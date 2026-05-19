'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.ALLHA_DB_PATH || path.join(DATA_DIR, 'allha2d.db');
const MIGRATION_BACKUP_DIR = path.join(DATA_DIR, 'migration-backups');

let _sqliteAvailable = null;
let _db = null;
function getDb() {
  if (!_db) {
    ensureDirs();
    _db = new Database(DB_PATH);
  }
  return _db;
}
function closeDb() {
  if (!_db) return false;
  try {
    _db.close();
    return true;
  } finally {
    _db = null;
    _initialized = false;
    _sqliteAvailable = null;
  }
}
let _initialized = false;
const _dbPerf = {
  startedAt: new Date().toISOString(),
  runCount: 0,
  allCount: 0,
  totalMs: 0,
  maxMs: 0,
  lastMs: 0,
  lastOp: '',
  slowCount: 0
};
function recordDbPerf(op, started){
  const ms = Date.now() - started;
  _dbPerf.lastMs = ms;
  _dbPerf.lastOp = op;
  _dbPerf.totalMs += ms;
  if(ms > _dbPerf.maxMs) _dbPerf.maxMs = ms;
  if(ms >= Number(process.env.ALLHA_DB_SLOW_MS || 100)) _dbPerf.slowCount++;
}
function getPerformanceStats(){
  const count = _dbPerf.runCount + _dbPerf.allCount;
  return { ..._dbPerf, count, avgMs: count ? Math.round((_dbPerf.totalMs / count) * 10) / 10 : 0 };
}

function sqliteAvailable() {
  if (_sqliteAvailable !== null) return _sqliteAvailable;
  try {
    getDb();
    _sqliteAvailable = true;
  } catch (e) {
    console.warn('[db] better-sqlite3 not available:', e.message);
    _sqliteAvailable = false;
  }
  return _sqliteAvailable;
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MIGRATION_BACKUP_DIR, { recursive: true });
}

function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function json(value, fallback) {
  try { return JSON.stringify(value === undefined ? fallback : value); }
  catch { return JSON.stringify(fallback); }
}

function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

function run(sql) {
  if (!sqliteAvailable()) throw new Error('better-sqlite3 is not available');
  const started = Date.now();
  try {
    getDb().exec(sql);
  } finally {
    _dbPerf.runCount++;
    recordDbPerf('run', started);
  }
}

function runTransaction(sql) {
  if (!sqliteAvailable()) throw new Error('better-sqlite3 is not available');
  const started = Date.now();
  const db = getDb();
  try {
    db.exec('BEGIN;');
    db.exec(sql);
    db.exec('COMMIT;');
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw e;
  } finally {
    _dbPerf.runCount++;
    recordDbPerf('transaction', started);
  }
}

function tryRun(sql) {
  try { run(sql); return true; } catch { return false; }
}

function all(sql) {
  if (!sqliteAvailable()) throw new Error('better-sqlite3 is not available');
  const started = Date.now();
  try {
    return getDb().prepare(sql).all();
  } finally {
    _dbPerf.allCount++;
    recordDbPerf('all', started);
  }
}

function get(sql) {
  return all(sql)[0] || null;
}

function backupLegacyFile(file, label) {
  try {
    if (!fs.existsSync(file)) return null;
    fs.mkdirSync(MIGRATION_BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}-${label || path.basename(file)}`;
    const dst = path.join(MIGRATION_BACKUP_DIR, name);
    fs.copyFileSync(file, dst);
    return dst;
  } catch (e) {
    console.warn('[db] legacy backup failed:', file, e.message);
    return null;
  }
}

function initSchema() {
  if (_initialized) return sqliteAvailable();
  if (!sqliteAvailable()) {
    console.warn('[db] sqlite3 is not available; falling back to legacy JSON storage');
    return false;
  }
  ensureDirs();
  run(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mobile_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  alias TEXT UNIQUE,
  description TEXT,
  platform TEXT,
  model TEXT,
  manufacturer TEXT,
  os_version TEXT,
  app_version TEXT,
  user_agent TEXT,
  screen TEXT,
  paired_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'control',
  profile_access_json TEXT NOT NULL DEFAULT '{"mode":"all","profileIds":[]}',
  enabled INTEGER NOT NULL DEFAULT 1,
  replaced_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mobile_device_settings (
  device_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  server_backup_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES mobile_devices(device_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS web_clients (
  client_id TEXT PRIMARY KEY,
  name TEXT,
  alias TEXT,
  slug TEXT UNIQUE,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'web',
  user_agent TEXT,
  screen TEXT,
  first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enabled INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS web_client_settings (
  client_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  server_backup_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(client_id) REFERENCES web_clients(client_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS web_sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(device_id) REFERENCES mobile_devices(device_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS access_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS command_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  client_id TEXT,
  entity_id TEXT,
  domain TEXT,
  service TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS attention_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT,
  room_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS backup_index (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  backup_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS server_baseline_settings (
  key TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_documents (
  doc_key TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL DEFAULT 'json',
  json_value TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS project_files (
  file_key TEXT PRIMARY KEY,
  file_type TEXT NOT NULL DEFAULT 'text',
  text_value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS standard_sensor_bindings (
  profile_id TEXT NOT NULL,
  level_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  sensor_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(profile_id, level_id, room_id, sensor_type)
);
CREATE INDEX IF NOT EXISTS idx_standard_sensor_bindings_level ON standard_sensor_bindings(profile_id, level_id, room_id);
CREATE INDEX IF NOT EXISTS idx_project_documents_updated ON project_documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_mobile_devices_alias ON mobile_devices(alias);
CREATE INDEX IF NOT EXISTS idx_mobile_devices_last_seen ON mobile_devices(last_seen);
CREATE INDEX IF NOT EXISTS idx_web_clients_slug ON web_clients(slug);
CREATE INDEX IF NOT EXISTS idx_web_clients_last_seen ON web_clients(last_seen);
CREATE INDEX IF NOT EXISTS idx_sessions_device ON web_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_access_events_created ON access_events(created_at);
CREATE INDEX IF NOT EXISTS idx_access_events_type ON access_events(event_type);
CREATE INDEX IF NOT EXISTS idx_command_log_created ON command_log(created_at);
`);
  // v4.1.18: upgrade existing v4.1.16/v4.1.17 DBs without dropping data.
  tryRun("ALTER TABLE web_clients ADD COLUMN alias TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN slug TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN description TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN screen TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN deleted_at TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN created_at TEXT;");
  tryRun("ALTER TABLE web_clients ADD COLUMN updated_at TEXT;");
  tryRun("CREATE UNIQUE INDEX IF NOT EXISTS idx_web_clients_slug_unique ON web_clients(slug) WHERE slug IS NOT NULL AND slug != '';");
  _initialized = true;
  migrateLegacyMobileDevices();
  migrateLegacyClientPrefs();
  return true;
}

function hasDb() {
  return initSchema();
}

function normalizeProfileAccess(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const mode = raw.mode === 'selected' ? 'selected' : 'all';
  const profileIds = Array.isArray(raw.profileIds) ? raw.profileIds.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
  return { mode, profileIds };
}

function normalizeMobileSettings(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const serverMode = ['both', 'local', 'web'].includes(String(raw.serverMode || '')) ? String(raw.serverMode) : 'both';
  const scale = Math.min(1.5, Math.max(0.7, Number(raw.scale || 1)));

  // v4.1.21.18.21:
  // Keep arbitrary per-device client settings sections. The previous normalizer returned
  // a fixed whitelist and silently dropped nested settings.ui, settings.navigation,
  // visibility, tiles, kiosk, mobile, layout, etc. That is why debug showed current
  // state.ui values but server settings.ui was empty after save.
  const keepObj = (key) => (raw[key] && typeof raw[key] === 'object' && !Array.isArray(raw[key])) ? raw[key] : undefined;
  const out = {
    ...raw,
    serverMode,
    keepScreenOn: !!raw.keepScreenOn,
    stayInBackground: !!raw.stayInBackground,
    autoStart: !!raw.autoStart,
    scale,
    showMarkers: raw.showMarkers !== false,
    showSensors: raw.showSensors !== false,
    showStandardSensors: raw.showStandardSensors !== false,
    markerScale: Number.isFinite(Number(raw.markerScale)) ? Number(raw.markerScale) : 1,
    sensorScale: Number.isFinite(Number(raw.sensorScale)) ? Number(raw.sensorScale) : 1,
    navigationMode: ['maps','tiles','switchable'].includes(String(raw.navigationMode || '')) ? String(raw.navigationMode) : 'maps',
    activeProfileId: String(raw.activeProfileId || ''),
    activeLevelId: String(raw.activeLevelId || ''),
    activeRoomId: String(raw.activeRoomId || '')
  };

  for (const key of ['ui','navigation','visibility','tiles','kiosk','mobile','layout','viewport','standardSensorsVisibility']) {
    const obj = keepObj(key);
    if (obj !== undefined) out[key] = obj;
  }
  return out;
}

function rowToDevice(r) {
  if (!r) return null;
  return {
    device_id: r.device_id,
    name: r.name || r.device_id,
    alias: r.alias || '',
    description: r.description || '',
    platform: r.platform || '',
    model: r.model || '',
    manufacturer: r.manufacturer || '',
    osVersion: r.os_version || '',
    appVersion: r.app_version || '',
    screen: r.screen || '',
    userAgent: r.user_agent || '',
    paired_at: r.paired_at,
    last_seen: r.last_seen,
    enabled: Number(r.enabled) !== 0,
    accessMode: r.access_mode || 'control',
    profileAccess: normalizeProfileAccess(parseJson(r.profile_access_json, { mode: 'all', profileIds: [] })),
    settings: normalizeMobileSettings(parseJson(r.settings_json, {})),
    serverBackup: parseJson(r.server_backup_json, {})
  };
}

function upsertMobileDevice(device) {
  if (!hasDb()) return false;
  const now = new Date().toISOString();
  const profileAccess = normalizeProfileAccess(device.profileAccess);
  const settings = normalizeMobileSettings(device.settings);
  runTransaction(`
INSERT INTO mobile_devices (
  device_id, token_hash, name, alias, description, platform, model, manufacturer,
  os_version, app_version, user_agent, screen, paired_at, last_seen, access_mode,
  profile_access_json, enabled, updated_at
) VALUES (
  ${q(device.device_id)}, ${q(device.tokenHash)}, ${q(device.name || device.device_id)}, ${q(device.alias || null)}, ${q(device.description || null)},
  ${q(device.platform || '')}, ${q(device.model || '')}, ${q(device.manufacturer || '')}, ${q(device.osVersion || '')},
  ${q(device.appVersion || '')}, ${q(device.userAgent || '')}, ${q(device.screen || '')}, ${q(device.paired_at || now)},
  ${q(device.last_seen || now)}, ${q(device.accessMode || 'control')}, ${q(json(profileAccess, { mode:'all', profileIds:[] }))},
  ${device.enabled === false ? 0 : 1}, ${q(now)}
)
ON CONFLICT(device_id) DO UPDATE SET
  token_hash=excluded.token_hash,
  name=excluded.name,
  alias=excluded.alias,
  description=excluded.description,
  platform=excluded.platform,
  model=excluded.model,
  manufacturer=excluded.manufacturer,
  os_version=excluded.os_version,
  app_version=excluded.app_version,
  user_agent=excluded.user_agent,
  screen=excluded.screen,
  last_seen=excluded.last_seen,
  access_mode=excluded.access_mode,
  profile_access_json=excluded.profile_access_json,
  enabled=excluded.enabled,
  updated_at=excluded.updated_at;
INSERT INTO mobile_device_settings (device_id, settings_json, server_backup_json, updated_at)
VALUES (${q(device.device_id)}, ${q(json(settings, {}))}, ${q(json(device.serverBackup || settings, {}))}, ${q(now)})
ON CONFLICT(device_id) DO UPDATE SET
  settings_json=excluded.settings_json,
  server_backup_json=COALESCE(NULLIF(mobile_device_settings.server_backup_json, '{}'), excluded.server_backup_json),
  updated_at=excluded.updated_at;
`);
  return true;
}

function listMobileDevices() {
  if (!hasDb()) return null;
  return all(`SELECT d.*, s.settings_json, s.server_backup_json FROM mobile_devices d LEFT JOIN mobile_device_settings s ON s.device_id=d.device_id WHERE d.enabled=1 ORDER BY d.last_seen DESC, d.name ASC;`).map(rowToDevice);
}

function getMobileDevice(device_id) {
  if (!hasDb()) return null;
  return rowToDevice(get(`SELECT d.*, s.settings_json, s.server_backup_json FROM mobile_devices d LEFT JOIN mobile_device_settings s ON s.device_id=d.device_id WHERE d.device_id=${q(device_id)} AND d.enabled=1;`));
}

function getMobileDeviceByAlias(alias) {
  if (!hasDb()) return null;
  const clean = String(alias || '').trim().slice(0, 64);
  if (!clean) return null;
  return rowToDevice(get(`SELECT d.*, s.settings_json, s.server_backup_json FROM mobile_devices d LEFT JOIN mobile_device_settings s ON s.device_id=d.device_id WHERE d.alias=${q(clean)} AND d.enabled=1 ORDER BY d.last_seen DESC LIMIT 1;`));
}

function getMobileDeviceSecret(device_id) {
  if (!hasDb()) return null;
  const r = get(`SELECT token_hash FROM mobile_devices WHERE device_id=${q(device_id)} AND enabled=1;`);
  return r ? r.token_hash : null;
}

function updateMobileLastSeen(device_id) {
  if (!hasDb()) return false;
  run(`UPDATE mobile_devices SET last_seen=${q(new Date().toISOString())}, updated_at=${q(new Date().toISOString())} WHERE device_id=${q(device_id)} AND enabled=1;`);
  return true;
}

function updateMobileDevice(device_id, patch = {}) {
  if (!hasDb()) return null;
  const current = getMobileDevice(device_id);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    device_id,
    tokenHash: getMobileDeviceSecret(device_id) || patch.tokenHash || '',
    accessMode: patch.accessMode !== undefined ? patch.accessMode : current.accessMode,
    profileAccess: patch.profileAccess !== undefined ? normalizeProfileAccess(patch.profileAccess) : current.profileAccess,
    settings: patch.settings !== undefined ? normalizeMobileSettings({ ...(current.settings || {}), ...(patch.settings || {}) }) : current.settings,
    serverBackup: patch.serverBackup !== undefined ? patch.serverBackup : current.serverBackup
  };
  upsertMobileDevice(next);
  return getMobileDevice(device_id);
}

function deleteMobileDevice(device_id) {
  if (!hasDb()) return false;
  const id = String(device_id || '').trim().slice(0, 128);
  if (!id) return false;
  const current = get(`SELECT device_id, alias, name FROM mobile_devices WHERE device_id=${q(id)};`);
  if (!current) return false;
  runTransaction(`DELETE FROM mobile_device_settings WHERE device_id=${q(id)};
DELETE FROM web_sessions WHERE device_id=${q(id)};
DELETE FROM mobile_devices WHERE device_id=${q(id)};`);
  rmDirQuiet(clientSettingsDirFor('mobile_device', id));
  addClientLifecycleAudit('mobile', id, 'delete', { alias: current.alias || current.name || '' });
  return true;
}

function deleteAllMobileDevices() {
  if (!hasDb()) return false;
  const rows = all(`SELECT device_id FROM mobile_devices;`);
  runTransaction(`DELETE FROM mobile_device_settings;
DELETE FROM web_sessions;
DELETE FROM mobile_devices;`);
  for (const r of rows) rmDirQuiet(clientSettingsDirFor('mobile_device', r.device_id));
  addClientLifecycleAudit('mobile', 'bulk', 'delete', { count: rows.length, deviceIds: rows.map(r=>r.device_id) });
  return true;
}

function createWebSession(device_id, ttlMs) {
  if (!hasDb()) return null;
  const session = require('crypto').randomBytes(32).toString('base64url');
  const exp = Date.now() + (ttlMs || 24 * 60 * 60_000);
  run(`INSERT INTO web_sessions(session_id, device_id, expires_at) VALUES (${q(session)}, ${q(device_id)}, ${q(exp)});`);
  return session;
}

function validateWebSession(session) {
  if (!hasDb()) return false;
  const r = get(`SELECT s.session_id, s.device_id, s.expires_at FROM web_sessions s JOIN mobile_devices d ON d.device_id=s.device_id WHERE s.session_id=${q(session)} AND d.enabled=1;`);
  if (!r || Number(r.expires_at) < Date.now()) {
    if (r) run(`DELETE FROM web_sessions WHERE session_id=${q(session)};`);
    return false;
  }
  return true;
}

function getWebSessionDeviceId(session) {
  if (!hasDb()) return '';
  const r = get(`SELECT s.device_id, s.expires_at FROM web_sessions s JOIN mobile_devices d ON d.device_id=s.device_id WHERE s.session_id=${q(session)} AND d.enabled=1;`);
  if (!r || Number(r.expires_at) < Date.now()) {
    if (r) run(`DELETE FROM web_sessions WHERE session_id=${q(session)};`);
    return '';
  }
  return String(r.device_id || '');
}

function migrateLegacyMobileDevices() {
  if (!sqliteAvailable()) return;
  const marker = get(`SELECT id FROM schema_migrations WHERE id='legacy-mobile-devices-v1';`);
  if (marker) return;
  const file = path.join(DATA_DIR, 'mobile-devices.json');
  try {
    if (fs.existsSync(file)) {
      backupLegacyFile(file, 'mobile-devices.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = Array.isArray(raw?.devices) ? raw.devices.map(d => [d.device_id || d.id, d]) : Object.entries(raw || {});
      for (const [id, d] of entries) {
        if (!id || !d) continue;
        const tokenHash = d.tokenHash || (d.token ? require('crypto').createHash('sha256').update(String(d.token)).digest('hex') : '');
        if (!tokenHash) continue;
        upsertMobileDevice({
          device_id: id,
          tokenHash,
          name: d.name || id,
          alias: d.alias || '',
          description: d.description || '',
          platform: d.platform || '',
          model: d.model || '',
          manufacturer: d.manufacturer || '',
          osVersion: d.osVersion || d.os_version || '',
          appVersion: d.appVersion || d.app_version || '',
          userAgent: d.userAgent || '',
          screen: d.screen || '',
          paired_at: d.paired_at || d.createdAt || new Date().toISOString(),
          last_seen: d.last_seen || d.lastSeen || new Date().toISOString(),
          accessMode: d.accessMode || 'control',
          profileAccess: d.profileAccess || { mode: 'all', profileIds: [] },
          settings: d.settings || {}
        });
      }
    }
  } catch (e) {
    console.warn('[db] mobile-devices migration failed:', e.message);
  }
  run(`INSERT OR REPLACE INTO schema_migrations(id) VALUES('legacy-mobile-devices-v1');`);
}

function migrateLegacyClientPrefs() {
  if (!sqliteAvailable()) return;
  const marker = get(`SELECT id FROM schema_migrations WHERE id='legacy-client-prefs-v1';`);
  if (marker) return;
  const dir = path.join(DATA_DIR, 'client-prefs');
  try {
    if (fs.existsSync(dir)) {
      fs.mkdirSync(MIGRATION_BACKUP_DIR, { recursive: true });
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        const clientId = path.basename(f, '.json');
        const full = path.join(dir, f);
        const prefs = JSON.parse(fs.readFileSync(full, 'utf8'));
        upsertWebClient(clientId, { name: prefs.name || clientId, settings: prefs });
      }
    }
  } catch (e) {
    console.warn('[db] client-prefs migration failed:', e.message);
  }
  run(`INSERT OR REPLACE INTO schema_migrations(id) VALUES('legacy-client-prefs-v1');`);
}


function safeWebClientId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128);
}

function safeSlug(slug) {
  return String(slug || '').toLowerCase().replace(/[^a-z0-9_\-]/g, '').replace(/^[\-_]+|[\-_]+$/g, '').slice(0, 96);
}

function randomSlug(len = 10) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = require('crypto').randomBytes(len);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function rmDirQuiet(dir) {
  try { if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.warn('[db] rmDirQuiet failed:', dir, e.message); }
}

function clientSettingsDirFor(type, id) {
  const clean = safeWebClientId(id);
  if (!clean) return '';
  return path.join(DATA_DIR, 'client_settings', type, clean);
}

function addClientLifecycleAudit(kind, clientId, action, payload = {}) {
  try {
    addAccessEvent({
      deviceId: clientId,
      eventType: `client.${kind}.${action}`,
      payload: { id: clientId, kind, action, ...payload }
    });
  } catch (_) {}
}

function webClientDefaultSettings() {
  return {
    version: 1,
    ui: {},
    activeProfileId: '',
    activeLevelId: '',
    activeRoomId: '',
    navigationMode: 'maps',
    standardSensorVisibility: {},
    markerLayoutOverrides: {},
    sensorLayoutOverrides: {},
    kioskSettings: {}
  };
}

function rowToWebClient(r) {
  if (!r) return null;
  const settings = parseJson(r.settings_json, webClientDefaultSettings());
  return {
    client_id: r.client_id,
    id: r.client_id,
    name: r.name || r.alias || r.client_id,
    alias: r.alias || r.name || '',
    slug: r.slug || '',
    description: r.description || '',
    type: r.type || 'web',
    userAgent: r.user_agent || '',
    screen: r.screen || '',
    firstSeen: r.first_seen || r.created_at || '',
    lastSeen: r.last_seen || '',
    enabled: Number(r.enabled) !== 0,
    settings,
    serverBackup: parseJson(r.server_backup_json, {})
  };
}

function upsertWebClient(clientId, data = {}) {
  if (!hasDb()) return false;
  const id = safeWebClientId(clientId) || ('web_' + randomSlug(8));
  const now = new Date().toISOString();
  const settings = { ...webClientDefaultSettings(), ...(data.settings || {}) };
  const alias = String(data.alias || data.name || id).trim().slice(0, 80);
  const slug = data.slug ? safeSlug(data.slug) : '';
  runTransaction(`
INSERT INTO web_clients(client_id, name, alias, slug, description, type, user_agent, screen, first_seen, last_seen, enabled, created_at, updated_at)
VALUES(${q(id)}, ${q(data.name || alias || id)}, ${q(alias || null)}, ${q(slug || null)}, ${q(data.description || '')}, ${q(data.type || 'web')}, ${q(data.userAgent || '')}, ${q(data.screen || '')}, ${q(data.firstSeen || now)}, ${q(now)}, 1, ${q(now)}, ${q(now)})
ON CONFLICT(client_id) DO UPDATE SET
  last_seen=excluded.last_seen,
  name=COALESCE(NULLIF(excluded.name,''), web_clients.name),
  alias=COALESCE(NULLIF(excluded.alias,''), web_clients.alias),
  slug=COALESCE(NULLIF(excluded.slug,''), web_clients.slug),
  description=COALESCE(NULLIF(excluded.description,''), web_clients.description),
  user_agent=COALESCE(NULLIF(excluded.user_agent,''), web_clients.user_agent),
  screen=COALESCE(NULLIF(excluded.screen,''), web_clients.screen),
  enabled=1,
  deleted_at=NULL,
  updated_at=excluded.updated_at;
INSERT INTO web_client_settings(client_id, settings_json, server_backup_json, updated_at)
VALUES(${q(id)}, ${q(json(settings, webClientDefaultSettings()))}, ${q(json(data.serverBackup || settings, {}))}, ${q(now)})
ON CONFLICT(client_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at;
`);
  return true;
}

function listWebClients() {
  if (!hasDb()) return [];
  return all(`SELECT c.*, s.settings_json, s.server_backup_json FROM web_clients c LEFT JOIN web_client_settings s ON s.client_id=c.client_id WHERE c.enabled=1 AND c.deleted_at IS NULL ORDER BY c.last_seen DESC, c.name ASC;`).map(rowToWebClient);
}

function getWebClient(clientId) {
  if (!hasDb()) return null;
  const id = safeWebClientId(clientId);
  if (!id) return null;
  return rowToWebClient(get(`SELECT c.*, s.settings_json, s.server_backup_json FROM web_clients c LEFT JOIN web_client_settings s ON s.client_id=c.client_id WHERE c.client_id=${q(id)} AND c.enabled=1 AND c.deleted_at IS NULL;`));
}

function getWebClientBySlug(slug) {
  if (!hasDb()) return null;
  const clean = safeSlug(slug);
  if (!clean) return null;
  return rowToWebClient(get(`SELECT c.*, s.settings_json, s.server_backup_json FROM web_clients c LEFT JOIN web_client_settings s ON s.client_id=c.client_id WHERE c.slug=${q(clean)} AND c.enabled=1 AND c.deleted_at IS NULL;`));
}

function makeUniqueWebClientSlug(base = '') {
  const prefix = safeSlug(base).slice(0, 40);
  for (let i = 0; i < 20; i++) {
    const slug = (prefix ? prefix + '-' : '') + randomSlug(i < 5 ? 6 : 10);
    if (!getWebClientBySlug(slug)) return slug;
  }
  return randomSlug(16);
}

function createWebClient(data = {}) {
  if (!hasDb()) return null;
  const alias = String(data.alias || data.name || 'web-client').trim().slice(0, 80) || 'web-client';
  const clientId = safeWebClientId(data.clientId || data.client_id || ('web_' + randomSlug(12)));
  const slug = data.slug ? safeSlug(data.slug) : makeUniqueWebClientSlug(alias);
  upsertWebClient(clientId, { ...data, alias, name: data.name || alias, slug, settings: data.settings || webClientDefaultSettings() });
  return getWebClient(clientId);
}

function touchWebClient(clientId, meta = {}) {
  if (!hasDb()) return null;
  const existing = getWebClient(clientId);
  if (!existing) return createWebClient({ clientId, alias: meta.alias || clientId, userAgent: meta.userAgent || '', screen: meta.screen || '', settings: meta.settings || webClientDefaultSettings() });
  upsertWebClient(existing.client_id, { name: existing.name, alias: existing.alias, slug: existing.slug, description: existing.description, userAgent: meta.userAgent || existing.userAgent || '', screen: meta.screen || existing.screen || '', settings: existing.settings || webClientDefaultSettings() });
  return getWebClient(existing.client_id);
}

function updateWebClient(clientId, patch = {}) {
  if (!hasDb()) return null;
  const current = getWebClient(clientId);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    clientId: current.client_id,
    alias: patch.alias !== undefined ? String(patch.alias || '').trim().slice(0, 80) : current.alias,
    name: patch.name !== undefined ? String(patch.name || '').trim().slice(0, 80) : current.name,
    description: patch.description !== undefined ? String(patch.description || '').trim().slice(0, 200) : current.description,
    slug: patch.regenerateSlug ? makeUniqueWebClientSlug(patch.alias || current.alias || current.name) : (patch.slug !== undefined ? safeSlug(patch.slug) : current.slug),
    settings: patch.settings !== undefined ? { ...(current.settings || {}), ...(patch.settings || {}) } : current.settings
  };
  upsertWebClient(current.client_id, next);
  return getWebClient(current.client_id);
}

function deleteWebClient(clientId, options = {}) {
  if (!hasDb()) return false;
  const id = safeWebClientId(clientId);
  if (!id) return false;
  const current = get(`SELECT client_id, alias, name, slug, type FROM web_clients WHERE client_id=${q(id)};`);
  if (!current) return false;
  const label = String(current.alias || current.name || '').trim().toLowerCase();
  if (id === 'server' || label === 'server' || current.type === 'server') return false;
  const now = new Date().toISOString();
  if (options.soft === true) {
    run(`UPDATE web_clients SET enabled=0, deleted_at=${q(now)}, updated_at=${q(now)} WHERE client_id=${q(id)};`);
    addClientLifecycleAudit('web', id, 'soft-delete', { alias: current.alias || current.name || '', slug: current.slug || '' });
    return true;
  }
  // v4.2.1: real delete by default. Deleted clients must not remain as full rows
  // forever and must not be resurrected by settings saves.
  runTransaction(`DELETE FROM web_client_settings WHERE client_id=${q(id)};
DELETE FROM web_clients WHERE client_id=${q(id)};`);
  rmDirQuiet(clientSettingsDirFor('web_client', id));
  addClientLifecycleAudit('web', id, 'delete', { alias: current.alias || current.name || '', slug: current.slug || '' });
  return true;
}

function deleteAllWebClients(options = {}) {
  if (!hasDb()) return { deleted:0, clientIds:[] };
  const keep = new Set((options.keepClientIds || []).map(safeWebClientId).filter(Boolean));
  const rows = all(`SELECT client_id, alias, name, slug, type FROM web_clients WHERE enabled=1 AND deleted_at IS NULL;`).filter(r => {
    const id = safeWebClientId(r.client_id);
    if (!id || keep.has(id)) return false;
    const label = String(r.alias || r.name || '').trim().toLowerCase();
    if (id === 'server' || label === 'server' || r.type === 'server') return false;
    return true;
  });
  if (!rows.length) return { deleted:0, clientIds:[] };
  const ids = rows.map(r => safeWebClientId(r.client_id)).filter(Boolean);
  const idList = ids.map(q).join(',');
  runTransaction(`DELETE FROM web_client_settings WHERE client_id IN (${idList});
DELETE FROM web_clients WHERE client_id IN (${idList});`);
  for (const id of ids) rmDirQuiet(clientSettingsDirFor('web_client', id));
  addClientLifecycleAudit('web', 'bulk', 'delete', { count: ids.length, clientIds: ids });
  return { deleted: ids.length, clientIds: ids };
}

function getWebClientSettings(clientId) {
  if (!hasDb()) return null;
  const client = getWebClient(clientId);
  return client ? client.settings : null;
}

function setWebClientSettings(clientId, settings, meta = {}) {
  if (!hasDb()) return false;
  const current = getWebClient(clientId);
  // v4.2.0.28: settings writes must never create OR resurrect web clients.
  // Do not call upsertWebClient() here because upsertWebClient() intentionally
  // re-enables rows (enabled=1, deleted_at=NULL). Settings saves/copy/restore
  // must be a pure settings update for an already existing active /client/<slug>.
  if(!current || !current.client_id || current.enabled === false) return false;
  const merged = { ...webClientDefaultSettings(), ...(current.settings || {}), ...(settings || {}) };
  const now = new Date().toISOString();
  runTransaction(`
INSERT INTO web_client_settings(client_id, settings_json, server_backup_json, updated_at)
VALUES(${q(current.client_id)}, ${q(json(merged, webClientDefaultSettings()))}, ${q(json(merged, {}))}, ${q(now)})
ON CONFLICT(client_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at;
UPDATE web_clients SET updated_at=${q(now)} WHERE client_id=${q(current.client_id)} AND enabled=1 AND deleted_at IS NULL;
`);
  return true;
}


function normalizeDocKey(key) {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\./g, '_').slice(0, 500) || 'root';
}

function setProjectDocument(key, value, type = 'json') {
  if (!hasDb()) return false;
  const docKey = normalizeDocKey(key);
  const now = new Date().toISOString();
  run(`INSERT INTO project_documents(doc_key, doc_type, json_value, updated_at)
VALUES(${q(docKey)}, ${q(type || 'json')}, ${q(json(value, {}))}, ${q(now)})
ON CONFLICT(doc_key) DO UPDATE SET doc_type=excluded.doc_type, json_value=excluded.json_value, updated_at=excluded.updated_at;`);
  return true;
}

function getProjectDocument(key, fallback) {
  // Important: do not default fallback to null.
  // Callers such as readJsonSafe(file, fallback) intentionally pass undefined
  // to distinguish DB miss from a stored JSON null. Default parameters would
  // turn that undefined into null and make missing documents look like valid
  // null JSON, which later broke /api/ui-state on loaded.viewport.
  if (!hasDb()) return fallback;
  const docKey = normalizeDocKey(key);
  const r = get(`SELECT json_value FROM project_documents WHERE doc_key=${q(docKey)};`);
  return r ? parseJson(r.json_value, fallback) : fallback;
}

function hasProjectDocument(key) {
  if (!hasDb()) return false;
  const r = get(`SELECT 1 AS ok FROM project_documents WHERE doc_key=${q(normalizeDocKey(key))};`);
  return !!r;
}

function deleteProjectDocument(key) {
  if (!hasDb()) return false;
  run(`DELETE FROM project_documents WHERE doc_key=${q(normalizeDocKey(key))};`);
  return true;
}

function escapeLikePattern(str) {
  return String(str ?? '').replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/%/g, '\\%');
}

function clearProjectDocuments(prefix = '') {
  if (!hasDb()) return false;
  const p = normalizeDocKey(prefix);
  if (!prefix) runTransaction(`DELETE FROM project_documents; DELETE FROM project_files;`);
  else {
    const esc = escapeLikePattern(p);
    runTransaction(`DELETE FROM project_documents WHERE doc_key LIKE ${q(esc + '%')} ESCAPE '\\'; DELETE FROM project_files WHERE file_key LIKE ${q(esc + '%')} ESCAPE '\\';`);
  }
  return true;
}

function setProjectFile(key, text, type = 'text') {
  if (!hasDb()) return false;
  const fileKey = normalizeDocKey(key);
  const now = new Date().toISOString();
  run(`INSERT INTO project_files(file_key, file_type, text_value, updated_at)
VALUES(${q(fileKey)}, ${q(type || 'text')}, ${q(String(text ?? ''))}, ${q(now)})
ON CONFLICT(file_key) DO UPDATE SET file_type=excluded.file_type, text_value=excluded.text_value, updated_at=excluded.updated_at;`);
  return true;
}

function getProjectFile(key, fallback = null) {
  if (!hasDb()) return fallback;
  const r = get(`SELECT text_value FROM project_files WHERE file_key=${q(normalizeDocKey(key))};`);
  return r ? r.text_value : fallback;
}


function deleteProjectFile(key) {
  if (!hasDb()) return false;
  run(`DELETE FROM project_files WHERE file_key=${q(normalizeDocKey(key))};`);
  return true;
}

function listProjectDocumentKeys() {
  if (!hasDb()) return [];
  return all(`SELECT doc_key, doc_type, updated_at FROM project_documents ORDER BY doc_key ASC;`);
}

function listProjectFileKeys() {
  if (!hasDb()) return [];
  return all(`SELECT file_key, file_type, updated_at FROM project_files ORDER BY file_key ASC;`);
}

function upsertBackupIndex(item = {}) {
  if (!hasDb() || !item.id || !item.filename) return false;
  run(`INSERT INTO backup_index(id, filename, backup_type, size_bytes, meta_json, created_at)
VALUES(${q(item.id)}, ${q(item.filename)}, ${q(item.backupType || item.type || 'manual')}, ${q(Number(item.sizeBytes || item.size || 0))}, ${q(json(item.meta || {}, {}))}, ${q(item.createdAt || new Date().toISOString())})
ON CONFLICT(id) DO UPDATE SET filename=excluded.filename, backup_type=excluded.backup_type, size_bytes=excluded.size_bytes, meta_json=excluded.meta_json;`);
  return true;
}


function normalizeSensorType(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64);
}
function normalizeEntityIdForDb(value) {
  const v = String(value || '').trim();
  return /^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(v) ? v : '';
}
function getStandardSensorBindingsForLevel(profileId, levelId) {
  if (!hasDb()) return {};
  const rows = all(`SELECT room_id, sensor_type, entity_id FROM standard_sensor_bindings WHERE profile_id=${q(profileId)} AND level_id=${q(levelId)} ORDER BY room_id ASC, sensor_type ASC;`);
  const out = {};
  for (const r of rows) {
    const room = String(r.room_id || '').trim();
    const type = normalizeSensorType(r.sensor_type);
    const entity = normalizeEntityIdForDb(r.entity_id);
    if (!room || !type || !entity) continue;
    out[room] = out[room] || {};
    out[room][type] = entity;
  }
  return out;
}
function getStandardSensorBindingsForRoom(profileId, levelId, roomId) {
  const allBindings = getStandardSensorBindingsForLevel(profileId, levelId);
  return allBindings[String(roomId || '').trim()] || {};
}
function replaceRoomStandardSensorBindings(profileId, levelId, roomId, sensors = {}) {
  if (!hasDb()) return false;
  const pid = String(profileId || '').trim() || 'profile-1';
  const lid = String(levelId || '').trim() || 'level-1';
  const rid = String(roomId || '').trim();
  if (!rid) return false;
  const now = new Date().toISOString();
  const statements = [`DELETE FROM standard_sensor_bindings WHERE profile_id=${q(pid)} AND level_id=${q(lid)} AND room_id=${q(rid)};`];
  for (const [typeRaw, entityRaw] of Object.entries(sensors || {})) {
    const type = normalizeSensorType(typeRaw);
    const entity = normalizeEntityIdForDb(entityRaw);
    if (!type || !entity) continue;
    statements.push(`INSERT INTO standard_sensor_bindings(profile_id, level_id, room_id, sensor_type, entity_id, updated_at) VALUES(${q(pid)}, ${q(lid)}, ${q(rid)}, ${q(type)}, ${q(entity)}, ${q(now)});`);
  }
  run(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`);
  return true;
}
function clearStandardSensorBinding(profileId, levelId, roomId, sensorType) {
  if (!hasDb()) return false;
  run(`DELETE FROM standard_sensor_bindings WHERE profile_id=${q(profileId)} AND level_id=${q(levelId)} AND room_id=${q(roomId)} AND sensor_type=${q(normalizeSensorType(sensorType))};`);
  return true;
}
function clearAllStandardSensorBindingsForRoom(profileId, levelId, roomId) {
  if (!hasDb()) return false;
  run(`DELETE FROM standard_sensor_bindings WHERE profile_id=${q(profileId)} AND level_id=${q(levelId)} AND room_id=${q(roomId)};`);
  return true;
}
function syncStandardSensorBindingsFromRooms(profileId, levelId, settings = {}) {
  if (!hasDb()) return false;
  const rooms = settings && typeof settings === 'object' && settings.rooms && typeof settings.rooms === 'object' ? settings.rooms : {};
  for (const [roomId, room] of Object.entries(rooms)) {
    if (!room || typeof room !== 'object') continue;
    // DB-primary safety: missing standardSensors means “not changed”, not “clear bindings”.
    // Explicit clears go through clearStandardSensorBinding/clearAllStandardSensorBindingsForRoom.
    if (!Object.prototype.hasOwnProperty.call(room, 'standardSensors')) continue;
    replaceRoomStandardSensorBindings(profileId, levelId, roomId, room.standardSensors || {});
  }
  return true;
}


function integrityCheck() {
  if (!hasDb()) return { ok:false, available:false, result:'sqlite unavailable' };
  try {
    const rows = all(`PRAGMA integrity_check;`);
    const result = rows.map(r => r.integrity_check || Object.values(r)[0]).join('\n') || 'unknown';
    return { ok: result === 'ok', available:true, result };
  } catch (e) { return { ok:false, available:true, result:e.message }; }
}

function maintenanceReport() {
  const info = getInfo();
  const report = { database: info, integrity: integrityCheck(), issues: {}, generatedAt: new Date().toISOString() };
  if (!hasDb()) return report;
  try { report.issues.orphanWebSettings = all(`SELECT s.client_id FROM web_client_settings s LEFT JOIN web_clients c ON c.client_id=s.client_id WHERE c.client_id IS NULL OR c.enabled=0 OR c.deleted_at IS NOT NULL ORDER BY s.client_id ASC;`); } catch { report.issues.orphanWebSettings = []; }
  try { report.issues.orphanMobileSettings = all(`SELECT s.device_id FROM mobile_device_settings s LEFT JOIN mobile_devices d ON d.device_id=s.device_id WHERE d.device_id IS NULL OR d.enabled=0 ORDER BY s.device_id ASC;`); } catch { report.issues.orphanMobileSettings = []; }
  try { report.issues.temporaryWebClients = all(`SELECT client_id, alias, slug, last_seen FROM web_clients WHERE enabled=1 AND deleted_at IS NULL AND (slug IS NULL OR slug='') ORDER BY last_seen DESC;`); } catch { report.issues.temporaryWebClients = []; }
  try { report.issues.deletedProfileDocuments = all(`SELECT doc_key, updated_at FROM project_documents WHERE doc_key LIKE 'profiles/profile-%/%' AND doc_key NOT LIKE 'profiles/profile-1/%' ORDER BY doc_key ASC LIMIT 200;`); } catch { report.issues.deletedProfileDocuments = []; }
  try {
    const st = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH) : null;
    report.database.sizeBytes = st ? st.size : 0;
    report.database.sizeMb = st ? Math.round((st.size / 1024 / 1024) * 10) / 10 : 0;
  } catch (_) {}
  try { report.clients = { webActive: Number(get(`SELECT COUNT(*) AS c FROM web_clients WHERE enabled=1 AND deleted_at IS NULL;`)?.c || 0), mobileActive: Number(get(`SELECT COUNT(*) AS c FROM mobile_devices WHERE enabled=1;`)?.c || 0) }; } catch (_) {}
  return report;
}

function clearWebClientSettings(clientId) {
  if (!hasDb()) return false;
  const id = safeWebClientId(clientId);
  if (!id) return false;
  run(`UPDATE web_client_settings SET settings_json='{}', updated_at=${q(new Date().toISOString())} WHERE client_id=${q(id)};`);
  return true;
}

function cleanupTemporaryWebClients() {
  if (!hasDb()) return { removed:0 };
  const rows = all(`SELECT client_id FROM web_clients WHERE enabled=1 AND deleted_at IS NULL AND (slug IS NULL OR slug='');`);
  const ids = rows.map(r => safeWebClientId(r.client_id)).filter(Boolean).filter(id => id !== 'server');
  if (!ids.length) return { removed:0, clientIds:[] };
  const idList = ids.map(q).join(',');
  runTransaction(`DELETE FROM web_client_settings WHERE client_id IN (${idList});
DELETE FROM web_clients WHERE client_id IN (${idList});`);
  for (const id of ids) rmDirQuiet(clientSettingsDirFor('web_client', id));
  addClientLifecycleAudit('web', 'temporary', 'cleanup', { count: ids.length, clientIds: ids });
  return { removed: ids.length, clientIds: ids };
}

function cleanupOrphanClientSettings() {
  if (!hasDb()) return { web:0, mobile:0, sessions:0 };
  const web = all(`SELECT s.client_id FROM web_client_settings s LEFT JOIN web_clients c ON c.client_id=s.client_id WHERE c.client_id IS NULL OR c.enabled=0 OR c.deleted_at IS NOT NULL;`);
  const mobile = all(`SELECT s.device_id FROM mobile_device_settings s LEFT JOIN mobile_devices d ON d.device_id=s.device_id WHERE d.device_id IS NULL OR d.enabled=0;`);
  const sessions = all(`SELECT ws.session_id FROM web_sessions ws LEFT JOIN mobile_devices d ON d.device_id=ws.device_id WHERE d.device_id IS NULL OR d.enabled=0 OR ws.expires_at < ${q(String(Date.now()))};`);
  runTransaction(`DELETE FROM web_client_settings WHERE client_id IN (SELECT s.client_id FROM web_client_settings s LEFT JOIN web_clients c ON c.client_id=s.client_id WHERE c.client_id IS NULL OR c.enabled=0 OR c.deleted_at IS NOT NULL);
DELETE FROM mobile_device_settings WHERE device_id IN (SELECT s.device_id FROM mobile_device_settings s LEFT JOIN mobile_devices d ON d.device_id=s.device_id WHERE d.device_id IS NULL OR d.enabled=0);
DELETE FROM web_sessions WHERE session_id IN (SELECT ws.session_id FROM web_sessions ws LEFT JOIN mobile_devices d ON d.device_id=ws.device_id WHERE d.device_id IS NULL OR d.enabled=0 OR ws.expires_at < ${q(String(Date.now()))});`);
  for (const r of web) rmDirQuiet(clientSettingsDirFor('web_client', r.client_id));
  for (const r of mobile) rmDirQuiet(clientSettingsDirFor('mobile_device', r.device_id));
  addClientLifecycleAudit('clients', 'orphans', 'cleanup', { web:web.length, mobile:mobile.length, sessions:sessions.length });
  return { web:web.length, mobile:mobile.length, sessions:sessions.length };
}


function addAccessEvent(item = {}) {
  if (!hasDb()) return false;
  const eventType = String(item.eventType || item.event_type || '').trim().slice(0, 96);
  if (!eventType) return false;
  const deviceId = String(item.deviceId || item.device_id || '').trim().slice(0, 96) || null;
  run(`INSERT INTO access_events(device_id, event_type, payload_json, created_at) VALUES(${q(deviceId)}, ${q(eventType)}, ${q(json(item.payload || {}, {}))}, ${q(item.createdAt || new Date().toISOString())});`);
  return true;
}
function listAccessEvents(prefix = '', limit = 100) {
  if (!hasDb()) return [];
  const lim = Math.min(500, Math.max(1, Number(limit || 100)));
  const where = prefix ? `WHERE event_type LIKE ${q(String(prefix).replace(/[%_]/g,'') + '%')}` : '';
  return all(`SELECT id, device_id, event_type, payload_json, created_at FROM access_events ${where} ORDER BY id DESC LIMIT ${lim};`).map(r => ({
    id: Number(r.id || 0),
    deviceId: r.device_id || '',
    eventType: r.event_type || '',
    payload: parseJson(r.payload_json, {}),
    createdAt: r.created_at || ''
  }));
}


function clearStandardSensorBindings(profileId = '', levelId = '') {
  if (!hasDb()) return false;
  const pid = String(profileId || '').trim();
  const lid = String(levelId || '').trim();
  if (pid && lid) run(`DELETE FROM standard_sensor_bindings WHERE profile_id=${q(pid)} AND level_id=${q(lid)};`);
  else if (pid) run(`DELETE FROM standard_sensor_bindings WHERE profile_id=${q(pid)};`);
  else run(`DELETE FROM standard_sensor_bindings;`);
  return true;
}

function getInfo() {
  const available = sqliteAvailable();
  if (!available) return { available:false, path:DB_PATH };
  initSchema();
  const counts = {};
  for (const table of ['mobile_devices','mobile_device_settings','web_clients','web_client_settings','web_sessions','command_log','attention_events','backup_index','project_documents','project_files','standard_sensor_bindings','server_baseline_settings']) {
    try { counts[table] = Number(get(`SELECT COUNT(*) AS count FROM ${table};`)?.count || 0); }
    catch { counts[table] = 0; }
  }
  return { available:true, path:DB_PATH, counts };
}

module.exports = {
  DB_PATH, q, json, parseJson,
  sqliteAvailable, initSchema, closeDb, hasDb, getInfo, integrityCheck, maintenanceReport, cleanupTemporaryWebClients, cleanupOrphanClientSettings, getPerformanceStats,
  upsertMobileDevice, listMobileDevices, getMobileDevice, getMobileDeviceByAlias, getMobileDeviceSecret,
  updateMobileLastSeen, updateMobileDevice, deleteMobileDevice, deleteAllMobileDevices,
  createWebSession, validateWebSession, getWebSessionDeviceId, addAccessEvent, listAccessEvents,
  upsertWebClient, listWebClients, getWebClient, getWebClientBySlug, createWebClient, touchWebClient, updateWebClient, deleteWebClient, deleteAllWebClients, getWebClientSettings, setWebClientSettings, clearWebClientSettings,
  setProjectDocument, getProjectDocument, hasProjectDocument, deleteProjectDocument, clearProjectDocuments, listProjectDocumentKeys, listProjectFileKeys,
  setProjectFile, getProjectFile, deleteProjectFile, upsertBackupIndex,
  getStandardSensorBindingsForLevel, getStandardSensorBindingsForRoom, replaceRoomStandardSensorBindings, clearStandardSensorBinding, clearAllStandardSensorBindingsForRoom, clearStandardSensorBindings, syncStandardSensorBindingsFromRooms,
  normalizeMobileSettings, normalizeProfileAccess, backupLegacyFile
};
