'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DEVICES_FILE = path.join(DATA_DIR, 'mobile-devices.json');

/* ── In-memory state ─────────────────────────────────── */
let _devices = null; // device_id → { token, name, paired_at, last_seen, _lastSeenMs }
let _pendingCode = null; // { code, expires, used }

function _loadDevices() {
  try { _devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); }
  catch { _devices = {}; }
}

function _saveDevices() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Strip runtime-only field before writing
    const clean = Object.fromEntries(
      Object.entries(_devices).map(([id, d]) => {
        const { _lastSeenMs, ...rest } = d;
        return [id, rest];
      })
    );
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) { console.error('[mobile-auth] save failed:', e.message); }
}

function _devs() {
  if (!_devices) _loadDevices();
  return _devices;
}

/* ── Pairing code ────────────────────────────────────── */

function generatePairingCode() {
  // 6 символов BASE36 = 2.17 млрд комбинаций, TTL 5 минут, одноразовый
  const n = crypto.randomInt(0, Math.pow(36, 6));
  const code = n.toString(36).toUpperCase().padStart(6, '0');
  _pendingCode = { code, expires: Date.now() + 5 * 60_000, used: false };
  setTimeout(() => { if (_pendingCode?.code === code) _pendingCode = null; }, 5 * 60_000);
  return { code, expires_in: 300 };
}

function getPendingCode() {
  if (!_pendingCode || _pendingCode.used) return null;
  if (Date.now() > _pendingCode.expires) { _pendingCode = null; return null; }
  return { code: _pendingCode.code, expires_in: Math.floor((_pendingCode.expires - Date.now()) / 1000) };
}

function cancelPendingCode() {
  _pendingCode = null;
}

/* ── Pairing ─────────────────────────────────────────── */

function _cleanText(value, max = 120) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function _deviceDefaultName(device_id, meta = {}) {
  const explicit = _cleanText(meta.deviceName || meta.name, 64);
  if (explicit) return explicit;
  const model = _cleanText(meta.model || meta.deviceModel, 64);
  if (model) return model;
  const ua = _cleanText(meta.userAgent, 180);
  const androidModel = ua.match(/Android\s+[0-9.]+;\s*([^;)]+?)\s+Build/i)?.[1]
    || ua.match(/Android\s+[0-9.]+;\s*([^;)]+)/i)?.[1];
  if (androidModel && !/wv|mobile|linux/i.test(androidModel)) return androidModel.slice(0, 64);
  const platform = _cleanText(meta.platform, 32);
  if (/android/i.test(platform || ua)) return `Android ${String(device_id).slice(0, 6)}`;
  if (/iphone|ipad|ios/i.test(platform || ua)) return `iOS ${String(device_id).slice(0, 6)}`;
  return `Устройство ${Object.keys(_devs()).length + 1}`;
}

function consumeCode(code, device_id, meta = {}) {
  if (!code || !device_id) {
    throw Object.assign(new Error('Не указан код или device_id'), { status: 400 });
  }
  if (!_pendingCode) {
    throw Object.assign(new Error('Нет активного кода. Создайте новый в настройках аддона.'), { status: 410 });
  }
  if (_pendingCode.used || Date.now() > _pendingCode.expires) {
    _pendingCode = null;
    throw Object.assign(new Error('Код истёк или уже использован'), { status: 410 });
  }
  if (_pendingCode.code !== String(code).toUpperCase().trim()) {
    throw Object.assign(new Error('Неверный код'), { status: 401 });
  }

  _pendingCode.used = true;
  _pendingCode = null;

  const token = crypto.randomBytes(32).toString('hex');
  const devs = _devs();
  const existing = devs[device_id] || {};
  const now = new Date().toISOString();
  devs[device_id] = {
    ...existing,
    token,
    name: existing.name || _deviceDefaultName(device_id, meta),
    platform: _cleanText(meta.platform, 32),
    model: _cleanText(meta.model || meta.deviceModel, 64),
    manufacturer: _cleanText(meta.manufacturer, 64),
    osVersion: _cleanText(meta.osVersion || meta.os_version, 32),
    appVersion: _cleanText(meta.appVersion || meta.app_version, 32),
    userAgent: _cleanText(meta.userAgent, 240),
    screen: _cleanText(meta.screen, 32),
    paired_at: existing.paired_at || now,
    last_seen: now
  };
  _saveDevices();
  return token;
}

/* ── Token validation ────────────────────────────────── */

function validateToken(token, device_id) {
  if (!token || !device_id) return false;
  const d = _devs()[device_id];
  if (!d || d.token !== token) return false;
  // throttled last_seen (max 1 write per 60 s per device)
  const now = Date.now();
  if (!d._lastSeenMs || now - d._lastSeenMs > 60_000) {
    d.last_seen = new Date().toISOString();
    d._lastSeenMs = now;
    _saveDevices();
  }
  return true;
}


/* ── Short mobile web session ───────────────────────────
   Used only to let the Capacitor WebView load /index.html after pairing.
   API requests still use Authorization: Bearer + X-Device-ID. */
function _b64url(input) {
  return Buffer.from(String(input), 'utf8').toString('base64url');
}
function _unb64url(input) {
  return Buffer.from(String(input), 'base64url').toString('utf8');
}
function _sessionSig(device_id, exp, token) {
  return crypto.createHmac('sha256', String(token || ''))
    .update(`${device_id}.${exp}.allha-mobile-session-v1`)
    .digest('base64url');
}
function createWebSession(device_id, token, ttlMs = 24 * 60 * 60_000) {
  if (!validateToken(token, device_id)) return null;
  const exp = Date.now() + ttlMs;
  const sig = _sessionSig(device_id, exp, token);
  return `${_b64url(device_id)}.${exp}.${sig}`;
}
function validateWebSession(session) {
  try {
    const parts = String(session || '').split('.');
    if (parts.length !== 3) return false;
    const device_id = _unb64url(parts[0]);
    const exp = Number(parts[1]);
    const sig = parts[2];
    if (!device_id || !Number.isFinite(exp) || Date.now() > exp) return false;
    const d = _devs()[device_id];
    if (!d || !d.token) return false;
    const expected = _sessionSig(device_id, exp, d.token);
    const a = Buffer.from(String(sig));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return true;
  } catch { return false; }
}

/* ── Device management ───────────────────────────────── */

function listDevices() {
  return Object.entries(_devs()).map(([device_id, d]) => ({
    device_id,
    name: d.name || device_id,
    platform: d.platform || '',
    model: d.model || '',
    manufacturer: d.manufacturer || '',
    osVersion: d.osVersion || '',
    appVersion: d.appVersion || '',
    screen: d.screen || '',
    userAgent: d.userAgent || '',
    paired_at: d.paired_at,
    last_seen: d.last_seen
  }));
}

function renameDevice(device_id, name) {
  const d = _devs()[device_id];
  if (!d) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
  d.name = String(name || '').trim().slice(0, 64) || d.name;
  _saveDevices();
}

function revokeDevice(device_id) {
  if (!_devs()[device_id]) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
  delete _devices[device_id];
  _saveDevices();
}

function revokeAllDevices() {
  _devices = {};
  _saveDevices();
}

module.exports = {
  generatePairingCode, getPendingCode, cancelPendingCode,
  consumeCode, validateToken,
  createWebSession, validateWebSession,
  listDevices, renameDevice, revokeDevice, revokeAllDevices
};
