// ============================================================================
//  UNIFIED HOME ENERGY DAEMON (Home Assistant Local Add-on)
//  Continuously polls SolarEdge (Modbus) + Emporia Vue (Cloud),
//  logs persistent energy accumulation to /data, and publishes to Home Assistant (MQTT).
// ============================================================================
const fs = require("fs");
const path = require("path");
const ModbusRTU = require("modbus-serial");
const { EmporiaVue, Scale } = require("emporia-vue-lib");
const HaMqttPublisher = require("./ha-mqtt");

// Load local .env only during standalone desktop development
// (In Home Assistant OS, all settings come from the built-in Configuration tab /data/options.json)
if (fs.existsSync(path.join(__dirname, ".env"))) {
  try {
    require("./env");
  } catch (_) {}
}

// --- Read Home Assistant Add-on Options (/data/options.json) ---
let haOptions = {};
const OPTIONS_PATH = "/data/options.json";
if (fs.existsSync(OPTIONS_PATH)) {
  try {
    haOptions = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf8"));
    console.log("[Config] Loaded Home Assistant add-on options from /data/options.json");
  } catch (err) {
    console.warn("[Config] Failed to parse options.json, using defaults:", err.message);
  }
}

// --- Configuration ---
const INVERTER_IP = haOptions.inverter_ip || process.env.INVERTER_IP || "127.0.0.1";
const MODBUS_PORT = Number(haOptions.modbus_port || process.env.MODBUS_PORT) || 502;
const UNIT_ID = 1;
const IMPORT_RATE_KWH = haOptions.import_rate_kwh !== undefined
  ? Number(haOptions.import_rate_kwh)
  : (process.env.IMPORT_RATE_KWH !== undefined ? Number(process.env.IMPORT_RATE_KWH) : 0.14);
const EXPORT_RATE_KWH = haOptions.export_rate_kwh !== undefined
  ? Number(haOptions.export_rate_kwh)
  : (process.env.EXPORT_RATE_KWH !== undefined ? Number(process.env.EXPORT_RATE_KWH) : 0.01);

const EMPORIA_USER = haOptions.emporia_user || process.env.EMPORIA_USER || "";
const EMPORIA_PASS = haOptions.emporia_pass || process.env.EMPORIA_PASS || "";

const DEFAULT_INTERVAL = Number(haOptions.poll_interval_ms || process.env.POLL_INTERVAL_MS) || 2000;
let modbusIntervalMs = Number(haOptions.modbus_poll_interval_ms || process.env.MODBUS_POLL_INTERVAL_MS) || 1000;
let emporiaIntervalMs = Number(haOptions.emporia_poll_interval_ms || process.env.EMPORIA_POLL_INTERVAL_MS) || DEFAULT_INTERVAL;

// Persistent energy log file (/data directory is preserved across HA container restarts)
const DATA_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const ENERGY_LOG_FILE = path.join(DATA_DIR, "energy-log.json");

// --- Home Assistant MQTT Integration ---
const HA_MQTT_BROKER = haOptions.mqtt_broker || process.env.HA_MQTT_BROKER || "mqtt://core-mosquitto:1883";
const HA_MQTT_USER = haOptions.mqtt_user || process.env.HA_MQTT_USER || "solar";
const HA_MQTT_PASS = haOptions.mqtt_pass || process.env.HA_MQTT_PASS || "";

// --- Clients ---
let modbus = new ModbusRTU();
const vue = new EmporiaVue();
const haMqtt = new HaMqttPublisher({
  brokerUrl: HA_MQTT_BROKER,
  username: HA_MQTT_USER,
  password: HA_MQTT_PASS,
});

let emporiaReady = false;
let emporiaDeviceGids = [];
let lastPollTime = null;
let lastSolar = null;
let lastEmporia = null;
let latestHvacWatts = 0;
let latestOutdoorWatts = 0;
let latestBlowerWatts = 0;
let latestDryerWatts = 0;
let latestOvenWatts = 0;
let latestWasherWatts = 0;
let lastSaveTime = 0;

haMqtt.onHvacPower = (watts) => {
  latestHvacWatts = watts;
};

haMqtt.onOutdoorPower = (watts) => {
  latestOutdoorWatts = watts;
};

haMqtt.onBlowerPower = (watts) => {
  latestBlowerWatts = watts;
};

haMqtt.onDryerPower = (watts) => {
  latestDryerWatts = watts;
};

haMqtt.onOvenPower = (watts) => {
  latestOvenWatts = watts;
};

haMqtt.onWasherPower = (watts) => {
  latestWasherWatts = watts;
};

// --- Daemon Error Tracking & Diagnostics ---
const recentErrors = [];
let totalErrorCount = 0;
let lastErrorString = "None";
const lastLoggedErrorByKey = new Map();

function recordDaemonError(source, err) {
  const time = new Date().toLocaleTimeString();
  const rawMsg = err && err.message ? err.message : String(err || "Unknown error");
  const msg = rawMsg.replace(/\r?\n/g, " ").trim();
  const key = `${source}:${msg}`;
  const now = Date.now();

  // Deduplicate identical errors within 30 seconds to avoid log flooding
  const prevTime = lastLoggedErrorByKey.get(key) || 0;
  if (now - prevTime < 30000) {
    return;
  }
  lastLoggedErrorByKey.set(key, now);

  totalErrorCount++;
  lastErrorString = `[${time}] [${source}] ${msg}`;

  recentErrors.unshift({
    time,
    source,
    message: msg.slice(0, 180),
  });
  if (recentErrors.length > 10) {
    recentErrors.pop();
  }
  console.warn(`[Daemon Error][${source}] ${msg}`);
}

// --- Energy Log Persistence ---
function loadEnergyLog() {
  try {
    if (fs.existsSync(ENERGY_LOG_FILE)) {
      return JSON.parse(fs.readFileSync(ENERGY_LOG_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[Log] Error reading log file:", err.message);
  }
  return {};
}

function saveEnergyLog(logData) {
  try {
    fs.writeFileSync(ENERGY_LOG_FILE, JSON.stringify(logData, null, 2), "utf8");
  } catch (err) {
    console.error("[Log] Error writing log file:", err.message);
  }
}

const energyLog = loadEnergyLog();

// Load saved runtime preferences if present
if (energyLog._settings) {
  if (energyLog._settings.modbusIntervalMs) modbusIntervalMs = energyLog._settings.modbusIntervalMs;
  if (energyLog._settings.emporiaIntervalMs) emporiaIntervalMs = energyLog._settings.emporiaIntervalMs;
}

haMqtt.onConnect = () => {
  haMqtt.publishSetting("modbus_poll_interval_ms", modbusIntervalMs);
  haMqtt.publishSetting("emporia_poll_interval_ms", emporiaIntervalMs);
};

haMqtt.onSettingChange = (key, val) => {
  const num = Number(val);
  if (isNaN(num) || num < 1 || num > 60000) return;
  energyLog._settings = energyLog._settings || {};
  if (key === "modbus_poll_interval_ms") {
    modbusIntervalMs = num;
    energyLog._settings.modbusIntervalMs = num;
    saveEnergyLog(energyLog);
    haMqtt.publishSetting("modbus_poll_interval_ms", num);
    console.log(`[Config] SolarEdge Modbus polling interval updated live to: ${num}ms`);
  } else if (key === "emporia_poll_interval_ms") {
    emporiaIntervalMs = num;
    energyLog._settings.emporiaIntervalMs = num;
    saveEnergyLog(energyLog);
    haMqtt.publishSetting("emporia_poll_interval_ms", num);
    console.log(`[Config] Emporia Vue polling interval updated live to: ${num}ms`);
  }
};

function getTodayEntry(logData) {
  const now = new Date();
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (!logData[dateKey]) {
    logData[dateKey] = {
      solarKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
      gridExportKwh: 0,
      peakSolarW: 0,
      peakConsumptionW: 0,
      hvacKwh: 0,
      hvacRuntimeMinutes: 0,
      lastUpdated: now.toISOString(),
    };
  }
  if (logData[dateKey].hvacKwh === undefined) logData[dateKey].hvacKwh = 0;
  if (logData[dateKey].hvacRuntimeMinutes === undefined) logData[dateKey].hvacRuntimeMinutes = 0;
  if (logData[dateKey].dryerKwh === undefined) logData[dateKey].dryerKwh = 0;
  if (logData[dateKey].dryerRuntimeMinutes === undefined) logData[dateKey].dryerRuntimeMinutes = 0;
  if (logData[dateKey].ovenKwh === undefined) logData[dateKey].ovenKwh = 0;
  if (logData[dateKey].ovenRuntimeMinutes === undefined) logData[dateKey].ovenRuntimeMinutes = 0;
  if (logData[dateKey].washerKwh === undefined) logData[dateKey].washerKwh = 0;
  if (logData[dateKey].washerRuntimeMinutes === undefined) logData[dateKey].washerRuntimeMinutes = 0;
  return logData[dateKey];
}

function toSigned16(val) { return val > 32767 ? val - 65536 : val; }
function scaleSE(val, sf) {
  if (val === 0x8000 || val === 0x7fff || val === 0xffff || val === undefined) return null;
  return Number((val * Math.pow(10, sf)).toFixed(2));
}

async function ensureModbusConnection() {
  if (modbus && modbus.isOpen) return true;
  try {
    if (modbus) {
      try { modbus.close(); } catch { }
    }
    modbus = new ModbusRTU();
    await modbus.connectTCP(INVERTER_IP, { port: MODBUS_PORT });
    modbus.setID(UNIT_ID);
    modbus.setTimeout(5000);
    return true;
  } catch (err) {
    recordDaemonError("SolarEdge Modbus", `Connection failed (${INVERTER_IP}:${MODBUS_PORT}): ${err.message}`);
    return false;
  }
}

async function fetchSolarEdge() {
  const connected = await ensureModbusConnection();
  if (!connected) return null;

  try {
    const raw = await modbus.readHoldingRegisters(40069, 40);
    const d = raw.data;

    const acPowerRaw = toSigned16(d[14]);
    const acPowerSf = toSigned16(d[15]);
    const acWatts = scaleSE(acPowerRaw, acPowerSf) || 0;

    const energyWh = (d[24] << 16) | d[25];
    const energySf = toSigned16(d[26]);
    const lifetimeKwh = (energyWh * Math.pow(10, energySf)) / 1000.0;

    const dcWatts = scaleSE(toSigned16(d[31]), toSigned16(d[32])) || 0;
    const heatSinkC = scaleSE(toSigned16(d[34]), toSigned16(d[37])) || 0;

    return {
      acWatts: Math.max(0, acWatts),
      dcWatts: Math.max(0, dcWatts),
      lifetimeKwh: Number(lifetimeKwh.toFixed(2)),
      heatSinkC,
    };
  } catch (err) {
    recordDaemonError("SolarEdge Modbus", `Register read failed: ${err.message}`);
    try { modbus.close(); } catch { }
    return null;
  }
}

async function fetchEmporia() {
  if (!emporiaReady || emporiaDeviceGids.length === 0) return null;

  try {
    const usageDict = await vue.getDeviceListUsage(emporiaDeviceGids, new Date(), Scale.SECOND);
    let mainNetWatts = 0;
    const circuits = [];

    for (const [gid, deviceUsage] of Object.entries(usageDict)) {
      const channels = deviceUsage.channelUsages || {};
      const mainCh = channels["1,2,3"] || channels["TotalUsage"];
      if (mainCh) {
        mainNetWatts += (mainCh.usage || 0) * 3600 * 1000;
      }

      for (const [chNum, ch] of Object.entries(channels)) {
        if (["1,2,3", "TotalUsage", "Balance"].includes(chNum)) continue;
        circuits.push({
          name: ch.name || `Circuit ${chNum}`,
          watts: Math.round((ch.usage || 0) * 3600 * 1000),
        });
      }
    }

    return {
      mainNetWatts: Math.round(mainNetWatts),
      circuits,
    };
  } catch (err) {
    recordDaemonError("Emporia Vue", `Cloud fetch failed: ${err.message}`);
    return null;
  }
}

function processAndPublish() {
  try {
    const now = new Date();
    const solarProdW = lastSolar ? lastSolar.acWatts : 0;
    const subpanelW = lastEmporia ? lastEmporia.mainNetWatts : 0;
    const hvacEstimatedW = latestHvacWatts || 0;
    const outdoorW = (latestOutdoorWatts !== undefined && latestOutdoorWatts > 0)
      ? latestOutdoorWatts
      : Math.max(0, hvacEstimatedW - (latestBlowerWatts || 0));
    const blowerW = Math.max(0, hvacEstimatedW - outdoorW);
    const dryerW = latestDryerWatts || 0;
    const ovenW = latestOvenWatts || 0;
    const washerW = latestWasherWatts || 0;

    // Total house load: subpanel (feeder) + outdoor 240V loads (AC condenser, Dryer, Oven)
    // Note: Washer is on Breaker #15 inside the subpanel, so subpanelW already includes it!
    const houseConsumptionW = Math.max(0, subpanelW + outdoorW + dryerW + ovenW);
    const gridNetW = houseConsumptionW - solarProdW;
    const selfPoweredPct = houseConsumptionW > 0
      ? Math.min((solarProdW / houseConsumptionW) * 100, 100)
      : (solarProdW > 0 ? 100 : 0);

    // Accumulation
    const today = getTodayEntry(energyLog);
    if (lastPollTime !== null) {
      const elapsedHrs = (now.getTime() - lastPollTime) / 3600000;
      if (elapsedHrs > 0 && elapsedHrs < 30 / 3600) {
        today.solarKwh += (solarProdW / 1000) * elapsedHrs;
        today.consumptionKwh += (houseConsumptionW / 1000) * elapsedHrs;
        if (hvacEstimatedW > 50) {
          today.hvacKwh += (hvacEstimatedW / 1000) * elapsedHrs;
          today.hvacRuntimeMinutes += elapsedHrs * 60;
        }
        if (dryerW > 50) {
          today.dryerKwh += (dryerW / 1000) * elapsedHrs;
          today.dryerRuntimeMinutes += elapsedHrs * 60;
        }
        if (ovenW > 50) {
          today.ovenKwh += (ovenW / 1000) * elapsedHrs;
          today.ovenRuntimeMinutes += elapsedHrs * 60;
        }
        if (washerW > 50) {
          today.washerKwh += (washerW / 1000) * elapsedHrs;
          today.washerRuntimeMinutes += elapsedHrs * 60;
        }
        if (gridNetW > 0) {
          today.gridImportKwh += (gridNetW / 1000) * elapsedHrs;
        } else {
          today.gridExportKwh += (Math.abs(gridNetW) / 1000) * elapsedHrs;
        }
      }
    }
    if (solarProdW > today.peakSolarW) today.peakSolarW = solarProdW;
    if (houseConsumptionW > today.peakConsumptionW) today.peakConsumptionW = houseConsumptionW;
    today.lastUpdated = now.toISOString();
    lastPollTime = now.getTime();

    // Throttled disk writes to avoid high I/O
    const nowMs = Date.now();
    if (nowMs - lastSaveTime > 10000) {
      saveEnergyLog(energyLog);
      lastSaveTime = nowMs;
    }

    const lifetimeKwh = lastSolar ? lastSolar.lifetimeKwh : 0;
    const heatSinkF = lastSolar ? (lastSolar.heatSinkC * 9) / 5 + 32 : 0;

    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const minsSinceMidnight = Math.max(1, (now.getTime() - midnight) / 60000);
    const hvacDutyCyclePct = Math.min(100, (today.hvacRuntimeMinutes / minsSinceMidnight) * 100);

    if (haMqtt.connected) {
      haMqtt.publishData({
        solarProdW,
        houseConsumptionW,
        subpanelWatts: subpanelW,
        hvacEstimatedWatts: hvacEstimatedW,
        outdoorWatts: outdoorW,
        blowerWatts: blowerW,
        dryerWatts: dryerW,
        dryerTodayKwh: today.dryerKwh,
        dryerTodayRuntimeMin: Math.round(today.dryerRuntimeMinutes),
        dryerTodayCost: today.dryerKwh * IMPORT_RATE_KWH,
        ovenWatts: ovenW,
        ovenTodayKwh: today.ovenKwh,
        ovenTodayRuntimeMin: Math.round(today.ovenRuntimeMinutes),
        ovenTodayCost: today.ovenKwh * IMPORT_RATE_KWH,
        washerWatts: washerW,
        washerTodayKwh: today.washerKwh,
        washerTodayRuntimeMin: Math.round(today.washerRuntimeMinutes),
        washerTodayCost: today.washerKwh * IMPORT_RATE_KWH,
        gridNetW,
        selfPoweredPct,
        dcWatts: lastSolar ? lastSolar.dcWatts : 0,
        heatSinkF,
        solarTodayKwh: today.solarKwh,
        houseTodayKwh: today.consumptionKwh,
        gridImportTodayKwh: today.gridImportKwh,
        gridExportTodayKwh: today.gridExportKwh,
        hvacTodayKwh: today.hvacKwh,
        hvacTodayRuntimeMin: Math.round(today.hvacRuntimeMinutes),
        hvacTodayCost: today.hvacKwh * IMPORT_RATE_KWH,
        hvacDutyCyclePct,
        importRateKwh: IMPORT_RATE_KWH,
        lifetimeKwh,
        importCostToday: today.gridImportKwh * IMPORT_RATE_KWH,
        exportCreditToday: today.gridExportKwh * EXPORT_RATE_KWH,
        netCostToday: (today.gridImportKwh * IMPORT_RATE_KWH) - (today.gridExportKwh * EXPORT_RATE_KWH),
        circuits: lastEmporia ? lastEmporia.circuits : [],
        uptimeHours: process.uptime() / 3600,
        memoryMb: process.memoryUsage().rss / 1024 / 1024,
        errorCount: totalErrorCount,
        lastError: lastErrorString,
        errorLog: recentErrors,
      });
    }
  } catch (err) {
    recordDaemonError("Publish Cycle", err);
  }
}

async function runModbusLoop() {
  console.log(`[Modbus Loop] Started (every ${modbusIntervalMs}ms)`);
  while (true) {
    try {
      const solar = await fetchSolarEdge();
      if (solar) {
        lastSolar = solar;
        processAndPublish();
      }
    } catch (err) {
      recordDaemonError("Modbus Loop", err);
    }
    await new Promise(r => setTimeout(r, modbusIntervalMs));
  }
}

async function runEmporiaLoop() {
  console.log(`[Emporia Loop] Started (every ${emporiaIntervalMs}ms)`);
  while (true) {
    try {
      if (!emporiaReady) {
        try {
          if (EMPORIA_USER && EMPORIA_PASS) {
            await vue.login({ username: EMPORIA_USER, password: EMPORIA_PASS });
            const devices = await vue.getDevices();
            emporiaDeviceGids = devices.map(d => d.deviceGid);
            emporiaReady = true;
            console.log(`[${new Date().toLocaleTimeString()}] Emporia authenticated (${devices.length} devices).`);
          }
        } catch (err) {
          recordDaemonError("Emporia Auth", err.message);
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
      }
      if (emporiaReady) {
        const emporia = await fetchEmporia();
        if (emporia) {
          lastEmporia = emporia;
          processAndPublish();
        }
      }
    } catch (err) {
      recordDaemonError("Emporia Loop", err);
    }
    await new Promise(r => setTimeout(r, emporiaIntervalMs));
  }
}

async function main() {
  console.log(`[${new Date().toLocaleTimeString()}] Starting Solar & Energy Daemon (HA Add-on)...`);
  console.log(`[Config] Inverter: ${INVERTER_IP}:${MODBUS_PORT} | Modbus Interval: ${modbusIntervalMs}ms`);
  console.log(`[Config] Emporia Vue Cloud | Emporia Interval: ${emporiaIntervalMs}ms`);
  console.log(`[Config] MQTT: ${HA_MQTT_BROKER} (User: ${HA_MQTT_USER})`);
  console.log(`[Config] Persistence path: ${ENERGY_LOG_FILE}`);

  // Connect to Home Assistant MQTT
  haMqtt.connect();

  // Modbus initial check
  const mbOk = await ensureModbusConnection();
  console.log(`[${new Date().toLocaleTimeString()}] Modbus TCP connected: ${mbOk}`);

  // Start independent polling loops
  runModbusLoop();
  runEmporiaLoop();

  // Start CPS Ingress Web Dashboard Server (Port 3355)
  try {
    const { startServer } = require("./cps-dashboard/server");
    startServer(3355).catch(err => {
      console.warn("[CPS Server] Dashboard server warning:", err.message);
    });
  } catch (e) {
    console.warn("[CPS Server] Could not load cps-dashboard/server:", e.message);
  }

  // Start CPS Smart Meter Sync Daemon (Startup push + daily scheduled sync)
  try {
    const { runSync } = require("./cps-sync");
    // Initial startup sync (runs in background so it doesn't block main startup)
    setTimeout(() => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const targetDate = yesterday.toISOString().split("T")[0];
      console.log(`[CPS Daemon] Triggering startup sync for ${targetDate}...`);
      runSync(targetDate).catch(err => {
        console.warn("[CPS Daemon] Startup sync warning:", err.message);
      });
    }, 4000);

    // Periodic interval: Check every minute for 4:00 AM and 6:00 AM
    setInterval(() => {
      const now = new Date();
      const hours = now.getHours();
      const mins = now.getMinutes();
      if ((hours === 4 || hours === 6) && mins === 0) {
        console.log("[CPS Daemon] Scheduled time reached, triggering daily sync...");
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const targetDate = yesterday.toISOString().split("T")[0];
        runSync(targetDate).catch(err => {
          console.warn("[CPS Daemon] Daily sync error:", err.message);
        });
      }
    }, 60000);
  } catch (e) {
    console.warn("[CPS Daemon] Could not load cps-sync:", e.message);
  }
}

process.on("uncaughtException", (err) => {
  recordDaemonError("Uncaught Exception", err);
});

process.on("unhandledRejection", (reason) => {
  recordDaemonError("Unhandled Rejection", reason);
});

main();
