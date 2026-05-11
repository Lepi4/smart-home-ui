'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DEVICES_FILE = path.join(DATA_DIR, 'mobile-devices.json');

let _devices = null; // legacy fallback only
let _pendingCode = null;
let _lastSeenMemory = new Map();

function _hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function _loadDevices() {
  try { _devices = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); }
  catch { _devices = {}; }
}
function _saveDevices() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const clean = Object.fromEntries(Object.entries(_devices || {}).map(([id, d]) => {
      const { _lastSeenMs, ...rest } = d; return [id, rest];
    }));
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(clean, null, 2), 'utf8');
  } catch (e) { console.error('[mobile-auth] legacy save failed:', e.message); }
}
function _devs() { if (!_devices) _loadDevices(); return _devices; }

try { db.initSchema(); } catch (e) { console.warn('[mobile-auth] db init failed:', e.message); }

function generatePairingCode() {
  const n = crypto.randomInt(0, Math.pow(36, 6));
  const code = n.toString(36).toUpperCase().padStart(6, '0');
  _pendingCode = { code, expires: Date.now() + 5 * 60_000, used: false };
  setTimeout(() => { if (_pendingCode?.code === code) _pendingCode = null; }, 5 * 60_000).unref?.();
  return { code, expires_in: 300 };
}
function getPendingCode() {
  if (!_pendingCode || _pendingCode.used) return null;
  if (Date.now() > _pendingCode.expires) { _pendingCode = null; return null; }
  return { code: _pendingCode.code, expires_in: Math.floor((_pendingCode.expires - Date.now()) / 1000) };
}
function cancelPendingCode() { _pendingCode = null; }

function _cleanText(value, max = 120) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function _normalizeDeviceSettings(raw = {}) { return db.normalizeMobileSettings(raw); }
function _normalizeDeviceAccess(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const accessMode = ['viewer','control','admin'].includes(String(source.accessMode || '')) ? String(source.accessMode) : 'viewer';
  const profileAccess = db.normalizeProfileAccess(source.profileAccess || {});
  return { accessMode, profileAccess };
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
  const count = db.hasDb() ? ((db.listMobileDevices() || []).length) : Object.keys(_devs()).length;
  return `Устройство ${count + 1}`;
}

function consumeCode(code, device_id, meta = {}) {
  if (!code || !device_id) throw Object.assign(new Error('Не указан код или device_id'), { status: 400 });
  if (!_pendingCode) throw Object.assign(new Error('Нет активного кода. Создайте новый в настройках аддона.'), { status: 410 });
  if (_pendingCode.used || Date.now() > _pendingCode.expires) { _pendingCode = null; throw Object.assign(new Error('Код истёк или уже использован'), { status: 410 }); }
  if (_pendingCode.code !== String(code).toUpperCase().trim()) throw Object.assign(new Error('Неверный код'), { status: 401 });
  _pendingCode.used = true; _pendingCode = null;

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = _hashToken(token);
  const now = new Date().toISOString();
  const existing = db.hasDb() ? (db.getMobileDevice(device_id) || {}) : (_devs()[device_id] || {});
  const device = {
    device_id,
    tokenHash,
    name: existing.name || _deviceDefaultName(device_id, meta),
    alias: existing.alias || _cleanText(meta.alias || meta.deviceAlias, 48),
    description: existing.description || _cleanText(meta.description, 160),
    platform: _cleanText(meta.platform, 32),
    model: _cleanText(meta.model || meta.deviceModel, 64),
    manufacturer: _cleanText(meta.manufacturer, 64),
    osVersion: _cleanText(meta.osVersion || meta.os_version, 32),
    appVersion: _cleanText(meta.appVersion || meta.app_version, 32),
    userAgent: _cleanText(meta.userAgent, 240),
    screen: _cleanText(meta.screen, 32),
    paired_at: existing.paired_at || now,
    last_seen: now,
    accessMode: existing.accessMode || 'viewer',
    profileAccess: existing.profileAccess || { mode: 'all', profileIds: [] },
    settings: _normalizeDeviceSettings(existing.settings || {})
  };
  if (db.hasDb()) {
    db.upsertMobileDevice(device);
  } else {
    const devs = _devs();
    devs[device_id] = { ...device, token };
    _saveDevices();
  }
  return token;
}

function validateToken(token, device_id) {
  if (!token || !device_id) return false;
  const tokenHash = _hashToken(token);
  if (db.hasDb()) {
    const stored = db.getMobileDeviceSecret(device_id);
    if (!stored || stored !== tokenHash) return false;
    const now = Date.now();
    const last = _lastSeenMemory.get(device_id) || 0;
    if (now - last > 60_000) { _lastSeenMemory.set(device_id, now); db.updateMobileLastSeen(device_id); }
    return true;
  }
  const d = _devs()[device_id];
  if (!d) return false;
  const ok = d.tokenHash ? d.tokenHash === tokenHash : d.token === token;
  if (!ok) return false;
  const now = Date.now();
  if (!d._lastSeenMs || now - d._lastSeenMs > 60_000) { d.last_seen = new Date().toISOString(); d._lastSeenMs = now; _saveDevices(); }
  return true;
}

function createWebSession(device_id, token, ttlMs = 24 * 60 * 60_000) {
  if (!validateToken(token, device_id)) return null;
  if (db.hasDb()) return db.createWebSession(device_id, ttlMs);
  return `${Buffer.from(String(device_id)).toString('base64url')}.${Date.now() + ttlMs}.${crypto.randomBytes(16).toString('base64url')}`;
}
function validateWebSession(session) {
  if (db.hasDb()) return db.validateWebSession(session);
  return false;
}

function listDevices() {
  if (db.hasDb()) return db.listMobileDevices() || [];
  return Object.entries(_devs()).map(([device_id, d]) => ({
    device_id,
    name: d.name || device_id,
    alias: d.alias || '',
    description: d.description || '',
    platform: d.platform || '',
    model: d.model || '',
    manufacturer: d.manufacturer || '',
    osVersion: d.osVersion || '',
    appVersion: d.appVersion || '',
    screen: d.screen || '',
    userAgent: d.userAgent || '',
    paired_at: d.paired_at,
    last_seen: d.last_seen,
    accessMode: d.accessMode || 'viewer',
    profileAccess: d.profileAccess || { mode: 'all', profileIds: [] },
    settings: _normalizeDeviceSettings(d.settings || {})
  }));
}
function getDevice(device_id) {
  if (db.hasDb()) return db.getMobileDevice(device_id);
  const d = _devs()[device_id];
  if (!d) return null;
  return listDevices().find(x => x.device_id === device_id) || null;
}
function renameDevice(device_id, name) {
  if (db.hasDb()) {
    const d = db.updateMobileDevice(device_id, { name: _cleanText(name, 64) });
    if (!d) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
    return;
  }
  const d = _devs()[device_id];
  if (!d) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
  d.name = String(name || '').trim().slice(0, 64) || d.name; _saveDevices();
}
function updateDevice(device_id, patch = {}) {
  if (db.hasDb()) {
    const d = db.updateMobileDevice(device_id, patch);
    if (!d) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
    return d;
  }
  const d = _devs()[device_id];
  if (!d) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
  if (patch.name !== undefined) d.name = _cleanText(patch.name, 64) || d.name;
  if (patch.alias !== undefined) d.alias = _cleanText(patch.alias, 48);
  if (patch.description !== undefined) d.description = _cleanText(patch.description, 160);
  if (patch.accessMode !== undefined || patch.profileAccess !== undefined) {
    const access = _normalizeDeviceAccess({ accessMode: patch.accessMode || d.accessMode, profileAccess: patch.profileAccess || d.profileAccess });
    d.accessMode = access.accessMode; d.profileAccess = access.profileAccess;
  }
  if (patch.settings !== undefined) d.settings = _normalizeDeviceSettings({ ...(d.settings || {}), ...(patch.settings || {}) });
  _saveDevices();
  return listDevices().find(x => x.device_id === device_id) || null;
}
function revokeDevice(device_id) {
  if (db.hasDb()) { if (!db.deleteMobileDevice(device_id)) throw Object.assign(new Error('Устройство не найдено'), { status: 404 }); return; }
  if (!_devs()[device_id]) throw Object.assign(new Error('Устройство не найдено'), { status: 404 });
  delete _devices[device_id]; _saveDevices();
}
function revokeAllDevices() {
  if (db.hasDb()) { db.deleteAllMobileDevices(); return; }
  _devices = {}; _saveDevices();
}

module.exports = {
  generatePairingCode, getPendingCode, cancelPendingCode,
  consumeCode, validateToken, getDevice,
  createWebSession, validateWebSession,
  listDevices, renameDevice, updateDevice, revokeDevice, revokeAllDevices,
  getDbInfo: db.getInfo
};
