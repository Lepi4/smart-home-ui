'use strict';

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

const ROOM_LABELS = {
  living:'Гостиная', kitchen:'Кухня', bedroom1:'Спальня левая', bedroom2:'Спальня правая',
  office:'Кабинет', wardrobe:'Гардероб', laundry:'Постирочная / котельная', mainbath:'Основной санузел',
  guestbath:'Гостевой санузел', entrance:'Прихожая', corridor:'Коридор', media:'media', plumbing:'plumbing', system:'system', misc:'misc'
};
function friendlyRoomLabel(roomId){ return ROOM_LABELS[String(roomId||'').trim()] || String(roomId||'').trim(); }

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

module.exports = {
  ENTITY_DOMAINS,
  ENTITY_RE,
  ROOM_PATTERNS,
  ROOM_LABELS,
  DOMAIN_EMOJI,
  friendlyRoomLabel,
  domainOf,
  isEntityId,
  extractEntityIdsFromString,
  friendlyFromEntityId,
  canonicalRoomFromText,
  asArray,
  deepClone,
  deepMerge,
  variablesToMap,
  substituteDeclutteringVars,
  unwrapLovelaceConfig,
  selectViews,
  cardTitle,
  headingTitle,
  getCardsFromView,
  resolveButtonCardTemplates,
  resolveDeclutteringCard,
  collectEntityRefs,
  flattenCardForEntityCollection,
  makeDevice,
  parseLovelaceRawBundle
};
