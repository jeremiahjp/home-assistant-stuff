require("./env");
const fs = require("fs");
const path = require("path");

const SOURCE_DIR = path.join(__dirname, "ha-addon", "solar_energy_monitor");
const TARGET_DIR = process.env.HA_SAMBA_PATH || "\\\\192.168.68.88\\addons\\ha-addon\\solar_energy_monitor";

console.log("==================================================");
console.log("  🚀 Home Assistant Add-on Deployer");
console.log(`  Source: ${SOURCE_DIR}`);
console.log(`  Target: ${TARGET_DIR}`);
console.log("==================================================");

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (path.basename(src) === "node_modules") return;
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
    console.log(`  Pushed: ${path.relative(SOURCE_DIR, src)}`);
  }
}

try {
  copyRecursive(SOURCE_DIR, TARGET_DIR);
  console.log("\n✅ [Deploy] Successfully deployed all add-on files to Home Assistant!");

  // --- Push Lovelace Dashboard directly to Home Assistant Storage ---
  const YAML = require("./node_modules/yaml");
  const dashboardYamlPath = path.join(__dirname, "dashboards", "solar-hub.yaml");
  const haStorageFile = "Z:\\.storage\\lovelace.solar_hub";
  const haDashboardsDir = "Z:\\dashboards";

  if (fs.existsSync(dashboardYamlPath) && fs.existsSync("Z:\\.storage")) {
    console.log("\n==================================================");
    console.log("  📊 Syncing Solar Command Hub Dashboard to HA");
    console.log("==================================================");

    const yamlContent = fs.readFileSync(dashboardYamlPath, "utf8");
    const parsedConfig = YAML.parse(yamlContent);

    const haSolarEnergyFile = "Z:\\.storage\\lovelace.solar_energy";

    // Backup current storage files
    if (fs.existsSync(haStorageFile)) {
      fs.copyFileSync(haStorageFile, haStorageFile + ".bak_auto");
    }
    if (fs.existsSync(haSolarEnergyFile)) {
      fs.copyFileSync(haSolarEnergyFile, haSolarEnergyFile + ".bak_auto");
    }

    const storagePayload = {
      version: 1,
      minor_version: 1,
      key: "lovelace.solar_hub",
      data: {
        config: parsedConfig
      }
    };

    const solarEnergyPayload = {
      version: 1,
      minor_version: 1,
      key: "lovelace.solar_energy",
      data: {
        config: parsedConfig
      }
    };

    fs.writeFileSync(haStorageFile, JSON.stringify(storagePayload, null, 2), "utf8");
    fs.writeFileSync(haSolarEnergyFile, JSON.stringify(solarEnergyPayload, null, 2), "utf8");
    console.log(`  Pushed: dashboards/solar-hub.yaml -> ${haStorageFile}`);
    console.log(`  Pushed: dashboards/solar-hub.yaml -> ${haSolarEnergyFile}`);

    if (!fs.existsSync(haDashboardsDir)) fs.mkdirSync(haDashboardsDir, { recursive: true });
    fs.copyFileSync(dashboardYamlPath, path.join(haDashboardsDir, "solar-hub.yaml"));
    console.log("✅ [Deploy] Dashboard successfully synchronized to Home Assistant storage!");
  }

  // --- Push www assets directly to Home Assistant ---
  const wwwDir = path.join(__dirname, "www");
  const haWwwDir = "Z:\\www";
  if (fs.existsSync(wwwDir) && fs.existsSync("Z:\\")) {
    console.log("\n==================================================");
    console.log("  🌐 Syncing WWW Static Assets to HA");
    console.log("==================================================");
    if (!fs.existsSync(haWwwDir)) fs.mkdirSync(haWwwDir, { recursive: true });
    const wwwFiles = fs.readdirSync(wwwDir);
    for (const file of wwwFiles) {
      fs.copyFileSync(path.join(wwwDir, file), path.join(haWwwDir, file));
      console.log(`  Pushed: www/${file} -> ${path.join(haWwwDir, file)}`);
    }
    console.log("✅ [Deploy] WWW assets successfully synchronized!");
  }
} catch (err) {
  console.error("❌ Deploy failed:", err.message);
  process.exit(1);
}
