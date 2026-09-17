# PostgreSQL 16 Database (Alpine)

High-performance, enterprise-grade relational database server running **PostgreSQL 16 (Alpine Linux)**.

---

## System & Version Information
* **Database Engine**: PostgreSQL 16 (Alpine)
* **Add-on Version**: `16.2-alpine`
* **Default Port**: `5432`
* **Persistent Storage**: `/data/postgresql` (Preserved across reboots and included in Home Assistant backups)
* **Superuser**: `postgres`

---

## Databases Created Automatically
1. **`homeassistant`**: Dedicated to Home Assistant's native `recorder` component (replaces SQLite for all states, events, and long-term energy stats).
2. **`emporia_energy`**: Dedicated to high-resolution circuit telemetry with pre-indexed table:
   * `circuit_energy_logs` (tracks `circuit_id`, `circuit_name`, `watts`, `kwh_cumulative`)

---

## Home Assistant Connection (`configuration.yaml`)
To route Home Assistant's recorder to this database, add the following to your `/config/configuration.yaml`:

```yaml
recorder:
  db_url: postgresql://postgres:ha_postgres_secure_pass_2026@localhost:5432/homeassistant
  commit_interval: 5
  auto_purge: true
  purge_keep_days: 30
```

---

## Connecting from Your Local Network (LAN)
You can connect external tools (DBeaver, pgAdmin, Python, Grafana, Node.js) from any PC on your local network:
* **Host**: `192.168.68.84`
* **Port**: `5432`
* **Database**: `homeassistant` or `emporia_energy`
* **Username**: `postgres`
* **Password**: `ha_postgres_secure_pass_2026` (or whatever you configured in the Configuration tab)
