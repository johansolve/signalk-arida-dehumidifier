# signalk-arida-dehumidifier

Monitor and control an **Arida S3L WiFi** dehumidifier (a Tuya device) from Signal K.
Control is **local** over the LAN via [tinytuya](https://github.com/jasonacox/tinytuya) —
no Tuya cloud at runtime. Ships with a small control-panel webapp.

## What it exposes

Under `environment.inside.dehumidifier.*` (configurable prefix):

| Path | Unit | Notes |
|------|------|-------|
| `relativeHumidity` | ratio | current humidity measured by the device |
| `targetHumidity` | ratio | setpoint — **PUT** to change (40 / 50 / 60 %) |
| `temperature` | K | device sensor (near the rotor outlet, not cabin ambient) |
| `power` | bool | on/off — **PUT** to change |
| `fan` | string | `LOW` / `HIGH` (read-only) |
| `timer` | string | `1h` / `2h` / `3h` / `CANCEL` |
| `fault` | string | decoded bitmap: `TILTED`, `CHECK`, `E_Saving`, `FULL` |

Webapp (standalone, in the Webapps menu): a control panel with live green lamps,
power and humidity (40/50/60) buttons. Reads run open (`allow_readonly`); writes use
the Signal K **access-request** flow (approve once under Security → Access Requests).

## Requirements

- A Python interpreter with `tinytuya` installed. A dedicated venv is recommended:
  ```
  python3 -m venv ~/arida-venv
  ~/arida-venv/bin/pip install tinytuya
  ```
- The device's Tuya `deviceId`, LAN `ip` and `localKey` — see onboarding below.

## Getting the local key (one-time onboarding)

Tuya devices are controlled locally with a per-device `localKey`. Extracting it once needs
the Tuya cloud; after that the plugin never touches the cloud again.

1. **Pair the dehumidifier** in the **Smart Life** (or Tuya Smart) app. Register with an
   **email address**, and pick the **Central Europe** data center *before* entering anything
   — the wrong region means the device won't show up in step 4. The unit joins your 2.4 GHz WiFi.
2. **Create a Tuya IoT developer account** at <https://iot.tuya.com> — this is a *separate*
   account from the app login.
3. **Cloud → Create Cloud Project** (data center **Central Europe**, "Smart Home" method).
   Note the **Access ID** and **Access Secret**.
4. In the project: **Devices → Link App Account → Add App Account**, scan the QR with the
   Smart Life app. The dehumidifier now appears under **Devices** with its **Device ID**.
5. Run the wizard (region `eu`) and answer the prompts with the Access ID/Secret and a
   Device ID:
   ```
   python3 -m tinytuya wizard
   ```
   It writes `devices.json` containing `id`, `key` (the local key) and `ip`.
6. Put `deviceId` and `localKey` into the plugin config (below). The `ip` is optional —
   leave it blank and the plugin auto-discovers the device on the LAN; set it (with a DHCP
   reservation) only if you want to pin a fixed address.

**If you hit HTTP 412 ("security risk control"):** it's egress-IP reputation, not your
account. Run from a different IP — a mobile hotspot, or run `tinytuya wizard` on the Signal K
host itself (its internet egress is usually clean). Toggling airplane mode gives a fresh
mobile IP; an incognito window clears a flagged session.

**Webapp control** uses Signal K's access-request flow, not Tuya: the first time you press a
button the webapp requests access — approve it once under **Security → Access Requests** as
**read/write** (read-only lets the panel display but not control).

## Configuration

In the Signal K Plugin Config screen:

| Setting | Example |
|---------|---------|
| Tuya device ID | `bfxxxxxxxxxxxxxxxxxxxx` |
| Device IP | *(blank — auto-discovered via broadcast; set it to pin a fixed address)* |
| Tuya local key | (from `tinytuya wizard`) |
| Tuya protocol version | `3.4` |
| Python interpreter | `/home/boat/arida-venv/bin/python` |
| Poll interval | `30` |

Credentials live in the plugin configuration, never in the committed code.

## Architecture

- `arida.py` — owns the Tuya local protocol (tinytuya). Reads connection details from
  `ARIDA_DEVICE_ID` / `ARIDA_IP` / `ARIDA_KEY` / `ARIDA_VERSION`. Usable standalone as a CLI.
- `lib/device.js` — async wrapper that runs `arida.py`, passing config via the environment.
- `lib/deltas.js` — maps device state to Signal K deltas + metadata (SI units).
- `index.js` — plugin entry: schema, poll loop, PUT handlers.
- `public/` — the control-panel webapp.

After a successful PUT the plugin re-polls immediately, so the model reflects the change
within a couple of seconds rather than waiting for the next poll.

## License

MIT — see [LICENSE](LICENSE).
