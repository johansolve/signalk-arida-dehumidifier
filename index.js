const { createDevice } = require('./lib/device')
const { toDeltaValues, metaFor } = require('./lib/deltas')

const DEFAULT_PREFIX = 'environment.inside.dehumidifier'

module.exports = function (app) {
    let timer = null
    let device = null
    let prefix = DEFAULT_PREFIX

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
                pathPrefix: { type: 'string', title: 'Signal K path prefix', default: DEFAULT_PREFIX }
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
        device = createDevice(options)

        app.handleMessage(plugin.id, { updates: [{ meta: metaFor(prefix) }] })

        app.registerPutHandler('vessels.self', `${prefix}.power`,
            handlePut((value) => device.setPower(value)))
        app.registerPutHandler('vessels.self', `${prefix}.targetHumidity`,
            handlePut((value) => device.setTargetHumidity(value)))

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

    return plugin
}
