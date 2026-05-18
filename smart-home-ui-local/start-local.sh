#!/bin/sh
set -e
cd /app

echo "[ALLHA-2D local-dev] Starting local Docker runtime..."
echo "[ALLHA-2D local-dev] Version: 5.0.0"
echo "[ALLHA-2D local-dev] Browser: http://localhost:${PORT:-8099}"
echo "[ALLHA-2D local-dev] Mobile:  http://WINDOWS_PC_IP:${MOBILE_PORT:-32457}"

if [ ! -f "${ALLHA_CONFIG:-/app/config/local-config.json}" ]; then
  echo "[ALLHA-2D local-dev] WARNING: config/local-config.json not found."
  echo "[ALLHA-2D local-dev] Copy config/local-config.example.json to config/local-config.json and fill haUrl/haToken."
fi

if ! node -e "require.resolve('express'); require.resolve('ws'); require.resolve('better-sqlite3')" >/dev/null 2>&1; then
  echo "[ALLHA-2D local-dev] WARNING: Node dependencies are missing inside the container."
  echo "[ALLHA-2D local-dev] Installing runtime dependencies now..."
  npm install --omit=dev --registry=https://registry.npmjs.org
fi

node -e "require.resolve('express'); require.resolve('ws'); require.resolve('better-sqlite3'); console.log('[ALLHA-2D local-dev] Dependencies OK')"
exec node server.js
