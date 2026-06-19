// Maps the device state (from arida.py json) to Signal K delta values, and
// provides metadata for the numeric paths. SI units: ratio for humidity, K for
// temperature.

function toDeltaValues(prefix, data) {
    const values = []
    const push = (p, v) => {
        if (v !== undefined && v !== null) {
            values.push({ path: `${prefix}.${p}`, value: v })
        }
    }

    if (data.current_humidity != null) {
        push('relativeHumidity', Number(data.current_humidity) / 100)
    }
    if (data.target_humidity != null) {
        push('targetHumidity', Number(data.target_humidity) / 100)
    }
    if (data.temperature != null) {
        push('temperature', Number(data.temperature) + 273.15)
    }
    push('power', !!data.power)
    push('fan', data.fan)
    push('timer', data.timer)
    push('fault', data.fault)

    return values
}

function metaFor(prefix) {
    return [
        {
            path: `${prefix}.relativeHumidity`,
            value: { units: 'ratio', description: 'Current relative humidity measured by the dehumidifier' }
        },
        {
            path: `${prefix}.targetHumidity`,
            value: { units: 'ratio', description: 'Target relative humidity setpoint' }
        },
        {
            path: `${prefix}.temperature`,
            value: { units: 'K', description: 'Temperature measured by the dehumidifier' }
        }
    ]
}

module.exports = { toDeltaValues, metaFor }
