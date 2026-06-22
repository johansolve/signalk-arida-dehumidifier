const { createDevice } = require('./lib/device')
const { toDeltaValues, metaFor } = require('./lib/deltas')

const DEFAULT_PREFIX = 'environment.inside.dehumidifier'

// The humidity lines never need raw 30 s samples; aim for roughly this many
// points across whatever range is asked for and let InfluxDB downsample.
const TARGET_POINTS = 400

// Runtime is a duty-cycle: the share of time the unit was drying. A fine bucket
// only ever holds "on the whole bucket" or "off", so it reads as 0/100 %. Use a
// much coarser bucket (~this many across the range, i.e. roughly hourly for a
// day) so each bar is a meaningful percentage.
const RUNTIME_POINTS = 30

module.exports = function (app) {
    let timer = null
    let device = null
    let prefix = DEFAULT_PREFIX
    let influx = {}

    const plugin = {
        id: 'signalk-arida-dehumidifier',
        name: 'Arida S3L Dehumidifier',
        description: 'Monitor and control an Arida S3L WiFi (Tuya) dehumidifier over the local network.',
        schema: {
            type: 'object',
            required: ['deviceId', 'localKey'],
            properties: {
                deviceId: { type: 'string', title: 'Tuya device ID' },
                ip: { type: 'string', title: 'Device IP on the LAN (blank = auto-discover via broadcast)' },
                localKey: { type: 'string', title: 'Tuya local key' },
                version: { type: 'string', title: 'Tuya protocol version', default: '3.4' },
                pythonBin: {
                    type: 'string',
                    title: 'Python interpreter (a venv with tinytuya installed)',
                    default: '/home/boat/arida-venv/bin/python'
                },
                scriptPath: {
                    type: 'string',
                    title: 'Path to arida.py (blank = bundled copy)',
                    default: ''
                },
                pollInterval: { type: 'number', title: 'Poll interval (seconds)', default: 30 },
                pathPrefix: { type: 'string', title: 'Signal K path prefix', default: DEFAULT_PREFIX },
                influxHost: { type: 'string', title: 'InfluxDB host (for the history chart)', default: 'localhost' },
                influxPort: { type: 'number', title: 'InfluxDB port', default: 8086 },
                influxDatabase: { type: 'string', title: 'InfluxDB database', default: 'libelle' },
                influxUsername: { type: 'string', title: 'InfluxDB username (blank if auth is off)', default: '' },
                influxPassword: { type: 'string', title: 'InfluxDB password (blank if auth is off)', default: '' }
            }
        }
    }

    function poll() {
        if (!device) {
            return
        }
        device.read()
            .then((data) => {
                app.handleMessage(plugin.id, { updates: [{ values: toDeltaValues(prefix, data) }] })
                if (data.current_humidity != null) {
                    app.setPluginStatus(`${Math.round(Number(data.current_humidity))}%RH, target ${data.target_humidity}%`)
                }
            })
            .catch((err) => app.setPluginError(err.message))
    }

    function handlePut(action) {
        return (context, path, value, callback) => {
            action(value)
                .then(() => {
                    poll()
                    callback({ state: 'COMPLETED', statusCode: 200 })
                })
                .catch((err) => callback({ state: 'FAILED', statusCode: 502, message: err.message }))
            return { state: 'PENDING' }
        }
    }

    plugin.start = function (options) {
        prefix = options.pathPrefix || DEFAULT_PREFIX
        influx = {
            host: options.influxHost || 'localhost',
            port: options.influxPort || 8086,
            database: options.influxDatabase || 'libelle',
            username: options.influxUsername || '',
            password: options.influxPassword || ''
        }
        device = createDevice(options)

        app.handleMessage(plugin.id, { updates: [{ meta: metaFor(prefix) }] })

        app.registerPutHandler('vessels.self', `${prefix}.power`,
            handlePut((value) => device.setPower(value)))
        app.registerPutHandler('vessels.self', `${prefix}.targetHumidity`,
            handlePut((value) => device.setTargetHumidity(value)))
        app.registerPutHandler('vessels.self', `${prefix}.fan`,
            handlePut((value) => device.setFan(value)))

        poll()
        timer = setInterval(poll, (options.pollInterval || 30) * 1000)
    }

    plugin.stop = function () {
        if (timer) {
            clearInterval(timer)
            timer = null
        }
        device = null
    }

    // ---- History (InfluxDB) --------------------------------------------------

    // Snap the group-by interval to a "nice" minute value so axis ticks land on
    // sensible times rather than e.g. every 17 minutes.
    function groupMinutes(days, target) {
        const raw = (days * 24 * 60) / target
        const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
        for (const s of steps) {
            if (raw <= s) {
                return s
            }
        }
        return 1440
    }

    // Quote a Signal K path as an InfluxQL measurement identifier, escaping any
    // embedded quote/backslash so a configured prefix can't break the query.
    function measurement(suffix) {
        const m = `${prefix}.${suffix}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        return `"${m}"`
    }

    function rowsToPoints(result) {
        const serie = result && result.series && result.series[0]
        return serie ? serie.values : []
    }

    async function queryHistory(days) {
        const humMin = groupMinutes(days, TARGET_POINTS)
        const runMin = groupMinutes(days, RUNTIME_POINTS)
        const humWin =
            `WHERE time > now() - ${days}d GROUP BY time(${humMin}m) fill(none)`
        // InfluxDB aligns time() buckets to the epoch (i.e. whole clock hours), so
        // the newest bucket only holds the minutes elapsed since the top of the
        // hour yet still draws as a full bar — a misleading partial. Offset the
        // buckets so a boundary lands exactly on now, making each runtime bar a
        // complete window measured back from now (the oldest bar takes the
        // partial instead, off at the edge of the range).
        const runOffsetMs = Date.now() % (runMin * 60 * 1000)
        const runGroup = `GROUP BY time(${runMin}m, ${runOffsetMs}ms) fill(0)`
        // Runtime is the duty-cycle of the drying state: the share of samples in
        // each bucket where state='drying'. state is stored as a string, so we
        // count matching samples and divide by the total (polling is even, so
        // sample share ≈ time share). fan is a separate string measurement; we
        // also count HIGH samples per bucket to colour each bar by fan speed.
        // Statements 0..2 share the coarse runtime bucket; 3..4 the fine one.
        const statements = [
            `SELECT count("stringValue") FROM ${measurement('state')} ` +
                `WHERE "stringValue"='drying' AND time > now() - ${days}d ${runGroup}`,
            `SELECT count("stringValue") FROM ${measurement('state')} ` +
                `WHERE time > now() - ${days}d ${runGroup}`,
            `SELECT count("stringValue") FROM ${measurement('fan')} ` +
                `WHERE "stringValue"='HIGH' AND time > now() - ${days}d ${runGroup}`,
            `SELECT mean("value")*100 FROM ${measurement('relativeHumidity')} ${humWin}`,
            `SELECT mean("value")*100 FROM ${measurement('targetHumidity')} ${humWin}`
        ].join('; ')

        const params = new URLSearchParams({
            db: influx.database,
            epoch: 'ms',
            q: statements
        })
        if (influx.username) {
            params.set('u', influx.username)
            params.set('p', influx.password)
        }

        const url = `http://${influx.host}:${influx.port}/query?${params.toString()}`
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
        if (!resp.ok) {
            throw new Error(`InfluxDB HTTP ${resp.status}`)
        }
        const body = await resp.json()
        if (body.error) {
            throw new Error(body.error)
        }
        const results = body.results || []

        // Combine the count series into a runtime-percent series, with the
        // dominant fan speed per bucket. fill(0) on the total means a bucket with
        // no samples (plugin was down) reads 0; emit null there so the chart
        // shows a gap, not a false 0 %.
        const drying = new Map(rowsToPoints(results[0]).map(([t, v]) => [t, v]))
        const fanHigh = new Map(rowsToPoints(results[2]).map(([t, v]) => [t, v]))
        const runtime = []
        const fan = []
        rowsToPoints(results[1]).forEach(([t, total]) => {
            if (total > 0) {
                runtime.push([t, (drying.get(t) || 0) / total * 100])
                fan.push([t, (fanHigh.get(t) || 0) / total >= 0.5 ? 'HIGH' : 'LOW'])
            } else {
                runtime.push([t, null])
                fan.push([t, null])
            }
        })

        return {
            days,
            groupMinutes: humMin,
            runtimeMinutes: runMin,
            series: [
                { key: 'runtime', label: 'Runtime', points: runtime, fan },
                { key: 'relativeHumidity', label: 'Humidity', points: rowsToPoints(results[3]) },
                { key: 'targetHumidity', label: 'Target', points: rowsToPoints(results[4]) }
            ]
        }
    }

    async function historyHandler(req, res) {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 1))
        try {
            res.json(await queryHistory(days))
        } catch (e) {
            app.error(`arida history query failed: ${e.message}`)
            res.status(500).json({ error: e.message })
        }
    }

    // Mounted under /signalk/v1/api (not /plugins): the server guards /plugins/*
    // with admin auth, so the anonymous webapp gets 401 there. Routes under
    // /signalk/v1/api honour "Allow readonly access" — the same browser that can
    // read the live values can read their history too.
    //   GET /signalk/v1/api/arida-dehumidifier/history?days=1
    plugin.signalKApiRoutes = function (router) {
        router.get('/arida-dehumidifier/history', historyHandler)
        return router
    }

    // Also expose it under /plugins for admin/OpenAPI tooling.
    plugin.registerWithRouter = function (router) {
        router.get('/history', historyHandler)
    }

    plugin.getOpenApi = () => ({
        openapi: '3.0.0',
        info: { title: 'Arida S3L Dehumidifier plugin API', version: '0.1.0' },
        paths: {
            '/history': {
                get: {
                    summary: 'Downsampled history: drying duty-cycle and humidity (percent)',
                    parameters: [
                        {
                            name: 'days',
                            in: 'query',
                            schema: { type: 'integer', default: 1 },
                            description: 'Range in days (1..365)'
                        }
                    ],
                    responses: { 200: { description: 'History JSON' } }
                }
            }
        }
    })

    return plugin
}
