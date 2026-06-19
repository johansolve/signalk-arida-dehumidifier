#!/usr/bin/env python3
"""Local control of the Arida S3L WiFi dehumidifier over the LAN via tinytuya.

Connection details are read from the environment so no credentials live in this
file:
    ARIDA_DEVICE_ID   Tuya device id
    ARIDA_IP          device IP on the LAN (blank = auto-discover via broadcast)
    ARIDA_KEY         Tuya local key
    ARIDA_VERSION     Tuya protocol version (default 3.4)

Usage:
    ./arida.py status            # human-readable status
    ./arida.py raw               # dump every DP value
    ./arida.py json              # machine-readable, e.g. for the Signal K plugin
    ./arida.py scan              # discover the device IP on the LAN (UDP broadcast)
    ./arida.py on | off
    ./arida.py humidity 40|50|60 # target humidity (enum: 40=L, 50=M, 60=H)
    ./arida.py timer 1h|2h|3h|cancel
    ./arida.py set <dp> <value>  # escape hatch for probing undocumented DPs

DP map (category cs), verified against the device:
    1 power(bool)  3 target humidity enum 40/50/60  4 fan (read-only, "HIGH")
    6 current humidity %  7 temperature °C  17 timer enum  19 fault bitmap
"""

import json
import os
import sys

import tinytuya

DEVICE_ID = os.environ.get("ARIDA_DEVICE_ID")
IP = os.environ.get("ARIDA_IP")
LOCAL_KEY = os.environ.get("ARIDA_KEY")
VERSION = float(os.environ.get("ARIDA_VERSION", "3.4"))

DP_MAP = {
    "1": "power",
    "3": "target_humidity",   # enum "40" / "50" / "60"
    "4": "fan",               # live value "HIGH"; not in cloud mapping, read-only here
    "6": "current_humidity",
    "7": "temperature",
    "17": "timer",            # enum "1h" / "2h" / "3h" / "CANCEL"
    "19": "fault",            # bitmap: bit0 TILTED, bit1 CHECK, bit2 E_Saving, bit3 FULL
}

FAULT_BITS = ["TILTED", "CHECK", "E_Saving", "FULL"]
HUMIDITY_VALUES = ("40", "50", "60")
TIMER_VALUES = {"1h": "1h", "2h": "2h", "3h": "3h", "cancel": "CANCEL"}


def find():
    return tinytuya.find_device(DEVICE_ID) or {}


def connect():
    if not (DEVICE_ID and LOCAL_KEY):
        raise SystemExit("set ARIDA_DEVICE_ID and ARIDA_KEY in the environment")
    ip = IP or find().get("ip")
    if not ip:
        raise SystemExit("device not found on the LAN (set ARIDA_IP or check it is online)")
    d = tinytuya.OutletDevice(DEVICE_ID, ip, LOCAL_KEY)
    d.set_version(VERSION)
    d.set_socketPersistent(True)
    return d


def read(d):
    data = d.status()
    if "dps" not in data:
        raise SystemExit(f"No data returned: {data}")
    return data["dps"]


def named(dps):
    return {DP_MAP.get(k, k): v for k, v in dps.items()}


def decode_fault(value):
    if not value:
        return "none"
    flags = [name for i, name in enumerate(FAULT_BITS) if value & (1 << i)]
    return ", ".join(flags) or f"raw {value}"


def cmd_status(d):
    s = named(read(d))
    print(f"Power:            {'ON' if s.get('power') else 'OFF'}")
    print(f"Current humidity: {s.get('current_humidity')} %")
    print(f"Target humidity:  {s.get('target_humidity')} %")
    print(f"Temperature:      {s.get('temperature')} °C")
    print(f"Fan:              {s.get('fan')}")
    print(f"Timer:            {s.get('timer')}")
    print(f"Fault:            {decode_fault(s.get('fault'))}")


def cmd_raw(d):
    print(json.dumps(read(d), indent=2))


def cmd_scan():
    if not DEVICE_ID:
        raise SystemExit("set ARIDA_DEVICE_ID in the environment")
    info = find()
    if not info.get("ip"):
        raise SystemExit("device not found on the LAN")
    print(json.dumps({"ip": info.get("ip"), "version": info.get("version")}))


def cmd_json(d):
    s = named(read(d))
    s["fault"] = decode_fault(s.get("fault"))
    print(json.dumps(s))


def cmd_humidity(d, value):
    if value not in HUMIDITY_VALUES:
        raise SystemExit(f"humidity must be one of {HUMIDITY_VALUES}")
    print(d.set_value("3", value))


def cmd_timer(d, value):
    if value not in TIMER_VALUES:
        raise SystemExit(f"timer must be one of {list(TIMER_VALUES)}")
    print(d.set_value("17", TIMER_VALUES[value]))


def cmd_set(d, dp, value):
    if value in ("true", "false"):
        value = value == "true"
    elif value.lstrip("-").isdigit():
        value = int(value)
    print(d.set_value(dp, value))


def main():
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    cmd = args[0]
    if cmd == "scan":
        cmd_scan()
        return
    d = connect()
    if cmd == "status":
        cmd_status(d)
    elif cmd == "raw":
        cmd_raw(d)
    elif cmd == "json":
        cmd_json(d)
    elif cmd == "on":
        print(d.set_value("1", True))
    elif cmd == "off":
        print(d.set_value("1", False))
    elif cmd == "humidity":
        cmd_humidity(d, args[1])
    elif cmd == "timer":
        cmd_timer(d, args[1])
    elif cmd == "set":
        cmd_set(d, args[1], args[2])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
