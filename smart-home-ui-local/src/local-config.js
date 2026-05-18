'use strict';

/**
 * Local Docker/Windows dev config loader.
 *
 * This file is intentionally small and has no external dependencies. It lets the
 * same ALLHA-2D server run outside Home Assistant as a local Docker container.
 * Secrets are read from config/local-config.json mounted from the host and are
 * copied only into process.env for the current Node.js process.
 */
const fs = require('fs');
const path = require('path');

let applied = false;

function normalizeApiBase(haUrl) {
  const raw = String(haUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return raw.endsWith('/api') ? raw : `${raw}/api`;
}

function wsFromApiBase(apiBase) {
  if (!apiBase) return '';
  return apiBase.replace(/^http/i, 'ws').replace(/\/api$/, '/api/websocket');
}

function mask(value) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 10) return '***';
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function readJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[ALLHA-2D local-dev] Cannot read config ${filePath}: ${err.message}`);
    return null;
  }
}

function applyLocalConfig() {
  if (applied) return;
  applied = true;

  const mode = process.env.ALLHA_MODE || process.env.ALLHA_RUNTIME_MODE || '';
  const configPath = process.env.ALLHA_CONFIG || process.env.LOCAL_CONFIG_PATH || path.join(process.cwd(), 'config', 'local-config.json');
  const shouldLoad = mode === 'local-dev' || process.env.ALLHA_CONFIG || process.env.LOCAL_CONFIG_PATH;
  if (!shouldLoad) return;

  const cfg = readJson(configPath);
  if (!cfg) {
    console.warn(`[ALLHA-2D local-dev] Config not found: ${configPath}`);
    console.warn('[ALLHA-2D local-dev] Copy config/local-config.example.json to config/local-config.json and fill haUrl/haToken.');
    return;
  }

  const apiBase = normalizeApiBase(cfg.haApiBase || cfg.haUrl || cfg.homeAssistantUrl);
  const wsUrl = String(cfg.haWsUrl || '').trim() || wsFromApiBase(apiBase);
  const token = String(cfg.haToken || cfg.token || '').trim();

  if (apiBase && !process.env.HA_API_BASE) process.env.HA_API_BASE = apiBase;
  if (wsUrl && !process.env.HA_WS_URL) process.env.HA_WS_URL = wsUrl;
  if (token) {
    // In local Docker mode Home Assistant provides no real SUPERVISOR_TOKEN.
    // Keep both variables populated so older add-on code paths that still check
    // SUPERVISOR_TOKEN continue to work while using the user's local HA token.
    if (!process.env.HA_TOKEN) process.env.HA_TOKEN = token;
    if (!process.env.SUPERVISOR_TOKEN) process.env.SUPERVISOR_TOKEN = token;
  }

  if (cfg.port && !process.env.PORT) process.env.PORT = String(cfg.port);
  if (cfg.mobilePort && !process.env.MOBILE_PORT) process.env.MOBILE_PORT = String(cfg.mobilePort);
  if (cfg.directDashboardPort && !process.env.DIRECT_DASHBOARD_PORT) process.env.DIRECT_DASHBOARD_PORT = String(cfg.directDashboardPort);
  if (cfg.dataDir && !process.env.DATA_DIR) process.env.DATA_DIR = String(cfg.dataDir);
  if (cfg.logLevel && !process.env.ALLHA_LOG_LEVEL) process.env.ALLHA_LOG_LEVEL = String(cfg.logLevel);

  console.log(`[ALLHA-2D local-dev] Config loaded: ${configPath}`);
  console.log(`[ALLHA-2D local-dev] HA_API_BASE=${process.env.HA_API_BASE || ''}`);
  console.log(`[ALLHA-2D local-dev] HA_WS_URL=${process.env.HA_WS_URL || ''}`);
  console.log(`[ALLHA-2D local-dev] HA_TOKEN=${mask(process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN || '')}`);
}

module.exports = { applyLocalConfig };
