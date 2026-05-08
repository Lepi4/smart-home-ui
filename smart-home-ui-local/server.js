const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
let sharp = null;
try { sharp = require('sharp'); } catch (e) { sharp = null; }

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const FALLBACK_DATA_DIR = path.join(__dirname, 'data');
const ADDON_CONFIG_PATH = path.join(DATA_DIR, 'addon_config.json');
const HA_API_BASE = (process.env.HA_API_BASE || 'http://supervisor/core/api').replace(/\/$/, '');
const HA_WS_URL = process.env.HA_WS_URL || HA_API_BASE.replace(/^http/i, 'ws').replace(/\/api$/, '/websocket');
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const LAYOUT_BACKUP_DIR = path.join(DATA_DIR, 'backups');
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
const ADDON_VERSION = process.env.BUILD_VERSION || require('./package.json').version || '3.5.8.1';
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
function readJsonSafe(file, fallback){ try{return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):fallback;}catch(e){return fallback;} }


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
      created_at: raw.created_at || null
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
    if(profiles.length >= 5) break;
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
  let meta = fs.existsSync(levelsMetaPath(profileId)) ? loadLevelsMeta(profileId) : defaultLevelsMeta();
  if(!fs.existsSync(levelsMetaPath(profileId))) atomicWriteJson(levelsMetaPath(profileId), meta);
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
function copyIfExists(src, dst){
  try{ if(fs.existsSync(src) && !fs.existsSync(dst)) copyPathRecursive(src, dst); }catch(e){ console.warn('[ALLHA-2D] profile migration copy failed:', src, e.message); }
}
function initializeProfilesStorage(){
  fs.mkdirSync(DATA_DIR, {recursive:true});
  fs.mkdirSync(PROFILES_DIR, {recursive:true});
  let meta = fs.existsSync(PROFILES_META_PATH) ? loadProfilesMeta() : defaultProfilesMeta();
  if(!fs.existsSync(PROFILES_META_PATH)) atomicWriteJson(PROFILES_META_PATH, meta);
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
    max: 5,
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
        sourceConfig: { ...sc, dashboardPaths, dashboardPathText: dashboardPaths.join('\n') }
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
  if(!fs.existsSync(lp.rooms)) atomicWriteJson(lp.rooms, defaultRoomsSettings());
  if(!fs.existsSync(lp.sourceConfig)) atomicWriteJson(lp.sourceConfig, defaultSourceConfig());
  if(!fs.existsSync(lp.uiState)) atomicWriteJson(lp.uiState, defaultUiState());
  if(!fs.existsSync(lp.devicesJs)) writeJsAssignedArray(lp.devicesJs, 'ALL_DEVICES', []);
  if(!fs.existsSync(lp.lovelaceJs)) fs.writeFileSync(lp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'utf8');
  const now = new Date().toISOString();
  meta.levels.push({id, name, createdAt:now, updatedAt:now});
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
  saveLevelsMeta(pid, meta);
  return levelsDiagnostics(pid);
}
function backupLevelDirectory(profileId, levelId, reason='level-backup'){
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
  updateActiveProfilePaths();
  ensureDataStore();
  const diag = levelsDiagnostics(pid);
  diag.backup = backup ? path.basename(backup) : null;
  return diag;
}

function createProfile(payload={}){
  const meta = loadProfilesMeta();
  if(meta.profiles.length >= 5) throw new Error('Можно создать максимум 5 профилей');
  let n = 1; let id;
  do { id = 'profile-' + (++n); } while(meta.profiles.some(p=>p.id===id) && n < 20);
  const now = new Date().toISOString();
  const name = String(payload.name || `Профиль ${meta.profiles.length + 1}`).trim().slice(0,60) || `Профиль ${meta.profiles.length + 1}`;
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
  if(!fs.existsSync(pp.rooms)) atomicWriteJson(pp.rooms, defaultRoomsSettings());
  if(!fs.existsSync(pp.sourceConfig)) atomicWriteJson(pp.sourceConfig, defaultSourceConfig());
  atomicWriteJson(pp.uiState, defaultUiState());
  atomicWriteJson(pp.imagesMeta, defaultImagesMeta());
  if(!fs.existsSync(pp.devicesJs)) writeJsAssignedArray(pp.devicesJs, 'ALL_DEVICES', []);
  if(!fs.existsSync(pp.lovelaceJs)) fs.writeFileSync(pp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'utf8');
  meta.profiles.push({id, name, createdAt:now, updatedAt:now});
  saveProfilesMeta(meta);
  return profilesDiagnostics();
}
function duplicateProfile(id, payload={}){
  const meta = loadProfilesMeta();
  if(meta.profiles.length >= 5) throw new Error('Можно создать максимум 5 профилей');
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

function backupProfileDirectory(profileId, reason='profile-backup'){
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
  if(!fs.existsSync(IMAGES_META_PATH)) atomicWriteJson(IMAGES_META_PATH, defaultImagesMeta());
  if(!fs.existsSync(DEVICES_PATH)) writeJsAssignedArray(DEVICES_PATH, 'ALL_DEVICES', []);
  if(!fs.existsSync(LOVELACE_PATH)) fs.writeFileSync(LOVELACE_PATH, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'utf8');
  if(!fs.existsSync(ATTENTION_RULES_PATH)) saveAttentionRules(attentionDefault());
  if(!fs.existsSync(SECURITY_RULES_PATH)) saveSecurityRules(securityRulesDefault());
  if(!fs.existsSync(ROOMS_SETTINGS_PATH)) saveRoomsSettings(defaultRoomsSettings());
}

function atomicWriteJson(file, payload){
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
function loadUiState(){
  const loaded = readJsonSafe(UI_STATE_PATH, {});
  const def = defaultUiState();
  const legacyUi = (loaded && loaded.ui && typeof loaded.ui === 'object') ? loaded.ui : {};
  const cleanUi = { ...def.ui };
  for(const key of Object.keys(def.ui)){
    if(Object.prototype.hasOwnProperty.call(legacyUi, key)) cleanUi[key] = legacyUi[key];
  }
  // Older resets could revive the legacy left sidebar. New/current defaults keep it hidden
  // unless the user explicitly opens it after the reset.
  if(Number(loaded?.version || 0) < 2 && !Object.prototype.hasOwnProperty.call(legacyUi, 'hideSidebar')) cleanUi.hideSidebar = true;
  return {
    ...def,
    ...loaded,
    version: Math.max(Number(loaded?.version)||0, def.version),
    ui: cleanUi,
    viewport: { ...def.viewport, ...(loaded.viewport||{}), overview:{...def.viewport.overview, ...(loaded.viewport?.overview||{})}, rooms: loaded.viewport?.rooms || {} }
  };
}
function saveUiState(payload){
  const current = loadUiState();
  const next = {
    ...current,
    ...(payload||{}),
    ui: { ...current.ui, ...(payload?.ui||{}) },
    viewport: { ...current.viewport, ...(payload?.viewport||{}), overview:{...current.viewport.overview, ...(payload?.viewport?.overview||{})}, rooms: payload?.viewport?.rooms || current.viewport.rooms || {} },
    updatedAt: new Date().toISOString()
  };
  atomicWriteJson(UI_STATE_PATH, next);
  return next;
}
function parseJsAssignedArray(file, name){
  try{
    if(!fs.existsSync(file)) return [];
    const txt=fs.readFileSync(file,'utf8');
    const re=new RegExp('window\\.'+name+'\\s*=\\s*([\\s\\S]*?);\\s*(?:\\n|$)');
    const m=txt.match(re); if(!m) return [];
    return JSON.parse(m[1]);
  }catch(e){ return []; }
}
function loadAllDevicesForDiagnostics(){
  const file=fs.existsSync(DEVICES_PATH)?DEVICES_PATH:FALLBACK_DEVICES_PATH;
  return parseJsAssignedArray(file,'ALL_DEVICES');
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
  if(fs.existsSync(LAYOUT_PATH)) backupLayout();
  fs.copyFileSync(src, LAYOUT_PATH);
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
function walkBackupItems(){
  if(!fs.existsSync(LAYOUT_BACKUP_DIR)) return [];
  const items = [];
  function walk(dir, rel=''){
    for(const name of fs.readdirSync(dir)){
      const full = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      const st = fs.statSync(full);
      if(st.isDirectory()){
        const hasNested = fs.readdirSync(full).some(x=>fs.statSync(path.join(full,x)).isDirectory());
        const hasFiles = fs.readdirSync(full).some(x=>fs.statSync(path.join(full,x)).isFile());
        if(hasFiles || !hasNested){
          items.push({ name:r, type:'directory', size:dirSizeBytes(full), mtime:st.mtime.toISOString() });
        } else walk(full, r);
      } else {
        items.push({ name:r, type:'file', size:st.size, mtime:st.mtime.toISOString() });
      }
    }
  }
  walk(LAYOUT_BACKUP_DIR);
  return items.sort((a,b)=>new Date(b.mtime)-new Date(a.mtime));
}
function backupSummary(){
  const items = walkBackupItems();
  const totalSize = items.reduce((a,b)=>a+(Number(b.size)||0),0);
  return {
    count: items.length,
    totalSize,
    oldest: items.length ? items.reduce((a,b)=>new Date(a.mtime)<new Date(b.mtime)?a:b).mtime : null,
    newest: items.length ? items[0].mtime : null,
    items
  };
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
    try{ if(fs.existsSync(src) && copyPathRecursive(src, path.join(dst, path.basename(src)))) copied.push(path.basename(src)); }catch(e){}
  }
  return { name:path.basename(dst), type:'directory', copied, path:dst };
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
  if(!fs.existsSync(LAYOUT_PATH)) return null;
  fs.mkdirSync(LAYOUT_BACKUP_DIR,{recursive:true});
  const safePrefix = String(prefix||'layout').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const backupPath = path.join(LAYOUT_BACKUP_DIR, `${safePrefix}-${timestampForFile()}.json`);
  fs.copyFileSync(LAYOUT_PATH, backupPath);
  return backupPath;
}
function writeLayoutWithoutBackup(layout){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const normalized = normalizeLayoutPayload(layout || {version:8}, {strict:false});
  const tmpPath = LAYOUT_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(normalized.layout, null, 2), 'utf8');
  fs.renameSync(tmpPath, LAYOUT_PATH);
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
  }
  return true;
}
function removePathSafe(target){
  if(!target || !target.startsWith(DATA_DIR)) return;
  try{ if(fs.existsSync(target)) fs.rmSync(target, {recursive:true, force:true}); }catch(e){ console.warn('[ALLHA-2D] factory reset remove failed:', target, e.message); }
}
function writeJsAssignedArray(file, name, arr){
  fs.mkdirSync(path.dirname(file), {recursive:true});
  fs.writeFileSync(file, `window.${name} = ${JSON.stringify(arr||[], null, 2)};\n`, 'utf8');
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
  fs.writeFileSync(lp.lovelaceJs, 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'utf8');
  atomicWriteJson(lp.lovelaceRaw, { version:1, views:[] });
}
function factoryResetProject(confirmWord){
  if(String(confirmWord||'') !== 'RESET') throw new Error('Для полного сброса требуется подтверждение RESET');
  ensureDataStore();
  const stamp = timestampForFile();
  const backupDir = path.join(LAYOUT_BACKUP_DIR, `factory-reset-${stamp}`);
  fs.mkdirSync(backupDir, {recursive:true});
  const candidates = [
    ADDON_CONFIG_PATH, PROFILES_META_PATH, PROFILES_DIR,
    SOURCE_CONFIG_PATH, UI_STATE_PATH, LAYOUT_PATH, ROOMS_SETTINGS_PATH, DEVICES_PATH, activeLevelPaths().devicesJson, LOVELACE_PATH, activeLevelPaths().lovelaceRaw,
    path.join(DATA_DIR,'layout.json'), path.join(DATA_DIR,'rooms.json'), path.join(DATA_DIR,'source_config.json'), path.join(DATA_DIR,'ui_state.json'),
    path.join(DATA_DIR,'devices.js'), path.join(DATA_DIR,'devices.json'), path.join(DATA_DIR,'lovelace-source.js'), path.join(DATA_DIR,'lovelace_raw.json'), path.join(DATA_DIR,'images'),
    ATTENTION_RULES_PATH, SECURITY_RULES_PATH, COMMAND_LOG_PATH
  ];
  const backedUp = [];
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
  fs.writeFileSync(path.join(DATA_DIR,'lovelace-source.js'), 'window.LOVELACE_SOURCE = '+JSON.stringify({version:1, views:[]}, null, 2)+';\n', 'utf8');
  atomicWriteJson(path.join(DATA_DIR,'lovelace_raw.json'), { version:1, views:[] });

  ensureDataStore();
  return { ok:true, reset:true, backup:path.basename(backupDir), backedUp, config: publicConfig(loadAddonConfig()), layout: loadLayout(), uiState: loadUiState(), profiles: profilesDiagnostics(), levels: levelsDiagnostics() };
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
function safeRoomImageFileBase(roomId){ return String(roomId||'default').replace(/[^a-zA-Z0-9_-]/g,'_'); }
function customRoomImagePath(roomId){ return path.join(DATA_IMAGES_ROOMS_DIR, `${safeRoomImageFileBase(roomId)}.webp`); }
function activeCustomRoomImagePath(roomId){
  const meta = loadImagesMeta();
  const src = meta.rooms?.[String(roomId||'')]?.file;
  if(src && path.resolve(src).startsWith(path.resolve(DATA_IMAGES_ROOMS_DIR)) && fs.existsSync(src)) return src;
  const base = path.join(DATA_IMAGES_ROOMS_DIR, safeRoomImageFileBase(roomId));
  for(const ext of ['webp','png','jpg','jpeg']){
    const f = `${base}.${ext}`;
    if(fs.existsSync(f)) return f;
  }
  return customRoomImagePath(roomId);
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
function assertKnownRoomId(roomId){
  const id = String(roomId||'').trim();
  if(!id) throw new Error('room_id не указан');
  if(id === 'overview') throw new Error('overview не является комнатой');
  const known = new Set(listKnownRoomIds());
  if(!known.has(id)) throw new Error(`Комната ${id} не найдена в конфигурации`);
  return id;
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
function listKnownRoomIds(){
  const set = new Set();
  try{
    const devices = parseJsAssignedArray(DEVICES_PATH, 'ALL_DEVICES');
    for(const d of devices){
      const rid = String(d?.room || d?.area || '').trim();
      if(rid && rid !== 'overview' && rid !== 'unassigned') set.add(rid);
    }
  }catch(e){}
  try{
    const raw = readJsonSafe(ROOMS_SETTINGS_PATH, {rooms:{}});
    for(const rid of Object.keys(raw.rooms || {})) if(rid && rid !== 'overview') set.add(rid);
  }catch(e){}
  return [...set].sort((a,b)=>a.localeCompare(b));
}

const STANDARD_SENSOR_KEYS = ['temperature','humidity','motion','noise','co2','illuminance'];
function defaultRoomsSettings(){ return { version: 1, rooms: {}, updatedAt: null }; }
function normalizeEntityId(value){
  const v = String(value || '').trim();
  if(!v) return '';
  if(!/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(v)) throw new Error(`Некорректный entity_id: ${v}`);
  return v;
}
function normalizeStandardSensors(value){
  const src = isPlainObject(value) ? value : {};
  const out = {};
  for(const key of STANDARD_SENSOR_KEYS){
    const v = normalizeEntityId(src[key]);
    if(v) out[key] = v;
  }
  return out;
}
function normalizeRoomSettingsRoom(roomId, value){
  const current = isPlainObject(value) ? value : {};
  const out = { ...current };
  if(Object.prototype.hasOwnProperty.call(current, 'standardSensors')) out.standardSensors = normalizeStandardSensors(current.standardSensors);
  return out;
}
function normalizeRoomsSettings(payload){
  const src = isPlainObject(payload) ? payload : defaultRoomsSettings();
  const known = new Set(listKnownRoomIds());
  const rooms = {};
  for(const [roomId, value] of Object.entries(isPlainObject(src.rooms) ? src.rooms : {})){
    if(!known.has(roomId)) continue;
    rooms[roomId] = normalizeRoomSettingsRoom(roomId, value);
  }
  return { version: Number(src.version) || 1, rooms, updatedAt: src.updatedAt || null };
}
function loadRoomsSettings(){ return normalizeRoomsSettings(readJsonSafe(ROOMS_SETTINGS_PATH, defaultRoomsSettings())); }
function saveRoomsSettings(payload){
  const next = normalizeRoomsSettings({ ...(payload||{}), updatedAt: new Date().toISOString() });
  atomicWriteJson(ROOMS_SETTINGS_PATH, next);
  return next;
}
function saveRoomStandardSensors(roomId, sensors){
  const id = assertKnownRoomId(roomId);
  const current = loadRoomsSettings();
  current.rooms[id] = { ...(current.rooms[id] || {}), standardSensors: normalizeStandardSensors(sensors || {}) };
  return saveRoomsSettings(current);
}
function roomSourcesForApi(){
  const settings = loadRoomsSettings();
  const labelByRoom = {};
  try{
    const devices = parseJsAssignedArray(DEVICES_PATH, 'ALL_DEVICES');
    for(const d of devices){
      const rid = String(d?.room || '').trim();
      if(rid && !labelByRoom[rid]) labelByRoom[rid] = d.roomLabel || d.room_name || rid;
    }
  }catch(e){}
  return listKnownRoomIds().map(id => ({ id, label: settings.rooms[id]?.alias || labelByRoom[id] || id, source: settings.rooms[id]?.source || 'detected', settings: settings.rooms[id] || {} }));
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

async function buildDiagnostics(){
  const devices=loadAllDevicesForDiagnostics();
  let haStates=[]; let haError=null;
  try{ haStates=await haFetch('/states'); }catch(e){ haError=e.message; }
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
    haApiBase: HA_API_BASE,
    haWsUrl: HA_WS_URL,
    hasSupervisorToken: !!HA_TOKEN,
    haError,
    counts: { devices: devices.length, haStates: haStates.length, missingInHa: missing.length, duplicates: duplicates.length, noRoom: noRoom.length, noCoordinates: noCoordinates.length, backups: backupSummary().count },
    images: imagesDiagnostics(),
    profiles: profilesDiagnostics(),
    missingInHa: missing.slice(0,200), duplicates: duplicates.slice(0,200), noRoom: noRoom.slice(0,200), noCoordinates: noCoordinates.slice(0,200),
    backups: backupSummary(),
    storage: { dataDir: DATA_DIR, layoutPath: LAYOUT_PATH, addonConfigPath: ADDON_CONFIG_PATH, sourceConfigPath: SOURCE_CONFIG_PATH, uiStatePath: UI_STATE_PATH, attentionRulesPath: ATTENTION_RULES_PATH, securityRulesPath: SECURITY_RULES_PATH, profilesPath: PROFILES_META_PATH, profilesDir: PROFILES_DIR, activeProfileId: ACTIVE_PROFILE_ID, activeProfileDir: ACTIVE_PROFILE_DIR, activeLevelId: ACTIVE_LEVEL_ID, activeLevelDir: ACTIVE_LEVEL_DIR, levelsMetaPath: levelsMetaPath(ACTIVE_PROFILE_ID), roomsSettingsPath: ROOMS_SETTINGS_PATH, devicesPath: DEVICES_PATH, lovelacePath: LOVELACE_PATH, dataExists: fs.existsSync(DATA_DIR), imagesDir: DATA_IMAGES_DIR, imagesMetaPath: IMAGES_META_PATH, imagesExists: fs.existsSync(DATA_IMAGES_DIR), imagesMetaExists: fs.existsSync(IMAGES_META_PATH), layoutExists: fs.existsSync(LAYOUT_PATH), uiStateExists: fs.existsSync(UI_STATE_PATH), roomsSettingsExists: fs.existsSync(ROOMS_SETTINGS_PATH), devicesInData: fs.existsSync(DEVICES_PATH), lovelaceInData: fs.existsSync(LOVELACE_PATH), fallbackDevicesPath: FALLBACK_DEVICES_PATH, fallbackDevicesExists: fs.existsSync(FALLBACK_DEVICES_PATH) },
    layoutDiagnostics,
    allowedServices: ALLOWED_SERVICES,
    safeServices: SAFE_SERVICES,
    dangerousServices: DANGEROUS_SERVICES,
    security: normalizeSecurityConfig(loadAddonConfig().security),
    commandLog: loadCommandLog(),
    generatedAt: new Date().toISOString()
  };
}
function loadLayout(){ if(!fs.existsSync(LAYOUT_PATH)) return {version:1, markers:{}}; try{return JSON.parse(fs.readFileSync(LAYOUT_PATH,'utf8'));}catch(e){return {version:1, markers:{}};} }
function timestampForFile(){ return new Date().toISOString().replace(/[:.]/g,'-'); }
function backupLayout(){
  if(!fs.existsSync(LAYOUT_PATH)) return null;
  fs.mkdirSync(LAYOUT_BACKUP_DIR,{recursive:true});
  const backupPath = path.join(LAYOUT_BACKUP_DIR, `layout-${timestampForFile()}.json`);
  fs.copyFileSync(LAYOUT_PATH, backupPath);
  return backupPath;
}
function saveLayout(layout){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const normalized = normalizeLayoutPayload(layout || {version:8}, {strict:false});
  const payload = normalized.layout;
  let backupPath = null;
  if(fs.existsSync(LAYOUT_PATH)) backupPath = backupLayout();
  const tmpPath = LAYOUT_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, LAYOUT_PATH);
  pruneLayoutBackups(20);
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
function loadSourceConfig(){
  if(!fs.existsSync(SOURCE_CONFIG_PATH)) return defaultSourceConfig();
  try { return { ...defaultSourceConfig(), ...JSON.parse(fs.readFileSync(SOURCE_CONFIG_PATH,'utf8')) }; }
  catch(e){ return defaultSourceConfig(); }
}
function saveSourceConfig(cfg){
  fs.mkdirSync(path.dirname(SOURCE_CONFIG_PATH),{recursive:true});
  fs.writeFileSync(SOURCE_CONFIG_PATH, JSON.stringify({ ...defaultSourceConfig(), ...(cfg || {}) }, null, 2), 'utf8');
}
function loadSourceConfigForLevel(profileId, levelId){
  const lp = ensureLevelDirs(profileId || ACTIVE_PROFILE_ID, levelId || ACTIVE_LEVEL_ID);
  if(!fs.existsSync(lp.sourceConfig)) return defaultSourceConfig();
  try { return { ...defaultSourceConfig(), ...JSON.parse(fs.readFileSync(lp.sourceConfig,'utf8')) }; }
  catch(e){ return defaultSourceConfig(); }
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
  fs.writeFileSync(lp.sourceConfig, JSON.stringify(normalized, null, 2), 'utf8');
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


ensureDataStore();
app.use(express.json({limit:'1mb'}));
app.get('/devices.js', (req,res)=>{
  const generated = DEVICES_PATH;
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.type('application/javascript');
  if(fs.existsSync(generated)) return res.sendFile(generated);
  return res.send('window.ALL_DEVICES = [];\nwindow.DEVICES = [];\n');
});
app.get('/lovelace-source.js', (req,res)=>{
  const generated = LOVELACE_PATH;
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');
  res.type('application/javascript');
  if(fs.existsSync(generated)) return res.sendFile(generated);
  return res.send('window.LOVELACE_SOURCE = {"version":1,"views":[]};\n');
});
app.use(express.static(path.join(__dirname, 'public')));


function defaultAddonConfig(){
  return {
    pollIntervalMs: 6000,
    dashboardPaths: [],
    ui: {
      darkTheme:true, kioskWidget:false, weatherEntity:'', showAllDevicesInRoom:false,
      haloScale:0.50, hardwareScale:1.00, markerScale:1.00, sensorScale:1.00, roomLabelScale:1.00, markerOpacity:0.00, sensorOpacity:0.00
    },
    security: { panelMode:'admin', confirmDangerousServices:true, dangerousRequirePin:false, pinEnabled:false }
  };
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
function loadCommandLog(){ return readJsonSafe(COMMAND_LOG_PATH, []); }
function appendCommandLog(entry){
  try{
    const list=Array.isArray(loadCommandLog())?loadCommandLog():[];
    list.unshift({...entry, time:new Date().toISOString()});
    atomicWriteJson(COMMAND_LOG_PATH, list.slice(0,100));
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
    const options = fs.existsSync(optionsPath) ? JSON.parse(fs.readFileSync(optionsPath, 'utf8')) : {};
    const local = fs.existsSync(ADDON_CONFIG_PATH) ? JSON.parse(fs.readFileSync(ADDON_CONFIG_PATH, 'utf8')) : {};
    const merged = { ...defaults, ...options, ...local };
    return {
      ...merged,
      pollIntervalMs: Number(local.pollIntervalMs || options.pollIntervalMs || defaults.pollIntervalMs),
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
    pollIntervalMs: Math.max(2000, Number(cfg?.pollIntervalMs || current.pollIntervalMs || 6000)),
    dashboardPaths: normalizeDashboardPaths(cfg?.dashboardPaths ?? cfg?.dashboardPathText ?? current.dashboardPaths ?? ''),
    ui: normalizeUiConfig({ ...current.ui, ...(cfg?.ui||{}) }),
    security: normalizeSecurityConfig({ ...current.security, ...(cfg?.security||{}) })
  };
  fs.writeFileSync(ADDON_CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
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
    pollIntervalMs: cfg?.pollIntervalMs || 6000,
    dashboardPaths,
    dashboardPathText: dashboardPaths.join('\n'),
    ui: normalizeUiConfig(cfg?.ui||{}),
    security: publicSecurityConfig(cfg?.security||{})
  };
}
async function haFetch(endpoint, init={}){
  if(!HA_TOKEN) throw new Error('SUPERVISOR_TOKEN недоступен. Проверь config.yaml: homeassistant_api: true');
  const url = HA_API_BASE + endpoint;
  const res = await fetch(url, { ...init, headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers||{}) } });
  if(!res.ok){
    const text = await res.text().catch(()=> '');
    throw new Error(`HA API ${res.status}${text ? ': '+text.slice(0,300) : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  if(ct.includes('application/json')) return res.json();
  return res.text();
}

function haWebSocketUrl(haUrl){
  const u = new URL(haUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/$/, '') + '/api/websocket';
  u.search = '';
  u.hash = '';
  return u.toString();
}
function splitDashboardPath(raw){
  const s = normalizeDashboardPathEntry(raw);
  const parts = s.split('/').filter(Boolean);
  return { raw:s, dashboardPath: parts[0] || 'lovelace', viewPath: parts.slice(1).join('/') };
}
function haWsCommand(type, payload={}){
  if(!HA_TOKEN) return Promise.reject(new Error('SUPERVISOR_TOKEN недоступен'));
  return new Promise((resolve,reject)=>{
    const ws = new WebSocket(HA_WS_URL);
    const timer = setTimeout(()=>{ try{ws.close();}catch(e){} reject(new Error('Timeout WebSocket Home Assistant')); }, 15000);
    let authed = false;
    const done = (err,data)=>{ clearTimeout(timer); try{ws.close();}catch(e){} err ? reject(err) : resolve(data); };
    ws.on('error', err=>done(err));
    ws.on('message', buf=>{
      let msg;
      try{ msg = JSON.parse(buf.toString()); }catch(e){ return; }
      if(msg.type === 'auth_required'){
        ws.send(JSON.stringify({type:'auth', access_token: HA_TOKEN}));
        return;
      }
      if(msg.type === 'auth_invalid') return done(new Error(msg.message || 'HA auth invalid'));
      if(msg.type === 'auth_ok' && !authed){
        authed = true;
        ws.send(JSON.stringify({id:1, type, ...payload}));
        return;
      }
      if(msg.id === 1){
        if(msg.success === false) return done(new Error(msg.error?.message || JSON.stringify(msg.error || msg)));
        return done(null, msg.result ?? msg);
      }
    });
  });
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
  fs.writeFileSync(activeLevelPaths().lovelaceRaw, JSON.stringify({ generatedAt:new Date().toISOString(), requested, results }, null, 2), 'utf8');
  return { requested, results };
}


const ENTITY_DOMAINS = new Set([
  'light','switch','sensor','binary_sensor','cover','climate','media_player','humidifier','fan','input_boolean','input_number','input_select','valve','lock','scene','script','automation','button','person','camera','alarm_control_panel','select','number','water_heater','vacuum','remote','device_tracker','weather','sun','update','calendar','timer','counter','event','image','siren','lawn_mower','notify','conversation','todo','text','datetime','date','time','stt','tts','wake_word'
]);
const ENTITY_RE = /\b([a-z_][a-z0-9_]*)\.([A-Za-z0-9_]+)\b/g;
const ROOM_PATTERNS = [
  [/гостин|living|зал|тв гост/i, 'living'],
  [/кухн|kitchen/i, 'kitchen'],
  [/левая.*спаль|спальня левая|bedroom1|left.*bedroom/i, 'bedroom1'],
  [/правая.*спаль|спальня правая|bedroom2|right.*bedroom/i, 'bedroom2'],
  [/кабинет|office/i, 'office'],
  [/гардер|wardrobe/i, 'wardrobe'],
  [/постир|котель|laundry|boiler/i, 'laundry'],
  [/основ.*сан|санузел основ|main.*bath/i, 'mainbath'],
  [/гост.*сан|guest.*bath/i, 'guestbath'],
  [/прихож|entrance/i, 'entrance'],
  [/коридор|corridor/i, 'corridor'],
  [/медиа|nvidia|dennon|denon|алиса|master.*volume|мастер-громкость/i, 'media'],
  [/сантех|протеч|кран|plumb/i, 'plumbing'],
  [/систем|system/i, 'system'],
  [/хрень|misc/i, 'misc']
];
const DOMAIN_EMOJI = { light:'💡', switch:'🔌', cover:'▤', climate:'❄️', media_player:'▶️', humidifier:'💧', sensor:'📟', binary_sensor:'●', valve:'🚰', lock:'🔒', scene:'✨', fan:'💨', input_boolean:'✅', input_number:'🔢', input_select:'▾', button:'⏺', script:'▶', automation:'⚙', person:'👤' };
function domainOf(entityId){ return String(entityId||'').split('.')[0] || ''; }
function isEntityId(value){ const d=domainOf(value); return ENTITY_DOMAINS.has(d) && /^[a-z_][a-z0-9_]*\.[A-Za-z0-9_]+$/.test(String(value||'')); }
function extractEntityIdsFromString(value){
  const out=[]; const text=String(value||''); let m;
  ENTITY_RE.lastIndex = 0;
  while((m=ENTITY_RE.exec(text))){
    const id = `${m[1]}.${m[2]}`;
    if(isEntityId(id)) out.push(id);
  }
  return out;
}
function friendlyFromEntityId(entityId){
  const s=String(entityId||'').split('.')[1]||String(entityId||'');
  return s.replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase());
}
function canonicalRoomFromText(...parts){
  const text = parts.filter(Boolean).join(' ');
  for(const [re, room] of ROOM_PATTERNS){ if(re.test(text)) return room; }
  return 'unassigned';
}
function asArray(value){ return Array.isArray(value) ? value : (value == null ? [] : [value]); }
function deepClone(obj){ return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }
function deepMerge(a,b){
  if(Array.isArray(a) || Array.isArray(b)) return b === undefined ? deepClone(a) : deepClone(b);
  if(!a || typeof a !== 'object') return b === undefined ? deepClone(a) : deepClone(b);
  if(!b || typeof b !== 'object') return deepClone(a);
  const out = deepClone(a);
  for(const [k,v] of Object.entries(b)) out[k] = (out[k] && v && typeof out[k]==='object' && typeof v==='object' && !Array.isArray(out[k]) && !Array.isArray(v)) ? deepMerge(out[k], v) : deepClone(v);
  return out;
}
function variablesToMap(vars){
  const out={};
  if(Array.isArray(vars)){
    for(const item of vars){ if(item && typeof item==='object') Object.assign(out, item); }
  } else if(vars && typeof vars==='object') Object.assign(out, vars);
  return out;
}
function substituteDeclutteringVars(node, vars){
  if(typeof node === 'string'){
    return node.replace(/\[\[\s*([A-Za-z0-9_ -]+)\s*\]\]/g, (_, key)=> String(vars[key.trim()] ?? ''));
  }
  if(Array.isArray(node)) return node.map(v=>substituteDeclutteringVars(v, vars));
  if(node && typeof node === 'object'){
    const out={};
    for(const [k,v] of Object.entries(node)) out[k]=substituteDeclutteringVars(v, vars);
    return out;
  }
  return node;
}
function unwrapLovelaceConfig(raw){
  return raw?.config || raw?.rawConfig?.config || raw?.result?.config || raw?.rawConfig || raw || {};
}
function selectViews(config, viewFilters){
  const views = Array.isArray(config.views) ? config.views : [];
  const filters = [...new Set((viewFilters||[]).map(v=>String(v).trim()).filter(Boolean))];
  if(!filters.length) return views.map((view,index)=>({view,index}));
  return views.map((view,index)=>({view,index})).filter(({view,index})=>{
    return filters.some(f=>{
      if(/^\d+$/.test(f)) return Number(f) === index;
      const normalized = f.replace(/^\/+|\/+$/g,'').toLowerCase();
      return String(view.path||'').toLowerCase() === normalized || String(view.title||'').toLowerCase() === normalized;
    });
  });
}
function cardTitle(card, fallback){
  return String(card?.title || card?.name || card?.label || fallback || card?.type || 'Без группы');
}
function headingTitle(card){ return String(card?.heading || card?.title || card?.name || '').trim(); }
function getCardsFromView(view){
  const cards=[];
  if(Array.isArray(view.cards)) cards.push(...view.cards);
  if(Array.isArray(view.sections)){
    for(const section of view.sections){
      let currentHeading = section.title || '';
      if(Array.isArray(section.cards)){
        for(const card of section.cards){
          if(card?.type === 'heading'){
            currentHeading = headingTitle(card) || currentHeading;
            continue;
          }
          // В sections dashboard карточки часто идут под heading без title. Сохраняем heading как группу,
          // но name самой карточки оставляем для имени устройства и определения комнаты.
          cards.push({ ...card, title: card.title || currentHeading || section.title || card.name });
        }
      }
    }
  }
  return cards;
}
function resolveButtonCardTemplates(card, templates, stats, stack=[]){
  const names = asArray(card?.template || card?.templates).flatMap(v=>Array.isArray(v)?v:[v]).filter(v=>typeof v==='string');
  let merged = {};
  for(const name of names){
    if(stack.includes(name)) { stats.templateWarnings.push(`button-card cycle: ${stack.concat(name).join(' -> ')}`); continue; }
    const tpl = templates?.[name];
    if(!tpl) { stats.templateWarnings.push(`button-card template not found: ${name}`); continue; }
    stats.templatesUsed.add(`button_card_templates.${name}`);
    merged = deepMerge(merged, resolveButtonCardTemplates(tpl, templates, stats, stack.concat(name)));
    merged = deepMerge(merged, tpl);
  }
  return deepMerge(merged, card || {});
}
function resolveDeclutteringCard(card, templates, stats){
  if(!card || card.type !== 'custom:decluttering-card') return card;
  const name = card.template;
  const tpl = templates?.[name];
  if(!tpl){ stats.templateWarnings.push(`decluttering template not found: ${name}`); return card; }
  stats.templatesUsed.add(`decluttering_templates.${name}`);
  const defaults = variablesToMap(tpl.default || []);
  const vars = { ...defaults, ...variablesToMap(card.variables || []) };
  const tplCard = tpl.card ? tpl.card : tpl;
  const resolved = substituteDeclutteringVars(deepClone(tplCard), vars);
  return deepMerge(resolved, { variables: vars });
}
function collectEntityRefs(node, refs, ctx={}){
  if(node == null) return refs;
  if(typeof node === 'string'){
    for(const id of extractEntityIdsFromString(node)) refs.push({ entity_id:id, name:ctx.name, icon:ctx.icon });
    return refs;
  }
  if(Array.isArray(node)){ for(const item of node) collectEntityRefs(item, refs, ctx); return refs; }
  if(typeof node !== 'object') return refs;
  const nextCtx = {
    name: node.name || node.label || node.title || ctx.name,
    icon: node.icon || ctx.icon
  };
  if(typeof node.entity === 'string' && isEntityId(node.entity)) refs.push({ entity_id:node.entity, name:nextCtx.name, icon:nextCtx.icon });
  if(typeof node.entity_id === 'string' && isEntityId(node.entity_id)) refs.push({ entity_id:node.entity_id, name:nextCtx.name, icon:nextCtx.icon });
  if(Array.isArray(node.entity_id)) for(const id of node.entity_id) if(isEntityId(id)) refs.push({ entity_id:id, name:nextCtx.name, icon:nextCtx.icon });
  if(typeof node.service_data?.entity_id === 'string' && isEntityId(node.service_data.entity_id)) refs.push({ entity_id:node.service_data.entity_id, name:nextCtx.name, icon:nextCtx.icon });
  if(Array.isArray(node.service_data?.entity_id)) for(const id of node.service_data.entity_id) if(isEntityId(id)) refs.push({ entity_id:id, name:nextCtx.name, icon:nextCtx.icon });
  if(typeof node.target?.entity_id === 'string' && isEntityId(node.target.entity_id)) refs.push({ entity_id:node.target.entity_id, name:nextCtx.name, icon:nextCtx.icon });
  if(Array.isArray(node.target?.entity_id)) for(const id of node.target.entity_id) if(isEntityId(id)) refs.push({ entity_id:id, name:nextCtx.name, icon:nextCtx.icon });
  for(const [k,v] of Object.entries(node)){
    if(['entity','entity_id','service_data','target'].includes(k)) continue;
    collectEntityRefs(v, refs, nextCtx);
  }
  return refs;
}
function flattenCardForEntityCollection(card, config, stats){
  let out = deepClone(card || {});
  out = resolveDeclutteringCard(out, config.decluttering_templates || {}, stats);
  if(out?.type === 'custom:button-card' || out?.template || out?.templates){
    out = resolveButtonCardTemplates(out, config.button_card_templates || {}, stats);
  }
  return out;
}
function makeDevice(ref, ctx){
  const domain = domainOf(ref.entity_id);
  const category = ctx.cardTitle || 'Без группы';
  const name = ref.name || friendlyFromEntityId(ref.entity_id);
  const haArea = ctx.haArea || null;
  // Приоритет комнаты:
  // 1) Lovelace card/section title, 2) имя устройства/entity_id, 3) HA Area API, 4) unassigned.
  const roomFromCard = canonicalRoomFromText(category, ctx.viewTitle);
  const roomFromName = canonicalRoomFromText(name, ref.entity_id);
  const panelRoom = roomFromCard !== 'unassigned' ? roomFromCard : roomFromName;
  const haRoom = haArea?.room && haArea.room !== 'unassigned' ? haArea.room : '';
  const room = panelRoom !== 'unassigned' ? panelRoom : (haRoom || 'unassigned');
  const sourceKey = `${ctx.viewTitle || 'RAW'}::${category}`;
  return {
    entity_id: ref.entity_id,
    name,
    icon: ref.icon || '',
    cardTitle: category,
    viewTitle: ctx.viewTitle || 'RAW Lovelace',
    cardType: ctx.cardType || '',
    source: 'raw-lovelace',
    domain,
    label: name,
    category,
    room,
    haArea: haArea ? { areaId: haArea.areaId || '', areaName: haArea.areaName || '', room: haArea.room || '' } : null,
    roomSource: roomFromCard !== 'unassigned' ? 'lovelace-card' : (roomFromName !== 'unassigned' ? 'device-name' : (haRoom ? 'ha-area' : 'unassigned')),
    zone: null,
    emoji: DOMAIN_EMOJI[domain] || '•',
    sourceKey,
    panelName: name,
    nameSource: ref.name ? 'panel-name' : 'entity-id'
  };
}
function parseLovelaceRawBundle(bundle, haRegistry={}){
  const generatedAt = new Date().toISOString();
  const devicesById = new Map();
  const viewsOut = [];
  const stats = { generatedAt, dashboards:0, views:0, cards:0, entitiesFound:0, templatesUsed:new Set(), templateWarnings:[], skippedViews:[], haRegistry: haRegistry.meta || null };
  const results = bundle?.results || [];
  for(const result of results){
    if(!result.ok) continue;
    stats.dashboards += 1;
    const config = unwrapLovelaceConfig(result.rawConfig ?? result.raw);
    const selectedViews = selectViews(config, result.viewFilters || []);
    const allViews = Array.isArray(config.views) ? config.views : [];
    if((result.viewFilters||[]).length && !selectedViews.length) stats.skippedViews.push(`${result.dashboardPath}: ${result.viewFilters.join(', ')}`);
    for(const {view,index} of selectedViews){
      stats.views += 1;
      const viewTitle = view.title || view.path || `Вкладка ${index}`;
      const cardsOut=[];
      for(const originalCard of getCardsFromView(view)){
        const cTitle = cardTitle(originalCard, viewTitle);
        const sourceKey = `${viewTitle}::${cTitle}`;
        const resolved = flattenCardForEntityCollection(originalCard, config, stats);
        const refs = collectEntityRefs(resolved, [], { name: resolved.name || resolved.label, icon: resolved.icon });
        const uniqueRefs = [];
        const seen = new Set();
        for(const ref of refs){ if(!seen.has(ref.entity_id)){ seen.add(ref.entity_id); uniqueRefs.push(ref); } }
        if(!uniqueRefs.length) continue;
        stats.cards += 1;
        const cardDevices = [];
        for(const ref of uniqueRefs){
          const existing = devicesById.get(ref.entity_id);
          const device = existing || makeDevice(ref, { viewTitle, cardTitle:cTitle, cardType:originalCard.type || resolved.type || '', haArea: haRegistry.entityArea?.get(ref.entity_id) });
          if(!existing) devicesById.set(ref.entity_id, device);
          cardDevices.push(device);
        }
        cardsOut.push({ title:cTitle, canonicalRoom:canonicalRoomFromText(cTitle, viewTitle), zone:null, sourceKey, devices:cardDevices });
      }
      viewsOut.push({ title:viewTitle, path:view.path || String(index), cards:cardsOut });
    }
  }
  const devices = [...devicesById.values()].sort((a,b)=>String(a.sourceKey).localeCompare(String(b.sourceKey),'ru') || a.entity_id.localeCompare(b.entity_id));
  stats.entitiesFound = devices.length;
  const source = { version:2, generatedAt, generatedFrom:'ha-lovelace-raw', haRegistry: haRegistry.meta || null, views:viewsOut };
  return { devices, source, stats: { ...stats, templatesUsed:[...stats.templatesUsed] } };
}
function writeDeviceOutputs(parsed){
  if(!parsed.devices.length) throw new Error('RAW Lovelace прочитан, но entity_id не найдены. Файлы устройств не перезаписаны.');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const devicesJs = 'window.ALL_DEVICES = '+JSON.stringify(parsed.devices, null, 2)+';\nwindow.DEVICES = window.ALL_DEVICES;\n';
  const lovelaceJs = 'window.LOVELACE_SOURCE = '+JSON.stringify(parsed.source, null, 2)+';\n';
  fs.writeFileSync(activeLevelPaths().devicesJson, JSON.stringify(parsed.devices, null, 2), 'utf8');
  fs.writeFileSync(DEVICES_PATH, devicesJs, 'utf8');
  fs.writeFileSync(LOVELACE_PATH, lovelaceJs, 'utf8');
  fs.writeFileSync(activeLevelPaths().deviceParseReportJson, JSON.stringify(parsed.stats, null, 2), 'utf8');
  const md = [
    '# Device parse report v3.4.13',
    '',
    `Generated: ${parsed.stats.generatedAt}`,
    `Source: HA Lovelace RAW`,
    '',
    `- Dashboards read: ${parsed.stats.dashboards}`,
    `- Views processed: ${parsed.stats.views}`,
    `- Cards with entities: ${parsed.stats.cards}`,
    `- Unique entities: ${parsed.stats.entitiesFound}`,
    `- Runtime storage: /data/devices.js, /data/lovelace-source.js, /data/devices.json`,
    `- Templates used: ${parsed.stats.templatesUsed.length ? parsed.stats.templatesUsed.join(', ') : 'none'}`,
    '',
    '## Template warnings',
    ...(parsed.stats.templateWarnings.length ? parsed.stats.templateWarnings.map(x=>`- ${x}`) : ['- none']),
    '',
    '## Skipped views',
    ...(parsed.stats.skippedViews.length ? parsed.stats.skippedViews.map(x=>`- ${x}`) : ['- none'])
  ].join('\n');
  fs.writeFileSync(activeLevelPaths().deviceParseReportMd, md+'\n', 'utf8');
}

async function importLovelaceRaw(paths){
  const rawBundle = await readLovelaceRawFromHa(paths);
  const registry = await loadHaEntityAreaMap();
  const parsed = parseLovelaceRawBundle(rawBundle, registry);
  writeDeviceOutputs(parsed);
  return { ...rawBundle, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length, haRegistry: parsed.stats.haRegistry } };
}
async function importStoredLovelaceRaw(){
  const file = activeLevelPaths().lovelaceRaw;
  if(!fs.existsSync(file)) throw new Error('data/lovelace_raw.json не найден. Сначала перечитайте RAW панели из HA.');
  const rawBundle = JSON.parse(fs.readFileSync(file,'utf8'));
  const registry = await loadHaEntityAreaMap();
  const parsed = parseLovelaceRawBundle(rawBundle, registry);
  writeDeviceOutputs(parsed);
  return { ok:true, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length, haRegistry: parsed.stats.haRegistry } };
}

function sendImageFile(res, file, kind='overview', roomId=''){
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if(file && fs.existsSync(file)) return res.sendFile(file);
  res.type('image/svg+xml').send(placeholderSvg(kind, roomId));
}
app.get(['/media/overview','/media/overview/:filename','/media/images/overview.webp'], (req,res)=>{
  const custom = activeCustomOverviewImagePath();
  sendImageFile(res, custom && fs.existsSync(custom) ? custom : null, 'overview');
});
app.get(['/media/rooms/:room_id','/media/rooms/:room_id/:filename','/media/images/rooms/:room_id.webp'], (req,res)=>{
  const roomId = req.params.room_id;
  const custom = activeCustomRoomImagePath(roomId);
  sendImageFile(res, custom && fs.existsSync(custom) ? custom : null, 'room', roomId);
});
app.use('/media', express.static(DATA_IMAGES_DIR, {fallthrough:true}));


app.get('/api/profiles', (req,res)=>{ try{res.json({ok:true, ...profilesDiagnostics()});}catch(e){res.status(500).json({ok:false,error:e.message});} });
app.post('/api/profiles', (req,res)=>{ try{res.json({ok:true, ...createProfile(req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.post('/api/profiles/:id/duplicate', (req,res)=>{ try{res.json({ok:true, ...duplicateProfile(req.params.id, req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.post('/api/profiles/:id/activate', (req,res)=>{ try{res.json({ok:true, ...activateProfile(req.params.id), reloadRecommended:true});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.delete('/api/profiles/:id', (req,res)=>{ try{res.json({ok:true, ...deleteProfile(req.params.id, req.body||{}), reloadRecommended:true});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.patch('/api/profiles/:id', (req,res)=>{ try{res.json({ok:true, ...patchProfile(req.params.id, req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });

app.get('/api/levels', (req,res)=>{ try{res.json({ok:true, ...levelsDiagnostics()});}catch(e){res.status(500).json({ok:false,error:e.message});} });
app.post('/api/levels', (req,res)=>{ try{res.json({ok:true, ...createLevel(req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.post('/api/levels/:id/duplicate', (req,res)=>{ try{res.json({ok:true, ...duplicateLevel(req.params.id, req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.post('/api/levels/:id/activate', (req,res)=>{ try{res.json({ok:true, ...activateLevel(req.params.id), reloadRecommended:true});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.delete('/api/levels/:id', (req,res)=>{ try{res.json({ok:true, ...deleteLevel(req.params.id), reloadRecommended:true});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.patch('/api/levels/:id', (req,res)=>{ try{res.json({ok:true, ...patchLevel(req.params.id, req.body||{})});}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.get('/api/levels/:id/source-config', (req,res)=>{
  try{
    const cfg = loadSourceConfigForLevel(ACTIVE_PROFILE_ID, req.params.id);
    const dashboardPaths = normalizeDashboardPaths(cfg.dashboardPaths ?? cfg.dashboardPathText ?? '');
    res.json({ok:true, levelId:sanitizeLevelId(req.params.id), config:{...cfg, dashboardPaths, dashboardPathText:dashboardPaths.join('\n')}});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.patch('/api/levels/:id/source-config', (req,res)=>{
  try{
    const current = loadSourceConfigForLevel(ACTIVE_PROFILE_ID, req.params.id);
    const cfg = saveSourceConfigForLevel(ACTIVE_PROFILE_ID, req.params.id, {...current, ...(req.body||{})});
    const dashboardPaths = normalizeDashboardPaths(cfg.dashboardPaths ?? cfg.dashboardPathText ?? '');
    res.json({ok:true, levelId:sanitizeLevelId(req.params.id), config:{...cfg, dashboardPaths, dashboardPathText:dashboardPaths.join('\n')}, levels:levelsDiagnostics()});
  }catch(e){res.status(400).json({ok:false,error:e.message});}
});
app.post('/api/levels/:id/lovelace/import', async (req,res)=>{
  try{
    const current = loadSourceConfigForLevel(ACTIVE_PROFILE_ID, req.params.id);
    const dashboardPaths = normalizeDashboardPaths(req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? current.dashboardPaths ?? '');
    saveSourceConfigForLevel(ACTIVE_PROFILE_ID, req.params.id, {...current, dashboardPaths});
    const data = await importLovelaceRawForLevel(ACTIVE_PROFILE_ID, req.params.id, dashboardPaths);
    res.json({ok:true, levelId:sanitizeLevelId(req.params.id), ...data, levels:levelsDiagnostics()});
  }catch(e){res.status(500).json({ok:false,error:e.message});}
});

app.get('/api/images', (req,res)=>{
  try{
    const roomIds = listKnownRoomIds();
    const rooms = {};
    for(const roomId of roomIds) rooms[roomId] = imageInfo('room', roomId);
    res.json({ ok:true, meta: loadImagesMeta(), overview: imageInfo('overview'), rooms });
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

app.post('/api/images/overview', express.raw({type:['image/*','application/octet-stream'], limit:'25mb'}), async (req,res)=>{
  try{
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
  }catch(e){ res.status(400).json({ok:false, error:e.message}); }
});

app.delete('/api/images/overview', (req,res)=>{
  try{
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
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

app.post('/api/images/rooms/:room_id', express.raw({type:['image/*','application/octet-stream'], limit:'25mb'}), async (req,res)=>{
  try{
    ensureDataStore();
    const roomId = assertKnownRoomId(req.params.room_id);
    const info = validateUploadedImage(req, req.body, 'room');
    const currentInfo = imageInfo('room', roomId);
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup(`before-room-${safeRoomImageFileBase(roomId)}-image-replace`) : null;
    const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g,'_');
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
  }catch(e){ res.status(400).json({ok:false, error:e.message}); }
});

app.delete('/api/images/rooms/:room_id', (req,res)=>{
  try{
    ensureDataStore();
    const roomId = assertKnownRoomId(req.params.room_id);
    const backupRequested = req.query.backup === '1' || req.get('x-create-backup') === '1';
    const preBackup = backupRequested ? createManualBackup(`before-room-${safeRoomImageFileBase(roomId)}-image-replace`) : null;
    const safe = String(roomId).replace(/[^a-zA-Z0-9_-]/g,'_');
    for(const ext of ['webp','png','jpg','jpeg']){
      const f = path.join(DATA_IMAGES_ROOMS_DIR, `${safe}.${ext}`);
      if(fs.existsSync(f)) fs.unlinkSync(f);
    }
    const meta = loadImagesMeta();
    meta.rooms = isPlainObject(meta.rooms) ? meta.rooms : {};
    delete meta.rooms[roomId];
    saveImagesMeta(meta);
    res.json({ok:true, room_id:roomId, room:imageInfo('room', roomId), rooms:{[roomId]:imageInfo('room', roomId)}, meta:loadImagesMeta(), backup:false});
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/health', (req,res)=> res.json({ ok:true }));
app.get('/api/layout', (req,res)=>{ try{res.json(loadLayout());}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/rooms', (req,res)=>{ try{ res.json({ ok:true, ...loadRoomsSettings(), knownRooms: roomSourcesForApi() }); }catch(e){res.status(500).json({error:e.message});} });
app.patch('/api/rooms/:room_id/standard-sensors', (req,res)=>{ try{ const settings=saveRoomStandardSensors(req.params.room_id, req.body?.standardSensors || req.body || {}); res.json({ ok:true, ...settings }); }catch(e){res.status(400).json({error:e.message});} });
app.get('/api/layout/diagnostics', (req,res)=>{ try{res.json(analyzeLayout(loadLayout()));}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/layout/normalize', (req,res)=>{ try{res.json(normalizeStoredLayout());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/layout/clear-markers', (req,res)=>{ try{res.json(clearLayoutMarkers());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/layout/clear-zones', (req,res)=>{ try{res.json(clearLayoutZones());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/factory-reset', (req,res)=>{ try{res.json(factoryResetProject(req.body?.confirm));}catch(e){res.status(400).json({ok:false,error:e.message});} });
app.get('/api/source-config', (req,res)=>{ try{res.json(loadSourceConfig());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/source-config', (req,res)=>{ try{saveSourceConfig(req.body);res.json({ok:true, config: loadSourceConfig()});}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/layout', (req,res)=>{ try{const backup=saveLayout(req.body);res.json({ok:true, backup: backup ? path.basename(backup) : null, diagnostics: analyzeLayout(loadLayout())});}catch(e){res.status(400).json({error:e.message});} });
app.get('/api/config', (req,res)=> { try { res.json(publicConfig(loadAddonConfig())); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/config', (req,res)=> {
  try {
    const body = req.body || {};
    // v3.5.8.2: Lovelace/dashboard paths are configured per level, not in global settings.
    const {dashboardPaths, dashboardPathText, ...globalBody} = body;
    const cfg = saveAddonConfig(globalBody || {});
    res.json({ ok:true, config: publicConfig(cfg) });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/config/clear', (req,res)=> { try { saveAddonConfig({ pollIntervalMs:6000, dashboardPaths:[] }); res.json({ok:true, config: publicConfig(loadAddonConfig())}); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/ha/test', async (req,res)=> { try { const data = await haFetch('/'); res.json({ ok:true, data }); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/system', (req,res)=> { try { res.json({ ok:true, version:ADDON_VERSION, mode:'home-assistant-addon', haApiBase:HA_API_BASE, haWsUrl:HA_WS_URL, hasSupervisorToken:!!HA_TOKEN, dataDir:DATA_DIR }); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/ui-state', (req,res)=> { try { res.json(loadUiState()); } catch(e){ res.status(500).json({error:e.message}); } });


app.get('/api/security/rules', (req,res)=>{
  try{ res.json({ok:true, rules:loadSecurityRules(), security:publicSecurityConfig(loadAddonConfig().security)}); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/security/pin/change', (req,res)=>{
  try{
    const {pin,pin2}=req.body||{};
    if(String(pin)!==String(pin2)) return res.status(400).json({error:'PIN-коды не совпадают'});
    const security=setSecurityPin(pin);
    res.json({ok:true, security});
  }catch(e){ res.status(400).json({error:e.message}); }
});
app.post('/api/security/pin/reset', (req,res)=>{
  try{
    const {pin,pin2}=req.body||{};
    if(String(pin)!==String(pin2)) return res.status(400).json({error:'PIN-коды не совпадают'});
    if(!verifySecurityPin(pin)) return res.status(403).json({error:'Неверный PIN'});
    const security=clearSecurityPin();
    res.json({ok:true, security});
  }catch(e){ res.status(400).json({error:e.message}); }
});
app.post('/api/security/pin/verify', (req,res)=>{
  try{ res.json({ok:verifySecurityPin(req.body?.pin)}); }
  catch(e){ res.status(500).json({error:e.message}); }
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
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/attention', async (req,res)=> {
  try {
    const rules = loadAttentionRules();
    let states = [];
    try { states = await haFetch('/states'); } catch(e) { states = []; }
    res.json(evaluateAttentionRules(rules, states));
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/attention', async (req,res)=> {
  try {
    const entity_id = String(req.body?.entity_id || '').trim();
    if(!entity_id) return res.status(400).json({error:'entity_id is required'});
    let st = null;
    try { st = await haFetch('/states/' + encodeURIComponent(entity_id)); } catch(e) { st = null; }
    const current = st ? String(st.state) : String(req.body?.normal_state || 'unknown');
    const name = String(req.body?.name || st?.attributes?.friendly_name || entity_id);
    const data = loadAttentionRules();
    const rest = data.rules.filter(r=>r.entity_id !== entity_id);
    rest.push({ entity_id, name, normal_state: current, enabled:true, created_at:new Date().toISOString() });
    const saved = saveAttentionRules({version:1, rules: rest});
    let states = [];
    try { states = await haFetch('/states'); } catch(e) { states = []; }
    res.json(evaluateAttentionRules(saved, states));
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.delete('/api/attention/:entity_id', async (req,res)=> {
  try {
    const entity_id = decodeURIComponent(String(req.params.entity_id || ''));
    const data = loadAttentionRules();
    const saved = saveAttentionRules({version:1, rules: data.rules.filter(r=>r.entity_id !== entity_id)});
    let states = [];
    try { states = await haFetch('/states'); } catch(e) { states = []; }
    res.json(evaluateAttentionRules(saved, states));
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/attention/clear', async (req,res)=> {
  try { res.json(evaluateAttentionRules(saveAttentionRules(attentionDefault()), [])); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/ui-state', (req,res)=> { try { res.json({ok:true, state: saveUiState(req.body || {})}); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/diagnostics', async (req,res)=> { try { res.json(await buildDiagnostics()); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/backups', (req,res)=> { try { res.json({ok:true, backups:backupSummary()}); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/backups/create', (req,res)=> { try { const item=createManualBackup(req.body?.reason||'manual'); res.json({ok:true, backup:item, backups:backupSummary()}); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/backups/restore', (req,res)=> { try { const layout=restoreLayoutBackup(req.body?.name); res.json({ok:true, layout}); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/backups/delete', (req,res)=> { try { deleteBackupItem(req.body?.name); res.json({ok:true, backups:backupSummary()}); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/backups/delete-old', (req,res)=> { try { res.json({ok:true, backups:deleteOldBackups(req.body?.keep||10)}); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/backups/delete-all', (req,res)=> { try { res.json({ok:true, backups:deleteAllBackups(req.body?.confirm)}); } catch(e){ res.status(400).json({error:e.message}); } });

app.post('/api/ha/dashboard-paths/normalize', (req,res)=>{
  try { res.json({ ok:true, dashboardPaths: normalizeDashboardPaths(req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? '') }); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/ha/lovelace/raw', async (req,res)=>{
  try {
    const cfg = loadSourceConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await readLovelaceRawFromHa(paths);
    res.json({ ok:true, ...data });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/ha/lovelace/import', async (req,res)=>{
  try {
    const cfg = loadSourceConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await importLovelaceRaw(paths);
    res.json({ ok:true, ...data });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/ha/lovelace/import-stored', async (req,res)=>{
  try { res.json(await importStoredLovelaceRaw()); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/ha/states', async (req,res)=> { try { const states = await haFetch('/states'); res.json({ ok:true, states }); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/ha/service', async (req,res)=> {
  const {domain, service, data, confirmDangerous, pin} = req.body || {};
  const entity_id = data?.entity_id || '';
  try {
    if(!domain || !service) return res.status(400).json({error:'domain and service are required'});
    const cfg = loadAddonConfig();
    const security = normalizeSecurityConfig(cfg.security);
    const category = commandCategory(domain, service, entity_id);
    if(security.panelMode === 'viewer'){
      appendCommandLog({domain,service,entity_id,result:'blocked-viewer'});
      return res.status(403).json({error:'Панель в режиме viewer: управление запрещено'});
    }
    if(category === 'blocked'){
      appendCommandLog({domain,service,entity_id,result:'blocked-allowlist'});
      console.warn(`[Smart Home UI] Blocked service call ${domain}.${service}`);
      return res.status(403).json({error:`Service ${domain}.${service} запрещён allowlist`});
    }
    if(category === 'dangerous'){
      if(security.panelMode === 'control' && security.dangerousRequirePin && security.pinEnabled && !verifySecurityPin(pin, security)){
        appendCommandLog({domain,service,entity_id,result:'pin-required',category});
        return res.status(409).json({requiresPin:true, message:`Введите PIN для опасной команды ${domain}.${service}${entity_id ? ' для '+entity_id : ''}`});
      }
      if(security.confirmDangerousServices && !confirmDangerous){
        return res.status(409).json({requiresConfirmation:true, message:`Подтвердить опасную команду ${domain}.${service}${entity_id ? ' для '+entity_id : ''}?`});
      }
    }
    const result = await haFetch(`/services/${domain}/${service}`, { method:'POST', body: JSON.stringify(data || {}) });
    appendCommandLog({domain,service,entity_id,result:'ok',category});
    res.json({ ok:true, result, category });
  } catch(e){ appendCommandLog({domain,service,entity_id,result:'error:'+e.message}); res.status(500).json({error:e.message}); }
});

const server = app.listen(PORT, ()=> console.log(`Smart Home UI HA Add-on listening on http://0.0.0.0:${PORT}`));
server.on('error', err => {
  if(err && err.code === 'EADDRINUSE'){
    console.error(`Port ${PORT} is already in use. Set another PORT, e.g. PORT=8105`);
    process.exit(1);
  }
  throw err;
});
