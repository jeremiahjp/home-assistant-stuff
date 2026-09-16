// ============================================================================
//  Home Assistant MQTT Auto-Discovery & Publisher (Add-on Edition)
//  Publishes SolarEdge + Emporia Vue data to Home Assistant via MQTT
// ============================================================================
const mqtt = require("mqtt");

const DISCOVERY_PREFIX = "homeassistant";
const BASE_TOPIC = "home/energy";

const DEVICE = {
  identifiers: ["solaredge_emporia_unified_monitor"],
  name: "Home Solar & Energy Monitor",
  manufacturer: "SolarEdge + Emporia Vue",
  model: "Unified Modbus/Cloud Monitor",
  sw_version: "1.0.0",
};

class HaMqttPublisher {
  constructor(options = {}) {
    this.brokerUrl = options.brokerUrl || "mqtt://core-mosquitto:1883";
    this.username = options.username || "solar";
    this.password = options.password || "";
    this.client = null;
    this.connected = false;
    this.discoveredCircuits = new Set();
    this.statusMessage = "Disconnected";
    this.latestHvacWatts = 0;
    this.latestOutdoorWatts = 0;
    this.latestBlowerWatts = 0;
    this.onHvacPower = null;
    this.onOutdoorPower = null;
    this.onBlowerPower = null;
  }

  connect() {
    this.client = mqtt.connect(this.brokerUrl, {
      username: this.username,
      password: this.password,
      reconnectPeriod: 5000,
      clientId: `solar_energy_monitor_${Math.random().toString(16).slice(2, 8)}`,
    });

    this.client.on("connect", () => {
      this.connected = true;
      this.statusMessage = "Connected";
      console.log(`[MQTT] Connected to broker: ${this.brokerUrl}`);
      this.client.publish(`${BASE_TOPIC}/status`, "online", { retain: true, qos: 1 });
      this.client.subscribe(`${BASE_TOPIC}/settings/+/set`);
      this.client.subscribe(`${BASE_TOPIC}/circuits/hvac_thermostat/power`);
      this.client.subscribe(`${BASE_TOPIC}/circuits/hvac_thermostat/outdoor_power`);
      this.client.subscribe(`${BASE_TOPIC}/circuits/dryer/power`);
      this.client.subscribe(`${BASE_TOPIC}/circuits/oven/power`);
      this.client.subscribe(`${BASE_TOPIC}/circuits/washer/power`);
      this.publishBaseDiscovery();
      if (this.onConnect) this.onConnect();
    });

    this.client.on("message", (topic, payload) => {
      const payloadStr = payload.toString().trim();
      const match = topic.match(/^home\/energy\/settings\/(.+)\/set$/);
      if (match && this.onSettingChange) {
        this.onSettingChange(match[1], payloadStr);
        return;
      }

      if (topic === `${BASE_TOPIC}/circuits/hvac_thermostat/power`) {
        const val = parseFloat(payloadStr);
        this.latestHvacWatts = isNaN(val) ? 0 : Math.max(0, val);
        if (this.onHvacPower) {
          this.onHvacPower(this.latestHvacWatts);
        }
        return;
      }

      if (topic === `${BASE_TOPIC}/circuits/hvac_thermostat/outdoor_power`) {
        const val = parseFloat(payloadStr);
        this.latestOutdoorWatts = isNaN(val) ? 0 : Math.max(0, val);
        if (this.onOutdoorPower) {
          this.onOutdoorPower(this.latestOutdoorWatts);
        }
        return;
      }

      if (topic === `${BASE_TOPIC}/circuits/dryer/power`) {
        const val = parseFloat(payloadStr);
        this.latestDryerWatts = isNaN(val) ? 0 : Math.max(0, val);
        if (this.onDryerPower) {
          this.onDryerPower(this.latestDryerWatts);
        }
        return;
      }

      if (topic === `${BASE_TOPIC}/circuits/oven/power`) {
        const val = parseFloat(payloadStr);
        this.latestOvenWatts = isNaN(val) ? 0 : Math.max(0, val);
        if (this.onOvenPower) {
          this.onOvenPower(this.latestOvenWatts);
        }
        return;
      }

      if (topic === `${BASE_TOPIC}/circuits/washer/power`) {
        const val = parseFloat(payloadStr);
        this.latestWasherWatts = isNaN(val) ? 0 : Math.max(0, val);
        if (this.onWasherPower) {
          this.onWasherPower(this.latestWasherWatts);
        }
        return;
      }
    });

    this.client.on("error", (err) => {
      this.statusMessage = `Error: ${err.message}`;
      console.warn(`[MQTT] Error: ${err.message}`);
    });

    this.client.on("close", () => {
      this.connected = false;
      this.statusMessage = "Closed";
    });

    this.client.on("reconnect", () => {
      this.statusMessage = "Reconnecting...";
    });
  }

  publishBinarySensorDiscovery(sensorId, name, deviceClass, stateTopic) {
    const topic = `${DISCOVERY_PREFIX}/binary_sensor/energy_monitor/${sensorId}/config`;
    const payload = {
      name,
      unique_id: `em_${sensorId}`,
      state_topic: stateTopic,
      payload_on: "online",
      payload_off: "offline",
      device: DEVICE,
    };
    if (deviceClass) payload.device_class = deviceClass;
    this.client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  publishSensorDiscovery(sensorId, name, unit, deviceClass, stateClass, stateTopic, icon = null, jsonAttrTopic = null) {
    const topic = `${DISCOVERY_PREFIX}/sensor/energy_monitor/${sensorId}/config`;
    const payload = {
      name,
      unique_id: `em_${sensorId}`,
      state_topic: stateTopic,
      device: DEVICE,
      availability_topic: `${BASE_TOPIC}/status`,
      payload_available: "online",
      payload_not_available: "offline",
    };
    if (unit) payload.unit_of_measurement = unit;
    if (deviceClass) payload.device_class = deviceClass;
    if (stateClass) payload.state_class = stateClass;
    if (icon) payload.icon = icon;
    if (jsonAttrTopic) payload.json_attributes_topic = jsonAttrTopic;

    this.client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  publishNumberDiscovery(sensorId, name, min, max, step, unit, stateTopic, commandTopic, icon = null, mode = "slider") {
    const topic = `${DISCOVERY_PREFIX}/number/energy_monitor/${sensorId}/config`;
    const payload = {
      name,
      unique_id: `em_${sensorId}`,
      state_topic: stateTopic,
      command_topic: commandTopic,
      min,
      max,
      step,
      unit_of_measurement: unit,
      device: DEVICE,
      availability_topic: `${BASE_TOPIC}/status`,
      payload_available: "online",
      payload_not_available: "offline",
      mode,
    };
    if (icon) payload.icon = icon;
    this.client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  publishSetting(settingKey, value) {
    if (!this.connected || !this.client) return;
    this.client.publish(`${BASE_TOPIC}/settings/${settingKey}`, String(value), { retain: true });
  }

  publishBaseDiscovery() {
    if (!this.connected) return;

    // Live Runtime Polling Interval Sliders
    this.publishNumberDiscovery(
      "modbus_interval_ms",
      "SolarEdge Modbus Poll Interval",
      1,
      1000,
      1,
      "ms",
      `${BASE_TOPIC}/settings/modbus_poll_interval_ms`,
      `${BASE_TOPIC}/settings/modbus_poll_interval_ms/set`,
      "mdi:timer-refresh-outline"
    );
    this.publishNumberDiscovery(
      "emporia_poll_interval",
      "Emporia Vue Poll Interval",
      1000,
      30000,
      500,
      "ms",
      `${BASE_TOPIC}/settings/emporia_poll_interval_ms`,
      `${BASE_TOPIC}/settings/emporia_poll_interval_ms/set`,
      "mdi:cloud-sync-outline"
    );

    // Daemon Service Health & Error Diagnostics
    this.publishBinarySensorDiscovery("daemon_running", "Solar Daemon Service", "running", `${BASE_TOPIC}/status`);
    this.publishSensorDiscovery("daemon_uptime_hrs", "Daemon Uptime", "h", "duration", "measurement", `${BASE_TOPIC}/daemon/uptime_hrs`, "mdi:clock-check-outline");
    this.publishSensorDiscovery("daemon_memory_mb", "Daemon Memory Usage", "MB", "data_size", "measurement", `${BASE_TOPIC}/daemon/memory_mb`, "mdi:memory");
    this.publishSensorDiscovery("daemon_error_count", "Daemon Error Count", null, null, "measurement", `${BASE_TOPIC}/daemon/error_count`, "mdi:shield-alert-outline");
    this.publishSensorDiscovery("daemon_last_error", "Daemon Last Error", null, null, null, `${BASE_TOPIC}/daemon/last_error`, "mdi:alert-circle-outline");
    this.publishSensorDiscovery("daemon_error_log", "Daemon Error Log", null, null, null, `${BASE_TOPIC}/daemon/error_log`, "mdi:clipboard-text-clock-outline", `${BASE_TOPIC}/daemon/error_log/attributes`);

    // Real-time Power (Watts)
    this.publishSensorDiscovery("solar_power", "Solar Production", "W", "power", "measurement", `${BASE_TOPIC}/solar/power`);
    this.publishSensorDiscovery("house_power", "House Consumption", "W", "power", "measurement", `${BASE_TOPIC}/house/power`, null, `${BASE_TOPIC}/house/power/attributes`);
    this.publishSensorDiscovery("subpanel_power", "Subpanel Consumption", "W", "power", "measurement", `${BASE_TOPIC}/subpanel/power`, "mdi:fuse-box");
    this.publishSensorDiscovery("hvac_power", "HVAC Estimated Power", "W", "power", "measurement", `${BASE_TOPIC}/hvac/power`, "mdi:hvac");
    this.publishSensorDiscovery("grid_net_power", "Grid Net Power", "W", "power", "measurement", `${BASE_TOPIC}/grid/power`);
    this.publishSensorDiscovery("grid_import_power", "Grid Import Power", "W", "power", "measurement", `${BASE_TOPIC}/grid/import_power`, "mdi:transmission-tower-import");
    this.publishSensorDiscovery("grid_export_power", "Grid Export Power", "W", "power", "measurement", `${BASE_TOPIC}/grid/export_power`, "mdi:transmission-tower-export");
    this.publishSensorDiscovery("self_powered_pct", "Self-Powered Ratio", "%", null, "measurement", `${BASE_TOPIC}/self_powered_pct`);

    // Inverter Diagnostic Sensors
    this.publishSensorDiscovery("inverter_temp_f", "Inverter Temperature", "°F", "temperature", "measurement", `${BASE_TOPIC}/inverter/temp_f`);
    this.publishSensorDiscovery("solar_dc_power", "Solar DC Power", "W", "power", "measurement", `${BASE_TOPIC}/solar/dc_power`);

    // Cumulative Energy (kWh) - Compatible with HA Native Energy Dashboard
    this.publishSensorDiscovery("solar_energy_today", "Solar Produced Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/solar/today_kwh`);
    this.publishSensorDiscovery("house_energy_today", "House Consumed Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/house/today_kwh`);
    this.publishSensorDiscovery("grid_imported_today", "Grid Imported Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/grid/import_today_kwh`);
    this.publishSensorDiscovery("grid_exported_today", "Grid Exported Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/grid/export_today_kwh`);
    this.publishSensorDiscovery("solar_lifetime_kwh", "Solar Lifetime Production", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/solar/lifetime_kwh`);

    // HVAC Energy & Runtime Analytics
    this.publishSensorDiscovery("hvac_energy_today", "HVAC Consumed Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/hvac/today_kwh`, "mdi:hvac", `${BASE_TOPIC}/hvac/today_kwh/attributes`);
    this.publishSensorDiscovery("hvac_runtime_today", "HVAC Runtime Today", "h", "duration", "measurement", `${BASE_TOPIC}/hvac/today_runtime_hrs`, "mdi:clock-outline");
    this.publishSensorDiscovery("hvac_cost_today", "HVAC Energy Cost Today", "USD", "monetary", "total", `${BASE_TOPIC}/hvac/today_cost`, "mdi:currency-usd");
    this.publishSensorDiscovery("hvac_duty_cycle", "HVAC Duty Cycle", "%", null, "measurement", `${BASE_TOPIC}/hvac/duty_cycle`, "mdi:chart-donut");

    // Outdoor Main Panel: Heavy 240V Loads
    this.publishSensorDiscovery("circuit_dryer", "Circuit: Electric Dryer (LG DLEX3370W)", "W", "power", "measurement", `${BASE_TOPIC}/circuits/dryer/power`, "mdi:tumble-dryer");
    this.publishSensorDiscovery("circuit_oven", "Circuit: Wall Oven (GE JT3000SF3SS)", "W", "power", "measurement", `${BASE_TOPIC}/circuits/oven/power`, "mdi:stove");

    // Heavy Appliance Energy & Runtime Analytics
    this.publishSensorDiscovery("dryer_energy_today", "Dryer Consumed Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/dryer/today_kwh`, "mdi:tumble-dryer");
    this.publishSensorDiscovery("dryer_cost_today", "Dryer Energy Cost Today", "USD", "monetary", "total", `${BASE_TOPIC}/dryer/today_cost`, "mdi:currency-usd");
    this.publishSensorDiscovery("dryer_runtime_today", "Dryer Runtime Today", "h", "duration", "measurement", `${BASE_TOPIC}/dryer/today_runtime_hrs`, "mdi:timer-outline");

    this.publishSensorDiscovery("oven_energy_today", "Oven Consumed Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/oven/today_kwh`, "mdi:stove");
    this.publishSensorDiscovery("oven_cost_today", "Oven Energy Cost Today", "USD", "monetary", "total", `${BASE_TOPIC}/oven/today_cost`, "mdi:currency-usd");
    this.publishSensorDiscovery("oven_runtime_today", "Oven Runtime Today", "h", "duration", "measurement", `${BASE_TOPIC}/oven/today_runtime_hrs`, "mdi:timer-outline");

    this.publishSensorDiscovery("washer_energy_today", "Washer Consumed Today", "kWh", "energy", "total_increasing", `${BASE_TOPIC}/washer/today_kwh`, "mdi:washing-machine");
    this.publishSensorDiscovery("washer_cost_today", "Washer Energy Cost Today", "USD", "monetary", "total", `${BASE_TOPIC}/washer/today_cost`, "mdi:currency-usd");
    this.publishSensorDiscovery("washer_runtime_today", "Washer Runtime Today", "h", "duration", "measurement", `${BASE_TOPIC}/washer/today_runtime_hrs`, "mdi:timer-outline");

    // Financial Metrics (USD)
    this.publishSensorDiscovery("grid_import_cost_today", "Grid Import Cost Today", "USD", "monetary", "total", `${BASE_TOPIC}/cost/import_today`);
    this.publishSensorDiscovery("grid_export_credit_today", "Grid Export Credit Today", "USD", "monetary", "total", `${BASE_TOPIC}/cost/export_today`);
    this.publishSensorDiscovery("net_cost_today", "Net Energy Cost Today", "USD", "monetary", null, `${BASE_TOPIC}/cost/net_today`);

    // Physical Breaker Panel: Square D QOC32UF Unmonitored Circuits (Default 0 W)
    const UNMONITORED_PANEL = [
      { slug: "garage_plugs_door_lights", name: "Garage Plugs, Door & Lights", icon: "mdi:garage" },
      { slug: "bathroom_gfci_outlets", name: "Bathroom GFCI Outlets", icon: "mdi:power-socket-us" },
      { slug: "exterior_patio_outlets", name: "Exterior & Patio Outlets", icon: "mdi:patio-heater" },
      { slug: "gas_furnace_igniter", name: "Gas Furnace & Igniter", icon: "mdi:fire" },
      { slug: "family_room_outlets_patio_light", name: "Family Room Outlets & Patio Light", icon: "mdi:sofa" },
      { slug: "dishwasher", name: "Dishwasher", icon: "mdi:dishwasher" },
      { slug: "garbage_disposal", name: "Garbage Disposal", icon: "mdi:delete-empty" },
      { slug: "kitchen_island_nook_outlets", name: "Kitchen Island & Nook Outlets", icon: "mdi:island" },
      { slug: "washer", name: "Washing Machine", icon: "mdi:washing-machine" },
      { slug: "dining_family_kitchen_lights", name: "Dining, Family & Kitchen Lights", icon: "mdi:ceiling-light-multiple" },
      { slug: "kitchen_vent_hood", name: "Kitchen Vent Hood", icon: "mdi:hvac" },
      { slug: "hallway_lights_bedroom_3", name: "Hallway Lights & Bedroom #3", icon: "mdi:lightbulb-group" },
      { slug: "dining_outlets_counter_gfci", name: "Dining Outlets & Counter GFCI", icon: "mdi:countertop" },
      { slug: "foyer_lights_outlets", name: "Foyer Lights & Outlets", icon: "mdi:door" },
    ];

    for (const c of UNMONITORED_PANEL) {
      this.publishSensorDiscovery(
        `circuit_${c.slug}`,
        `Circuit: ${c.name}`,
        "W",
        "power",
        "measurement",
        `${BASE_TOPIC}/circuits/${c.slug}/power`,
        c.icon
      );
      if (c.slug === "gas_furnace_igniter") {
        this.client.publish(`${BASE_TOPIC}/circuits/${c.slug}/power`, String(Math.round(this.latestBlowerWatts || 0)), { retain: true });
      } else if (c.slug === "washer") {
        this.client.publish(`${BASE_TOPIC}/circuits/${c.slug}/power`, String(Math.round(this.latestWasherWatts || 0)), { retain: true });
      } else {
        this.client.publish(`${BASE_TOPIC}/circuits/${c.slug}/power`, "0", { retain: true });
      }
    }
  }

  slugify(text) {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  ensureCircuitDiscovery(circuitName) {
    const slug = this.slugify(circuitName);
    if (!slug || this.discoveredCircuits.has(slug)) return slug;

    this.discoveredCircuits.add(slug);
    this.publishSensorDiscovery(
      `circuit_${slug}`,
      `Circuit: ${circuitName}`,
      "W",
      "power",
      "measurement",
      `${BASE_TOPIC}/circuits/${slug}/power`
    );
    return slug;
  }

  publishData(data) {
    if (!this.connected) return;

    const p = (topic, val) => {
      if (val !== null && val !== undefined && !Number.isNaN(val)) {
        this.client.publish(topic, String(val), { retain: true });
      }
    };

    // Power
    p(`${BASE_TOPIC}/solar/power`, Math.round(data.solarProdW || 0));
    p(`${BASE_TOPIC}/house/power`, Math.round(data.houseConsumptionW || 0));
    p(`${BASE_TOPIC}/grid/power`, Math.round(data.gridNetW || 0));
    p(`${BASE_TOPIC}/grid/import_power`, Math.max(0, Math.round(data.gridNetW || 0)));
    p(`${BASE_TOPIC}/grid/export_power`, Math.max(0, -Math.round(data.gridNetW || 0)));
    p(`${BASE_TOPIC}/self_powered_pct`, Number(data.selfPoweredPct || 0).toFixed(1));
    if (data.subpanelWatts !== undefined) p(`${BASE_TOPIC}/subpanel/power`, Math.round(data.subpanelWatts));
    if (data.hvacEstimatedWatts !== undefined) p(`${BASE_TOPIC}/hvac/power`, Math.round(data.hvacEstimatedWatts));
    this.client.publish(`${BASE_TOPIC}/house/power/attributes`, JSON.stringify({
      subpanel_watts: Math.round(data.subpanelWatts || 0),
      hvac_estimated_watts: Math.round(data.hvacEstimatedWatts || 0),
      outdoor_watts: Math.round(data.outdoorWatts || 0),
      blower_watts: Math.round(data.blowerWatts || 0),
      dryer_watts: Math.round(data.dryerWatts || 0),
      oven_watts: Math.round(data.ovenWatts || 0),
      washer_watts: Math.round(data.washerWatts || 0),
      hvac_included_in_consumption: true,
    }), { retain: true });

    // DC & Temperature
    if (data.dcWatts !== undefined) p(`${BASE_TOPIC}/solar/dc_power`, Math.round(data.dcWatts));
    if (data.heatSinkF !== undefined) p(`${BASE_TOPIC}/inverter/temp_f`, Number(data.heatSinkF).toFixed(1));

    // Energy (kWh)
    p(`${BASE_TOPIC}/solar/today_kwh`, Number(data.solarTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/house/today_kwh`, Number(data.houseTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/grid/import_today_kwh`, Number(data.gridImportTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/grid/export_today_kwh`, Number(data.gridExportTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/solar/lifetime_kwh`, Number(data.lifetimeKwh || 0).toFixed(1));

    // HVAC Energy & Runtime Metrics
    p(`${BASE_TOPIC}/hvac/today_kwh`, Number(data.hvacTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/hvac/today_runtime_hrs`, Number(((data.hvacTodayRuntimeMin || 0) / 60).toFixed(2)));
    p(`${BASE_TOPIC}/hvac/today_cost`, Number(data.hvacTodayCost || 0).toFixed(2));
    p(`${BASE_TOPIC}/hvac/duty_cycle`, Number(data.hvacDutyCyclePct || 0).toFixed(1));
    this.client.publish(`${BASE_TOPIC}/hvac/today_kwh/attributes`, JSON.stringify({
      runtime_minutes: Math.round(data.hvacTodayRuntimeMin || 0),
      runtime_hours: Number(((data.hvacTodayRuntimeMin || 0) / 60).toFixed(2)),
      cost_usd: Number((data.hvacTodayCost || 0).toFixed(2)),
      duty_cycle_pct: Number((data.hvacDutyCyclePct || 0).toFixed(1)),
      compressor_model: "Carrier CA16NA042-A (3.5 Ton / 42k BTU)",
      furnace_model: "Carrier 58PHA090-16 (88k BTU / 3/4 HP ECM Blower)",
      blower_cooling_watts: 335,
    }), { retain: true });

    // Electric Dryer (LG DLEX3370W)
    if (data.dryerWatts !== undefined) p(`${BASE_TOPIC}/circuits/dryer/power`, Math.round(data.dryerWatts));
    p(`${BASE_TOPIC}/dryer/today_kwh`, Number(data.dryerTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/dryer/today_cost`, Number(data.dryerTodayCost || 0).toFixed(2));
    p(`${BASE_TOPIC}/dryer/today_runtime_hrs`, Number(((data.dryerTodayRuntimeMin || 0) / 60).toFixed(2)));

    // Wall Oven (GE JT3000SF3SS)
    if (data.ovenWatts !== undefined) p(`${BASE_TOPIC}/circuits/oven/power`, Math.round(data.ovenWatts));
    p(`${BASE_TOPIC}/oven/today_kwh`, Number(data.ovenTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/oven/today_cost`, Number(data.ovenTodayCost || 0).toFixed(2));
    p(`${BASE_TOPIC}/oven/today_runtime_hrs`, Number(((data.ovenTodayRuntimeMin || 0) / 60).toFixed(2)));

    // Washing Machine (LG WM3370HWA)
    if (data.washerWatts !== undefined) p(`${BASE_TOPIC}/circuits/washer/power`, Math.round(data.washerWatts));
    p(`${BASE_TOPIC}/washer/today_kwh`, Number(data.washerTodayKwh || 0).toFixed(3));
    p(`${BASE_TOPIC}/washer/today_cost`, Number(data.washerTodayCost || 0).toFixed(2));
    p(`${BASE_TOPIC}/washer/today_runtime_hrs`, Number(((data.washerTodayRuntimeMin || 0) / 60).toFixed(2)));

    // Financial
    p(`${BASE_TOPIC}/cost/import_today`, Number(data.importCostToday || 0).toFixed(2));
    p(`${BASE_TOPIC}/cost/export_today`, Number(data.exportCreditToday || 0).toFixed(2));
    p(`${BASE_TOPIC}/cost/net_today`, Number(data.netCostToday || 0).toFixed(2));

    // Daemon Telemetry & Error Diagnostics
    if (data.uptimeHours !== undefined) p(`${BASE_TOPIC}/daemon/uptime_hrs`, Number(data.uptimeHours).toFixed(2));
    if (data.memoryMb !== undefined) p(`${BASE_TOPIC}/daemon/memory_mb`, Number(data.memoryMb).toFixed(1));
    if (data.errorCount !== undefined) p(`${BASE_TOPIC}/daemon/error_count`, data.errorCount);
    if (data.lastError !== undefined) p(`${BASE_TOPIC}/daemon/last_error`, String(data.lastError || "None").slice(0, 255));
    if (data.errorLog !== undefined) {
      const stateStr = (data.errorCount === 0 || !data.errorCount) ? "Healthy" : `${data.errorCount} Errors`;
      p(`${BASE_TOPIC}/daemon/error_log`, stateStr);
      this.client.publish(`${BASE_TOPIC}/daemon/error_log/attributes`, JSON.stringify({
        errors: data.errorLog || [],
        total_errors: data.errorCount || 0,
        last_error: data.lastError || "None",
        last_check: new Date().toLocaleTimeString(),
      }), { retain: true });
    }

    // Circuits
    if (Array.isArray(data.circuits)) {
      for (const c of data.circuits) {
        const slug = this.ensureCircuitDiscovery(c.name);
        if (slug) {
          p(`${BASE_TOPIC}/circuits/${slug}/power`, Math.round(c.watts || 0));
        }
      }
    }

    // Update unmonitored circuits from live estimation states
    p(`${BASE_TOPIC}/circuits/gas_furnace_igniter/power`, Math.round(this.latestBlowerWatts || 0));
    p(`${BASE_TOPIC}/circuits/washer/power`, Math.round(this.latestWasherWatts || 0));
  }

  close() {
    if (this.client) {
      try {
        this.client.publish(`${BASE_TOPIC}/status`, "offline", { retain: true, qos: 1 }, () => {
          try { this.client.end(); } catch {}
        });
      } catch {
        try { this.client.end(); } catch {}
      }
    }
  }
}

module.exports = HaMqttPublisher;
