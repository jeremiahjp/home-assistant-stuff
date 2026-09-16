const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { authenticateAndGetToken, invalidateToken } = require('../cps-auth');

process.on('uncaughtException', (err) => {
  console.error('[CPS Server uncaughtException]', err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CPS Server unhandledRejection]', reason);
});

const PORT = process.env.PORT || 3355;
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '..');
const HISTORY_FILE = path.join(DATA_DIR, 'cps-history.json');
const SEED_FILE = path.join(__dirname, '..', 'cps-history.json');
const ALT_SEED_FILE = path.join(__dirname, '..', 'cps-history-seed.json');

// If running in container and /data/cps-history.json doesn't exist, seed it
if (!fs.existsSync(HISTORY_FILE)) {
  if (fs.existsSync(ALT_SEED_FILE)) {
    try {
      fs.copyFileSync(ALT_SEED_FILE, HISTORY_FILE);
      console.log(`[CPS Server] Seeded history from ${ALT_SEED_FILE} to ${HISTORY_FILE}`);
    } catch (e) {
      console.warn(`[CPS Server] Failed to copy seed history:`, e.message);
    }
  } else if (fs.existsSync(SEED_FILE) && path.resolve(SEED_FILE) !== path.resolve(HISTORY_FILE)) {
    try {
      fs.copyFileSync(SEED_FILE, HISTORY_FILE);
      console.log(`[CPS Server] Seeded history from ${SEED_FILE} to ${HISTORY_FILE}`);
    } catch (e) {
      console.warn(`[CPS Server] Failed to copy seed history:`, e.message);
    }
  }
}

// Load meter ID from HA options, environment variable, or fallback
let METER_ID = process.env.CPS_METER_ID || '';
const OPTIONS_PATH = '/data/options.json';
if (fs.existsSync(OPTIONS_PATH)) {
  try {
    const opts = JSON.parse(fs.readFileSync(OPTIONS_PATH, 'utf8'));
    if (opts.cps_meter_id) METER_ID = String(opts.cps_meter_id);
  } catch (e) {}
}

// Read history from disk
function getHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      const hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      // Clean up any empty stubs with 0 intervals (e.g. invalid future dates)
      for (const k of Object.keys(hist)) {
        if (!hist[k] || hist[k].intervalsCount === 0 || !hist[k].intervals || hist[k].intervals.length === 0) {
          delete hist[k];
        }
      }
      return hist;
    } catch (e) {
      console.warn('[Server] Error parsing history file:', e.message);
    }
  }
  return {};
}

// Save history to disk
function saveHistory(date, data) {
  if (!data || !data.intervals || data.intervals.length === 0) {
    console.warn(`[Server] Skipping save for ${date}: no interval data`);
    return;
  }
  const history = getHistory();
  history[date] = data;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
    console.log(`[Server] Saved ${date} data (${data.intervals.length} intervals) to cps-history.json`);
  } catch (e) {
    console.error('[Server] Failed to save history:', e.message);
  }
}

// Helper to make HTTPS requests
function httpsReq(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...headers
    };

    https.get(urlStr, { headers: reqHeaders }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// Fetch consumption data from SilverBlaze API with auto-reauth
async function fetchSilverBlaze(queryParams, retryCount = 0) {
  const token = await authenticateAndGetToken();
  queryParams.parameters = token;
  const query = new URLSearchParams(queryParams).toString();
  const url = `https://acewebsite.silverblaze.com/api/ConsumptionV3/Data?${query}`;

  const res = await httpsReq(url);
  if (res.statusCode !== 200 || !res.body || res.body.startsWith('<!doctype')) {
    if (retryCount < 2) {
      console.warn(`[Server] SilverBlaze API returned status ${res.statusCode}. Renewing auth token...`);
      invalidateToken();
      await authenticateAndGetToken(true);
      return fetchSilverBlaze(queryParams, retryCount + 1);
    }
    throw new Error(`SilverBlaze API returned HTTP ${res.statusCode}`);
  }

  try {
    return JSON.parse(res.body);
  } catch (e) {
    if (retryCount < 2) {
      console.warn(`[Server] JSON parse failed. Renewing auth token...`);
      invalidateToken();
      await authenticateAndGetToken(true);
      return fetchSilverBlaze(queryParams, retryCount + 1);
    }
    throw new Error(`Failed to parse SilverBlaze JSON response: ${res.body.slice(0, 150)}`);
  }
}

// Parse raw API data into standardized dashboard structure
function parse15MinuteData(targetDateStr, json, gasJson = null) {
  const intervals = json.IntervalLayout?.ChartIntervals || [];
  const forward = json.AlignedSeriesData?.['forward/usage'] || [];
  const reverse = json.AlignedSeriesData?.['reverse/usage'] || [];
  const net = json.AlignedSeriesData?.['net/usage'] || [];

  let peakDemandWatts = 0;
  let peakDemandTime = '';

  const parsedIntervals = intervals.map((intv, idx) => {
    const imp = forward[idx] !== null && forward[idx] !== undefined ? forward[idx] : 0;
    const exp = reverse[idx] !== null && reverse[idx] !== undefined ? reverse[idx] : 0;
    const n = net[idx] !== null && net[idx] !== undefined ? net[idx] : (imp - exp);
    const avgWatts = Math.round(imp * 4000);
    const solarWatts = Math.round(exp * 4000);
    const netWatts = Math.round(n * 4000);

    if (avgWatts > peakDemandWatts) {
      peakDemandWatts = avgWatts;
      peakDemandTime = intv.TooltipDate || intv.Category;
    }

    return {
      index: idx,
      time: intv.TooltipDate || intv.Category,
      category: intv.Category,
      epochMs: intv.EpochMs,
      hour: intv.Hour,
      minute: intv.Minute,
      isLoaded: intv.IsAmiLoaded !== false,
      importKwh: Number(imp.toFixed(4)),
      exportKwh: Number(exp.toFixed(4)),
      netKwh: Number(n.toFixed(4)),
      avgWatts,
      solarWatts,
      netWatts,
      watts: avgWatts
    };
  });

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

  const totalDayImport = parsedIntervals.reduce((s, x) => s + x.importKwh, 0);
  const totalDayExport = parsedIntervals.reduce((s, x) => s + x.exportKwh, 0);
  const totalDayNet = parsedIntervals.reduce((s, x) => s + x.netKwh, 0);

  let gasCcf = 0;
  if (gasJson) {
    const gasSeries = gasJson.AlignedSeriesData?.['forward/usage'] || [];
    gasCcf = gasSeries.find(v => v !== null && v !== undefined) || 0;
  }

  return {
    date: targetDateStr,
    latestAmiMs: json.IntervalLayout?.LatestAmiMs,
    latestAmiFormatted: json.IntervalLayout?.LatestAmiMs
      ? new Date(json.IntervalLayout.LatestAmiMs).toLocaleString('en-US', { timeZone: 'America/Chicago' })
      : null,
    totalImportKwh: Number(totalDayImport.toFixed(2)),
    totalExportKwh: Number(totalDayExport.toFixed(2)),
    totalNetKwh: Number(totalDayNet.toFixed(2)),
    gasCcf: Number(Number(gasCcf).toFixed(2)),
    peakDemandWatts,
    peakDemandTime,
    intervalsCount: parsedIntervals.length,
    meta: {
      date: targetDateStr,
      latestMeterTimestamp: json.IntervalLayout?.LatestAmiMs,
      latestAmiFormatted: json.IntervalLayout?.LatestAmiMs
        ? new Date(json.IntervalLayout.LatestAmiMs).toLocaleString('en-US', { timeZone: 'America/Chicago' })
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
        importKwh: Number(totalDayImport.toFixed(2)),
        exportKwh: Number(totalDayExport.toFixed(2)),
        netKwh: Number(totalDayNet.toFixed(2))
      }
    },
    intervals: parsedIntervals
  };
}

// Fetch 15-minute intervals for target date
async function get15MinuteData(targetDateStr, forceRefresh = false) {
  if (!targetDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(targetDateStr) || parseInt(targetDateStr.slice(0, 4), 10) < 2020) {
    return {
      error: `Invalid date format: "${targetDateStr}". Expected YYYY-MM-DD.`,
      canRetry: false
    };
  }

  const history = getHistory();
  const cached = history[targetDateStr];

  // If cached and not explicitly forcing a refresh, return cached data immediately
  if (cached && !forceRefresh) {
    return { ...cached, source: 'cache', cached: true };
  }

  // Attempt live fetch from SilverBlaze
  try {
    const startUtc = new Date(`${targetDateStr}T05:00:00.000Z`);
    const endUtc = new Date(startUtc.getTime() + (24 * 60 * 60 * 1000) - 60000);

    const queryParams = {
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

    const electricJson = await fetchSilverBlaze(queryParams);

    // Also fetch gas if available
    let gasJson = null;
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
      gasJson = await fetchSilverBlaze(gasQuery);
    } catch (e) {
      // Non-fatal
    }

    const parsed = parse15MinuteData(targetDateStr, electricJson, gasJson);
    parsed.source = 'live';
    parsed.cached = false;

    // Check if CPS Energy has not published interval data yet (NoConsumption / empty intervals)
    const isNoConsumption = electricJson.NoConsumption === true || !electricJson.IntervalLayout || !parsed.intervals || parsed.intervals.length === 0;
    if (isNoConsumption) {
      console.log(`[Server] Live query for ${targetDateStr}: CPS Energy has not published interval data yet (NoConsumption/0 intervals).`);
      return {
        date: targetDateStr,
        noDataFromUtility: true,
        pendingUtilityPost: true,
        gasCcf: parsed.gasCcf || 0,
        intervalsCount: 0,
        intervals: [],
        source: 'live',
        cached: false,
        message: `CPS Energy has not yet published smart meter interval data for ${targetDateStr}. Electric smart meter data typically posts with a 24–48 hour delay.`,
        canQuery: true
      };
    }

    // Cache the successful result
    saveHistory(targetDateStr, parsed);
    return parsed;
  } catch (err) {
    console.error(`[Server] Live fetch failed for ${targetDateStr}:`, err.message);

    // Fallback 1: Return cached data for target date if available
    if (cached) {
      console.log(`[Server] Serving cached data for ${targetDateStr} after live fetch failure.`);
      return {
        ...cached,
        source: 'cache',
        cached: true,
        warning: `CPS portal query notice: ${err.message}. Displaying stored archive data.`
      };
    }

    // If explicit query was requested and failed, return an informative error
    if (forceRefresh) {
      return {
        error: `CPS Energy query failed for ${targetDateStr}: ${err.message}`,
        date: targetDateStr,
        canRetry: true
      };
    }

    // Date not in archive and not force-refreshing
    return {
      notInArchive: true,
      date: targetDateStr,
      message: `No data stored for ${targetDateStr} in local archive. Click 'Query CPS' to retrieve data from the portal.`,
      canQuery: true
    };
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsedUrl.pathname;

  // Handle Home Assistant Ingress prefix stripping if present
  const ingressPath = req.headers['x-ingress-path'] || '';
  if (ingressPath && pathname.startsWith(ingressPath)) {
    pathname = pathname.substring(ingressPath.length) || '/';
  }

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === '/api/data') {
      const targetDate = parsedUrl.searchParams.get('date') || '2026-09-09';
      const forceRefresh = parsedUrl.searchParams.get('refresh') === 'true';
      const data = await get15MinuteData(targetDate, forceRefresh);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/latest') {
      const history = getHistory();
      const dates = Object.keys(history)
        .filter(d => history[d] && history[d].intervals && history[d].intervals.length > 0)
        .sort()
        .reverse();
      const latestDate = dates[0] || '2026-09-10';
      const forceRefresh = parsedUrl.searchParams.get('refresh') === 'true';
      const data = await get15MinuteData(latestDate, forceRefresh);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (pathname === '/api/history') {
      const history = getHistory();
      const dates = Object.keys(history)
        .filter(d => history[d] && history[d].intervals && history[d].intervals.length > 0)
        .sort()
        .reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dates, count: dates.length }));
      return;
    }

    if (pathname === '/api/backfill-status') {
      const statusFile = path.join(DATA_DIR, 'cps-backfill-status.json');
      const altStatusFile = path.join(__dirname, '..', 'cps-backfill-status.json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (fs.existsSync(statusFile)) {
        res.end(fs.readFileSync(statusFile));
      } else if (fs.existsSync(altStatusFile)) {
        res.end(fs.readFileSync(altStatusFile));
      } else {
        res.end(JSON.stringify({ status: 'completed', totalSavedDays: Object.keys(getHistory()).length }));
      }
      return;
    }

    // Serve Static Files
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, 'public', 'index.html');
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png'
    };

    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message, canRetry: true }));
  }
});

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`[CPS Portal Dashboard] Running on port ${port} (Ingress ready)`);
      resolve(server);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[CPS Portal Dashboard] Port ${port} already in use, assuming existing server.`);
        resolve(server);
      } else {
        reject(err);
      }
    });
  });
}

if (require.main === module) {
  startServer(PORT);
}

module.exports = {
  startServer,
  server,
  getHistory,
  saveHistory,
  get15MinuteData
};
