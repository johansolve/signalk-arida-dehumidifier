const { execFile } = require('child_process')
const path = require('path')

const BUNDLED_SCRIPT = path.join(__dirname, '..', 'arida.py')

// Wraps arida.py (tinytuya) as a small async device interface. The Python layer
// owns the Tuya local protocol; connection details are passed via the environment
// so no credentials live in the bundled script.
//
// The device IP is optional: if not configured it is discovered once via UDP
// broadcast (`scan`), cached, and re-discovered automatically if a call fails
// (e.g. after a DHCP lease change).
function createDevice(options) {
    const pythonBin = options.pythonBin || '/home/boat/arida-venv/bin/python'
    const scriptPath = options.scriptPath || BUNDLED_SCRIPT
    const configuredIp = options.ip || ''
    let resolvedIp = configuredIp
    let scanPromise = null
    let failures = 0

    // Turn opaque execFile failures into actionable plugin-status messages: the
    // two common setup mistakes are a missing Python interpreter and a venv
    // without tinytuya installed.
    function explain(err, stderr) {
        if (err.code === 'ENOENT') {
            return new Error(`Python interpreter not found at "${pythonBin}" — create a venv with tinytuya: python3 -m venv ~/arida-venv && ~/arida-venv/bin/pip install tinytuya`)
        }
        if (stderr && /No module named ['"]?tinytuya/.test(stderr)) {
            return new Error(`tinytuya is not installed for "${pythonBin}" — install it: "${pythonBin}" -m pip install tinytuya`)
        }
        const tail = stderr && stderr.trim().split('\n').pop()
        return tail ? new Error(tail) : err
    }

    function spawn(ip, args, timeout) {
        const env = {
            ...process.env,
            ARIDA_DEVICE_ID: options.deviceId,
            ARIDA_IP: ip || '',
            ARIDA_KEY: options.localKey,
            ARIDA_VERSION: String(options.version || '3.4')
        }
        return new Promise((resolve, reject) => {
            execFile(pythonBin, [scriptPath, ...args], { env, timeout: timeout || 15000 }, (err, stdout, stderr) => {
                if (err) {
                    reject(explain(err, stderr))
                    return
                }
                resolve(stdout)
            })
        })
    }

    function ensureIp() {
        if (resolvedIp) {
            return Promise.resolve(resolvedIp)
        }
        // share one in-flight scan between concurrent callers (poll + PUT)
        if (!scanPromise) {
            scanPromise = spawn('', ['scan'], 30000)
                .then((out) => {
                    const ip = JSON.parse(out).ip
                    if (!ip) {
                        throw new Error('scan returned no IP')
                    }
                    resolvedIp = ip
                    return ip
                })
                .finally(() => {
                    scanPromise = null
                })
        }
        return scanPromise
    }

    function run(args) {
        return ensureIp()
            .then((ip) => spawn(ip, args))
            .then((out) => {
                failures = 0
                return out
            })
            .catch((err) => {
                failures += 1
                // only re-discover after repeated failures, so a transient device
                // error doesn't trigger an expensive scan on every poll
                if (!configuredIp && failures >= 3) {
                    resolvedIp = ''
                    failures = 0
                }
                throw err
            })
    }

    return {
        read() {
            return run(['json']).then((out) => JSON.parse(out))
        },
        setPower(on) {
            return run([on ? 'on' : 'off'])
        },
        setTargetHumidity(value) {
            // accept a ratio (0.40) or a whole percent (40); device allows 40, 50 or 60
            const pct = value <= 1 ? Math.round(value * 100) : Math.round(value)
            const target = pct >= 55 ? '60' : (pct >= 45 ? '50' : '40')
            return run(['humidity', target])
        },
        setFan(value) {
            // accept "LOW"/"HIGH" (any case); device enum is LOW or HIGH
            const speed = String(value).toLowerCase() === 'low' ? 'low' : 'high'
            return run(['fan', speed])
        }
    }
}

module.exports = { createDevice }
