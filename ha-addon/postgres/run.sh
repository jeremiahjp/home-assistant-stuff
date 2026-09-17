#!/usr/bin/env bash
set -e

CONFIG_PATH=/data/options.json
PGDATA=/data/postgresql

# Read options
if [ -f "$CONFIG_PATH" ]; then
    PASSWORD=$(jq -r '.postgres_password // "ha_postgres_secure_pass_2026"' "$CONFIG_PATH")
    DATABASES=$(jq -r '.databases[]?' "$CONFIG_PATH")
else
    PASSWORD="ha_postgres_secure_pass_2026"
    DATABASES="homeassistant emporia_energy"
fi

mkdir -p "$PGDATA"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"

# Initialize database if needed
if [ ! -s "$PGDATA/PG_VERSION" ]; then
    echo "[PostgreSQL] Initializing new database cluster in $PGDATA..."
    su-exec postgres initdb -D "$PGDATA" --auth-local=trust --auth-host=scram-sha-256

    echo "[PostgreSQL] Configuring listen_addresses and pg_hba.conf..."
    echo "listen_addresses = '*'" >> "$PGDATA/postgresql.conf"
    echo "max_connections = 100" >> "$PGDATA/postgresql.conf"
    echo "shared_buffers = 128MB" >> "$PGDATA/postgresql.conf"
    
    # Allow local docker and LAN subnet connections
    echo "host all all 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
    echo "host all all ::/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"
fi

# Start PostgreSQL temporarily in the background to apply passwords & provision databases
echo "[PostgreSQL] Starting background service to ensure users and databases exist..."
su-exec postgres pg_ctl -D "$PGDATA" -o "-c listen_addresses='*'" -w start

# Set postgres superuser password
su-exec postgres psql -v ON_ERROR_STOP=1 -U postgres <<-EOSQL
    ALTER USER postgres WITH PASSWORD '$PASSWORD';
EOSQL

# Ensure configured databases exist
for db in $DATABASES; do
    echo "[PostgreSQL] Checking database: $db"
    su-exec postgres psql -U postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 ||     su-exec postgres psql -v ON_ERROR_STOP=1 -U postgres -c "CREATE DATABASE $db OWNER postgres;"
done

# Initialize emporia_energy table if database exists
echo "[PostgreSQL] Ensuring circuit_energy_logs table exists in emporia_energy..."
su-exec postgres psql -U postgres -d emporia_energy <<-EOSQL
    CREATE TABLE IF NOT EXISTS circuit_energy_logs (
        id BIGSERIAL PRIMARY KEY,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        circuit_id VARCHAR(64) NOT NULL,
        circuit_name VARCHAR(128) NOT NULL,
        watts NUMERIC(10, 2) NOT NULL,
        kwh_cumulative NUMERIC(14, 4) DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_circuit_time ON circuit_energy_logs (circuit_name, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_time ON circuit_energy_logs (recorded_at DESC);

    -- Provision restricted emporia_writer role
    DO $$
    BEGIN
       IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'emporia_writer') THEN
          CREATE ROLE emporia_writer WITH LOGIN ENCRYPTED PASSWORD 'emporia_write_secure_pass_2026';
       END IF;
    END
    $$;

    REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
    REVOKE CONNECT ON DATABASE homeassistant FROM PUBLIC;
    GRANT CONNECT ON DATABASE homeassistant TO postgres;
    GRANT CONNECT ON DATABASE postgres TO postgres;
    GRANT CONNECT ON DATABASE emporia_energy TO emporia_writer;

    GRANT USAGE ON SCHEMA public TO emporia_writer;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM emporia_writer;
    GRANT SELECT, INSERT ON TABLE circuit_energy_logs TO emporia_writer;
    GRANT SELECT, INSERT ON TABLE whole_home_energy_logs TO emporia_writer;
    GRANT SELECT, INSERT, UPDATE ON TABLE daily_energy_summary TO emporia_writer;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO emporia_writer;

    CREATE OR REPLACE FUNCTION purge_expired_energy_logs(keep_days integer DEFAULT 60)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $func$
    DECLARE
        deleted_circuit_rows integer := 0;
        deleted_home_rows integer := 0;
        curr_deleted integer;
    BEGIN
        IF keep_days < 30 THEN
            RAISE EXCEPTION 'Safety Violation: keep_days cannot be less than 30 days (requested: %)', keep_days;
        END IF;

        DELETE FROM circuit_energy_logs WHERE recorded_at < NOW() - (keep_days || ' days')::interval;
        GET DIAGNOSTICS curr_deleted = ROW_COUNT;
        deleted_circuit_rows := curr_deleted;

        DELETE FROM whole_home_energy_logs WHERE recorded_at < NOW() - (keep_days || ' days')::interval;
        GET DIAGNOSTICS curr_deleted = ROW_COUNT;
        deleted_home_rows := curr_deleted;

        RETURN deleted_circuit_rows + deleted_home_rows;
    END;
    $func$;
    GRANT EXECUTE ON FUNCTION purge_expired_energy_logs(integer) TO emporia_writer;
EOSQL

# Stop background instance
echo "[PostgreSQL] Stopping background instance..."
su-exec postgres pg_ctl -D "$PGDATA" -m fast -w stop

# Start PostgreSQL in the foreground
echo "[PostgreSQL] PostgreSQL 16 ready and listening on port 5432."
exec su-exec postgres postgres -D "$PGDATA"
