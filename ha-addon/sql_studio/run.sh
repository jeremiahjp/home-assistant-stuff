#!/usr/bin/env bash
set -e

CONFIG_PATH=/data/options.json
DB_HOST="192.168.68.84"
DB_PORT="5432"
DB_USER="postgres"
DB_PASS="ha_postgres_secure_pass_2026"
DEFAULT_DB="emporia_energy"

if [ -f "$CONFIG_PATH" ]; then
    DB_HOST=$(jq -r '.db_host // "192.168.68.84"' "$CONFIG_PATH")
    DB_PORT=$(jq -r '.db_port // 5432' "$CONFIG_PATH")
    DB_USER=$(jq -r '.db_user // "postgres"' "$CONFIG_PATH")
    DB_PASS=$(jq -r '.db_password // "ha_postgres_secure_pass_2026"' "$CONFIG_PATH")
    DEFAULT_DB=$(jq -r '.default_db // "emporia_energy"' "$CONFIG_PATH")
fi

URL="postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DEFAULT_DB}?sslmode=disable"

echo "[pgweb] Connecting to ${DB_HOST}:${DB_PORT}/${DEFAULT_DB}..."
echo "[pgweb] Starting pgweb on port 8080 (Ingress) and 8085 (Direct)..."

# Run socat or redirect port 8085 to 8080 in background if desired, or run pgweb on 8080
exec pgweb --bind=0.0.0.0 --listen=8080 --url="$URL"
