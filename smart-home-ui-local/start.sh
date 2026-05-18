#!/bin/sh
set -e

cd /app

echo "[Smart Home UI] Starting add-on..."

if ! node -e "require('express'); require('ws'); require('better-sqlite3')" >/dev/null 2>&1; then
  echo "[Smart Home UI] Node dependencies are missing. Running npm install --omit=dev..."
  npm install --omit=dev
fi

echo "[Smart Home UI] Dependencies OK"
exec node server.js
