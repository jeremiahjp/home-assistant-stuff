#!/usr/bin/env bash
set -e

echo "[SQL Studio] Starting SQL Studio Web Query Tool on port 8080..."
exec php83 -S 0.0.0.0:8080 -t /app
