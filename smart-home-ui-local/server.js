const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const crypto = require('crypto');
const zlib = require('zlib');
const { HA_API_BASE, HA_WS_URL, HA_TOKEN, haFetch, haWsCommand, haCallService, statesCache, sseClients, broadcastSseEvent, setSseBatchMs, noteSseClientConnected, noteSseClientDisconnected, noteSseClientRejected, noteSseHeartbeat, startHaWsSubscription, getHaStatus, stopHaWsSubscription } = require('./src/ha');
const mobileAuth = require('./src/mobile-auth');
const allhaDb = require('./src/db');
const { ENTITY_DOMAINS, ENTITY_RE, ROOM_PATTERNS, ROOM_LABELS, DOMAIN_EMOJI, friendlyRoomLabel, domainOf, isEntityId, extractEntityIdsFromString, friendlyFromEntityId, canonicalRoomFromText, asArray, deepClone, deepMerge, variablesToMap, substituteDeclutteringVars, unwrapLovelaceConfig, selectViews, cardTitle, headingTitle, getCardsFromView, resolveButtonCardTemplates, resolveDeclutteringCard, collectEntityRefs, flattenCardForEntityCollection, makeDevice, parseLovelaceRawBundle } = require('./src/lovelace');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const app = express();
let _inFlightRequests = 0;
let _lastInFlightChangeAt = null;
app.use((req,res,next)=>{
  _inFlightRequests++;
  _lastInFlightChangeAt = new Date().toISOString();
  res.on('finish', ()=>{ _inFlightRequests=Math.max(0,_inFlightRequests-1); _lastInFlightChangeAt = new Date().toISOString(); });
  res.on('close', ()=>{ if(!res.writableEnded){ _inFlightRequests=Math.max(0,_inFlightRequests-1); _lastInFlightChangeAt = new Date().toISOString(); } });
  next();
});

// Security + CORS headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Mobile app / Capacitor CORS.
  // v4.2.0: do not return wildcard CORS for empty Origin. Non-browser clients do not need it.
  // Origin: null is allowed only on the mobile port, because some Android WebView/Capacitor
  // flows may use it; this must stay covered by mobile auth/device-token checks.
  const origin = req.headers.origin || '';
  const localPort = Number(req.socket?.localPort || req.headers.host?.split(':').pop() || 0);
  const isMobilePort = localPort === MOBILE_PORT;
  const allowedOrigins = /^(capacitor|ionic):\/\/localhost$|^https?:\/\/localhost(?::\d+)?$/i;
  const allowCors = !!origin && (allowedOrigins.test(origin) || (origin === 'null' && isMobilePort));
  if (allowCors) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method, Access-Control-Request-Private-Network');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Device-ID, X-Client-ID, Accept, Origin, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Per-request id for logs and safe client-facing errors.
app.use((req, res, next) => {
  const incoming = String(req.headers['x-request-id'] || '').trim();
  req.requestId = /^[a-zA-Z0-9_.:-]{6,96}$/.test(incoming) ? incoming : crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-ID', req.requestId);
  next();
});

// Lightweight rate limiter (no external deps).
// v4.1.21.18.44: keep it on sensitive endpoints only and cap internal Map growth.
const _rlStore = new Map();
const RATE_LIMIT_MAX_KEYS = Number(process.env.ALLHA_RATE_LIMIT_MAX_KEYS || 2000);
let _lastRateLimitCleanupAt = 0;
const _perfStats = {
  startedAt: new Date().toISOString(),
  logWrites: 0,
  logBytes: 0,
  logFlushes: 0,
  logRotationChecks: 0,
  logRotations: 0,
  rateLimitChecks: 0,
  rateLimitBlocked: 0,
  rateLimitCleanups: 0,
  rateLimitDeleted: 0,
  rateLimitMaxStoreSize: 0
};
function trustedProxyEnabled(){ return String(process.env.ALLHA_TRUST_PROXY || process.env.TRUST_PROXY || '0') === '1'; }
function getForwardedIp(req){
  if(!trustedProxyEnabled()) return '';
  const xff=String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers['x-real-ip'] || '').trim();
}
function getRateLimitKey(req){
  // Avoid expensive parsing on every request. This middleware is used only for sensitive routes.
  const h = req.headers || {};
  const rawDevice = h['x-device-id'] || h['x-allha-device-id'] || '';
  if(rawDevice) return 'mobile:' + sanitizeClientId(rawDevice);
  const rawClient = h['x-client-id'] || '';
  if(rawClient) return 'client:' + sanitizeClientId(rawClient);
  const fwd=getForwardedIp(req);
  return 'ip:' + (fwd || req.socket?.remoteAddress || 'unknown');
}
function cleanupRateLimitStore(now = Date.now(), force=false){
  if(!force && now - _lastRateLimitCleanupAt < 30_000 && _rlStore.size <= RATE_LIMIT_MAX_KEYS) return 0;
  _lastRateLimitCleanupAt = now;
  let removed = 0;
  for(const [k,e] of _rlStore){
    if(now > e.resetAt || (RATE_LIMIT_MAX_KEYS > 0 && _rlStore.size - removed > RATE_LIMIT_MAX_KEYS && e.count <= 1)){
      _rlStore.delete(k); removed++;
    }
  }
  _perfStats.rateLimitCleanups++;
  _perfStats.rateLimitDeleted += removed;
  return removed;
}
function makeRateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    _perfStats.rateLimitChecks++;
    const now = Date.now();
    cleanupRateLimitStore(now, _rlStore.size > RATE_LIMIT_MAX_KEYS);
    const key = getRateLimitKey(req);
    let e = _rlStore.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; _rlStore.set(key, e); }
    if(_rlStore.size > _perfStats.rateLimitMaxStoreSize) _perfStats.rateLimitMaxStoreSize = _rlStore.size;
    if (++e.count > maxReq) { _perfStats.rateLimitBlocked++; return res.status(429).json({ error: 'Слишком много запросов, подождите немного' }); }
    next();
  };
}
// Clean up stale entries periodically and keep the timer cheap.
setInterval(() => cleanupRateLimitStore(Date.now(), true), 60_000).unref();
const writeRouteRateLimit = makeRateLimit(Number(process.env.ALLHA_WRITE_RATE_LIMIT_MAX || 60), Number(process.env.ALLHA_WRITE_RATE_LIMIT_WINDOW_MS || 60_000));
function isWriteOrDestructiveRoute(req){
  const method = String(req.method || '').toUpperCase();
  if(!['POST','PUT','PATCH','DELETE'].includes(method)) return false;
  const p = String(req.path || req.url || '').split('?')[0];
  return /^\/api\/(profiles|levels|layout|factory-reset|source-config|config|security|attention|ui-state|maintenance|backups|ha\/(service|lovelace|dashboard-paths)|import|mobile\/(code|devices|settings)|web-clients|client-layout|prefs)/.test(p);
}
app.use((req,res,next)=>{
  if(!isWriteOrDestructiveRoute(req)) return next();
  return writeRouteRateLimit(req,res,next);
});
function serverPerformanceStats(){
  return {
    ..._perfStats,
    debugLogEnabled: DEBUG_LOG_ENABLED,
    rateLimitStoreSize: _rlStore.size,
    rateLimitMaxKeys: RATE_LIMIT_MAX_KEYS,
    trustedProxy: trustedProxyEnabled()
  };
}

function readPortEnv(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port number between 1 and 65535`);
  }
  return value;
}
const PORT = readPortEnv('PORT', 8080);
const MOBILE_PORT = readPortEnv('MOBILE_PORT', 32457);
const MOBILE_OPEN_PATHS = new Set(['/api/health', '/api/mobile/debug', '/api/mobile/pair', '/mobile-lock.html']);
const MOBILE_WEB_COOKIE = 'allha_mobile_session';
const DATA_DIR = process.env.DATA_DIR || '/data';
const FALLBACK_DATA_DIR = path.join(__dirname, 'data');

const DEBUG_LOG_DIR = path.join(DATA_DIR, 'logs');
const DEBUG_LOG_PATH = path.join(DEBUG_LOG_DIR, 'allha2d-debug.log');
const DEBUG_LOG_ENABLED = String(process.env.ALLHA_DEBUG_LOG || '0') === '1';
const DEBUG_LOG_HTTP = String(process.env.ALLHA_DEBUG_HTTP || '0') === '1';
const DEBUG_LOG_CLIENT_EVENTS = String(process.env.ALLHA_DEBUG_CLIENT_EVENTS || '0') === '1';
const DEBUG_LOG_MAX_BYTES = Number(process.env.ALLHA_DEBUG_LOG_MAX_BYTES || 5 * 1024 * 1024);
const DEBUG_LOG_MAX_FILES = Number(process.env.ALLHA_DEBUG_LOG_MAX_FILES || 3);
const DEBUG_LOG_ROTATE_CHECK_MS = Number(process.env.ALLHA_DEBUG_LOG_ROTATE_CHECK_MS || 60_000);
let _debugLogQueue = [];
let _debugLogFlushTimer = null;
let _debugLogKnownSize = 0;
let _debugLogKnownSizeLoaded = false;
let _debugLogLastRotateCheckAt = 0;
function maskSecretValue(value){
  const s = String(value ?? '');
  if(!s) return s;
  if(s.length <= 12) return '***';
  return s.slice(0,4) + '…' + s.slice(-4);
}
function sanitizeForDebugLog(value, depth=0){
  if(depth > 4) return '[depth-limit]';
  if(value === null || value === undefined) return value;
  if(typeof value === 'string') return value.length > 350 ? value.slice(0,350)+'…' : value;
  if(typeof value !== 'object') return value;
  if(Array.isArray(value)) return value.slice(0,25).map(v=>sanitizeForDebugLog(v, depth+1));
  const out = {};
  for(const [k,v] of Object.entries(value)){
    const lk = String(k).toLowerCase();
    const secretKeys = ['token','authorization','password','pin','secret','apikey','api_key','bearer','bearertoken','credentials','cookie','set-cookie','session','accesskey','access_key','refreshtoken','refresh_token'];
    if(secretKeys.some(x => lk.includes(x))){
      out[k] = maskSecretValue(v);
    } else {
      out[k] = sanitizeForDebugLog(v, depth+1);
    }
  }
  return out;
}
function rotateDebugLogIfNeeded(extraBytes=0){
  try{
    if(!DEBUG_LOG_MAX_BYTES) return;
    const now = Date.now();
    const add = Number(extraBytes||0);
    if(!_debugLogKnownSizeLoaded){
      _debugLogKnownSizeLoaded = true;
      try { _debugLogKnownSize = fs.existsSync(DEBUG_LOG_PATH) ? fs.statSync(DEBUG_LOG_PATH).size : 0; } catch { _debugLogKnownSize = 0; }
    }
    _debugLogKnownSize += add;
    // v4.1.21.18.44: do not stat/rename synchronously on every log flush.
    if(_debugLogKnownSize <= DEBUG_LOG_MAX_BYTES && now - _debugLogLastRotateCheckAt < DEBUG_LOG_ROTATE_CHECK_MS) return;
    _debugLogLastRotateCheckAt = now;
    _perfStats.logRotationChecks++;
    if(!fs.existsSync(DEBUG_LOG_PATH)) { _debugLogKnownSize = 0; return; }
    const st=fs.statSync(DEBUG_LOG_PATH);
    _debugLogKnownSize = st.size + add;
    if(_debugLogKnownSize <= DEBUG_LOG_MAX_BYTES) return;
    fs.mkdirSync(DEBUG_LOG_DIR,{recursive:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const rotated=path.join(DEBUG_LOG_DIR, `allha2d-debug.${stamp}.log`);
    fs.renameSync(DEBUG_LOG_PATH, rotated);
    _debugLogKnownSize = 0;
    _perfStats.logRotations++;
    const files=fs.readdirSync(DEBUG_LOG_DIR)
      .filter(n=>/^allha2d-debug\..+\.log$/.test(n))
      .map(n=>({name:n, path:path.join(DEBUG_LOG_DIR,n), mtime:fs.statSync(path.join(DEBUG_LOG_DIR,n)).mtimeMs}))
      .sort((a,b)=>b.mtime-a.mtime);
    files.slice(Math.max(0, DEBUG_LOG_MAX_FILES)).forEach(f=>{ try{fs.unlinkSync(f.path);}catch(e){} });
  }catch(e){}
}
function flushDebugLog(){
  if(!_debugLogQueue.length) return;
  const lines = _debugLogQueue.splice(0, _debugLogQueue.length).join('');
  const bytes = Buffer.byteLength(lines);
  _perfStats.logFlushes++;
  _perfStats.logBytes += bytes;
  fs.mkdir(DEBUG_LOG_DIR, {recursive:true}, () => {
    rotateDebugLogIfNeeded(bytes);
    fs.appendFile(DEBUG_LOG_PATH, lines, 'utf8', () => {});
  });
}
function writeDebugLog(scope, message, data){
  if(!DEBUG_LOG_ENABLED) return;
  try{
    _perfStats.logWrites++;
    _debugLogQueue.push(JSON.stringify({
      ts:new Date().toISOString(),
      scope,
      message,
      data:sanitizeForDebugLog(data)
    }) + '\n');
    if(_debugLogQueue.length > 100) flushDebugLog();
    else if(!_debugLogFlushTimer){
      _debugLogFlushTimer = setTimeout(() => {
        _debugLogFlushTimer = null;
        flushDebugLog();
      }, 500);
      _debugLogFlushTimer.unref?.();
    }
  }catch(e){}
}
function debugLogResponse(req, res, scope, extra){
  if(!DEBUG_LOG_HTTP) return;
  const start = Date.now();
  res.on('finish', () => {
    if(res.statusCode < 400) return;
    writeDebugLog(scope || 'http-error', `${req.method} ${req.originalUrl || req.url}`, {
      method:req.method,
      url:req.originalUrl || req.url,
      status:res.statusCode,
      ms:Date.now()-start,
      deviceId:req.headers['x-device-id'] || '',
      clientId:req.headers['x-client-id'] || '',
      mobile: !!req.headers.authorization,
      ...extra
    });
  });
}
function logRequestError(req, scope, err, extra={}){
  try{
    writeDebugLog(scope || 'server-error', err?.message || 'error', {
      requestId: req?.requestId || '',
      url: req?.originalUrl || req?.url || '',
      method: req?.method || '',
      error: err?.message || String(err || 'error'),
      stack: err?.stack || '',
      ...extra
    });
  }catch(e){}
}
function safeErrorResponse(req, res, err, status=500, message='Внутренняя ошибка'){
  const code = Number(status || 500);
  logRequestError(req, code >= 500 ? 'server-error' : 'request-error', err);
  return res.status(code).json({ ok:false, error: message, requestId: req?.requestId || '' });
}
function validationErrorResponse(req, res, err, message){
  return safeErrorResponse(req, res, err, 400, message || 'Некорректный запрос');
}
function publicSafeErrorMessage(err, fallback='Внутренняя ошибка'){
  const msg = String(err?.message || err || '').trim();
  if(!msg) return fallback;
  // Keep user-actionable errors visible, but strip control chars and keep it short.
  return msg.replace(/[\r\n\t]+/g, ' ').slice(0, 240);
}
function importErrorResponse(req, res, err, message='Ошибка перечитывания уровня'){
  logRequestError(req, 'lovelace-import-error', err);
  const detail = publicSafeErrorMessage(err);
  return res.status(500).json({ ok:false, error: `${message}: ${detail}`, requestId: req?.requestId || '' });
}


const ADDON_CONFIG_PATH = path.join(DATA_DIR, 'addon_config.json');
const MOBILE_ACCESS_PATH = path.join(DATA_DIR, 'mobile_access.json');
const LAYOUT_BACKUP_DIR = path.join(DATA_DIR, 'backups');
// v4.2.5: backups are manual-only by default. Automatic safety backups can be
// re-enabled only explicitly for local/debug use with ALLHA_ENABLE_AUTO_BACKUPS=1.
function autoBackupsEnabled(){ return String(process.env.ALLHA_ENABLE_AUTO_BACKUPS || '').trim() === '1'; }
function autoBackupSkipped(reason){ return { skipped:true, reason:String(reason||'automatic-backups-disabled'), automaticBackups:false }; }
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const PROFILES_META_PATH = path.join(DATA_DIR, 'profiles.json');
let ACTIVE_PROFILE_ID = 'profile-1';
let ACTIVE_PROFILE_DIR = path.join(PROFILES_DIR, ACTIVE_PROFILE_ID);
let ACTIVE_LEVEL_ID = 'level-1';
let ACTIVE_LEVEL_DIR = path.join(ACTIVE_PROFILE_DIR, 'levels', ACTIVE_LEVEL_ID);
let LAYOUT_PATH = path.join(ACTIVE_LEVEL_DIR, 'layout.json');
let SOURCE_CONFIG_PATH = path.join(ACTIVE_LEVEL_DIR, 'source_config.json');
let UI_STATE_PATH = path.join(ACTIVE_LEVEL_DIR, 'ui_state.json');
let DATA_IMAGES_DIR = path.join(ACTIVE_LEVEL_DIR, 'images');
let DATA_IMAGES_OVERVIEW_DIR = path.join(DATA_IMAGES_DIR, 'overview');
let DATA_IMAGES_ROOMS_DIR = path.join(DATA_IMAGES_DIR, 'rooms');
let DATA_IMAGES_ORIGINALS_DIR = path.join(DATA_IMAGES_DIR, 'originals');
let IMAGES_META_PATH = path.join(DATA_IMAGES_DIR, 'images_meta.json');
let DATA_IMAGES_ORIGINALS_ROOMS_DIR = path.join(DATA_IMAGES_ORIGINALS_DIR, 'rooms');
const DEFAULT_OVERVIEW_IMAGE = null;
const DEFAULT_ROOM_IMAGE = null;
const ATTENTION_RULES_PATH = path.join(DATA_DIR, 'attention_rules.json');
const SECURITY_RULES_PATH = path.join(DATA_DIR, 'security_rules.json');
let ROOMS_SETTINGS_PATH = path.join(ACTIVE_LEVEL_DIR, 'rooms.json');

let DEVICES_PATH = path.join(ACTIVE_LEVEL_DIR, 'devices.js');
let LOVELACE_PATH = path.join(ACTIVE_LEVEL_DIR, 'lovelace-source.js');
const FALLBACK_DEVICES_PATH = path.join(__dirname, 'public', 'devices.js');
const ADDON_VERSION = process.env.BUILD_VERSION || require('./package.json').version || '4.0.0';
const APP_BRAND = 'ALLHA-2D';
const APP_DEVELOPER = 'Lepi4';
const APP_GITHUB = 'https://github.com/Lepi4/smart-home-ui';
const APP_COPYRIGHT = '© Lepi4';
const SAFE_SERVICES = {
  light: ['turn_on','turn_off','toggle','set_brightness','set_temperature','set_color_temp','set_hs_color','set_rgb_color'],
  switch: ['turn_on','turn_off','toggle'],
  fan: ['turn_on','turn_off','toggle','set_percentage','set_preset_mode'],
  input_boolean: ['turn_on','turn_off','toggle'],
  cover: ['open_cover','close_cover','stop_cover','set_cover_position'],
  climate: ['turn_on','turn_off','set_temperature','set_hvac_mode','set_fan_mode','set_preset_mode'],
  media_player: ['turn_on','turn_off','media_play_pause','volume_down','volume_up','volume_set','media_stop','media_play','media_pause'],
  humidifier: ['turn_on','turn_off','set_humidity','set_mode'],
  scene: ['turn_on'],
  input_number: ['set_value'],
  input_select: ['select_option'],
  select: ['select_option'],
  number: ['set_value']
};
const DANGEROUS_SERVICES = {
  lock: ['lock','unlock'],
  valve: ['open_valve','close_valve'],
  button: ['press'],
  script: ['turn_on'],
  automation: ['trigger','turn_on','turn_off']
};
const ALLOWED_SERVICES = Object.fromEntries([...Object.entries(SAFE_SERVICES), ...Object.entries(DANGEROUS_SERVICES)]);
const COMMAND_LOG_PATH = path.join(DATA_DIR, 'command_log.json');
const DASHBOARD_PROXY_STATE_PATH = path.join(DATA_DIR, 'dashboard_proxy.json');
const DIRECT_DASHBOARD_PORT = Number(process.env.DIRECT_DASHBOARD_PORT || process.env.ALLHA_DIRECT_PORT || 8099);
const runtimeAudit = {
  jsonFallbackReads: 0,
  fileFallbackReads: 0,
  jsonFallbackKeys: {},
  fileFallbackKeys: {},
  runtimeDefaultWrites: 0,
  mirrorMissingButDbPresent: 0,
  directRuntimeFileChecks: 0,
  legacyClientPrefsFallbackReads: 0,
  legacyClientPrefsFallbackWrites: 0,
  legacyClientPrefsImported: 0,
  legacyMobileJsonFallbackReads: 0,
  legacyStandardSensorsMigrationReads: 0,
  devicesSource: 'unknown',
  lovelaceRawSource: 'unknown'
};
function bumpRuntimeAudit(kind, key){
  try{
    if(runtimeAudit[kind] !== undefined && typeof runtimeAudit[kind] === 'number') runtimeAudit[kind] += 1;
    const bucket = kind === 'jsonFallbackReads' ? 'jsonFallbackKeys' : (kind === 'fileFallbackReads' ? 'fileFallbackKeys' : null);
    if(bucket && key) runtimeAudit[bucket][key] = (runtimeAudit[bucket][key] || 0) + 1;
    if(kind==='jsonFallbackReads' || kind==='fileFallbackReads') logDebug('storage', `${kind}: ${key||''}`);
  }catch(e){}
}

const LOG_LEVELS = { error: 0, info: 1, debug: 2 };
let cachedLogLevel = null;
let cachedLogLevelLoadedAt = 0;
function currentLogLevel(){
  const env = process.env.ALLHA_LOG_LEVEL;
  if(env) return String(env).toLowerCase();
  const now = Date.now();
  if(cachedLogLevel && (now - cachedLogLevelLoadedAt) < 30000) return cachedLogLevel;
  try{
    const cfg = readJsonSafe(ADDON_CONFIG_PATH, {}) || {};
    cachedLogLevel = String(cfg.logLevel || 'info').toLowerCase();
    cachedLogLevelLoadedAt = now;
    return cachedLogLevel;
  }catch(e){ return cachedLogLevel || 'info'; }
}
function setCachedLogLevel(level){
  cachedLogLevel = String(level || 'info').toLowerCase();
  cachedLogLevelLoadedAt = Date.now();
}
function shouldLog(level){
  const cur = LOG_LEVELS[currentLogLevel()] ?? LOG_LEVELS.info;
  const val = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  return val <= cur;
}
function redactForLog(value){
  if(value === undefined) return undefined;
  try{
    const seen = new WeakSet();
    return JSON.parse(JSON.stringify(value, (k,v)=>{
      const key = String(k||'').toLowerCase();
      if(key.includes('token') || key.includes('password') || key.includes('secret') || key.includes('pin') || key.includes('authorization')) return '[redacted]';
      if(v && typeof v === 'object'){
        if(seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }));
  }catch(e){ return value; }
}
const LOG_BUFFER_LIMIT = 300;
const logBuffer = [];
function allhaLog(level, scope, message, details){
  if(!shouldLog(level)) return;
  const row = { ts:new Date().toISOString(), level, scope:String(scope||'app'), message:String(message||''), details:redactForLog(details) };
  logBuffer.push(row);
  while(logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.shift();
  const line = `[ALLHA-2D][${row.level}][${row.scope}] ${row.message}` + (row.details !== undefined ? ` ${JSON.stringify(row.details)}` : '');
  try{ (level === 'error' ? console.error : console.log)(line); }catch(e){}
  try{
    if(process.env.ALLHA_LOG_FILE === '1'){
      const dir = path.join(DATA_DIR, 'logs');
      fs.mkdirSync(dir, {recursive:true});
      const file = path.join(dir, 'allha2d.log');
      fs.appendFileSync(file, line + '\n', 'utf8');
      try{
        const st = fs.statSync(file);
        if(st.size > 1024*1024){
          const old = path.join(dir, 'allha2d.log.1');
          try{ if(fs.existsSync(old)) fs.rmSync(old, {force:true}); }catch(e){}
          fs.renameSync(file, old);
        }
      }catch(e){}
    }
  }catch(e){}
}
function logError(scope, message, details){ allhaLog('error', scope, message, details); }
function logInfo(scope, message, details){ allhaLog('info', scope, message, details); }
function logDebug(scope, message, details){ allhaLog('debug', scope, message, details); }

function projectDocKeyForFile(file){
  try{
    const resolved = path.resolve(file);
    const dataRoot = path.resolve(DATA_DIR);
    if(!resolved.startsWith(dataRoot)) return null;
    const rel = path.relative(dataRoot, resolved).replace(/\\/g,'/');
    if(!rel || rel.startsWith('..')) return null;
    if(!/\.json$/i.test(rel)) return null;
    return rel;
  }catch(e){ return null; }
}
function readJsonSafe(file, fallback){
  try{
    const key = projectDocKeyForFile(file);
    if(key && allhaDb.hasDb && allhaDb.hasDb()){
      const fromDb = allhaDb.getProjectDocument(key, undefined);
      if(fromDb !== undefined){
        if(!fs.existsSync(file)) runtimeAudit.mirrorMissingButDbPresent += 1;
        if(fromDb === null){
          writeDebugLog('runtime-json', 'db document is null', {key, file, fallbackType:typeof fallback});
          return fallback;
        }
        return fromDb;
      }
      if(fs.existsSync(file)){
        const parsed = JSON.parse(fs.readFileSync(file,'utf8'));
        bumpRuntimeAudit('jsonFallbackReads', key);
        allhaDb.setProjectDocument(key, parsed, 'json-migration-fallback');
        return parsed;
      }
      writeDebugLog('runtime-json', 'document missing, fallback used', {key, file, fallbackType:typeof fallback});
      return fallback;
    }
    if(fs.existsSync(file)){
      bumpRuntimeAudit('jsonFallbackReads', key || file);
      return JSON.parse(fs.readFileSync(file,'utf8'));
    }
    return fallback;
  }catch(e){
    writeDebugLog('runtime-json', 'read failed, fallback used', {file, error:e.message});
    return fallback;
  }
}
function readJsonFileOnly(file, fallback){
  try{ return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : fallback; }
  catch(e){ return fallback; }
}

function runtimeDocumentExists(file){
  try{
    const key = projectDocKeyForFile(file);
    if(key && allhaDb.hasDb && allhaDb.hasDb() && allhaDb.hasProjectDocument && allhaDb.hasProjectDocument(key)){
      if(!fs.existsSync(file)) runtimeAudit.mirrorMissingButDbPresent += 1;
      return true;
    }
    return fs.existsSync(file);
  }catch(e){ return false; }
}
function runtimeFileExists(file){
  try{
    const key = projectFileKeyForFile(file);
    const fromDb = key && allhaDb.hasDb && allhaDb.hasDb() && allhaDb.getProjectFile ? allhaDb.getProjectFile(key, null) : null;
    if(fromDb !== null && fromDb !== undefined){
      if(!fs.existsSync(file)) runtimeAudit.mirrorMissingButDbPresent += 1;
      return true;
    }
    return fs.existsSync(file);
  }catch(e){ return false; }
}
function runtimeDocumentSource(file){
  try{
    const key = projectDocKeyForFile(file);
    if(key && allhaDb.hasDb && allhaDb.hasDb() && allhaDb.hasProjectDocument && allhaDb.hasProjectDocument(key)) return fs.existsSync(file) ? 'sqlite+mirror' : 'sqlite-only';
    if(fs.existsSync(file)) return 'mirror-only';
    return 'missing';
  }catch(e){ return 'error'; }
}
function runtimeFileSource(file){
  try{
    const key = projectFileKeyForFile(file);
    const fromDb = key && allhaDb.hasDb && allhaDb.hasDb() && allhaDb.getProjectFile ? allhaDb.getProjectFile(key, null) : null;
    if(fromDb !== null && fromDb !== undefined) return fs.existsSync(file) ? 'sqlite+mirror' : 'sqlite-only';
    if(fs.existsSync(file)) return 'mirror-only';
    return 'missing';
  }catch(e){ return 'error'; }
}
function readRuntimeDocument(file, fallback){ return readJsonSafe(file, fallback); }
function writeRuntimeDocument(file, data){ return atomicWriteJson(file, data); }
function readRuntimeTextFile(file, fallback=''){ return readTextRuntimeFile(file, fallback); }
function writeRuntimeTextFile(file, text, type='text'){ return writeTextRuntimeFile(file, text, type); }
function copyRuntimeDocument(src, dst, fallback){
  const value = readJsonSafe(src, undefined);
  if(value !== undefined){ atomicWriteJson(dst, value); return true; }
  if(fallback !== undefined){ atomicWriteJson(dst, fallback); return true; }
  return false;
}
function copyRuntimeFile(src, dst){
  const txt = readTextRuntimeFile(src, null);
  if(txt === null || txt === undefined) return false;
  writeTextRuntimeFile(dst, txt, path.extname(dst).slice(1) || 'text');
  return true;
}

function clearRuntimeStoragePrefix(prefix){
  const clean = String(prefix || '').replace(/\\/g,'/').replace(/^\/+/, '').replace(/\.\./g, '_');
  if(!clean) return false;
  try{
    if(allhaDb.clearProjectDocuments) allhaDb.clearProjectDocuments(clean.endsWith('/') ? clean : clean + '/');
    writeDebugLog('runtime-cleanup', 'cleared runtime storage prefix', {prefix:clean});
    return true;
  }catch(e){
    writeDebugLog('runtime-cleanup', 'failed to clear runtime storage prefix', {prefix:clean, error:e.message});
    return false;
  }
}
function clearProfileRuntimeStorage(profileId){
  const pid = sanitizeProfileId(profileId);
  if(!pid) return false;
  clearRuntimeStoragePrefix(`profiles/${pid}/`);
  try{ if(allhaDb.clearStandardSensorBindings) allhaDb.clearStandardSensorBindings(pid); }catch(e){ writeDebugLog('runtime-cleanup','failed to clear profile standard sensors',{profileId:pid,error:e.message}); }
  return true;
}
function clearLevelRuntimeStorage(profileId, levelId){
  const pid = sanitizeProfileId(profileId);
  const lid = sanitizeLevelId(levelId);
  if(!pid || !lid) return false;
  clearRuntimeStoragePrefix(`profiles/${pid}/levels/${lid}/`);
  try{ if(allhaDb.clearStandardSensorBindings) allhaDb.clearStandardSensorBindings(pid, lid); }catch(e){ writeDebugLog('runtime-cleanup','failed to clear level standard sensors',{profileId:pid,levelId:lid,error:e.message}); }
  return true;
}
function importRuntimeMirrorToDb(file){
  try{
    if(!file || !fs.existsSync(file)) return false;
    const docKey = projectDocKeyForFile(file);
    if(docKey && allhaDb.hasDb && allhaDb.hasDb()){
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      allhaDb.setProjectDocument(docKey, parsed, 'json-imported-copy');
      return true;
    }
    const fileKey = projectFileKeyForFile(file);
    if(fileKey && allhaDb.hasDb && allhaDb.hasDb()){
      const txt = fs.readFileSync(file, 'utf8');
      allhaDb.setProjectFile(fileKey, txt, path.extname(file).slice(1) || 'text');
      return true;
    }
  }catch(e){ console.warn('[ALLHA-2D] import mirror to DB failed:', file, e.message); }
  return false;
}
function mergeStandardSensorsMaps(primary, secondary){
  const out = isPlainObject(primary) ? JSON.parse(JSON.stringify(primary)) : {};
  const src = isPlainObject(secondary) ? secondary : {};
  out.rooms = isPlainObject(out.rooms) ? out.rooms : {};
  const srcRooms = isPlainObject(src.rooms) ? src.rooms : {};
  for(const [rid, room] of Object.entries(srcRooms)){
    const oldSensors = normalizeStandardSensors(room?.standardSensors || {});
    if(!Object.keys(oldSensors).length) continue;
    out.rooms[rid] = isPlainObject(out.rooms[rid]) ? out.rooms[rid] : { ...(isPlainObject(room) ? room : {}) };
    const currentSensors = normalizeStandardSensors(out.rooms[rid]?.standardSensors || {});
    out.rooms[rid].standardSensors = { ...oldSensors, ...currentSensors };
  }
  return out;
}

function profileLevelFromRoomsPath(roomsPath){
  try{
    const rel = path.relative(path.resolve(PROFILES_DIR), path.resolve(roomsPath || ROOMS_SETTINGS_PATH)).replace(/\\/g,'/');
    const parts = rel.split('/').filter(Boolean);
    const profileId = sanitizeProfileId(parts[0] || ACTIVE_PROFILE_ID) || ACTIVE_PROFILE_ID;
    const levelIdx = parts.indexOf('levels');
    const levelId = sanitizeLevelId(levelIdx >= 0 ? parts[levelIdx + 1] : ACTIVE_LEVEL_ID) || ACTIVE_LEVEL_ID;
    return { profileId, levelId };
  }catch(e){
    return { profileId: ACTIVE_PROFILE_ID, levelId: ACTIVE_LEVEL_ID };
  }
}
function applyDbStandardSensorBindings(settings, roomsPath = ROOMS_SETTINGS_PATH){
  const next = normalizeRoomsSettings(settings || defaultRoomsSettings());
  try{
    if(!allhaDb.hasDb || !allhaDb.hasDb()) return next;
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    const bindings = allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {};
    for(const [rid, sensors] of Object.entries(bindings)){
      const clean = normalizeStandardSensors(sensors || {}, {strict:false});
      if(!Object.keys(clean).length) continue;
      if(!next.rooms[rid]) next.rooms[rid] = { alias:friendlyRoomLabel(rid), source:'standard-sensor-bindings' };
      next.rooms[rid].standardSensors = clean;
    }
  }catch(e){ console.warn('[standardSensors] DB overlay failed:', e.message); }
  return next;
}


function canonicalStandardSensorsForCompare(src){
  const clean = normalizeStandardSensors(src || {}, {strict:false});
  const out = {};
  for(const key of STANDARD_SENSOR_KEYS){
    if(clean[key]) out[key] = clean[key];
  }
  return out;
}
function sameStandardSensors(a,b){
  return JSON.stringify(canonicalStandardSensorsForCompare(a)) === JSON.stringify(canonicalStandardSensorsForCompare(b));
}

function standardSensorBindingsForRoomsPath(roomsPath = ROOMS_SETTINGS_PATH){
  try{
    if(!allhaDb.hasDb || !allhaDb.hasDb()) return {};
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    return allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {};
  }catch(e){ console.warn('[standardSensors] DB bindings read failed:', e.message); return {}; }
}
function overlayExplicitStandardSensorBindings(settings, bindings){
  const next = normalizeRoomsSettings(settings || defaultRoomsSettings(), {filterUnknownRooms:false});
  const src = isPlainObject(bindings) ? bindings : {};
  for(const [rid, sensors] of Object.entries(src)){
    const clean = normalizeStandardSensors(sensors || {});
    if(!Object.keys(clean).length) continue;
    if(!next.rooms[rid]) next.rooms[rid] = { alias:friendlyRoomLabel(rid), source:'standard-sensor-bindings' };
    const current = normalizeStandardSensors(next.rooms[rid]?.standardSensors || {});
    next.rooms[rid].standardSensors = { ...current, ...clean };
  }
  return next;
}
function roomsApiPayloadForRequest(req){
  const lp = clientLevelPaths(req);
  logDebug('rooms', 'api rooms payload requested', {roomsPath:lp.rooms, devicesPath:lp.devicesJs});
  const settings = loadRoomsSettings(lp.rooms);
  const bindings = standardSensorBindingsForRoomsPath(lp.rooms);
  const hydrated = overlayExplicitStandardSensorBindings(settings, bindings);
  return { ok:true, ...hydrated, standardSensorBindings:bindings, knownRooms: roomSourcesForApi({ roomsPath: lp.rooms, devicesPath: lp.devicesJs }) };
}

const _standardSensorLegacySeedAttempts = new Set();
function seedDbStandardSensorsIfEmpty(settings, roomsPath = ROOMS_SETTINGS_PATH){
  try{
    if(!allhaDb.hasDb || !allhaDb.hasDb()) return false;
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    const seedKey = `${profileId}/${levelId}`;
    const currentDb = allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {};
    if(Object.keys(currentDb).length) return false;
    if(_standardSensorLegacySeedAttempts.has(seedKey)) return false;
    _standardSensorLegacySeedAttempts.add(seedKey);
    // One-time migration only. Runtime source remains SQLite standard_sensor_bindings.
    const mirror = readJsonFileOnly(roomsPath, null);
    const dedicatedBackup = readStandardSensorsBackup(roomsPath);
    const scannedBackups = scanStandardSensorBackups(roomsPath);
    let seed = mergeStandardSensorsMaps(settings || defaultRoomsSettings(), mirror);
    seed = mergeStandardSensorsMaps(seed, dedicatedBackup);
    seed = mergeStandardSensorsMaps(seed, scannedBackups);
    seed = normalizeRoomsSettings(seed, {filterUnknownRooms:false});
    const hasAny = Object.values(seed.rooms || {}).some(r => Object.keys(normalizeStandardSensors(r?.standardSensors || {})).length);
    if(!hasAny) return false;
    runtimeAudit.legacyStandardSensorsMigrationReads += 1;
    allhaDb.syncStandardSensorBindingsFromRooms(profileId, levelId, seed);
    return true;
  }catch(e){ console.warn('[standardSensors] DB seed failed:', e.message); return false; }
}
function syncRoomSettingsAndStandardSensorDb(settings, roomsPath = ROOMS_SETTINGS_PATH){
  const normalized = normalizeRoomsSettings(settings || defaultRoomsSettings());
  try{
    if(allhaDb.hasDb && allhaDb.hasDb()){
      const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
      allhaDb.syncStandardSensorBindingsFromRooms(profileId, levelId, normalized);
    }
  }catch(e){ console.warn('[standardSensors] DB sync failed:', e.message); }
  return applyDbStandardSensorBindings(normalized, roomsPath);
}

function standardSensorsBackupPathForRooms(roomsPath){
  try{ return path.join(path.dirname(roomsPath || ROOMS_SETTINGS_PATH), 'standard_sensors_bindings.json'); }
  catch(e){ return path.join(ACTIVE_LEVEL_DIR, 'standard_sensors_bindings.json'); }
}
function extractStandardSensorBindings(settings){
  const out = { version:1, rooms:{}, updatedAt:new Date().toISOString(), source:'standard-sensors-backup' };
  const rooms = isPlainObject(settings?.rooms) ? settings.rooms : {};
  for(const [rid, room] of Object.entries(rooms)){
    const sensors = normalizeStandardSensors(room?.standardSensors || {});
    if(Object.keys(sensors).length) out.rooms[rid] = { standardSensors:sensors };
  }
  return out;
}
function readStandardSensorsBackup(roomsPath = ROOMS_SETTINGS_PATH){
  const file = standardSensorsBackupPathForRooms(roomsPath);
  const backup = readJsonFileOnly(file, null);
  return isPlainObject(backup) ? backup : { version:1, rooms:{} };
}
function writeStandardSensorsBackup(settings, roomsPath = ROOMS_SETTINGS_PATH){
  // Deprecated in DB-primary mode. Kept as a no-op compatibility stub; runtime writes only to SQLite.
  return extractStandardSensorBindings(settings);
}
function scanStandardSensorBackups(roomsPath = ROOMS_SETTINGS_PATH){
  const out = { version:1, rooms:{} };
  const wantedBase = path.basename(roomsPath || 'rooms.json');
  const candidates = [standardSensorsBackupPathForRooms(roomsPath)];
  const dirs = [path.join(DATA_DIR, 'migration-backups'), path.join(DATA_DIR, 'backups')];
  for(const dir of dirs){
    try{
      if(!fs.existsSync(dir)) continue;
      for(const name of fs.readdirSync(dir).slice(-200)){
        const f = path.join(dir, name);
        if(!/\.json$/i.test(name) && !name.includes(wantedBase) && !name.includes('standard_sensors')) continue;
        candidates.push(f);
      }
    }catch(e){}
  }
  for(const f of candidates){
    try{
      if(!fs.existsSync(f)) continue;
      runtimeAudit.legacyStandardSensorsMigrationReads += 1;
      const parsed = JSON.parse(fs.readFileSync(f,'utf8'));
      const merged = mergeStandardSensorsMaps(out, parsed);
      out.rooms = merged.rooms || out.rooms;
    }catch(e){}
  }
  return out;
}

/* ── Mobile access helpers ───────────────────────────── */
const LOCAL_IP_RE = /^(127\.|::1$|::ffff:(127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
function isLocalIp(req) {
  // local-dev Docker: browser requests often come from docker bridge / host-gateway.
  // Treat the local dev runtime as local management context so pairing-code
  // creation works from http://localhost:8099 and Windows LAN browser.
  if (process.env.ALLHA_MODE === 'local-dev') return true;
  const ip = req.socket?.remoteAddress || req.ip || '';
  return LOCAL_IP_RE.test(ip);
}

function isMobilePortRequest(req) {
  return req.socket?.localPort === MOBILE_PORT;
}
function allowMobileManagement(req) {
  // Main HA/ingress/LAN UI may manage paired devices. The protected mobile port
  // must not expose management endpoints unless the request is local.
  return !isMobilePortRequest(req) || isLocalIp(req);
}

function mobileAccessEnabled() {
  try { return !!loadMobileAccessConfig().enabled; } catch { return false; }
}
function parseCookies(req){
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function mobileLockHtml(){
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ALLHA-2D Mobile</title><style>
  body{margin:0;min-height:100vh;background:#0e1013;color:#e8edf4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .card{max-width:560px;background:#151922;border:1px solid #283142;border-radius:24px;padding:28px;box-shadow:0 18px 60px rgba(0,0,0,.35);text-align:center}.logo{font-size:48px}.muted{color:#8f9bad;line-height:1.5}.code{font-family:ui-monospace,monospace;background:#0b0e13;border-radius:12px;padding:10px 12px;color:#f0b34b;display:inline-block;margin-top:10px}.actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}.btn{display:inline-block;text-decoration:none;border:1px solid #334055;background:#202838;color:#e8edf4;border-radius:12px;padding:12px 16px;font-weight:800}.btn.primary{background:#f0b34b;color:#160d00;border-color:#f0b34b}
  </style></head><body><div class="card"><div class="logo">⌂</div><h1>ALLHA-2D Mobile Access</h1><p class="muted">Этот порт предназначен для мобильного приложения. Откройте приложение ALLHA-2D и выполните привязку через код из Home Assistant → ALLHA-2D → Настройки → Мобильный доступ.</p><div class="code">Без токена основной интерфейс не открывается</div><div class="actions"><a class="btn primary" href="https://localhost/?reset=1">Открыть вход в приложении</a><a class="btn" href="http://localhost/?reset=1">Сбросить вход</a></div><p class="muted" style="font-size:12px;margin-top:14px">Если устройство было отозвано на сервере, нажмите кнопку входа или очистите настройки приложения.</p></div></body></html>`;
}
function mobileAuthFromHeaders(req){
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const deviceId = (req.headers['x-device-id'] || '').trim();
  const ok = mobileAuth.validateToken(token, deviceId);
  const device = ok ? mobileAuth.getDevice(deviceId) : null;
  return { token, deviceId, ok, device };
}
function isMobileApiRequest(req){
  return !!((req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() && (req.headers['x-device-id'] || '').trim());
}
function effectivePanelModeForRequest(req, security){
  const auth = mobileAuthFromHeaders(req);
  if(auth.ok && auth.device) return auth.device.accessMode || 'control';
  return (security?.panelMode === 'user' ? 'viewer' : (security?.panelMode || 'admin'));
}
function requireMobileAdminForWrite(req, res, next){
  if(!isMobileApiRequest(req)) return next();
  const auth = mobileAuthFromHeaders(req);
  if(!auth.ok) return res.status(401).json({ error:'Токен устройства отозван или недействителен' });
  if((auth.device?.accessMode || 'control') !== 'admin') return res.status(403).json({ error:'Мобильное устройство не имеет admin-доступа' });
  return next();
}
function buildHashFromQuery(q){
  const hp = new URLSearchParams();
  if(q._mt) hp.set('_mt', String(q._mt));
  if(q._did) hp.set('_did', String(q._did));
  if(q._local) hp.set('_local', String(q._local));
  if(q._remote) hp.set('_remote', String(q._remote));
  return hp.toString();
}
// Middleware: port 32457 = protected mobile web entry. Browser without token sees only lock page.
app.use((req, res, next) => {
  const onMobilePort = req.socket?.localPort === MOBILE_PORT;
  if (onMobilePort) {
    if (MOBILE_OPEN_PATHS.has(req.path)) return next();

    const fromHeader = mobileAuthFromHeaders(req);
    if (fromHeader.ok) return next();

    const qToken = String(req.query?._mt || '').trim();
    const qDevice = String(req.query?._did || '').trim();
    if (qToken && qDevice && mobileAuth.validateToken(qToken, qDevice)) {
      const session = mobileAuth.createWebSession(qDevice, qToken);
      if (session) {
        res.setHeader('Set-Cookie', `${MOBILE_WEB_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        const hash = buildHashFromQuery(req.query);
        return res.redirect(302, `${req.path || '/'}${hash ? '#' + hash : ''}`);
      }
    }

    const cookies = parseCookies(req);
    if (mobileAuth.validateWebSession(cookies[MOBILE_WEB_COOKIE])) return next();

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Требуется авторизация мобильного устройства' });
    }
    res.status(401).type('html').send(mobileLockHtml());
    return;
  }

  // Main port: normal Home Assistant/ LAN UI. Do not block it because mobile access is enabled.
  next();
});

// Mobile devices must not bypass their per-device access mode. Viewer/control devices may read,
// and control devices may call safe services through /api/ha/service, but admin-only writes stay blocked.
const MOBILE_ADMIN_WRITE_PREFIXES = [
  '/api/config','/api/config/clear','/api/source-config','/api/layout','/api/factory-reset',
  '/api/profiles','/api/levels','/api/images','/api/rooms','/api/backups','/api/security',
  '/api/mobile/devices','/api/mobile/code','/api/ha/lovelace','/api/import'
];
app.use((req, res, next) => {
  if(req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if(!isMobileApiRequest(req)) return next();
  if(MOBILE_ADMIN_WRITE_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) return requireMobileAdminForWrite(req, res, next);
  return next();
});


function isHomeAssistantAddonMode(){
  return String(process.env.ALLHA_MODE || process.env.ALLHA_RUNTIME_MODE || '').toLowerCase() !== 'local-dev';
}
function isIngressRequest(req){
  return !!normalizeIngressProxyPath(req?.headers?.['x-ingress-path'] || '')
    || !!normalizeIngressProxyPath(req?.headers?.['x-forwarded-prefix'] || '')
    || !!normalizeIngressProxyPath(req?.headers?.['x-forwarded-uri'] || '')
    || !!normalizeIngressProxyPath(req?.headers?.['x-original-uri'] || '')
    || !!normalizeIngressProxyPath(req?.headers?.referer || '')
    || /^\/api\/hassio_ingress\//.test(String(req?.originalUrl || req?.url || ''));
}

function requestHostname(req){
  const raw = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if(!raw) return '';
  try{ return new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw).hostname; }catch(e){ return raw.replace(/:\d+$/, ''); }
}
function directLocalDashboardInfo(req){
  const host = requestHostname(req);
  const candidates = [];
  if(host && !/ui\.nabu\.casa$/i.test(host)){
    candidates.push({ label:'Direct local dashboard', url:`http://${host}:${DIRECT_DASHBOARD_PORT}/`, status:'lan-only' });
  }
  candidates.push({ label:'Direct local dashboard template', url:`http://IP_HOME_ASSISTANT:${DIRECT_DASHBOARD_PORT}/`, status:'replace-ip' });
  return {
    enabled:true,
    port:DIRECT_DASHBOARD_PORT,
    url:candidates[0]?.url || `http://IP_HOME_ASSISTANT:${DIRECT_DASHBOARD_PORT}/`,
    candidates,
    hint:'Локальный direct-доступ работает по LAN через проброшенный порт add-on. Не открывайте этот порт на роутере. Для удалённой стартовой панели используйте ingress-aware Lovelace card, а для локального киоска — Direct local dashboard.'
  };
}

function normalizeIngressProxyPath(value){
  const raw = String(value || '').trim();
  if(!raw) return '';
  let pathOnly = raw;
  try{
    if(/^https?:\/\//i.test(raw)) pathOnly = new URL(raw).pathname;
  }catch(e){ pathOnly = raw; }
  if(!pathOnly.startsWith('/')) pathOnly = '/' + pathOnly;
  const m = pathOnly.match(/^(\/api\/hassio_ingress\/[^/?#]+)\/?/);
  if(m) return m[1] + '/';
  return '';
}
function dashboardUrlCandidates(basePath){
  const clean = normalizeIngressProxyPath(basePath);
  const out = [];
  if(clean){
    out.push({ label:'Ingress proxy', url:clean, status:'try-first' });
    out.push({ label:'Ingress proxy + dashboard flag', url:clean + '?allha_dashboard=1', status:'try-if-503' });
  }
  out.push({ label:'Direct route for external reverse proxy', url:'/allha-2d-direct/', status:'requires-explicit-proxy' });
  return out;
}
function getDashboardProxyFromRequest(req){
  const candidates = [
    req.headers['x-ingress-path'],
    req.headers['x-forwarded-prefix'],
    req.headers['x-forwarded-uri'],
    req.headers['x-original-uri'],
    req.headers['referer']
  ];
  for(const c of candidates){
    const p = normalizeIngressProxyPath(c);
    if(p) return { dashboardUrl: p, source: 'home-assistant-ingress-header', candidates: dashboardUrlCandidates(p) };
  }
  return { dashboardUrl: '', source: 'not-detected', candidates: dashboardUrlCandidates('') };
}
function loadDashboardProxyState(){
  const fallback = {
    version: 2,
    dashboardUrl: '',
    source: 'not-detected',
    updatedAt: null,
    candidates: dashboardUrlCandidates(''),
    hint: 'Откройте add-on через штатный ingress/боковое меню Home Assistant, затем обновите диагностику. Если /api/hassio_ingress/... даёт 503 в Webpage dashboard, этот путь нельзя считать стабильным для вашей установки; используйте внешний reverse proxy к /allha-2d-direct/ или штатную боковую панель add-on.'
  };
  const saved = readJsonSafe(DASHBOARD_PROXY_STATE_PATH, fallback);
  const url = normalizeIngressProxyPath(saved.dashboardUrl || '');
  return { ...fallback, ...saved, version:2, dashboardUrl:url, candidates: dashboardUrlCandidates(url) };
}
function saveDashboardProxyState(info){
  if(!info || !info.dashboardUrl) return loadDashboardProxyState();
  const clean = normalizeIngressProxyPath(info.dashboardUrl);
  const payload = {
    version: 2,
    dashboardUrl: clean,
    source: info.source || 'home-assistant-ingress-header',
    updatedAt: new Date().toISOString(),
    candidates: dashboardUrlCandidates(clean),
    hint: 'Скопируйте Ingress proxy в Dashboard → Webpage. Если Home Assistant возвращает 503, значит этот ingress-token не работает как стабильный Webpage URL в вашей установке; нужен внешний proxy-route на /allha-2d-direct/ или штатный ingress add-on.'
  };
  try{ atomicWriteJson(DASHBOARD_PROXY_STATE_PATH, payload); }catch(e){}
  return payload;
}
function dashboardProxyInfo(req){
  const fromReq = req ? getDashboardProxyFromRequest(req) : { dashboardUrl: '', source: 'not-detected' };
  if(fromReq.dashboardUrl) return saveDashboardProxyState(fromReq);
  return loadDashboardProxyState();
}



function attentionDefault(){
  return { version: 1, rules: [] };
}
function normalizeAttentionRules(payload){
  const src = payload && typeof payload === 'object' ? payload : attentionDefault();
  const seen = new Set();
  const rules = Array.isArray(src.rules) ? src.rules : [];
  const normalized = [];
  for(const raw of rules){
    if(!raw || typeof raw !== 'object') continue;
    const entity_id = String(raw.entity_id || '').trim();
    if(!entity_id || seen.has(entity_id)) continue;
    seen.add(entity_id);
    normalized.push({
      entity_id,
      name: String(raw.name || entity_id),
      normal_state: String(raw.normal_state ?? 'unknown'),
      enabled: raw.enabled !== false,
      created_at: raw.created_at || null,
      updated_at: raw.updated_at || null
    });
  }
  return { version: Number(src.version) || 1, rules: normalized };
}
function loadAttentionRules(){
  return normalizeAttentionRules(readJsonSafe(ATTENTION_RULES_PATH, attentionDefault()));
}
function saveAttentionRules(payload){
  const normalized = normalizeAttentionRules(payload);
  atomicWriteJson(ATTENTION_RULES_PATH, normalized);
  return normalized;
}
function evaluateAttentionRules(payload, states){
  const rulesData = normalizeAttentionRules(payload);
  const byEntity = new Map();
  if(Array.isArray(states)){
    for(const st of states){
      if(st && st.entity_id) byEntity.set(String(st.entity_id), st);
    }
  }
  const evaluated = rulesData.rules.map(rule => {
    const st = byEntity.get(rule.entity_id);
    const current_state = st ? String(st.state) : 'unknown';
    const alert = rule.enabled !== false && current_state !== String(rule.normal_state);
    return {
      ...rule,
      current_state,
      alert,
      last_changed: st?.last_changed || null,
      last_updated: st?.last_updated || null,
      friendly_name: st?.attributes?.friendly_name || rule.name || rule.entity_id
    };
  });
  return {
    ok: true,
    version: rulesData.version,
    hasAlerts: evaluated.some(r => r.alert),
    alertCount: evaluated.filter(r => r.alert).length,
    rules: evaluated
  };
}


function defaultProfilesMeta(){
  return { version: 1, activeProfileId: 'profile-1', profiles: [ { id:'profile-1', name:'Основной', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() } ] };
}
function sanitizeProfileId(id){
  return String(id||'profile-1').replace(/[^a-z0-9_-]/gi,'-').toLowerCase() || 'profile-1';
}
function normalizeProfilesMeta(raw){
  const def = defaultProfilesMeta();
  const list = Array.isArray(raw?.profiles) ? raw.profiles : def.profiles;
  const seen = new Set();
  const profiles = [];
  for(const p of list){
    if(!p || typeof p !== 'object') continue;
    const id = sanitizeProfileId(p.id);
    if(!id || seen.has(id)) continue;
    seen.add(id);
    profiles.push({
      id,
      name: String(p.name || (id === 'profile-1' ? 'Основной' : id)),
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || null
    });
    if(profiles.length >= 10) break;
  }
  if(!profiles.length) profiles.push(def.profiles[0]);
  const active = sanitizeProfileId(raw?.activeProfileId || profiles[0].id);
  const activeProfileId = profiles.some(p=>p.id===active) ? active : profiles[0].id;
  return { version: Number(raw?.version)||1, activeProfileId, profiles };
}
function loadProfilesMeta(){
  return normalizeProfilesMeta(readJsonSafe(PROFILES_META_PATH, defaultProfilesMeta()));
}
function saveProfilesMeta(meta){
  const normalized = normalizeProfilesMeta(meta);
  atomicWriteJson(PROFILES_META_PATH, normalized);
  return normalized;
}
function updateActiveProfilePaths(){
  const meta = loadProfilesMeta();
  ACTIVE_PROFILE_ID = meta.activeProfileId || 'profile-1';
  ACTIVE_PROFILE_DIR = path.join(PROFILES_DIR, ACTIVE_PROFILE_ID);
  const levels = initializeLevelsStorage(ACTIVE_PROFILE_ID);
  ACTIVE_LEVEL_ID = levels.activeLevelId || 'level-1';
  const lp = ensureLevelDirs(ACTIVE_PROFILE_ID, ACTIVE_LEVEL_ID);
  ACTIVE_LEVEL_DIR = lp.dir;
  LAYOUT_PATH = lp.layout;
  SOURCE_CONFIG_PATH = lp.sourceConfig;
  UI_STATE_PATH = lp.uiState;
  DATA_IMAGES_DIR = lp.images;
  DATA_IMAGES_OVERVIEW_DIR = path.join(DATA_IMAGES_DIR, 'overview');
  DATA_IMAGES_ROOMS_DIR = path.join(DATA_IMAGES_DIR, 'rooms');
  DATA_IMAGES_ORIGINALS_DIR = path.join(DATA_IMAGES_DIR, 'originals');
  DATA_IMAGES_ORIGINALS_ROOMS_DIR = path.join(DATA_IMAGES_ORIGINALS_DIR, 'rooms');
  IMAGES_META_PATH = path.join(DATA_IMAGES_DIR, 'images_meta.json');
  ROOMS_SETTINGS_PATH = lp.rooms;
  DEVICES_PATH = lp.devicesJs;
  LOVELACE_PATH = lp.lovelaceJs;
  return { meta, levels, paths: lp };
}
function profilePaths(id){
  const profileId = sanitizeProfileId(id);
  const dir = path.join(PROFILES_DIR, profileId);
  const images = path.join(dir, 'images');
  return {
    id: profileId,
    dir,
    layout: path.join(dir, 'layout.json'),
    rooms: path.join(dir, 'rooms.json'),
    sourceConfig: path.join(dir, 'source_config.json'),
    uiState: path.join(dir, 'ui_state.json'),
    images,
    imagesMeta: path.join(images, 'images_meta.json'),
    devicesJs: path.join(dir, 'devices.js'),
    devicesJson: path.join(dir, 'devices.json'),
    lovelaceJs: path.join(dir, 'lovelace-source.js'),
    lovelaceRaw: path.join(dir, 'lovelace_raw.json'),
    deviceParseReportJson: path.join(dir, 'device_parse_report.json'),
    deviceParseReportMd: path.join(dir, 'device_parse_report.md')
  };
}

function sanitizeLevelId(id){
  return String(id||'level-1').replace(/[^a-z0-9_-]/gi,'-').toLowerCase() || 'level-1';
}
function levelsMetaPath(profileId){ return path.join(profilePaths(profileId).dir, 'levels.json'); }
function defaultLevelsMeta(){
  return { version: 1, activeLevelId: 'level-1', levels: [ { id:'level-1', name:'Основной уровень', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() } ] };
}
function normalizeLevelsMeta(raw){
  const def = defaultLevelsMeta();
  const list = Array.isArray(raw?.levels) ? raw.levels : def.levels;
  const seen = new Set();
  const levels = [];
  for(const l of list){
    if(!l || typeof l !== 'object') continue;
    const id = sanitizeLevelId(l.id);
    if(!id || seen.has(id)) continue;
    seen.add(id);
    levels.push({
      id,
      name: String(l.name || (id === 'level-1' ? 'Основной уровень' : id)).slice(0,80),
      createdAt: l.createdAt || new Date().toISOString(),
      updatedAt: l.updatedAt || null
    });
    if(levels.length >= 12) break;
  }
  if(!levels.length) levels.push(def.levels[0]);
  const active = sanitizeLevelId(raw?.activeLevelId || levels[0].id);
  const activeLevelId = levels.some(l=>l.id===active) ? active : levels[0].id;
  return { version: Number(raw?.version)||1, activeLevelId, levels };
}
function loadLevelsMeta(profileId=ACTIVE_PROFILE_ID){
  return normalizeLevelsMeta(readJsonSafe(levelsMetaPath(profileId), defaultLevelsMeta()));
}
function saveLevelsMeta(profileId, meta){
  const normalized = normalizeLevelsMeta(meta);
  atomicWriteJson(levelsMetaPath(profileId), normalized);
  return normalized;
}
function levelPaths(profileId, levelId){
  const profile = profilePaths(profileId);
  const lid = sanitizeLevelId(levelId);
  const dir = path.join(profile.dir, 'levels', lid);
  const images = path.join(dir, 'images');
  return {
    profileId: profile.id,
    id: lid,
    dir,
    layout: path.join(dir, 'layout.json'),
    rooms: path.join(dir, 'rooms.json'),
    sourceConfig: path.join(dir, 'source_config.json'),
    uiState: path.join(dir, 'ui_state.json'),
    images,
    imagesMeta: path.join(images, 'images_meta.json'),
    devicesJs: path.join(dir, 'devices.js'),
    devicesJson: path.join(dir, 'devices.json'),
    lovelaceJs: path.join(dir, 'lovelace-source.js'),
    lovelaceRaw: path.join(dir, 'lovelace_raw.json'),
    deviceParseReportJson: path.join(dir, 'device_parse_report.json'),
    deviceParseReportMd: path.join(dir, 'device_parse_report.md')
  };
}
function ensureLevelDirs(profileId, levelId){
  const lp = levelPaths(profileId, levelId);
  fs.mkdirSync(lp.dir, {recursive:true});
  fs.mkdirSync(lp.images, {recursive:true});
  fs.mkdirSync(path.join(lp.images,'overview'), {recursive:true});
  fs.mkdirSync(path.join(lp.images,'rooms'), {recursive:true});
  fs.mkdirSync(path.join(lp.images,'originals'), {recursive:true});
  fs.mkdirSync(path.join(lp.images,'originals','rooms'), {recursive:true});
  return lp;
}
function initializeLevelsStorage(profileId){
  const pp = ensureProfileDirs(profileId);
  let meta = runtimeDocumentExists(levelsMetaPath(profileId)) ? loadLevelsMeta(profileId) : defaultLevelsMeta();
  if(!runtimeDocumentExists(levelsMetaPath(profileId))) atomicWriteJson(levelsMetaPath(profileId), meta);
  for(const l of meta.levels) ensureLevelDirs(profileId, l.id);
  const l1 = ensureLevelDirs(profileId, 'level-1');
  // Миграция v3.5.7: данные лежали прямо в profile-N/. Переносим их в первый уровень.
  copyIfExists(pp.layout, l1.layout);
  copyIfExists(pp.rooms, l1.rooms);
  copyIfExists(pp.sourceConfig, l1.sourceConfig);
  copyIfExists(pp.uiState, l1.uiState);
  copyIfExists(pp.images, l1.images);
  copyIfExists(pp.devicesJs, l1.devicesJs);
  copyIfExists(pp.devicesJson, l1.devicesJson);
  copyIfExists(pp.lovelaceJs, l1.lovelaceJs);
  copyIfExists(pp.lovelaceRaw, l1.lovelaceRaw);
  copyIfExists(pp.deviceParseReportJson, l1.deviceParseReportJson);
  return loadLevelsMeta(profileId);
}
function activeLevelPaths(){ return levelPaths(ACTIVE_PROFILE_ID, ACTIVE_LEVEL_ID); }
function ensureProfileDirs(id){
  const pp = profilePaths(id);
  fs.mkdirSync(pp.dir, {recursive:true});
  fs.mkdirSync(pp.images, {recursive:true});
  fs.mkdirSync(path.join(pp.images,'overview'), {recursive:true});
  fs.mkdirSync(path.join(pp.images,'rooms'), {recursive:true});
  fs.mkdirSync(path.join(pp.images,'originals'), {recursive:true});
  fs.mkdirSync(path.join(pp.images,'originals','rooms'), {recursive:true});
  return pp;
}
function assignedArrayCount(file, name){
  try{ return parseJsAssignedArray(file, name).length; }catch(e){ return 0; }
}
function jsonArrayCount(file){
  try{ const v=readJsonSafe(file, []); return Array.isArray(v) ? v.length : 0; }catch(e){ return 0; }
}
function shouldReplaceEmptyMigratedFile(src, dst){
  try{
    if(!(runtimeDocumentExists(src) || runtimeFileExists(src) || fs.existsSync(src))) return false;
    if(!(runtimeDocumentExists(dst) || runtimeFileExists(dst) || fs.existsSync(dst))) return false;
    if(path.basename(src)==='devices.js' && path.basename(dst)==='devices.js'){
      return assignedArrayCount(src, 'ALL_DEVICES') > 0 && assignedArrayCount(dst, 'ALL_DEVICES') === 0;
    }
    if(path.basename(src)==='devices.json' && path.basename(dst)==='devices.json'){
      return jsonArrayCount(src) > 0 && jsonArrayCount(dst) === 0;
    }
    if(path.basename(src)==='lovelace-source.js' && path.basename(dst)==='lovelace-source.js'){
      const srcTxt=readTextRuntimeFile(src,''); const dstTxt=readTextRuntimeFile(dst,'');
      return /views\s*"?\s*:\s*\[\s*\{/.test(srcTxt) && !/views\s*"?\s*:\s*\[\s*\{/.test(dstTxt);
    }
  }catch(e){ return false; }
  return false;
}
function copyIfExists(src, dst){
  try{
    const sourceExists = runtimeDocumentExists(src) || runtimeFileExists(src) || fs.existsSync(src);
    if(!sourceExists) return;
    const targetExists = runtimeDocumentExists(dst) || runtimeFileExists(dst) || fs.existsSync(dst);
    if(targetExists && !shouldReplaceEmptyMigratedFile(src, dst)) return;
    if(projectDocKeyForFile(src) || projectDocKeyForFile(dst)) return copyRuntimeDocument(src, dst);
    if(projectFileKeyForFile(src) || projectFileKeyForFile(dst)) return copyRuntimeFile(src, dst);
    return copyPathRecursive(src, dst);
  }catch(e){ console.warn('[ALLHA-2D] profile migration copy failed:', src, e.message); }
}
function initializeProfilesStorage(){
  fs.mkdirSync(DATA_DIR, {recursive:true});
  fs.mkdirSync(PROFILES_DIR, {recursive:true});
  let meta = runtimeDocumentExists(PROFILES_META_PATH) ? loadProfilesMeta() : defaultProfilesMeta();
  if(!runtimeDocumentExists(PROFILES_META_PATH)) atomicWriteJson(PROFILES_META_PATH, meta);
  for(const p of meta.profiles){ ensureProfileDirs(p.id); initializeLevelsStorage(p.id); }
  const p1 = profilePaths('profile-1');
  ensureProfileDirs('profile-1');
  copyIfExists(path.join(DATA_DIR,'layout.json'), p1.layout);
  copyIfExists(path.join(DATA_DIR,'rooms.json'), p1.rooms);
  copyIfExists(path.join(DATA_DIR,'source_config.json'), p1.sourceConfig);
  copyIfExists(path.join(DATA_DIR,'ui_state.json'), p1.uiState);
  copyIfExists(path.join(DATA_DIR,'images'), p1.images);
  copyIfExists(path.join(DATA_DIR,'devices.js'), p1.devicesJs);
  copyIfExists(path.join(DATA_DIR,'devices.json'), p1.devicesJson);
  copyIfExists(path.join(DATA_DIR,'lovelace-source.js'), p1.lovelaceJs);
  copyIfExists(path.join(DATA_DIR,'lovelace_raw.json'), p1.lovelaceRaw);
  copyIfExists(path.join(DATA_DIR,'device_parse_report.json'), p1.deviceParseReportJson);
  updateActiveProfilePaths();
  return loadProfilesMeta();
}
function profilesDiagnostics(){
  const meta = loadProfilesMeta();
  return {
    metaPath: PROFILES_META_PATH,
    activeProfileId: meta.activeProfileId,
    count: meta.profiles.length,
    max: 10,
    profiles: meta.profiles.map(p=>({
      ...p,
      dir: profilePaths(p.id).dir,
      active: p.id === meta.activeProfileId,
      exists: fs.existsSync(profilePaths(p.id).dir)
    })),
    activePaths: levelPaths(meta.activeProfileId, loadLevelsMeta(meta.activeProfileId).activeLevelId),
    activeLevelId: loadLevelsMeta(meta.activeProfileId).activeLevelId
  };
}


function safeJsonFileCount(file, kind){
  try{
    const data = readJsonSafe(file, null);
    if(data === null || data === undefined) return 0;
    if(Array.isArray(data)) return data.length;
    if(kind === 'rooms') return Object.keys(data.rooms || {}).length;
    if(kind === 'zones') return Object.keys(data.zones || {}).length;
    return Object.keys(data || {}).length;
  }catch(e){ return 0; }
}
function summarizeLevelStatus(profileId, levelId){
  const lp = levelPaths(profileId, levelId);
  const sc = loadSourceConfigForLevel(profileId, levelId);
  const dashboardPaths = normalizeDashboardPaths(sc.dashboardPaths ?? sc.dashboardPathText ?? '');
  const layout = readJsonSafe(lp.layout, emptyLayout());
  const rooms = readJsonSafe(lp.rooms, defaultRoomsSettings());
  const devicesCount = safeJsonFileCount(lp.devicesJson, 'devices');
  const hasOverviewImage = !!(activeCustomOverviewImagePath && profileId === ACTIVE_PROFILE_ID && levelId === ACTIVE_LEVEL_ID ? fs.existsSync(activeCustomOverviewImagePath()) : fs.existsSync(path.join(lp.images,'overview','overview.webp')) || fs.existsSync(path.join(lp.images,'overview.webp')));
  const roomImageDir = path.join(lp.images, 'rooms');
  let roomImagesCount = 0;
  try{ if(fs.existsSync(roomImageDir)) roomImagesCount = fs.readdirSync(roomImageDir).filter(n=>/\.(webp|png|jpg|jpeg|svg)$/i.test(n)).length; }catch(e){}
  return {
    hasOverviewImage,
    overviewMode: hasOverviewImage ? 'custom' : 'fallback',
    hasSources: dashboardPaths.length > 0,
    sourcesCount: dashboardPaths.length,
    devicesCount,
    roomsCount: Object.keys(rooms.rooms || {}).length,
    zonesCount: Object.keys(layout.zones || {}).length,
    overviewMarkersCount: Object.keys(layout.overviewMarkers || {}).length,
    roomMarkersCount: Object.values(layout.roomMarkers || {}).reduce((sum,v)=>sum+Object.keys(v||{}).length,0),
    roomImagesCount
  };
}

function levelsDiagnostics(profileId=ACTIVE_PROFILE_ID){
  const pid = sanitizeProfileId(profileId);
  const meta = loadLevelsMeta(pid);
  return {
    profileId: pid,
    metaPath: levelsMetaPath(pid),
    activeLevelId: meta.activeLevelId,
    count: meta.levels.length,
    max: 12,
    levels: meta.levels.map(l=>{
      const lp = levelPaths(pid, l.id);
      const sc = loadSourceConfigForLevel(pid, l.id);
      const dashboardPaths = normalizeDashboardPaths(sc.dashboardPaths ?? sc.dashboardPathText ?? '');
      return {
        ...l,
        active: l.id === meta.activeLevelId,
        dir: lp.dir,
        exists: fs.existsSync(lp.dir),
        sourceConfig: { ...sc, dashboardPaths, dashboardPathText: dashboardPaths.join('\n') },
        status: summarizeLevelStatus(pid, l.id)
      };
    }),
    activePaths: levelPaths(pid, meta.activeLevelId)
  };
}
function nextLevelId(profileId){
  const meta = loadLevelsMeta(profileId);
  let n=1, id;
  do { id = 'level-' + (++n); } while(meta.levels.some(l=>l.id===id) && n < 99);
  return id;
}
function createLevel(payload={}){
  const pid = ACTIVE_PROFILE_ID;
  const meta = loadLevelsMeta(pid);
  if(meta.levels.length >= 12) throw new Error('Слишком много уровней/областей');
  const id = nextLevelId(pid);
  const name = String(payload.name || `Уровень ${meta.levels.length + 1}`).trim().slice(0,80) || `Уровень ${meta.levels.length + 1}`;
  clearLevelRuntimeStorage(pid, id);
  const lp = ensureLevelDirs(pid, id);
  const baseLayout = emptyLayout();
  const currentLayout = normalizeLayoutPayload(loadLayout(), {strict:false}).layout;
  if(payload.duplicateZones) baseLayout.zones = currentLayout.zones || {};
  if(payload.duplicateMarkers){
    baseLayout.overviewMarkers = currentLayout.overviewMarkers || {};
    baseLayout.roomMarkers = currentLayout.roomMarkers || {};
    baseLayout.overviewMetrics = currentLayout.overviewMetrics || {};
    baseLayout.roomMetrics = currentLayout.roomMetrics || {};
    baseLayout.customNames = currentLayout.customNames || {};
  }
  atomicWriteJson(lp.layout, baseLayout);
  if(payload.duplicateImages) copyPathRecursive(DATA_IMAGES_DIR, lp.images); else atomicWriteJson(lp.imagesMeta, defaultImagesMeta());
  if(payload.duplicateSources){
    copyIfExists(SOURCE_CONFIG_PATH, lp.sourceConfig);
    copyIfExists(DEVICES_PATH, lp.devicesJs);
    copyIfExists(activeLevelPaths().devicesJson, lp.devicesJson);
    copyIfExists(LOVELACE_PATH, lp.lovelaceJs);
    copyIfExists(activeLevelPaths().lovelaceRaw, lp.lovelaceRaw);
  }
  if(payload.duplicateSources){
    if(!runtimeDocumentExists(lp.rooms)) atomicWriteJson(lp.rooms, defaultRoomsSettings());
  } else {
    atomicWriteJson(lp.rooms, defaultRoomsSettings());
    atomicWriteJson(lp.sourceConfig, defaultSourceConfig());
    writeJsAssignedArray(lp.devicesJs, 'ALL_DEVICES', []);
    atomicWriteJson(lp.devicesJson, []);
    writeTextRuntimeFile(lp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'js');
    atomicWriteJson(lp.lovelaceRaw, { version:1, views:[] });
    atomicWriteJson(lp.deviceParseReportJson, { ok:true, empty:true, reason:'new-level', devices:0, rooms:0, cards:0, generatedAt:new Date().toISOString() });
  }
  atomicWriteJson(lp.uiState, defaultUiState());
  const now = new Date().toISOString();
  meta.levels.push({id, name, createdAt:now, updatedAt:now});
  meta.activeLevelId = id;
  saveLevelsMeta(pid, meta);
  return levelsDiagnostics(pid);
}
function duplicateLevel(levelId, payload={}){
  const pid = ACTIVE_PROFILE_ID;
  const meta = loadLevelsMeta(pid);
  const srcId = sanitizeLevelId(levelId || meta.activeLevelId);
  const srcMeta = meta.levels.find(l=>l.id===srcId);
  if(!srcMeta) throw new Error('Исходный уровень не найден');
  const newId = nextLevelId(pid);
  const src = levelPaths(pid, srcId), dst = levelPaths(pid, newId);
  copyPathRecursive(src.dir, dst.dir);
  const now = new Date().toISOString();
  const name = String(payload.name || `Копия ${srcMeta.name}`).trim().slice(0,80) || `Копия ${srcMeta.name}`;
  meta.levels.push({id:newId, name, createdAt:now, updatedAt:now});
  meta.activeLevelId = newId;
  saveLevelsMeta(pid, meta);
  return levelsDiagnostics(pid);
}
function backupLevelDirectory(profileId, levelId, reason='level-backup'){
  if(!autoBackupsEnabled()) return null;
  const lp = levelPaths(profileId, levelId);
  if(!fs.existsSync(lp.dir)) return null;
  const stamp = timestampForFile();
  const backupDir = path.join(LAYOUT_BACKUP_DIR, 'levels', `${sanitizeProfileId(profileId)}-${sanitizeLevelId(levelId)}-${String(reason).replace(/[^a-z0-9_-]/gi,'-')}-${stamp}`);
  copyPathRecursive(lp.dir, backupDir);
  return backupDir;
}
function activateLevel(levelId){
  const pid = ACTIVE_PROFILE_ID;
  const meta = loadLevelsMeta(pid);
  const id = sanitizeLevelId(levelId);
  if(!meta.levels.some(l=>l.id===id)) throw new Error('Уровень не найден');
  meta.activeLevelId = id;
  for(const l of meta.levels) if(l.id===id) l.updatedAt = new Date().toISOString();
  saveLevelsMeta(pid, meta);
  updateActiveProfilePaths();
  ensureDataStore();
  return levelsDiagnostics(pid);
}
function patchLevel(levelId, payload={}){
  const pid = ACTIVE_PROFILE_ID;
  const meta = loadLevelsMeta(pid);
  const id = sanitizeLevelId(levelId);
  const l = meta.levels.find(x=>x.id===id);
  if(!l) throw new Error('Уровень не найден');
  if(payload.name !== undefined) l.name = String(payload.name || l.name).trim().slice(0,80) || l.name;
  l.updatedAt = new Date().toISOString();
  saveLevelsMeta(pid, meta);
  return levelsDiagnostics(pid);
}
function deleteLevel(levelId){
  const pid = ACTIVE_PROFILE_ID;
  const meta = loadLevelsMeta(pid);
  const id = sanitizeLevelId(levelId);
  if(meta.levels.length <= 1) throw new Error('Нельзя удалить последний уровень');
  const idx = meta.levels.findIndex(l=>l.id===id);
  if(idx < 0) throw new Error('Уровень не найден');
  const backup = backupLevelDirectory(pid, id, 'before-delete');
  meta.levels.splice(idx, 1);
  if(meta.activeLevelId === id) meta.activeLevelId = meta.levels[0].id;
  saveLevelsMeta(pid, meta);
  removePathSafe(levelPaths(pid, id).dir);
  clearLevelRuntimeStorage(pid, id);
  updateActiveProfilePaths();
  ensureDataStore();
  const diag = levelsDiagnostics(pid);
  diag.backup = backup ? path.basename(backup) : null;
  return diag;
}

function createProfile(payload={}){
  const meta = loadProfilesMeta();
  if(meta.profiles.length >= 10) throw new Error('Можно создать максимум 10 профилей');
  let n = 1; let id;
  do { id = 'profile-' + (++n); } while(meta.profiles.some(p=>p.id===id) && n < 20);
  const now = new Date().toISOString();
  const name = String(payload.name || `Профиль ${meta.profiles.length + 1}`).trim().slice(0,60) || `Профиль ${meta.profiles.length + 1}`;
  // A newly created profile must never reuse stale DB mirror data from a previously deleted profile with the same id.
  clearProfileRuntimeStorage(id);
  ensureProfileDirs(id);
  let levelsMeta = defaultLevelsMeta();
  levelsMeta.levels[0].name = 'Основной уровень';
  atomicWriteJson(levelsMetaPath(id), levelsMeta);
  const pp = ensureLevelDirs(id, 'level-1');
  const baseLayout = emptyLayout();
  const duplicateZones = !!payload.duplicateZones;
  const duplicateMarkers = !!payload.duplicateMarkers;
  if(duplicateZones || duplicateMarkers){
    const current = normalizeLayoutPayload(loadLayout(), {strict:false}).layout;
    if(duplicateZones) baseLayout.zones = current.zones || {};
    if(duplicateMarkers){
      baseLayout.overviewMarkers = current.overviewMarkers || {};
      baseLayout.roomMarkers = current.roomMarkers || {};
      baseLayout.overviewMetrics = current.overviewMetrics || {};
      baseLayout.roomMetrics = current.roomMetrics || {};
      baseLayout.customNames = current.customNames || {};
    }
  }
  atomicWriteJson(pp.layout, baseLayout);
  // Always overwrite the new profile runtime bundle with empty defaults unless the user explicitly selected a copy action.
  // This prevents old SQLite mirror documents from reappearing when a deleted profile id is reused.
  atomicWriteJson(pp.rooms, defaultRoomsSettings());
  atomicWriteJson(pp.sourceConfig, defaultSourceConfig());
  atomicWriteJson(pp.uiState, defaultUiState());
  atomicWriteJson(pp.imagesMeta, defaultImagesMeta());
  writeJsAssignedArray(pp.devicesJs, 'ALL_DEVICES', []);
  atomicWriteJson(pp.devicesJson, []);
  writeTextRuntimeFile(pp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'js');
  atomicWriteJson(pp.lovelaceRaw, { version:1, views:[] });
  atomicWriteJson(pp.deviceParseReportJson, { ok:true, empty:true, reason:'new-profile', devices:0, rooms:0, cards:0, generatedAt:new Date().toISOString() });
  meta.profiles.push({id, name, createdAt:now, updatedAt:now});
  meta.activeProfileId = id;
  saveProfilesMeta(meta);
  updateActiveProfilePaths();
  ensureDataStore();
  return profilesDiagnostics();
}
function duplicateProfile(id, payload={}){
  const meta = loadProfilesMeta();
  if(meta.profiles.length >= 10) throw new Error('Можно создать максимум 10 профилей');
  const srcId = sanitizeProfileId(id || meta.activeProfileId);
  const srcMeta = meta.profiles.find(p=>p.id===srcId);
  if(!srcMeta) throw new Error('Исходный профиль не найден');
  let n = 1; let newId;
  do { newId = 'profile-' + (++n); } while(meta.profiles.some(p=>p.id===newId) && n < 20);
  const now = new Date().toISOString();
  const src = profilePaths(srcId); const dst = profilePaths(newId);
  copyPathRecursive(src.dir, dst.dir);
  const name = String(payload.name || `Копия ${srcMeta.name}`).trim().slice(0,60) || `Копия ${srcMeta.name}`;
  meta.profiles.push({id:newId, name, createdAt:now, updatedAt:now});
  saveProfilesMeta(meta);
  return profilesDiagnostics();
}


function profileActiveLevelPath(profileId){
  const pid = sanitizeProfileId(profileId);
  const lm = loadLevelsMeta(pid);
  return levelPaths(pid, lm.activeLevelId || 'level-1');
}
function overviewImageInfoForLevelPath(lp){
  const meta = readJsonSafe(lp.imagesMeta, defaultImagesMeta());
  const fromMeta = meta && meta.overview ? meta.overview : null;
  if(fromMeta && (fromMeta.processedWidth || fromMeta.originalWidth) && (fromMeta.processedHeight || fromMeta.originalHeight)){
    const width = Number(fromMeta.processedWidth || fromMeta.originalWidth) || null;
    const height = Number(fromMeta.processedHeight || fromMeta.originalHeight) || null;
    return { exists:true, width, height, aspectRatio: width && height ? Math.round((width/height)*1000)/1000 : null, source:'images_meta' };
  }
  const candidates=[];
  for(const ext of ['webp','png','jpg','jpeg']){
    candidates.push(path.join(lp.images,'overview',`overview.${ext}`));
    candidates.push(path.join(lp.images,`overview.${ext}`));
  }
  for(const file of candidates){
    if(fs.existsSync(file)){
      const size=getImageSize(file);
      const width=Number(size.width)||null, height=Number(size.height)||null;
      return { exists:true, width, height, aspectRatio: width && height ? Math.round((width/height)*1000)/1000 : null, source:path.basename(file) };
    }
  }
  return { exists:false, width:null, height:null, aspectRatio:null, source:'fallback' };
}
function compareOverviewImagesForCopy(srcLp, dstLp){
  const source = overviewImageInfoForLevelPath(srcLp);
  const target = overviewImageInfoForLevelPath(dstLp);
  const bothHaveImages = !!(source.exists && target.exists);
  const sourceRatio = Number(source.aspectRatio)||0;
  const targetRatio = Number(target.aspectRatio)||0;
  const sizeMismatch = bothHaveImages && (Number(source.width)!==Number(target.width) || Number(source.height)!==Number(target.height));
  const aspectMismatch = bothHaveImages && sourceRatio && targetRatio && Math.abs(sourceRatio-targetRatio) > 0.01;
  return { source, target, bothHaveImages, sizeMismatch, aspectMismatch, mismatch: !!(sizeMismatch || aspectMismatch) };
}
function copyJsonFileWithFallback(src, dst, fallback){
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  return copyRuntimeDocument(src, dst, fallback);
}
function replacePathIfExists(src, dst){
  if(projectDocKeyForFile(src) || projectDocKeyForFile(dst)){ if(runtimeDocumentExists(src)) return copyRuntimeDocument(src, dst); return false; }
  if(projectFileKeyForFile(src) || projectFileKeyForFile(dst)){ if(runtimeFileExists(src)) return copyRuntimeFile(src, dst); return false; }
  if(fs.existsSync(src)){ if(fs.existsSync(dst)) removePathSafe(dst); return copyPathRecursive(src, dst); }
  return false;
}
function copyProfileData(targetProfileId, payload={}, req=null){
  const meta = loadProfilesMeta();
  const targetId = sanitizeProfileId(targetProfileId);
  const sourceId = sanitizeProfileId(payload.sourceProfileId || payload.source || '');
  const kind = String(payload.kind || payload.copyKind || '').trim();
  const allowed = new Set(['zones','sensors','markers','rooms','overview','display','all']);
  if(!allowed.has(kind)) throw new Error('Некорректный тип копирования');
  if(!meta.profiles.some(p=>p.id===targetId)) throw new Error('Профиль назначения не найден');
  if(!meta.profiles.some(p=>p.id===sourceId)) throw new Error('Профиль-источник не найден');
  if(targetId === sourceId) throw new Error('Источник и назначение совпадают');
  ensureProfileDirs(sourceId); ensureProfileDirs(targetId);
  initializeLevelsStorage(sourceId); initializeLevelsStorage(targetId);
  const srcLp = profileActiveLevelPath(sourceId);
  const dstLp = profileActiveLevelPath(targetId);
  ensureLevelDirs(sourceId, srcLp.id); ensureLevelDirs(targetId, dstLp.id);
  const overviewCompare = compareOverviewImagesForCopy(srcLp, dstLp);
  if((kind === 'zones' || kind === 'markers' || kind === 'all') && overviewCompare.mismatch && payload.confirmMismatch !== true){
    return { ok:false, needsConfirmation:true, warning:'Размеры или aspect ratio overview-карт источника и назначения не совпадают. Координаты зон/маркеров могут визуально сместиться, после копирования может потребоваться ручное редактирование.', comparison:overviewCompare };
  }
  const backup = backupProfileDirectory(targetId, `before-copy-${kind}-from-${sourceId}`);
  const srcLayout = normalizeLayoutPayload(readJsonSafe(srcLp.layout, emptyLayout()), {strict:false}).layout;
  const dstLayout = normalizeLayoutPayload(readJsonSafe(dstLp.layout, emptyLayout()), {strict:false}).layout;
  if(kind === 'zones' || kind === 'all') dstLayout.zones = srcLayout.zones || {};
  if(kind === 'markers' || kind === 'all'){
    dstLayout.overviewMarkers = srcLayout.overviewMarkers || {};
    dstLayout.roomMarkers = srcLayout.roomMarkers || {};
    dstLayout.overviewMetrics = srcLayout.overviewMetrics || {};
    dstLayout.roomMetrics = srcLayout.roomMetrics || {};
    dstLayout.customNames = srcLayout.customNames || {};
  }
  if(kind === 'zones' || kind === 'markers' || kind === 'all') atomicWriteJson(dstLp.layout, dstLayout);
  if(kind === 'sensors' || kind === 'rooms' || kind === 'all') copyJsonFileWithFallback(srcLp.rooms, dstLp.rooms, defaultRoomsSettings());
  if(kind === 'display'){
    const srcUiState = loadUiState(srcLp.uiState);
    const dstUiState = loadUiState(dstLp.uiState);
    const displayKeys = ['hardwareScale','markerScale','sensorScale','roomLabelScale','markerOpacity','sensorOpacity','haloScale','showAllDevicesInRoom','compact','theme','darkTheme','kioskMode','kioskTileMode','kioskNavigationMode','kioskWidget','kioskAutoLock','kioskAutoLockSeconds','mobileMode','autoHide','hideSidebar','hideDevicePanel','hideToolbar','showZones','invisibleZones','showMarkers','showSensors','debugMode'];
    const nextUi = { ...(dstUiState.ui || {}) };
    for(const k of displayKeys){ if(srcUiState.ui && Object.prototype.hasOwnProperty.call(srcUiState.ui, k)) nextUi[k] = srcUiState.ui[k]; }
    atomicWriteJson(dstLp.uiState, { ...dstUiState, ui: nextUi, updatedAt:new Date().toISOString() });
    try{ copyDisplayUiForCurrentClientBetweenProfileContexts(req, sourceId, srcLp.id, targetId, dstLp.id, nextUi); }catch(e){ writeDebugLog('profiles','copy display client context failed',{requestId:req?.requestId, sourceId, targetId, error:e.message}); }
  }
  if(kind === 'overview' || kind === 'all'){
    removePathSafe(path.join(dstLp.images,'overview'));
    fs.mkdirSync(path.join(dstLp.images,'overview'), {recursive:true});
    copyPathRecursive(path.join(srcLp.images,'overview'), path.join(dstLp.images,'overview'));
    const srcImagesMeta = readJsonSafe(srcLp.imagesMeta, defaultImagesMeta());
    const dstImagesMeta = readJsonSafe(dstLp.imagesMeta, defaultImagesMeta());
    dstImagesMeta.overview = srcImagesMeta.overview || null;
    atomicWriteJson(dstLp.imagesMeta, { ...defaultImagesMeta(), ...dstImagesMeta, rooms: isPlainObject(dstImagesMeta.rooms) ? dstImagesMeta.rooms : {} });
  }
  if(kind === 'all'){
    copyJsonFileWithFallback(srcLp.sourceConfig, dstLp.sourceConfig, defaultSourceConfig());
    copyJsonFileWithFallback(srcLp.uiState, dstLp.uiState, defaultUiState());
    replacePathIfExists(srcLp.devicesJs, dstLp.devicesJs); replacePathIfExists(srcLp.devicesJson, dstLp.devicesJson);
    replacePathIfExists(srcLp.lovelaceJs, dstLp.lovelaceJs); replacePathIfExists(srcLp.lovelaceRaw, dstLp.lovelaceRaw);
    replacePathIfExists(srcLp.deviceParseReportJson, dstLp.deviceParseReportJson); replacePathIfExists(srcLp.deviceParseReportMd, dstLp.deviceParseReportMd);
    removePathSafe(path.join(dstLp.images,'rooms'));
    copyPathRecursive(path.join(srcLp.images,'rooms'), path.join(dstLp.images,'rooms'));
    const srcImagesMeta = readJsonSafe(srcLp.imagesMeta, defaultImagesMeta());
    const dstImagesMeta = readJsonSafe(dstLp.imagesMeta, defaultImagesMeta());
    atomicWriteJson(dstLp.imagesMeta, { ...defaultImagesMeta(), ...dstImagesMeta, overview:srcImagesMeta.overview || null, rooms:isPlainObject(srcImagesMeta.rooms) ? srcImagesMeta.rooms : {} });
  }
  const now = new Date().toISOString();
  const t = meta.profiles.find(p=>p.id===targetId); if(t) t.updatedAt = now;
  saveProfilesMeta(meta);
  updateActiveProfilePaths();
  ensureDataStore();
  return { ok:true, copiedKind:kind, sourceProfileId:sourceId, targetProfileId:targetId, backup: backup ? path.basename(backup) : null, comparison:overviewCompare, profiles:profilesDiagnostics() };
}
function backupProfileDirectory(profileId, reason='profile-backup'){
  if(!autoBackupsEnabled()) return null;
  const id = sanitizeProfileId(profileId);
  const src = profilePaths(id).dir;
  if(!fs.existsSync(src)) return null;
  const stamp = timestampForFile();
  const backupDir = path.join(LAYOUT_BACKUP_DIR, 'profiles', `${id}-${String(reason).replace(/[^a-z0-9_-]/gi,'-')}-${stamp}`);
  copyPathRecursive(src, backupDir);
  return backupDir;
}
function deleteProfile(id, payload={}){
  const meta = loadProfilesMeta();
  const profileId = sanitizeProfileId(id);
  if(meta.profiles.length <= 1) throw new Error('Нельзя удалить последний профиль');
  const idx = meta.profiles.findIndex(p=>p.id===profileId);
  if(idx < 0) throw new Error('Профиль не найден');
  const backup = backupProfileDirectory(profileId, 'before-delete');
  meta.profiles.splice(idx, 1);
  if(meta.activeProfileId === profileId){
    const requested = sanitizeProfileId(payload.activateProfileId || '');
    meta.activeProfileId = meta.profiles.some(p=>p.id===requested) ? requested : meta.profiles[0].id;
  }
  saveProfilesMeta(meta);
  removePathSafe(profilePaths(profileId).dir);
  clearProfileRuntimeStorage(profileId);
  updateActiveProfilePaths();
  ensureDataStore();
  const diag = profilesDiagnostics();
  diag.backup = backup ? path.basename(backup) : null;
  return diag;
}

function activateProfile(id){
  const meta = loadProfilesMeta();
  const profileId = sanitizeProfileId(id);
  if(!meta.profiles.some(p=>p.id===profileId)) throw new Error('Профиль не найден');
  meta.activeProfileId = profileId;
  for(const p of meta.profiles) if(p.id===profileId) p.updatedAt = new Date().toISOString();
  saveProfilesMeta(meta);
  updateActiveProfilePaths();
  ensureDataStore();
  return profilesDiagnostics();
}
function patchProfile(id, payload={}){
  const meta = loadProfilesMeta();
  const profileId = sanitizeProfileId(id);
  const p = meta.profiles.find(x=>x.id===profileId);
  if(!p) throw new Error('Профиль не найден');
  if(payload.name !== undefined) p.name = String(payload.name||p.name).trim().slice(0,60) || p.name;
  p.updatedAt = new Date().toISOString();
  saveProfilesMeta(meta);
  return profilesDiagnostics();
}

function safeCopyIfMissing(src, dst){
  try{
    if(src && fs.existsSync(src) && !fs.existsSync(dst)){
      fs.mkdirSync(path.dirname(dst), {recursive:true});
      fs.copyFileSync(src, dst);
    }
  }catch(e){ console.warn('[Smart Home UI] copy fallback failed:', e.message); }
}
function ensureDataStore(){
  fs.mkdirSync(DATA_DIR, {recursive:true});
  initializeProfilesStorage();
  fs.mkdirSync(LAYOUT_BACKUP_DIR, {recursive:true});
  fs.mkdirSync(DATA_IMAGES_DIR, {recursive:true});
  fs.mkdirSync(DATA_IMAGES_OVERVIEW_DIR, {recursive:true});
  fs.mkdirSync(DATA_IMAGES_ROOMS_DIR, {recursive:true});
  fs.mkdirSync(DATA_IMAGES_ORIGINALS_DIR, {recursive:true});
  fs.mkdirSync(DATA_IMAGES_ORIGINALS_ROOMS_DIR, {recursive:true});
  if(!runtimeDocumentExists(IMAGES_META_PATH)) atomicWriteJson(IMAGES_META_PATH, defaultImagesMeta());
  if(!runtimeFileExists(DEVICES_PATH)) writeJsAssignedArray(DEVICES_PATH, 'ALL_DEVICES', []);
  if(!runtimeFileExists(LOVELACE_PATH)) writeTextRuntimeFile(LOVELACE_PATH, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'js');
  if(!runtimeDocumentExists(ATTENTION_RULES_PATH)) saveAttentionRules(attentionDefault());
  if(!runtimeDocumentExists(SECURITY_RULES_PATH)) saveSecurityRules(securityRulesDefault());
  if(!runtimeDocumentExists(ROOMS_SETTINGS_PATH)) saveRoomsSettings(defaultRoomsSettings());
}

function atomicWriteJson(file, payload){
  const key = projectDocKeyForFile(file);
  if(key && allhaDb.hasDb && allhaDb.hasDb()){
    try{ allhaDb.setProjectDocument(key, payload, 'json'); }catch(e){ console.warn('[ALLHA-2D] DB JSON write failed:', key, e.message); }
  }
  // Mirror to files for image/media compatibility, manual inspection, and safe rollback.
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function defaultUiState(){
  return {
    version: 3,
    selectedRoom: 'overview',
    ui: {
      hideSidebar:true, hideDevicePanel:true, hideToolbar:false,
      mobileMode:true, autoHide:false, compact:false, darkTheme:true,
      kioskWidget:false, kioskMode:false, weatherEntity:'',
      haloScale:0.50, hardwareScale:1.00,
      markerScale:1.00, sensorScale:1.00, markerOpacity:0.00, sensorOpacity:0.00,
      showAllDevicesInRoom:false, showZones:true, invisibleZones:false, showMarkers:true, showSensors:true
    },
    viewport: { overview:{zoom:1,panX:0,panY:0}, rooms:{} },
    updatedAt: null
  };
}
function loadUiState(uiPath = UI_STATE_PATH){
  const raw = readJsonSafe(uiPath, {});
  const loaded = isPlainObject(raw) ? raw : {};
  const def = defaultUiState();
  const legacyUi = isPlainObject(loaded.ui) ? loaded.ui : {};
  const cleanUi = { ...def.ui };
  for(const key of Object.keys(def.ui)){
    if(Object.prototype.hasOwnProperty.call(legacyUi, key)) cleanUi[key] = legacyUi[key];
  }
  // Older resets could revive the legacy left sidebar. New/current defaults keep it hidden
  // unless the user explicitly opens it after the reset.
  if(Number(loaded?.version || 0) < 2 && !Object.prototype.hasOwnProperty.call(legacyUi, 'hideSidebar')) cleanUi.hideSidebar = true;
  const loadedViewport = isPlainObject(loaded.viewport) ? loaded.viewport : {};
  const loadedOverview = isPlainObject(loadedViewport.overview) ? loadedViewport.overview : {};
  const loadedRooms = isPlainObject(loadedViewport.rooms) ? loadedViewport.rooms : {};
  return {
    ...def,
    ...loaded,
    version: Math.max(Number(loaded?.version)||0, def.version),
    ui: cleanUi,
    viewport: {
      ...def.viewport,
      ...loadedViewport,
      overview:{...def.viewport.overview, ...loadedOverview},
      rooms: loadedRooms
    }
  };
}
function saveUiState(payload, uiPath = UI_STATE_PATH){
  const current = loadUiState(uiPath);
  const next = {
    ...current,
    ...(payload||{}),
    ui: { ...current.ui, ...(payload?.ui||{}) },
    viewport: { ...current.viewport, ...(payload?.viewport||{}), overview:{...current.viewport.overview, ...(payload?.viewport?.overview||{})}, rooms: payload?.viewport?.rooms || current.viewport.rooms || {} },
    updatedAt: new Date().toISOString()
  };
  atomicWriteJson(uiPath, next);
  return next;
}
function parseJsAssignedArray(file, name){
  try{
    const txt=readTextRuntimeFile(file, '');
    if(!txt) return [];
    const re=new RegExp('window\\.'+name+'\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)');
    const m=txt.match(re); if(!m) return [];
    return JSON.parse(m[1]);
  }catch(e){ return []; }
}
function loadAllDevicesForDiagnostics(){
  const devices = parseJsAssignedArray(DEVICES_PATH,'ALL_DEVICES');
  if(devices.length) return devices;
  return parseJsAssignedArray(FALLBACK_DEVICES_PATH,'ALL_DEVICES');
}
function listBackups(){
  if(!fs.existsSync(LAYOUT_BACKUP_DIR)) return [];
  return fs.readdirSync(LAYOUT_BACKUP_DIR).filter(f=>/^layout-.*\.json$/.test(f)).map(f=>{
    const full=path.join(LAYOUT_BACKUP_DIR,f); const st=fs.statSync(full);
    return { name:f, size:st.size, mtime:st.mtime.toISOString() };
  }).sort((a,b)=>b.name.localeCompare(a.name));
}
function pruneLayoutBackups(max=20){
  const items=listBackups();
  for(const item of items.slice(max)){ try{fs.unlinkSync(path.join(LAYOUT_BACKUP_DIR,item.name));}catch(e){} }
}
function restoreLayoutBackup(name){
  if(!/^layout-.*\.json$/.test(String(name||''))) throw new Error('Некорректное имя backup');
  const src=path.join(LAYOUT_BACKUP_DIR,name);
  if(!fs.existsSync(src)) throw new Error('Backup не найден');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(runtimeDocumentExists(LAYOUT_PATH)) backupLayout();
  const restored = JSON.parse(fs.readFileSync(src, 'utf8'));
  atomicWriteJson(LAYOUT_PATH, restored);
  return loadLayout();
}
function deleteLayoutBackup(name){
  if(!/^layout-.*\.json$/.test(String(name||''))) throw new Error('Некорректное имя backup');
  const file=path.join(LAYOUT_BACKUP_DIR,name);
  if(fs.existsSync(file)) fs.unlinkSync(file);
}


function pathInside(base, target){
  const b = path.resolve(base);
  const t = path.resolve(target);
  return t === b || t.startsWith(b + path.sep);
}
function dirSizeBytes(dir){
  let total = 0;
  if(!fs.existsSync(dir)) return 0;
  const st = fs.statSync(dir);
  if(st.isFile()) return st.size;
  for(const name of fs.readdirSync(dir)) total += dirSizeBytes(path.join(dir, name));
  return total;
}
function backupManifestPath(dir){ return path.join(dir, 'backup-manifest.json'); }
function readBackupManifest(dir){
  try{
    const file = backupManifestPath(dir);
    if(fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) || null;
  }catch(e){}
  return null;
}
function writeBackupManifest(dir, meta={}){
  try{
    const manifest = {
      version: 1,
      appVersion: require('./package.json').version || '',
      createdAt: meta.createdAt || new Date().toISOString(),
      reason: meta.reason || 'manual',
      backupType: meta.backupType || 'manual',
      sizeBytes: Number(meta.sizeBytes || 0),
      copied: Array.isArray(meta.copied) ? meta.copied : [],
      secretsPolicy: 'secrets-redacted'
    };
    fs.writeFileSync(backupManifestPath(dir), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  }catch(e){ return null; }
}
function sanitizedForBackup(value){
  const secretKey = /(password|passwd|pass|token|secret|cookie|pin|qrpassword|apikey|api_key|bearer|credential|session|refresh|accesskey)/i;
  function walk(v, key=''){
    if(Array.isArray(v)) return v.map(x=>walk(x, key));
    if(v && typeof v === 'object'){
      const out = {};
      for(const [k,val] of Object.entries(v)) out[k] = secretKey.test(k) ? '[REDACTED]' : walk(val, k);
      return out;
    }
    return secretKey.test(key) ? '[REDACTED]' : v;
  }
  return walk(value);
}
function copyJsonForBackup(src, dst){
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  fs.writeFileSync(dst, JSON.stringify(sanitizedForBackup(data), null, 2), 'utf8');
  return true;
}
function copyPathForBackup(src, dst){
  if(!fs.existsSync(src)) return false;
  const st = fs.statSync(src);
  if(st.isDirectory()){
    fs.mkdirSync(dst, {recursive:true});
    for(const name of fs.readdirSync(src)){
      if(name === 'backups' || name === 'logs' || name === 'sessions' || /allha2d\.db(-wal|-shm)?$/i.test(name)) continue;
      copyPathForBackup(path.join(src,name), path.join(dst,name));
    }
    return true;
  }
  if(/\.json$/i.test(src)) return copyJsonForBackup(src, dst);
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  fs.copyFileSync(src, dst);
  return true;
}
function backupItemFromPath(full, rel=''){
  const st = fs.statSync(full);
  if(st.isDirectory()){
    const manifest = readBackupManifest(full);
    return {
      name: rel || path.basename(full),
      type: 'directory',
      size: Number(manifest?.sizeBytes || 0),
      mtime: st.mtime.toISOString(),
      createdAt: manifest?.createdAt || st.mtime.toISOString(),
      manifest: !!manifest,
      reason: manifest?.reason || ''
    };
  }
  return { name: rel || path.basename(full), type:'file', size:st.size, mtime:st.mtime.toISOString(), manifest:false };
}
function walkBackupItems(){
  if(!fs.existsSync(LAYOUT_BACKUP_DIR)) return [];
  const items = [];
  for(const name of fs.readdirSync(LAYOUT_BACKUP_DIR)){
    const full = path.join(LAYOUT_BACKUP_DIR, name);
    try{ items.push(backupItemFromPath(full, name)); }catch(e){}
  }
  return items.sort((a,b)=>new Date(b.createdAt || b.mtime)-new Date(a.createdAt || a.mtime));
}
function backupSummary(){
  const items = walkBackupItems();
  const totalSize = items.reduce((a,b)=>a+(Number(b.size)||0),0);
  return {
    count: items.length,
    totalSize,
    oldest: items.length ? items.reduce((a,b)=>new Date(a.mtime)<new Date(b.mtime)?a:b).mtime : null,
    newest: items.length ? items[0].mtime : null,
    items,
    sizeMode: 'manifest-or-file-stat'
  };
}

function stableJsonForHash(value){
  if(value === null || typeof value !== 'object') return JSON.stringify(value);
  if(Array.isArray(value)) return '[' + value.map(stableJsonForHash).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJsonForHash(value[k])).join(',') + '}';
}
function hashText(value){ return crypto.createHash('sha1').update(String(value ?? ''), 'utf8').digest('hex'); }
function hashJson(value){ return hashText(stableJsonForHash(value)); }
function mirrorDiagnostics(){
  const out = { ok:true, generatedAt:new Date().toISOString(), mode:'diagnostics-only', repairAvailable:false, db:{documents:0, files:0}, disk:{json:0}, counts:{dbOnly:0,fileOnly:0,different:0,same:0}, dbOnly:[], fileOnly:[], different:[], sameSamples:[], notes:[
    'DB is primary; JSON files are mirrors for inspection, portability and rollback.',
    'This endpoint does not repair anything. Full DB↔JSON repair remains a later guarded maintenance step.',
    'Backups are manual-only by default; automatic backups are disabled unless ALLHA_ENABLE_AUTO_BACKUPS=1.'
  ] };
  const ignoreRel = (rel) => {
    const r = String(rel||'').replace(/\\/g,'/');
    return !r || r.startsWith('backups/') || r.startsWith('logs/') || r.startsWith('sessions/') || r.includes('/sessions/') || /(^|\/)allha2d\.db(-wal|-shm)?$/i.test(r) || /(^|\.)tmp$/i.test(r);
  };
  const diskJson = new Map();
  function walk(dir){
    if(!fs.existsSync(dir)) return;
    for(const name of fs.readdirSync(dir)){
      const full = path.join(dir,name);
      const rel = path.relative(DATA_DIR, full).replace(/\\/g,'/');
      if(ignoreRel(rel)) continue;
      const st = fs.statSync(full);
      if(st.isDirectory()) walk(full);
      else if(/\.json$/i.test(name)){
        try{ diskJson.set(rel, { key:rel, hash:hashJson(JSON.parse(fs.readFileSync(full,'utf8'))), size:st.size, mtime:st.mtime.toISOString() }); }
        catch(e){ diskJson.set(rel, { key:rel, parseError:e.message, size:st.size, mtime:st.mtime.toISOString() }); }
      }
    }
  }
  walk(DATA_DIR);
  out.disk.json = diskJson.size;
  const dbDocs = new Map();
  try{
    for(const row of (allhaDb.listProjectDocumentKeys ? allhaDb.listProjectDocumentKeys() : [])){
      const key = String(row.doc_key || '');
      if(ignoreRel(key)) continue;
      const value = allhaDb.getProjectDocument ? allhaDb.getProjectDocument(key, undefined) : undefined;
      dbDocs.set(key, { key, type:row.doc_type||'json', updatedAt:row.updated_at||'', hash:hashJson(value) });
    }
  }catch(e){ out.dbError = e.message; }
  out.db.documents = dbDocs.size;
  try{ out.db.files = (allhaDb.listProjectFileKeys ? allhaDb.listProjectFileKeys() : []).length; }catch(_){ }
  for(const [key, d] of dbDocs.entries()){
    const f = diskJson.get(key);
    if(!f){ out.dbOnly.push({key, updatedAt:d.updatedAt}); continue; }
    if(f.parseError){ out.different.push({key, reason:'file-parse-error', error:f.parseError, dbUpdatedAt:d.updatedAt, fileMtime:f.mtime}); continue; }
    if(f.hash !== d.hash){ out.different.push({key, dbUpdatedAt:d.updatedAt, fileMtime:f.mtime, dbHash:d.hash, fileHash:f.hash}); continue; }
    if(out.sameSamples.length < 20) out.sameSamples.push({key, updatedAt:d.updatedAt, fileMtime:f.mtime});
  }
  for(const [key, f] of diskJson.entries()){
    if(!dbDocs.has(key)) out.fileOnly.push({key, mtime:f.mtime, parseError:f.parseError||null});
  }
  const staleClientSettings = collectStaleClientSettingsDocuments(500);
  out.staleClientSettings = staleClientSettings;
  out.counts.staleClientSettings = staleClientSettings.length;
  out.counts.deletedOrMissingClientSettings = staleClientSettings.length;
  out.counts.skippedDeletedClients = staleClientSettings.length;
  out.counts.dbOnly = out.dbOnly.length;
  out.counts.fileOnly = out.fileOnly.length;
  out.counts.different = out.different.length;
  out.counts.same = Math.max(0, dbDocs.size - out.counts.dbOnly - out.counts.different);
  out.truncated = { dbOnly:out.dbOnly.length>200, fileOnly:out.fileOnly.length>200, different:out.different.length>200 };
  out.dbOnly = out.dbOnly.slice(0,200); out.fileOnly = out.fileOnly.slice(0,200); out.different = out.different.slice(0,200);
  return out;
}


function isBackupMirrorKey(key){
  const k = String(key || '').replace(/\\/g,'/').replace(/^\/+/, '');
  return k === 'backups' || k.startsWith('backups/');
}
function clientSettingsKeyStatus(key){
  const k = String(key || '').replace(/\\/g,'/');
  if(!k.startsWith('client_settings/')) return null;
  if(k === 'client_settings/server_ui.json') return {type:'server', id:'server', active:true, protected:true};
  if(k === 'client_settings/default_client_settings.json') return {type:'default', id:'default', active:true, protected:true};
  const m = k.match(/^client_settings\/(web_client|mobile_device)\/([^\/]+)/);
  if(!m) return {type:'unknown', id:'', active:false, protected:false};
  try{
    if(m[1] === 'web_client'){
      const c = allhaDb.getWebClient && allhaDb.getWebClient(m[2]);
      return {type:m[1], id:m[2], active:!!c, protected:m[2] === 'server'};
    }
    if(m[1] === 'mobile_device'){
      const d = allhaDb.getMobileDevice && allhaDb.getMobileDevice(m[2]);
      return {type:m[1], id:m[2], active:!!d, protected:false};
    }
  }catch(e){}
  return {type:m[1], id:m[2], active:false, protected:false};
}
function collectStaleClientSettingsDocuments(limit=500){
  const out = [];
  if(!allhaDb.hasDb || !allhaDb.hasDb() || !allhaDb.listProjectDocumentKeys) return out;
  for(const row of allhaDb.listProjectDocumentKeys()){
    const key = String(row.doc_key || '');
    const status = clientSettingsKeyStatus(key);
    if(!status || status.protected || status.active) continue;
    out.push({key, type:status.type, id:status.id, updatedAt:row.updated_at || ''});
    if(out.length >= limit) break;
  }
  return out;
}
function cleanupStaleClientSettingsDocuments(){
  const stale = collectStaleClientSettingsDocuments(5000);
  let deletedDocuments = 0;
  let deletedFiles = 0;
  const errors = [];
  for(const item of stale){
    try{ if(allhaDb.deleteProjectDocument && allhaDb.deleteProjectDocument(item.key)) deletedDocuments++; }
    catch(e){ errors.push({key:item.key, error:e.message}); }
    try{
      if(allhaDb.deleteProjectFile && allhaDb.deleteProjectFile(item.key)){ deletedFiles++; }
    }catch(e){ /* older DB module may not expose deleteProjectFile */ }
    try{
      const target = path.join(DATA_DIR, item.key);
      if(pathInside(DATA_DIR, target) && fs.existsSync(target)) fs.rmSync(target, {recursive:true, force:true});
    }catch(e){ errors.push({key:item.key, error:e.message}); }
  }
  writeDebugLog('maintenance','cleanup-stale-client-settings',{stale:stale.length, deletedDocuments, deletedFiles, errors:errors.length});
  return {stale:stale.length, deletedDocuments, deletedFiles, errors, items:stale.slice(0,200)};
}

function mirrorRepairClientKeyAllowed(key, includeDeletedClients=false){
  const k = String(key || '').replace(/\\/g,'/');
  if(!k.startsWith('client_settings/')) return true;
  if(k === 'client_settings/server_ui.json' || k === 'client_settings/default_client_settings.json') return true;
  const m = k.match(/^client_settings\/(web_client|mobile_device)\/([^\/]+)/);
  if(!m) return !includeDeletedClients;
  if(includeDeletedClients) return true;
  try{
    if(m[1] === 'web_client') return !!(allhaDb.getWebClient && allhaDb.getWebClient(m[2]));
    if(m[1] === 'mobile_device') return !!(allhaDb.getMobileDevice && allhaDb.getMobileDevice(m[2]));
  }catch(e){}
  return false;
}
function normalizeMirrorRepairKeys(input){
  if(Array.isArray(input)) return input.map(x=>String(x||'').replace(/\\/g,'/').trim()).filter(Boolean);
  const single = String(input || '').replace(/\\/g,'/').trim();
  return single ? [single] : [];
}
function mirrorRepair(payload={}){
  const includeBackups = payload.includeBackups === true;
  const expectedConfirm = includeBackups ? 'REPAIR MIRROR BACKUPS' : 'REPAIR MIRROR';
  if(String(payload.confirm || '') !== expectedConfirm){
    const msg = includeBackups
      ? 'Для восстановления mirror вместе с backups нужно подтверждение REPAIR MIRROR BACKUPS'
      : 'Для восстановления mirror нужно подтверждение REPAIR MIRROR';
    throw Object.assign(new Error(msg), {status:400});
  }
  if(!allhaDb.hasDb || !allhaDb.hasDb()) throw Object.assign(new Error('SQLite недоступен'), {status:503});
  const direction = String(payload.direction || '').trim();
  const includeDeletedClients = payload.includeDeletedClients === true;
  const selectedKeys = new Set(normalizeMirrorRepairKeys(payload.keys || payload.key));
  const allMode = selectedKeys.size === 0 || payload.all === true;
  const result = { ok:true, direction, generatedAt:new Date().toISOString(), repaired:[], skipped:[], errors:[] };
  const shouldInclude = (key) => (allMode || selectedKeys.has(key));
  const safeTarget = (key) => {
    const clean = String(key || '').replace(/\\/g,'/').replace(/^\/+/, '').replace(/\.\./g, '_');
    const target = path.join(DATA_DIR, clean);
    if(!pathInside(DATA_DIR, target)) throw new Error('Некорректный mirror key');
    return target;
  };
  if(direction === 'db-to-json'){
    const docRows = allhaDb.listProjectDocumentKeys ? allhaDb.listProjectDocumentKeys() : [];
    for(const row of docRows){
      const key = String(row.doc_key || '');
      if(!shouldInclude(key)) continue;
      if(isBackupMirrorKey(key) && !includeBackups){ result.skipped.push({key, reason:'backup-skipped'}); continue; }
      if(isBackupMirrorKey(key) && !includeBackups){ result.skipped.push({key, reason:'backup-skipped'}); continue; }
      if(!mirrorRepairClientKeyAllowed(key, includeDeletedClients)){ result.skipped.push({key, reason:'deleted-or-missing-client'}); continue; }
      try{
        const value = allhaDb.getProjectDocument(key, undefined);
        const target = safeTarget(key);
        fs.mkdirSync(path.dirname(target), {recursive:true});
        fs.writeFileSync(target, JSON.stringify(value, null, 2), 'utf8');
        result.repaired.push({key, type:'json', action:'db-to-json'});
      }catch(e){ result.errors.push({key, error:e.message}); }
    }
    const fileRows = allhaDb.listProjectFileKeys ? allhaDb.listProjectFileKeys() : [];
    for(const row of fileRows){
      const key = String(row.file_key || '');
      if(!shouldInclude(key)) continue;
      if(isBackupMirrorKey(key) && !includeBackups){ result.skipped.push({key, reason:'backup-skipped'}); continue; }
      if(!mirrorRepairClientKeyAllowed(key, includeDeletedClients)){ result.skipped.push({key, reason:'deleted-or-missing-client'}); continue; }
      try{
        const value = allhaDb.getProjectFile(key, null);
        if(value === null || value === undefined){ result.skipped.push({key, reason:'missing-db-file'}); continue; }
        const target = safeTarget(key);
        fs.mkdirSync(path.dirname(target), {recursive:true});
        fs.writeFileSync(target, String(value), 'utf8');
        result.repaired.push({key, type:'text', action:'db-to-json'});
      }catch(e){ result.errors.push({key, error:e.message}); }
    }
  } else if(direction === 'json-to-db'){
    const keys = allMode ? [] : Array.from(selectedKeys);
    if(allMode){
      function walk(dir){
        if(!fs.existsSync(dir)) return;
        for(const name of fs.readdirSync(dir)){
          const full = path.join(dir, name);
          const rel = path.relative(DATA_DIR, full).replace(/\\/g,'/');
          if((!includeBackups && rel.startsWith('backups/')) || rel.startsWith('logs/') || rel.startsWith('sessions/') || /(^|\/)allha2d\.db(-wal|-shm)?$/i.test(rel)) continue;
          const st = fs.statSync(full);
          if(st.isDirectory()) walk(full);
          else if(/\.(json|js|txt|md)$/i.test(name)) keys.push(rel);
        }
      }
      walk(DATA_DIR);
    }
    for(const key of keys){
      if(!mirrorRepairClientKeyAllowed(key, includeDeletedClients)){ result.skipped.push({key, reason:'deleted-or-missing-client'}); continue; }
      try{
        const target = safeTarget(key);
        if(!fs.existsSync(target)){ result.skipped.push({key, reason:'missing-file'}); continue; }
        if(/\.json$/i.test(key)){
          const value = JSON.parse(fs.readFileSync(target,'utf8'));
          if(allhaDb.setProjectDocument) allhaDb.setProjectDocument(key, value, 'json-repair');
          result.repaired.push({key, type:'json', action:'json-to-db'});
        } else if(/\.(js|txt|md)$/i.test(key)){
          const value = fs.readFileSync(target,'utf8');
          if(allhaDb.setProjectFile) allhaDb.setProjectFile(key, value, path.extname(key).slice(1) || 'text');
          result.repaired.push({key, type:'text', action:'json-to-db'});
        } else result.skipped.push({key, reason:'unsupported-extension'});
      }catch(e){ result.errors.push({key, error:e.message}); }
    }
  } else {
    throw Object.assign(new Error('direction должен быть db-to-json или json-to-db'), {status:400});
  }
  result.counts = { repaired:result.repaired.length, skipped:result.skipped.length, errors:result.errors.length };
  writeDebugLog('maintenance','mirror-repair',{direction, counts:result.counts, includeDeletedClients, includeBackups});
  return result;
}

function tarOctal(value, length){
  const s = Math.max(0, Number(value)||0).toString(8);
  return Buffer.from(s.padStart(length - 1, '0').slice(-(length - 1)) + '\0');
}
function tarHeader(name, size, mtime, type='0'){
  const buf = Buffer.alloc(512, 0);
  const clean = String(name || 'file').replace(/\\/g,'/').replace(/^\/+/, '').slice(0, 100);
  buf.write(clean, 0, Math.min(Buffer.byteLength(clean), 100), 'utf8');
  tarOctal(0o644, 8).copy(buf, 100);
  tarOctal(0, 8).copy(buf, 108);
  tarOctal(0, 8).copy(buf, 116);
  tarOctal(size, 12).copy(buf, 124);
  tarOctal(Math.floor(new Date(mtime || Date.now()).getTime()/1000), 12).copy(buf, 136);
  Buffer.from('        ').copy(buf, 148);
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0; for(const b of buf) sum += b;
  const chk = sum.toString(8).padStart(6,'0');
  buf.write(chk, 148, 6, 'ascii');
  buf[154] = 0; buf[155] = 32;
  return buf;
}
function createTarGzBuffer(srcDir, rootName){
  const chunks = [];
  const root = path.resolve(srcDir);
  const base = String(rootName || path.basename(srcDir)).replace(/[^a-z0-9_.-]/gi,'-') || 'backup';
  function addFile(full){
    const st = fs.statSync(full);
    if(st.isDirectory()){
      for(const name of fs.readdirSync(full)) addFile(path.join(full, name));
      return;
    }
    const rel = path.relative(root, full).replace(/\\/g,'/');
    const name = `${base}/${rel}`;
    const data = fs.readFileSync(full);
    chunks.push(tarHeader(name, data.length, st.mtime, '0'));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if(pad) chunks.push(Buffer.alloc(pad, 0));
  }
  addFile(root);
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function createManualBackup(reason='manual'){
  ensureDataStore();
  const stamp = timestampForFile();
  const safeReason = String(reason||'manual').replace(/[^a-z0-9_-]/gi,'-').slice(0,40) || 'manual';
  const dst = path.join(LAYOUT_BACKUP_DIR, `${safeReason}-backup-${stamp}`);
  fs.mkdirSync(dst, {recursive:true});
  const candidates = [
    PROFILES_META_PATH, PROFILES_DIR, ADDON_CONFIG_PATH, ATTENTION_RULES_PATH, SECURITY_RULES_PATH, COMMAND_LOG_PATH
  ];
  const copied=[];
  for(const src of candidates){
    try{ if(fs.existsSync(src) && copyPathForBackup(src, path.join(dst, path.basename(src)))) copied.push(path.basename(src)); }catch(e){ console.warn('[ALLHA-2D] backup copy failed:', path.basename(src), e.message); }
  }
  const sizeBytes = dirSizeBytes(dst);
  const manifest = writeBackupManifest(dst, {reason:safeReason, copied, sizeBytes});
  return { name:path.basename(dst), type:'directory', copied, path:dst, size:sizeBytes, manifest:!!manifest };
}

function restoreManualBackup(name, confirmWord){
  const rel = String(name||'').replace(/\\/g,'/');
  if(!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('Некорректное имя backup');
  if(String(confirmWord||'') !== 'RESTORE BACKUP') throw new Error('Для восстановления backup требуется RESTORE BACKUP');
  const srcDir = path.join(LAYOUT_BACKUP_DIR, rel);
  if(!pathInside(LAYOUT_BACKUP_DIR, srcDir) || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error('Backup не найден или не является директорией');
  const before = autoBackupsEnabled() ? createManualBackup('before-restore') : null;
  const restoreMap = [
    ['profiles.json', PROFILES_META_PATH],
    ['profiles', PROFILES_DIR],
    ['addon_config.json', ADDON_CONFIG_PATH],
    ['attention_rules.json', ATTENTION_RULES_PATH],
    ['security_rules.json', SECURITY_RULES_PATH],
    ['command_log.json', COMMAND_LOG_PATH]
  ];
  const restored=[];
  for(const [name0, dst] of restoreMap){
    const src = path.join(srcDir, name0);
    if(!fs.existsSync(src)) continue;
    try{
      if(fs.existsSync(dst)) fs.rmSync(dst, {recursive:true, force:true});
      copyPathRecursive(src, dst);
      restored.push(name0);
    }catch(e){ console.warn('[ALLHA-2D] restore backup failed:', name0, e.message); }
  }
  updateActiveProfilePaths();
  return { ok:true, restored, preRestoreBackup: before?.name || null, automaticPreRestoreBackup: !!before, backups: backupSummary(), reloadRecommended:true };
}
function deleteBackupItem(name){
  const rel = String(name||'').replace(/\\/g,'/');
  if(!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('Некорректное имя backup');
  const target = path.join(LAYOUT_BACKUP_DIR, rel);
  if(!pathInside(LAYOUT_BACKUP_DIR, target)) throw new Error('Некорректный путь backup');
  if(fs.existsSync(target)) fs.rmSync(target, {recursive:true, force:true});
}
function deleteAllBackups(confirmWord){
  if(String(confirmWord||'') !== 'DELETE BACKUPS') throw new Error('Для удаления всех backup требуется DELETE BACKUPS');
  if(fs.existsSync(LAYOUT_BACKUP_DIR)){
    for(const name of fs.readdirSync(LAYOUT_BACKUP_DIR)) fs.rmSync(path.join(LAYOUT_BACKUP_DIR,name), {recursive:true, force:true});
  }
  fs.mkdirSync(LAYOUT_BACKUP_DIR, {recursive:true});
  return backupSummary();
}
function deleteOldBackups(keep=10){
  const items = walkBackupItems();
  for(const item of items.slice(Math.max(0, Number(keep)||10))) deleteBackupItem(item.name);
  return backupSummary();
}

function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function isPlainObject(value){ return !!value && typeof value === 'object' && !Array.isArray(value); }
function finiteNumber(value){ const n=Number(value); return Number.isFinite(n) ? n : null; }
function roundPercent(value){ return Math.round(Number(value) * 1000) / 1000; }
function normalizePoint(value, problems, pathLabel){
  if(!isPlainObject(value)) { problems.invalidPoints.push({path:pathLabel, reason:'not-object'}); return null; }
  const x=finiteNumber(value.x), y=finiteNumber(value.y);
  if(x === null || y === null){ problems.invalidPoints.push({path:pathLabel, reason:'x/y-not-number'}); return null; }
  if(x > 100 || y > 100 || x < 0 || y < 0) problems.outOfRange.push({path:pathLabel, x, y});
  if(x > 100 || y > 100) problems.pixelLike.push({path:pathLabel, x, y});
  return { ...value, x: roundPercent(clamp(x,0,100)), y: roundPercent(clamp(y,0,100)) };
}
function normalizeRect(value, problems, pathLabel){
  if(!isPlainObject(value)) { problems.invalidPoints.push({path:pathLabel, reason:'not-object'}); return null; }
  const x=finiteNumber(value.x), y=finiteNumber(value.y), w=finiteNumber(value.w), h=finiteNumber(value.h);
  if(x === null || y === null || w === null || h === null){ problems.invalidPoints.push({path:pathLabel, reason:'x/y/w/h-not-number'}); return null; }
  if(x > 100 || y > 100 || w > 100 || h > 100 || x < 0 || y < 0 || w < 0 || h < 0) problems.outOfRange.push({path:pathLabel, x,y,w,h});
  if(x > 100 || y > 100 || w > 100 || h > 100) problems.pixelLike.push({path:pathLabel, x,y,w,h});
  return { ...value, x:roundPercent(clamp(x,0,100)), y:roundPercent(clamp(y,0,100)), w:roundPercent(clamp(w,0,100)), h:roundPercent(clamp(h,0,100)) };
}
function makeLayoutProblems(){ return { pixelLike:[], outOfRange:[], invalidPoints:[], oversized:[], unknownTopLevel:[] }; }
const LAYOUT_ALLOWED_TOP = new Set(['version','coordinateSpace','overviewRoomSync','roomCoordinateMigrated','overviewMarkers','roomMarkers','overviewMetrics','roomMetrics','zones','customNames','markers']);
function normalizeLayoutPayload(input, opts={}){
  const problems=makeLayoutProblems();
  if(!isPlainObject(input)) throw new Error('Layout должен быть JSON object');
  const rawSize = Buffer.byteLength(JSON.stringify(input), 'utf8');
  if(rawSize > 1024*1024) throw new Error('Layout слишком большой');
  for(const k of Object.keys(input)) if(!LAYOUT_ALLOWED_TOP.has(k)) problems.unknownTopLevel.push(k);
  const layout={
    version: Number.isFinite(Number(input.version)) ? Number(input.version) : 8,
    coordinateSpace: input.coordinateSpace || 'room-content-box',
    overviewRoomSync: !!input.overviewRoomSync,
    roomCoordinateMigrated: isPlainObject(input.roomCoordinateMigrated) ? input.roomCoordinateMigrated : {},
    overviewMarkers: {}, roomMarkers:{}, overviewMetrics:{}, roomMetrics:{}, zones:{}, customNames: isPlainObject(input.customNames) ? input.customNames : {}
  };
  const overviewMarkers = isPlainObject(input.overviewMarkers) ? input.overviewMarkers : (isPlainObject(input.markers) ? input.markers : {});
  for(const [eid,p] of Object.entries(overviewMarkers)){
    const np=normalizePoint(p, problems, `overviewMarkers.${eid}`);
    if(np) layout.overviewMarkers[eid]=np;
  }
  if(Object.keys(layout.overviewMarkers).length > 2000) problems.oversized.push({path:'overviewMarkers', count:Object.keys(layout.overviewMarkers).length});
  const roomMarkers = isPlainObject(input.roomMarkers) ? input.roomMarkers : {};
  for(const [rid,map] of Object.entries(roomMarkers)){
    if(!isPlainObject(map)){ problems.invalidPoints.push({path:`roomMarkers.${rid}`, reason:'not-object'}); continue; }
    layout.roomMarkers[rid]={};
    for(const [eid,p] of Object.entries(map)){
      const np=normalizePoint(p, problems, `roomMarkers.${rid}.${eid}`);
      if(np) layout.roomMarkers[rid][eid]=np;
    }
    if(Object.keys(layout.roomMarkers[rid]).length > 2000) problems.oversized.push({path:`roomMarkers.${rid}`, count:Object.keys(layout.roomMarkers[rid]).length});
  }
  for(const [id,p] of Object.entries(isPlainObject(input.overviewMetrics)?input.overviewMetrics:{})){
    const np=normalizePoint(p, problems, `overviewMetrics.${id}`); if(np) layout.overviewMetrics[id]=np;
  }
  for(const [rid,p] of Object.entries(isPlainObject(input.roomMetrics)?input.roomMetrics:{})){
    const np=normalizePoint(p, problems, `roomMetrics.${rid}`); if(np) layout.roomMetrics[rid]=np;
  }
  for(const [rid,z] of Object.entries(isPlainObject(input.zones)?input.zones:{})){
    const nz=normalizeRect(z, problems, `zones.${rid}`); if(nz) layout.zones[rid]=nz;
  }
  layout.version = Math.max(1, Number(layout.version)||8);
  if(problems.oversized.length) throw new Error('Layout содержит слишком много объектов');
  if(problems.invalidPoints.length && opts.strict) throw new Error('Layout содержит некорректные координаты');
  if(problems.unknownTopLevel.length > 20) throw new Error('Layout содержит слишком много неизвестных top-level полей');
  return { layout, problems };
}
function analyzeLayout(layout){
  const { layout: normalized, problems } = normalizeLayoutPayload(layout || {}, {strict:false});
  const counts={ overviewMarkers:Object.keys(normalized.overviewMarkers||{}).length, roomMarkers:0, overviewMetrics:Object.keys(normalized.overviewMetrics||{}).length, roomMetrics:Object.keys(normalized.roomMetrics||{}).length, zones:Object.keys(normalized.zones||{}).length };
  for(const map of Object.values(normalized.roomMarkers||{})) counts.roomMarkers += Object.keys(map||{}).length;
  const ok = !problems.pixelLike.length && !problems.outOfRange.length && !problems.invalidPoints.length && !problems.oversized.length;
  return { ok, counts, problems, normalizedPreview: normalized };
}
function normalizeStoredLayout(){
  const current=loadLayout();
  const {layout, problems}=normalizeLayoutPayload(current, {strict:false});
  const backup=saveLayout(layout);
  return { ok:true, backup: backup ? path.basename(backup) : null, diagnostics: analyzeLayout(layout), problems };
}

function backupLayoutWithPrefix(prefix){
  if(!autoBackupsEnabled()) return null;
  const layout = loadLayout();
  if(!layout) return null;
  fs.mkdirSync(LAYOUT_BACKUP_DIR,{recursive:true});
  const safePrefix = String(prefix||'layout').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const backupPath = path.join(LAYOUT_BACKUP_DIR, `${safePrefix}-${timestampForFile()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(layout, null, 2), 'utf8');
  return backupPath;
}
function writeLayoutWithoutBackup(layout){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const normalized = normalizeLayoutPayload(layout || {version:8}, {strict:false});
  atomicWriteJson(LAYOUT_PATH, normalized.layout);
  return normalized.layout;
}
function clearLayoutMarkers(){
  const current=loadLayout();
  const {layout}=normalizeLayoutPayload(current, {strict:false});
  const backup=backupLayoutWithPrefix('layout-before-clear-markers');
  layout.overviewMarkers = {};
  layout.roomMarkers = {};
  layout.overviewMetrics = {};
  layout.roomMetrics = {};
  const saved=writeLayoutWithoutBackup(layout);
  return { ok:true, backup: backup ? path.basename(backup) : null, layout: saved, diagnostics: analyzeLayout(saved) };
}
function clearLayoutZones(){
  const current=loadLayout();
  const {layout}=normalizeLayoutPayload(current, {strict:false});
  const backup=backupLayoutWithPrefix('layout-before-clear-zones');
  layout.zones = {};
  const saved=writeLayoutWithoutBackup(layout);
  return { ok:true, backup: backup ? path.basename(backup) : null, layout: saved, diagnostics: analyzeLayout(saved) };
}



function copyPathRecursive(src, dst){
  if(!fs.existsSync(src)) return false;
  const st = fs.statSync(src);
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  if(st.isDirectory()){
    fs.mkdirSync(dst, {recursive:true});
    for(const name of fs.readdirSync(src)) copyPathRecursive(path.join(src,name), path.join(dst,name));
  } else {
    fs.copyFileSync(src, dst);
    importRuntimeMirrorToDb(dst);
  }
  return true;
}
function removePathSafe(target){
  if(!target || !target.startsWith(DATA_DIR)) return;
  try{
    const rel = path.relative(DATA_DIR, target).replace(/\\/g,'/');
    if(rel && !rel.startsWith('..')) clearRuntimeStoragePrefix(rel.endsWith('/') ? rel : rel + '/');
  }catch(e){}
  try{ if(fs.existsSync(target)) fs.rmSync(target, {recursive:true, force:true}); }catch(e){ console.warn('[ALLHA-2D] factory reset remove failed:', target, e.message); }
}
function projectFileKeyForFile(file){
  try{
    const resolved = path.resolve(file);
    const dataRoot = path.resolve(DATA_DIR);
    if(!resolved.startsWith(dataRoot)) return null;
    const rel = path.relative(dataRoot, resolved).replace(/\\/g,'/');
    if(!rel || rel.startsWith('..')) return null;
    if(!/\.(js|txt|md)$/i.test(rel)) return null;
    return rel;
  }catch(e){ return null; }
}
function writeTextRuntimeFile(file, text, type='text'){
  const key = projectFileKeyForFile(file);
  if(key && allhaDb.hasDb && allhaDb.hasDb()){
    try{ allhaDb.setProjectFile(key, text, type); }catch(e){ console.warn('[ALLHA-2D] DB text write failed:', key, e.message); }
  }
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, String(text ?? ''), 'utf8');
}
function readTextRuntimeFile(file, fallback=''){
  const key = projectFileKeyForFile(file);
  if(key && allhaDb.hasDb && allhaDb.hasDb()){
    const fromDb = allhaDb.getProjectFile(key, null);
    if(fromDb !== null && fromDb !== undefined){
      if(!fs.existsSync(file)) runtimeAudit.mirrorMissingButDbPresent += 1;
      return fromDb;
    }
    if(fs.existsSync(file)){
      const txt=fs.readFileSync(file,'utf8');
      bumpRuntimeAudit('fileFallbackReads', key);
      allhaDb.setProjectFile(key, txt, path.extname(file).slice(1) || 'text');
      return txt;
    }
    return fallback;
  }
  if(fs.existsSync(file)){
    bumpRuntimeAudit('fileFallbackReads', key || file);
    return fs.readFileSync(file,'utf8');
  }
  return fallback;
}
function writeJsAssignedArray(file, name, arr){
  writeTextRuntimeFile(file, `window.${name} = ${JSON.stringify(arr||[], null, 2)};\n`, 'js');
}
function emptyLayout(){
  return { version:8, coordinateSpace:'room-content-box', overviewRoomSync:false, roomCoordinateMigrated:{}, overviewMarkers:{}, roomMarkers:{}, overviewMetrics:{}, roomMetrics:{}, zones:{}, customNames:{} };
}
function writeEmptyRuntimeBundle(lp){
  atomicWriteJson(lp.layout, emptyLayout());
  atomicWriteJson(lp.rooms, defaultRoomsSettings());
  atomicWriteJson(lp.sourceConfig, defaultSourceConfig());
  atomicWriteJson(lp.uiState, defaultUiState());
  atomicWriteJson(lp.imagesMeta, defaultImagesMeta());
  writeJsAssignedArray(lp.devicesJs, 'ALL_DEVICES', []);
  atomicWriteJson(lp.devicesJson, []);
  writeTextRuntimeFile(lp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'js');
  atomicWriteJson(lp.lovelaceRaw, { version:1, views:[] });
}
function factoryResetProject(confirmWord){
  if(String(confirmWord||'') !== 'RESET') throw new Error('Для полного сброса требуется подтверждение RESET');
  ensureDataStore();
  const stamp = timestampForFile();
  const backupDir = autoBackupsEnabled() ? path.join(LAYOUT_BACKUP_DIR, `factory-reset-${stamp}`) : null;
  if(backupDir) fs.mkdirSync(backupDir, {recursive:true});
  const candidates = [
    ADDON_CONFIG_PATH, PROFILES_META_PATH, PROFILES_DIR,
    SOURCE_CONFIG_PATH, UI_STATE_PATH, LAYOUT_PATH, ROOMS_SETTINGS_PATH, DEVICES_PATH, activeLevelPaths().devicesJson, LOVELACE_PATH, activeLevelPaths().lovelaceRaw,
    path.join(DATA_DIR,'layout.json'), path.join(DATA_DIR,'rooms.json'), path.join(DATA_DIR,'source_config.json'), path.join(DATA_DIR,'ui_state.json'),
    path.join(DATA_DIR,'devices.js'), path.join(DATA_DIR,'devices.json'), path.join(DATA_DIR,'lovelace-source.js'), path.join(DATA_DIR,'lovelace_raw.json'), path.join(DATA_DIR,'images'),
    ATTENTION_RULES_PATH, SECURITY_RULES_PATH, COMMAND_LOG_PATH
  ];
  const backedUp = [];
  if(backupDir){
    const seenBackup = new Set();
    for(const src of candidates){
      try{
        if(!src || seenBackup.has(src)) continue;
        seenBackup.add(src);
        if(fs.existsSync(src)){
          const dst = path.join(backupDir, path.basename(src));
          if(copyPathRecursive(src, dst)) backedUp.push(path.basename(src));
        }
      }catch(e){ console.warn('[ALLHA-2D] factory reset backup failed:', src, e.message); }
    }
  }

  // Полный сброс должен удалять не только картинки, но и все runtime-данные:
  // профили, уровни, layout/zones/markers, rooms cache, devices, Lovelace sources, UI state и security.
  const removeTargets = [
    ADDON_CONFIG_PATH, PROFILES_META_PATH, PROFILES_DIR,
    path.join(DATA_DIR,'layout.json'), path.join(DATA_DIR,'rooms.json'), path.join(DATA_DIR,'source_config.json'), path.join(DATA_DIR,'ui_state.json'),
    path.join(DATA_DIR,'devices.js'), path.join(DATA_DIR,'devices.json'), path.join(DATA_DIR,'lovelace-source.js'), path.join(DATA_DIR,'lovelace_raw.json'), path.join(DATA_DIR,'device_parse_report.json'), path.join(DATA_DIR,'device_parse_report.md'),
    path.join(DATA_DIR,'images'), ATTENTION_RULES_PATH, SECURITY_RULES_PATH, COMMAND_LOG_PATH
  ];
  for(const target of removeTargets) removePathSafe(target);

  fs.mkdirSync(DATA_DIR, {recursive:true});
  fs.mkdirSync(LAYOUT_BACKUP_DIR, {recursive:true});

  // Сбрасываем активный runtime на единственный чистый профиль/уровень.
  const profilesMeta = defaultProfilesMeta();
  profilesMeta.activeProfileId = 'profile-1';
  profilesMeta.profiles = [{ id:'profile-1', name:'Основной', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }];
  atomicWriteJson(PROFILES_META_PATH, profilesMeta);
  const levelsMeta = defaultLevelsMeta();
  levelsMeta.activeLevelId = 'level-1';
  levelsMeta.levels = [{ id:'level-1', name:'Основной уровень', createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() }];
  atomicWriteJson(levelsMetaPath('profile-1'), levelsMeta);

  updateActiveProfilePaths();
  const lp = ensureLevelDirs('profile-1', 'level-1');
  writeEmptyRuntimeBundle(lp);

  atomicWriteJson(ADDON_CONFIG_PATH, defaultAddonConfig());
  saveAttentionRules(attentionDefault());
  saveSecurityRules(securityRulesDefault());
  atomicWriteJson(COMMAND_LOG_PATH, []);

  // Legacy-файлы оставляем пустыми, чтобы старые миграции/кэш не подтягивали старые устройства.
  atomicWriteJson(path.join(DATA_DIR,'source_config.json'), defaultSourceConfig());
  atomicWriteJson(path.join(DATA_DIR,'ui_state.json'), defaultUiState());
  atomicWriteJson(path.join(DATA_DIR,'rooms.json'), defaultRoomsSettings());
  atomicWriteJson(path.join(DATA_DIR,'layout.json'), emptyLayout());
  writeJsAssignedArray(path.join(DATA_DIR,'devices.js'), 'ALL_DEVICES', []);
  atomicWriteJson(path.join(DATA_DIR,'devices.json'), []);
  writeTextRuntimeFile(path.join(DATA_DIR,'lovelace-source.js'), 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'js');
  atomicWriteJson(path.join(DATA_DIR,'lovelace_raw.json'), { version:1, views:[] });

  ensureDataStore();
  return { ok:true, reset:true, backup:backupDir ? path.basename(backupDir) : null, automaticBackup:!!backupDir, backedUp, config: publicConfig(loadAddonConfig()), layout: loadLayout(), uiState: loadUiState(), profiles: profilesDiagnostics(), levels: levelsDiagnostics() };
}

function defaultImagesMeta(){
  return { version: 1, overview: null, rooms: {} };
}
function loadImagesMeta(){
  const meta = readJsonSafe(IMAGES_META_PATH, defaultImagesMeta());
  return {
    version: Number(meta.version) || 1,
    overview: meta.overview || null,
    rooms: isPlainObject(meta.rooms) ? meta.rooms : {}
  };
}
function getImageSize(file){
  try{
    if(!fs.existsSync(file)) return { width:null, height:null };
    const b = fs.readFileSync(file);
    if(b.length >= 24 && b.toString('ascii',1,4) === 'PNG'){
      return { width:b.readUInt32BE(16), height:b.readUInt32BE(20) };
    }
    if(b.length >= 10 && b[0] === 0xff && b[1] === 0xd8){
      let i = 2;
      while(i < b.length){
        if(b[i] !== 0xff){ i++; continue; }
        const marker = b[i+1];
        const len = b.readUInt16BE(i+2);
        if(marker >= 0xc0 && marker <= 0xc3){
          return { width:b.readUInt16BE(i+7), height:b.readUInt16BE(i+5) };
        }
        i += 2 + len;
      }
    }
    if(b.length >= 30 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP'){
      const chunk = b.toString('ascii',12,16);
      if(chunk === 'VP8X' && b.length >= 30){
        return { width:1 + b.readUIntLE(24,3), height:1 + b.readUIntLE(27,3) };
      }
      if(chunk === 'VP8 ' && b.length >= 30){
        return { width:b.readUInt16LE(26) & 0x3fff, height:b.readUInt16LE(28) & 0x3fff };
      }
      if(chunk === 'VP8L' && b.length >= 25){
        const bits = b.readUInt32LE(21);
        return { width:(bits & 0x3fff) + 1, height:((bits >> 14) & 0x3fff) + 1 };
      }
    }
  }catch(e){}
  return { width:null, height:null };
}
function mediaUrlForOverview(){ return 'media/images/overview.webp'; }
function mediaUrlForRoom(roomId){ return `media/images/rooms/${encodeURIComponent(String(roomId||'default'))}.webp`; }
function customOverviewImagePath(){ return path.join(DATA_IMAGES_OVERVIEW_DIR, 'overview.webp'); }
function legacyUnsafeRoomImageFileBase(roomId){ return String(roomId||'default').replace(/[^a-zA-Z0-9_-]/g,'_'); }
function safeRoomImageFileBase(roomId){
  const raw = String(roomId || 'default').trim() || 'default';
  const slug = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'room';
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  return `${slug}-${hash}`;
}
function customRoomImagePath(roomId){ return path.join(DATA_IMAGES_ROOMS_DIR, `${safeRoomImageFileBase(roomId)}.webp`); }
function activeCustomRoomImagePath(roomId){
  const meta = loadImagesMeta();
  const rid = String(roomId||'');
  const expectedBase = safeRoomImageFileBase(roomId);
  const expectedPath = path.join(DATA_IMAGES_ROOMS_DIR, `${expectedBase}.webp`);

  // In local-dev, old legacy room image names were derived from room_id by
  // replacing non-latin characters. Several Russian room_ids could therefore
  // point to the same file (for example many underscores). Do not trust those
  // legacy paths, because they can show another room's image. Only accept the
  // new hash-based per-room filename.
  const strictRoomImageFiles = process.env.ALLHA_MODE === 'local-dev';

  const metaEntry = meta.rooms?.[rid];
  const src = metaEntry?.file;
  if(src && path.resolve(src).startsWith(path.resolve(DATA_IMAGES_ROOMS_DIR)) && fs.existsSync(src)){
    if(!strictRoomImageFiles || path.basename(src) === `${expectedBase}.webp`){
      return src;
    }
  }

  if(fs.existsSync(expectedPath)) return expectedPath;

  if(!strictRoomImageFiles){
    const legacyBase = path.join(DATA_IMAGES_ROOMS_DIR, legacyUnsafeRoomImageFileBase(roomId));
    for(const ext of ['webp','png','jpg','jpeg']){
      const f = `${legacyBase}.${ext}`;
      if(fs.existsSync(f)) return f;
    }
  }

  return null;
}
function placeholderSvg(kind='overview', roomId=''){
  const title = kind === 'overview' ? 'ALLHA-2D overview' : `ALLHA-2D room ${String(roomId||'')}`;
  const subtitle = kind === 'overview' ? 'Загрузите общий план в настройках' : 'Загрузите картинку комнаты в настройках';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#101824"/><stop offset="1" stop-color="#1f2f44"/></linearGradient></defs>
    <rect width="1600" height="900" fill="url(#g)"/>
    <rect x="80" y="80" width="1440" height="740" rx="36" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="6" stroke-dasharray="26 22"/>
    <text x="800" y="410" text-anchor="middle" fill="#eef4ff" font-family="Arial, sans-serif" font-size="54" font-weight="700">${title.replace(/[<>&]/g,'')}</text>
    <text x="800" y="485" text-anchor="middle" fill="#b8c7dc" font-family="Arial, sans-serif" font-size="34">${subtitle}</text>
  </svg>`;
}

const IMAGE_UPLOAD_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxPixels: 55 * 1000 * 1000,
  overviewMaxLongSide: 3000,
  roomMaxLongSide: 2500,
  webpQuality: 86
};
function imageExtFromFilename(name){
  const ext = path.extname(String(name||'')).toLowerCase().replace('.','');
  return ['jpg','jpeg','png','webp'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : '';
}
function imageExtFromMime(mime){
  const m = String(mime||'').toLowerCase().split(';')[0].trim();
  if(m === 'image/jpeg' || m === 'image/jpg') return 'jpg';
  if(m === 'image/png') return 'png';
  if(m === 'image/webp') return 'webp';
  return '';
}
function imageExtFromMagic(buffer){
  const b = Buffer.from(buffer || []);
  if(b.length >= 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if(b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if(b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return 'webp';
  return '';
}
function safeOriginalFilename(req, fallback='image'){
  let filename = String(req.get('x-filename') || req.query.filename || fallback);
  try{ filename = decodeURIComponent(filename); }catch(e){}
  filename = path.basename(filename).replace(/[\\/\x00]/g,'').trim();
  return filename || fallback;
}
function validateUploadedImage(req, buffer, kind='overview'){
  if(!buffer || !buffer.length) throw new Error('Файл изображения пустой');
  if(buffer.length > IMAGE_UPLOAD_LIMITS.maxBytes) throw new Error('Файл слишком большой. Максимум 25 MB.');
  const filename = safeOriginalFilename(req, kind);
  const mimeExt = imageExtFromMime(req.get('content-type'));
  const filenameExt = imageExtFromFilename(filename);
  const magicExt = imageExtFromMagic(buffer);
  const ext = magicExt || mimeExt || filenameExt;
  if(!['jpg','png','webp'].includes(ext)) throw new Error('Поддерживаются только JPG, PNG и WEBP');
  if(mimeExt && magicExt && mimeExt !== magicExt) throw new Error('MIME type не совпадает с содержимым файла');
  if(filenameExt && magicExt && filenameExt !== magicExt) throw new Error('Расширение файла не совпадает с содержимым изображения');
  const tmp = path.join(DATA_IMAGES_DIR, `.upload-check-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`);
  fs.writeFileSync(tmp, buffer);
  const size = getImageSize(tmp);
  try{ fs.unlinkSync(tmp); }catch(e){}
  if(!size.width || !size.height) throw new Error('Не удалось прочитать размеры изображения');
  if(size.width * size.height > IMAGE_UPLOAD_LIMITS.maxPixels) throw new Error('Изображение слишком большое по пикселям. Максимум около 55 MP.');
  return { ext, filename, width:size.width, height:size.height, aspectRatio: Math.round((size.width/size.height)*1000)/1000, sizeBytes: buffer.length, kind };
}
async function processUploadedImage(kind, buffer, info, targetBasePath){
  const maxLongSide = kind === 'room' ? IMAGE_UPLOAD_LIMITS.roomMaxLongSide : IMAGE_UPLOAD_LIMITS.overviewMaxLongSide;
  const baseNoExt = targetBasePath.replace(/\.[^.]+$/, '');
  for(const ext of ['webp','png','jpg','jpeg']){
    const old = `${baseNoExt}.${ext}`;
    if(fs.existsSync(old)) fs.unlinkSync(old);
  }
  if(sharp){
    const outputPath = `${baseNoExt}.webp`;
    const pipeline = sharp(buffer, { limitInputPixels: IMAGE_UPLOAD_LIMITS.maxPixels }).rotate().resize({ width:maxLongSide, height:maxLongSide, fit:'inside', withoutEnlargement:true }).webp({ quality: IMAGE_UPLOAD_LIMITS.webpQuality });
    const outInfo = await pipeline.toFile(outputPath);
    const st = fs.statSync(outputPath);
    return {
      workingPath: outputPath,
      processedWidth: outInfo.width || info.width,
      processedHeight: outInfo.height || info.height,
      format: 'webp',
      processedSizeBytes: st.size,
      converter: 'sharp-webp',
      maxLongSide
    };
  }
  const outputPath = `${baseNoExt}.${info.ext}`;
  fs.writeFileSync(outputPath, buffer);
  const st = fs.statSync(outputPath);
  return {
    workingPath: outputPath,
    processedWidth: info.width,
    processedHeight: info.height,
    format: info.ext,
    processedSizeBytes: st.size,
    converter: 'copy-fallback',
    maxLongSide
  };
}
function backupDataFile(src, prefix, ext){
  if(!src || !fs.existsSync(src)) return null;
  fs.mkdirSync(LAYOUT_BACKUP_DIR, {recursive:true});
  const safeExt = ext || path.extname(src) || '.bak';
  const dst = path.join(LAYOUT_BACKUP_DIR, `${prefix}-${timestampForFile()}${safeExt.startsWith('.')?safeExt:'.'+safeExt}`);
  fs.copyFileSync(src, dst);
  return dst;
}
function backupImagesMeta(){ return backupDataFile(IMAGES_META_PATH, 'images-meta', '.json'); }
function backupOverviewImage(){
  const active = activeCustomOverviewImagePath();
  return active && fs.existsSync(active) ? backupDataFile(active, 'overview-image', path.extname(active) || '.img') : null;
}
function backupRoomImage(roomId){
  const safe = safeRoomImageFileBase(roomId);
  const active = activeCustomRoomImagePath(roomId);
  return active && fs.existsSync(active) ? backupDataFile(active, `room-${safe}-image`, path.extname(active) || '.img') : null;
}
function activeCustomOverviewImagePath(){
  const meta = loadImagesMeta();
  const src = meta.overview?.file;
  if(src && path.resolve(src).startsWith(path.resolve(DATA_IMAGES_OVERVIEW_DIR)) && fs.existsSync(src)) return src;
  for(const ext of ['webp','png','jpg','jpeg']){
    const f = path.join(DATA_IMAGES_OVERVIEW_DIR, `overview.${ext}`);
    if(fs.existsSync(f)) return f;
  }
  return customOverviewImagePath();
}
function saveImagesMeta(meta){
  const next = {
    version: Number(meta?.version) || 1,
    overview: meta?.overview || null,
    rooms: isPlainObject(meta?.rooms) ? meta.rooms : {}
  };
  atomicWriteJson(IMAGES_META_PATH, next);
  return next;
}
function imageInfo(kind, roomId){
  const custom = kind === 'overview' ? activeCustomOverviewImagePath() : activeCustomRoomImagePath(roomId);
  const hasCustom = !!custom && fs.existsSync(custom);
  const file = hasCustom ? custom : null;
  const size = file ? getImageSize(file) : { width:1600, height:900 };
  const st = file ? fs.statSync(file) : null;
  const width = size.width || 1600, height = size.height || 900;
  const meta = loadImagesMeta();
  const metaInfo = kind === 'overview' ? meta.overview : meta.rooms?.[String(roomId||'')];
  return {
    src: kind === 'overview' ? mediaUrlForOverview() : mediaUrlForRoom(roomId),
    cacheToken: metaInfo?.updatedAt || (hasCustom ? String(st.mtimeMs) : 'fallback'),
    mode: hasCustom ? 'custom' : 'fallback',
    fallbackKind: hasCustom ? null : 'empty-placeholder',
    room_id: kind === 'room' ? String(roomId||'') : undefined,
    originalWidth: hasCustom ? (metaInfo?.originalWidth || width) : null,
    originalHeight: hasCustom ? (metaInfo?.originalHeight || height) : null,
    processedWidth: metaInfo?.processedWidth || width,
    processedHeight: metaInfo?.processedHeight || height,
    format: hasCustom ? (metaInfo?.format || path.extname(file).replace('.','') || null) : 'svg',
    sizeBytes: metaInfo?.processedSizeBytes || (st ? st.size : 0),
    originalSizeBytes: metaInfo?.sizeBytes || null,
    aspectRatio: (metaInfo?.aspectRatio || (width && height ? Math.round((width / height) * 1000) / 1000 : null)),
    converter: metaInfo?.converter || (hasCustom ? 'legacy-copy' : 'empty-placeholder'),
    maxLongSide: metaInfo?.maxLongSide || null
  };
}
function roomKeyVariants(roomId, room){
  const values = [roomId, room?.id, room?.alias, room?.label, room?.name, room?.title];
  const out = new Set();
  for(const v of values){
    const raw = String(v || '').trim();
    if(!raw) continue;
    out.add(raw.toLowerCase());
    out.add(raw.replace(/[^a-z0-9а-яё]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase());
    out.add(raw.replace(/\s+/g,' ').toLowerCase());
  }
  return out;
}
function listKnownRoomIds(options={}){
  const roomsPath = options.roomsPath || ROOMS_SETTINGS_PATH;
  const devicesPath = options.devicesPath || (roomsPath === ROOMS_SETTINGS_PATH ? DEVICES_PATH : path.join(path.dirname(roomsPath), 'devices.js'));
  const ids = new Set();
  try{
    const rawRooms = readJsonSafe(roomsPath, {rooms:{}});
    if(rawRooms && isPlainObject(rawRooms.rooms)){
      for(const id of Object.keys(rawRooms.rooms)) if(id && id !== 'overview') ids.add(id);
    }
  }catch(e){}
  try{
    const devices = parseJsAssignedArray(devicesPath, 'ALL_DEVICES');
    for(const d of devices){
      const room = String(d?.room || d?.room_id || '').trim();
      if(room && room !== 'overview' && room !== 'unassigned') ids.add(room);
    }
  }catch(e){}
  return [...ids];
}
function assertKnownRoomId(roomId, roomsPath = ROOMS_SETTINGS_PATH){
  const id = String(roomId||'').trim();
  if(!id) throw new Error('room_id не указан');
  if(id === 'overview') throw new Error('overview не является комнатой');
  const devicesPath = roomsPath === ROOMS_SETTINGS_PATH ? DEVICES_PATH : path.join(path.dirname(roomsPath), 'devices.js');
  const known = new Set(listKnownRoomIds({ roomsPath, devicesPath }));
  if(known.size && !known.has(id)) throw new Error(`Комната ${id} не найдена в конфигурации`);
  return id;
}
const STANDARD_SENSOR_KEYS = ['temperature','humidity','motion','noise','co2','illuminance'];

function defaultRoomsSettings(){ return { version: 1, rooms: {}, updatedAt: null }; }

function normalizeEntityId(value, options={}){
  const v = String(value || '').trim();
  if(!v) return '';
  if(!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(v)){
    if(options.strict) throw new Error(`Некорректный entity_id: ${v}`);
    logInfo('standardSensors', 'invalid entity_id ignored while loading', { entity_id:v });
    return '';
  }
  return v;
}

function normalizeStandardSensors(src, options={}){
  const out = {};
  if(!isPlainObject(src)) return out;
  for(const key of STANDARD_SENSOR_KEYS){
    const v = normalizeEntityId(src[key], { strict: options.strict === true });
    if(v) out[key] = v;
  }
  return out;
}
function normalizeRoomSettingsRoom(roomId, value){
  const current = isPlainObject(value) ? value : {};
  const out = { ...current };
  out.virtual = current.virtual === true;
  if(Array.isArray(current.hiddenDevices)) out.hiddenDevices = [...new Set(current.hiddenDevices.map(v=>normalizeEntityId(v, {strict:false})).filter(Boolean))];
  else if(Object.prototype.hasOwnProperty.call(current, 'hiddenDevices')) out.hiddenDevices = [];
  if(Object.prototype.hasOwnProperty.call(current, 'standardSensors')) out.standardSensors = normalizeStandardSensors(current.standardSensors);
  if(current.standardSensorOrientation === 'vertical') out.standardSensorOrientation = 'vertical';
  else if(Object.prototype.hasOwnProperty.call(current, 'standardSensorOrientation')) out.standardSensorOrientation = 'horizontal';
  if(current.standardSensorOverviewOrientation === 'vertical') out.standardSensorOverviewOrientation = 'vertical';
  else if(Object.prototype.hasOwnProperty.call(current, 'standardSensorOverviewOrientation')) out.standardSensorOverviewOrientation = 'horizontal';
  if(current.standardSensorRoomOrientation === 'vertical') out.standardSensorRoomOrientation = 'vertical';
  else if(Object.prototype.hasOwnProperty.call(current, 'standardSensorRoomOrientation')) out.standardSensorRoomOrientation = 'horizontal';
  return out;
}

function setRoomStandardSensorOrientation(roomId, orientation, roomsPath = ROOMS_SETTINGS_PATH, scope = 'room'){
  const id = assertKnownRoomId(roomId, roomsPath);
  const value = String(orientation || '').trim() === 'vertical' ? 'vertical' : 'horizontal';
  const normalizedScope = String(scope || '').trim() === 'overview' ? 'overview' : 'room';
  const key = normalizedScope === 'overview' ? 'standardSensorOverviewOrientation' : 'standardSensorRoomOrientation';
  const current = loadRoomsSettings(roomsPath);
  current.rooms[id] = { ...(current.rooms[id] || {}), [key]: value };
  const saved = saveRoomsSettings(current, roomsPath);
  return { ok:true, roomId:id, scope:normalizedScope, orientation:saved.rooms?.[id]?.[key] || 'horizontal', rooms:saved };
}

function setRoomHiddenDevices(roomId, hiddenDevices, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  const list = Array.isArray(hiddenDevices) ? hiddenDevices : [];
  const normalized = [...new Set(list.map(v=>normalizeEntityId(v, {strict:false})).filter(Boolean))];
  const current = loadRoomsSettings(roomsPath);
  current.rooms[id] = { ...(current.rooms[id] || {}), hiddenDevices: normalized };
  const saved = saveRoomsSettings(current, roomsPath);
  return { ok:true, roomId:id, hiddenDevices:saved.rooms?.[id]?.hiddenDevices || [], rooms:saved };
}
function setRoomVirtualFlag(roomId, virtual, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  const current = loadRoomsSettings(roomsPath);
  current.rooms[id] = { ...(current.rooms[id] || {}), virtual: virtual === true };
  const saved = saveRoomsSettings(current, roomsPath);
  return { ok:true, roomId:id, virtual:!!saved.rooms?.[id]?.virtual, rooms:saved };
}
function normalizeRoomsSettings(payload, options={}){
  const src = isPlainObject(payload) ? payload : defaultRoomsSettings();
  const rooms = {};
  const srcRooms = isPlainObject(src.rooms) ? src.rooms : {};
  const filterUnknownRooms = options.filterUnknownRooms === true;
  const explicitKnown = Array.isArray(options.knownRoomIds) ? options.knownRoomIds : null;
  const known = new Set(explicitKnown || []);
  // Non-destructive by default: load/DB hydration must never delete rooms or sensors.
  // Even in filtered mode an empty known set means “unknown”, not “delete everything”.
  for(const [roomId, value] of Object.entries(srcRooms)){
    if(filterUnknownRooms && known.size && !known.has(roomId)) continue;
    rooms[roomId] = normalizeRoomSettingsRoom(roomId, value);
  }
  return { version: Number(src.version) || 1, rooms, updatedAt: src.updatedAt || null, ...(src.importSummary ? {importSummary:src.importSummary} : {}) };
}
function loadRoomsSettings(roomsPath = ROOMS_SETTINGS_PATH){
  const fromDbOrFile = normalizeRoomsSettings(readJsonSafe(roomsPath, defaultRoomsSettings()), {filterUnknownRooms:false});
  seedDbStandardSensorsIfEmpty(fromDbOrFile, roomsPath);
  const withDbSensors = applyDbStandardSensorBindings(fromDbOrFile, roomsPath);
  // If DB table contains bindings, keep rooms document hydrated, but never write an empty normalized result over DB.
  try{
    const hasSensors = Object.values(withDbSensors.rooms || {}).some(r => Object.keys(normalizeStandardSensors(r?.standardSensors || {})).length);
    if(hasSensors && JSON.stringify(fromDbOrFile) !== JSON.stringify(withDbSensors)) atomicWriteJson(roomsPath, withDbSensors);
  }catch(e){}
  return withDbSensors;
}
function saveRoomsSettings(payload, roomsPath = ROOMS_SETTINGS_PATH){
  const next = normalizeRoomsSettings({ ...(payload||{}), updatedAt: new Date().toISOString() }, {filterUnknownRooms:false});
  const withDbSensors = syncRoomSettingsAndStandardSensorDb(next, roomsPath);
  atomicWriteJson(roomsPath, withDbSensors);
  return withDbSensors;
}

function standardSensorBindingsForRoom(roomsPath, roomId){
  try{
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()){
      const all = allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {};
      return normalizeStandardSensors(all[roomId] || {}, {strict:false});
    }
  }catch(e){ logError('standardSensors', 'read room bindings failed', {roomId, error:e.message}); }
  return {};
}

function verifyRoomStandardSensorSave(roomsPath, roomId, expected){
  const saved = canonicalStandardSensorsForCompare(standardSensorBindingsForRoom(roomsPath, roomId));
  const want = canonicalStandardSensorsForCompare(expected || {});
  if(!sameStandardSensors(saved, want)){
    logError('standardSensors', 'DB verify failed after save', {roomId, expected:want, saved});
    throw new Error(`Датчики не подтвердились в базе данных для комнаты ${roomId}`);
  }
  return saved;
}

function saveRoomStandardSensors(roomId, sensors, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  logInfo('standardSensors', 'save requested', {roomId:id, roomsPath, keys:Object.keys(sensors||{}), sensors});
  const current = loadRoomsSettings(roomsPath);
  const clean = normalizeStandardSensors(sensors || {}, {strict:true});
  if(!Object.keys(clean).length) throw new Error('Пустой набор датчиков не сохраняется. Для очистки используйте кнопку «Очистить» или «Очистить все».');
  current.rooms[id] = { ...(current.rooms[id] || {}), standardSensors: clean };
  try{
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()) {
      allhaDb.replaceRoomStandardSensorBindings(profileId, levelId, id, clean);
      verifyRoomStandardSensorSave(roomsPath, id, clean);
    }
  }catch(e){
    logError('standardSensors', 'DB room save failed', {roomId:id, error:e.message});
    throw e;
  }
  atomicWriteJson(roomsPath, applyDbStandardSensorBindings(current, roomsPath));
  const hydrated = loadRoomsSettings(roomsPath);
  logInfo('standardSensors', 'save confirmed', {roomId:id, dbBinding:standardSensorBindingsForRoom(roomsPath, id)});
  return hydrated;
}

function saveSingleRoomStandardSensor(roomId, sensorType, entityId, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  const key = String(sensorType || '').trim();
  if(!STANDARD_SENSOR_KEYS.includes(key)) throw new Error(`Неизвестный тип стандартного датчика: ${key}`);
  const value = normalizeEntityId(entityId, {strict:true});
  if(!value) throw new Error('entity_id не указан');
  const current = loadRoomsSettings(roomsPath);
  const existing = normalizeStandardSensors(current.rooms?.[id]?.standardSensors || {}, {strict:false});
  const nextSensors = { ...existing, [key]: value };
  current.rooms[id] = { ...(current.rooms[id] || {}), standardSensors: nextSensors };
  logInfo('standardSensors', 'save one requested', {roomId:id, sensorType:key, entityId:value, roomsPath, before:existing, after:nextSensors});
  try{
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()) {
      allhaDb.replaceRoomStandardSensorBindings(profileId, levelId, id, nextSensors);
      verifyRoomStandardSensorSave(roomsPath, id, nextSensors);
    }
  }catch(e){
    logError('standardSensors', 'DB room save-one failed', {roomId:id, sensorType:key, error:e.message});
    throw e;
  }
  atomicWriteJson(roomsPath, applyDbStandardSensorBindings(current, roomsPath));
  logInfo('standardSensors', 'save one confirmed', {roomId:id, sensorType:key, dbBinding:standardSensorBindingsForRoom(roomsPath, id)});
  return loadRoomsSettings(roomsPath);
}

function clearRoomStandardSensor(roomId, sensorType, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  logInfo('standardSensors', 'clear one requested', {roomId:id, sensorType, roomsPath});
  const key = String(sensorType || '').trim();
  if(!STANDARD_SENSOR_KEYS.includes(key)) throw new Error(`Неизвестный тип стандартного датчика: ${key}`);
  const current = loadRoomsSettings(roomsPath);
  const room = { ...(current.rooms[id] || {}) };
  const sensors = { ...(room.standardSensors || {}) };
  delete sensors[key];
  room.standardSensors = sensors;
  current.rooms[id] = room;
  try{
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()) allhaDb.replaceRoomStandardSensorBindings(profileId, levelId, id, sensors);
  }catch(e){ console.warn('[standardSensors] DB clear failed:', e.message); }
  atomicWriteJson(roomsPath, applyDbStandardSensorBindings(current, roomsPath));
  return loadRoomsSettings(roomsPath);
}
function clearAllRoomStandardSensors(roomId, roomsPath = ROOMS_SETTINGS_PATH){
  const id = assertKnownRoomId(roomId, roomsPath);
  logInfo('standardSensors', 'clear all requested', {roomId:id, roomsPath});
  const current = loadRoomsSettings(roomsPath);
  current.rooms[id] = { ...(current.rooms[id] || {}), standardSensors: {} };
  try{
    const { profileId, levelId } = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()) allhaDb.clearAllStandardSensorBindingsForRoom(profileId, levelId, id);
  }catch(e){ console.warn('[standardSensors] DB clear-all failed:', e.message); }
  atomicWriteJson(roomsPath, applyDbStandardSensorBindings(current, roomsPath));
  return loadRoomsSettings(roomsPath);
}
function mergeParsedRoomsIntoSettings(parsed, roomsPath = ROOMS_SETTINGS_PATH){
  const currentRaw = loadRoomsSettings(roomsPath);
  const oldRooms = isPlainObject(currentRaw.rooms) ? currentRaw.rooms : {};
  let dbBindings = {};
  try{
    const {profileId, levelId} = profileLevelFromRoomsPath(roomsPath);
    if(allhaDb.hasDb && allhaDb.hasDb()) dbBindings = allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {};
  }catch(e){}
  const parsedRooms = new Map();
  for(const d of parsed?.devices || []){
    const id = String(d?.room || '').trim();
    if(!id || id === 'overview' || id === 'unassigned') continue;
    if(!parsedRooms.has(id)) parsedRooms.set(id, { id, label: d.roomLabel || d.room_name || friendlyRoomLabel(id), source: d.roomSource || 'lovelace-import', entities:0 });
    parsedRooms.get(id).entities += 1;
  }
  const oldIndex = new Map();
  for(const [oldId, oldRoom] of Object.entries(oldRooms)){
    const withDb = { ...oldRoom, standardSensors: { ...normalizeStandardSensors(dbBindings[oldId] || {}), ...normalizeStandardSensors(oldRoom?.standardSensors || {}) } };
    for(const k of roomKeyVariants(oldId, withDb)) if(k && !oldIndex.has(k)) oldIndex.set(k, {id:oldId, room:withDb});
  }
  const nextRooms = {};
  for(const [id, meta] of parsedRooms.entries()){
    const keys = roomKeyVariants(id, {alias:meta.label, label:meta.label, name:meta.label});
    let match = oldRooms[id] ? {id, room:oldRooms[id]} : null;
    if(!match){ for(const k of keys){ if(oldIndex.has(k)){ match = oldIndex.get(k); break; } } }
    const prev = match?.room || {};
    const directDbSensors = normalizeStandardSensors(dbBindings[id] || {});
    const prevSensors = { ...directDbSensors, ...normalizeStandardSensors(prev.standardSensors || {}) };
    nextRooms[id] = normalizeRoomSettingsRoom(id, {
      ...prev,
      alias: prev.alias || meta.label || id,
      label: prev.label || meta.label || id,
      source: meta.source || prev.source || 'lovelace-import',
      importedEntities: meta.entities,
      updatedAt: new Date().toISOString(),
      standardSensors: prevSensors
    });
  }
  const next = { version:Number(currentRaw.version)||1, rooms:nextRooms, updatedAt:new Date().toISOString(), importSummary:{ rooms:parsedRooms.size, entities:(parsed?.devices||[]).length, source:'lovelace-import' } };
  return saveRoomsSettings(next, roomsPath);
}
function resetInvalidSelectedRoomAfterImport(validRoomIds, uiPath = UI_STATE_PATH){
  try{
    const ui = readJsonSafe(uiPath, null);
    if(!ui || typeof ui !== 'object') return false;
    const selected = String(ui.selectedRoom || '').trim();
    if(selected && selected !== 'overview' && !validRoomIds.has(selected)){
      ui.selectedRoom = 'overview';
      atomicWriteJson(uiPath, ui);
      return true;
    }
  }catch(e){}
  return false;
}
function entityDomain(entityId){ return String(entityId||'').split('.')[0] || ''; }
function textForSuggestion(device, stateObj){
  const parts = [
    device?.entity_id, device?.name, device?.friendly_name, device?.label, device?.room, device?.roomLabel,
    stateObj?.attributes?.friendly_name, stateObj?.attributes?.device_class, stateObj?.attributes?.unit_of_measurement,
    stateObj?.attributes?.state_class
  ];
  return parts.map(x=>String(x||'').toLowerCase()).join(' ');
}
function standardSensorTypeEvidence(key, entityId, device, stateObj){
  const domain = entityDomain(entityId);
  const txt = textForSuggestion(device, stateObj);
  const dc = String(stateObj?.attributes?.device_class || device?.device_class || '').toLowerCase();
  const unit = String(stateObj?.attributes?.unit_of_measurement || '').toLowerCase();
  const has = (...words)=>words.some(w=>txt.includes(w));
  if(key === 'temperature') return (domain === 'sensor') && (dc === 'temperature' || has('temperature','temp','температур'));
  if(key === 'humidity') return (domain === 'sensor') && (dc === 'humidity' || has('humidity','влажн'));
  if(key === 'motion') return (domain === 'binary_sensor' || domain === 'sensor') && (['motion','presence','occupancy'].includes(dc) || has('motion','presence','occupancy','движ','присутств'));
  if(key === 'illuminance') return (domain === 'sensor') && (dc === 'illuminance' || has('illuminance','lux','light_level','освещ'));
  if(key === 'noise') return (domain === 'sensor') && (['sound_pressure','sound_level'].includes(dc) || has('sound_level','noise','sound','шум'));
  if(key === 'co2') return (domain === 'sensor') && (['carbon_dioxide','co2'].includes(dc) || has('co2','carbon_dioxide','carbon dioxide','углекисл'));
  return false;
}
function scoreStandardSensorSuggestion(key, entityId, device, stateObj, roomId){
  // Strict matcher: if there is no type evidence, do not suggest anything. Same-room alone is not enough.
  if(!standardSensorTypeEvidence(key, entityId, device, stateObj)) return 0;
  const domain = entityDomain(entityId);
  const txt = textForSuggestion(device, stateObj);
  let score = 0;
  if(String(device?.room || '').trim() === roomId) score += 50;
  if(String(device?.area || '').trim() === roomId) score += 25;
  if(domain === 'sensor') score += 8;
  if(domain === 'binary_sensor') score += key === 'motion' ? 12 : -20;
  const dc = String(stateObj?.attributes?.device_class || device?.device_class || '').toLowerCase();
  const unit = String(stateObj?.attributes?.unit_of_measurement || '').toLowerCase();
  const has = (...words)=>words.some(w=>txt.includes(w));
  if(key === 'temperature') { if(dc === 'temperature') score += 80; if(has('temperature','temp','температур')) score += 45; if(unit.includes('°') || unit === 'c' || unit.includes('°c')) score += 10; }
  if(key === 'humidity') { if(dc === 'humidity') score += 80; if(has('humidity','влажн')) score += 45; if(unit === '%' || unit.includes('%')) score += 10; }
  if(key === 'motion') { if(['motion','presence','occupancy'].includes(dc)) score += 80; if(has('motion','presence','occupancy','движ','присутств')) score += 45; }
  if(key === 'illuminance') { if(dc === 'illuminance') score += 80; if(has('illuminance','lux','light_level','освещ')) score += 45; if(unit.includes('lx') || unit.includes('lux')) score += 10; }
  if(key === 'noise') { if(['sound_pressure','sound_level'].includes(dc)) score += 80; if(has('sound_level','noise','sound','шум')) score += 45; if(unit.includes('db')) score += 10; }
  if(key === 'co2') { if(['carbon_dioxide','co2'].includes(dc)) score += 90; if(has('co2','carbon_dioxide','carbon dioxide','углекисл')) score += 60; if(unit.includes('ppm')) score += 10; }
  return score;
}
function standardSensorSuggestionReason(key, entityId, device, stateObj, roomId){
  const dc = String(stateObj?.attributes?.device_class || device?.device_class || '').toLowerCase();
  const unit = String(stateObj?.attributes?.unit_of_measurement || '').toLowerCase();
  const roomLabel = friendlyRoomLabel(roomId);
  if(dc) return `найдено по device_class ${dc}${String(device?.room || '') === roomId ? ` · комната ${roomLabel}` : ''}`;
  if(unit) return `найдено по unit ${unit}${String(device?.room || '') === roomId ? ` · комната ${roomLabel}` : ''}`;
  if(String(device?.room || '') === roomId) return `найдено по entity/name и комнате ${roomLabel}`;
  return `найдено по entity/name`;
}
function standardSensorSuggestionsForRoom(roomId, options={}){
  const roomsPath = options.roomsPath || ROOMS_SETTINGS_PATH;
  const devicesPath = options.devicesPath || (roomsPath === ROOMS_SETTINGS_PATH ? DEVICES_PATH : path.join(path.dirname(roomsPath), 'devices.js'));
  const rid = assertKnownRoomId(roomId, roomsPath);
  logInfo('standardSensors', 'suggest requested', {roomId:rid, roomsPath, devicesPath});
  const devices = parseJsAssignedArray(devicesPath, 'ALL_DEVICES');
  const allStates = statesCache instanceof Map ? [...statesCache.values()] : [];
  const byId = new Map();
  for(const d of devices){ if(d?.entity_id) byId.set(d.entity_id, d); }
  for(const st of allStates){ if(st?.entity_id && !byId.has(st.entity_id)) byId.set(st.entity_id, { entity_id:st.entity_id, name:st.attributes?.friendly_name || st.entity_id, domain:entityDomain(st.entity_id), room:'' }); }
  const candidates = [...byId.values()].filter(d=>{
    const eid=String(d?.entity_id||'');
    const domain=entityDomain(eid);
    if(!['sensor','binary_sensor'].includes(domain)) return false;
    const sameRoom = String(d?.room||'') === rid || String(d?.area||'') === rid || String(d?.room_id||'') === rid;
    const stateObj = statesCache?.get?.(eid);
    const txt = textForSuggestion(d, stateObj);
    return sameRoom || txt.includes(rid.toLowerCase()) || txt.includes(friendlyRoomLabel(rid).toLowerCase());
  });
  const out = {};
  for(const key of STANDARD_SENSOR_KEYS){
    const scored = candidates.map(d=>{
      const eid=String(d.entity_id||'');
      const st=statesCache?.get?.(eid);
      const score=scoreStandardSensorSuggestion(key, eid, d, st, rid);
      return { entity_id:eid, name:d.name || d.friendly_name || st?.attributes?.friendly_name || eid, domain:entityDomain(eid), score, device_class:st?.attributes?.device_class || d.device_class || '', unit:st?.attributes?.unit_of_measurement || '', reason:standardSensorSuggestionReason(key, eid, d, st, rid) }; 
    }).filter(x=>x.score>25).sort((a,b)=>b.score-a.score || a.entity_id.localeCompare(b.entity_id)).slice(0,5);
    out[key]=scored;
  }
  return { roomId:rid, suggestions:out, totalCandidates:candidates.length };
}
function roomSourcesForApi(options={}){
  const roomsPath = options.roomsPath || ROOMS_SETTINGS_PATH;
  const devicesPath = options.devicesPath || (roomsPath === ROOMS_SETTINGS_PATH ? DEVICES_PATH : path.join(path.dirname(roomsPath), 'devices.js'));
  const settings = loadRoomsSettings(roomsPath);
  const labelByRoom = {};
  try{
    const devices = parseJsAssignedArray(devicesPath, 'ALL_DEVICES');
    for(const d of devices){
      const rid = String(d?.room || '').trim();
      if(rid && !labelByRoom[rid]) labelByRoom[rid] = d.roomLabel || d.room_name || rid;
    }
  }catch(e){}
  return listKnownRoomIds({ roomsPath, devicesPath }).map(id => ({ id, label: settings.rooms[id]?.alias || labelByRoom[id] || friendlyRoomLabel(id), source: settings.rooms[id]?.source || 'detected', settings: settings.rooms[id] || {} }));
}
function imagesDiagnostics(){
  const metaOk = (()=>{ try{ loadImagesMeta(); return true; }catch(e){ return false; } })();
  const rooms = listKnownRoomIds();
  const customRooms = fs.existsSync(DATA_IMAGES_ROOMS_DIR) ? fs.readdirSync(DATA_IMAGES_ROOMS_DIR).filter(f=>/\.(webp|png|jpe?g)$/i.test(f)).length : 0;
  return {
    dataImagesDir: DATA_IMAGES_DIR,
    overviewDir: DATA_IMAGES_OVERVIEW_DIR,
    roomsDir: DATA_IMAGES_ROOMS_DIR,
    originalsDir: DATA_IMAGES_ORIGINALS_DIR,
    exists: fs.existsSync(DATA_IMAGES_DIR),
    overviewDirExists: fs.existsSync(DATA_IMAGES_OVERVIEW_DIR),
    roomsDirExists: fs.existsSync(DATA_IMAGES_ROOMS_DIR),
    originalsDirExists: fs.existsSync(DATA_IMAGES_ORIGINALS_DIR),
    originalsRoomsDirExists: fs.existsSync(DATA_IMAGES_ORIGINALS_ROOMS_DIR),
    backupsDirExists: fs.existsSync(LAYOUT_BACKUP_DIR),
    metaPath: IMAGES_META_PATH,
    metaExists: fs.existsSync(IMAGES_META_PATH),
    metaOk,
    overview: imageInfo('overview'),
    roomCount: rooms.length,
    customRoomImages: customRooms,
    converterAvailable: !!sharp,
    uploadLimits: IMAGE_UPLOAD_LIMITS
  };
}

function cachedHaStatesList(){
  return statesCache instanceof Map && statesCache.size > 0 ? [...statesCache.values()] : [];
}
async function haStatesForDiagnostics(){
  const cached = cachedHaStatesList();
  if(cached.length) return { states: cached, source: 'cache', error: null };
  try{ return { states: await haFetch('/states'), source: 'http', error: null }; }
  catch(e){ return { states: [], source: 'error', error: e.message }; }
}

async function buildDiagnostics(req=null){
  const devices=loadAllDevicesForDiagnostics();
  const haStatePack = await haStatesForDiagnostics();
  let haStates=haStatePack.states || []; let haError=haStatePack.error || null;
  const haIds=new Set(haStates.map(s=>s.entity_id));
  const counts={}; const duplicates=[];
  for(const d of devices){ if(!d.entity_id) continue; counts[d.entity_id]=(counts[d.entity_id]||0)+1; }
  for(const [id,n] of Object.entries(counts)) if(n>1) duplicates.push({entity_id:id,count:n});
  const missing=devices.filter(d=>d.entity_id && !haIds.has(d.entity_id)).map(d=>({entity_id:d.entity_id,name:d.name||d.label||'',room:d.room||''}));
  const noRoom=devices.filter(d=>!d.room).map(d=>d.entity_id).filter(Boolean);
  const layout=loadLayout();
  const layoutDiagnostics=analyzeLayout(layout);
  const markers=Object.assign({}, layoutDiagnostics.normalizedPreview?.overviewMarkers||layout.overviewMarkers||{});
  for(const map of Object.values(layoutDiagnostics.normalizedPreview?.roomMarkers||layout.roomMarkers||{})) Object.assign(markers,map||{});
  const noCoordinates=devices.filter(d=>d.entity_id && !markers[d.entity_id]).map(d=>d.entity_id);
  return {
    ok: !haError,
    version: ADDON_VERSION,
    brand: { name: APP_BRAND, developer: APP_DEVELOPER, github: APP_GITHUB, copyright: APP_COPYRIGHT },
    mode: 'home-assistant-addon',
    dataDir: DATA_DIR,
    hasSupervisorToken: !!HA_TOKEN,
    liveStatesCache: statesCache.size,
    haStatesSource: haStatePack.source,
    dashboardProxy: { ...dashboardProxyInfo(req), directLocal: directLocalDashboardInfo(req) },
    haError,
    counts: { devices: devices.length, haStates: haStates.length, missingInHa: missing.length, duplicates: duplicates.length, noRoom: noRoom.length, noCoordinates: noCoordinates.length, backups: backupSummary().count },
    images: imagesDiagnostics(),
    profiles: profilesDiagnostics(),
    missingInHa: missing.slice(0,200), duplicates: duplicates.slice(0,200), noRoom: noRoom.slice(0,200), noCoordinates: noCoordinates.slice(0,200),
    backups: backupSummary(),
    storage: { dataDir: DATA_DIR, layoutPath: LAYOUT_PATH, addonConfigPath: ADDON_CONFIG_PATH, sourceConfigPath: SOURCE_CONFIG_PATH, uiStatePath: UI_STATE_PATH, attentionRulesPath: ATTENTION_RULES_PATH, securityRulesPath: SECURITY_RULES_PATH, profilesPath: PROFILES_META_PATH, profilesDir: PROFILES_DIR, activeProfileId: ACTIVE_PROFILE_ID, activeProfileDir: ACTIVE_PROFILE_DIR, activeLevelId: ACTIVE_LEVEL_ID, activeLevelDir: ACTIVE_LEVEL_DIR, levelsMetaPath: levelsMetaPath(ACTIVE_PROFILE_ID), roomsSettingsPath: ROOMS_SETTINGS_PATH, devicesPath: DEVICES_PATH, lovelacePath: LOVELACE_PATH, dataExists: fs.existsSync(DATA_DIR), imagesDir: DATA_IMAGES_DIR, imagesMetaPath: IMAGES_META_PATH, imagesExists: fs.existsSync(DATA_IMAGES_DIR), imagesMetaExists: runtimeDocumentExists(IMAGES_META_PATH), layoutExists: runtimeDocumentExists(LAYOUT_PATH), uiStateExists: runtimeDocumentExists(UI_STATE_PATH), roomsSettingsExists: runtimeDocumentExists(ROOMS_SETTINGS_PATH), devicesInData: runtimeFileExists(DEVICES_PATH), lovelaceInData: runtimeFileExists(LOVELACE_PATH), fallbackDevicesPath: FALLBACK_DEVICES_PATH, fallbackDevicesExists: fs.existsSync(FALLBACK_DEVICES_PATH) },
    layoutDiagnostics,
    allowedServices: ALLOWED_SERVICES,
    safeServices: SAFE_SERVICES,
    dangerousServices: DANGEROUS_SERVICES,
    security: normalizeSecurityConfig(loadAddonConfig().security),
    commandLog: loadCommandLog(),
    generatedAt: new Date().toISOString()
  };
}
function loadLayout(layoutPath = LAYOUT_PATH){ return readJsonSafe(layoutPath, {version:1, markers:{}}); }
function timestampForFile(){ return new Date().toISOString().replace(/[:.]/g,'-'); }
function backupLayout(){
  if(!autoBackupsEnabled()) return null;
  const layout = loadLayout();
  if(!layout) return null;
  fs.mkdirSync(LAYOUT_BACKUP_DIR,{recursive:true});
  const backupPath = path.join(LAYOUT_BACKUP_DIR, `layout-${timestampForFile()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(layout, null, 2), 'utf8');
  return backupPath;
}
function saveLayout(layout, layoutPath = LAYOUT_PATH){
  fs.mkdirSync(path.dirname(layoutPath),{recursive:true});
  const normalized = normalizeLayoutPayload(layout || {version:8}, {strict:false});
  const payload = normalized.layout;
  let backupPath = null;
  if(autoBackupsEnabled() && runtimeDocumentExists(layoutPath)){
    fs.mkdirSync(LAYOUT_BACKUP_DIR,{recursive:true});
    backupPath = path.join(LAYOUT_BACKUP_DIR, `layout-${timestampForFile()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(readJsonSafe(layoutPath, emptyLayout()), null, 2), 'utf8');
    pruneLayoutBackups(20);
  }
  atomicWriteJson(layoutPath, payload);
  return backupPath;
}

function defaultSourceConfig(){
  return {
    version: 1,
    selectedCards: {},
    defaultInclude: true,
    excludedCards: {
      'Физические устройства::Системные': true,
      'Вирт.устройства::Вирт.устройства': true
    },
    includeUnknownFromApi: false,
    dashboardPaths: []
  };
}
function loadSourceConfig(srcPath = SOURCE_CONFIG_PATH){
  return { ...defaultSourceConfig(), ...readJsonSafe(srcPath, {}) };
}
function saveSourceConfig(cfg, srcPath = SOURCE_CONFIG_PATH){
  atomicWriteJson(srcPath, { ...defaultSourceConfig(), ...(cfg || {}) });
}
function loadSourceConfigForLevel(profileId, levelId){
  const lp = ensureLevelDirs(profileId || ACTIVE_PROFILE_ID, levelId || ACTIVE_LEVEL_ID);
  return { ...defaultSourceConfig(), ...readJsonSafe(lp.sourceConfig, {}) };
}
function saveSourceConfigForLevel(profileId, levelId, cfg){
  const lp = ensureLevelDirs(profileId || ACTIVE_PROFILE_ID, levelId || ACTIVE_LEVEL_ID);
  fs.mkdirSync(path.dirname(lp.sourceConfig), {recursive:true});
  const hasDashboardPathText = Object.prototype.hasOwnProperty.call(cfg || {}, 'dashboardPathText');
  const sourceInput = hasDashboardPathText ? cfg.dashboardPathText : (cfg?.dashboardPaths ?? '');
  const dashboardPaths = normalizeDashboardPaths(sourceInput);
  const normalized = {
    ...defaultSourceConfig(),
    ...(cfg || {}),
    dashboardPaths,
    dashboardPathText: dashboardPaths.join('\n')
  };
  atomicWriteJson(lp.sourceConfig, normalized);
  if(sanitizeProfileId(profileId || ACTIVE_PROFILE_ID) === ACTIVE_PROFILE_ID && sanitizeLevelId(levelId || ACTIVE_LEVEL_ID) === ACTIVE_LEVEL_ID){
    SOURCE_CONFIG_PATH = lp.sourceConfig;
  }
  return normalized;
}
async function withTemporaryLevel(profileId, levelId, fn){
  const prev = { ACTIVE_PROFILE_ID, ACTIVE_PROFILE_DIR, ACTIVE_LEVEL_ID, ACTIVE_LEVEL_DIR, LAYOUT_PATH, SOURCE_CONFIG_PATH, UI_STATE_PATH, DATA_IMAGES_DIR, DATA_IMAGES_OVERVIEW_DIR, DATA_IMAGES_ROOMS_DIR, DATA_IMAGES_ORIGINALS_DIR, DATA_IMAGES_ORIGINALS_ROOMS_DIR, IMAGES_META_PATH, ROOMS_SETTINGS_PATH, DEVICES_PATH, LOVELACE_PATH };
  try{
    const pid = sanitizeProfileId(profileId || ACTIVE_PROFILE_ID);
    const lid = sanitizeLevelId(levelId || ACTIVE_LEVEL_ID);
    const pp = profilePaths(pid);
    const lp = ensureLevelDirs(pid, lid);
    ACTIVE_PROFILE_ID = pid; ACTIVE_PROFILE_DIR = pp.dir; ACTIVE_LEVEL_ID = lid; ACTIVE_LEVEL_DIR = lp.dir;
    LAYOUT_PATH = lp.layout; SOURCE_CONFIG_PATH = lp.sourceConfig; UI_STATE_PATH = lp.uiState;
    DATA_IMAGES_DIR = lp.images; DATA_IMAGES_OVERVIEW_DIR = path.join(DATA_IMAGES_DIR, 'overview'); DATA_IMAGES_ROOMS_DIR = path.join(DATA_IMAGES_DIR, 'rooms');
    DATA_IMAGES_ORIGINALS_DIR = path.join(DATA_IMAGES_DIR, 'originals'); DATA_IMAGES_ORIGINALS_ROOMS_DIR = path.join(DATA_IMAGES_ORIGINALS_DIR, 'rooms');
    IMAGES_META_PATH = lp.imagesMeta; ROOMS_SETTINGS_PATH = lp.rooms; DEVICES_PATH = lp.devicesJs; LOVELACE_PATH = lp.lovelaceJs;
    return await fn(lp);
  } finally {
    Object.assign(globalThis, {});
    ACTIVE_PROFILE_ID = prev.ACTIVE_PROFILE_ID; ACTIVE_PROFILE_DIR = prev.ACTIVE_PROFILE_DIR; ACTIVE_LEVEL_ID = prev.ACTIVE_LEVEL_ID; ACTIVE_LEVEL_DIR = prev.ACTIVE_LEVEL_DIR;
    LAYOUT_PATH = prev.LAYOUT_PATH; SOURCE_CONFIG_PATH = prev.SOURCE_CONFIG_PATH; UI_STATE_PATH = prev.UI_STATE_PATH; DATA_IMAGES_DIR = prev.DATA_IMAGES_DIR;
    DATA_IMAGES_OVERVIEW_DIR = prev.DATA_IMAGES_OVERVIEW_DIR; DATA_IMAGES_ROOMS_DIR = prev.DATA_IMAGES_ROOMS_DIR; DATA_IMAGES_ORIGINALS_DIR = prev.DATA_IMAGES_ORIGINALS_DIR; DATA_IMAGES_ORIGINALS_ROOMS_DIR = prev.DATA_IMAGES_ORIGINALS_ROOMS_DIR;
    IMAGES_META_PATH = prev.IMAGES_META_PATH; ROOMS_SETTINGS_PATH = prev.ROOMS_SETTINGS_PATH; DEVICES_PATH = prev.DEVICES_PATH; LOVELACE_PATH = prev.LOVELACE_PATH;
  }
}
async function importLovelaceRawForLevel(profileId, levelId, paths){
  return await withTemporaryLevel(profileId || ACTIVE_PROFILE_ID, levelId || ACTIVE_LEVEL_ID, async()=>{
    const cfg = loadSourceConfig();
    const sourcePaths = paths ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const result = await importLovelaceRaw(sourcePaths);
    return result;
  });
}

function summarizeLovelaceRawConfig(result){
  if(!result || !result.ok) return { ok:false, dashboardPath:result?.dashboardPath || '', error:result?.error || 'not read', viewFilters:result?.viewFilters || [] };
  const config = unwrapLovelaceConfig(result.rawConfig ?? result.raw ?? {});
  const views = Array.isArray(config.views) ? config.views : [];
  let cards = 0;
  let entities = new Set();
  for(const view of views){
    const viewCards = getCardsFromView(view);
    cards += viewCards.length;
    for(const card of viewCards){
      const refs = collectEntityRefs(card, []);
      for(const ref of refs) if(ref?.entity_id) entities.add(ref.entity_id);
    }
  }
  return {
    ok:true,
    dashboardPath:result.dashboardPath || result.raw || 'lovelace',
    viewFilters:result.viewFilters || [],
    views:views.length,
    cards,
    entities:entities.size,
    modeHint:'storage/dashboard API',
    yamlMode:'unknown'
  };
}
function buildLovelaceDiagnosticsForLevel(profileId, levelId){
  const pid = sanitizeProfileId(profileId || ACTIVE_PROFILE_ID);
  const lid = sanitizeLevelId(levelId || ACTIVE_LEVEL_ID);
  const lp = ensureLevelDirs(pid, lid);
  const cfg = loadSourceConfigForLevel(pid, lid);
  const dashboardPaths = normalizeDashboardPaths(cfg.dashboardPaths ?? cfg.dashboardPathText ?? '');
  const rawBundle = readJsonSafe(lp.lovelaceRaw, null);
  const parseReport = readJsonSafe(lp.deviceParseReportJson, null);
  let devices = [];
  try{ devices = parseJsAssignedArray(lp.devicesJs, 'ALL_DEVICES'); }catch(e){ try{ devices = readJsonSafe(lp.devicesJson, []); }catch(_){ devices=[]; } }
  const sourceKeys = new Map();
  for(const d of Array.isArray(devices)?devices:[]){
    const key = String(d.sourceKey || `${d.viewTitle || 'RAW'}::${d.cardTitle || d.category || 'Без группы'}`);
    if(!sourceKeys.has(key)) sourceKeys.set(key, { sourceKey:key, count:0, roomIds:new Set(), domains:new Set(), enabled:true });
    const item = sourceKeys.get(key);
    item.count++;
    if(d.room) item.roomIds.add(d.room);
    if(d.domain) item.domains.add(d.domain);
  }
  const selectedCards = cfg.selectedCards || {};
  const excludedCards = cfg.excludedCards || {};
  const sourceSummary = [...sourceKeys.values()].map(x=>({
    sourceKey:x.sourceKey,
    devices:x.count,
    rooms:[...x.roomIds],
    domains:[...x.domains],
    enabled:Object.prototype.hasOwnProperty.call(selectedCards, x.sourceKey) ? !!selectedCards[x.sourceKey] : (!(excludedCards||{})[x.sourceKey] && cfg.defaultInclude !== false)
  })).sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey,'ru'));
  const unassignedDevices = (Array.isArray(devices)?devices:[]).filter(d=>!d.room || d.room==='unassigned').slice(0,200).map(d=>({ entity_id:d.entity_id, name:d.name || d.label || '', sourceKey:d.sourceKey || '', reason:'room not detected' }));
  const rawResults = Array.isArray(rawBundle?.results) ? rawBundle.results : [];
  return {
    ok:true,
    profileId:pid,
    levelId:lid,
    generatedAt:new Date().toISOString(),
    sourceConfig:{ dashboardPaths, defaultInclude:cfg.defaultInclude!==false, selectedCardsCount:Object.keys(selectedCards||{}).length, excludedCardsCount:Object.keys(excludedCards||{}).length, includeUnknownFromApi:!!cfg.includeUnknownFromApi },
    raw:{ exists:!!rawBundle, generatedAt:rawBundle?.generatedAt || null, requested:rawBundle?.requested || dashboardPaths, dashboards:rawResults.map(summarizeLovelaceRawConfig), errors:rawResults.filter(r=>!r.ok).map(r=>({dashboardPath:r.dashboardPath||r.raw||'', error:r.error||''})) },
    import:{ exists:!!parseReport, devices:Array.isArray(devices)?devices.length:0, views:Number(parseReport?.views||0), cards:Number(parseReport?.cards||0), rooms:Number(parseReport?.rooms||0), entitiesFound:Number(parseReport?.entitiesFound||0), roomsFromCardTitles:Number(parseReport?.roomsFromCardTitles||0), templatesUsed:Array.isArray(parseReport?.templatesUsed)?parseReport.templatesUsed:[], templateWarnings:Array.isArray(parseReport?.templateWarnings)?parseReport.templateWarnings:[], skippedViews:Array.isArray(parseReport?.skippedViews)?parseReport.skippedViews:[], viewDetails:Array.isArray(parseReport?.viewDetails)?parseReport.viewDetails:[], roomDetails:Array.isArray(parseReport?.roomDetails)?parseReport.roomDetails:[], haRegistry:parseReport?.haRegistry || null },
    sources:sourceSummary,
    notPlacedOrUnassigned:unassignedDevices,
    notes:[
      'RAW читается через persistent HA WebSocket command lovelace/config.',
      'YAML/storage режим определяется Home Assistant; если dashboard не читается через lovelace/config, ошибка будет в raw.errors.',
      'Перечитать уровень использует сохранённые sources, если request не передал новые dashboardPaths/dashboardPathText.'
    ]
  };
}
function buildLovelaceDiagnosticsAllLevels(){
  const profilesMeta = loadProfilesMeta();
  return profilesMeta.profiles.map(p=>{
    const levelsMeta = loadLevelsMeta(p.id);
    return {
      profileId:p.id,
      profileName:p.name,
      activeLevelId:levelsMeta.activeLevelId,
      levels:levelsMeta.levels.map(l=>{
        const d = buildLovelaceDiagnosticsForLevel(p.id, l.id);
        return { levelId:l.id, levelName:l.name, sourceConfig:d.sourceConfig, raw:d.raw, import:d.import, sourcesCount:d.sources.length, unassignedCount:d.notPlacedOrUnassigned.length };
      })
    };
  });
}


ensureDataStore();

// v3.6.0.4: capture the real Home Assistant ingress proxy URL for Webpage dashboards.
// Home Assistant exposes add-ons through /api/hassio_ingress/<token>/.
// The token/path is discovered from X-Ingress-Path and shown in diagnostics as "Адрес для дашборда".
app.use((req, res, next) => {
  const info = getDashboardProxyFromRequest(req);
  if (info.dashboardUrl) saveDashboardProxyState(info);
  next();
});

// v3.6.0: direct web path for reverse proxies that explicitly map this add-on.
// Note: HA Webpage dashboards generally need the discovered /api/hassio_ingress/... URL above.
const DIRECT_WEB_PREFIX = '/allha-2d-direct';
app.use((req, res, next) => {
  if (req.url === DIRECT_WEB_PREFIX) return res.redirect(302, DIRECT_WEB_PREFIX + '/');
  if (req.url.startsWith(DIRECT_WEB_PREFIX + '/')) {
    req.url = req.url.slice(DIRECT_WEB_PREFIX.length) || '/';
    res.setHeader('X-ALLHA-Direct-Path', DIRECT_WEB_PREFIX);
  }
  next();
});
app.use(express.json({limit:'1mb'}));

// Lightweight debug log: no full HTTP trace by default. Only errors when ALLHA_DEBUG_HTTP=1.
app.use((req,res,next)=>{
  if(DEBUG_LOG_HTTP) debugLogResponse(req,res,'http-error');
  next();
});

app.post('/api/debug/client-event', express.json({limit:'64kb'}), (req,res)=>{
  try{
    if(DEBUG_LOG_CLIENT_EVENTS){
      writeDebugLog('client-event', String(req.body?.event || 'event'), {
        client:req.body?.client || {},
        payload:req.body?.payload || {},
        deviceId:req.headers['x-device-id'] || '',
        clientId:req.headers['x-client-id'] || ''
      });
    }
    res.json({ok:true});
  }catch(e){ safeErrorResponse(req,res,e); }
});

function logFilesSummary(){
  try{
    fs.mkdirSync(DEBUG_LOG_DIR,{recursive:true});
    return fs.readdirSync(DEBUG_LOG_DIR).filter(n=>n.startsWith('allha2d-debug') && n.endsWith('.log')).map(n=>{
      const fp=path.join(DEBUG_LOG_DIR,n); const st=fs.statSync(fp);
      return { name:n, size:st.size, mtime:st.mtime.toISOString() };
    }).sort((a,b)=>String(b.mtime).localeCompare(String(a.mtime)));
  }catch(e){ return []; }
}
function clearDebugLogs(){
  let removed=0;
  try{ for(const f of logFilesSummary()){ fs.unlinkSync(path.join(DEBUG_LOG_DIR,f.name)); removed++; } }catch(e){}
  return { removed };
}

app.get('/api/debug/log/status', (req,res)=>{
  try{
    const exists = fs.existsSync(DEBUG_LOG_PATH);
    const st = exists ? fs.statSync(DEBUG_LOG_PATH) : null;
    res.json({ok:true, enabled:DEBUG_LOG_ENABLED, httpTrace:DEBUG_LOG_HTTP, clientEvents:DEBUG_LOG_CLIENT_EVENTS, path:DEBUG_LOG_PATH, exists, size:st?.size || 0});
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.get('/api/debug/log/tail', (req,res)=>{
  try{
    flushDebugLog();
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 300)));
    if(!fs.existsSync(DEBUG_LOG_PATH)) return res.type('text/plain').send('');
    const text = fs.readFileSync(DEBUG_LOG_PATH, 'utf8');
    const lines = text.trim().split(/\n/).slice(-limit).join('\n');
    res.type('text/plain').send(lines + (lines ? '\n' : ''));
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/debug/log/clear', (req,res)=>{
  try{
    fs.mkdirSync(DEBUG_LOG_DIR,{recursive:true});
    fs.writeFileSync(DEBUG_LOG_PATH, '', 'utf8');
    writeDebugLog('debug-log','cleared',{});
    res.json({ok:true,path:DEBUG_LOG_PATH});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/dashboard-info', (req,res)=>{
  try{
    const info = dashboardProxyInfo(req);
    res.json({ ok:true, ...info, directRoute:'/allha-2d-direct/', directLocal: directLocalDashboardInfo(req), recommended: info.dashboardUrl || directLocalDashboardInfo(req).url || 'Откройте add-on через ingress, затем обновите эту страницу.', candidates: info.candidates || dashboardUrlCandidates(info.dashboardUrl) });
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.get('/devices.js', (req,res)=>{
  const generated = DEVICES_PATH;
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.type('application/javascript');
  const txt = readTextRuntimeFile(generated, 'window.ALL_DEVICES = [];\nwindow.DEVICES = [];\n');
  return res.send(txt);
});
app.get('/lovelace-source.js', (req,res)=>{
  const generated = LOVELACE_PATH;
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.type('application/javascript');
  const txt = readTextRuntimeFile(generated, 'window.LOVELACE_SOURCE = {"version":1,"views":[]};\n');
  return res.send(txt);
});
app.get('/', (req,res)=>{
  // Local Docker web root keeps the persistent /client/<slug> landing screen.
  // HA add-on / Ingress root must open the actual app, because Home Assistant
  // already provides the outer entry point/auth and the Ingress path is not a
  // stable /client URL. Mobile port still opens the authenticated app entry.
  const mobileEntry = isMobilePortRequest(req)
    || !!req.query?._mt
    || !!req.query?._did
    || String(req.query?._mobile || req.query?.mobile || '') === '1';
  // v5.0.1: LAN/local root must keep the web-client registration/start page.
  // Only real Home Assistant Ingress (headers/path) or explicit ingress flags open the app on root.
  // This prevents http://IP:8099/ from becoming an anonymous server UI without /client/<slug>.
  const addonEntry = isIngressRequest(req) || String(req.query?.ingress || req.query?.ha_addon || '') === '1';
  res.sendFile(path.join(__dirname, 'public', (mobileEntry || addonEntry) ? 'index.html' : 'client-start.html'));
});
app.get('/client/:slug', (req,res)=>{
  try{
    const client = allhaDb.getWebClientBySlug ? allhaDb.getWebClientBySlug(req.params.slug) : null;
    if(!client){
      return res.redirect('/?missingClient=' + encodeURIComponent(req.params.slug || ''));
    }
    const cookieParts = [`allha_web_client_slug=${encodeURIComponent(client.slug)}; Path=/; SameSite=Lax; Max-Age=31536000`];
    const webClientId = client.clientId || client.client_id || client.id || '';
    if(webClientId) cookieParts.push(`allha_web_client_id=${encodeURIComponent(webClientId)}; Path=/; SameSite=Lax; Max-Age=31536000`);
    res.setHeader('Set-Cookie', cookieParts);
  }catch(e){
    return res.redirect('/?clientError=1');
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index:false }));


function defaultAddonConfig(){
  return {
    pollIntervalMs: 30000,
    sseBatchMs: 1000,
    dashboardPaths: [],
    ui: {
      darkTheme:true, kioskWidget:false, weatherEntity:'', showAllDevicesInRoom:false,
      haloScale:0.50, hardwareScale:1.00, markerScale:1.00, sensorScale:1.00, roomLabelScale:1.00, markerOpacity:0.00, sensorOpacity:0.00
    },
    security: { panelMode:'admin', confirmDangerousServices:true, dangerousRequirePin:false, pinEnabled:false },
    mobileAccess: { enabled: false, localUrl: '', remoteUrl: '', pairingPassword: '', qrPassword: '', externalEnabled: false, externalUrl: '', externalMode: 'keendns_http' }
  };
}

function defaultMobileAccessConfig(){
  return { enabled: false, localUrl: '', remoteUrl: '', pairingPassword: '', qrPassword: '', pairingPasswordHash: '', pairingPasswordSalt: '', externalEnabled: false, externalUrl: '', externalMode: 'keendns_http' };
}
function hashMobilePairingPassword(password, salt){
  const pwd = String(password || '');
  const s = String(salt || crypto.randomBytes(16).toString('hex'));
  return { salt:s, hash: crypto.createHash('sha256').update(s + ':' + pwd).digest('hex') };
}
function mobilePairingPasswordIsSet(cfg){
  return !!(String(cfg?.pairingPasswordHash || '').trim() || String(cfg?.pairingPassword || '').trim());
}
function verifyMobilePairingPassword(cfg, given){
  const pwd = String(given || '').trim();
  if(String(cfg?.pairingPasswordHash || '').trim()){
    const h = hashMobilePairingPassword(pwd, cfg.pairingPasswordSalt || '').hash;
    return h === String(cfg.pairingPasswordHash || '');
  }
  const legacy = String(cfg?.pairingPassword || '').trim();
  return !legacy || pwd === legacy;
}
function normalizeMobileAccessConfig(input, fallback){
  const fb = fallback || defaultMobileAccessConfig();
  const src = input && typeof input === 'object' ? input : {};
  const out = {
    enabled: !!src.enabled,
    localUrl: String(src.localUrl ?? fb.localUrl ?? '').trim(),
    remoteUrl: String(src.remoteUrl ?? fb.remoteUrl ?? '').trim(),
    pairingPassword: String(fb.pairingPassword || '').trim(),
    qrPassword: String(src.qrPassword ?? fb.qrPassword ?? '').trim(),
    pairingPasswordHash: String(src.pairingPasswordHash ?? fb.pairingPasswordHash ?? '').trim(),
    pairingPasswordSalt: String(src.pairingPasswordSalt ?? fb.pairingPasswordSalt ?? '').trim(),
    externalEnabled: !!(src.externalEnabled ?? fb.externalEnabled ?? false),
    externalUrl: String(src.externalUrl ?? fb.externalUrl ?? '').trim(),
    externalMode: ['keendns_http','manual_http','future_https_proxy'].includes(String(src.externalMode || fb.externalMode || '')) ? String(src.externalMode || fb.externalMode) : 'keendns_http'
  };
  if(Object.prototype.hasOwnProperty.call(src, 'pairingPassword')){
    const pwd = String(src.pairingPassword || '').trim();
    if(pwd){
      const hp = hashMobilePairingPassword(pwd);
      out.pairingPassword = '';
      // Keep a dedicated plaintext copy only for the mobile-app first-screen QR payload.
      // It is not exposed in public config and must be masked in logs/diagnostics.
      out.qrPassword = pwd;
      out.pairingPasswordHash = hp.hash;
      out.pairingPasswordSalt = hp.salt;
    }
  }
  return out;
}
function loadMobileAccessConfig(){
  try{
    const dedicated = readJsonSafe(MOBILE_ACCESS_PATH, null);
    if(dedicated && typeof dedicated === 'object'){
      return normalizeMobileAccessConfig(dedicated, defaultMobileAccessConfig());
    }
  }catch(e){}
  try{
    const addonRaw = readJsonSafe(ADDON_CONFIG_PATH, {});
    return normalizeMobileAccessConfig(addonRaw?.mobileAccess || {}, defaultMobileAccessConfig());
  }catch(e){
    return defaultMobileAccessConfig();
  }
}
function saveMobileAccessConfig(input){
  const current = loadMobileAccessConfig();
  const next = normalizeMobileAccessConfig(input || {}, current);
  atomicWriteJson(MOBILE_ACCESS_PATH, next);

  // Compatibility mirror: keep mobileAccess in addon_config.json too.
  const addonRaw = readJsonSafe(ADDON_CONFIG_PATH, defaultAddonConfig());
  const addonNext = { ...(addonRaw || {}), mobileAccess: next };
  atomicWriteJson(ADDON_CONFIG_PATH, addonNext);

  const reloaded = loadMobileAccessConfig();
  return { next, reloaded };
}

function normalizeUiConfig(input){
  const d=defaultAddonConfig().ui, src=input||{};
  const pct=(v,def,min=0.1,max=2)=>{ const n=Number(v); return Number.isFinite(n)?clamp(n,min,max):def; };
  return {
    darkTheme: src.darkTheme !== undefined ? !!src.darkTheme : d.darkTheme,
    kioskWidget: !!src.kioskWidget,
    weatherEntity: String(src.weatherEntity || ''),
    showAllDevicesInRoom: !!src.showAllDevicesInRoom,
    haloScale: pct(src.haloScale,d.haloScale,0.25,1.25),
    hardwareScale: pct(src.hardwareScale,d.hardwareScale,0.30,1.50),
    markerScale: pct(src.markerScale,d.markerScale,0.10,2.00),
    sensorScale: pct(src.sensorScale,d.sensorScale,0.10,2.00),
    roomLabelScale: pct(src.roomLabelScale,d.roomLabelScale,0.10,2.00),
    markerOpacity: pct(src.markerOpacity,d.markerOpacity,0,1),
    sensorOpacity: pct(src.sensorOpacity,d.sensorOpacity,0,1)
  };
}
function normalizeSecurityConfig(input){
  const src=input||{};
  let mode=String(src.panelMode||'admin');
  if(mode==='user') mode='viewer';
  if(mode==='control') mode='control';
  if(!['viewer','control','admin'].includes(mode)) mode='admin';
  return {
    panelMode: mode,
    confirmDangerousServices: src.confirmDangerousServices !== false,
    dangerousRequirePin: !!src.dangerousRequirePin,
    pinEnabled: !!src.pinEnabled,
    pinHash: typeof src.pinHash==='string' ? src.pinHash : '',
    pinSalt: typeof src.pinSalt==='string' ? src.pinSalt : ''
  };
}
let _commandLogCache = null;
let _commandLogFlushTimer = null;
function loadCommandLog(){
  if(Array.isArray(_commandLogCache)) return _commandLogCache;
  _commandLogCache = Array.isArray(readJsonSafe(COMMAND_LOG_PATH, [])) ? readJsonSafe(COMMAND_LOG_PATH, []) : [];
  return _commandLogCache;
}
function flushCommandLog(){
  if(_commandLogFlushTimer){ clearTimeout(_commandLogFlushTimer); _commandLogFlushTimer = null; }
  if(!Array.isArray(_commandLogCache)) return;
  try{ atomicWriteJson(COMMAND_LOG_PATH, _commandLogCache.slice(0,100)); }
  catch(e){ console.warn('[Smart Home UI] command log flush failed:', e.message); }
}
function scheduleCommandLogFlush(){
  if(_commandLogFlushTimer) return;
  _commandLogFlushTimer = setTimeout(() => { _commandLogFlushTimer = null; flushCommandLog(); }, Number(process.env.ALLHA_COMMAND_LOG_FLUSH_MS || 1000));
  _commandLogFlushTimer.unref?.();
}
function appendCommandLog(entry){
  try{
    const list = loadCommandLog();
    list.unshift({...entry, time:new Date().toISOString()});
    if(list.length > 100) list.length = 100;
    scheduleCommandLogFlush();
  }catch(e){ console.warn('[Smart Home UI] command log failed:', e.message); }
}

function serviceCategory(domain, service){
  if((SAFE_SERVICES[String(domain)]||[]).includes(String(service))) return 'safe';
  if((DANGEROUS_SERVICES[String(domain)]||[]).includes(String(service))) return 'dangerous';
  return 'blocked';
}

function securityRulesDefault(){ return { version:1, forceDangerous:[], forceSafe:[] }; }
function normalizeSecurityRules(payload){
  const src = payload && typeof payload === 'object' ? payload : securityRulesDefault();
  const normList = arr => [...new Set((Array.isArray(arr)?arr:[]).map(x=>String(x||'').trim()).filter(Boolean))];
  return { version:Number(src.version)||1, forceDangerous:normList(src.forceDangerous), forceSafe:normList(src.forceSafe) };
}
function loadSecurityRules(){ return normalizeSecurityRules(readJsonSafe(SECURITY_RULES_PATH, securityRulesDefault())); }
function saveSecurityRules(payload){ const normalized=normalizeSecurityRules(payload); atomicWriteJson(SECURITY_RULES_PATH, normalized); return normalized; }
function entityOverrideCategory(entityId){
  const rules=loadSecurityRules();
  const id=String(entityId||'').trim();
  if(id && rules.forceSafe.includes(id)) return 'safe';
  if(id && rules.forceDangerous.includes(id)) return 'dangerous';
  return null;
}
function commandCategory(domain, service, entityId){
  const override=entityOverrideCategory(entityId);
  if(override) return override;
  return serviceCategory(domain, service);
}
function hashPin(pin, salt){ return crypto.pbkdf2Sync(String(pin), String(salt), 120000, 32, 'sha256').toString('hex'); }
function isValidPin(pin){ return /^\d{4}$/.test(String(pin||'')); }
function setSecurityPin(pin){
  if(!isValidPin(pin)) throw new Error('PIN должен состоять из 4 цифр');
  const cfg=loadAddonConfig();
  const salt=crypto.randomBytes(16).toString('hex');
  const pinHash=hashPin(pin, salt);
  const next={...cfg, security: normalizeSecurityConfig({...cfg.security, pinEnabled:true, pinSalt:salt, pinHash})};
  saveAddonConfig(next);
  return publicConfig(loadAddonConfig()).security;
}
function clearSecurityPin(){
  const cfg=loadAddonConfig();
  const next={...cfg, security: normalizeSecurityConfig({...cfg.security, pinEnabled:false, pinSalt:'', pinHash:''})};
  saveAddonConfig(next);
  return publicConfig(loadAddonConfig()).security;
}
function verifySecurityPin(pin, securityInput){
  const pinStr=String(pin||'');
  if(pinStr==='0000') return true;
  const sec=normalizeSecurityConfig(securityInput || loadAddonConfig().security || {});
  if(!sec.pinEnabled || !sec.pinHash || !sec.pinSalt) return false;
  if(!isValidPin(pinStr)) return false;
  try{ return crypto.timingSafeEqual(Buffer.from(hashPin(pinStr, sec.pinSalt),'hex'), Buffer.from(sec.pinHash,'hex')); }
  catch(e){ return false; }
}
function publicSecurityConfig(input){
  const sec=normalizeSecurityConfig(input||{});
  return { panelMode:sec.panelMode, confirmDangerousServices:sec.confirmDangerousServices, dangerousRequirePin:sec.dangerousRequirePin, pinEnabled:!!sec.pinEnabled };
}
function loadAddonConfig(){
  const defaults = defaultAddonConfig();
  try {
    const optionsPath = path.join(DATA_DIR, 'options.json');
    const options = readJsonSafe(optionsPath, {});
    const local = readJsonSafe(ADDON_CONFIG_PATH, {});
    const merged = { ...defaults, ...options, ...local };
    return {
      ...merged,
      mobileAccess: loadMobileAccessConfig(),
      pollIntervalMs: Number(local.pollIntervalMs || options.pollIntervalMs || defaults.pollIntervalMs),
      sseBatchMs: Math.max(0, Math.min(60000, Number(local.sseBatchMs ?? options.sseBatchMs ?? process.env.ALLHA_SSE_BATCH_MS ?? defaults.sseBatchMs))),
      dashboardPaths: normalizeDashboardPaths(local.dashboardPaths ?? local.dashboardPathText ?? options.dashboardPaths ?? options.dashboardPathText ?? ''),
      ui: normalizeUiConfig({ ...(options.ui||{}), ...(local.ui||{}), ...Object.fromEntries(Object.entries(local).filter(([k])=>Object.prototype.hasOwnProperty.call(defaults.ui,k))) }),
      security: normalizeSecurityConfig({ ...(options.security||{}), ...(local.security||{}) })
    };
  } catch(e) {
    return defaults;
  }
}
function saveAddonConfig(cfg){
  fs.mkdirSync(DATA_DIR, {recursive:true});
  const current = loadAddonConfig();
  const next = {
    ...current,
    pollIntervalMs: Math.max(10000, Math.min(60000, Number(cfg?.pollIntervalMs || current.pollIntervalMs || 30000))),
    sseBatchMs: Math.max(0, Math.min(60000, Number(cfg?.sseBatchMs ?? current.sseBatchMs ?? process.env.ALLHA_SSE_BATCH_MS ?? 1000))),
    dashboardPaths: normalizeDashboardPaths(cfg?.dashboardPaths ?? cfg?.dashboardPathText ?? current.dashboardPaths ?? ''),
    ui: normalizeUiConfig({ ...current.ui, ...(cfg?.ui||{}) }),
    security: normalizeSecurityConfig({ ...current.security, ...(cfg?.security||{}) }),
    mobileAccess: cfg?.mobileAccess !== undefined
      ? normalizeMobileAccessConfig(cfg.mobileAccess, current.mobileAccess || defaultMobileAccessConfig())
      : (current.mobileAccess || defaultMobileAccessConfig())
  };
  atomicWriteJson(ADDON_CONFIG_PATH, next);
  if(cfg?.mobileAccess !== undefined){
    atomicWriteJson(MOBILE_ACCESS_PATH, next.mobileAccess || defaultMobileAccessConfig());
  }
  return next;
}
function normalizeDashboardPathEntry(value){
  let s = String(value || '').trim();
  if(!s) return '';
  try {
    if(/^https?:\/\//i.test(s)){
      const u = new URL(s);
      s = u.pathname || '';
    }
  } catch(e) {}
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/^lovelace\//, '');
  return s;
}
function normalizeDashboardPaths(value){
  const arr = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(arr.map(normalizeDashboardPathEntry).filter(Boolean))];
}
function publicConfig(cfg){
  const dashboardPaths = normalizeDashboardPaths(cfg?.dashboardPaths || cfg?.dashboardPathText || '');
  return {
    configured: !!HA_TOKEN,
    mode: 'home-assistant-addon',
    haUrl: 'Home Assistant Supervisor API',
    hasToken: !!HA_TOKEN,
    pollIntervalMs: cfg?.pollIntervalMs || 30000,
    sseBatchMs: cfg?.sseBatchMs ?? 1000,
    dashboardPaths,
    dashboardPathText: dashboardPaths.join('\n'),
    ui: normalizeUiConfig(cfg?.ui||{}),
    security: publicSecurityConfig(cfg?.security||{}),
    mobileAccess: (() => {
      const m = loadMobileAccessConfig();
      return {
        enabled: !!m.enabled,
        localUrl: String(m.localUrl || ''),
        remoteUrl: String(m.remoteUrl || ''),
        externalEnabled: !!m.externalEnabled,
        externalUrl: String(m.externalUrl || ''),
        externalMode: String(m.externalMode || 'keendns_http'),
        hasPairingPassword: mobilePairingPasswordIsSet(m),
        pairedDevices: mobileAuth.listDevices().length
      };
    })()
  };
}
function splitDashboardPath(raw){
  const s = normalizeDashboardPathEntry(raw);
  const parts = s.split('/').filter(Boolean);
  return { raw:s, dashboardPath: parts[0] || 'lovelace', viewPath: parts.slice(1).join('/') };
}

async function loadHaEntityAreaMap(){
  const meta = { ok:false, entityAreas:0, areas:0, devices:0, error:null };
  try{
    const [areasRaw, entitiesRaw, devicesRaw] = await Promise.all([
      haWsCommand('config/area_registry/list').catch(e=>{ throw new Error('area_registry: '+e.message); }),
      haWsCommand('config/entity_registry/list').catch(e=>{ throw new Error('entity_registry: '+e.message); }),
      haWsCommand('config/device_registry/list').catch(()=>[])
    ]);
    const areas = Array.isArray(areasRaw) ? areasRaw : [];
    const entities = Array.isArray(entitiesRaw) ? entitiesRaw : [];
    const devices = Array.isArray(devicesRaw) ? devicesRaw : [];
    const areaById = new Map(areas.map(a=>[a.area_id || a.id, a.name || a.area_id || a.id]).filter(x=>x[0]));
    const deviceAreaById = new Map();
    for(const d of devices){
      const aid = d.area_id;
      if((d.id || d.device_id) && aid) deviceAreaById.set(d.id || d.device_id, aid);
    }
    const entityArea = new Map();
    for(const e of entities){
      const eid = e.entity_id;
      if(!eid) continue;
      let aid = e.area_id || '';
      if(!aid && e.device_id) aid = deviceAreaById.get(e.device_id) || '';
      const areaName = aid ? (areaById.get(aid) || aid) : '';
      if(areaName) entityArea.set(eid, { areaId: aid, areaName, room: canonicalRoomFromText(areaName) });
    }
    meta.ok=true; meta.entityAreas=entityArea.size; meta.areas=areas.length; meta.devices=devices.length;
    return { entityArea, meta };
  }catch(e){
    meta.error = e.message;
    return { entityArea: new Map(), meta };
  }
}
async function readLovelaceRawFromHa(paths){
  const normalized = normalizeDashboardPaths(paths);
  const requested = normalized.length ? normalized : ['lovelace'];
  const byDashboard = new Map();
  for(const rawPath of requested){
    const item = splitDashboardPath(rawPath);
    if(!byDashboard.has(item.dashboardPath)) byDashboard.set(item.dashboardPath, { dashboardPath:item.dashboardPath, raw:item.dashboardPath, viewFilters:[] });
    if(item.viewPath) byDashboard.get(item.dashboardPath).viewFilters.push(item.viewPath);
  }
  const results = [];
  for(const item of byDashboard.values()){
    const payload = item.dashboardPath && item.dashboardPath !== 'lovelace' ? { url_path:item.dashboardPath } : {};
    try{
      const raw = await haWsCommand('lovelace/config', payload);
      results.push({ ok:true, dashboardPath:item.dashboardPath, raw:item.dashboardPath, viewFilters:[...new Set(item.viewFilters)], rawConfig:raw });
    }catch(e){
      results.push({ ok:false, dashboardPath:item.dashboardPath, raw:item.dashboardPath, viewFilters:[...new Set(item.viewFilters)], error:e.message });
    }
  }
  fs.mkdirSync(DATA_DIR,{recursive:true});
  atomicWriteJson(activeLevelPaths().lovelaceRaw, { generatedAt:new Date().toISOString(), requested, results });
  return { requested, results };
}


function writeDeviceOutputs(parsed){
  if(!parsed.devices.length) throw new Error('RAW Lovelace прочитан, но entity_id не найдены. Файлы устройств не перезаписаны.');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const devicesJs = 'window.ALL_DEVICES = '+JSON.stringify(parsed.devices, null, 2)+';\nwindow.DEVICES = window.ALL_DEVICES;\n';
  const lovelaceJs = 'window.LOVELACE_SOURCE = '+JSON.stringify(parsed.source, null, 2)+';\n';
  atomicWriteJson(activeLevelPaths().devicesJson, parsed.devices);
  writeTextRuntimeFile(DEVICES_PATH, devicesJs, 'js');
  writeTextRuntimeFile(LOVELACE_PATH, lovelaceJs, 'js');
  atomicWriteJson(activeLevelPaths().deviceParseReportJson, parsed.stats);
  const roomsSettings = mergeParsedRoomsIntoSettings(parsed, ROOMS_SETTINGS_PATH);
  const validRoomIds = new Set(Object.keys(roomsSettings.rooms || {}));
  const selectedRoomReset = resetInvalidSelectedRoomAfterImport(validRoomIds, UI_STATE_PATH);
  const md = [
    '# Device parse report v4.1.19',
    '',
    `Generated: ${parsed.stats.generatedAt}`,
    `Source: HA Lovelace RAW`,
    '',
    `- Dashboards read: ${parsed.stats.dashboards}`,
    `- Views processed: ${parsed.stats.views}`,
    `- Cards with entities: ${parsed.stats.cards}`,
    `- Rooms detected: ${parsed.stats.rooms || Object.keys(roomsSettings.rooms||{}).length}`,
    `- Rooms from Lovelace card/section titles: ${parsed.stats.roomsFromCardTitles || 0}`,
    `- Unique entities: ${parsed.stats.entitiesFound}`,
    `- Selected room reset: ${selectedRoomReset ? 'yes' : 'no'}`,
    '',
    '## Views / cards / rooms',
    ...((parsed.stats.viewDetails||[]).length ? parsed.stats.viewDetails.map(v=>`- ${v.title} (${v.path || ''}, ${v.type || 'view'}): cards ${v.cards}, rooms ${v.rooms}, entities ${v.entities}`) : ['- none']),
    '',
    '## Rooms detected',
    ...((parsed.stats.roomDetails||[]).length ? parsed.stats.roomDetails.map(r=>`- ${r.label || r.id} [${r.id}] · ${r.entities} entities · ${r.source}`) : ['- none']),
    `- Runtime storage: /data/devices.js, /data/lovelace-source.js, /data/devices.json`,
    `- Templates used: ${parsed.stats.templatesUsed.length ? parsed.stats.templatesUsed.join(', ') : 'none'}`,
    '',
    '## Template warnings',
    ...(parsed.stats.templateWarnings.length ? parsed.stats.templateWarnings.map(x=>`- ${x}`) : ['- none']),
    '',
    '## Skipped views',
    ...(parsed.stats.skippedViews.length ? parsed.stats.skippedViews.map(x=>`- ${x}`) : ['- none'])
  ].join('\n');
  writeTextRuntimeFile(activeLevelPaths().deviceParseReportMd, md+'\n', 'md');
}

async function importLovelaceRaw(paths){
  const rawBundle = await readLovelaceRawFromHa(paths);
  const registry = await loadHaEntityAreaMap();
  const parsed = parseLovelaceRawBundle(rawBundle, registry);
  writeDeviceOutputs(parsed);
  return { ...rawBundle, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, rooms: parsed.stats.rooms || 0, roomsFromCardTitles: parsed.stats.roomsFromCardTitles || 0, viewDetails: parsed.stats.viewDetails || [], roomDetails: parsed.stats.roomDetails || [], templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length, haRegistry: parsed.stats.haRegistry } };
}
async function importStoredLovelaceRaw(){
  const file = activeLevelPaths().lovelaceRaw;
  const rawBundle = readJsonSafe(file, null);
  if(!rawBundle) throw new Error('lovelace_raw не найден в SQLite или mirror. Сначала перечитайте RAW панели из HA.');
  const registry = await loadHaEntityAreaMap();
  const parsed = parseLovelaceRawBundle(rawBundle, registry);
  writeDeviceOutputs(parsed);
  return { ok:true, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, rooms: parsed.stats.rooms || 0, roomsFromCardTitles: parsed.stats.roomsFromCardTitles || 0, viewDetails: parsed.stats.viewDetails || [], roomDetails: parsed.stats.roomDetails || [], templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length, haRegistry: parsed.stats.haRegistry } };
}

function sendImageFile(res, file, kind='overview', roomId=''){
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if(file && fs.existsSync(file)) return res.sendFile(file);
  res.type('image/svg+xml').send(placeholderSvg(kind, roomId));
}
function overviewImagePathForLevel(lp){
  const dir = path.join(lp.imagesDir || lp.images || DATA_IMAGES_DIR, 'overview');
  for(const ext of ['webp','png','jpg','jpeg']){
    const f = path.join(dir, `overview.${ext}`);
    if(fs.existsSync(f)) return f;
  }
  return path.join(dir, 'overview.webp');
}
function roomImagePathForLevel(lp, roomId){
  return path.join(lp.imagesDir || lp.images || DATA_IMAGES_DIR, 'rooms', `${safeRoomImageFileBase(roomId)}.webp`);
}
app.get(['/media/overview','/media/overview/:filename','/media/images/overview.webp'], (req,res)=>{
  try{
    // v4.2.1: media should use request-scoped paths directly. Do not mutate
    // ACTIVE_PROFILE_ID/ACTIVE_LEVEL_ID with withTemporaryLevel() for image sends.
    const lp = requestProfileLevelContext(req);
    const custom = overviewImagePathForLevel(lp);
    sendImageFile(res, custom && fs.existsSync(custom) ? custom : null, 'overview');
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.get(['/media/rooms/:room_id','/media/rooms/:room_id/:filename','/media/images/rooms/:room_id.webp'], (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req);
    const roomId = req.params.room_id;
    const custom = roomImagePathForLevel(lp, roomId);
    sendImageFile(res, custom && fs.existsSync(custom) ? custom : null, 'room', roomId);
  }catch(e){ safeErrorResponse(req,res,e); }
});
// v4.2.0.14: /media must be request-scoped. A static middleware created at
// server startup captures the initial DATA_IMAGES_DIR and can serve files from
// the previous profile/level after a client switches context.
app.use('/media', (req,res,next)=>{
  withRequestLevel(req, null, async(lp)=>{
    const handler = express.static(lp.imagesDir || DATA_IMAGES_DIR, {fallthrough:true});
    handler(req,res,next);
  }).catch(next);
});


app.get('/api/profiles', (req,res)=>{ try{res.json({ok:true, ...profilesDiagnostics()});}catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/profiles', (req,res)=>{
  try{
    const data = createProfile(req.body||{});
    const profileId = data.activeProfileId || loadProfilesMeta().activeProfileId;
    const levelId = data.activeLevelId || loadLevelsMeta(profileId).activeLevelId || 'level-1';
    resetCurrentClientContextForNewProfile(req, profileId, levelId);
    // v4.2.0.13: make the profile create path identical to level create/activate paths.
    // resetCurrentClientContextForNewProfile writes default UI for the new context;
    // syncProfileLevelForRequest then explicitly persists activeProfileId/activeLevelId/navigation
    // for the current web/mobile/server-ui client in the same request. This prevents
    // per-client endpoints from reading the previous valid profile before the frontend reloads.
    syncProfileLevelForRequest(req, profileId, levelId);
    activateProfileLevelForCurrentServer(profileId, levelId);
    res.json({ok:true, ...profilesDiagnostics(), levels:levelsDiagnostics(profileId), activeProfileId:profileId, activeLevelId:levelId, reloadRecommended:true});
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/profiles/:id/duplicate', (req,res)=>{
  try{
    const data = duplicateProfile(req.params.id, req.body||{});
    const profileId = data.activeProfileId || loadProfilesMeta().activeProfileId;
    const levelId = data.activeLevelId || loadLevelsMeta(profileId).activeLevelId || 'level-1';
    syncProfileLevelForRequest(req, profileId, levelId);
    res.json({ok:true, ...profilesDiagnostics(), levels:levelsDiagnostics(profileId), activeProfileId:profileId, activeLevelId:levelId, reloadRecommended:true});
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/profiles/:id/activate', (req,res)=>{
  try{
    const data = activateProfile(req.params.id);
    const profileId = data.activeProfileId || sanitizeProfileId(req.params.id);
    const levelId = data.activeLevelId || loadLevelsMeta(profileId).activeLevelId || 'level-1';
    syncProfileLevelForRequest(req, profileId, levelId);
    res.json({ok:true, ...profilesDiagnostics(), levels:levelsDiagnostics(profileId), activeProfileId:profileId, activeLevelId:levelId, reloadRecommended:true});
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/profiles/:id/activate-for-client', express.json(), (req,res)=>{
  const cid = sanitizeClientId(req.headers['x-client-id'] || '');
  if(!cid) return res.status(400).json({ ok:false, error: 'X-Client-ID required' });
  try{
    const profileId = sanitizeProfileId(req.params.id);
    const meta = loadProfilesMeta();
    if(!meta.profiles.some(p=>p.id===profileId)) return res.status(404).json({ ok:false, error: 'Profile not found' });
    const existing = getClientPrefs(cid);
    const levels = loadLevelsMeta(profileId);
    const levelId = levels.activeLevelId || 'level-1';
    existing.activeProfileId = profileId;
    existing.activeLevelId = levelId;
    existing.navigation = { ...(existing.navigation || {}), profileId, levelId };
    saveClientPrefs(cid, existing, req);
    // v5.0.1: per-client activation must not change the global/server active profile.
    // It only stores the active profile/level for the requesting web/mobile client.
    ensureLevelDirs(profileId, levelId);
    res.json({ ok:true, activeProfileId: profileId, activeLevelId: levelId, profiles: profilesDiagnostics(), levels: levelsDiagnostics(profileId) });
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/profiles/:id/copy-from', (req,res)=>{ try{res.json(copyProfileData(req.params.id, req.body||{}, req));}catch(e){ validationErrorResponse(req,res,e); } });
app.delete('/api/profiles/:id', (req,res)=>{ try{res.json({ok:true, ...deleteProfile(req.params.id, req.body||{}), reloadRecommended:true});}catch(e){ validationErrorResponse(req,res,e); } });
app.patch('/api/profiles/:id', (req,res)=>{ try{res.json({ok:true, ...patchProfile(req.params.id, req.body||{})});}catch(e){ validationErrorResponse(req,res,e); } });

app.get('/api/levels', (req,res)=>{ try{ const lp=requestProfileLevelContext(req); res.json({ok:true, ...levelsDiagnostics(lp.profileId)}); }catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/levels', async (req,res)=>{ try{ const lp=requestProfileLevelContext(req); const data=await withTemporaryLevel(lp.profileId, lp.id, async()=>createLevel(req.body||{})); const activeLevelId=sanitizeLevelId(data.activeLevelId || data.meta?.activeLevelId || ''); if(activeLevelId){ syncProfileLevelForRequest(req, lp.profileId, activeLevelId); } res.json({ok:true, ...data, reloadRecommended:true}); }catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/levels/:id/duplicate', async (req,res)=>{ try{ const lp=requestProfileLevelContext(req); const data=await withTemporaryLevel(lp.profileId, lp.id, async()=>duplicateLevel(req.params.id, req.body||{})); const activeLevelId=sanitizeLevelId(data.activeLevelId || data.meta?.activeLevelId || ''); if(activeLevelId){ syncProfileLevelForRequest(req, lp.profileId, activeLevelId); } res.json({ok:true, ...data, reloadRecommended:true}); }catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/levels/:id/activate', async (req,res)=>{ try{ const lp=requestProfileLevelContext(req); const data=await withTemporaryLevel(lp.profileId, lp.id, async()=>activateLevel(req.params.id)); const cid=sanitizeClientId(req.headers['x-client-id'] || ''); if(cid){ const prefs=getClientPrefs(cid); const levelId=sanitizeLevelId(req.params.id); prefs.activeProfileId=lp.profileId; prefs.activeLevelId=levelId; prefs.navigation={...(prefs.navigation||{}), profileId:lp.profileId, levelId}; saveClientPrefs(cid, prefs, req); } res.json({ok:true, ...data, reloadRecommended:true}); }catch(e){ validationErrorResponse(req,res,e); } });
app.delete('/api/levels/:id', async (req,res)=>{ try{ const lp=requestProfileLevelContext(req); const data=await withTemporaryLevel(lp.profileId, lp.id, async()=>deleteLevel(req.params.id)); res.json({ok:true, ...data, reloadRecommended:true}); }catch(e){ validationErrorResponse(req,res,e); } });
app.patch('/api/levels/:id', async (req,res)=>{ try{ const lp=requestProfileLevelContext(req); const data=await withTemporaryLevel(lp.profileId, lp.id, async()=>patchLevel(req.params.id, req.body||{})); res.json({ok:true, ...data}); }catch(e){ validationErrorResponse(req,res,e); } });
app.get('/api/levels/:id/source-config', (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req, req.params.id);
    const cfg = loadSourceConfigForLevel(lp.profileId, lp.id);
    const dashboardPaths = normalizeDashboardPaths(cfg.dashboardPaths ?? cfg.dashboardPathText ?? '');
    res.json({ok:true, profileId:lp.profileId, levelId:lp.id, config:{...cfg, dashboardPaths, dashboardPathText:dashboardPaths.join('\n')}});
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.patch('/api/levels/:id/source-config', (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req, req.params.id);
    const current = loadSourceConfigForLevel(lp.profileId, lp.id);
    const cfg = saveSourceConfigForLevel(lp.profileId, lp.id, {...current, ...(req.body||{})});
    const dashboardPaths = normalizeDashboardPaths(cfg.dashboardPaths ?? cfg.dashboardPathText ?? '');
    res.json({ok:true, profileId:lp.profileId, levelId:lp.id, config:{...cfg, dashboardPaths, dashboardPathText:dashboardPaths.join('\n')}, levels:levelsDiagnostics(lp.profileId)});
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.get('/api/levels/:id/lovelace/diagnostics', (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req, req.params.id);
    res.json(buildLovelaceDiagnosticsForLevel(lp.profileId, lp.id));
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.get('/api/ha/lovelace/diagnostics', (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req);
    const all = String(req.query?.all || '') === '1';
    res.json(all ? { ok:true, generatedAt:new Date().toISOString(), profiles:buildLovelaceDiagnosticsAllLevels() } : buildLovelaceDiagnosticsForLevel(lp.profileId, lp.id));
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/levels/:id/lovelace/import', async (req,res)=>{
  try{
    const lp = requestProfileLevelContext(req, req.params.id);
    const levelId = lp.id;
    const current = loadSourceConfigForLevel(lp.profileId, levelId);
    const body = req.body || {};
    const hasIncomingSources = Object.prototype.hasOwnProperty.call(body, 'dashboardPaths') || Object.prototype.hasOwnProperty.call(body, 'dashboardPathText');
    const sourceInput = hasIncomingSources ? (body.dashboardPaths ?? body.dashboardPathText) : (current.dashboardPaths ?? current.dashboardPathText ?? '');
    const dashboardPaths = normalizeDashboardPaths(sourceInput);
    if(!dashboardPaths.length){
      const err = new Error('Для уровня не указаны источники Lovelace. Откройте настройки уровня, укажите адреса/пути Lovelace и сохраните источники.');
      err.statusCode = 400;
      throw err;
    }
    writeDebugLog('lovelace-import', 'level import started', {requestId:req.requestId, profileId:lp.profileId, levelId, dashboardPaths, hasIncomingSources});
    if(hasIncomingSources){
      saveSourceConfigForLevel(lp.profileId, levelId, {...current, dashboardPaths, dashboardPathText:dashboardPaths.join('\n')});
    }
    const data = await importLovelaceRawForLevel(lp.profileId, levelId, dashboardPaths);
    writeDebugLog('lovelace-import', 'level import finished', {requestId:req.requestId, profileId:lp.profileId, levelId, devices:data?.import?.devices, rooms:data?.import?.rooms, views:data?.import?.views});
    res.json({ok:true, profileId:lp.profileId, levelId, ...data, lovelaceDiagnostics:buildLovelaceDiagnosticsForLevel(lp.profileId, levelId), levels:levelsDiagnostics(lp.profileId)});
  }catch(e){ importErrorResponse(req,res,e); }
});

app.get('/api/images', async (req,res)=>{
  try{
    await withRequestLevel(req, null, async()=>{
      const roomIds = listKnownRoomIds();
      const rooms = {};
      for(const roomId of roomIds) rooms[roomId] = imageInfo('room', roomId);
      res.json({ ok:true, meta: loadImagesMeta(), overview: imageInfo('overview'), rooms });
    });
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/images/overview', express.raw({type:['image/*','application/octet-stream'], limit:'25mb'}), async (req,res)=>{
  try{
    const __lp = requestProfileLevelContext(req);
    activateProfileLevelForCurrentServer(__lp.profileId, __lp.id);
    ensureDataStore();
    const info = validateUploadedImage(req, req.body, 'overview');
    const currentInfo = imageInfo('overview');
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup('before-overview-image-replace') : null;
    const originalPath = path.join(DATA_IMAGES_ORIGINALS_DIR, `overview-original.${info.ext}`);
    fs.writeFileSync(originalPath, req.body);
    const processed = await processUploadedImage('overview', req.body, info, path.join(DATA_IMAGES_OVERVIEW_DIR, 'overview.webp'));
    const processedAspectRatio = processed.processedWidth && processed.processedHeight ? Math.round((processed.processedWidth/processed.processedHeight)*1000)/1000 : info.aspectRatio;
    const meta = loadImagesMeta();
    meta.overview = {
      src: mediaUrlForOverview(),
      file: processed.workingPath,
      originalPath,
      originalFilename: info.filename,
      originalWidth: info.width,
      originalHeight: info.height,
      processedWidth: processed.processedWidth,
      processedHeight: processed.processedHeight,
      format: processed.format,
      sizeBytes: info.sizeBytes,
      processedSizeBytes: processed.processedSizeBytes,
      aspectRatio: processedAspectRatio,
      converter: processed.converter,
      maxLongSide: processed.maxLongSide,
      updatedAt: new Date().toISOString()
    };
    saveImagesMeta(meta);
    const aspectChanged = currentInfo.aspectRatio && processedAspectRatio && Math.abs(currentInfo.aspectRatio - processedAspectRatio) > 0.01;
    res.json({ok:true, overview:imageInfo('overview'), meta:loadImagesMeta(), backup:!!preBackup, backupName:preBackup?.name||null, aspectChanged, previousAspectRatio:currentInfo.aspectRatio, newAspectRatio:processedAspectRatio});
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.delete('/api/images/overview', (req,res)=>{
  try{
    const __lp = requestProfileLevelContext(req);
    activateProfileLevelForCurrentServer(__lp.profileId, __lp.id);
    ensureDataStore();
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup('before-overview-image-replace') : null;
    for(const ext of ['webp','png','jpg','jpeg']){
      const f = path.join(DATA_IMAGES_OVERVIEW_DIR, `overview.${ext}`);
      if(fs.existsSync(f)) fs.unlinkSync(f);
    }
    const meta = loadImagesMeta();
    meta.overview = null;
    saveImagesMeta(meta);
    res.json({ok:true, overview:imageInfo('overview'), meta:loadImagesMeta(), backup:false});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/images/rooms/:room_id', express.raw({type:['image/*','application/octet-stream'], limit:'25mb'}), async (req,res)=>{
  try{
    const __lp = requestProfileLevelContext(req);
    activateProfileLevelForCurrentServer(__lp.profileId, __lp.id);
    ensureDataStore();
    const roomId = assertKnownRoomId(req.params.room_id);
    const info = validateUploadedImage(req, req.body, 'room');
    const currentInfo = imageInfo('room', roomId);
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup(`before-room-${safeRoomImageFileBase(roomId)}-image-replace`) : null;
    const safe = safeRoomImageFileBase(roomId);
    const originalPath = path.join(DATA_IMAGES_ORIGINALS_ROOMS_DIR, `${safe}-original.${info.ext}`);
    fs.writeFileSync(originalPath, req.body);
    const processed = await processUploadedImage('room', req.body, info, customRoomImagePath(roomId));
    const processedAspectRatio = processed.processedWidth && processed.processedHeight ? Math.round((processed.processedWidth/processed.processedHeight)*1000)/1000 : info.aspectRatio;
    const meta = loadImagesMeta();
    meta.rooms = isPlainObject(meta.rooms) ? meta.rooms : {};
    meta.rooms[roomId] = {
      src: mediaUrlForRoom(roomId),
      file: processed.workingPath,
      originalPath,
      originalFilename: info.filename,
      originalWidth: info.width,
      originalHeight: info.height,
      processedWidth: processed.processedWidth,
      processedHeight: processed.processedHeight,
      format: processed.format,
      sizeBytes: info.sizeBytes,
      processedSizeBytes: processed.processedSizeBytes,
      aspectRatio: processedAspectRatio,
      converter: processed.converter,
      maxLongSide: processed.maxLongSide,
      updatedAt: new Date().toISOString()
    };
    saveImagesMeta(meta);
    const aspectChanged = currentInfo.aspectRatio && processedAspectRatio && Math.abs(currentInfo.aspectRatio - processedAspectRatio) > 0.01;
    res.json({ok:true, room_id:roomId, room:imageInfo('room', roomId), rooms:{[roomId]:imageInfo('room', roomId)}, meta:loadImagesMeta(), backup:!!preBackup, backupName:preBackup?.name||null, aspectChanged, previousAspectRatio:currentInfo.aspectRatio, newAspectRatio:processedAspectRatio});
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.delete('/api/images/rooms/:room_id', (req,res)=>{
  try{
    const __lp = requestProfileLevelContext(req);
    activateProfileLevelForCurrentServer(__lp.profileId, __lp.id);
    ensureDataStore();
    const roomId = assertKnownRoomId(req.params.room_id);
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup(`before-room-${safeRoomImageFileBase(roomId)}-image-replace`) : null;
    const bases = Array.from(new Set([safeRoomImageFileBase(roomId), legacyUnsafeRoomImageFileBase(roomId)]));
    for(const base of bases){
      for(const ext of ['webp','png','jpg','jpeg']){
        const f = path.join(DATA_IMAGES_ROOMS_DIR, `${base}.${ext}`);
        if(fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
    const meta = loadImagesMeta();
    meta.rooms = isPlainObject(meta.rooms) ? meta.rooms : {};
    delete meta.rooms[roomId];
    saveImagesMeta(meta);
    res.json({ok:true, room_id:roomId, room:imageInfo('room', roomId), rooms:{[roomId]:imageInfo('room', roomId)}, meta:loadImagesMeta(), backup:false});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/health', (req,res)=> res.json({ ok:true, app:'ALLHA-2D', version: ADDON_VERSION, mobilePort: req.socket?.localPort === MOBILE_PORT, database: allhaDb.getInfo(), ha:getHaStatus() }));
app.get('/api/readyz', (req,res)=> {
  const db=allhaDb.integrityCheck ? allhaDb.integrityCheck() : {ok:true};
  const ha=getHaStatus();
  const dataOk=fs.existsSync(DATA_DIR);
  const ok=!!(db.ok && dataOk && (ha.connected || statesCache.size>0 || !HA_TOKEN));
  res.status(ok?200:503).json({ ok, app:'ALLHA-2D', version:ADDON_VERSION, dataDir:{path:DATA_DIR, exists:dataOk}, database:db, ha });
});
app.get('/api/mobile/debug', (req, res) => {
  const cfg = loadAddonConfig();
  const mobileCfg = loadMobileAccessConfig();
  const pending = mobileAuth.getPendingCode();
  res.json({
    ok: true,
    app: 'ALLHA-2D',
    version: ADDON_VERSION,
    mobilePort: req.socket?.localPort === MOBILE_PORT,
    mobileAccessEnabled: !!mobileCfg.enabled,
    externalEnabled: !!mobileCfg.externalEnabled,
    externalUrl: String(mobileCfg.externalUrl || ''),
    externalMode: String(mobileCfg.externalMode || 'keendns_http'),
    pairingPasswordSet: mobilePairingPasswordIsSet(mobileCfg),
    pairingCodeActive: !!pending,
    pairedDevices: mobileAuth.listDevices().length,
    database: allhaDb.getInfo()
  });
});
app.get('/api/layout', (req,res)=>{ try{
  const lp=clientLevelPaths(req);
  res.json(loadEffectiveLayoutForRequest(req, lp.layout));
}catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/rooms', (req,res)=>{ try{ res.json(roomsApiPayloadForRequest(req)); }catch(e){ safeErrorResponse(req,res,e); } });
app.patch('/api/rooms/:room_id/virtual', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    setRoomVirtualFlag(req.params.room_id, req.body?.virtual === true, lp.rooms);
    res.json(roomsApiPayloadForRequest(req));
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.patch('/api/rooms/:room_id/hidden-devices', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    setRoomHiddenDevices(req.params.room_id, req.body?.hiddenDevices || [], lp.rooms);
    res.json(roomsApiPayloadForRequest(req));
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.get('/api/rooms/:room_id/standard-sensors/db', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    const rid=assertKnownRoomId(req.params.room_id, lp.rooms);
    const rooms=loadRoomsSettings(lp.rooms);
    res.json({ok:true, roomId:rid, dbBinding:standardSensorBindingsForRoom(lp.rooms, rid), roomStandardSensors:normalizeStandardSensors(rooms.rooms?.[rid]?.standardSensors || {}, {strict:false}), roomsPath:lp.rooms});
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.get('/api/rooms/:room_id/standard-sensor-suggestions', (req,res)=>{ try{ const lp=clientLevelPaths(req); res.json({ ok:true, ...standardSensorSuggestionsForRoom(req.params.room_id, { roomsPath: lp.rooms, devicesPath: lp.devicesJs }) }); }catch(e){ validationErrorResponse(req,res,e); } });
app.patch('/api/rooms/:room_id/standard-sensors/orientation', (req,res)=>{ try{ const lp=clientLevelPaths(req); setRoomStandardSensorOrientation(req.params.room_id, req.body?.orientation, lp.rooms, req.body?.scope); const payload=roomsApiPayloadForRequest(req); res.json(payload); }catch(e){ validationErrorResponse(req,res,e); } });
app.patch('/api/rooms/:room_id/standard-sensors', (req,res)=>{ try{ const lp=clientLevelPaths(req); saveRoomStandardSensors(req.params.room_id, req.body?.standardSensors || req.body || {}, lp.rooms); const payload=roomsApiPayloadForRequest(req); const rid=assertKnownRoomId(req.params.room_id, lp.rooms); payload.verifiedRoomBinding=standardSensorBindingsForRoom(lp.rooms, rid); res.json(payload); }catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/rooms/:room_id/standard-sensors/:sensor_type/save', (req,res)=>{ try{ const lp=clientLevelPaths(req); saveSingleRoomStandardSensor(req.params.room_id, req.params.sensor_type, req.body?.entity_id || req.body?.entityId || req.body?.value || '', lp.rooms); const payload=roomsApiPayloadForRequest(req); const rid=assertKnownRoomId(req.params.room_id, lp.rooms); payload.verifiedRoomBinding=standardSensorBindingsForRoom(lp.rooms, rid); res.json(payload); }catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/rooms/:room_id/standard-sensors/clear', (req,res)=>{ try{ const lp=clientLevelPaths(req); clearAllRoomStandardSensors(req.params.room_id, lp.rooms); const payload=roomsApiPayloadForRequest(req); res.json({ ...payload, cleared:true, clearedTypes:STANDARD_SENSOR_KEYS, suggestions:standardSensorSuggestionsForRoom(req.params.room_id, { roomsPath: lp.rooms, devicesPath: lp.devicesJs }).suggestions }); }catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/rooms/:room_id/standard-sensors/:sensor_type/clear', (req,res)=>{ try{ const lp=clientLevelPaths(req); clearRoomStandardSensor(req.params.room_id, req.params.sensor_type, lp.rooms); const suggestionPack=standardSensorSuggestionsForRoom(req.params.room_id, { roomsPath: lp.rooms, devicesPath: lp.devicesJs }).suggestions || {}; const payload=roomsApiPayloadForRequest(req); res.json({ ...payload, cleared:true, sensorType:req.params.sensor_type, suggestion:suggestionPack[req.params.sensor_type]?.[0] || null }); }catch(e){ validationErrorResponse(req,res,e); } });
app.get('/api/layout/diagnostics', (req,res)=>{ try{ const lp=clientLevelPaths(req); res.json(analyzeLayout(loadLayout(lp.layout))); }catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/layout/normalize', (req,res)=>{ try{res.json(normalizeStoredLayout());}catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/layout/clear-markers', (req,res)=>{ try{res.json(clearLayoutMarkers());}catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/layout/clear-zones', (req,res)=>{ try{res.json(clearLayoutZones());}catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/factory-reset', (req,res)=>{ try{res.json(factoryResetProject(req.body?.confirm));}catch(e){ validationErrorResponse(req,res,e); } });
app.get('/api/source-config', (req,res)=>{ try{ const lp=clientLevelPaths(req); res.json(loadSourceConfig(lp.sourceConfig)); }catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/source-config', (req,res)=>{ try{ const lp=clientLevelPaths(req); saveSourceConfig(req.body, lp.sourceConfig); res.json({ok:true, config: loadSourceConfig(lp.sourceConfig)}); }catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/layout', (req,res)=>{ try{
  const lp=clientLevelPaths(req);
  const saved=saveLayoutForRequest(req, req.body, lp.layout);
  const savedLayout=loadLayout(saved.layoutPath);
  res.json({
    ok:true,
    backup: saved.backup ? path.basename(saved.backup) : null,
    diagnostics: analyzeLayout(savedLayout),
    clientSettings:{ isClientOverride:!!saved.isClientOverride, client:saved.client, layoutPath:saved.layoutPath, baselinePath:saved.baselinePath }
  });
}catch(e){ validationErrorResponse(req,res,e); } });

app.post('/api/client-layout/current/reset-to-baseline', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    const overridePath=clientScopedPath(req, 'layout', lp.layout, 'json');
    if(!overridePath) return res.status(400).json({ok:false,error:'Текущий клиент использует baseline и не имеет отдельного override'});
    if(runtimeDocumentExists(overridePath)) atomicWriteJson(overridePath, loadLayout(lp.layout));
    res.json({ok:true, layout:loadEffectiveLayoutForRequest(req, lp.layout), clientSettings:{resetToBaseline:true, overridePath, baselinePath:lp.layout, client:currentClientIdentity(req)}});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/config', (req,res)=> { try { res.json(publicConfig(loadAddonConfig())); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/config', (req,res)=> {
  try {
    const body = req.body || {};
    // v3.5.8.2: Lovelace/dashboard paths are configured per level, not in global settings.
    const {dashboardPaths, dashboardPathText, ...globalBody} = body;
    const cfg = saveAddonConfig(globalBody || {});
    setSseBatchMs(cfg.sseBatchMs);
    res.json({ ok:true, config: publicConfig(cfg) });
  } catch(e){ safeErrorResponse(req,res,e); }
});

function normalizeMobileAccessPayload(input, current){
  const src = input || {};
  return normalizeMobileAccessConfig(src, current || defaultMobileAccessConfig());
}

app.get('/api/mobile/settings', (req, res) => {
  try {
    const cfg = loadAddonConfig();
    res.json({ ok: true, mobileAccess: publicConfig(cfg).mobileAccess });
  } catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/mobile/settings', (req, res) => {
  try {
    const input = req.body?.mobileAccess || req.body || {};
    const { next, reloaded } = saveMobileAccessConfig(input);
    const persisted = !!reloaded?.enabled === !!next.enabled
      && String(reloaded?.localUrl || '') === String(next.localUrl || '')
      && String(reloaded?.remoteUrl || '') === String(next.remoteUrl || '');
    if(!persisted){
      return res.status(500).json({
        ok:false,
        error:'Настройки мобильного доступа не были подтверждены после сохранения',
        expected:{ enabled:!!next.enabled, localUrl:next.localUrl, remoteUrl:next.remoteUrl },
        actual:{ enabled:!!reloaded?.enabled, localUrl:String(reloaded?.localUrl||''), remoteUrl:String(reloaded?.remoteUrl||'') }
      });
    }
    res.json({ ok:true, mobileAccess: publicConfig(loadAddonConfig()).mobileAccess });
  } catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/config/clear', (req,res)=> { try { const cfg=saveAddonConfig({ pollIntervalMs:30000, sseBatchMs:1000, dashboardPaths:[] }); setSseBatchMs(cfg.sseBatchMs); res.json({ok:true, config: publicConfig(loadAddonConfig())}); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/ha/test', async (req,res)=> { try { const data = await haFetch('/'); res.json({ ok:true, data }); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/system', (req,res)=> { try { res.json({ ok:true, version:ADDON_VERSION, mode:process.env.ALLHA_MODE === 'local-dev' ? 'local-dev' : 'home-assistant-addon', ingress:isIngressRequest(req), ingressPath:normalizeIngressProxyPath(req.headers['x-ingress-path'] || req.headers['x-forwarded-prefix'] || req.headers['referer'] || ''), hasHaToken:!!HA_TOKEN, hasSupervisorToken:!!HA_TOKEN }); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/ui-state', (req,res)=> { try {
  const lp=clientLevelPaths(req);
  res.json(loadEffectiveUiStateForRequest(req, lp.uiState));
} catch(e){ safeErrorResponse(req,res,e); } });


app.get('/api/security/rules', (req,res)=>{
  try{ res.json({ok:true, rules:loadSecurityRules(), security:publicSecurityConfig(loadAddonConfig().security)}); }
  catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/security/pin/change', (req,res)=>{
  try{
    const {pin,pin2}=req.body||{};
    if(String(pin)!==String(pin2)) return res.status(400).json({error:'PIN-коды не совпадают'});
    const security=setSecurityPin(pin);
    res.json({ok:true, security});
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/security/pin/reset', (req,res)=>{
  try{
    const {pin,pin2}=req.body||{};
    if(String(pin)!==String(pin2)) return res.status(400).json({error:'PIN-коды не совпадают'});
    if(!verifySecurityPin(pin)) return res.status(403).json({error:'Неверный PIN'});
    const security=clearSecurityPin();
    res.json({ok:true, security});
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/security/pin/verify', (req,res)=>{
  try{ res.json({ok:verifySecurityPin(req.body?.pin)}); }
  catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/security/dangerous', (req,res)=>{
  try{
    const cfg=loadAddonConfig();
    const sec=normalizeSecurityConfig(cfg.security);
    if(sec.panelMode!=='admin') return res.status(403).json({error:'Изменение dangerous доступно только в admin mode'});
    const entity_id=String(req.body?.entity_id||'').trim();
    if(!entity_id) return res.status(400).json({error:'entity_id required'});
    const dangerous=!!req.body?.dangerous;
    const rules=loadSecurityRules();
    rules.forceDangerous=rules.forceDangerous.filter(x=>x!==entity_id);
    rules.forceSafe=rules.forceSafe.filter(x=>x!==entity_id);
    if(dangerous) rules.forceDangerous.push(entity_id); else rules.forceSafe.push(entity_id);
    res.json({ok:true, rules:saveSecurityRules(rules)});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/attention', async (req,res)=> {
  try {
    const rules = loadAttentionRules();
    const pack = await haStatesForDiagnostics();
    res.json({ ...evaluateAttentionRules(rules, pack.states), statesSource: pack.source });
  } catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/attention', async (req,res)=> {
  try {
    const entity_id = String(req.body?.entity_id || '').trim();
    if(!entity_id) return res.status(400).json({error:'entity_id is required'});
    let st = statesCache?.get?.(entity_id) || null;
    if(!st && statesCache.size === 0){ try { st = await haFetch('/states/' + encodeURIComponent(entity_id)); } catch(e) { st = null; } }
    const current = st ? String(st.state) : String(req.body?.normal_state || 'unknown');
    const name = String(req.body?.name || st?.attributes?.friendly_name || entity_id);
    const data = loadAttentionRules();
    const rest = data.rules.filter(r=>r.entity_id !== entity_id);
    rest.push({ entity_id, name, normal_state: current, enabled:true, created_at:new Date().toISOString() });
    const saved = saveAttentionRules({version:1, rules: rest});
    const pack = await haStatesForDiagnostics();
    res.json({ ...evaluateAttentionRules(saved, pack.states), statesSource: pack.source });
  } catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/attention/:entity_id/normal', async (req,res)=> {
  try {
    const entity_id = decodeURIComponent(String(req.params.entity_id || '')).trim();
    if(!entity_id) return res.status(400).json({error:'entity_id is required'});
    const data = loadAttentionRules();
    const idx = data.rules.findIndex(r=>r.entity_id === entity_id);
    if(idx < 0) return res.status(404).json({error:'attention rule not found'});
    let st = statesCache?.get?.(entity_id) || null;
    if(!st && statesCache.size === 0){ try { st = await haFetch('/states/' + encodeURIComponent(entity_id)); } catch(e) { st = null; } }
    const current = st ? String(st.state) : String(req.body?.normal_state || data.rules[idx].current_state || data.rules[idx].normal_state || 'unknown');
    const nextRules = data.rules.slice();
    nextRules[idx] = { ...nextRules[idx], normal_state: current, enabled: true, updated_at: new Date().toISOString() };
    const saved = saveAttentionRules({version:1, rules: nextRules});
    const pack = await haStatesForDiagnostics();
    res.json({ ...evaluateAttentionRules(saved, pack.states), statesSource: pack.source });
  } catch(e){ safeErrorResponse(req,res,e); }
});

app.delete('/api/attention/:entity_id', async (req,res)=> {
  try {
    const entity_id = decodeURIComponent(String(req.params.entity_id || ''));
    const data = loadAttentionRules();
    const saved = saveAttentionRules({version:1, rules: data.rules.filter(r=>r.entity_id !== entity_id)});
    const pack = await haStatesForDiagnostics();
    res.json({ ...evaluateAttentionRules(saved, pack.states), statesSource: pack.source });
  } catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/attention/clear', async (req,res)=> {
  try { res.json(evaluateAttentionRules(saveAttentionRules(attentionDefault()), [])); }
  catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/ui-state', (req,res)=> { try {
  const lp=clientLevelPaths(req);
  const saved=saveUiStateForRequest(req, req.body || {}, lp.uiState);
  writeDebugLog('ui-state','save',{client:saved.client, path:saved.path, keys:Object.keys(req.body||{}), uiKeys:Object.keys(req.body?.ui||{})});
  res.json({ok:true, state:saved.state, clientSettings:{ isClientOverride:!!saved.isClientOverride, client:saved.client, path:saved.path, baselinePath:saved.baselinePath }});
} catch(e){
  writeDebugLog('ui-state','save failed',{error:e.message, stack:e.stack, body:req.body, client:currentClientIdentity(req)});
  safeErrorResponse(req,res,e);
} });
app.get('/api/diagnostics', async (req,res)=> { try { res.json({ ...(await buildDiagnostics(req)), ha:getHaStatus(), logs:{files:logFilesSummary()}, rateLimit:{trustProxy:trustedProxyEnabled(), storeSize:_rlStore.size, maxKeys:RATE_LIMIT_MAX_KEYS}, runtime:{inFlightRequests:_inFlightRequests,lastInFlightChangeAt:_lastInFlightChangeAt,shuttingDown:_shuttingDown}, performance:serverPerformanceStats(), dbPerformance: allhaDb.getPerformanceStats ? allhaDb.getPerformanceStats() : null }); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/maintenance/status', (req,res)=> { try { res.json({ ok:true, report: allhaDb.maintenanceReport ? allhaDb.maintenanceReport() : {database:allhaDb.getInfo()}, logs:{files:logFilesSummary()}, ha:getHaStatus(), rateLimit:{trustProxy:trustedProxyEnabled(), storeSize:_rlStore.size, maxKeys:RATE_LIMIT_MAX_KEYS}, runtime:{inFlightRequests:_inFlightRequests,lastInFlightChangeAt:_lastInFlightChangeAt,shuttingDown:_shuttingDown}, performance:serverPerformanceStats(), dbPerformance: allhaDb.getPerformanceStats ? allhaDb.getPerformanceStats() : null }); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/maintenance/context', (req,res)=> { try { res.json({ ok:true, context: resolveRequestContext(req) }); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/maintenance/mirror-diagnostics', (req,res)=> { try { res.json(mirrorDiagnostics()); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/maintenance/mirror-repair', express.json(), (req,res)=> { try { res.json(mirrorRepair(req.body || {})); } catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/maintenance/logs/clear', (req,res)=> { try { flushDebugLog(); res.json({ok:true, ...clearDebugLogs(), logs:{files:logFilesSummary()}}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/maintenance/web-clients/cleanup-temporary', (req,res)=> { try { res.json({ok:true, result: allhaDb.cleanupTemporaryWebClients ? allhaDb.cleanupTemporaryWebClients() : {removed:0}, report: allhaDb.maintenanceReport ? allhaDb.maintenanceReport() : null}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/maintenance/orphans/cleanup', (req,res)=> { try { res.json({ok:true, result: allhaDb.cleanupOrphanClientSettings ? allhaDb.cleanupOrphanClientSettings() : {}, report: allhaDb.maintenanceReport ? allhaDb.maintenanceReport() : null}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/maintenance/clients/cleanup', (req,res)=> { try { const temp = allhaDb.cleanupTemporaryWebClients ? allhaDb.cleanupTemporaryWebClients() : {removed:0}; const orphans = allhaDb.cleanupOrphanClientSettings ? allhaDb.cleanupOrphanClientSettings() : {}; const staleClientSettings = cleanupStaleClientSettingsDocuments(); res.json({ok:true, result:{temporaryWebClients:temp, orphans, staleClientSettings}, report: allhaDb.maintenanceReport ? allhaDb.maintenanceReport() : null, mirrorDiagnostics: mirrorDiagnostics()}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/maintenance/stale-client-settings/cleanup', (req,res)=> { try { res.json({ok:true, result: cleanupStaleClientSettingsDocuments(), mirrorDiagnostics: mirrorDiagnostics()}); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/backups', (req,res)=> { try { res.json({ok:true, backups:backupSummary()}); } catch(e){ safeErrorResponse(req,res,e); } });
app.get('/api/backups/download/:name', (req,res)=> { try { const rel=String(req.params.name||'').replace(/\\/g,'/'); if(!rel || rel.includes('..') || path.isAbsolute(rel)) throw new Error('Некорректное имя backup'); const target=path.join(LAYOUT_BACKUP_DIR, rel); if(!pathInside(LAYOUT_BACKUP_DIR,target) || !fs.existsSync(target)) throw new Error('Backup не найден'); if(fs.statSync(target).isDirectory()){ const tgz=createTarGzBuffer(target, path.basename(rel)); res.setHeader('Content-Type','application/gzip'); res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rel)}.tar.gz"`); return res.send(tgz); } res.download(target); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/backups/create', (req,res)=> { try { const item=createManualBackup(req.body?.reason||'manual'); res.json({ok:true, backup:item, backups:backupSummary()}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/backups/restore', (req,res)=> { try { const layout=restoreLayoutBackup(req.body?.name); res.json({ok:true, layout}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/backups/delete', (req,res)=> { try { deleteBackupItem(req.body?.name); res.json({ok:true, backups:backupSummary()}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/backups/delete-old', (req,res)=> { try { res.json({ok:true, backups:deleteOldBackups(req.body?.keep||10)}); } catch(e){ safeErrorResponse(req,res,e); } });
app.post('/api/backups/delete-all', (req,res)=> { try { res.json({ok:true, backups:deleteAllBackups(req.body?.confirm)}); } catch(e){ validationErrorResponse(req,res,e); } });
app.post('/api/backups/restore-full', (req,res)=> { try { res.json(restoreManualBackup(req.body?.name, req.body?.confirm)); } catch(e){ validationErrorResponse(req,res,e); } });

app.post('/api/ha/dashboard-paths/normalize', (req,res)=>{
  try { res.json({ ok:true, dashboardPaths: normalizeDashboardPaths(req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? '') }); }
  catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/ha/lovelace/raw', async (req,res)=>{
  try {
    const cfg = loadSourceConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await readLovelaceRawFromHa(paths);
    res.json({ ok:true, ...data, lovelaceDiagnostics:buildLovelaceDiagnosticsForLevel(ACTIVE_PROFILE_ID, ACTIVE_LEVEL_ID) });
  } catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/ha/lovelace/import', async (req,res)=>{
  try {
    const cfg = loadSourceConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await importLovelaceRaw(paths);
    res.json({ ok:true, ...data, lovelaceDiagnostics:buildLovelaceDiagnosticsForLevel(ACTIVE_PROFILE_ID, ACTIVE_LEVEL_ID) });
  } catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/ha/lovelace/import-stored', async (req,res)=>{
  try { const data=await importStoredLovelaceRaw(); res.json({ ...data, lovelaceDiagnostics:buildLovelaceDiagnosticsForLevel(ACTIVE_PROFILE_ID, ACTIVE_LEVEL_ID) }); }
  catch(e){ safeErrorResponse(req,res,e); }
});
const MAX_SSE_CLIENTS = Number(process.env.ALLHA_MAX_SSE_CLIENTS || 50);
const MAX_SSE_CLIENTS_PER_IP = Number(process.env.ALLHA_MAX_SSE_CLIENTS_PER_IP || 8);
const MAX_SSE_CLIENTS_PER_CLIENT = Number(process.env.ALLHA_MAX_SSE_CLIENTS_PER_CLIENT || 3);
const sseClientMeta = new Map();
function sseCounts(){
  const byIp = new Map();
  const byClient = new Map();
  for(const meta of sseClientMeta.values()){
    byIp.set(meta.ip, (byIp.get(meta.ip)||0)+1);
    byClient.set(meta.clientKey, (byClient.get(meta.clientKey)||0)+1);
  }
  return { byIp, byClient };
}
function sseClientKeyForRequest(req){
  try{
    const ident = currentClientIdentity(req);
    return `${ident.type}:${ident.id || 'unknown'}`;
  }catch(_){
    return `ip:${String(req.ip || req.socket?.remoteAddress || 'unknown')}`;
  }
}
/* SSE: browser subscribes to initial_states and live state_changed. */
app.get('/api/ha/events', (req, res) => {
  const ip = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const clientKey = sseClientKeyForRequest(req);
  const counts = sseCounts();
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    noteSseClientRejected();
    return res.status(429).json({ error: 'Слишком много SSE-подключений', maxClients: MAX_SSE_CLIENTS });
  }
  if (MAX_SSE_CLIENTS_PER_IP > 0 && (counts.byIp.get(ip)||0) >= MAX_SSE_CLIENTS_PER_IP) {
    noteSseClientRejected();
    return res.status(429).json({ error: 'Слишком много SSE-подключений с одного IP', maxPerIp: MAX_SSE_CLIENTS_PER_IP });
  }
  if (MAX_SSE_CLIENTS_PER_CLIENT > 0 && (counts.byClient.get(clientKey)||0) >= MAX_SSE_CLIENTS_PER_CLIENT) {
    noteSseClientRejected();
    return res.status(429).json({ error: 'Слишком много SSE-подключений для этого клиента', maxPerClient: MAX_SSE_CLIENTS_PER_CLIENT });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  sseClients.add(res);
  sseClientMeta.set(res, { ip, clientKey, connectedAt:new Date().toISOString(), lastHeartbeatAt:null });
  noteSseClientConnected();
  const states = [...statesCache.values()];
  if (states.length) res.write(`event: initial_states\ndata: ${JSON.stringify(states)}\n\n`);
  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
      const meta = sseClientMeta.get(res); if(meta) meta.lastHeartbeatAt = new Date().toISOString();
      noteSseHeartbeat();
    } catch (e) {
      sseClients.delete(res); sseClientMeta.delete(res); clearInterval(hb); noteSseClientDisconnected();
    }
  }, 25_000);
  if(hb.unref) hb.unref();
  req.on('close', () => { sseClients.delete(res); sseClientMeta.delete(res); clearInterval(hb); noteSseClientDisconnected(); });
});

app.get('/api/ha/states', async (req, res) => {
  try {
    if (statesCache.size > 0) return res.json({ ok: true, states: [...statesCache.values()] });
    // fallback: прямой запрос к HA пока кэш не прогрелся
    const states = await haFetch('/states');
    states.forEach(s => statesCache.set(s.entity_id, s));
    res.json({ ok: true, states });
  } catch (e) { safeErrorResponse(req,res,e); }
});
app.post('/api/ha/service', makeRateLimit(30, 60_000), async (req,res)=> {
  const {domain, service, data, confirmDangerous, pin} = req.body || {};
  const entity_id = data?.entity_id || '';
  try {
    if(!domain || !service) return res.status(400).json({error:'domain and service are required'});
    const cfg = loadAddonConfig();
    const security = normalizeSecurityConfig(cfg.security);
    const effectiveMode = effectivePanelModeForRequest(req, security);
    const category = commandCategory(domain, service, entity_id);
    if(effectiveMode === 'viewer'){
      appendCommandLog({domain,service,entity_id,result:'blocked-viewer'});
      return res.status(403).json({error:'Панель в режиме viewer: управление запрещено'});
    }
    if(category === 'blocked'){
      appendCommandLog({domain,service,entity_id,result:'blocked-allowlist'});
      console.warn(`[Smart Home UI] Blocked service call ${domain}.${service}`);
      return res.status(403).json({error:`Service ${domain}.${service} запрещён allowlist`});
    }
    if(category === 'dangerous'){
      if(effectiveMode === 'control' && security.dangerousRequirePin && security.pinEnabled && !verifySecurityPin(pin, security)){
        appendCommandLog({domain,service,entity_id,result:'pin-required',category});
        return res.status(409).json({requiresPin:true, message:`Введите PIN для опасной команды ${domain}.${service}${entity_id ? ' для '+entity_id : ''}`});
      }
      if(security.confirmDangerousServices && !confirmDangerous){
        return res.status(409).json({requiresConfirmation:true, message:`Подтвердить опасную команду ${domain}.${service}${entity_id ? ' для '+entity_id : ''}?`});
      }
    }
    const result = await haCallService(domain, service, data || {}, { timeoutMs: Number(process.env.ALLHA_HA_SERVICE_TIMEOUT_MS || 10_000) });
    appendCommandLog({domain,service,entity_id,result:'ok',category});
    res.json({ ok:true, result, category });
  } catch(e){ appendCommandLog({domain,service,entity_id,result:'error:'+e.message}); safeErrorResponse(req,res,e); }
});

/* ── Camera proxies ───────────────────────────────────────────── */
// MJPEG live stream: браузер показывает в <img> нативно
app.get('/api/camera/stream/:entity_id', makeRateLimit(20, 60_000), async (req, res) => {
  const entity_id = req.params.entity_id;
  if(!/^camera\.[a-zA-Z0-9_]+$/.test(entity_id)) return res.status(400).end();
  if(!HA_TOKEN) return res.status(503).end();
  try {
    const camRes = await fetch(`${HA_API_BASE}/camera_proxy_stream/${entity_id}`, {
      headers: { 'Authorization': `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(10_000)
    });
    if(!camRes.ok) return res.status(camRes.status).end();
    res.setHeader('Content-Type', camRes.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=--frame');
    res.setHeader('Cache-Control', 'no-store');
    const nodeStream = Readable.fromWeb(camRes.body);
    nodeStream.pipe(res);
    req.on('close', () => nodeStream.destroy());
  } catch(e) { if(!res.headersSent) res.status(500).end(); }
});

// Одиночный кадр (fallback / кнопка «Обновить»)
app.get('/api/camera/snapshot/:entity_id', makeRateLimit(60, 60_000), async (req, res) => {
  const entity_id = req.params.entity_id;
  if(!/^camera\.[a-zA-Z0-9_]+$/.test(entity_id)) return res.status(400).json({error:'Некорректный entity_id'});
  if(!HA_TOKEN) return res.status(503).json({error: process.env.ALLHA_MODE === 'local-dev' ? 'HA_TOKEN недоступен. Проверь config/local-config.json' : 'SUPERVISOR_TOKEN недоступен'});
  try {
    const camRes = await fetch(`${HA_API_BASE}/camera_proxy/${entity_id}`, {
      headers: { 'Authorization': `Bearer ${HA_TOKEN}` }
    });
    if(!camRes.ok) return res.status(camRes.status).json({error:`HA camera ${camRes.status}`});
    res.setHeader('Content-Type', camRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.from(await camRes.arrayBuffer()));
  } catch(e) { safeErrorResponse(req,res,e); }
});

/* ── Layout export / import ───────────────────────────────────── */
app.get('/api/export/layout', (req, res) => {
  try {
    const layout = loadLayout();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="allha2d-layout.json"');
    res.json(layout);
  } catch(e) { safeErrorResponse(req,res,e); }
});

app.post('/api/import/layout', express.json({limit:'5mb'}), (req, res) => {
  try {
    const { layout } = normalizeLayoutPayload(req.body, {strict:true});
    const backup = saveLayout(layout);
    res.json({ok:true, backup: backup ? path.basename(backup) : null});
  } catch(e) { validationErrorResponse(req,res,e); }
});

/* ── Database diagnostics ───────────────────────────────────────────── */
const RUNTIME_DB_DOCUMENTS = [
  'profiles.json','attention_rules.json','security_rules.json','addon_config.json','dashboard_proxy.json','command_log.json',
  'profiles/profile-1/levels/level-1/layout.json','profiles/profile-1/levels/level-1/rooms.json','profiles/profile-1/levels/level-1/source_config.json','profiles/profile-1/levels/level-1/ui_state.json','profiles/profile-1/levels/level-1/images/images_meta.json','profiles/profile-1/levels/level-1/devices.json','profiles/profile-1/levels/level-1/lovelace_raw.json'
];
const RUNTIME_DB_FILES = [
  'profiles/profile-1/levels/level-1/devices.js',
  'profiles/profile-1/levels/level-1/lovelace-source.js'
];
function runtimeStorageDiagnostics(){
  const db = allhaDb.getInfo();
  const documents = [];
  const files = [];
  const knownDocs = new Map((allhaDb.listProjectDocumentKeys ? allhaDb.listProjectDocumentKeys() : []).map(x=>[x.doc_key,x]));
  for(const key of RUNTIME_DB_DOCUMENTS){
    const file = path.join(DATA_DIR, key);
    const inDb = allhaDb.hasProjectDocument ? allhaDb.hasProjectDocument(key) : false;
    let size = 0; let mirrorUpdatedAt = null;
    try{ if(fs.existsSync(file)){ const st=fs.statSync(file); size=st.size; mirrorUpdatedAt=st.mtime.toISOString(); } }catch(e){}
    documents.push({ key, inDb, mirrorExists: fs.existsSync(file), sourceUsed: inDb ? 'sqlite' : (fs.existsSync(file) ? 'json-fallback-migrated-on-read' : 'default'), dbUpdatedAt: knownDocs.get(key)?.updated_at || null, mirrorUpdatedAt, sizeBytes:size });
  }
  for(const key of RUNTIME_DB_FILES){
    const file = path.join(DATA_DIR, key);
    const inDb = !!(allhaDb.getProjectFile && allhaDb.getProjectFile(key, null) !== null);
    let size = 0; let mirrorUpdatedAt = null;
    try{ if(fs.existsSync(file)){ const st=fs.statSync(file); size=st.size; mirrorUpdatedAt=st.mtime.toISOString(); } }catch(e){}
    files.push({ key, inDb, mirrorExists: fs.existsSync(file), sourceUsed: inDb ? 'sqlite' : (fs.existsSync(file) ? 'file-fallback-migrated-on-read' : 'default'), mirrorUpdatedAt, sizeBytes:size });
  }
  let roomsDebug = null;
  try{
    const rawRooms = readJsonSafe(ROOMS_SETTINGS_PATH, {rooms:{}});
    const normalizedRooms = normalizeRoomsSettings(rawRooms, {filterUnknownRooms:false});
    const knownRoomIds = listKnownRoomIds({roomsPath:ROOMS_SETTINGS_PATH, devicesPath:DEVICES_PATH});
    const {profileId, levelId} = profileLevelFromRoomsPath(ROOMS_SETTINGS_PATH);
    const bindings = allhaDb.hasDb && allhaDb.hasDb() ? (allhaDb.getStandardSensorBindingsForLevel(profileId, levelId) || {}) : {};
    roomsDebug = {
      dbRoomsCount: Object.keys(rawRooms?.rooms || {}).length,
      normalizedRoomsCount: Object.keys(normalizedRooms.rooms || {}).length,
      knownRoomIdsCount: knownRoomIds.length,
      standardSensorBindingsRooms: Object.keys(bindings).length,
      standardSensorBindingsCount: Object.values(bindings).reduce((a,b)=>a+Object.keys(b||{}).length,0),
      devicesSource: runtimeFileSource(DEVICES_PATH),
      lovelaceRawSource: runtimeDocumentSource(activeLevelPaths().lovelaceRaw)
    };
    runtimeAudit.devicesSource = roomsDebug.devicesSource;
    runtimeAudit.lovelaceRawSource = roomsDebug.lovelaceRawSource;
  }catch(e){ roomsDebug = { error:e.message }; }
  return { ...db, mode:'sqlite-primary-json-mirror', documents, files, audit:{...runtimeAudit}, roomsDebug };
}

function standardSensorsDiagnosticsSnapshot(roomIdRaw, req){
  const lp = req ? clientLevelPaths(req) : activeLevelPaths();
  const rid = roomIdRaw ? assertKnownRoomId(roomIdRaw, lp.rooms) : '';
  const rawRooms = readJsonSafe(lp.rooms, {rooms:{}});
  const loadedRooms = loadRoomsSettings(lp.rooms);
  const bindings = standardSensorBindingsForRoomsPath(lp.rooms);
  const roomFromRaw = rid ? (rawRooms.rooms?.[rid] || null) : null;
  const roomFromLoaded = rid ? (loadedRooms.rooms?.[rid] || null) : null;
  return {
    ts: new Date().toISOString(),
    roomId: rid,
    profileLevel: profileLevelFromRoomsPath(lp.rooms),
    roomsPath: lp.rooms,
    devicesPath: lp.devicesJs,
    devicesSource: runtimeFileSource(lp.devicesJs),
    roomsSource: runtimeDocumentSource(lp.rooms),
    rawRoomStandardSensors: normalizeStandardSensors(roomFromRaw?.standardSensors || {}, {strict:false}),
    loadedRoomStandardSensors: normalizeStandardSensors(roomFromLoaded?.standardSensors || {}, {strict:false}),
    dbBinding: rid ? normalizeStandardSensors(bindings?.[rid] || {}, {strict:false}) : {},
    allDbBindingRoomIds: Object.keys(bindings || {}),
    allLoadedRoomIds: Object.keys(loadedRooms.rooms || {}),
    knownRoomIds: listKnownRoomIds({roomsPath:lp.rooms, devicesPath:lp.devicesJs})
  };
}

app.get('/api/database/info', (req, res) => {
  try { res.json({ ok:true, database: runtimeStorageDiagnostics(), logLevel: currentLogLevel(), recentErrors: logBuffer.filter(x=>x.level==='error').slice(-20) }); }
  catch(e){ safeErrorResponse(req,res,e); }
});


app.get('/api/diagnostics/logs', (req,res)=>{
  try{
    const level = currentLogLevel();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit||200)));
    res.json({ ok:true, level, logs: logBuffer.slice(-limit) });
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.post('/api/diagnostics/log-level', (req,res)=>{
  try{
    const level = String(req.body?.level || '').toLowerCase();
    if(!['error','info','debug'].includes(level)) return res.status(400).json({ok:false,error:'log level must be error, info or debug'});
    const cfg = readJsonSafe(ADDON_CONFIG_PATH, {}) || {};
    cfg.logLevel = level;
    atomicWriteJson(ADDON_CONFIG_PATH, cfg);
    setCachedLogLevel(level);
    logInfo('diagnostics', 'log level changed', {level});
    res.json({ok:true, level});
  }catch(e){ safeErrorResponse(req,res,e); }
});



app.post('/api/diagnostics/client-trace', (req,res)=>{
  try{
    logDebug('client-trace', req.body?.message || 'client trace', req.body?.details || req.body || {});
    res.json({ok:true});
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/diagnostics/standard-sensors/full', (req,res)=>{
  try{
    const roomId = String(req.query.room_id || req.query.roomId || '');
    res.json({ok:true, snapshot: standardSensorsDiagnosticsSnapshot(roomId, req)});
  }catch(e){ validationErrorResponse(req,res,e); }
});


app.get('/api/debug/virtual-room-state', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    const roomId=String(req.query.room || req.query.room_id || req.query.roomId || '').trim();
    const rawRooms=readJsonSafe(lp.rooms, {rooms:{}});
    const normalizedRooms=normalizeRoomsSettings(rawRooms, {filterUnknownRooms:false});
    const hydratedRooms=loadRoomsSettings(lp.rooms);
    const apiPayload=roomsApiPayloadForRequest(req);
    const pick=(obj)=> roomId && obj?.rooms ? (obj.rooms[roomId] || null) : null;
    const known=(apiPayload.knownRooms||[]).find(r=>String(r.id||'')===roomId || String(r.settings?.label||'')===roomId || String(r.label||'')===roomId) || null;
    res.json({ ok:true, roomId, roomsPath:lp.rooms, raw:pick(rawRooms), normalized:pick(normalizedRooms), hydrated:pick(hydratedRooms), apiRooms:pick(apiPayload), apiKnown:known, apiRoomsKeys:Object.keys(apiPayload.rooms||{}), knownRoomIds:(apiPayload.knownRooms||[]).map(r=>r.id) });
  }catch(e){ safeErrorResponse(req,res,e); }
});

app.get('/api/rooms/debug', (req,res)=>{
  try{
    const lp=clientLevelPaths(req);
    const rawRooms = readJsonSafe(lp.rooms, {rooms:{}});
    const normalizedRooms = normalizeRoomsSettings(rawRooms, {filterUnknownRooms:false});
    const hydratedRooms = loadRoomsSettings(lp.rooms);
    const knownRoomIds = listKnownRoomIds({roomsPath:lp.rooms, devicesPath:lp.devicesJs});
    const {profileId, levelId} = profileLevelFromRoomsPath(lp.rooms);
    const bindings = standardSensorBindingsForRoomsPath(lp.rooms);
    res.json({ ok:true, profileId, levelId, roomsPath:lp.rooms, devicesPath:lp.devicesJs, devicesSource:runtimeFileSource(lp.devicesJs), lovelaceRawSource:runtimeDocumentSource(lp.lovelaceRaw), rawRoomsCount:Object.keys(rawRooms?.rooms||{}).length, normalizedRoomsCount:Object.keys(normalizedRooms.rooms||{}).length, hydratedRoomsCount:Object.keys(hydratedRooms.rooms||{}).length, knownRoomIds, standardSensorBindings:bindings, hydratedStandardSensors:Object.fromEntries(Object.entries(hydratedRooms.rooms||{}).map(([rid,room])=>[rid, normalizeStandardSensors(room?.standardSensors||{})]).filter(([,s])=>Object.keys(s).length)), audit:{...runtimeAudit} });
  }catch(e){ safeErrorResponse(req,res,e); }
});


function ensureMobileAccessEnabledForCode(){
  const cfg = loadAddonConfig();
  const mobile = {
    ...(cfg.mobileAccess || {}),
    enabled: true,
    localUrl: String(cfg.mobileAccess?.localUrl ?? '').trim(),
    remoteUrl: String(cfg.mobileAccess?.remoteUrl ?? '').trim(),
    pairingPassword: String(cfg.mobileAccess?.pairingPassword ?? '').trim(),
    qrPassword: String(cfg.mobileAccess?.qrPassword ?? '').trim()
  };
  saveAddonConfig({ ...cfg, mobileAccess: mobile });
  return true;
}


function mobileRequestInfo(req){
  return {
    ip: getForwardedIp(req) || req.socket?.remoteAddress || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0,240),
    forwardedFor: String(req.headers['x-forwarded-for'] || '').slice(0,240),
    forwardedProto: String(req.headers['x-forwarded-proto'] || '').slice(0,64),
    host: String(req.headers.host || '').slice(0,160),
    mobilePort: req.socket?.localPort === MOBILE_PORT
  };
}
function mobileAudit(eventType, req, payload = {}){
  try{
    const body = req?.body || {};
    const deviceId = String(payload.deviceId || payload.device_id || body.device_id || body.deviceId || body.clientId || req?.headers?.['x-device-id'] || '').slice(0,96);
    const safePayload = { ...payload, request: mobileRequestInfo(req) };
    if(safePayload.password) safePayload.password = '***';
    if(safePayload.token) safePayload.token = '***';
    if(allhaDb.addAccessEvent) allhaDb.addAccessEvent({ deviceId, eventType, payload: safePayload });
    debugLog('mobile', eventType, safePayload);
  }catch(e){}
}
const _mobilePairFailures = new Map();
function mobilePairingFailureKey(req, code, deviceId){
  const ip = getForwardedIp(req) || req.socket?.remoteAddress || 'unknown';
  return [ip, String(code||'').slice(0,6), String(deviceId||'').slice(0,96)].join('|');
}
function noteMobilePairFailure(req, code, deviceId){
  const key = mobilePairingFailureKey(req, code, deviceId);
  const now = Date.now();
  let e = _mobilePairFailures.get(key);
  if(!e || now > e.resetAt) e = { count:0, resetAt: now + 10*60_000, blockedUntil:0 };
  e.count += 1;
  if(e.count >= 10) e.blockedUntil = now + 10*60_000;
  _mobilePairFailures.set(key, e);
  return e;
}
function checkMobilePairBlocked(req, code, deviceId){
  const e = _mobilePairFailures.get(mobilePairingFailureKey(req, code, deviceId));
  if(e && e.blockedUntil && Date.now() < e.blockedUntil) return Math.ceil((e.blockedUntil - Date.now())/1000);
  return 0;
}
function clearMobilePairFailures(req, code, deviceId){ _mobilePairFailures.delete(mobilePairingFailureKey(req, code, deviceId)); }
setInterval(()=>{ const now=Date.now(); _mobilePairFailures.forEach((e,k)=>{ if(now>e.resetAt && (!e.blockedUntil || now>e.blockedUntil)) _mobilePairFailures.delete(k); }); }, 300_000).unref();

/* ── Mobile access API ──────────────────────────────────────────────── */

// Генерация кода — только с локального IP (только admin)
app.get('/api/mobile/code', (req, res) => {
  if (!isLocalIp(req)) return res.status(403).json({ error: 'Только из локальной сети' });
  if (!mobileAccessEnabled()) return res.status(403).json({ error: 'Мобильный доступ выключен. Включите его в настройках ALLHA-2D.' });
  try {
    const existing = mobileAuth.getPendingCode();
    const out = existing || mobileAuth.generatePairingCode();
    if(!existing) mobileAudit('mobile_pair_code_created', req, { expiresIn:out.expires_in });
    res.json(out);
  } catch (e) { safeErrorResponse(req,res,e); }
});

app.post('/api/mobile/code/new', (req, res) => {
  if (!isLocalIp(req)) return res.status(403).json({ error: 'Только из локальной сети' });
  if (!mobileAccessEnabled()) return res.status(403).json({ error: 'Мобильный доступ выключен. Включите его в настройках ALLHA-2D.' });
  try { const out=mobileAuth.generatePairingCode(); mobileAudit('mobile_pair_code_created', req, { expiresIn:out.expires_in, forced:true }); res.json(out); }
  catch (e) { safeErrorResponse(req,res,e); }
});


app.get('/api/mobile/debug/config', (req, res) => {
  if (!isLocalIp(req)) return res.status(403).json({ error: 'Только из локальной сети' });
  const cfg = loadAddonConfig();
  res.json({
    ok: true,
    mode: process.env.ALLHA_MODE || '',
    mobileAccess: (() => {
      const m = loadMobileAccessConfig();
      return {
        enabled: !!m.enabled,
        persistedEnabled: !!m.enabled,
        localUrl: String(m.localUrl || ''),
        remoteUrl: String(m.remoteUrl || ''),
        externalEnabled: !!m.externalEnabled,
        externalUrl: String(m.externalUrl || ''),
        externalMode: String(m.externalMode || 'keendns_http'),
        hasPairingPassword: mobilePairingPasswordIsSet(m),
        source: runtimeDocumentSource(MOBILE_ACCESS_PATH),
        addonConfigSource: runtimeDocumentSource(ADDON_CONFIG_PATH)
      };
    })(),
    pendingCode: !!mobileAuth.getPendingCode()
  });
});

app.delete('/api/mobile/code', (req, res) => {
  if (!isLocalIp(req)) return res.status(403).json({ error: 'Только из локальной сети' });
  mobileAuth.cancelPendingCode();
  mobileAudit('mobile_pair_code_cancelled', req, {});
  res.json({ ok: true });
});

// Паринг — открытый эндпоинт (с rate-limit)


function buildMobileConfigQrPayload(req){
  const m = loadMobileAccessConfig();
  const localUrl = String(m.localUrl || '').trim();
  const remoteUrl = String(m.remoteUrl || m.externalUrl || '').trim();
  const plainPassword = String(m.qrPassword || m.pairingPassword || '').trim();
  const mode = localUrl && remoteUrl ? 'both' : (remoteUrl ? 'web' : 'local');
  return {
    l: localUrl,
    r: remoteUrl,
    p: plainPassword,
    m: mode
  };
}
function maskMobileConfigQrPayload(payload){
  return { ...(payload || {}), p: payload?.p ? '***' : '' };
}


app.get('/api/mobile/config-qr', async (req, res) => {
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  try {
    const payload = buildMobileConfigQrPayload(req);
    const jsonText = JSON.stringify(payload);
    let qrDataUrl = '';
    try {
      const QRCode = require('qrcode');
      qrDataUrl = await QRCode.toDataURL(jsonText, { errorCorrectionLevel: 'M', margin: 2, width: 256 });
    } catch (e) {
      qrDataUrl = '';
    }
    res.json({ ok:true, payload, maskedPayload: maskMobileConfigQrPayload(payload), json: jsonText, qrDataUrl, passwordIncluded: !!payload.p });
  } catch(e){ safeErrorResponse(req,res,e); }
});

function normalizeMobilePairingCode(value){
  return String(value || '').replace(/[^A-Z0-9]/gi, '').toUpperCase().trim();
}
function normalizeMobileDeviceAliasInput(body, deviceId){
  const source = body && typeof body === 'object' ? body : {};
  let alias = String(
    source.mobileDeviceAlias ?? source.alias ?? source.deviceName ?? source.clientAlias ?? source.deviceAlias ?? source.name ?? ''
  ).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if(alias.length > 64) alias = alias.slice(0, 64);
  if(alias) return alias;
  const id = String(deviceId || source.deviceId || source.device_id || '').trim();
  if(id){
    const tail = id.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
    if(tail) return `Мобильное устройство ${tail}`;
  }
  return 'Мобильное устройство';
}

function generateMobileDeviceIdFromPairRequest(req){
  const body = req.body || {};
  const explicit = String(
    body.device_id || body.deviceId || body.deviceID || body.id ||
    body.clientId || body.client_id || body.installId || body.install_id ||
    body.uuid || body.deviceUuid || ''
  ).trim();
  if(explicit) return explicit.slice(0, 96);
  const seed = [
    body.deviceName || body.name || '',
    body.model || body.deviceModel || '',
    body.manufacturer || '',
    body.platform || '',
    body.osVersion || body.os_version || '',
    body.screen || '',
    req.headers['user-agent'] || '',
    Date.now().toString(36),
    Math.random().toString(36).slice(2)
  ].join('|');
  return 'phone_' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

app.post('/api/mobile/pair', makeRateLimit(5, 60_000), express.json(), (req, res) => {
  try {
    const { password } = req.body || {};
    const code = normalizeMobilePairingCode(req.body?.code || req.body?.pairingCode || req.body?.pairing_code || req.body?.pin || req.body?.mobileCode);
    const device_id = generateMobileDeviceIdFromPairRequest(req);
    const cfg = loadAddonConfig();
    const mobileCfg = loadMobileAccessConfig();
    if (!mobileAccessEnabled()) { mobileAudit('mobile_pair_disabled', req, { deviceId:device_id, codeProvided:!!code }); return res.status(403).json({ error: 'Мобильный доступ выключен в настройках ALLHA-2D. Включите мобильный доступ и создайте новый код.' }); }
    const blockedSeconds = checkMobilePairBlocked(req, code, device_id);
    if(blockedSeconds > 0){ mobileAudit('mobile_pair_blocked', req, { deviceId:device_id, blockedSeconds }); return res.status(429).json({ error: `Слишком много ошибок подключения. Повторите через ${blockedSeconds} с.` }); }
    if (mobilePairingPasswordIsSet(mobileCfg)) {
      if (!verifyMobilePairingPassword(mobileCfg, password)) {
        const e = noteMobilePairFailure(req, code, device_id);
        mobileAudit('mobile_pair_failed_password', req, { deviceId:device_id, codeProvided:!!code, failures:e.count });
        return res.status(403).json({ error: 'Неверный пароль сервера' });
      }
    }
    const requestedAlias = normalizeMobileDeviceAliasInput(req.body || {}, device_id);
    const meta = {
      mobileDeviceAlias: requestedAlias,
      alias: requestedAlias,
      clientAlias: requestedAlias,
      deviceName: requestedAlias,
      platform: req.body?.platform,
      model: req.body?.model || req.body?.deviceModel,
      manufacturer: req.body?.manufacturer,
      osVersion: req.body?.osVersion || req.body?.os_version,
      appVersion: req.body?.appVersion || req.body?.app_version || ADDON_VERSION,
      userAgent: req.body?.userAgent || req.headers['user-agent'],
      screen: req.body?.screen
    };
    const token = mobileAuth.consumeCode(code, device_id, meta);
    // Ensure aliases from new APKs win over model/user-agent fallback names.
    try { if (requestedAlias) mobileAuth.renameDevice(device_id, requestedAlias); } catch (_) {}
    clearMobilePairFailures(req, code, device_id);
    const pairedDevice = mobileAuth.getDevice(device_id) || null;
    const pairedAlias = String(pairedDevice?.alias || pairedDevice?.name || requestedAlias || meta.mobileDeviceAlias || meta.alias || meta.deviceName || meta.clientAlias || '').trim();
    mobileAudit('mobile_pair_success', req, { deviceId:device_id, alias:pairedAlias, model:meta.model, platform:meta.platform, externalEnabled:!!mobileCfg.externalEnabled });
    res.json({ ok: true, token, deviceId: device_id, device_id, mobileDeviceAlias: pairedAlias, alias: pairedAlias, deviceName: pairedAlias, clientAlias: pairedAlias, devices: mobileAuth.listDevices() });
  } catch (e) {
    try{ const code = normalizeMobilePairingCode(req.body?.code || req.body?.pairingCode || req.body?.pairing_code || req.body?.pin || req.body?.mobileCode); const device_id = generateMobileDeviceIdFromPairRequest(req); const f = noteMobilePairFailure(req, code, device_id); mobileAudit('mobile_pair_failed_code', req, { deviceId:device_id, codeProvided:!!code, error:e.message, failures:f.count }); }catch{}
    validationErrorResponse(req,res,e);
  }
});

// Проверка мобильной сессии — используется APK перед переходом в основной UI.
app.get('/api/mobile/session', (req, res) => {
  const auth = mobileAuthFromHeaders(req);
  if (!auth.ok) return res.status(401).json({ ok:false, error:'Токен устройства отозван или недействителен' });
  const device = auth.device || mobileAuth.getDevice(auth.deviceId) || null;
  res.json({ ok:true, device, accessMode: device?.accessMode || 'control', profileAccess: device?.profileAccess || { mode:'all', profileIds:[] }, settings: device?.settings || {} });
});


app.get('/api/mobile/audit', (req,res)=>{
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  try{ res.json({ ok:true, events: allhaDb.listAccessEvents ? allhaDb.listAccessEvents('mobile_', Number(req.query.limit || 100)) : [] }); }
  catch(e){ safeErrorResponse(req,res,e); }
});
app.get('/api/mobile/external-status', (req,res)=>{
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  const m = loadMobileAccessConfig();
  const events = allhaDb.listAccessEvents ? allhaDb.listAccessEvents('mobile_', 50) : [];
  res.json({ ok:true, mobileAccess:{ enabled:!!m.enabled, localUrl:String(m.localUrl||''), remoteUrl:String(m.remoteUrl||''), externalEnabled:!!m.externalEnabled, externalUrl:String(m.externalUrl||''), externalMode:String(m.externalMode||'keendns_http'), hasPairingPassword:mobilePairingPasswordIsSet(m), pairedDevices:mobileAuth.listDevices().length }, pendingCode:!!mobileAuth.getPendingCode(), recentEvents:events.slice(0,20), request:mobileRequestInfo(req), rateLimit:{ activePairingFailureBuckets:_mobilePairFailures.size } });
});

// Список устройств — только локально
app.get('/api/mobile/devices', (req, res) => {
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  res.json({ ok:true, devices: mobileAuth.listDevices() });
});

// Переименование
app.patch('/api/mobile/devices/:id', express.json(), (req, res) => {
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  try {
    const body = req.body || {};
    const patch = {};
    if (body.accessMode !== undefined) {
      const mode = String(body.accessMode || 'control');
      if (!['viewer','control','admin'].includes(mode)) throw new Error('Некорректный режим доступа');
      patch.accessMode = mode;
    }
    // Server UI intentionally manages only server-side access mode. APK behaviour
    // settings (server choice, autostart, keep-screen-on, background, app scale)
    // are owned by the mobile app and are not persisted from this endpoint.
    if (Object.keys(patch).length) mobileAuth.updateDevice(req.params.id, patch);
    res.json({ ok: true, devices: mobileAuth.listDevices() });
  } catch (e) { validationErrorResponse(req,res,e); }
});

// Отзыв токена
app.delete('/api/mobile/devices/:id', (req, res) => {
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  try {
    mobileAuth.revokeDevice(req.params.id);
    res.json({ ok: true, devices: mobileAuth.listDevices() });
  } catch (e) { validationErrorResponse(req,res,e); }
});

// Отзыв всех токенов
app.delete('/api/mobile/devices', (req, res) => {
  if (!allowMobileManagement(req)) return res.status(403).json({ error: 'Только из локальной сети / панели Home Assistant' });
  mobileAuth.revokeAllDevices();
  res.json({ ok: true, devices: [] });
});


/* ── Local web clients for LAN browser access on host port 8099 ─────── */
function webClientBaseUrl(req){
  const host = requestHostname(req) || 'IP_HOME_ASSISTANT';
  return `http://${host}:${DIRECT_DASHBOARD_PORT}`;
}
function publicWebClient(client, req){
  if(!client) return null;
  return {
    clientId: client.client_id,
    client_id: client.client_id,
    name: client.name,
    alias: client.alias,
    description: client.description,
    slug: client.slug,
    url: client.slug ? `${webClientBaseUrl(req)}/client/${client.slug}` : '',
    userAgent: client.userAgent,
    screen: client.screen,
    firstSeen: client.firstSeen,
    lastSeen: client.lastSeen,
    settings: client.settings || {}
  };
}
app.get('/api/web-clients', (req,res)=>{
  try{
    const mobileIds = new Set((mobileAuth.listDevices() || []).map(d => String(d.device_id || '')));
    const seen = new Set();
    const clients = (allhaDb.listWebClients ? allhaDb.listWebClients() : [])
      .filter(c => c && c.client_id && !mobileIds.has(String(c.client_id)))
      .filter(c => {
        // Не показываем явные дубли одной и той же постоянной ссылки. Старые временные
        // web_ записи без slug пока оставляем, чтобы админ мог удалить их вручную.
        const key = c.slug ? ('slug:'+c.slug) : ('id:'+c.client_id);
        if(seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(c=>publicWebClient(c, req));
    res.json({ ok:true, baseUrl:webClientBaseUrl(req), clients });
  }catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/web-clients', express.json(), (req,res)=>{
  try{
    const body=req.body||{};
    const client = allhaDb.createWebClient({
      clientId: body.clientId || body.client_id,
      alias: body.alias || body.name || 'web-client',
      name: body.name || body.alias || 'web-client',
      description: body.description || '',
      userAgent: req.headers['user-agent'] || body.userAgent || '',
      screen: body.screen || '',
      settings: body.settings || {}
    });
    res.json({ ok:true, client: publicWebClient(client, req) });
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/web-clients/touch', express.json(), (req,res)=>{
  try{
    const body=req.body||{};
    const headerId = sanitizeClientId(req.headers['x-client-id'] || '');
    const requestedSlug = String(body.slug || '').trim();
    let client = null;
    if(requestedSlug && allhaDb.getWebClientBySlug) client = allhaDb.getWebClientBySlug(requestedSlug);
    if(client){
      allhaDb.touchWebClient(client.client_id, { userAgent:req.headers['user-agent'] || '', screen:body.screen || '' });
      client = allhaDb.getWebClient(client.client_id);
    } else if(headerId) {
      if(mobileAuth.getDevice && mobileAuth.getDevice(headerId)){
        return res.json({ ok:true, skipped:true, reason:'mobile-device-id', client:null });
      }
      const existing = allhaDb.getWebClient ? allhaDb.getWebClient(headerId) : null;
      // v4.2.0.22: touch must not create random persistent web_* rows.
      // New web clients are created only via /api/web-clients or by opening a known /client/<slug>.
      // This prevents mobile WebView/Chrome on :32457 from spawning parallel web clients.
      if(!existing && !requestedSlug){
        return res.json({ ok:true, skipped:true, reason:'no-client-slug', client:null });
      }
      if(!existing && requestedSlug){
        return res.status(404).json({ ok:false, error:'Web-клиент не найден. Создайте новую ссылку на стартовой странице.' });
      }
      client = allhaDb.touchWebClient(headerId, { alias:body.alias || headerId, userAgent:req.headers['user-agent'] || '', screen:body.screen || '', settings:body.settings || {} });
    } else {
      return res.json({ ok:true, skipped:true, reason:'no-client-id', client:null });
    }
    res.json({ ok:true, client: publicWebClient(client, req) });
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.delete('/api/web-clients', express.json(), (req,res)=>{
  try{
    const keepCurrent = req.body?.keepCurrent !== false; // safe default: keep the current /client session
    const keepIds = [];
    if(keepCurrent){
      const c = currentClientIdentity(req);
      if(c?.id && c.type === 'web_client') keepIds.push(c.id);
    }
    const result = allhaDb.deleteAllWebClients ? allhaDb.deleteAllWebClients({keepClientIds:keepIds}) : {deleted:0, clientIds:[]};
    res.json({ ok:true, keptCurrent: keepCurrent, keepClientIds: keepIds, ...result });
  }catch(e){ validationErrorResponse(req,res,e); }
});

app.patch('/api/web-clients/:id', express.json(), (req,res)=>{
  try{
    const client = allhaDb.updateWebClient(req.params.id, req.body || {});
    if(!client) return res.status(404).json({ ok:false, error:'Web client not found' });
    res.json({ ok:true, client: publicWebClient(client, req) });
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/web-clients/:id/regenerate-link', (req,res)=>{
  try{
    const client = allhaDb.updateWebClient(req.params.id, { regenerateSlug:true });
    if(!client) return res.status(404).json({ ok:false, error:'Web client not found' });
    res.json({ ok:true, client: publicWebClient(client, req) });
  }catch(e){ validationErrorResponse(req,res,e); }
});
app.delete('/api/web-clients/:id', (req,res)=>{
  try{ allhaDb.deleteWebClient(req.params.id); res.json({ ok:true }); }
  catch(e){ validationErrorResponse(req,res,e); }
});
app.post('/api/web-clients/:id/clear-settings', (req,res)=>{
  try{
    if(!allhaDb.clearWebClientSettings) return res.status(501).json({ok:false,error:'clear settings not supported'});
    allhaDb.clearWebClientSettings(req.params.id);
    const client=allhaDb.getWebClient(req.params.id);
    res.json({ok:true, client: client ? publicWebClient(client, req) : null});
  } catch(e){ validationErrorResponse(req,res,e); }
});

/* ── Per-client preferences (profile, panelMode, UI scales per device) ─ */
const CLIENT_PREFS_DIR = path.join(DATA_DIR, 'client-prefs');

function sanitizeClientId(id) {
  // Allow only safe chars to prevent path traversal
  return String(id || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 128);
}
function getClientPrefs(clientId) {
  const safe = sanitizeClientId(clientId);
  if(!safe) return {};
  const legacyPath = path.join(CLIENT_PREFS_DIR, `${safe}.json`);
  if(allhaDb.hasDb && allhaDb.hasDb()){
    const dbPrefs = allhaDb.getWebClientSettings(safe);
    if(dbPrefs) return dbPrefs;
    // v4.2.0.27: do not let old client-prefs JSON resurrect deleted/missing DB web-clients.
    try{ if(!allhaDb.getWebClient || !allhaDb.getWebClient(safe)) return {}; }catch(_){ return {}; }
    // DB-primary final polish: old client-prefs JSON is migration-only.
    // If a legacy file appears after the initial DB migration marker was already set,
    // import it once into web_client_settings and then keep runtime on SQLite.
    const legacy = readJsonFileOnly(legacyPath, null);
    if(legacy && isPlainObject(legacy)){
      runtimeAudit.legacyClientPrefsFallbackReads += 1;
      const meta = { userAgent:'', name: legacy.name || legacy.alias || safe, alias: legacy.alias || legacy.name || safe, slug: legacy.slug || '' };
      if(allhaDb.setWebClientSettings(safe, legacy, meta)){
        runtimeAudit.legacyClientPrefsImported += 1;
        return allhaDb.getWebClientSettings(safe) || legacy;
      }
      return legacy;
    }
    return {};
  }
  runtimeAudit.legacyClientPrefsFallbackReads += 1;
  return readJsonSafe(legacyPath, {});
}
function saveClientPrefs(clientId, prefs, req) {
  const safe = sanitizeClientId(clientId);
  if(!safe) return false;
  const meta = { userAgent: req?.headers?.['user-agent'] || '', name: prefs?.name || prefs?.alias || safe, alias: prefs?.alias || prefs?.name || safe, slug: prefs?.slug || '' };
  if(allhaDb.hasDb && allhaDb.hasDb()){
    // v4.2.0.27: saving prefs must not create/re-enable a web client.
    // A deleted/missing /client/<slug> must stay deleted/missing until explicitly created.
    try{ if(!allhaDb.getWebClient || !allhaDb.getWebClient(safe)) return false; }catch(_){ return false; }
    return !!allhaDb.setWebClientSettings(safe, prefs || {}, meta);
  }
  runtimeAudit.legacyClientPrefsFallbackWrites += 1;
  fs.mkdirSync(CLIENT_PREFS_DIR, { recursive: true });
  atomicWriteJson(path.join(CLIENT_PREFS_DIR, `${safe}.json`), prefs || {});
  return true;
}

/* ── Current client identity / per-client settings foundation ───────── */
function safeClientKey(value){
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
  if(cleaned) return cleaned;
  return crypto.createHash('sha1').update(raw || 'unknown').digest('hex').slice(0, 16);
}
function currentClientIdentity(req){
  const auth = mobileAuthFromHeaders(req);
  if(auth.ok && auth.deviceId){
    return { type:'mobile_device', id:auth.deviceId, mobile:true, device:auth.device || null };
  }
  // v4.2.1: requests on the mobile port that are authenticated through the
  // mobile web-session cookie are mobile clients too. They must never fall back
  // to stale web-client ids/slugs from localStorage/cookies and create/touch web_* rows.
  try{
    if(isMobilePortRequest(req)){
      const cookies = parseCookies(req || {});
      const sid = String(cookies[MOBILE_WEB_COOKIE] || '').trim();
      const did = sid && mobileAuth.getWebSessionDeviceId ? sanitizeClientId(mobileAuth.getWebSessionDeviceId(sid)) : '';
      if(did){ return { type:'mobile_device', id:did, mobile:true, device:mobileAuth.getDevice(did) || null }; }
      return { type:'server_ui', id:'server-ui', mobile:false, device:null };
    }
  }catch(_){}
  // v4.2.0.26: never let a random X-Client-ID create/touch a web client.
  // It is valid only when it belongs to an existing web client, or when a valid
  // /client/<slug> is present in header/cookie. This prevents mobile failed-pairing
  // and restore/copy flows from spawning phantom web_* rows.
  const cid = sanitizeClientId(req?.headers?.['x-client-id'] || '');
  const headerSlug = String(req?.headers?.['x-client-slug'] || '').trim();
  try{
    const cookies = parseCookies(req || {});
    const cookieSlug = String(cookies.allha_web_client_slug || '').trim();
    const urlText = String(req?.originalUrl || req?.url || '');
    const refText = String(req?.headers?.referer || '');
    const pathSlug = ((urlText.match(/\/client\/([a-zA-Z0-9_-]+)/)||[])[1] || '').trim();
    const refSlug = ((refText.match(/\/client\/([a-zA-Z0-9_-]+)/)||[])[1] || '').trim();
    // v4.2.0.28: cookie slug is not authoritative by itself. It may be stale
    // inside Android WebView/mobile flows. Use cookie only for resource requests
    // that clearly belong to a /client/<slug> page (referer), or explicit header/path.
    const explicitSlug = headerSlug || pathSlug || refSlug;
    const slug = explicitSlug || ((refSlug || pathSlug) ? cookieSlug : '');
    if(slug && allhaDb.getWebClientBySlug){
      const client = allhaDb.getWebClientBySlug(slug);
      const id = sanitizeClientId(client?.clientId || client?.client_id || client?.id || '');
      if(id && (!cid || cid === id)) return { type:'web_client', id, mobile:false, device:null };
      if(id && cid && cid !== id) return { type:'web_client', id, mobile:false, device:null };
    }
    if(cid && allhaDb.getWebClient){
      const existing = allhaDb.getWebClient(cid);
      if(existing && existing.client_id) return { type:'web_client', id:cid, mobile:false, device:null };
    }
  }catch(_){
    if(cid && allhaDb.getWebClient){
      try{ const existing = allhaDb.getWebClient(cid); if(existing && existing.client_id) return { type:'web_client', id:cid, mobile:false, device:null }; }catch(__){}
    }
  }
  return { type:'server_ui', id:'server-ui', mobile:false, device:null };
}

function clientSettingsContextKey(profileId, levelId){
  const pid = sanitizeProfileId(profileId || '') || ACTIVE_PROFILE_ID || 'profile-1';
  const lid = sanitizeLevelId(levelId || '') || ACTIVE_LEVEL_ID || 'level-1';
  return `${pid}/${lid}`;
}
function clientSettingsContextFromSettings(settings){
  const src = settings && typeof settings === 'object' ? settings : {};
  const nav = src.navigation && typeof src.navigation === 'object' ? src.navigation : {};
  return {
    profileId: sanitizeProfileId(src.activeProfileId || nav.profileId || ACTIVE_PROFILE_ID || 'profile-1'),
    levelId: sanitizeLevelId(src.activeLevelId || nav.levelId || ACTIVE_LEVEL_ID || 'level-1')
  };
}
function defaultClientDisplayUi(){
  const ui = defaultUiState().ui || {};
  return {
    haloScale: ui.haloScale ?? 0.50,
    hardwareScale: ui.hardwareScale ?? 1.00,
    markerScale: ui.markerScale ?? 1.00,
    sensorScale: ui.sensorScale ?? 1.00,
    roomLabelScale: ui.roomLabelScale ?? 1.00,
    markerOpacity: ui.markerOpacity ?? 0.00,
    sensorOpacity: ui.sensorOpacity ?? 0.00,
    showAllDevicesInRoom: ui.showAllDevicesInRoom ?? false,
    showZones: ui.showZones ?? true,
    invisibleZones: ui.invisibleZones ?? false,
    showMarkers: ui.showMarkers ?? true,
    showSensors: ui.showSensors ?? true,
    hideSidebar: ui.hideSidebar ?? true,
    hideDevicePanel: ui.hideDevicePanel ?? true,
    hideToolbar: ui.hideToolbar ?? false,
    mobileMode: ui.mobileMode ?? true,
    autoHide: ui.autoHide ?? false,
    compact: ui.compact ?? false,
    kioskMode: ui.kioskMode ?? false,
    kioskTileMode: ui.kioskTileMode ?? false,
    kioskNavigationMode: ui.kioskNavigationMode ?? 'switchable',
    kioskWidget: ui.kioskWidget ?? false,
    kioskAutoLock: ui.kioskAutoLock ?? false,
    kioskAutoLockSeconds: ui.kioskAutoLockSeconds ?? 15,
    darkTheme: ui.darkTheme ?? true,
    theme: ui.theme ?? 'dark',
    debugMode: ui.debugMode ?? false
  };
}

function pickObjectKeys(obj, keys){
  const out = {};
  const src = obj && typeof obj === 'object' ? obj : {};
  for(const k of keys || []) if(Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

function cloneClientSettings(settings){
  return settings && typeof settings === 'object' ? JSON.parse(JSON.stringify(settings)) : {};
}
function applyScopedUiForSettings(rawSettings){
  const out = cloneClientSettings(rawSettings);
  const ctx = clientSettingsContextFromSettings(out);
  const key = clientSettingsContextKey(ctx.profileId, ctx.levelId);
  const byCtx = out.uiByContext && typeof out.uiByContext === 'object' ? out.uiByContext : {};
  if(byCtx[key] && typeof byCtx[key] === 'object'){
    out.ui = { ...(out.ui || {}), ...byCtx[key] };
  }
  out.uiPrefsContext = { profileId: ctx.profileId, levelId: ctx.levelId, key };
  return out;
}
function normalizeSettingsWithScopedUi(existingRaw, incomingRaw){
  const existing = cloneClientSettings(existingRaw);
  const incoming = incomingRaw && typeof incomingRaw === 'object' ? cloneClientSettings(incomingRaw) : {};
  const beforeCtx = clientSettingsContextFromSettings(existing);
  const beforeKey = clientSettingsContextKey(beforeCtx.profileId, beforeCtx.levelId);
  const uiByContext = { ...(existing.uiByContext && typeof existing.uiByContext === 'object' ? existing.uiByContext : {}) };
  if(existing.ui && typeof existing.ui === 'object' && beforeKey && !uiByContext[beforeKey]){
    // v4.2.0.11: migrate legacy per-client ui into the context where it was actually used.
    // Do not let these slider/opacity values leak into newly created empty profiles.
    uiByContext[beforeKey] = { ...existing.ui };
  }
  const next = deepMerge(existing, incoming);
  next.uiByContext = { ...uiByContext, ...(next.uiByContext && typeof next.uiByContext === 'object' ? next.uiByContext : {}) };
  const afterCtx = clientSettingsContextFromSettings(next);
  const afterKey = clientSettingsContextKey(afterCtx.profileId, afterCtx.levelId);
  if(incoming.ui && typeof incoming.ui === 'object'){
    next.uiByContext[afterKey] = { ...(next.uiByContext[afterKey] || {}), ...incoming.ui };
    next.ui = { ...next.uiByContext[afterKey] };
  } else if(next.uiByContext[afterKey]){
    next.ui = { ...next.uiByContext[afterKey] };
  } else if(afterKey !== beforeKey){
    // Switching to a profile/level with no saved display prefs must not reuse the previous context.
    next.uiByContext[afterKey] = defaultClientDisplayUi();
    next.ui = { ...next.uiByContext[afterKey] };
  }
  return next;
}
function persistSettingsForIdentity(req, ident, settings){
  const clean = settings && typeof settings === 'object' ? settings : {};
  if(ident.type === 'mobile_device'){
    const device = ident.device || mobileAuth.getDevice(ident.id);
    if(!device) throw Object.assign(new Error('Мобильное устройство не найдено'), { status:401 });
    mobileAuth.updateDevice(ident.id, { settings: clean });
    return { client: ident, settings: applyScopedUiForSettings(clean) };
  }
  if(ident.type === 'web_client'){
    saveClientPrefs(ident.id, clean, req);
    return { client: ident, settings: applyScopedUiForSettings(clean) };
  }
  const serverUiPath = path.join(DATA_DIR, 'client_settings', 'server_ui.json');
  atomicWriteJson(serverUiPath, clean);
  return { client: ident, settings: applyScopedUiForSettings(clean) };
}
function getCurrentClientSettings(req){
  const ident = currentClientIdentity(req);
  let raw = {};
  if(ident.type === 'mobile_device'){
    const device = ident.device || mobileAuth.getDevice(ident.id) || {};
    raw = { ...(device.settings || {}) };
  } else if(ident.type === 'web_client'){
    raw = getClientPrefs(ident.id) || {};
  } else {
    const serverUiPath = path.join(DATA_DIR, 'client_settings', 'server_ui.json');
    raw = readJsonSafe(serverUiPath, {});
  }
  return applyScopedUiForSettings(raw);
}
function saveCurrentClientSettings(req, patch){
  const ident = currentClientIdentity(req);
  const incoming = patch && typeof patch === 'object' ? patch : {};
  let existing = {};
  if(ident.type === 'mobile_device'){
    const device = ident.device || mobileAuth.getDevice(ident.id);
    if(!device) throw Object.assign(new Error('Мобильное устройство не найдено'), { status:401 });
    existing = device.settings || {};
  } else if(ident.type === 'web_client'){
    existing = getClientPrefs(ident.id) || {};
  } else {
    existing = readJsonSafe(path.join(DATA_DIR, 'client_settings', 'server_ui.json'), {});
  }
  const next = normalizeSettingsWithScopedUi(existing, incoming);
  return persistSettingsForIdentity(req, ident, next);
}

function replaceCurrentClientSettings(req, settings){
  const ident = currentClientIdentity(req);
  const clean = settings && typeof settings === 'object' ? settings : {};
  if(ident.type === 'mobile_device'){
    const device = ident.device || mobileAuth.getDevice(ident.id);
    if(!device) throw Object.assign(new Error('Мобильное устройство не найдено'), { status:401 });
    mobileAuth.updateDevice(ident.id, { settings: clean });
    return { client: ident, settings: clean };
  }
  if(ident.type === 'web_client'){
    const existing = getClientPrefs(ident.id) || {};
    const preserved = {};
    for(const k of ['name','alias','slug','description']) if(existing[k] !== undefined) preserved[k] = existing[k];
    const next = { ...preserved, ...clean };
    saveClientPrefs(ident.id, next, req);
    return { client: ident, settings: next };
  }
  const serverUiPath = path.join(DATA_DIR, 'client_settings', 'server_ui.json');
  atomicWriteJson(serverUiPath, clean);
  return { client: ident, settings: clean };
}
function resetCurrentClientContextForNewProfile(req, profileId, levelId){
  const pid = sanitizeProfileId(profileId);
  const lid = sanitizeLevelId(levelId || 'level-1');
  const next = {
    activeProfileId: pid,
    activeLevelId: lid,
    activeRoomId:'overview',
    navigation:{ profileId:pid, levelId:lid, roomId:'overview', selectedRoom:'overview' },
    // v4.2.0.11: defaults are written only for the new profile/level context.
    // Existing profile slider/opacity settings stay in uiByContext[oldProfile/oldLevel].
    ui: defaultClientDisplayUi()
  };
  try{ return saveCurrentClientSettings(req, next); }
  catch(e){ writeDebugLog('profiles', 'new profile client settings reset failed', { requestId:req?.requestId, profileId:pid, levelId:lid, error:e.message }); return null; }
}

function copyDisplayUiForCurrentClientBetweenProfileContexts(req, sourceProfileId, sourceLevelId, targetProfileId, targetLevelId, fallbackUi){
  if(!req) return null;
  const sourceKey = clientSettingsContextKey(sourceProfileId, sourceLevelId || 'level-1');
  const targetKey = clientSettingsContextKey(targetProfileId, targetLevelId || 'level-1');
  const current = getCurrentClientSettings(req) || {};
  const raw = cloneClientSettings(current);
  const uiByContext = { ...(raw.uiByContext && typeof raw.uiByContext === 'object' ? raw.uiByContext : {}) };
  const sourceUi = (uiByContext[sourceKey] && typeof uiByContext[sourceKey] === 'object')
    ? uiByContext[sourceKey]
    : ((raw.uiPrefsContext?.key === sourceKey && raw.ui) ? raw.ui : fallbackUi);
  if(!sourceUi || typeof sourceUi !== 'object') return null;
  uiByContext[targetKey] = { ...(uiByContext[targetKey] || {}), ...pickObjectKeys(sourceUi, [
    'hardwareScale','markerScale','sensorScale','roomLabelScale',
    'markerOpacity','sensorOpacity','haloScale','cardFontSize','fontScale',
    'compact','theme','darkTheme','showAllDevicesInRoom',
    'showZones','invisibleZones','showMarkers','showSensors','showStandardSensors',
    'hideSidebar','hideDevicePanel','hideToolbar',
    'kioskMode','kioskTileMode','kioskNavigationMode','kioskWidget','kioskAutoLock','kioskAutoLockSeconds',
    'mobileMode','autoHide','debugMode'
  ]) };
  raw.uiByContext = uiByContext;
  const ctx = clientSettingsContextFromSettings(raw);
  const activeKey = clientSettingsContextKey(ctx.profileId, ctx.levelId);
  raw.ui = { ...(uiByContext[activeKey] || raw.ui || {}) };
  return persistSettingsForIdentity(req, currentClientIdentity(req), raw);
}

function defaultClientSettingsPath(){
  return path.join(DATA_DIR, 'client_settings', 'default_client_settings.json');
}
function getDefaultClientSettings(){
  return readJsonSafe(defaultClientSettingsPath(), {});
}
function saveDefaultClientSettings(settings){
  const clean = settings && typeof settings === 'object' ? settings : {};
  atomicWriteJson(defaultClientSettingsPath(), clean);
  return clean;
}
function resetCurrentClientSettingsToDefault(req){
  const defaults = getDefaultClientSettings();
  const ident = currentClientIdentity(req);
  if(ident.type === 'mobile_device'){
    const device = ident.device || mobileAuth.getDevice(ident.id);
    if(!device) throw Object.assign(new Error('Мобильное устройство не найдено'), { status:401 });
    mobileAuth.updateDevice(ident.id, { settings: defaults });
    return { client: ident, settings: defaults };
  }
  if(ident.type === 'web_client'){
    saveClientPrefs(ident.id, defaults, req);
    return { client: ident, settings: defaults };
  }
  const serverUiPath = path.join(DATA_DIR, 'client_settings', 'server_ui.json');
  atomicWriteJson(serverUiPath, defaults);
  return { client: ident, settings: defaults };
}
function copyCurrentSettingsToDefault(req){
  const current = getCurrentClientSettings(req) || {};
  const saved = saveDefaultClientSettings(current);
  return { client: currentClientIdentity(req), defaultSettings: saved };
}


function layoutScopeHash(layoutPath){
  return crypto.createHash('sha1').update(String(layoutPath || '')).digest('hex').slice(0, 16);
}
function clientScopedPath(req, kind, baselinePath, ext){
  const ident = currentClientIdentity(req);
  if(ident.type === 'server_ui') return null;
  const client = safeClientKey(ident.id);
  const scope = layoutScopeHash(baselinePath);
  return path.join(DATA_DIR, 'client_settings', ident.type, client, `${scope}.${kind}.${ext || 'json'}`);
}
function loadEffectiveLayoutForRequest(req, baselineLayoutPath){
  const overridePath = clientScopedPath(req, 'layout', baselineLayoutPath, 'json');
  if(overridePath && runtimeDocumentExists(overridePath)){
    const layout = loadLayout(overridePath);
    layout.__clientSettings = {
      effective: 'client_override',
      client: currentClientIdentity(req),
      overridePath,
      baselinePath: baselineLayoutPath
    };
    return layout;
  }
  const layout = loadLayout(baselineLayoutPath);
  if(overridePath){
    layout.__clientSettings = {
      effective: 'baseline',
      client: currentClientIdentity(req),
      overridePath,
      baselinePath: baselineLayoutPath
    };
  }
  return layout;
}
function saveLayoutForRequest(req, body, baselineLayoutPath){
  const overridePath = clientScopedPath(req, 'layout', baselineLayoutPath, 'json');
  if(overridePath){
    const backup = saveLayout(body, overridePath);
    return { layoutPath: overridePath, baselinePath: baselineLayoutPath, isClientOverride:true, client:currentClientIdentity(req), backup };
  }
  const backup = saveLayout(body, baselineLayoutPath);
  return { layoutPath: baselineLayoutPath, baselinePath: baselineLayoutPath, isClientOverride:false, client:currentClientIdentity(req), backup };
}
function loadEffectiveUiStateForRequest(req, baselineUiStatePath){
  const overridePath = clientScopedPath(req, 'ui-state', baselineUiStatePath, 'json');
  if(overridePath && runtimeDocumentExists(overridePath)){
    const ui = loadUiState(overridePath);
    ui.__clientSettings = { effective:'client_override', client:currentClientIdentity(req), overridePath, baselinePath:baselineUiStatePath };
    return ui;
  }
  const ui = loadUiState(baselineUiStatePath);
  if(overridePath) ui.__clientSettings = { effective:'baseline', client:currentClientIdentity(req), overridePath, baselinePath:baselineUiStatePath };
  return ui;
}
function saveUiStateForRequest(req, body, baselineUiStatePath){
  const overridePath = clientScopedPath(req, 'ui-state', baselineUiStatePath, 'json');
  if(overridePath){
    if(!runtimeDocumentExists(overridePath)){
      const baseline = loadUiState(baselineUiStatePath);
      atomicWriteJson(overridePath, baseline);
    }
    const state = saveUiState(body || {}, overridePath);
    return { state, path: overridePath, baselinePath: baselineUiStatePath, isClientOverride:true, client:currentClientIdentity(req) };
  }
  const state = saveUiState(body || {}, baselineUiStatePath);
  return { state, path: baselineUiStatePath, baselinePath: baselineUiStatePath, isClientOverride:false, client:currentClientIdentity(req) };
}


function clientLevelPaths(req) {
  const prefs = getCurrentClientSettings(req) || {};
  const requestedPid = sanitizeProfileId(prefs.activeProfileId || prefs.navigation?.profileId || '');
  const meta = loadProfilesMeta();
  const profileId = (requestedPid && meta.profiles.some(p=>p.id===requestedPid)) ? requestedPid : ACTIVE_PROFILE_ID;
  const levels = loadLevelsMeta(profileId);
  const requestedLevelId = sanitizeLevelId(prefs.activeLevelId || prefs.navigation?.levelId || '');
  const levelId = (requestedLevelId && (levels.levels || []).some(l => l.id === requestedLevelId)) ? requestedLevelId : (levels.activeLevelId || 'level-1');
  return ensureLevelDirs(profileId, levelId);
}

function requestProfileLevelContext(req, levelIdOverride = null){
  const base = clientLevelPaths(req);
  const profileId = base.profileId || ACTIVE_PROFILE_ID;
  const levels = loadLevelsMeta(profileId);
  const requestedLevelId = sanitizeLevelId(levelIdOverride || base.id || ACTIVE_LEVEL_ID);
  const levelId = (requestedLevelId && (levels.levels || []).some(l => l.id === requestedLevelId)) ? requestedLevelId : (levels.activeLevelId || 'level-1');
  return ensureLevelDirs(profileId, levelId);
}
function activateProfileForCurrentServer(profileId){
  const meta = loadProfilesMeta();
  const id = sanitizeProfileId(profileId);
  if(!meta.profiles.some(p=>p.id===id)) throw new Error('Профиль не найден');
  meta.activeProfileId = id;
  for(const p of meta.profiles) if(p.id===id) p.updatedAt = new Date().toISOString();
  saveProfilesMeta(meta);
  updateActiveProfilePaths();
  ensureDataStore();
  return id;
}

function syncProfileLevelForRequest(req, profileId, levelId){
  const pid = sanitizeProfileId(profileId);
  const lid = sanitizeLevelId(levelId || 'level-1');
  const patch = { activeProfileId: pid, activeLevelId: lid, navigation: { profileId: pid, levelId: lid } };
  try{
    if(req){
      // v4.2.0.10: sync the current client immediately in the same request that creates/activates
      // a profile or level. Waiting for a second frontend call left old valid client prefs in place,
      // so per-client endpoints kept reading the previous profile/level.
      saveCurrentClientSettings(req, patch);
    }
  }catch(e){ writeDebugLog('profiles', 'client profile/level sync failed', { requestId:req?.requestId, profileId:pid, levelId:lid, error:e.message }); }
  return activateProfileLevelForCurrentServer(pid, lid);
}
function activateProfileLevelForCurrentServer(profileId, levelId){
  const id = activateProfileForCurrentServer(profileId);
  const lid = sanitizeLevelId(levelId || 'level-1');
  const lm = loadLevelsMeta(id);
  if((lm.levels || []).some(l => l.id === lid)){
    lm.activeLevelId = lid;
    saveLevelsMeta(id, lm);
    updateActiveProfilePaths();
    ensureDataStore();
  }
  return { profileId:id, levelId:ACTIVE_LEVEL_ID };
}
async function withRequestLevel(req, levelIdOverride, fn){
  const lp = requestProfileLevelContext(req, levelIdOverride);
  return await withTemporaryLevel(lp.profileId, lp.id, () => fn(lp));
}

function resolveRequestContext(req, levelIdOverride = null){
  const identity = currentClientIdentity(req);
  const level = requestProfileLevelContext(req, levelIdOverride);
  const settings = getCurrentClientSettings(req) || {};
  return {
    identity,
    profileId: level.profileId,
    levelId: level.id,
    paths: {
      layout: level.layout,
      rooms: level.rooms,
      sourceConfig: level.sourceConfig,
      uiState: level.uiState,
      images: level.images,
      devicesJson: level.devicesJson,
      devicesJs: level.devicesJs
    },
    clientSettings: {
      activeProfileId: settings.activeProfileId || settings.navigation?.profileId || '',
      activeLevelId: settings.activeLevelId || settings.navigation?.levelId || '',
      navigation: settings.navigation || {}
    },
    serverActive: { profileId: ACTIVE_PROFILE_ID, levelId: ACTIVE_LEVEL_ID }
  };
}




function identityLabel(ident){
  if(!ident) return 'Неизвестный клиент';
  if(ident.type === 'default') return 'Настройки по умолчанию';
  if(ident.type === 'server_ui') return 'Серверный UI по умолчанию';
  if(ident.type === 'web_client') return `Web-клиент ${ident.name || ident.alias || ident.id}`;
  if(ident.type === 'mobile_device') return `Mobile ${ident.name || ident.alias || ident.id}`;
  return `${ident.type}:${ident.id}`;
}
function clientScopedPathForIdentity(ident, kind, baselinePath, ext){
  if(!ident || ident.type === 'server_ui' || ident.type === 'default') return null;
  const client = safeClientKey(ident.id);
  const scope = layoutScopeHash(baselinePath);
  return path.join(DATA_DIR, 'client_settings', ident.type, client, `${scope}.${kind}.${ext || 'json'}`);
}
function getSettingsForIdentity(ident){
  if(!ident || ident.type === 'default') return getDefaultClientSettings();
  if(ident.type === 'mobile_device'){
    const d = mobileAuth.getDevice(ident.id);
    return { ...(d?.settings || {}) };
  }
  if(ident.type === 'web_client') return getClientPrefs(ident.id) || {};
  if(ident.type === 'server_ui'){
    return readJsonSafe(path.join(DATA_DIR, 'client_settings', 'server_ui.json'), {});
  }
  return {};
}
function getSettingsForIdentityInContext(req, ident){
  const base = getSettingsForIdentity(ident);
  if(!ident || ident.type === 'default') return base;
  if(ident.type === 'server_ui'){
    // v4.1.21.18.27:
    // Prefer explicit server_ui client settings. Do not use default level ui_state
    // to overwrite another client's display values with defaults.
    const explicit = base && typeof base === 'object' ? base : {};
    if(explicit.ui && Object.keys(explicit.ui || {}).length) return applyScopedUiForSettings(explicit);
    try{
      const lp = clientLevelPaths(req);
      const uiState = loadUiState(lp.uiState) || {};
      const hasRealUi = uiState && uiState.ui && Object.keys(uiState.ui || {}).length;
      // Only use ui_state when it has explicit ui payload; otherwise keep source mostly empty.
      return hasRealUi ? { ui: uiState.ui, navigation: { roomId: uiState.selectedRoom || '' }, viewport: uiState.viewport || {} } : applyScopedUiForSettings(explicit);
    }catch(e){
      return applyScopedUiForSettings(explicit);
    }
  }
  return applyScopedUiForSettings(base || {});
}
function getAvailableClientSettingSources(req){
  const current = currentClientIdentity(req);
  const items = [{ type:'default', id:'default', label:'Настройки по умолчанию' }];
  items.push({
    type:'server_ui',
    id:'server-ui',
    label:'Серверный UI по умолчанию',
    hint:'Базовые серверные настройки, не индивидуальный браузер'
  });

  const mobileIds = new Set((mobileAuth.listDevices() || []).map(d => String(d.device_id || '')));
  if(allhaDb.listWebClients){
    for(const wc of (allhaDb.listWebClients() || [])){
      if(!wc?.client_id) continue;
      // Старые сборки могли ошибочно создать web_client с ID мобильного устройства.
      // Такой дубль не показываем как источник, чтобы не копировать не тот клиент.
      if(mobileIds.has(String(wc.client_id))) continue;
      const labelName = wc.alias || wc.name || wc.client_id;
      const lastSeen = wc.lastSeen ? `, был ${wc.lastSeen}` : '';
      items.push({
        type:'web_client',
        id:wc.client_id,
        label:`Браузер / панель: ${labelName}${wc.slug ? ' · /client/'+wc.slug : ''}${lastSeen}`,
        lastSeen:wc.lastSeen || '',
        current: current.type === 'web_client' && current.id === wc.client_id
      });
    }
  }

  for(const d of (mobileAuth.listDevices() || [])){
    items.push({
      type:'mobile_device',
      id:d.device_id,
      label:`Mobile: ${d.name || d.alias || d.device_id}`,
      accessMode:d.accessMode || 'control',
      lastSeen:d.last_seen || '',
      current: current.type === 'mobile_device' && current.id === d.device_id
    });
  }
  return { current, items };
}
function pickSettingsSections(source, sections){
  const src = source && typeof source === 'object' ? source : {};
  const list = Array.isArray(sections) ? sections : [];
  if(list.includes('all')){
    const { __clientSettings, uiByContext, uiPrefsContext, navigation, activeProfileId, activeLevelId, activeRoomId, ...clean } = src || {};
    // v4.2.0.12: copy effective settings, not the source client's entire profile/level context map.
    if(src.ui && typeof src.ui === 'object') clean.ui = { ...src.ui };
    return clean;
  }
  const out = {};
  const copyKey = (k) => { if(src[k] !== undefined) out[k] = src[k]; };
  if(list.includes('display')){
    if(src.ui){
      out.ui = {
        ...(out.ui || {}),
        ...Object.fromEntries(Object.entries(src.ui).filter(([k]) => [
          'hardwareScale','markerScale','sensorScale','roomLabelScale',
          'markerOpacity','sensorOpacity','haloScale','cardFontSize','fontScale',
          'compact','theme'
        ].includes(k)))
      };
    }
  }
  if(list.includes('visibility')){
    copyKey('visibility');
    if(src.ui){
      out.ui = {
        ...(out.ui || {}),
        ...Object.fromEntries(Object.entries(src.ui).filter(([k]) => [
          'showZones','invisibleZones','showMarkers','showSensors','showStandardSensors',
          'hideSidebar','hideDevicePanel','hideToolbar','showAllDevicesInRoom'
        ].includes(k)))
      };
    }
    copyKey('standardSensorsVisibility');
  }
  if(list.includes('modes')){
    copyKey('kiosk');
    copyKey('mobile');
    copyKey('tiles');
    if(src.ui){
      out.ui = {
        ...(out.ui || {}),
        ...Object.fromEntries(Object.entries(src.ui).filter(([k]) => [
          'kioskMode','kioskTileMode','kioskNavigationMode','kioskAutoLock',
          'kioskAutoLockSeconds','mobileMode','autoHide'
        ].includes(k)))
      };
    }
  }
  // Profiles and levels are global project entities. A client only stores its currently selected
  // activeProfileId/activeLevelId as runtime context, so navigation/profile/level are intentionally
  // not copied by the mass settings-copy flow.
  return out;
}

function adaptCopiedSettingsForTarget(settingsPatch, sourceSettings, targetIdent, sections){
  const patch = settingsPatch && typeof settingsPatch === 'object' ? { ...settingsPatch } : {};
  const srcUi = sourceSettings && typeof sourceSettings.ui === 'object' ? sourceSettings.ui : {};
  const list = Array.isArray(sections) ? sections : [];
  if(targetIdent && targetIdent.type === 'mobile_device'){
    // mobileMode is a device-class property for APK/mobile clients, not a portable preference.
    // Copying desktop web settings to mobile with mobileMode:false makes the map use desktop
    // layout math on a narrow screen and breaks pan/zoom geometry.
    patch.ui = { ...(patch.ui || {}), mobileMode:true, hideSidebar:true, hideDevicePanel:true };
    const copiedViewport = Object.prototype.hasOwnProperty.call(patch, 'viewport') || list.includes('all');
    if(copiedViewport && srcUi.mobileMode !== true){
      // Stored pan/zoom values are calibrated to a specific viewport and become invalid when
      // switching from desktop rendering to mobile rendering. Reset only on desktop -> mobile copy.
      patch.viewport = { overview:{ zoom:1, panX:0, panY:0 }, rooms:{} };
    }
  }
  return patch;
}
function sourceIdentityFromPayload(body){
  const type = String(body?.sourceType || body?.type || '').trim();
  const id = String(body?.sourceId || body?.id || '').trim();
  if(type === 'default') return { type:'default', id:'default' };
  if(type === 'server_ui') return { type:'server_ui', id:'server-ui' };
  if(type === 'mobile_device' && id) return { type:'mobile_device', id };
  if(type === 'web_client' && id) return { type:'web_client', id };
  return null;
}
function layoutHasClientPositions(layout){
  if(!layout || typeof layout !== 'object') return false;
  return !!(
    Object.keys(layout.overviewMarkers || {}).length ||
    Object.keys(layout.roomMarkers || {}).some(roomId => Object.keys(layout.roomMarkers?.[roomId] || {}).length) ||
    Object.keys(layout.overviewMetrics || {}).length ||
    Object.keys(layout.roomMetrics || {}).length
  );
}
function latestWebClientLayoutPathForRequest(req, baselineLayoutPath){
  if(!allhaDb.listWebClients) return null;
  const current = currentClientIdentity(req);
  const mobileIds = new Set((mobileAuth.listDevices() || []).map(d => String(d.device_id || '')));
  for(const wc of (allhaDb.listWebClients() || [])){
    if(!wc?.client_id) continue;
    if(current.type === 'web_client' && current.id === wc.client_id) continue;
    if(mobileIds.has(String(wc.client_id))) continue;
    const candidate = clientScopedPathForIdentity({ type:'web_client', id:wc.client_id }, 'layout', baselineLayoutPath, 'json');
    if(candidate && runtimeDocumentExists(candidate)){
      const layout = loadLayout(candidate);
      if(layoutHasClientPositions(layout)) return candidate;
    }
  }
  return null;
}
function copyPositionForCurrentClient(req, sourceIdent){
  const lp = clientLevelPaths(req);
  const currentIdent = currentClientIdentity(req);
  const currentPath = clientScopedPathForIdentity(currentIdent, 'layout', lp.layout, 'json') || lp.layout;
  let sourcePath = lp.layout;
  let sourceMode = 'project-default';

  if(sourceIdent && sourceIdent.type !== 'default' && sourceIdent.type !== 'server_ui'){
    const maybe = clientScopedPathForIdentity(sourceIdent, 'layout', lp.layout, 'json');
    if(maybe && runtimeDocumentExists(maybe)){
      sourcePath = maybe;
      sourceMode = sourceIdent.type;
    }
  } else if(sourceIdent && sourceIdent.type === 'server_ui') {
    // В текущей архитектуре обычный браузер работает как web_client с собственным
    // расположением датчиков и маркеров. Раньше пункт “Серверный UI / браузер”
    // ошибочно копировал пустой файл уровня. Если явного server_ui расположения нет,
    // берём последний web-клиент с реальными позициями.
    const latestWeb = latestWebClientLayoutPathForRequest(req, lp.layout);
    if(latestWeb){
      sourcePath = latestWeb;
      sourceMode = 'latest-web-client-fallback';
    }
  }

  const sourceLayout = loadLayout(sourcePath);
  const backup = saveLayout(sourceLayout, currentPath);
  return {
    currentPath,
    sourcePath,
    sourceMode,
    copiedPositions: layoutHasClientPositions(sourceLayout),
    backup: backup ? path.basename(backup) : null
  };
}


app.get('/api/client-settings/default', (req,res)=>{
  try{ res.json({ok:true, defaultSettings:getDefaultClientSettings()}); }
  catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/client-settings/current/reset-to-default', express.json(), (req,res)=>{
  try{
    const saved = resetCurrentClientSettingsToDefault(req);
    writeDebugLog('client-settings','reset-to-default',{client:saved.client, defaultKeys:Object.keys(getDefaultClientSettings()||{})});
    res.json({ok:true, ...saved, defaultSettings:getDefaultClientSettings()});
  }catch(e){safeErrorResponse(req,res,e,e.status||500);}
});
app.post('/api/client-settings/current/save-as-default', express.json(), (req,res)=>{
  try{
    // Ensure latest values from current UI are stored before copying if payload provided.
    if(req.body && Object.keys(req.body || {}).length) saveCurrentClientSettings(req, req.body);
    const saved = copyCurrentSettingsToDefault(req);
    res.json({ok:true, ...saved});
  }catch(e){safeErrorResponse(req,res,e,e.status||500);}
});


app.get('/api/client-settings/sources', (req,res)=>{
  try{ res.json({ok:true, ...getAvailableClientSettingSources(req)}); }
  catch(e){ safeErrorResponse(req,res,e); }
});
app.post('/api/client-settings/current/copy-from', express.json(), (req,res)=>{
  try{
    const sourceIdent = sourceIdentityFromPayload(req.body || {});
    if(!sourceIdent) return res.status(400).json({ok:false,error:'Не выбран источник настроек'});
    const sections = Array.isArray(req.body?.sections) ? req.body.sections : ['all'];
    const sourceSettings = getSettingsForIdentityInContext(req, sourceIdent);
    const targetIdent = currentClientIdentity(req);
    let settingsPatch = pickSettingsSections(sourceSettings, sections);
    settingsPatch = adaptCopiedSettingsForTarget(settingsPatch, sourceSettings, targetIdent, sections);
    let saved = null;
    const wantsPosition = sections.includes('all') || sections.includes('position');
    if(Object.keys(settingsPatch || {}).length){
      saved = saveCurrentClientSettings(req, settingsPatch);
    } else {
      saved = { client: currentClientIdentity(req), settings: getCurrentClientSettings(req) };
      if(!wantsPosition){
        return res.status(400).json({ok:false,error:'В выбранном источнике нет настроек выбранного типа. Сначала сохраните настройки на устройстве-источнике.'});
      }
    }
    let position = null;
    if(wantsPosition){
      position = copyPositionForCurrentClient(req, sourceIdent);
    }
    writeDebugLog('client-settings','copy-from',{source:sourceIdent, sections, patchKeys:Object.keys(settingsPatch||{}), savedClient:saved?.client, position});
    res.json({ok:true, source:sourceIdent, sections, saved, position, effectiveUiKeys:Object.keys(settingsPatch?.ui||{})});
  }catch(e){ safeErrorResponse(req,res,e,e.status||500); }
});

app.get('/api/client-settings/current', (req,res)=>{
  try{
    res.json({ok:true, client:currentClientIdentity(req), settings:getCurrentClientSettings(req)});
  }catch(e){safeErrorResponse(req,res,e,e.status||500);}
});
app.post('/api/client-settings/current', express.json(), (req,res)=>{
  try{
    const saved=saveCurrentClientSettings(req, req.body || {});
    res.json({ok:true, ...saved});
  }catch(e){safeErrorResponse(req,res,e,e.status||500);}
});
app.post('/api/client-settings/current/reset-to-baseline', express.json(), (req,res)=>{
  try{
    const ident=currentClientIdentity(req);
    if(ident.type==='mobile_device'){
      mobileAuth.updateDevice(ident.id, { settings:{} });
      return res.json({ok:true, client:ident, settings:{}});
    }
    if(ident.type==='web_client'){
      saveClientPrefs(ident.id, {}, req);
      return res.json({ok:true, client:ident, settings:{}});
    }
    const serverUiPath = path.join(DATA_DIR, 'client_settings', 'server_ui.json');
    atomicWriteJson(serverUiPath, {});
    res.json({ok:true, client:ident, settings:{}});
  }catch(e){safeErrorResponse(req,res,e,e.status||500);}
});

app.get('/api/prefs', (req, res) => {
  const ident = currentClientIdentity(req);
  const auth = mobileAuthFromHeaders(req);
  try {
    const data = getCurrentClientSettings(req) || {};
    if(auth.ok){
      data.panelMode = auth.device?.accessMode || 'control';
      data.mobileDevice = auth.device;
      data.mobileAccessLocked = true;
    }
    data.__clientSettings = { client: ident };
    res.json(data);
  } catch {
    res.json(auth.ok ? { panelMode: auth.device?.accessMode || 'control', mobileDevice: auth.device, mobileAccessLocked:true, __clientSettings:{client:ident} } : {__clientSettings:{client:ident}});
  }
});

app.put('/api/prefs', express.json(), (req, res) => {
  try {
    const body = req.body || {};
    const auth = mobileAuthFromHeaders(req);
    const patch = {};
    if (body.ui && typeof body.ui === 'object') patch.ui = body.ui;
    if (body.navigation && typeof body.navigation === 'object') patch.navigation = body.navigation;
    if (body.visibility && typeof body.visibility === 'object') patch.visibility = body.visibility;
    if (body.tiles && typeof body.tiles === 'object') patch.tiles = body.tiles;
    if (body.kiosk && typeof body.kiosk === 'object') patch.kiosk = body.kiosk;
    if (body.mobile && typeof body.mobile === 'object') patch.mobile = body.mobile;
    if (!auth.ok && body.panelMode !== undefined) patch.panelMode = String(body.panelMode);
    if (body.activeProfileId !== undefined) patch.activeProfileId = body.activeProfileId;
    if (body.activeLevelId !== undefined) patch.activeLevelId = body.activeLevelId;
    if (body.activeRoomId !== undefined) patch.activeRoomId = body.activeRoomId;
    const saved = saveCurrentClientSettings(req, patch);
    res.json({ ok: true, mobileAccessLocked: !!auth.ok, clientSettings: saved, database: allhaDb.getInfo() });
  } catch (e) { safeErrorResponse(req,res,e,e.status||500); }
});

const server = app.listen(PORT, () => {
  console.log(`[ALLHA-2D] Browser/LAN access on http://0.0.0.0:${PORT}`);
  try{ setSseBatchMs(loadAddonConfig().sseBatchMs); }catch(e){}
  startHaWsSubscription();
});
server.on('error', err => {
  if(err && err.code === 'EADDRINUSE'){
    console.error(`Port ${PORT} is already in use. Set another PORT, e.g. PORT=8105`);
    process.exit(1);
  }
  throw err;
});

const mobileServer = app.listen(MOBILE_PORT, () => {
  console.log(`[ALLHA-2D] Mobile-only access on http://0.0.0.0:${MOBILE_PORT}`);
});
mobileServer.on('error', err => {
  if(err && err.code === 'EADDRINUSE') console.error(`Mobile port ${MOBILE_PORT} already in use`);
  else throw err;
});

let _shuttingDown=false;
function shutdown(signal){
  if(_shuttingDown) return;
  _shuttingDown=true;
  console.log(`[ALLHA-2D] ${signal} received, shutting down gracefully...`);
  try{ stopHaWsSubscription(); }catch(e){}
  try{ for(const res of sseClients){ try{ res.end(); }catch(e){} } sseClients.clear(); }catch(e){}
  try{ flushDebugLog(); }catch(e){}
  try{ flushCommandLog(); }catch(e){}
  let pending=2;
  const finish=()=>{
    try{ allhaDb.closeDb?.(); }catch(e){ console.error('[ALLHA-2D] closeDb failed:', e.message); }
    process.exit(0);
  };
  const waitForInFlight=()=>{
    const started=Date.now();
    const check=()=>{
      if(_inFlightRequests<=0 || Date.now()-started>4000) return finish();
      setTimeout(check, 100);
    };
    check();
  };
  const done=()=>{ if(--pending<=0) waitForInFlight(); };
  const timer=setTimeout(finish, 6000); timer.unref?.();
  try{ server.close(done); }catch(e){ done(); }
  try{ mobileServer.close(done); }catch(e){ done(); }
}
process.on('SIGTERM', ()=>shutdown('SIGTERM'));
process.on('SIGINT', ()=>shutdown('SIGINT'));
