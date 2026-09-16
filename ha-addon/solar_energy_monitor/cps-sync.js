// ============================================================================
//  CPS ENERGY SMART METER INGESTION DAEMON (Home Assistant MQTT Integration)
//  Automates login to CPS Energy / SilverBlaze portal, pulls 15-minute AMI
//  smart meter intervals (electric + gas), stores history, and publishes
//  MQTT discovery sensors to Home Assistant.
// ============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { authenticateAndGetToken, invalidateToken } = require('./cps-auth');

// Load environment variables and Home Assistant Add-on options
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const HISTORY_FILE = path.join(DATA_DIR, 'cps-history.json');
const SEED_FILE = path.join(__dirname, 'cps-history.json');
const ALT_SEED_FILE = path.join(__dirname, 'cps-history-seed.json');

// Seed history into /data if running in HA container
if (!fs.existsSync(HISTORY_FILE)) {
  if (fs.existsSync(ALT_SEED_FILE)) {
    try {
      fs.copyFileSync(ALT_SEED_FILE, HISTORY_FILE);
      console.log(`[CPS Sync] Seeded history from ${ALT_SEED_FILE} to ${HISTORY_FILE}`);
    } catch (e) {}
  } else if (fs.existsSync(SEED_FILE) && path.resolve(SEED_FILE) !== path.resolve(HISTORY_FILE)) {
    try {
      fs.copyFileSync(SEED_FILE, HISTORY_FILE);
      console.log(`[CPS Sync] Seeded history from ${SEED_FILE} to ${HISTORY_FILE}`);
    } catch (e) {}
  }
}

let HA_MQTT_BROKER = process.env.HA_MQTT_BROKER || 'mqtt://core-mosquitto:1883';
let HA_MQTT_USER = process.env.HA_MQTT_USER || 'solar';
let METER_ID = process.env.CPS_METER_ID || '';

const OPTIONS_PATH = '/data/options.json';
if (fs.existsSync(OPTIONS_PATH)) {
  try {
    const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
    if (opts.mqtt_broker) HA_MQTT_BROKER = opts.mqtt_broker;
    if (opts.mqtt_user) HA_MQTT_USER = opts.mqtt_user;
    if (opts.mqtt_pass) HA_MQTT_PASS = opts.mqtt_pass;
    if (opts.cps_meter_id) METER_ID = String(opts.cps_meter_id);
  } catch (e) {}
}

const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('HA_MQTT_BROKER=')) HA_MQTT_BROKER = trimmed.substring('HA_MQTT_BROKER='.length);
    if (trimmed.startsWith('HA_MQTT_USER=')) HA_MQTT_USER = trimmed.substring('HA_MQTT_USER='.length);
    if (trimmed.startsWith('HA_MQTT_PASS=')) HA_MQTT_PASS = trimmed.substring('HA_MQTT_PASS='.length);
    if (trimmed.startsWith('CPS_METER_ID=')) METER_ID = trimmed.substring('CPS_METER_ID='.length);
  }
}

function req(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...options.headers
    };

    const r = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers
    }, res => {
      let body = '';
      res.on('data', ch => body += ch);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

// Fetch consumption data from SilverBlaze API with automatic token renewal retry
async function fetchChartData(queryParams, retryCount = 0) {
  const token = await authenticateAndGetToken();
  queryParams.parameters = token;

  const query = new URLSearchParams(queryParams).toString();
  const url = `https://acewebsite.silverblaze.com/api/ConsumptionV3/Data?${query}`;
  const res = await req(url);

  if (res.statusCode !== 200 || !res.body || res.body.startsWith('<!doctype')) {
    if (retryCount < 2) {
      console.warn(`[CPS Sync] API returned HTTP ${res.statusCode} (attempt ${retryCount + 1}). Renewing token and retrying...`);
      invalidateToken();
      await authenticateAndGetToken(true);
      return fetchChartData(queryParams, retryCount + 1);
    }
    throw new Error(`API returned HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`);
  }

  try {
    return JSON.parse(res.body);
  } catch (e) {
    if (retryCount < 2) {
      console.warn(`[CPS Sync] JSON parse error (attempt ${retryCount + 1}). Renewing token and retrying...`);
      invalidateToken();
      await authenticateAndGetToken(true);
      return fetchChartData(queryParams, retryCount + 1);
    }
    throw new Error(`Failed to parse chart response: ${res.body.slice(0, 200)}`);
  }
}

// Query 15-minute interval data and gas for a target date (YYYY-MM-DD)
async function getSmartMeterData(targetDateStr) {
  // CST is UTC-5; midnight CST is 05:00 UTC
  const startUtc = new Date(`${targetDateStr}T05:00:00.000Z`);
  const endUtc = new Date(startUtc.getTime() + (24 * 60 * 60 * 1000) - 60000);

  // 1. Fetch 15-minute electric intervals
  const electricQuery = {
    tabKey: 'tab.usagesubnav',
    commodity: 'electric',
    resolution: '15min',
    startDate: startUtc.toISOString(),
    endDate: endUtc.toISOString(),
    collectionId: METER_ID,
    collectionType: 'ServicePointId',
    clientTimezone: 'CST',
    chartId: '15minavg',
    isBillPeriodSelected: 'false',
    drilledFromChartId: 'houravg',
    drilling: 'true',
    drilldownDate: startUtc.getTime().toString()
  };

  const electricJson = await fetchChartData(electricQuery);

  // 2. Fetch Gas daily data
  let gasKwh = 0;
  try {
    const gasQuery = {
      tabKey: 'tab.usagesubnav',
      commodity: 'gas',
      resolution: 'day',
      startDate: startUtc.toISOString(),
      endDate: endUtc.toISOString(),
      collectionId: 'All',
      collectionType: 'ServicePointId',
      clientTimezone: 'CST',
      chartId: 'daytemp',
      isBillPeriodSelected: 'false'
    };
    const gasJson = await fetchChartData(gasQuery);
    const gasSeries = gasJson.AlignedSeriesData?.['forward/usage'] || [];
    gasKwh = gasSeries.find(v => v !== null && v !== undefined) || 0;
  } catch (err) {
    console.warn('[CPS Sync] Gas query warning:', err.message);
  }

  const intervals = electricJson.IntervalLayout?.ChartIntervals || [];
  const forward = electricJson.AlignedSeriesData?.['forward/usage'] || [];
  const reverse = electricJson.AlignedSeriesData?.['reverse/usage'] || [];
  const net = electricJson.AlignedSeriesData?.['net/usage'] || [];

  let peakDemandWatts = 0;
  let peakDemandTime = '';

  const parsedIntervals = intervals.map((intv, idx) => {
    const imp = forward[idx] !== null && forward[idx] !== undefined ? forward[idx] : 0;
    const exp = reverse[idx] !== null && reverse[idx] !== undefined ? reverse[idx] : 0;
    const n = net[idx] !== null && net[idx] !== undefined ? net[idx] : (imp - exp);
    const watts = Math.round(imp * 4000); // 15-min kWh to continuous Watts

    if (watts > peakDemandWatts) {
      peakDemandWatts = watts;
      peakDemandTime = intv.TooltipDate || intv.Category;
    }

    return {
      index: idx,
      epochMs: intv.EpochMs,
      time: intv.TooltipDate || intv.Category,
      category: intv.Category,
      hour: intv.Hour,
      minute: intv.Minute,
      isLoaded: intv.IsAmiLoaded !== false,
      importKwh: Number(imp.toFixed(4)),
      exportKwh: Number(exp.toFixed(4)),
      netKwh: Number(n.toFixed(4)),
      avgWatts: watts,
      solarWatts: Math.round(exp * 4000),
      netWatts: Math.round(n * 4000),
      watts
    };
  });

  const totalImport = parsedIntervals.reduce((s, x) => s + x.importKwh, 0);
  const totalExport = parsedIntervals.reduce((s, x) => s + x.exportKwh, 0);
  const totalNet = parsedIntervals.reduce((s, x) => s + x.netKwh, 0);

  // Compute Time-of-Use blocks (Overnight, Morning, Afternoon, Evening)
  const tou = {
    night: { label: 'Overnight (12am-6am)', imp: 0, exp: 0, net: 0, peakW: 0 },
    morning: { label: 'Morning (6am-12pm)', imp: 0, exp: 0, net: 0, peakW: 0 },
    afternoon: { label: 'Afternoon (12pm-6pm)', imp: 0, exp: 0, net: 0, peakW: 0 },
    evening: { label: 'Evening (6pm-12am)', imp: 0, exp: 0, net: 0, peakW: 0 }
  };

  parsedIntervals.forEach(d => {
    const h = d.hour;
    let b;
    if (h >= 0 && h < 6) b = tou.night;
    else if (h >= 6 && h < 12) b = tou.morning;
    else if (h >= 12 && h < 18) b = tou.afternoon;
    else b = tou.evening;

    b.imp += d.importKwh;
    b.exp += d.exportKwh;
    b.net += d.netKwh;
    if (d.avgWatts > b.peakW) b.peakW = d.avgWatts;
  });

  for (const k in tou) {
    tou[k].imp = Number(tou[k].imp.toFixed(2));
    tou[k].exp = Number(tou[k].exp.toFixed(2));
    tou[k].net = Number(tou[k].net.toFixed(2));
  }

  // Top peak demand intervals
  const topPeaks = [...parsedIntervals]
    .sort((a, b) => b.avgWatts - a.avgWatts)
    .slice(0, 4)
    .map(p => ({
      time: p.time,
      category: p.category,
      watts: p.avgWatts,
      importKwh: p.importKwh
    }));

  // Compute rollups for 15m, 30m, 1h
  const loadedList = parsedIntervals.filter(x => x.isLoaded && (x.importKwh > 0 || x.exportKwh > 0 || x.netKwh !== 0));
  const activeList = loadedList.length > 0 ? loadedList : parsedIntervals;

  const last1 = activeList.slice(-1)[0] || { importKwh: 0, exportKwh: 0, netKwh: 0, avgWatts: 0, solarWatts: 0, netWatts: 0, time: 'N/A' };
  const last2 = activeList.slice(-2);
  const import30 = last2.reduce((s, x) => s + x.importKwh, 0);
  const export30 = last2.reduce((s, x) => s + x.exportKwh, 0);
  const net30 = last2.reduce((s, x) => s + x.netKwh, 0);

  const last4 = activeList.slice(-4);
  const import60 = last4.reduce((s, x) => s + x.importKwh, 0);
  const export60 = last4.reduce((s, x) => s + x.exportKwh, 0);
  const net60 = last4.reduce((s, x) => s + x.netKwh, 0);

  return {
    date: targetDateStr,
    latestAmiMs: electricJson.IntervalLayout?.LatestAmiMs,
    latestAmiFormatted: electricJson.IntervalLayout?.LatestAmiMs
      ? new Date(electricJson.IntervalLayout.LatestAmiMs).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      : null,
    totalImportKwh: Number(totalImport.toFixed(2)),
    totalExportKwh: Number(totalExport.toFixed(2)),
    totalNetKwh: Number(totalNet.toFixed(2)),
    gasCcf: Number(gasKwh.toFixed(2)),
    peakDemandWatts,
    peakDemandTime,
    intervalsCount: parsedIntervals.length,
    tou,
    topPeaks,
    meta: {
      date: targetDateStr,
      latestMeterTimestamp: electricJson.IntervalLayout?.LatestAmiMs,
      latestAmiFormatted: electricJson.IntervalLayout?.LatestAmiMs
        ? new Date(electricJson.IntervalLayout.LatestAmiMs).toLocaleString('en-US', { timeZone: 'America/Chicago' })
        : null,
      meterId: METER_ID,
      totalIntervals: parsedIntervals.length,
      loadedIntervals: activeList.length
    },
    rollups: {
      last15m: {
        label: 'Last 15 Minutes',
        timeWindow: last1.time,
        importKwh: Number(last1.importKwh.toFixed(3)),
        exportKwh: Number(last1.exportKwh.toFixed(3)),
        netKwh: Number(last1.netKwh.toFixed(3)),
        avgWatts: last1.avgWatts || last1.watts,
        solarWatts: last1.solarWatts,
        netWatts: last1.netWatts
      },
      last30m: {
        label: 'Last 30 Minutes',
        timeWindow: last2.length >= 2 ? `${last2[0].time} to ${last2[1].time}` : last1.time,
        importKwh: Number(import30.toFixed(3)),
        exportKwh: Number(export30.toFixed(3)),
        netKwh: Number(net30.toFixed(3)),
        avgWatts: Math.round(import30 * 2000),
        solarWatts: Math.round(export30 * 2000),
        netWatts: Math.round(net30 * 2000)
      },
      last1h: {
        label: 'Last 1 Hour',
        timeWindow: last4.length > 0 ? `${last4[0].time} to ${last4[last4.length - 1].time}` : last1.time,
        importKwh: Number(import60.toFixed(3)),
        exportKwh: Number(export60.toFixed(3)),
        netKwh: Number(net60.toFixed(3)),
        avgWatts: Math.round(import60 * 1000),
        solarWatts: Math.round(export60 * 1000),
        netWatts: Math.round(net60 * 1000)
      },
      dayTotals: {
        importKwh: Number(totalImport.toFixed(2)),
        exportKwh: Number(totalExport.toFixed(2)),
        netKwh: Number(totalNet.toFixed(2))
      }
    },
    intervals: parsedIntervals
  };
}

// Publish MQTT discovery & entities to Home Assistant Mosquitto
async function publishToHomeAssistant(data) {
  return new Promise((resolve, reject) => {
    console.log(`[CPS MQTT] Connecting to broker: ${HA_MQTT_BROKER}...`);
    const client = mqtt.connect(HA_MQTT_BROKER, {
      username: HA_MQTT_USER,
      password: HA_MQTT_PASS,
      connectTimeout: 7000
    });

    client.on('error', err => {
      console.error('[CPS MQTT] Connection error:', err.message);
      client.end();
      reject(err);
    });

    client.on('connect', () => {
      console.log('[CPS MQTT] Connected to Mosquitto! Publishing discovery configs...');

      const device = {
        identifiers: [METER_ID ? `cps_smart_meter_${METER_ID}` : 'cps_smart_meter_ami'],
        name: 'CPS Energy Smart Meter (AMI)',
        model: 'Landis+Gyr FOCUS AXR-SD',
        manufacturer: 'CPS Energy / Landis+Gyr',
        sw_version: 'SilverBlaze AMI 15m'
      };

      const sensors = [
        {
          id: 'cps_meter_import_yesterday',
          name: 'CPS Smart Meter Import (Yesterday)',
          unit_of_measurement: 'kWh',
          device_class: 'energy',
          state_class: 'total',
          icon: 'mdi:transmission-tower-import',
          value: data.totalImportKwh
        },
        {
          id: 'cps_meter_solar_export_yesterday',
          name: 'CPS Smart Meter Solar Export (Yesterday)',
          unit_of_measurement: 'kWh',
          device_class: 'energy',
          state_class: 'total',
          icon: 'mdi:transmission-tower-export',
          value: data.totalExportKwh
        },
        {
          id: 'cps_meter_net_yesterday',
          name: 'CPS Smart Meter Net (Yesterday)',
          unit_of_measurement: 'kWh',
          icon: 'mdi:scale-balance',
          value: data.totalNetKwh
        },
        {
          id: 'cps_meter_gas_yesterday',
          name: 'CPS Gas Meter (Yesterday)',
          unit_of_measurement: 'CCF',
          device_class: 'gas',
          icon: 'mdi:fire',
          value: data.gasCcf
        },
        {
          id: 'cps_meter_peak_15m_demand',
          name: 'CPS Peak 15-Minute Demand',
          unit_of_measurement: 'W',
          device_class: 'power',
          icon: 'mdi:chart-bell-curve',
          value: data.peakDemandWatts
        },
        {
          id: 'cps_meter_last_batch_time',
          name: 'CPS Latest AMI Batch Processed',
          icon: 'mdi:clock-check-outline',
          value: data.latestAmiFormatted || 'Synced'
        },
        {
          id: 'cps_meter_sync_status',
          name: 'CPS Sync Status',
          icon: 'mdi:cloud-check-outline',
          value: 'Synced'
        },
        {
          id: 'cps_meter_sync_timestamp',
          name: 'CPS Last Sync Time',
          icon: 'mdi:calendar-sync',
          value: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })
        }
      ];

      // Publish Discovery topics
      sensors.forEach(s => {
        const configTopic = `homeassistant/sensor/cps_smart_meter/${s.id}/config`;
        const stateTopic = `homeassistant/sensor/cps_smart_meter/${s.id}/state`;
        const configPayload = {
          name: s.name,
          unique_id: s.id,
          state_topic: stateTopic,
          device
        };
        if (s.unit_of_measurement) configPayload.unit_of_measurement = s.unit_of_measurement;
        if (s.device_class) configPayload.device_class = s.device_class;
        if (s.state_class) configPayload.state_class = s.state_class;
        if (s.icon) configPayload.icon = s.icon;

        client.publish(configTopic, JSON.stringify(configPayload), { retain: true });
        client.publish(stateTopic, String(s.value), { retain: true });
      });

      // Publish Full Intervals Sensor with attributes
      const intervalsConfigTopic = `homeassistant/sensor/cps_smart_meter/cps_meter_intervals/config`;
      const intervalsStateTopic = `homeassistant/sensor/cps_smart_meter/cps_meter_intervals/state`;
      const intervalsAttrTopic = `homeassistant/sensor/cps_smart_meter/cps_meter_intervals/attributes`;

      client.publish(intervalsConfigTopic, JSON.stringify({
        name: 'CPS 15-Minute Intervals',
        unique_id: 'cps_meter_intervals',
        state_topic: intervalsStateTopic,
        json_attributes_topic: intervalsAttrTopic,
        icon: 'mdi:chart-timeline-variant-shimmer',
        device
      }), { retain: true });

      // Ensure tou & top_peaks are present
      let touData = data.tou;
      let topPeaksData = data.topPeaks;
      if (!touData && data.intervals && data.intervals.length > 0) {
        touData = {
          night: { label: 'Overnight (12am-6am)', imp: 0, exp: 0, net: 0, peakW: 0 },
          morning: { label: 'Morning (6am-12pm)', imp: 0, exp: 0, net: 0, peakW: 0 },
          afternoon: { label: 'Afternoon (12pm-6pm)', imp: 0, exp: 0, net: 0, peakW: 0 },
          evening: { label: 'Evening (6pm-12am)', imp: 0, exp: 0, net: 0, peakW: 0 }
        };
        data.intervals.forEach(d => {
          const h = d.hour;
          let b = (h >= 0 && h < 6) ? touData.night : (h >= 6 && h < 12) ? touData.morning : (h >= 12 && h < 18) ? touData.afternoon : touData.evening;
          b.imp += d.importKwh; b.exp += d.exportKwh; b.net += d.netKwh;
          if (d.avgWatts > b.peakW) b.peakW = d.avgWatts;
        });
        for (const k in touData) {
          touData[k].imp = Number(touData[k].imp.toFixed(2));
          touData[k].exp = Number(touData[k].exp.toFixed(2));
          touData[k].net = Number(touData[k].net.toFixed(2));
        }
      }
      if (!topPeaksData && data.intervals && data.intervals.length > 0) {
        topPeaksData = [...data.intervals].sort((a, b) => b.avgWatts - a.avgWatts).slice(0, 4).map(p => ({
          time: p.time, category: p.category, watts: p.avgWatts, importKwh: p.importKwh
        }));
      }

      client.publish(intervalsAttrTopic, JSON.stringify({
        date: data.date,
        latest_batch: data.latestAmiFormatted,
        peak_demand_watts: data.peakDemandWatts,
        peak_demand_time: data.peakDemandTime,
        tou: touData,
        top_peaks: topPeaksData,
        intervals: data.intervals
      }), { retain: true });

      console.log(`[CPS MQTT] Published all 9 sensors and 96 interval attributes!`);
      setTimeout(() => {
        client.end();
        resolve();
      }, 1000);
    });
  });
}

// Ingest target date data and save to history
async function runSync(targetDate) {
  const dateToSync = targetDate || (() => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  })();

  console.log(`\n======================================================`);
  console.log(`[CPS Sync] Starting sync for target date: ${dateToSync}`);
  console.log(`======================================================`);

  let data;
  try {
    data = await getSmartMeterData(dateToSync);
    if (!data || !data.intervalsCount || data.intervalsCount === 0) {
      throw new Error(`Live API returned 0 intervals for ${dateToSync} (AMI batch not ready yet)`);
    }
    console.log(`[CPS Sync] Received ${data.intervalsCount} intervals from live API.`);
    console.log(`   Import:       ${data.totalImportKwh} kWh`);
    console.log(`   Solar Export: ${data.totalExportKwh} kWh`);
    console.log(`   Net:          ${data.totalNetKwh} kWh`);
    console.log(`   Gas:          ${data.gasCcf} CCF`);
    console.log(`   Peak Demand:  ${data.peakDemandWatts} W (at ${data.peakDemandTime})`);

    // Save to persistent file
    let history = {};
    if (fs.existsSync(HISTORY_FILE)) {
      try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) {}
    }
    history[dateToSync] = data;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`[CPS Sync] Saved history to ${HISTORY_FILE}`);
  } catch (err) {
    console.warn(`[CPS Sync] Live fetch notice (${err.message}). Checking cached history...`);
    let history = {};
    if (fs.existsSync(HISTORY_FILE)) {
      try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) {}
    }
    const validDates = Object.keys(history)
      .filter(d => (history[d].intervalsCount > 0) || (history[d].intervals && history[d].intervals.length > 0))
      .sort()
      .reverse();

    if (history[dateToSync] && ((history[dateToSync].intervalsCount > 0) || (history[dateToSync].intervals && history[dateToSync].intervals.length > 0))) {
      console.log(`[CPS Sync] Found cached data for ${dateToSync}! Using cached history.`);
      data = history[dateToSync];
    } else if (validDates.length > 0) {
      console.log(`[CPS Sync] Using latest available history date with intervals: ${validDates[0]}`);
      data = history[validDates[0]];
    } else {
      console.error(`[CPS Sync] No cached data available.`);
      throw err;
    }
  }

  try {
    // Publish to Home Assistant MQTT
    await publishToHomeAssistant(data);
    console.log(`[CPS Sync] Sync completed successfully for ${data.date || dateToSync}!\n`);
    return data;
  } catch (mqttErr) {
    console.error(`[CPS Sync] MQTT publish failed:`, mqttErr.message);
    throw mqttErr;
  }
}

// Ingest past N days (e.g. range=7)
async function ingestRange(days = 7) {
  console.log(`[CPS Ingestion] Ingesting the past ${days} days...`);
  const now = new Date();
  const dates = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }

  for (const dt of dates) {
    try {
      await runSync(dt);
      // Wait 1.5s between days to avoid rate limits
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn(`[CPS Ingestion] Could not ingest ${dt}: ${e.message}`);
    }
  }
  console.log(`[CPS Ingestion] Finished range ingestion!`);
}

// CLI Execution handler
const isOnce = process.argv.includes('--once');
const rangeArg = process.argv.find(a => a.startsWith('--range='));
const dateArg = process.argv.find(a => a.startsWith('--date='));

if (rangeArg) {
  const days = parseInt(rangeArg.split('=')[1], 10) || 7;
  ingestRange(days).then(() => process.exit(0)).catch(() => process.exit(1));
} else if (isOnce) {
  const targetDate = dateArg ? dateArg.split('=')[1] : '2026-09-09';
  runSync(targetDate).then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  // Daemon mode: run once on startup, then schedule nightly at 4:00 AM & 6:00 AM
  console.log('[CPS Daemon] Starting CPS Smart Meter Ingestion Daemon...');
  runSync('2026-09-09').catch(() => {});

  setInterval(() => {
    const now = new Date();
    const hours = now.getHours();
    const mins = now.getMinutes();
    // Run at 4:00 AM and 6:00 AM
    if ((hours === 4 || hours === 6) && mins === 0) {
      console.log('[CPS Daemon] Scheduled time reached, triggering daily sync...');
      runSync().catch(() => {});
    }
  }, 60000); // check every minute
}

module.exports = {
  getSmartMeterData,
  runSync,
  ingestRange
};
