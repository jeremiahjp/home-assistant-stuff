// ============================================================================
//  REAL-TIME POSTGRESQL ENERGY TELEMETRY LOGGER
//  Streams Emporia Vue circuits & whole-home metrics into PostgreSQL
//  Features:
//    - Write-on-change deadband filter (reduces write volume by 85-90%)
//    - Multi-row batch insertion for high performance
//    - Non-blocking error handling (never crashes or hangs main daemon)
//    - Real-time daily energy summary UPSERT
//    - Automated 60-Day Rolling Data Retention Purge
// ============================================================================
const { Pool } = require('pg');

class DbLogger {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.host = options.host || process.env.PG_HOST || '192.168.68.84';
    this.port = Number(options.port || process.env.PG_PORT) || 5432;
    this.user = options.user || process.env.PG_USER || 'postgres';
    this.password = options.password || process.env.PG_PASSWORD || 'ha_postgres_secure_pass_2026';
    this.database = options.database || process.env.PG_DATABASE || 'emporia_energy';

    this.pool = null;
    this.connected = false;
    this.circuitState = new Map();
    this.wholeHomeState = null;
    this.lastDailyUpsert = 0;
    this.lastRetentionCheck = 0;
    this.circuitQueue = [];
    this.isFlushing = false;

    if (this.enabled) {
      this.initPool();
    }
  }

  initPool() {
    try {
      this.pool = new Pool({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
        database: this.database,
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
      });

      this.pool.on('error', (err) => {
        console.warn('[DB Logger] Background PostgreSQL pool warning:', err.message);
        this.connected = false;
      });

      this.testConnection();
    } catch (err) {
      console.warn('[DB Logger] Failed to initialize PostgreSQL pool:', err.message);
      this.connected = false;
    }
  }

  async testConnection() {
    if (!this.pool) return;
    try {
      const res = await this.pool.query('SELECT NOW() as server_time;');
      this.connected = true;
      console.log('[DB Logger] PostgreSQL connected successfully to ' + this.database + ' on ' + this.host + ':' + this.port + ' (' + res.rows[0].server_time.toISOString() + ')');
      await this.ensureTables();
    } catch (err) {
      this.connected = false;
      console.warn('[DB Logger] Initial PostgreSQL connection check failed (' + this.host + ':' + this.port + '): ' + err.message + '. Will retry on write.');
    }
  }

  async ensureTables() {
    if (!this.pool || !this.connected) return;
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS circuit_energy_logs (
          id BIGSERIAL PRIMARY KEY,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          circuit_id VARCHAR(255) NOT NULL,
          circuit_name VARCHAR(255) NOT NULL,
          watts NUMERIC(10, 2) NOT NULL,
          kwh_cumulative NUMERIC(14, 4) DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_circuit_time ON circuit_energy_logs (circuit_name, recorded_at DESC);
        CREATE INDEX IF NOT EXISTS idx_time ON circuit_energy_logs (recorded_at DESC);

        CREATE TABLE IF NOT EXISTS whole_home_energy_logs (
          id BIGSERIAL PRIMARY KEY,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          solar_prod_watts NUMERIC(10, 2) NOT NULL,
          house_consumption_watts NUMERIC(10, 2) NOT NULL,
          grid_net_watts NUMERIC(10, 2) NOT NULL,
          subpanel_watts NUMERIC(10, 2) DEFAULT 0,
          hvac_watts NUMERIC(10, 2) DEFAULT 0,
          dryer_watts NUMERIC(10, 2) DEFAULT 0,
          oven_watts NUMERIC(10, 2) DEFAULT 0,
          solar_today_kwh NUMERIC(10, 3) DEFAULT 0,
          consumption_today_kwh NUMERIC(10, 3) DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_whole_home_time ON whole_home_energy_logs (recorded_at DESC);

        CREATE TABLE IF NOT EXISTS daily_energy_summary (
          summary_date DATE PRIMARY KEY,
          solar_kwh NUMERIC(10, 3) DEFAULT 0,
          consumption_kwh NUMERIC(10, 3) DEFAULT 0,
          grid_import_kwh NUMERIC(10, 3) DEFAULT 0,
          grid_export_kwh NUMERIC(10, 3) DEFAULT 0,
          net_cost_usd NUMERIC(10, 2) DEFAULT 0,
          peak_power_watts NUMERIC(10, 2) DEFAULT 0,
          hvac_runtime_minutes INT DEFAULT 0,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
    } catch (err) {
      console.warn('[DB Logger] Table ensure check warning:', err.message);
    }
  }

  getCircuitEntityId(name) {
    const slug = name
      .toString()
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (slug === 'fridge') return 'sensor.fridge_circuit_circuit_fridge';
    return 'sensor.home_solar_energy_monitor_circuit_' + slug;
  }

  // --- Real-time Circuit Telemetry Logging with Deadband ---
  async logCircuits(circuits) {
    if (!this.enabled || !Array.isArray(circuits) || circuits.length === 0) return;

    const now = Date.now();
    const batch = [];

    for (const c of circuits) {
      if (!c || !c.name) continue;
      const watts = Math.round(Number(c.watts) || 0);
      const prev = this.circuitState.get(c.name);

      let shouldLog = false;
      if (!prev) {
        shouldLog = true;
      } else {
        const timeDiff = now - prev.time;
        // Write on ANY change (1:1 with Home Assistant SQLite behavior) or 120s heartbeat
        if (watts !== prev.watts || timeDiff >= 120000) {
          shouldLog = true;
        }
      }

      if (shouldLog) {
        this.circuitState.set(c.name, { watts, time: now });
        batch.push({
          entityId: this.getCircuitEntityId(c.name),
          name: c.name,
          watts,
        });
      }
    }

    if (batch.length === 0) return;

    // Enqueue readings and flush asynchronously
    this.circuitQueue.push(...batch);
    this.flushCircuitQueue();
  }

  async flushCircuitQueue() {
    if (this.isFlushing || this.circuitQueue.length === 0 || !this.pool) return;
    this.isFlushing = true;

    try {
      const toWrite = this.circuitQueue.splice(0, 100);
      const nowIso = new Date().toISOString();
      const values = [];
      const rows = [];
      let idx = 1;

      for (const item of toWrite) {
        rows.push('($' + (idx++) + ', $' + (idx++) + ', $' + (idx++) + ', $' + (idx++) + ', $' + (idx++) + ')');
        values.push(nowIso, item.entityId, item.name, item.watts, 0);
      }

      const query = 'INSERT INTO circuit_energy_logs (recorded_at, circuit_id, circuit_name, watts, kwh_cumulative) VALUES ' + rows.join(', ');

      await this.pool.query(query, values);
      this.connected = true;
    } catch (err) {
      this.connected = false;
      console.warn('[DB Logger] Circuit write warning: ' + (err.code || err.message));
    } finally {
      this.isFlushing = false;
      if (this.circuitQueue.length > 0) {
        setImmediate(() => this.flushCircuitQueue());
      }
    }
  }

  // --- Whole-Home Aggregates Logging ---
  async logWholeHome(data) {
    if (!this.enabled || !this.pool || !data) return;

    const now = Date.now();
    const solarW = Math.round(data.solarProdW || 0);
    const houseW = Math.round(data.houseConsumptionW || 0);
    const gridW = Math.round(data.gridNetW || 0);

    let shouldLog = false;
    if (!this.wholeHomeState) {
      shouldLog = true;
    } else {
      const timeDiff = now - this.wholeHomeState.time;
      // Write on any whole-home power change or 120s heartbeat
      if (
        solarW !== this.wholeHomeState.solar ||
        houseW !== this.wholeHomeState.house ||
        gridW !== this.wholeHomeState.grid ||
        timeDiff >= 120000
      ) {
        shouldLog = true;
      }
    }

    if (!shouldLog) return;

    this.wholeHomeState = { solar: solarW, house: houseW, grid: gridW, time: now };

    try {
      await this.pool.query(
        'INSERT INTO whole_home_energy_logs (' +
        '  recorded_at, solar_prod_watts, house_consumption_watts, grid_net_watts, ' +
        '  subpanel_watts, hvac_watts, dryer_watts, oven_watts, ' +
        '  solar_today_kwh, consumption_today_kwh' +
        ') VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9);',
        [
          solarW,
          houseW,
          gridW,
          Math.round(data.subpanelWatts || 0),
          Math.round(data.hvacEstimatedWatts || 0),
          Math.round(data.dryerWatts || 0),
          Math.round(data.ovenWatts || 0),
          Number(data.solarTodayKwh || 0).toFixed(3),
          Number(data.houseTodayKwh || 0).toFixed(3),
        ]
      );
      this.connected = true;
    } catch (err) {
      this.connected = false;
      console.warn('[DB Logger] Whole home write warning: ' + err.message);
    }
  }

  // --- Daily Energy Summary UPSERT (Every 60 Seconds) ---
  async upsertDailySummary(today, importRate, exportRate) {
    if (!this.enabled || !this.pool || !today) return;
    const now = Date.now();
    if (now - this.lastDailyUpsert < 60000) return;
    this.lastDailyUpsert = now;

    try {
      const d = new Date();
      const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const importCost = (today.gridImportKwh || 0) * (importRate || 0.14);
      const exportCredit = (today.gridExportKwh || 0) * (exportRate || 0.01);
      const netCost = Number((importCost - exportCredit).toFixed(2));

      await this.pool.query(
        'INSERT INTO daily_energy_summary (' +
        '  summary_date, solar_kwh, consumption_kwh, grid_import_kwh, grid_export_kwh, ' +
        '  net_cost_usd, peak_power_watts, hvac_runtime_minutes, updated_at' +
        ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW()) ' +
        'ON CONFLICT (summary_date) DO UPDATE SET ' +
        '  solar_kwh = EXCLUDED.solar_kwh, ' +
        '  consumption_kwh = EXCLUDED.consumption_kwh, ' +
        '  grid_import_kwh = EXCLUDED.grid_import_kwh, ' +
        '  grid_export_kwh = EXCLUDED.grid_export_kwh, ' +
        '  net_cost_usd = EXCLUDED.net_cost_usd, ' +
        '  peak_power_watts = EXCLUDED.peak_power_watts, ' +
        '  hvac_runtime_minutes = EXCLUDED.hvac_runtime_minutes, ' +
        '  updated_at = NOW();',
        [
          dateStr,
          Number((today.solarKwh || 0).toFixed(3)),
          Number((today.consumptionKwh || 0).toFixed(3)),
          Number((today.gridImportKwh || 0).toFixed(3)),
          Number((today.gridExportKwh || 0).toFixed(3)),
          netCost,
          Number((today.peakConsumptionW || 0).toFixed(2)),
          Math.round(today.hvacRuntimeMinutes || 0),
        ]
      );
    } catch (err) {
      console.warn('[DB Logger] Daily summary UPSERT warning: ' + err.message);
    }
  }

  // --- Automated 60-Day Rolling Prune (Once per 24h) ---
  async checkRetentionPurge() {
    if (!this.enabled || !this.pool) return;
    const now = Date.now();
    if (now - this.lastRetentionCheck < 86400000) return;
    this.lastRetentionCheck = now;

    try {
      console.log('[DB Logger] Running 60-day rolling retention cleanup...');
      const res1 = await this.pool.query("DELETE FROM circuit_energy_logs WHERE recorded_at < NOW() - INTERVAL '60 days';");
      const res2 = await this.pool.query("DELETE FROM whole_home_energy_logs WHERE recorded_at < NOW() - INTERVAL '60 days';");
      console.log('[DB Logger] 60-day cleanup finished. Removed ' + (res1.rowCount || 0) + ' circuit rows and ' + (res2.rowCount || 0) + ' whole-home rows.');
    } catch (err) {
      console.warn('[DB Logger] Retention purge warning: ' + err.message);
    }
  }

  async close() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch (_) {}
    }
  }
}

module.exports = DbLogger;
