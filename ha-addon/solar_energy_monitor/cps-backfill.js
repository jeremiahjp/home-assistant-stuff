// ============================================================================
//  CPS ENERGY SMART METER FULL HISTORICAL BACKFILL SERVICE
//  Backfills all 3 years of 15-minute smart meter interval data from
//  CPS Energy / SilverBlaze portal (Sep 10, 2023 to Sep 09, 2026).
//  Features: Idempotent resume, polite rate-limiting, periodic disk flush,
//  auto token renewal, and real-time status tracking.
// ============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');
const { authenticateAndGetToken, invalidateToken } = require('./cps-auth');

const HISTORY_FILE = path.join(__dirname, 'cps-history.json');
const STATUS_FILE = path.join(__dirname, 'cps-backfill-status.json');

// Load meter ID from HA options, environment variable, or .env
let METER_ID = process.env.CPS_METER_ID || '';
const OPTIONS_PATH = '/data/options.json';
if (fs.existsSync(OPTIONS_PATH)) {
  try {
    const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
    if (opts.cps_meter_id) METER_ID = String(opts.cps_meter_id);
  } catch (e) {}
}
const ENV_PATH = path.join(__dirname, '.env');
if (!METER_ID && fs.existsSync(ENV_PATH)) {
  const envContent = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('CPS_METER_ID=')) METER_ID = trimmed.substring('CPS_METER_ID='.length);
  }
}

// Polite pacing between day requests to prevent rate limiting (ms)
const DELAY_BETWEEN_REQUESTS_MS = 1200;

function req(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...headers
    };

    https.get(urlStr, { headers: reqHeaders }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// Fetch consumption data with automatic token renewal and retry
async function fetchWithRetry(queryParams, retryCount = 0) {
  const token = await authenticateAndGetToken();
  queryParams.parameters = token;
  const qStr = new URLSearchParams(queryParams).toString();
  const url = `https://acewebsite.silverblaze.com/api/ConsumptionV3/Data?${qStr}`;

  const res = await req(url);

  if (res.statusCode !== 200 || !res.body || res.body.startsWith('<!doctype')) {
    if (retryCount < 3) {
      console.warn(`[Backfill] API HTTP ${res.statusCode}. Renewing token and waiting 4s...`);
      invalidateToken();
      await new Promise(r => setTimeout(r, 4000));
      await authenticateAndGetToken(true);
      return fetchWithRetry(queryParams, retryCount + 1);
    }
    throw new Error(`API error HTTP ${res.statusCode}`);
  }

  try {
    return JSON.parse(res.body);
  } catch (e) {
    if (retryCount < 3) {
      console.warn(`[Backfill] JSON parse failed. Renewing token and retrying...`);
      invalidateToken();
      await new Promise(r => setTimeout(r, 3000));
      await authenticateAndGetToken(true);
      return fetchWithRetry(queryParams, retryCount + 1);
    }
    throw new Error(`Failed to parse response JSON: ${res.body.slice(0, 100)}`);
  }
}

// Fetch a single day's 15-minute electric and gas data
async function fetchDayData(targetDateStr) {
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

  const electricJson = await fetchWithRetry(electricQuery);

  // 2. Fetch daily gas
  let gasCcf = 0;
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
    const gasJson = await fetchWithRetry(gasQuery);
    const gasSeries = gasJson.AlignedSeriesData?.['forward/usage'] || [];
    gasCcf = gasSeries.find(v => v !== null && v !== undefined) || 0;
  } catch (e) {
    // gas is optional
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
    const watts = Math.round(imp * 4000);

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
    gasCcf: Number(Number(gasCcf).toFixed(2)),
    peakDemandWatts,
    peakDemandTime,
    intervalsCount: parsedIntervals.length,
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
        avgWatts: last1.avgWatts,
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

// Generate array of YYYY-MM-DD dates from startDate down to endDate (reverse chronological)
function generateDateList(startDateStr, endDateStr) {
  const dates = [];
  const current = new Date(`${startDateStr}T12:00:00.000Z`);
  const end = new Date(`${endDateStr}T12:00:00.000Z`);

  while (current >= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setDate(current.getDate() - 1);
  }
  return dates;
}

// Main backfill loop
async function runBackfill() {
  console.log('================================================================');
  console.log('  CPS ENERGY SMART METER FULL HISTORICAL BACKFILL');
  console.log('================================================================');

  // 1. Load existing history
  let history = {};
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`[Backfill] Loaded existing history: ${Object.keys(history).length} days already recorded.`);
    } catch (e) {
      console.warn('[Backfill] Could not parse existing history file, starting fresh.');
    }
  }

  // 2. Generate date targets (from yesterday down to 2023-09-10)
  const START_DATE = '2026-09-09';
  const END_DATE = '2023-09-10'; // exactly 3 years of data
  const allDates = generateDateList(START_DATE, END_DATE);
  const totalTargetDays = allDates.length;

  console.log(`[Backfill] Total target range: ${START_DATE} -> ${END_DATE} (${totalTargetDays} days)`);

  const missingDates = allDates.filter(d => !history[d]);
  console.log(`[Backfill] Missing days to fetch: ${missingDates.length} days.`);

  if (missingDates.length === 0) {
    console.log('[Backfill] All days already present in history! Nothing to do.');
    return;
  }

  const startTime = Date.now();
  let fetchedCount = 0;
  let errorCount = 0;

  // Function to flush history to disk safely
  function flushToDisk() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (e) {
      console.error('[Backfill] Failed to write history file:', e.message);
    }
  }

  // Update status file
  function updateStatus(curDate, idx) {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const ratePerDay = elapsedSec / Math.max(1, idx);
    const remainingDays = missingDates.length - idx;
    const etaSec = Math.round(remainingDays * ratePerDay);
    const etaMin = Math.round(etaSec / 60);

    const statusObj = {
      status: 'running',
      totalDays: totalTargetDays,
      alreadyHad: totalTargetDays - missingDates.length,
      toFetch: missingDates.length,
      currentDayIndex: idx,
      currentDate: curDate,
      percentComplete: Number(((idx / missingDates.length) * 100).toFixed(1)),
      elapsedSeconds: Math.round(elapsedSec),
      etaMinutes: etaMin,
      totalSavedDays: Object.keys(history).length,
      lastUpdated: new Date().toISOString()
    };

    try {
      fs.writeFileSync(STATUS_FILE, JSON.stringify(statusObj, null, 2));
    } catch (e) {}

    return { etaMin, pct: statusObj.percentComplete };
  }

  // Process days
  for (let i = 0; i < missingDates.length; i++) {
    const targetDate = missingDates[i];
    const { etaMin, pct } = updateStatus(targetDate, i + 1);

    try {
      const dayData = await fetchDayData(targetDate);
      history[targetDate] = dayData;
      fetchedCount++;

      const intervalsCount = dayData.intervalsCount || 0;
      const imp = dayData.totalImportKwh || 0;
      const exp = dayData.totalExportKwh || 0;

      console.log(`[${i + 1}/${missingDates.length} - ${pct}%] Ingested ${targetDate} (${intervalsCount} intvs) | Imp: ${imp} kWh, Exp: ${exp} kWh | ETA: ~${etaMin}m`);

      // Flush to disk every 10 days
      if (fetchedCount % 10 === 0) {
        flushToDisk();
      }

      // Polite pause
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS_MS));
    } catch (err) {
      errorCount++;
      console.warn(`[Backfill] Skipping ${targetDate} after error: ${err.message}`);
      // Brief pause before trying next date
      await new Promise(r => setTimeout(r, 2500));
    }
  }

  // Final flush to disk
  flushToDisk();

  const totalTimeMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log('\n================================================================');
  console.log(`[Backfill] COMPLETED! Ingested ${fetchedCount} days in ${totalTimeMin} minutes.`);
  console.log(`[Backfill] Total recorded days now in cps-history.json: ${Object.keys(history).length}`);
  console.log(`[Backfill] Errors encountered: ${errorCount}`);
  console.log('================================================================\n');

  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      status: 'completed',
      totalSavedDays: Object.keys(history).length,
      completedAt: new Date().toISOString(),
      durationMinutes: Number(totalTimeMin)
    }, null, 2));
  } catch (e) {}
}

runBackfill()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[Backfill] Fatal error:', err);
    process.exit(1);
  });
