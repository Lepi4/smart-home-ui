'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = process.env.ALLHA_DB_PATH || path.join(DATA_DIR, 'allha2d.db');
const MIGRATION_BACKUP_DIR = path.join(DATA_DIR, 'migration-backups');

let _sqliteAvailable = null;
let _initialized = false;

function sqliteAvailable() {
  if (_sqliteAvailable !== null) return _sqliteAvailable;
  try {
    execFileSync('sqlite3', ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    _sqliteAvailable = true;
  } catch {
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
  if (!sqliteAvailable()) throw new Error('sqlite3 CLI is not installed');
  ensureDirs();
  execFileSync('sqlite3', [DB_PATH], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024 });
}

function tryRun(sql) {
  try { run(sql); return true; } catch { return false; }
}

function all(sql) {
  if (!sqliteAvailable()) throw new Error('sqlite3 CLI is not installed');
  ensureDirs();
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
  try { return JSON.parse(out || '[]'); } catch { return []; }
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
  access_mode TEXT NOT NULL DEFAULT 'viewer',
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
  return {
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
    accessMode: r.access_mode || 'viewer',
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
  run(`
INSERT INTO mobile_devices (
  device_id, token_hash, name, alias, description, platform, model, manufacturer,
  os_version, app_version, user_agent, screen, paired_at, last_seen, access_mode,
  profile_access_json, enabled, updated_at
) VALUES (
  ${q(device.device_id)}, ${q(device.tokenHash)}, ${q(device.name || device.device_id)}, ${q(device.alias || null)}, ${q(device.description || null)},
  ${q(device.platform || '')}, ${q(device.model || '')}, ${q(device.manufacturer || '')}, ${q(device.osVersion || '')},
  ${q(device.appVersion || '')}, ${q(device.userAgent || '')}, ${q(device.screen || '')}, ${q(device.paired_at || now)},
  ${q(device.last_seen || now)}, ${q(device.accessMode || 'viewer')}, ${q(json(profileAccess, { mode:'all', profileIds:[] }))},
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
  run(`DELETE FROM mobile_devices WHERE device_id=${q(device_id)};`);
  return true;
}

function deleteAllMobileDevices() {
  if (!hasDb()) return false;
  run(`DELETE FROM mobile_devices; DELETE FROM web_sessions;`);
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
          accessMode: d.accessMode || 'viewer',
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
  run(`
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

function deleteWebClient(clientId) {
  if (!hasDb()) return false;
  const id = safeWebClientId(clientId);
  if (!id) return false;
  run(`UPDATE web_clients SET enabled=0, deleted_at=${q(new Date().toISOString())}, updated_at=${q(new Date().toISOString())} WHERE client_id=${q(id)};`);
  return true;
}

function getWebClientSettings(clientId) {
  if (!hasDb()) return null;
  const client = getWebClient(clientId);
  return client ? client.settings : null;
}

function setWebClientSettings(clientId, settings, meta = {}) {
  if (!hasDb()) return false;
  const current = getWebClient(clientId);
  const merged = { ...webClientDefaultSettings(), ...(current?.settings || {}), ...(settings || {}) };
  upsertWebClient(clientId, { name: meta.name || current?.name || clientId, alias: meta.alias || current?.alias || meta.name || clientId, slug: meta.slug || current?.slug || '', userAgent: meta.userAgent || current?.userAgent || '', screen: meta.screen || current?.screen || '', settings: merged });
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

function getProjectDocument(key, fallback = null) {
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

function clearProjectDocuments(prefix = '') {
  if (!hasDb()) return false;
  const p = normalizeDocKey(prefix);
  if (!prefix) run(`DELETE FROM project_documents; DELETE FROM project_files;`);
  else run(`DELETE FROM project_documents WHERE doc_key LIKE ${q(p + '%')}; DELETE FROM project_files WHERE file_key LIKE ${q(p + '%')};`);
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
  sqliteAvailable, initSchema, hasDb, getInfo,
  upsertMobileDevice, listMobileDevices, getMobileDevice, getMobileDeviceSecret,
  updateMobileLastSeen, updateMobileDevice, deleteMobileDevice, deleteAllMobileDevices,
  createWebSession, validateWebSession,
  upsertWebClient, listWebClients, getWebClient, getWebClientBySlug, createWebClient, touchWebClient, updateWebClient, deleteWebClient, getWebClientSettings, setWebClientSettings,
  setProjectDocument, getProjectDocument, hasProjectDocument, deleteProjectDocument, clearProjectDocuments, listProjectDocumentKeys, listProjectFileKeys,
  setProjectFile, getProjectFile, upsertBackupIndex,
  getStandardSensorBindingsForLevel, getStandardSensorBindingsForRoom, replaceRoomStandardSensorBindings, clearStandardSensorBinding, clearAllStandardSensorBindingsForRoom, syncStandardSensorBindingsFromRooms,
  normalizeMobileSettings, normalizeProfileAccess, backupLegacyFile
};
