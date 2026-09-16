# SolarEdge, Emporia Vue & CPS Energy Monitor

Home energy telemetry collector and Home Assistant bridge. Integrates local SolarEdge inverter metrics (SunSpec Modbus TCP), Emporia Vue branch circuit submetering, and CPS Energy smart meter interval data (AMI), publishing consolidated measurements to Home Assistant via MQTT.

## Overview

The service collects energy data across three sources:

1. **SolarEdge Inverter**: Connects over local Modbus TCP (port 502) to read instantaneous AC power output, DC watts, lifetime energy production, and inverter heatsink temperature.
2. **Emporia Vue**: Queries the Emporia API for subpanel mains and individual circuit branch power measurements (HVAC, dryer, oven, washer, lighting, and general branch circuits).
3. **CPS Energy Smart Meter (AMI)**: Authenticates to the utility customer portal to pull 15-minute smart meter interval data, syncs recent intervals, and provides a standalone web UI for daily/hourly interval consumption graphs and history.

The collected data is aggregated to calculate net grid import/export, self-consumption percentage, and estimated energy costs, and published to MQTT with Home Assistant auto-discovery payloads.

## System Components

- `service.js`: Main collector daemon. Polls SolarEdge and Emporia, calculates house consumption (subpanel + heavy 240V loads), tracks daily accumulators, and publishes to MQTT.
- `ha-mqtt.js`: Handles MQTT connection, Home Assistant discovery payload generation, and state publishing.
- `cps-sync.js`: Background sync daemon for CPS Energy smart meter interval data.
- `cps-auth.js`: Handles authentication and session management with the CPS Energy portal.
- `cps-backfill.js`: Utility script to download multi-year historical interval data from CPS Energy.
- `cps-dashboard/`: Express API server (`server.js`) and frontend web UI (`public/index.html`) running on port 3355 (accessible standalone or embedded via Home Assistant Ingress).
- `ha-addon/solar_energy_monitor/`: Complete Home Assistant Local Add-on packaging (Dockerfile, add-on config, and service scripts).
- `dashboards/`:
  - `solar-hub.yaml`: Home Assistant Lovelace dashboard for solar production, circuit submetering, live power flow, and system telemetry.
  - `smart-home.yaml`: Multi-view dashboard for lighting controls, climate/HVAC, appliances, and network monitoring.
  - `celestial-theme.yaml`: Dark Lovelace theme definition.
- `www/circuit-breakdown-card.js`: Custom Lovelace web component that renders circuit power breakdown with itemized load rows and visual proportion bars.

## Repository Structure

```
.
├── cps-auth.js                 # CPS Energy portal authentication
├── cps-backfill.js             # Utility to backfill historical interval data
├── cps-sync.js                 # 15-minute interval sync daemon
├── cps-dashboard/              # Web dashboard on port 3355
│   ├── server.js               # API server
│   └── public/index.html       # Web UI
├── dashboards/
│   ├── solar-hub.yaml          # Energy and solar hub dashboard
│   ├── smart-home.yaml         # Smart home, lighting, and climate dashboard
│   ├── celestial-theme.yaml    # Dashboard theme
│   └── ha-configuration.yaml   # HA configuration snippet
├── deploy.js                   # Local script to push files to HA Samba share
├── dump.js                     # Tool to inspect SolarEdge SunSpec registers
├── emporia.js                  # Standalone Emporia API test script
├── env.js                      # Environment loader (.env)
├── ha-addon/
│   └── solar_energy_monitor/   # Home Assistant local add-on
│       ├── config.yaml         # Add-on configuration and options schema
│       ├── Dockerfile          # Container definition
│       └── ...                 # Add-on copies of service scripts
├── ha-mqtt.js                  # MQTT client and discovery builder
├── monitor-live.js             # Terminal-based live power monitor
├── service.js                  # Main daemon
├── solaredge.js                # Standalone SolarEdge Modbus test script
├── sync-watch.js               # File watcher for auto-syncing to Samba share
├── www/
│   ├── circuit-breakdown-card.js # Lovelace card for submetering load attribution
│   └── solar-simulator.html    # Standalone browser solar/battery sizing model
├── .env.example                # Environment configuration template
└── package.json
```

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `INVERTER_IP` | SolarEdge inverter IP address on your local network | `192.168.1.100` |
| `MODBUS_PORT` | Modbus TCP port (standard is 502) | `502` |
| `RATED_AC_WATTS` | Inverter continuous rated AC output (e.g. 7600 for SE7600H) | `7600` |
| `EMPORIA_USER` | Emporia Vue account email | `""` |
| `EMPORIA_PASS` | Emporia Vue account password | `""` |
| `IMPORT_RATE_KWH` | Electricity import cost per kWh in USD | `0.14` |
| `EXPORT_RATE_KWH` | Solar net metering export credit per kWh in USD | `0.01` |
| `MODBUS_POLL_INTERVAL_MS` | Inverter polling interval in milliseconds | `1000` |
| `EMPORIA_POLL_INTERVAL_MS` | Emporia API polling interval in milliseconds | `2000` |
| `POLL_INTERVAL_MS` | Default polling loop interval | `2000` |
| `HA_IP` | Home Assistant server IP address | `192.168.1.50` |
| `HA_MQTT_BROKER` | MQTT broker URL | `mqtt://192.168.1.50:1883` |
| `HA_MQTT_USER` | MQTT username | `solar` |
| `HA_MQTT_PASS` | MQTT password | `""` |
| `CPS_USER` | CPS Energy web portal username | `""` |
| `CPS_PASS` | CPS Energy web portal password | `""` |
| `CPS_METER_ID` | CPS Energy electric smart meter ID number | `""` |
| `HA_SAMBA_PATH` | Local Samba network path for file deployments | `""` |

## Usage

### Option 1: Home Assistant Add-on (Recommended)

1. Copy `ha-addon/solar_energy_monitor` to your Home Assistant `/addons` folder.
2. In Home Assistant, open **Settings → Add-ons → Add-on Store**, click **Check for updates**, and install **Solar & Energy Monitor** under Local Add-ons.
3. In the add-on **Configuration** tab, enter your inverter IP, Emporia credentials, MQTT broker details, and CPS credentials.
4. Start the add-on.

The add-on runs `service.js` and exposes the CPS dashboard UI via Ingress or on port 3355.

### Option 2: Standalone Node.js Service

Prerequisites: Node.js 18+ and npm.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the daemon:
   ```bash
   node service.js
   ```

### Diagnostic Scripts

- Check inverter SunSpec registers:
  ```bash
  node dump.js
  ```
- Test inverter Modbus connection:
  ```bash
  node solaredge.js
  ```
- Test Emporia API authentication:
  ```bash
  node emporia.js
  ```
- Terminal live text display:
  ```bash
  node monitor-live.js
  ```
- Run CPS Energy 15-minute sync once:
  ```bash
  node cps-sync.js
  ```
- Run historical CPS Energy interval backfill:
  ```bash
  node cps-backfill.js
  ```

## Published MQTT Entities

The service registers devices and sensors with Home Assistant under the topic prefix `home/solar/`:

- **Solar Production**: AC power (`W`), DC power (`W`), daily energy (`kWh`), inverter efficiency (`%`), heatsink temperature (`°C`), inverter status.
- **Consumption & Grid**: House total consumption (`W`), grid net import/export (`W`), self-consumption (`%`), daily import/export (`kWh`), estimated daily cost (`USD`).
- **Subpanel Circuits**: 16 branch circuit sensors (HVAC condenser, furnace blower, kitchen circuits, washer, dryer, oven, bathroom, bedrooms, office, EV charger).
- **Appliances**: Dryer, oven, and washer real-time wattage, daily energy consumed (`kWh`), runtime hours, and daily cost.
- **CPS Smart Meter**: Import/export energy today, 15-minute demand watts, sync status, and AMI feed timestamps.

## Dashboards and Custom Cards

- **`dashboards/solar-hub.yaml`**: Main dashboard configured for Home Assistant. Includes views for Live Flow, Appliance telemetry, Circuit breakdowns, Analytics, and CPS Meter.
- **`dashboards/smart-home.yaml`**: Multi-room smart home dashboard for lighting, climate, appliances, and network status.
- **`www/circuit-breakdown-card.js`**: Custom card to show breakdown of power across appliances on a given circuit. Add to Home Assistant via Lovelace Resources (`/local/circuit-breakdown-card.js` as JavaScript module).

## License

MIT
