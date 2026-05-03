const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const FALLBACK_DATA_DIR = path.join(__dirname, 'data');
const ADDON_CONFIG_PATH = path.join(DATA_DIR, 'addon_config.json');
const HA_API_BASE = (process.env.HA_API_BASE || 'http://supervisor/core/api').replace(/\/$/, '');
const HA_WS_URL = process.env.HA_WS_URL || HA_API_BASE.replace(/^http/i, 'ws').replace(/\/api$/, '/websocket');
const HA_TOKEN = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';
const LAYOUT_PATH = path.join(DATA_DIR, 'layout.json');
const LAYOUT_BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SOURCE_CONFIG_PATH = path.join(DATA_DIR, 'source_config.json');
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
  const payload = layout || {version:1,markers:{}};
  let backupPath = null;
  if(fs.existsSync(LAYOUT_PATH)) backupPath = backupLayout();
  const tmpPath = LAYOUT_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, LAYOUT_PATH);
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
    includeUnknownFromApi: false
  };
}
function loadSourceConfig(){
  if(!fs.existsSync(SOURCE_CONFIG_PATH)) return defaultSourceConfig();
  try { return { ...defaultSourceConfig(), ...JSON.parse(fs.readFileSync(SOURCE_CONFIG_PATH,'utf8')) }; }
  catch(e){ return defaultSourceConfig(); }
}
function saveSourceConfig(cfg){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(SOURCE_CONFIG_PATH, JSON.stringify({ ...defaultSourceConfig(), ...(cfg || {}) }, null, 2), 'utf8');
}


app.use(express.json({limit:'1mb'}));
app.get('/devices.js', (req,res)=>{
  const generated = path.join(DATA_DIR, 'devices.js');
  const fallback = path.join(__dirname, 'public', 'devices.js');
  res.type('application/javascript').sendFile(fs.existsSync(generated) ? generated : fallback);
});
app.get('/lovelace-source.js', (req,res)=>{
  const generated = path.join(DATA_DIR, 'lovelace-source.js');
  const fallback = path.join(__dirname, 'public', 'lovelace-source.js');
  res.type('application/javascript').sendFile(fs.existsSync(generated) ? generated : fallback);
});
app.use(express.static(path.join(__dirname, 'public')));


function loadAddonConfig(){
  const defaults = { pollIntervalMs: 6000, dashboardPaths: [] };
  try {
    const optionsPath = path.join(DATA_DIR, 'options.json');
    const options = fs.existsSync(optionsPath) ? JSON.parse(fs.readFileSync(optionsPath, 'utf8')) : {};
    const local = fs.existsSync(ADDON_CONFIG_PATH) ? JSON.parse(fs.readFileSync(ADDON_CONFIG_PATH, 'utf8')) : {};
    return {
      ...defaults,
      ...options,
      ...local,
      pollIntervalMs: Number(local.pollIntervalMs || options.pollIntervalMs || defaults.pollIntervalMs),
      dashboardPaths: normalizeDashboardPaths(local.dashboardPaths ?? local.dashboardPathText ?? options.dashboardPaths ?? options.dashboardPathText ?? '')
    };
  } catch(e) {
    return defaults;
  }
}
function saveAddonConfig(cfg){
  fs.mkdirSync(DATA_DIR, {recursive:true});
  const next = {
    pollIntervalMs: Math.max(2000, Number(cfg?.pollIntervalMs || 6000)),
    dashboardPaths: normalizeDashboardPaths(cfg?.dashboardPaths ?? cfg?.dashboardPathText ?? '')
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
    dashboardPathText: dashboardPaths.join('\n')
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
  fs.writeFileSync(path.join(DATA_DIR,'lovelace_raw.json'), JSON.stringify({ generatedAt:new Date().toISOString(), requested, results }, null, 2), 'utf8');
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
function getCardsFromView(view){
  const cards=[];
  if(Array.isArray(view.cards)) cards.push(...view.cards);
  if(Array.isArray(view.sections)){
    for(const section of view.sections){
      if(Array.isArray(section.cards)){
        for(const card of section.cards) cards.push({ ...card, title: card.title || section.title || card.name });
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
  const room = canonicalRoomFromText(category, ctx.viewTitle, ref.entity_id);
  const name = ref.name || friendlyFromEntityId(ref.entity_id);
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
    zone: null,
    emoji: DOMAIN_EMOJI[domain] || '•',
    sourceKey,
    panelName: name,
    nameSource: ref.name ? 'panel-name' : 'entity-id'
  };
}
function parseLovelaceRawBundle(bundle){
  const generatedAt = new Date().toISOString();
  const devicesById = new Map();
  const viewsOut = [];
  const stats = { generatedAt, dashboards:0, views:0, cards:0, entitiesFound:0, templatesUsed:new Set(), templateWarnings:[], skippedViews:[] };
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
          const device = existing || makeDevice(ref, { viewTitle, cardTitle:cTitle, cardType:originalCard.type || resolved.type || '' });
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
  const source = { version:2, generatedAt, generatedFrom:'ha-lovelace-raw', views:viewsOut };
  return { devices, source, stats: { ...stats, templatesUsed:[...stats.templatesUsed] } };
}
function writeDeviceOutputs(parsed){
  if(!parsed.devices.length) throw new Error('RAW Lovelace прочитан, но entity_id не найдены. Файлы устройств не перезаписаны.');
  fs.mkdirSync(DATA_DIR,{recursive:true});
  fs.writeFileSync(path.join(DATA_DIR,'devices.json'), JSON.stringify(parsed.devices, null, 2), 'utf8');
  fs.writeFileSync(path.join(__dirname,'public','devices.js'), 'window.ALL_DEVICES = '+JSON.stringify(parsed.devices, null, 2)+';\nwindow.DEVICES = window.ALL_DEVICES;\n', 'utf8');
  fs.writeFileSync(path.join(__dirname,'public','lovelace-source.js'), 'window.LOVELACE_SOURCE = '+JSON.stringify(parsed.source, null, 2)+';\n', 'utf8');
  fs.writeFileSync(path.join(DATA_DIR,'device_parse_report.json'), JSON.stringify(parsed.stats, null, 2), 'utf8');
  const md = [
    '# Device parse report v3.2.3',
    '',
    `Generated: ${parsed.stats.generatedAt}`,
    `Source: HA Lovelace RAW`,
    '',
    `- Dashboards read: ${parsed.stats.dashboards}`,
    `- Views processed: ${parsed.stats.views}`,
    `- Cards with entities: ${parsed.stats.cards}`,
    `- Unique entities: ${parsed.stats.entitiesFound}`,
    `- Templates used: ${parsed.stats.templatesUsed.length ? parsed.stats.templatesUsed.join(', ') : 'none'}`,
    '',
    '## Template warnings',
    ...(parsed.stats.templateWarnings.length ? parsed.stats.templateWarnings.map(x=>`- ${x}`) : ['- none']),
    '',
    '## Skipped views',
    ...(parsed.stats.skippedViews.length ? parsed.stats.skippedViews.map(x=>`- ${x}`) : ['- none'])
  ].join('\n');
  fs.writeFileSync(path.join(DATA_DIR,'device_parse_report.md'), md+'\n', 'utf8');
}
async function importLovelaceRaw(paths){
  const rawBundle = await readLovelaceRawFromHa(paths);
  const parsed = parseLovelaceRawBundle(rawBundle);
  writeDeviceOutputs(parsed);
  return { ...rawBundle, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length } };
}
function importStoredLovelaceRaw(){
  const file = path.join(DATA_DIR,'lovelace_raw.json');
  if(!fs.existsSync(file)) throw new Error('data/lovelace_raw.json не найден. Сначала перечитайте RAW панели из HA.');
  const rawBundle = JSON.parse(fs.readFileSync(file,'utf8'));
  const parsed = parseLovelaceRawBundle(rawBundle);
  writeDeviceOutputs(parsed);
  return { ok:true, import: { devices: parsed.devices.length, views: parsed.stats.views, cards: parsed.stats.cards, templatesUsed: parsed.stats.templatesUsed.length, warnings: parsed.stats.templateWarnings.length } };
}

app.get('/api/health', (req,res)=> res.json({ ok:true }));
app.get('/api/layout', (req,res)=>{ try{res.json(loadLayout());}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/source-config', (req,res)=>{ try{res.json(loadSourceConfig());}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/source-config', (req,res)=>{ try{saveSourceConfig(req.body);res.json({ok:true, config: loadSourceConfig()});}catch(e){res.status(500).json({error:e.message});} });
app.post('/api/layout', (req,res)=>{ try{const backup=saveLayout(req.body);res.json({ok:true, backup: backup ? path.basename(backup) : null});}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/config', (req,res)=> { try { res.json(publicConfig(loadAddonConfig())); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/config', (req,res)=> {
  try {
    const cfg = saveAddonConfig(req.body || {});
    res.json({ ok:true, config: publicConfig(cfg) });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/config/clear', (req,res)=> { try { saveAddonConfig({ pollIntervalMs:6000, dashboardPaths:[] }); res.json({ok:true, config: publicConfig(loadAddonConfig())}); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/ha/test', async (req,res)=> { try { const data = await haFetch('/api/'); res.json({ ok:true, data }); } catch(e){ res.status(500).json({error:e.message}); } });
app.get('/api/system', (req,res)=> { try { res.json({ ok:true, mode:'home-assistant-addon', haApiBase:HA_API_BASE, haWsUrl:HA_WS_URL, hasSupervisorToken:!!HA_TOKEN, dataDir:DATA_DIR }); } catch(e){ res.status(500).json({error:e.message}); } });

app.post('/api/ha/dashboard-paths/normalize', (req,res)=>{
  try { res.json({ ok:true, dashboardPaths: normalizeDashboardPaths(req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? '') }); }
  catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/ha/lovelace/raw', async (req,res)=>{
  try {
    const cfg = loadAddonConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await readLovelaceRawFromHa(paths);
    res.json({ ok:true, ...data });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/ha/lovelace/import', async (req,res)=>{
  try {
    const cfg = loadAddonConfig();
    const paths = req.body?.dashboardPaths ?? req.body?.dashboardPathText ?? cfg.dashboardPaths ?? cfg.dashboardPathText ?? '';
    const data = await importLovelaceRaw(paths);
    res.json({ ok:true, ...data });
  } catch(e){ res.status(500).json({error:e.message}); }
});
app.post('/api/ha/lovelace/import-stored', (req,res)=>{
  try { res.json(importStoredLovelaceRaw()); }
  catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/ha/states', async (req,res)=> { try { const states = await haFetch('/api/states'); res.json({ ok:true, states }); } catch(e){ res.status(500).json({error:e.message}); } });
app.post('/api/ha/service', async (req,res)=> { try { const {domain, service, data} = req.body; if(!domain || !service) return res.status(400).json({error:'domain and service are required'}); const result = await haFetch(`/api/services/${domain}/${service}`, { method:'POST', body: JSON.stringify(data || {}) }); res.json({ ok:true, result }); } catch(e){ res.status(500).json({error:e.message}); } });

const server = app.listen(PORT, ()=> console.log(`Smart Home UI HA Add-on listening on http://0.0.0.0:${PORT}`));
server.on('error', err => {
  if(err && err.code === 'EADDRINUSE'){
    console.error(`Port ${PORT} is already in use. Set another PORT, e.g. PORT=8105`);
    process.exit(1);
  }
  throw err;
});
