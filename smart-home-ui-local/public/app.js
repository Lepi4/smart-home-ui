const state = {
  selectedRoom: 'overview',
  states: {},
  pollTimer: null,
  config: null,
  sourceConfig: null,
  layout: { version: 8, coordinateSpace: 'room-content-box', overviewRoomSync: false, roomCoordinateMigrated: {}, overviewMarkers: {}, roomMarkers: {}, overviewMetrics: {}, roomMetrics: {}, zones: {}, customNames: {} },
  edit: false,
  editSnapshot: null,
  undoStack: [],
  redoStack: [],
  layoutDirty: false,
  selectedEdit: null,
  suppressClick: false,
  quickOverlayOpen: false,
  serverUiState: null,
  ui: { hideSidebar:true, hideDevicePanel:true, hideToolbar:false, mobileMode:true, autoHide:false, compact:false, haloScale:0.50, hardwareScale:1.00, markerScale:1.00, sensorScale:1.00, roomLabelScale:1.00, markerOpacity:0.00, sensorOpacity:0.00, showAllDevicesInRoom:false, darkTheme:true, theme:'dark', kioskWidget:false, kioskMode:false, kioskTileMode:false, kioskNavigationMode:'switchable', kioskAutoLock:false, kioskAutoLockSeconds:15, weatherEntity:'', showZones:true, invisibleZones:false, showMarkers:true, showSensors:true, debugMode:false },
  viewport: { overview:{zoom:1,panX:0,panY:0}, rooms:{} },
  stageGesture: null, editHoldTimer:null, diagnostics:null, infoTab:'summary', clockTimer:null, persistTimer:null, openDeviceRoomGroup:null, openDevicePickerGroup:null, devicePickerShowAll:false, kioskLocked:false, kioskAutoLockTimer:null, kioskTileRoomFilter:'', placementEditor:null, images:null, roomsSettings:{version:1,rooms:{}}, attention:{ok:true,hasAlerts:false,rules:[]}, profiles:null, levels:null, backups:null, openStandardSensorRooms:new Set(), setupWizard:{step:1, profileName:'Дом', levelCount:1, levelNames:['1 этаж'], createdProfileId:null}
};

const STATIC_ROOMS = window.PLAN_CONFIG.rooms || [];

const ROOM_LABELS = {
  living:'Гостиная', kitchen:'Кухня', bedroom1:'Спальня левая', bedroom2:'Спальня правая',
  office:'Кабинет', wardrobe:'Гардероб', laundry:'Постирочная / котельная', mainbath:'Основной санузел',
  guestbath:'Гостевой санузел', entrance:'Прихожая', corridor:'Коридор', media:'media', plumbing:'plumbing', system:'system', misc:'misc'
};
function friendlyRoomLabel(roomId){ return ROOM_LABELS[String(roomId||'').trim()] || String(roomId||'').trim(); }
function runtimeRoomLabel(roomId, rawLabel){
  const id=normalizedRoomId(String(roomId||'').trim());
  const label=String(rawLabel||'').trim();
  if(!label) return friendlyRoomLabel(id);
  const technical = label.toLowerCase()===id.toLowerCase() || label.toLowerCase()===String(roomId||'').trim().toLowerCase();
  if(technical && ROOM_LABELS[id]) return friendlyRoomLabel(id);
  return label;
}

let ROOMS = [];
let ROOM_MAP = {};
function rebuildRoomMap(){ ROOM_MAP = Object.fromEntries(ROOMS.map(r => [r.id, r])); }
function refreshRuntimeRooms(){
  const byId = new Map();
  // v3.5.8.8: do not merge hardcoded/static room geometry into imported rooms.
  // Zones, metrics and room sensors must appear only after user/imported runtime data exists in /data.
  for(const item of (state.roomsSettings?.knownRooms || [])){
    const id=normalizedRoomId(item.id); if(!id || id==='overview') continue;
    byId.set(id, { id, label:item.settings?.alias || runtimeRoomLabel(id, item.label), image:`media/images/rooms/${encodeURIComponent(id)}.webp` });
  }
  for(const d of allDevices()){
    const id=normalizedRoomId(d.room); if(!id || id==='overview' || id==='unassigned') continue;
    if(!byId.has(id)) byId.set(id,{id,label:runtimeRoomLabel(id, d.roomLabel),image:`media/images/rooms/${encodeURIComponent(id)}.webp`});
  }
  ROOMS=[{id:'overview',label:'Общий план'}, ...[...byId.values()].sort((a,b)=>(a.label||a.id).localeCompare(b.label||b.id,'ru'))];
  rebuildRoomMap();
}
const TYPE_ICONS = { light:'💡', switch:'🔌', cover:'▤', climate:'❄️', media_player:'▶️', humidifier:'💧', sensor:'📟', binary_sensor:'●', valve:'🚰', lock:'🔒', scene:'✨', fan:'💨', input_boolean:'✅', input_number:'🔢', input_select:'▾', button:'⏺', script:'▶', automation:'⚙', person:'👤', camera:'📷' };
const TOGGLE_DOMAINS = new Set(['light','switch','fan','input_boolean','cover','media_player','climate','humidifier','valve']);
const IMPORTANT_DOMAINS = new Set(['light','switch','cover','climate','media_player','humidifier','fan','sensor','binary_sensor','input_boolean','input_number','input_select','valve','lock','button','script','automation']);
const LONG_PRESS_MS = 560;
const GESTURE_MOVE_PX = 14;
const DRAG_SUPPRESS_MS = 420;

// v3.4.13: global settings live in /data/addon_config.json and must be identical
// on PC, phone and kiosk panels. Device UI state is local per browser/screen.
// Ключи, хранящиеся на сервере глобально (одинаковы для всех устройств)
const GLOBAL_UI_KEYS = new Set(['weatherEntity']);
// Ключи, хранящиеся per-device в /api/prefs (у каждого устройства свои)
const CLIENT_UI_KEYS = new Set(['darkTheme','kioskWidget','kioskAutoLock','kioskAutoLockSeconds','haloScale','hardwareScale','markerScale','sensorScale','roomLabelScale','markerOpacity','sensorOpacity','showAllDevicesInRoom','debugMode']);
const DEVICE_UI_KEYS = new Set(['hideSidebar','hideDevicePanel','hideToolbar','mobileMode','autoHide','compact','kioskMode','kioskTileMode','kioskNavigationMode','showZones','invisibleZones','showMarkers','showSensors','theme']);
function pickKeys(obj, keys){ const out={}; for(const k of keys){ if(obj && Object.prototype.hasOwnProperty.call(obj,k)) out[k]=obj[k]; } return out; }
function applyGlobalConfig(cfg){
  const src = (cfg && cfg.ui) ? cfg.ui : cfg || {};
  // Читаем и GLOBAL и CLIENT ключи из серверного конфига как дефолты (backward compat).
  // После loadClientPrefs() client-ключи будут перекрыты per-device значениями.
  const next = pickKeys(src, new Set([...GLOBAL_UI_KEYS, ...CLIENT_UI_KEYS]));
  if(Object.keys(next).length){ state.ui = { ...state.ui, ...next }; applyUiPrefs(); renderKioskWidget(); }
}
// В глобальный конфиг отправляем только действительно общие ключи
function buildGlobalConfigPayload(){ return { ui: pickKeys(state.ui, GLOBAL_UI_KEYS) }; }
function buildSecurityConfigPayload(){ return { security:{panelMode:el('pref-panel-mode')?.value||state.config?.security?.panelMode||'admin',confirmDangerousServices:!!el('pref-confirm-dangerous')?.checked,dangerousRequirePin:!!el('pref-dangerous-pin')?.checked,pinEnabled:!!state.config?.security?.pinEnabled} }; }
function panelMode(){ const m=state.config?.security?.panelMode || 'admin'; return m==='user'?'viewer':m; }
function canEditLayout(){ return panelMode()==='admin'; }
function panelModeRank(mode){ return ({viewer:0,control:1,admin:2})[mode==='user'?'viewer':mode] ?? 2; }
async function verifyPinPrompt(message='Введите PIN для повышения режима'){
  const pin=await requestPin(message);
  if(!pin) return false;
  try{ const res=await apiJson('api/security/pin/verify',{method:'POST',body:JSON.stringify({pin})}); return !!res.ok; }
  catch(e){ showToast('Ошибка PIN: '+e.message); return false; }
}

async function saveGlobalPrefs(){
  // panelMode теперь per-client → убираем из глобального security
  const sec = buildSecurityConfigPayload();
  if(sec.security) delete sec.security.panelMode;
  const res=await apiJson('api/config',{method:'POST',body:JSON.stringify({...buildGlobalConfigPayload(),...sec})});
  state.config=res.config||state.config;
  saveClientPrefs().catch(()=>{});
  return res;
}

async function loadClientPrefs(){
  try{
    const prefs = await apiJson('api/prefs');
    // Применяем per-device UI настройки (перекрывают глобальные дефолты)
    if(prefs.ui){
      const over = pickKeys(prefs.ui, CLIENT_UI_KEYS);
      if(Object.keys(over).length){ state.ui={...state.ui,...over}; applyUiPrefs(); renderKioskWidget(); }
    }
    // Применяем режим доступа для этого устройства
    if(prefs.panelMode && state.config?.security){
      state.config.security.panelMode = prefs.panelMode;
      const pm = el('pref-panel-mode'); if(pm) pm.value = prefs.panelMode;
    }
    // Активный профиль (применяется в renderProfilesManager после загрузки)
    if(prefs.activeProfileId !== undefined) state._clientActiveProfileId = prefs.activeProfileId;
  }catch(e){ console.warn('[prefs] load', e); }
}

async function saveClientPrefs(){
  const prefs = {
    ui: pickKeys(state.ui, CLIENT_UI_KEYS),
    panelMode: el('pref-panel-mode')?.value || state.config?.security?.panelMode || 'admin',
  };
  if(state._clientActiveProfileId !== undefined) prefs.activeProfileId = state._clientActiveProfileId;
  await apiJson('api/prefs', {method:'PUT', body:JSON.stringify(prefs)});
}

function el(id){return document.getElementById(id)}
function qsa(s,p=document){return [...p.querySelectorAll(s)]}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function midpoint(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}}
function room(id){return ROOM_MAP[id]}
function roomWithLayout(id){const r=room(id); return {...r,...(state.layout.zones?.[id]||{})}}
function hasZoneRect(r){ return Number.isFinite(Number(r?.x)) && Number.isFinite(Number(r?.y)) && Number.isFinite(Number(r?.w)) && Number.isFinite(Number(r?.h)) && Number(r.w)>0 && Number(r.h)>0; }
function sanitizeZonePoints(points){
  return (Array.isArray(points)?points:[])
    .map(p=>({x:clamp(Number(p?.x),0,100), y:clamp(Number(p?.y),0,100)}))
    .filter(p=>Number.isFinite(p.x)&&Number.isFinite(p.y));
}
function hasZonePolygon(r){ return sanitizeZonePoints(r?.points).length>=3; }
function hasZoneShape(r){ return hasZonePolygon(r) || hasZoneRect(r); }
function rectZonePoints(r){
  const x=clamp(Number(r?.x)||50,0,100), y=clamp(Number(r?.y)||50,0,100), w=clamp(Number(r?.w)||10,1,100), h=clamp(Number(r?.h)||10,1,100);
  const a=(Number(r?.a ?? r?.angle ?? r?.rotate ?? 0)||0)*Math.PI/180;
  const hw=w/2, hh=h/2;
  return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([dx,dy])=>({x:clamp(x+dx*Math.cos(a)-dy*Math.sin(a),0,100), y:clamp(y+dx*Math.sin(a)+dy*Math.cos(a),0,100)}));
}
function zonePoints(r){ return hasZonePolygon(r) ? sanitizeZonePoints(r.points) : rectZonePoints(r); }
function zoneCentroid(points){
  const pts=sanitizeZonePoints(points);
  if(!pts.length) return {x:50,y:50};
  let sx=0, sy=0; pts.forEach(p=>{sx+=p.x; sy+=p.y;});
  return {x:sx/pts.length, y:sy/pts.length};
}
function zoneBounds(points){
  const pts=sanitizeZonePoints(points); if(!pts.length) return {x:50,y:50,w:10,h:10};
  const xs=pts.map(p=>p.x), ys=pts.map(p=>p.y);
  const minX=Math.min(...xs), maxX=Math.max(...xs), minY=Math.min(...ys), maxY=Math.max(...ys);
  return {x:(minX+maxX)/2, y:(minY+maxY)/2, w:Math.max(1,maxX-minX), h:Math.max(1,maxY-minY)};
}
function zoneClipPath(points){ return `polygon(${sanitizeZonePoints(points).map(p=>`${p.x.toFixed(2)}% ${p.y.toFixed(2)}%`).join(',')})`; }
function roomContentBox(roomId){
  const r = room(normalizedRoomId(roomId));
  const box = r?.contentBox || {};
  return { x:Number(box.x)||0, y:Number(box.y)||0, w:Number(box.w)||100, h:Number(box.h)||100 };
}
function roomStoredToImagePos(roomId,p){
  const b=roomContentBox(roomId);
  return { x:clamp(b.x + (Number(p?.x)||0)/100*b.w,0,100), y:clamp(b.y + (Number(p?.y)||0)/100*b.h,0,100) };
}
function roomImageToStoredPos(roomId,p){
  const b=roomContentBox(roomId);
  const bw=Math.max(0.0001, Number(b.w)||100), bh=Math.max(0.0001, Number(b.h)||100);
  return { x:clamp(((Number(p?.x)||0)-b.x)/bw*100,0,100), y:clamp(((Number(p?.y)||0)-b.y)/bh*100,0,100) };
}
function devices(){return window.DEVICES || []}
function allDevices(){return window.ALL_DEVICES || []}
async function loadPersistedUiState(){
  try{ state.serverUiState = await apiJson('api/ui-state'); }
  catch(e){ console.warn('server ui-state load failed', e); state.serverUiState = null; }
}
function loadUiPrefs(){
  try{
    const server = state.serverUiState || {};
    const savedRaw=JSON.parse(localStorage.getItem('ui_prefs')||'{}');
    const saved=pickKeys(savedRaw, DEVICE_UI_KEYS);
    const serverUi=pickKeys(server.ui||{}, DEVICE_UI_KEYS);
    const last=JSON.parse(localStorage.getItem('last_view')||'{}');
    const coarsePointer = !!(navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
    const autoMobile = !!(window.matchMedia && (
      window.matchMedia('(max-width: 760px)').matches ||
      window.matchMedia('(orientation: landscape) and (max-height: 920px)').matches ||
      (coarsePointer && window.innerHeight <= 920)
    ));
    // Global display settings intentionally are NOT loaded from localStorage/ui_state.
    // They are applied from /api/config so PC and mobile share scale/opacity/clock/theme.
    state.ui = { ...state.ui, ...serverUi, ...saved, hideSidebar:true };
    // v3.5.8.9: mobile version is a normal user switch again.
    // Default/reset enables it, but the user can turn it off in settings.
    // The old left sidebar still stays hidden until the Rooms button opens it.
    if(autoMobile && state.ui.mobileMode){
      state.ui.hideDevicePanel = true;
    }
    state.ui.hideSidebar = true;
    if(last.selectedRoom || server.selectedRoom) state.selectedRoom = last.selectedRoom || server.selectedRoom || state.selectedRoom;
    if(state.selectedRoom !== 'overview' && !ROOM_MAP[state.selectedRoom]) state.selectedRoom='overview';
    loadViewportPrefs();
    applyUiPrefs();
  }catch(e){ loadViewportPrefs(); applyUiPrefs(); }
}
function currentUiStatePayload(){ return { selectedRoom: state.selectedRoom, ui: pickKeys(state.ui, DEVICE_UI_KEYS), viewport: state.viewport }; }
function persistUiStateSoon(){
  clearTimeout(state.persistTimer);
  state.persistTimer=setTimeout(()=>{
    fetch('api/ui-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentUiStatePayload())}).catch(()=>{});
  }, 500);
}
function saveUiPrefs(){
  localStorage.setItem('ui_prefs', JSON.stringify(pickKeys(state.ui, DEVICE_UI_KEYS)));
  localStorage.setItem('last_view', JSON.stringify({selectedRoom:state.selectedRoom, updatedAt:new Date().toISOString()}));
  applyUiPrefs();
  persistUiStateSoon();
}

function saveKioskLockLocal(){
  try{ localStorage.setItem('kiosk_locked', state.kioskLocked ? '1' : '0'); }catch(_){ }
}
function loadKioskLockLocal(){
  try{ state.kioskLocked = localStorage.getItem('kiosk_locked') === '1'; }catch(_){ state.kioskLocked=false; }
}
function setKioskLocked(locked, reason=''){
  state.kioskLocked=!!locked;
  saveKioskLockLocal();
  applyKioskLockUi();
  if(locked) showToast(reason || 'Киоск заблокирован');
  else { showToast('Киоск разблокирован'); resetKioskAutoLock(); }
}
function applyKioskLockUi(){
  document.body.classList.toggle('kiosk-locked', !!(state.ui.kioskMode && state.kioskLocked));
  const btn=el('btn-kiosk-lock');
  if(btn){
    btn.textContent=state.kioskLocked?'🔒 Lock':'🔓 Unlock';
    btn.title=state.kioskLocked?'Киоск заблокирован. Нажмите, чтобы разблокировать':'Киоск разблокирован. Нажмите, чтобы заблокировать';
    btn.classList.toggle('is-locked', state.kioskLocked);
  }
  const badge=el('kiosk-lock-badge');
  if(badge) badge.classList.toggle('hidden', !(state.ui.kioskMode && state.kioskLocked));
}
function resetKioskAutoLock(){
  if(state.kioskAutoLockTimer) clearTimeout(state.kioskAutoLockTimer);
  state.kioskAutoLockTimer=null;
  const seconds=Number(state.ui.kioskAutoLockSeconds || 15);
  if(state.ui.kioskMode && !state.kioskLocked && state.ui.kioskAutoLock && seconds>0){
    state.kioskAutoLockTimer=setTimeout(()=>setKioskLocked(true, 'Автоблокировка киоска'), seconds*1000);
  }
}
function registerKioskActivity(e){
  if(!state.ui.kioskMode) return;
  if(e && e.target && e.target.closest('.kiosk-lock-btn,.kiosk-attention-btn,.kiosk-exit-btn,.kiosk-rooms-btn,.kiosk-room-overlay,.attention-modal')) return;
  if(!state.kioskLocked) resetKioskAutoLock();
}
function isKioskInputLocked(){ return !!(state.ui.kioskMode && state.kioskLocked); }


function applyDisplayPrefsOnly(){
  const isNarrowMobile = window.matchMedia && window.matchMedia('(max-width: 560px)').matches;
  const mobileMarkerFactor = isNarrowMobile ? 0.84 : 1;
  const mobileSensorFactor = isNarrowMobile ? 0.72 : 1;
  document.documentElement.style.setProperty('--marker-scale', String(clamp(Number(state.ui.markerScale ?? 1), .1, 2) * mobileMarkerFactor));
  document.documentElement.style.setProperty('--sensor-scale', String(clamp(Number(state.ui.sensorScale ?? 1), .1, 2) * mobileSensorFactor));
  document.documentElement.style.setProperty('--room-label-scale', String(clamp(Number(state.ui.roomLabelScale ?? 1), .1, 2)));
  document.documentElement.style.setProperty('--marker-bg-opacity', String(clamp(1 - Number(state.ui.markerOpacity ?? 0), 0, 1)));
  document.documentElement.style.setProperty('--sensor-bg-opacity', String(clamp(1 - Number(state.ui.sensorOpacity ?? 0), 0, 1)));
}
function previewUiPrefsSoon(){
  if(state.previewPrefsRaf) cancelAnimationFrame(state.previewPrefsRaf);
  state.previewPrefsRaf=requestAnimationFrame(()=>{
    applyDisplayPrefsOnly();
    applyStageTransform('overview');
    applyStageTransform('room');
    updateZoomControls();
  });
  clearTimeout(state.previewPrefsSaveTimer);
  state.previewPrefsSaveTimer=setTimeout(()=>saveGlobalPrefs().catch(()=>{}), 1200);
}
function bindRangePreview(id, key, valueId, opts={}){
  const input=el(id);
  if(!input) return;
  const out=valueId ? el(valueId) : null;
  const update=e=>{
    const n=Number(e.target.value)/100;
    state.ui[key]=n;
    if(out) out.textContent=e.target.value+'%';
    previewUiPrefsSoon();
    if(opts.render) opts.render();
  };
  input.oninput=update;
  input.onchange=()=>saveGlobalPrefs().catch(()=>{});
}

function shouldUseMobileMode(){
  if(!window.matchMedia) return false;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches || !!(navigator.maxTouchPoints && navigator.maxTouchPoints > 0);
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  const touchLandscape = coarsePointer && window.matchMedia('(orientation: landscape) and (max-height: 920px)').matches;
  const touchShort = coarsePointer && window.innerHeight <= 920;
  return narrow || touchLandscape || touchShort;
}
function syncAutoMobileMode(){
  // v3.5.8.9: do not force mobile mode anymore.
  // Only keep overlay panels closed on small/touch screens when mobile mode is enabled.
  if(!shouldUseMobileMode() || !state.ui.mobileMode) return;
  const changed = !state.ui.hideSidebar || !state.ui.hideDevicePanel;
  state.ui.hideSidebar = true;
  state.ui.hideDevicePanel = true;
  if(changed){ applyUiPrefs(); persistUiStateSoon(); }
}
function loadViewportPrefs(){
  try{
    const server = state.serverUiState?.viewport || {};
    const saved=JSON.parse(localStorage.getItem('viewport_prefs')||'{}');
    state.viewport={ overview:{zoom:1,panX:0,panY:0}, rooms:{}, ...server, ...saved };
    state.viewport.overview={zoom:1,panX:0,panY:0, ...(server.overview||{}), ...(saved.overview||{})};
    state.viewport.rooms={...(server.rooms||{}), ...(saved.rooms||{})};
  }catch(e){ state.viewport={ overview:{zoom:1,panX:0,panY:0}, rooms:{} }; }
}
function saveViewportPrefs(){ localStorage.setItem('viewport_prefs', JSON.stringify(state.viewport)); persistUiStateSoon(); }
function viewportKey(kind){ return kind==='overview' ? 'overview' : 'room:'+normalizedRoomId(state.selectedRoom); }
function getViewport(kind){
  if(kind==='overview') return state.viewport.overview || (state.viewport.overview={zoom:1,panX:0,panY:0});
  const rid=normalizedRoomId(state.selectedRoom);
  return state.viewport.rooms[rid] || (state.viewport.rooms[rid]={zoom:1,panX:0,panY:0});
}
function viewportElements(kind){
  return {
    stage: kind==='overview' ? el('overview-stage') : el('room-stage'),
    content: kind==='overview' ? el('overview-content') : el('room-content')
  };
}
function clampViewportPan(kind, v){
  const {stage, content}=viewportElements(kind);
  const hardware=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5);
  const scale=hardware*(Number(v.zoom)||1);
  if(!stage || !content || !stage.clientWidth || !stage.clientHeight || !content.offsetWidth || !content.offsetHeight){
    v.panX=clamp(Number(v.panX)||0, -1200, 1200);
    v.panY=clamp(Number(v.panY)||0, -1200, 1200);
    return v;
  }
  const stageW=stage.clientWidth, stageH=stage.clientHeight;
  const contentW=content.offsetWidth*scale, contentH=content.offsetHeight*scale;
  // The content is centered by flex layout before transform. Pan is therefore limited around zero.
  // This prevents the old "endless scroll" feeling on mobile/landscape.
  let maxX = contentW > stageW ? Math.ceil((contentW-stageW)/2 + 80) : 0;
  let maxY = contentH > stageH ? Math.ceil((contentH-stageH)/2 + 80) : 0;
  v.panX=clamp(Number(v.panX)||0, -maxX, maxX);
  v.panY=clamp(Number(v.panY)||0, -maxY, maxY);
  return v;
}
function setViewport(kind, next, persist=true){
  const v=getViewport(kind);
  v.zoom=clamp(Number(next.zoom ?? v.zoom)||1, 0.5, 4);
  v.panX=Number(next.panX ?? v.panX)||0;
  v.panY=Number(next.panY ?? v.panY)||0;
  clampViewportPan(kind, v);
  applyStageTransform(kind);
  updateZoomControls();
  if(persist) saveViewportPrefs();
}
function resetViewport(kind){ setViewport(kind,{zoom:1,panX:0,panY:0}); }
function zoomViewport(kind, factor){
  const v=getViewport(kind);
  setViewport(kind,{zoom:v.zoom*factor});
}
function applyStageTransform(kind){
  const content=kind==='overview'?el('overview-content'):el('room-content'); if(!content) return;
  const v=getViewport(kind);
  clampViewportPan(kind, v);
  const hardware=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5);
  const scale=hardware*v.zoom;
  content.style.transformOrigin='0 0';
  content.style.transform=`translate3d(${v.panX}px, ${v.panY}px, 0) scale(${scale})`;
  content.dataset.scale=String(scale);
}
function activeStageKind(){ return state.selectedRoom==='overview'?'overview':'room'; }
function updateZoomControls(){
  const zv=el('zoom-value'); if(zv){ const v=getViewport(activeStageKind()); const hw=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5); zv.textContent=Math.round(v.zoom*hw*100)+'%'; }
}
function fitViewport(kind){ resetViewport(kind); }
function lockViewportScroll(){
  document.documentElement.style.overflow='hidden';
  document.body.style.overflow='hidden';
  document.body.style.position='fixed';
  document.body.style.inset='0';
  document.body.style.width='100%';
  document.body.style.height='100dvh';
}
function isMobilePanelMode(){ return !!state.ui.mobileMode || document.body.classList.contains('mobile-mode') || (navigator.maxTouchPoints>0 && Math.min(window.innerWidth, window.innerHeight)<820); }
function setPanelHidden(key, value){
  state.ui[key]=!!value;
  // v3.4.14: mobile panels are mutually exclusive. This prevents the Rooms and Devices sheets
  // from stacking over each other and blocking the bottom navigation.
  if(isMobilePanelMode()){
    if(key==='hideSidebar' && value===false) state.ui.hideDevicePanel=true;
    if(key==='hideDevicePanel' && value===false) state.ui.hideSidebar=true;
  }
  saveUiPrefs();
}
function closeMobilePanels(){
  if(!isMobilePanelMode()) return;
  if(!state.ui.hideSidebar || !state.ui.hideDevicePanel){
    state.ui.hideSidebar=true;
    state.ui.hideDevicePanel=true;
    saveUiPrefs();
  }
}

function applyUiPrefs(){
  document.body.classList.toggle('touch-capable', !!(navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
  document.body.classList.toggle('hide-sidebar', !!state.ui.hideSidebar);
  document.body.classList.toggle('hide-device-panel', !!state.ui.hideDevicePanel);
  document.body.classList.toggle('mobile-panel-open', !!state.ui.mobileMode && (!state.ui.hideSidebar || !state.ui.hideDevicePanel));
  document.body.classList.toggle('mobile-rooms-open', !!state.ui.mobileMode && !state.ui.hideSidebar);
  document.body.classList.toggle('mobile-devices-open', !!state.ui.mobileMode && !state.ui.hideDevicePanel);
  document.body.classList.toggle('hide-toolbar', !!state.ui.hideToolbar);
  document.body.classList.toggle('mobile-mode', !!state.ui.mobileMode);
  document.body.classList.toggle('auto-hide-menus', !!state.ui.autoHide);
  document.body.classList.toggle('compact-mode', !!state.ui.compact);
  const activeTheme = state.ui.theme || (state.ui.darkTheme ? 'dark' : 'light');
  document.body.dataset.theme = activeTheme;
  document.body.classList.toggle('dark-theme', activeTheme === 'dark' || activeTheme === 'midnight');
  document.body.classList.toggle('kiosk-mode', !!state.ui.kioskMode);
  document.body.classList.toggle('debug-mode', !!state.ui.debugMode);
  document.body.classList.toggle('can-edit', canEditLayout());
  document.body.classList.toggle('invisible-zones', !!state.ui.invisibleZones && state.ui.showZones!==false);
  const invZonesBox=el('pref-invisible-zones'); if(invZonesBox) invZonesBox.disabled=state.ui.showZones===false;
  applyKioskLockUi();
  resetKioskAutoLock();
  const isNarrowMobile = window.matchMedia && window.matchMedia('(max-width: 560px)').matches;
  const mobileMarkerFactor = isNarrowMobile ? 0.84 : 1;
  const mobileSensorFactor = isNarrowMobile ? 0.72 : 1;
  document.documentElement.style.setProperty('--marker-scale', String(clamp(Number(state.ui.markerScale ?? 1), .1, 2) * mobileMarkerFactor));
  document.documentElement.style.setProperty('--sensor-scale', String(clamp(Number(state.ui.sensorScale ?? 1), .1, 2) * mobileSensorFactor));
  document.documentElement.style.setProperty('--room-label-scale', String(clamp(Number(state.ui.roomLabelScale ?? 1), .1, 2)));
  document.documentElement.style.setProperty('--marker-bg-opacity', String(clamp(1 - Number(state.ui.markerOpacity ?? 0), 0, 1))); // setting is background transparency
  document.documentElement.style.setProperty('--sensor-bg-opacity', String(clamp(1 - Number(state.ui.sensorOpacity ?? 0), 0, 1))); // setting is background transparency
  const bs=el('btn-show-sidebar'); if(bs) bs.classList.toggle('hidden', !state.ui.hideSidebar || state.ui.kioskMode);
  const bd=el('btn-show-device-panel'); if(bd) bd.classList.toggle('hidden', !state.ui.hideDevicePanel || state.ui.kioskMode);
  const bt=el('btn-show-toolbar'); if(bt) bt.classList.toggle('hidden', !state.ui.hideToolbar || state.ui.kioskMode);
  const hs=el('btn-hide-sidebar'); if(hs) hs.textContent=state.ui.hideSidebar?'Показать':'Скрыть';
  const td=el('btn-toggle-devices-panel'); if(td) td.textContent=state.ui.hideDevicePanel?'Показать список':'Скрыть список';
  const tt=el('btn-toggle-toolbar'); if(tt) tt.textContent=state.ui.hideToolbar?'Показать верх':'Скрыть верх';
  const pm=el('pref-mobile-mode'); if(pm){ pm.checked=!!state.ui.mobileMode; pm.disabled=false; pm.closest('label')?.classList.remove('muted'); }
  const pa=el('pref-auto-hide'); if(pa) pa.checked=!!state.ui.autoHide;
  const pc=el('pref-compact-mode'); if(pc) pc.checked=!!state.ui.compact;
  const dt=el('pref-dark-theme'); if(dt) dt.checked=!!state.ui.darkTheme;
  const pt=el('pref-theme'); if(pt) pt.value=state.ui.theme||'dark';
  const kw=el('pref-kiosk-widget'); if(kw) kw.checked=!!state.ui.kioskWidget;
  const km=el('pref-kiosk-mode'); if(km) km.checked=!!state.ui.kioskMode;
  const ktm=el('pref-kiosk-navigation-mode'); if(ktm) ktm.value=String(state.ui.kioskNavigationMode || (state.ui.kioskTileMode?'tiles':'switchable'));
  const oldKtm=el('pref-kiosk-tile-mode'); if(oldKtm) oldKtm.checked=!!state.ui.kioskTileMode;
  const dbg=el('pref-debug-mode'); if(dbg) dbg.checked=!!state.ui.debugMode;
  const kal=el('pref-kiosk-autolock'); if(kal) kal.checked=!!state.ui.kioskAutoLock;
  const kas=el('pref-kiosk-autolock-seconds'); if(kas) kas.value=String(Number(state.ui.kioskAutoLockSeconds||15));
  const we=el('pref-weather-entity'); if(we) we.value=state.ui.weatherEntity||'';
  const widget=el('kiosk-widget'); if(widget) widget.classList.toggle('hidden', !state.ui.kioskWidget);
  const showAll=el('pref-show-all-devices-room'); if(showAll) showAll.checked=!!state.ui.showAllDevicesInRoom;
  const tz=el('toggle-zones'); if(tz) tz.checked=state.ui.showZones!==false;
  const iz=el('pref-invisible-zones'); if(iz){ iz.checked=!!state.ui.invisibleZones; }
  const tdv=el('toggle-devices'); if(tdv) tdv.checked=state.ui.showMarkers!==false;
  const ts=el('toggle-sensors'); if(ts) ts.checked=state.ui.showSensors!==false;
  const ph=el('pref-halo-scale'); if(ph){ ph.value=String(Math.round(Number(state.ui.haloScale ?? 0.50)*100)); const hv=el('pref-halo-scale-value'); if(hv) hv.textContent=ph.value+'%'; }
  const hw=el('pref-hardware-scale'); if(hw){ hw.value=String(Math.round(Number(state.ui.hardwareScale ?? 1)*100)); const hv=el('pref-hardware-scale-value'); if(hv) hv.textContent=hw.value+'%'; }
  const ms=el('pref-marker-scale'); if(ms){ ms.value=String(Math.round(Number(state.ui.markerScale ?? 1)*100)); const mv=el('pref-marker-scale-value'); if(mv) mv.textContent=ms.value+'%'; }
  const ss=el('pref-sensor-scale'); if(ss){ ss.value=String(Math.round(Number(state.ui.sensorScale ?? 1)*100)); const sv=el('pref-sensor-scale-value'); if(sv) sv.textContent=ss.value+'%'; }
  const rls=el('pref-room-label-scale'); if(rls){ rls.value=String(Math.round(Number(state.ui.roomLabelScale ?? 1)*100)); const rv=el('pref-room-label-scale-value'); if(rv) rv.textContent=rls.value+'%'; }
  const mo=el('pref-marker-opacity'); if(mo){ mo.value=String(Math.round(Number(state.ui.markerOpacity ?? 0)*100)); const mv=el('pref-marker-opacity-value'); if(mv) mv.textContent=mo.value+'%'; }
  const so=el('pref-sensor-opacity'); if(so){ so.value=String(Math.round(Number(state.ui.sensorOpacity ?? 0)*100)); const sv=el('pref-sensor-opacity-value'); if(sv) sv.textContent=so.value+'%'; }
  const pmode=el('pref-panel-mode'); if(pmode && state.config?.security?.panelMode) pmode.value=state.config.security.panelMode;
  const cd=el('pref-confirm-dangerous'); if(cd) cd.checked=state.config?.security?.confirmDangerousServices!==false;
  const dp=el('pref-dangerous-pin'); if(dp) dp.checked=!!state.config?.security?.dangerousRequirePin;
  const pinBadge=el('pin-status'); if(pinBadge) pinBadge.textContent=state.config?.security?.pinEnabled?'PIN установлен':'PIN не установлен';
  const resetPinBtn=el('btn-reset-pin'); if(resetPinBtn) resetPinBtn.disabled=!state.config?.security?.pinEnabled;
  updateEditButtons();
  applyStageTransform('overview'); applyStageTransform('room'); updateZoomControls();
}
function normalizedRoomId(id){return id==='boiler'?'laundry':id}
function roomDevices(id){const rid=normalizedRoomId(id);return devices().filter(d=>normalizedRoomId(d.room)===rid || (rid==='overview' && d.room!=='media'))}
function getState(id){return state.states[id] || null}
function lightKind(d){
  const text = `${d.label||''} ${d.name||''} ${d.icon||''} ${d.entity_id||''}`.toLowerCase();
  if(text.includes('точк') || text.includes('vanity-light')) return 'spot';
  if(text.includes('люстр') || text.includes('ceiling-light')) return 'chandelier';
  if(text.includes('бра') || text.includes('outdoor-lamp')) return 'sconce';
  if(text.includes('светильник') || text.includes('настол') || text.includes('desk-lamp') || text.includes('lamp')) return 'lamp';
  if(text.includes('зеркало') || text.includes('подсвет')) return 'strip';
  return 'light';
}

function deviceText(d){return `${d.label||''} ${d.name||''} ${d.icon||''} ${d.entity_id||''} ${d.category||''}`.toLowerCase()}
function isUnavailable(d){const st=String(getState(d.entity_id)?.state||'').toLowerCase(); return st==='unavailable'}
function climateKind(d){
  const t=deviceText(d);
  if(t.includes('бризер') || t.includes('brizer') || t.includes('oneair') || t.includes('ballu')) return 'breezer';
  if(t.includes('отоп') || t.includes('termostat') || t.includes('thermostat') || t.includes('радиатор') || t.includes('radiator')) return 'heater';
  return 'ac';
}
function coverKind(d){ const t=deviceText(d); return (t.includes('рулон') || t.includes('rulon') || t.includes('rol') || t.includes('roller')) ? 'roller' : 'curtain'; }
function isWindowSensor(d){ const t=deviceText(d); return d.domain==='binary_sensor' && (t.includes('окно') || t.includes('okno') || t.includes('window')); }
function isLeakSensor(d){ const t=deviceText(d); return d.domain==='binary_sensor' && (t.includes('протеч') || t.includes('protech') || t.includes('leak') || t.includes('water_leak') || t.includes('moisture')); }
function coverStateKind(d){
  const s=getState(d.entity_id); const st=String(s?.state||'').toLowerCase(); const pos=s?.attributes?.current_position;
  if(st==='unavailable') return 'unavailable';
  if(Number.isFinite(Number(pos))){ const n=Number(pos); if(n<=0) return 'closed'; if(n>=100) return 'open'; return 'partial'; }
  if(['closed','closing'].includes(st)) return 'closed';
  if(['opening'].includes(st)) return 'partial';
  if(['open'].includes(st)) return 'open';
  return 'closed';
}
function windowStateKind(d){ const st=String(getState(d.entity_id)?.state||'').toLowerCase(); if(st==='unavailable') return 'unavailable'; return st==='on' ? 'open' : 'closed'; }
function leakStateKind(d){ const st=String(getState(d.entity_id)?.state||'').toLowerCase(); if(st==='unavailable') return 'unavailable'; return st==='on' ? 'leak' : 'dry'; }
function mediaStateKind(d){ const st=String(getState(d.entity_id)?.state||'').toLowerCase(); if(st==='unavailable') return 'unavailable'; return st==='playing' ? 'playing' : 'stopped'; }

function sensorKind(d){
  const t=deviceText(d);
  if(t.includes('движ') || t.includes('motion')) return 'motion';
  if(t.includes('шум') || t.includes('sound') || t.includes('noise')) return 'noise';
  if(t.includes('освещ') || t.includes('illuminance') || t.includes('lux')) return 'illuminance';
  if(t.includes('co2') || t.includes('carbon_dioxide') || t.includes('углекисл')) return 'co2';
  if(t.includes('темпера') || t.includes('temperature') || t.includes('external_sensor')) return 'temperature';
  if(t.includes('влаж') || t.includes('humidity')) return 'humidity';
  return 'sensor';
}
function sensorIconMarkup(d){
  const k=sensorKind(d);
  const paths={
    motion:`<circle cx="12" cy="12" r="3"/><path d="M4 12a8 8 0 0 1 8-8M20 12a8 8 0 0 0-8-8M6 18c2-2 4-3 6-3s4 1 6 3"/>`,
    noise:`<path d="M5 9v6h3l5 4V5L8 9H5z"/><path d="M17 9c1 2 1 4 0 6M20 7c2 3 2 7 0 10"/>`,
    illuminance:`<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2.2 2.2M17.3 17.3l2.2 2.2M19.5 4.5l-2.2 2.2M6.7 17.3l-2.2 2.2"/>`,
    temperature:`<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0Z"/><path d="M12 8v8"/>`,
    humidity:`<path d="M12 3C8 8 6 11 6 15a6 6 0 0 0 12 0c0-4-2-7-6-12Z"/>`,
    sensor:`<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M8 9h8M8 12h8M8 15h5"/>`
  };
  return `<svg class="icon-svg sensor-${k}" viewBox="0 0 24 24" aria-hidden="true">${paths[k]}</svg>`;
}

function iconMarkup(d){
  if(d.domain==='sensor' || (d.domain==='binary_sensor' && !isWindowSensor(d) && !isLeakSensor(d))){ return sensorIconMarkup(d); }
  if(d.domain==='climate'){
    const k=climateKind(d);
    const paths={
      ac:`<path d="M5 7h14v6H5z"/><path d="M8 16c1.5 1.2 3 1.2 4.5 0M11.5 18c1.4 1.1 2.9 1.1 4.4 0"/><path d="M8 10h8"/>`,
      heater:`<rect x="5" y="6" width="14" height="12" rx="2"/><path d="M8 8v8M12 8v8M16 8v8"/><path d="M4 20h16"/>`,
      breezer:`<rect x="5" y="5" width="14" height="14" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 8v8M8 12h8"/>`
    };
    return `<svg class="icon-svg climate-${k}" viewBox="0 0 24 24" aria-hidden="true">${paths[k]}</svg>`;
  }
  if(d.domain==='cover'){
    const k=coverKind(d);
    const paths={
      roller:`<rect x="5" y="4" width="14" height="3" rx="1"/><path d="M7 7h10v10H7z"/><path d="M9 10h6M9 13h6"/>`,
      curtain:`<path d="M5 5h14"/><path d="M7 5c1.5 3 1.5 10 0 14M17 5c-1.5 3-1.5 10 0 14"/><path d="M12 5v14"/>`
    };
    return `<svg class="icon-svg cover-${k}" viewBox="0 0 24 24" aria-hidden="true">${paths[k]}</svg>`;
  }
  if(isWindowSensor(d)){
    const open=windowStateKind(d)==='open';
    return `<svg class="icon-svg window-${open?'open':'closed'}" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 12h16"/>${open?'<path d="M12 4l7 3v13"/>':''}</svg>`;
  }
  if(isLeakSensor(d)){
    return `<svg class="icon-svg leak-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C8 8 6 11 6 15a6 6 0 0 0 12 0c0-4-2-7-6-12Z"/><path d="M9 16a3 3 0 0 0 3 3"/></svg>`;
  }
  if(d.domain==='media_player'){
    return `<svg class="icon-svg media-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8v8h4l6 4V4L9 8H5z"/><path d="M18 9a4 4 0 0 1 0 6"/></svg>`;
  }
  if(d.domain==='light'){
    const k=lightKind(d);
    const paths={
      spot:`<circle cx="12" cy="9" r="4.5"/><path d="M9 15h6M10 18h4"/>`,
      chandelier:`<path d="M12 3v4M6 7h12M7 7c0 4 2 6 5 6s5-2 5-6"/><circle cx="8" cy="16" r="2"/><circle cx="12" cy="17" r="2"/><circle cx="16" cy="16" r="2"/>`,
      sconce:`<path d="M7 5v14M7 9h6c3 0 5 2 5 5v2H7"/><path d="M13 9v7"/>`,
      lamp:`<path d="M10 4h4l3 7H7l3-7Z"/><path d="M12 11v7M8 20h8"/>`,
      strip:`<rect x="5" y="7" width="14" height="10" rx="2"/><path d="M8 10h8M8 14h8"/>`,
      light:`<path d="M9 14a5 5 0 1 1 6 0c-.8.7-1 1.3-1 2h-4c0-.7-.2-1.3-1-2Z"/><path d="M10 19h4"/>`
    };
    return `<svg class="icon-svg light-${k}" viewBox="0 0 24 24" aria-hidden="true">${paths[k]||paths.light}</svg>`;
  }
  if(d.domain==='camera'){
    return `<svg class="icon-svg camera-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`;
  }
  return `<span class="emoji-icon">${esc(d.emoji || TYPE_ICONS[d.domain] || '•')}</span>`;
}
function iconFor(d){return d.emoji || TYPE_ICONS[d.domain] || '•'}
function displayName(d){ return state.layout?.customNames?.[d.entity_id] || d.panelName || d.name || d.label || friendlyEntityName(d.entity_id); }
function friendlyEntityName(entityId){ return String(entityId||'').split('.')[1]?.replace(/_/g,' ') || String(entityId||''); }
function canToggle(d){return TOGGLE_DOMAINS.has(d.domain)}
function canPrimaryAction(d){ return canToggle(d) || ['button','script','automation'].includes(d.domain); }
function primaryActionLabel(d,s=getState(d.entity_id)){
  if(d.domain==='button') return 'Нажать';
  if(d.domain==='script') return 'Запустить';
  if(d.domain==='automation') return String(s?.state||'').toLowerCase()==='on' ? 'Запустить' : 'Включить';
  if(d.domain==='valve') return isOn(d,s) ? 'Закрыть' : 'Открыть';
  return isOn(d,s) ? 'Выключить' : 'Включить';
}
function hasMoreFunctions(d){return ['light','climate','cover','media_player','fan','humidifier','switch','input_boolean','input_number','input_select','valve','button','script','automation'].includes(d.domain)}
function isDimmableLight(d){
  if(d.domain!=='light') return false;
  const a=getState(d.entity_id)?.attributes||{};
  const modes=Array.isArray(a.supported_color_modes)?a.supported_color_modes.join(' '):'';
  if('brightness' in a) return true;
  if(/brightness|color_temp|hs|rgb|xy|rgbw|rgbww/.test(modes)) return true;
  const sf=Number(a.supported_features||0);
  return !!sf;
}
function currentBrightnessPct(d){
  const b=Number(getState(d.entity_id)?.attributes?.brightness);
  if(Number.isFinite(b)) return Math.round(clamp(b/255,0,1)*100);
  return isOn(d)?100:50;
}

function formatSensorReading(value, digits, suffix=''){
  const n = Number(value);
  if(!Number.isFinite(n)) return '';
  const fixed = digits > 0 ? n.toFixed(digits) : String(Math.round(n));
  return fixed.replace('.', ',') + suffix;
}
function sensorReadingLabel(d){
  const s=getState(d.entity_id); if(!s || isUnavailable(d)) return '';
  const a=s.attributes||{};
  const kind=sensorKind(d);
  const unitRaw = a.unit_of_measurement ? String(a.unit_of_measurement).trim() : '';
  let suffix = unitRaw;
  if(!suffix && kind==='humidity') suffix='%';
  if(kind==='temperature' && (suffix==='°C' || suffix==='C')) suffix='°';
  if(kind==='temperature' && !suffix) suffix='°';
  if(kind==='illuminance' && !suffix) suffix=' lx';
  if(kind==='noise' && !suffix) suffix=' dB';
  if(kind==='co2' && !suffix) suffix=' ppm';
  const digits = kind==='temperature' ? 1 : 0;
  if(kind==='temperature' || kind==='humidity' || kind==='illuminance' || kind==='noise' || kind==='co2'){
    const formatted = formatSensorReading(s.state, digits, suffix);
    if(formatted) return formatted;
  }
  if(kind==='motion'){
    const raw=String(s.state ?? '').trim();
    const n=Number(raw.replace(',', '.'));
    if(Number.isFinite(n)) return unitRaw ? `${Number.isInteger(n)?String(n):raw.replace('.', ',')}${unitRaw}` : (Number.isInteger(n)?String(n):raw.replace('.', ','));
    return raw && raw!=='unknown' && raw!=='unavailable' ? raw : '';
  }
  if(unitRaw){
    const formatted = formatSensorReading(s.state, 0, unitRaw);
    if(formatted) return formatted;
  }
  return '';
}
function sensorRoomReadingLabel(d){
  const s=getState(d.entity_id); if(!s || isUnavailable(d)) return '';
  const kind=sensorKind(d);
  if(kind==='motion'){
    const raw=String(s.state ?? '').trim();
    if(!raw || raw==='unavailable' || raw==='unknown') return '';
    const unit=String(s.attributes?.unit_of_measurement || '').trim();
    const n=Number(raw.replace(',', '.'));
    if(Number.isFinite(n)){
      const value = Number.isInteger(n) ? String(n) : String(raw).replace('.', ',');
      return unit ? `${value}${unit}` : value;
    }
    const st=raw.toLowerCase();
    if(d.domain==='binary_sensor'){
      if(st==='on') return 'Есть движение';
      if(st==='off') return 'Нет движения';
    }
    return raw;
  }
  return sensorReadingLabel(d);
}
function isSensorLikeDevice(d){
  return d.domain==='sensor' || (d.domain==='binary_sensor' && !isWindowSensor(d) && !isLeakSensor(d));
}
function shouldRenderSensorTextMarker(d, scope){
  return scope==='room' && isSensorLikeDevice(d) && !!sensorRoomReadingLabel(d);
}
function markerValueLabel(d){
  const s=getState(d.entity_id); if(!s || isUnavailable(d)) return '';
  const a=s.attributes||{};
  if(d.domain==='light' && isOn(d,s) && isDimmableLight(d)){
    const pct=currentBrightnessPct(d);
    return pct>0 && pct<100 ? pct+'%' : '';
  }
  if(d.domain==='cover'){
    const pos=Number(a.current_position);
    if(Number.isFinite(pos) && pos>0 && pos<100) return Math.round(pos)+'%';
    return '';
  }
  if(d.domain==='climate'){
    const mode=climateMode(d);
    if(mode==='climate-heat' || mode==='climate-cool'){
      const temp=a.temperature ?? a.target_temp_high ?? a.target_temp_low;
      const n=Number(temp);
      return Number.isFinite(n) ? String(n).replace('.',',')+'°' : '';
    }
    return '';
  }
  if(d.domain==='fan'){
    const pct=Number(a.percentage);
    return Number.isFinite(pct) && pct>0 && pct<100 ? Math.round(pct)+'%' : '';
  }
  if(d.domain==='humidifier'){
    const hum=Number(a.humidity);
    return Number.isFinite(hum) ? Math.round(hum)+'%' : '';
  }
  if(d.domain==='input_number'){
    const n=Number(s.state);
    if(Number.isFinite(n)){
      const step=Number(a.step ?? 1);
      const digits = step && step < 1 ? 1 : 0;
      const unit = a.unit_of_measurement ? String(a.unit_of_measurement) : '';
      return n.toFixed(digits).replace('.', ',') + unit;
    }
    return String(s.state ?? '');
  }
  if(d.domain==='input_select'){
    return String(s.state ?? '');
  }
  if(d.domain==='sensor'){
    return sensorReadingLabel(d);
  }
  return '';
}
function markerValueHtml(d, scope='overview'){
  if(shouldRenderSensorTextMarker(d, scope)) return '';
  const v=markerValueLabel(d);
  return v?`<span class="marker-value">${esc(v)}</span>`:'';
}
function markerInnerHtml(d, scope='overview'){
  if(shouldRenderSensorTextMarker(d, scope)) return `<span class="sensor-room-icon">${iconMarkup(d)}</span><span class="sensor-room-value">${esc(sensorRoomReadingLabel(d))}</span>`;
  return `<span class="ico">${iconMarkup(d)}</span>${markerValueHtml(d, scope)}`;
}
function isOn(d,s=getState(d.entity_id)){const st=s?.state;if(!st)return false;if(['light','switch','input_boolean','fan','humidifier'].includes(d.domain))return st==='on';if(d.domain==='cover')return ['open','opening'].includes(st) || (Number(s?.attributes?.current_position)>0);if(d.domain==='media_player')return st==='playing';if(d.domain==='climate')return st!=='off'&&st!=='unavailable';if(d.domain==='lock')return st==='unlocked';if(d.domain==='valve')return st==='open';if(isWindowSensor(d))return windowStateKind(d)==='open';if(isLeakSensor(d))return leakStateKind(d)==='leak';return ['on','open','unlocked','playing'].includes(st)}
function brightnessLevel(d){
  const s=getState(d.entity_id); const b=Number(s?.attributes?.brightness);
  if(Number.isFinite(b)) return clamp(b/255,0.12,1);
  return isOn(d,s)?1:0;
}
function climateMode(d){
  const s=getState(d.entity_id); const st=String(s?.state||'').toLowerCase(); const action=String(s?.attributes?.hvac_action||'').toLowerCase();
  const mode = action && !['idle','off','unavailable','unknown'].includes(action) ? action : st;
  if(['off','unavailable','unknown'].includes(st) || !st) return 'climate-off';
  if(mode.includes('cool')) return 'climate-cool';
  if(mode.includes('heat')) return 'climate-heat';
  if(mode.includes('dry')) return 'climate-dry';
  if(mode.includes('fan') || mode.includes('vent')) return 'climate-fan';
  return isOn(d,s)?'climate-on':'climate-off';
}
function visualClass(d){
  if(isUnavailable(d)) return 'unavailable-visual';
  if(d.domain==='light') return 'light-visual '+(isOn(d)?'light-on':'light-off')+' light-kind-'+lightKind(d);
  if(d.domain==='switch') return 'switch-visual '+(isOn(d)?'switch-on':'switch-off');
  if(d.domain==='climate') return 'climate-visual '+climateMode(d)+' climate-kind-'+climateKind(d);
  if(d.domain==='cover') return 'cover-visual cover-'+coverKind(d)+' cover-state-'+coverStateKind(d);
  if(isWindowSensor(d)) return 'window-visual window-state-'+windowStateKind(d);
  if(isLeakSensor(d)) return 'leak-visual leak-state-'+leakStateKind(d);
  if(d.domain==='media_player') return 'media-visual media-state-'+mediaStateKind(d);
  if(d.domain==='input_number' || d.domain==='input_select') return 'input-value';
  return isOn(d)?'active':'inactive';
}
function haloMul(){ return clamp(Number(state.ui.haloScale ?? 0.50),0.25,1.25); }
function haloScale(v){ return 1 + (Number(v)-1)*haloMul(); }
function haloCss(alpha, scale){ return `--halo-alpha:${Number(alpha).toFixed(3)};--halo-scale:${haloScale(scale).toFixed(2)};`; }
function visualStyle(d){
  if(isUnavailable(d)) return haloCss(0.98,2.25);
  if(d.domain==='light'){
    const lvl=brightnessLevel(d);
    const alpha=isOn(d)?Math.min(1,(0.70+0.30*lvl)):0;
    const scale=isOn(d)?(2.10+0.45*lvl):1;
    return haloCss(alpha,scale);
  }
  if(d.domain==='switch') return isOn(d)?haloCss(0.98,2.28):'--halo-alpha:0;--halo-scale:1;';
  if(d.domain==='climate') return climateMode(d)==='climate-off'?'--halo-alpha:0;--halo-scale:1;':haloCss(0.92,2.20);
  if(d.domain==='cover') return coverStateKind(d)==='closed'?'--halo-alpha:0;--halo-scale:1;':haloCss(0.90,2.10);
  if(isWindowSensor(d)) return windowStateKind(d)==='open'?haloCss(0.90,2.05):'--halo-alpha:0;--halo-scale:1;';
  if(isLeakSensor(d)) return leakStateKind(d)==='leak'?haloCss(0.96,2.20):'--halo-alpha:0;--halo-scale:1;';
  return '';
}

function localizedRawState(raw){
  const st=String(raw??'').toLowerCase();
  return ({
    on:'включено', off:'выключено', open:'открыто', closed:'закрыто', opening:'открывается', closing:'закрывается',
    unlocked:'открыто', locked:'закрыто', locking:'закрывается', unlocking:'открывается',
    detected:'обнаружено', clear:'не обнаружено', dry:'не обнаружено', wet:'обнаружено', leak:'обнаружено',
    playing:'воспроизведение', paused:'пауза', idle:'ожидание', standby:'ожидание', stopped:'остановлено',
    unavailable:'недоступно', unknown:'неизвестно', home:'дома', not_home:'не дома', heat:'обогрев', cool:'охлаждение',
    auto:'авто', heat_cool:'авто', fan_only:'вентиляция', dry:'осушение'
  })[st] || String(raw??'');
}
function stateText(d){
  const s=getState(d.entity_id); if(!s)return 'нет данных';
  const st=String(s.state??'').toLowerCase();
  if(st==='unavailable')return 'недоступно';
  if(st==='unknown')return 'неизвестно';
  if(isLeakSensor(d)) return leakStateKind(d)==='leak'?'обнаружено':'не обнаружено';
  if(isWindowSensor(d)) return windowStateKind(d)==='open'?'открыто':'закрыто';
  if(d.domain==='cover'){
    const k=coverStateKind(d);
    return k==='open'?'открыто':k==='closed'?'закрыто':k==='partial'?'частично открыто':'недоступно';
  }
  if(d.domain==='valve') return isOn(d,s)?'открыто':'закрыто';
  if(d.domain==='lock') return isOn(d,s)?'открыто':'закрыто';
  if(['light','switch','input_boolean','fan','humidifier'].includes(d.domain)) return isOn(d,s)?'включено':'выключено';
  if(d.domain==='automation') return st==='on'?'включено':'выключено';
  if(d.domain==='media_player') return mediaStateKind(d)==='playing'?'воспроизведение':'остановлено';
  if(d.domain==='climate') return localizedRawState(st);
  if(d.domain==='binary_sensor') return st==='on'?'обнаружено':'не обнаружено';
  return localizedRawState(s.state);
}
function attentionStateText(rule, value){
  const d=allDevices().find(x=>x.entity_id===rule?.entity_id)||devices().find(x=>x.entity_id===rule?.entity_id)||{entity_id:rule?.entity_id,domain:String(rule?.entity_id||'').split('.')[0]};
  const fake={...d};
  const old=state.states[fake.entity_id];
  state.states[fake.entity_id]={...(old||{}), entity_id:fake.entity_id, state:String(value??'unknown')};
  const label=stateText(fake);
  if(old) state.states[fake.entity_id]=old; else delete state.states[fake.entity_id];
  return label;
}
function fmtNum(v, digits){const n=Number(v); return Number.isFinite(n)?n.toFixed(digits).replace('.',','):''}
function tempValue(entity){const s=getState(entity); return s?fmtNum(s.state,1):''}
function humValue(entity){const s=getState(entity); return s?String(Math.round(Number(s.state)||0)):''}
const STANDARD_SENSOR_DEFS = [
  { key:'temperature', label:'Температура', shortLabel:'Темп.', icon:'🌡', placeholder:'sensor.room_temperature', unitFallback:'°', domains:['sensor'] },
  { key:'humidity', label:'Влажность', shortLabel:'Вл.', icon:'💧', placeholder:'sensor.room_humidity', unitFallback:'%', domains:['sensor'] },
  { key:'motion', label:'Движение', shortLabel:'Движ.', icon:'🚶', placeholder:'binary_sensor.room_motion', unitFallback:'', domains:['binary_sensor','sensor'] },
  { key:'noise', label:'Шум', shortLabel:'Шум', icon:'🔊', placeholder:'sensor.room_noise', unitFallback:' dBA', domains:['sensor'] },
  { key:'co2', label:'CO2', shortLabel:'CO2', icon:'CO₂', placeholder:'sensor.room_co2', unitFallback:' ppm', domains:['sensor'] },
  { key:'illuminance', label:'Освещённость', shortLabel:'Свет', icon:'☀', placeholder:'sensor.room_illuminance', unitFallback:' lx', domains:['sensor'] }
];
function standardSensorsForRoom(roomId){
  const entry = state.roomsSettings?.rooms?.[normalizedRoomId(roomId)];
  if(entry && entry.standardSensors && typeof entry.standardSensors === 'object') return entry.standardSensors;
  return null;
}
function findClimateEntity(r, kind){
  const configured = standardSensorsForRoom(r.id);
  if(configured) return String(configured[kind] || '').trim();
  return '';
}
function standardSensorDisplayValue(key, entityId){
  const id=String(entityId||'').trim();
  if(!id) return '';
  const s=getState(id);
  if(!s || ['unknown','unavailable'].includes(String(s.state||'').toLowerCase())) return '';
  const unit=String(s.attributes?.unit_of_measurement || '').trim();
  const raw=String(s.state ?? '').trim();
  if(key==='motion'){
    if(String(s.state).toLowerCase()==='on') return 'есть';
    if(String(s.state).toLowerCase()==='off') return 'нет';
    return raw;
  }
  const n=Number(raw.replace(',', '.'));
  if(Number.isFinite(n)){
    const digits = key==='temperature' ? 1 : 0;
    let suffix = unit;
    if(key==='temperature' && (suffix==='°C' || suffix==='C')) suffix='°';
    if(key==='temperature' && !suffix) suffix='°';
    if(key==='humidity' && !suffix) suffix='%';
    if(key==='noise' && !suffix) suffix=' dB';
    if(key==='co2' && !suffix) suffix=' ppm';
    if(key==='illuminance' && !suffix) suffix=' lx';
    return formatSensorReading(n, digits, suffix);
  }
  return unit ? `${raw}${unit}` : raw;
}
function standardMetricItems(r){
  const configured = standardSensorsForRoom(r.id);
  if(!configured) return [];
  return STANDARD_SENSOR_DEFS.map(def=>({def, entityId:String(configured[def.key]||'').trim()}))
    .filter(x=>x.entityId)
    .map(x=>({...x, value:standardSensorDisplayValue(x.def.key, x.entityId)}))
    .filter(x=>x.value);
}
function showToast(msg){
  let t=el('toast');
  if(!t){t=document.createElement('div');t.id='toast';t.className='toast';document.body.appendChild(t)}
  t.textContent=msg; t.classList.add('show'); clearTimeout(showToast._timer); showToast._timer=setTimeout(()=>t.classList.remove('show'),2200);
}

function fitStage(kind){
  const stage = el(kind==='overview'?'overview-stage':'room-stage');
  const img = el(kind==='overview'?'overview-image':'room-image');
  const content = kind==='overview'?el('overview-content'):el('room-content');
  if(!stage||!img||!img.naturalWidth||!content)return;
  const pad = kind==='overview' ? 36 : 24;
  const sw=Math.max(0, stage.clientWidth-pad), sh=Math.max(0, stage.clientHeight-pad), ratio=img.naturalWidth/img.naturalHeight;
  let w=sw,h=w/ratio; if(h>sh){h=sh;w=h*ratio}
  content.style.width=w+'px'; content.style.height=h+'px';
  applyStageTransform(kind);
}

function renderNav(){
  const nav=el('room-nav'); nav.innerHTML='';
  ROOMS.forEach(r=>{const b=document.createElement('button'); b.className='room-btn'+(state.selectedRoom===r.id?' active':''); b.textContent=r.label; b.onclick=()=>selectRoom(r.id); nav.appendChild(b)})
}


function closePlacementEditor(){
  const modal=el('placement-editor-modal');
  if(modal) modal.classList.add('hidden');
  document.body.classList.remove('placement-editor-open');
  state.placementEditor=null;
  const sizeBox=el('placement-editor-size-controls'); if(sizeBox) sizeBox.classList.add('hidden');
  const zr=el('placement-editor-zone-rect'); if(zr) zr.classList.add('hidden');
  const pm=el('placement-editor-marker'); if(pm) pm.classList.remove('hidden');
}

function pauseLiveDashboard(){
  state.livePaused = true;
  if(state.pollTimer){ clearInterval(state.pollTimer); state.pollTimer=null; }
  document.body.classList.add('live-paused');
}
function resumeLiveDashboard(){
  state.livePaused = false;
  document.body.classList.remove('live-paused');
  startPolling();
  loadStates().catch(()=>{});
}
function cloneLayout(layout){ return JSON.parse(JSON.stringify(layout || {})); }

/* ── Undo / Redo ─────────────────────────────────────────────── */
function pushUndo(){
  if(!state.edit) return;
  state.undoStack.push(cloneLayout(state.layout));
  if(state.undoStack.length > 40) state.undoStack.shift();
  state.redoStack = [];
  updateUndoRedoButtons();
}
function doUndo(){
  if(!state.edit || !state.undoStack.length) return;
  state.redoStack.push(cloneLayout(state.layout));
  state.layout = state.undoStack.pop();
  setLayoutDirty(true);
  render();
  updateUndoRedoButtons();
  showToast('Отменено');
}
function doRedo(){
  if(!state.edit || !state.redoStack.length) return;
  state.undoStack.push(cloneLayout(state.layout));
  state.layout = state.redoStack.pop();
  setLayoutDirty(true);
  render();
  updateUndoRedoButtons();
  showToast('Повторено');
}
function updateUndoRedoButtons(){
  const u=el('btn-undo'), r=el('btn-redo');
  if(u){ u.classList.toggle('hidden',!state.edit); u.disabled=!state.undoStack.length; }
  if(r){ r.classList.toggle('hidden',!state.edit); r.disabled=!state.redoStack.length; }
}

/* ── Камера ──────────────────────────────────────────────────── */
function openCameraStream(d){
  const modal=el('camera-modal');
  const img=el('camera-stream-img');
  const title=el('camera-modal-title');
  const entityLabel=el('camera-modal-entity');
  if(!modal||!img) return;
  title.textContent=displayName(d);
  entityLabel.textContent=d.entity_id;
  img.dataset.entity=d.entity_id;
  img.alt='';
  img.src='';
  img.src=`api/camera/stream/${encodeURIComponent(d.entity_id)}?t=`+Date.now();
  img.onerror=()=>{ img.alt='Камера недоступна или стрим не поддерживается'; };
  modal.classList.remove('hidden');
}
function closeCameraModal(){
  const modal=el('camera-modal');
  if(modal) modal.classList.add('hidden');
  const img=el('camera-stream-img');
  if(img) img.src='';
}
function setLayoutDirty(value=true){
  state.layoutDirty=!!value;
  updateEditButtons();
}
function updateEditButtons(){
  const allowed = canEditLayout();
  const eb=el('edit-mode-badge'); if(eb){ eb.textContent=state.edit?(state.layoutDirty?'Редактирование · есть изменения':'Редактирование'):'Режим управления'; eb.className='edit-mode-badge '+(state.edit?'is-edit':'is-view'); }
  const editBtn=el('btn-edit'), saveBtn=el('btn-save-edit'), cancelBtn=el('btn-cancel-edit');
  if(editBtn) editBtn.classList.toggle('hidden', state.edit || !allowed);
  if(saveBtn){ saveBtn.classList.toggle('hidden', !state.edit || !allowed); saveBtn.disabled=false; saveBtn.textContent='Сохранить изменения'; }
  if(cancelBtn) cancelBtn.classList.toggle('hidden', !state.edit || !allowed);
  updateUndoRedoButtons();
  renderLayoutMaintenanceTools();
}
function enterEditMode(){
  if(!canEditLayout()){ showToast('Редактирование доступно только в admin mode'); updateEditButtons(); return; }
  state.stageGesture=null;
  pauseLiveDashboard();
  state.editSnapshot=cloneLayout(state.layout);
  state.selectedEdit=null;
  closePlacementEditor();
  state.edit=true;
  // On a touch overview screen the full 180+ device list is expensive and covers the map.
  // Start with both panels closed; the user opens Devices only when they need to place something.
  // v3.4.27: edit mode uses a dedicated lightweight Device Picker instead of the heavy live device panel.
  state.ui.hideDevicePanel=true;
  if(isMobilePanelMode()) state.ui.hideSidebar=true;
  setLayoutDirty(false);
  showToast('Режим редактирования: изменения применятся только после сохранения.');
  render();
}
async function saveEditChanges(){
  if(!state.edit) return;
  if(!state.layoutDirty){
    state.edit=false;
    state.stageGesture=null;
    state.editSnapshot=null;
    closePlacementEditor();
    resumeLiveDashboard();
    updateEditButtons();
    showToast('Изменений нет');
    render();
    return;
  }
  await saveLayout(true);
  state.edit=false;
  state.stageGesture=null;
  state.editSnapshot=null;
  state.selectedEdit=null;
  closePlacementEditor();
  resumeLiveDashboard();
  setLayoutDirty(false);
  showToast('Изменения сохранены');
  render();
}
function cancelEditChanges(){
  if(!state.edit) return;
  if(state.editSnapshot) state.layout=cloneLayout(state.editSnapshot);
  state.edit=false;
  state.stageGesture=null;
  state.editSnapshot=null;
  state.selectedEdit=null;
  closePlacementEditor();
  resumeLiveDashboard();
  setLayoutDirty(false);
  showToast('Изменения отменены');
  render();
}


function kioskNavigationMode(){
  const mode=String(state.ui.kioskNavigationMode || 'switchable');
  return ['maps','tiles','switchable'].includes(mode) ? mode : 'switchable';
}
function kioskEffectiveTileNavigation(){
  const mode=kioskNavigationMode();
  if(mode==='tiles') return true;
  if(mode==='maps') return false;
  return !!state.ui.kioskTileMode;
}
function kioskShouldShowSwitcher(){
  return state.ui.kioskMode && kioskNavigationMode()==='switchable';
}
function kioskRoomTilesActive(){
  return !!(state.ui.kioskMode && kioskEffectiveTileNavigation() && state.selectedRoom && state.selectedRoom!=='overview');
}

function pointInPolyPct(point, points){
  const pts=sanitizeZonePoints(points);
  if(!point || pts.length<3) return false;
  const x=Number(point.x), y=Number(point.y);
  if(!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let inside=false;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const xi=pts[i].x, yi=pts[i].y, xj=pts[j].x, yj=pts[j].y;
    const intersect=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi);
    if(intersect) inside=!inside;
  }
  return inside;
}
function polygonAreaPct(points){
  const pts=sanitizeZonePoints(points);
  if(pts.length<3) return 999999;
  let a=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++) a += (pts[j].x*pts[i].y - pts[i].x*pts[j].y);
  return Math.abs(a/2);
}
function roomIdFromOverviewMarkerPoint(point){
  const hits=[];
  (ROOMS||[]).filter(r=>r.id!=='overview').forEach(r0=>{
    const rid=normalizedRoomId(r0.id);
    const r=roomWithLayout(rid);
    if(!hasZoneShape(r)) return;
    const pts=zonePoints(r);
    if(pointInPolyPct(point, pts)) hits.push({rid, area:polygonAreaPct(pts)});
  });
  hits.sort((a,b)=>a.area-b.area);
  return hits[0]?.rid || '';
}
function kioskTileRoomIdForDevice(d){
  return normalizedRoomId(d?.__kioskTileRoom || effectiveDeviceRoomId(d) || d?.room || inferRoomIdFromDevice(d) || '__noroom') || '__noroom';
}
function groupDevicesByRoomForKioskTile(list){
  const byRoom=new Map();
  const seen=new Set();
  (list||[]).forEach(d=>{
    if(!d || seen.has(d.entity_id)) return;
    seen.add(d.entity_id);
    const rid=kioskTileRoomIdForDevice(d);
    if(!byRoom.has(rid)) byRoom.set(rid,[]);
    byRoom.get(rid).push(d);
  });
  const roomOrder=(ROOMS||[]).filter(r=>r.id!=='overview').map(r=>normalizedRoomId(r.id));
  const ids=[...roomOrder.filter(id=>byRoom.has(id)), ...[...byRoom.keys()].filter(id=>!roomOrder.includes(id)).sort((a,b)=>roomGroupLabel(a).localeCompare(roomGroupLabel(b),'ru'))];
  return ids.map(id=>({
    id,
    label:roomGroupLabel(id),
    items:(byRoom.get(id)||[]).slice().sort((a,b)=>displayName(a).localeCompare(displayName(b),'ru'))
  })).filter(g=>g.items.length);
}
function placedKioskTileDevices(){
  // Kiosk cards are no longer a separate overview dashboard. The main screen
  // remains the same overview map. In tile navigation mode a selected room is
  // opened as a readable card screen with all devices from that room.
  const rid=normalizedRoomId(state.selectedRoom||'overview');
  if(!rid || rid==='overview') return [];
  const list=devices().filter(d=>normalizedRoomId(effectiveDeviceRoomId(d) || d.room || inferRoomIdFromDevice(d))===rid && IMPORTANT_DOMAINS.has(d.domain));
  return [{id:rid, label:roomGroupLabel(rid), items:list.slice().sort((a,b)=>displayName(a).localeCompare(displayName(b),'ru'))}].filter(g=>g.items.length);
}
function kioskTileDeviceHtml(d){
  const st=stateText(d);
  const value=markerValueLabel(d)||st;
  const rid=kioskTileRoomIdForDevice(d);
  return `<button type="button" class="kiosk-tile-device device-card ${visualClass(d)}" style="${visualStyle(d)}" data-kiosk-tile-device="${esc(d.entity_id)}"><span class="kiosk-tile-icon dev-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</span><span class="kiosk-tile-text"><span class="kiosk-tile-name">${esc(displayName(d))}</span><span class="kiosk-tile-room-name">${esc(roomGroupLabel(rid))}</span></span><span class="kiosk-tile-state state">${esc(value)}</span></button>`;
}
function buildKioskTilePages(groups, cols, maxRows){
  const pages=[];
  let html='';
  let rows=0;
  const safeCols=Math.max(1, Number(cols)||1);
  const safeRows=Math.max(2, Number(maxRows)||6);
  const flush=()=>{
    if(html.trim()) pages.push(html);
    html='';
    rows=0;
  };
  const addHeader=(g)=>{
    if(rows >= safeRows) flush();
    html += `<h3 class="kiosk-tile-room">${esc(g.label)}</h3>`;
    rows += 1;
  };
  (groups||[]).forEach(g=>{
    const items=(g.items||[]);
    let idx=0;
    while(idx < items.length){
      if(!html.trim()) addHeader(g);
      // If there is no space for at least one device row after the header,
      // start a new page and repeat the room header there.
      if(rows >= safeRows){ flush(); addHeader(g); }
      const freeRows=Math.max(1, safeRows - rows);
      const canTake=Math.max(1, freeRows * safeCols);
      const chunk=items.slice(idx, idx + canTake);
      chunk.forEach(d=>{ html += kioskTileDeviceHtml(d); });
      rows += Math.ceil(chunk.length / safeCols);
      idx += chunk.length;
      if(idx < items.length) flush();
    }
    if(!items.length){
      if(!html.trim()) addHeader(g);
    }
  });
  flush();
  return pages.length ? pages : [''];
}
function renderKioskTiles(){
  const view=el('kiosk-tile-view');
  const pages=el('kiosk-tile-pages');
  const pager=el('kiosk-tile-pager');
  const active=kioskRoomTilesActive();
  if(view) view.classList.toggle('hidden', !active);
  document.body.classList.toggle('kiosk-tiles-active', active);
  const sw=el('kiosk-view-switcher'); if(sw) sw.classList.toggle('hidden', !kioskShouldShowSwitcher());
  const mapBtn=el('btn-kiosk-map-mode'); if(mapBtn) mapBtn.classList.toggle('active', !kioskEffectiveTileNavigation());
  const tileBtn=el('btn-kiosk-tile-mode'); if(tileBtn) tileBtn.classList.toggle('active', !!kioskEffectiveTileNavigation());
  if(!active || !pages) return;
  const groups=placedKioskTileDevices();
  const roomFilter=normalizedRoomId(state.kioskTileRoomFilter||'');
  const head=view?.querySelector('.kiosk-tile-head');
  if(head){
    head.innerHTML=`<div class="kiosk-tile-head-actions"><button type="button" class="kiosk-tile-home-btn" data-kiosk-overview-home="1">Общий план</button></div><h2>${esc(roomGroupLabel(state.selectedRoom))}</h2><p>Карточки устройств этой комнаты. “Общий план” возвращает на основную карту.</p>`;
  }
  if(!groups.length){ pages.innerHTML='<div class="kiosk-tile-empty">В этой комнате нет устройств для отображения. Проверьте источники Lovelace/HA Area или назначение комнаты.</div>'; if(pager) pager.innerHTML=''; return; }

  const totalDevices=groups.reduce((sum,g)=>sum+g.items.length,0);
  const vw=Math.max(320, window.innerWidth || 1280);
  const vh=Math.max(320, window.innerHeight || 720);
  const roomCount=groups.length;
  // The tile screen is a fixed kiosk dashboard. Keep it inside one viewport and
  // paginate by real grid rows instead of allowing browser scroll.
  const headerReserve = vw < 720 ? 94 : 82;
  const footerReserve = 26;
  const availableH=Math.max(220, vh - headerReserve - footerReserve);
  const availableW=Math.max(300, vw - 24);
  let cols=clamp(Math.floor(availableW / (vw < 720 ? 126 : 154)), vw<760?2:5, vw>1700?13:11);
  if(totalDevices>32 && vw>1200) cols=Math.min(vw>1700?14:12, cols+1);
  if(totalDevices>48 && vw>1400) cols=Math.min(15, cols+1);
  const gap = totalDevices>42 ? 3 : totalDevices>28 ? 4 : 5;
  const maxRowsByHeight=Math.max(2, Math.floor(availableH / (totalDevices>42 ? 46 : totalDevices>28 ? 52 : 60)));
  let maxRows=clamp(maxRowsByHeight, 3, 10);
  // Headers are real grid rows. If many rooms exist, force pagination sooner so
  // lower room sections do not disappear behind kiosk controls.
  if(roomCount > 7 && vh < 850) maxRows=Math.min(maxRows, 7);
  if(vh < 650) maxRows=Math.min(maxRows, 6);
  let tileH=Math.floor((availableH - ((maxRows-1)*gap)) / maxRows);
  tileH=clamp(tileH, 36, totalDevices>34 ? 54 : 66);
  const compact = tileH < 58 || totalDevices > 28 || roomCount > 5;
  const ultra = tileH < 46 || totalDevices > 44 || (roomCount > 8 && vh < 850);
  if(view){
    view.style.setProperty('--kt-cols', String(cols));
    view.style.setProperty('--kt-tile-h', `${tileH}px`);
    view.style.setProperty('--kt-gap', `${gap}px`);
    view.classList.toggle('kiosk-tiles-compact', compact);
    view.classList.toggle('kiosk-tiles-ultra', ultra);
    view.classList.toggle('kiosk-tiles-room-filter', !!(roomFilter && roomFilter!=='overview'));
  }
  const pageHtml=buildKioskTilePages(groups, cols, maxRows);
  state.kioskTilePage=clamp(Number(state.kioskTilePage||0),0,pageHtml.length-1);
  pages.innerHTML=pageHtml.map((h,i)=>`<div class="kiosk-tile-page ${i===state.kioskTilePage?'active':''}">${h}</div>`).join('');
  if(pager){
    pager.innerHTML=pageHtml.length>1 ? `<button type="button" id="btn-kiosk-tile-prev">‹</button><span>${state.kioskTilePage+1} / ${pageHtml.length}</span><button type="button" id="btn-kiosk-tile-next">›</button>` : '';
    const prev=el('btn-kiosk-tile-prev'); if(prev) prev.onclick=()=>{ state.kioskTilePage=(state.kioskTilePage+pageHtml.length-1)%pageHtml.length; render(); };
    const next=el('btn-kiosk-tile-next'); if(next) next.onclick=()=>{ state.kioskTilePage=(state.kioskTilePage+1)%pageHtml.length; render(); };
  }
  qsa('[data-kiosk-tile-device]', pages).forEach(btn=>{ const d=devices().find(x=>x.entity_id===btn.dataset.kioskTileDevice); if(d) attachPressActions(btn,d); });
}

function render(){
  if(!state.edit && state.placementEditor){
    closePlacementEditor();
  }
  document.body.classList.toggle('editing', state.edit);
  document.body.classList.toggle('viewing', !state.edit);
  document.body.classList.toggle('overview-editing', !!(state.edit && state.selectedRoom==='overview'));
  document.body.classList.toggle('overview-edit-lite', !!(state.edit && state.selectedRoom==='overview' && isMobilePanelMode()));
  const eb=el('edit-mode-badge'); if(eb){ eb.textContent=state.edit?(state.layoutDirty?'Редактирование · есть изменения':'Редактирование'):'Режим управления'; eb.className='edit-mode-badge '+(state.edit?'is-edit':'is-view'); }
  const be=el('btn-edit'); if(be){ be.classList.toggle('edit-active', state.edit); be.setAttribute('aria-pressed', String(state.edit)); }
  updateEditButtons();
  const isOverview = state.selectedRoom==='overview';
  const qbtn=el('btn-quick-overlay'); if(qbtn) qbtn.classList.toggle('hidden', isOverview);
  el('overview-view').classList.toggle('active', isOverview);
  el('room-view').classList.toggle('active', !isOverview);
  el('page-title').textContent = isOverview ? 'Общий план' : room(state.selectedRoom).label;
  el('page-subtitle').textContent = state.edit ? 'Лёгкий редактор: живые состояния, меню и анимации временно отключены' : (isOverview ? 'Тап по комнате открывает отдельный вид помещения' : 'Тап по устройству — действие, удержание — функции');
  renderNav();
  if(isOverview){ renderOverview(); } else { renderRoom(); }
  renderDevices();
  renderEditSheet();
  renderKioskWidget();
  renderKioskTiles();
  renderLevelSwitcher();
  renderProjectSetupEmptyPrompt();
  updateZoomControls();
  requestAnimationFrame(updateLiveCoordinateDebug);
}


function isProjectSetupEmpty(){
  const hasDevices = devices().length > 0;
  const roomsCount = (ROOMS || []).filter(r=>r.id && r.id!=='overview').length;
  const hasZones = (ROOMS || []).some(r=>r.id && r.id!=='overview' && hasZoneShape(roomWithLayout(r.id)));
  const hasSources = !!((state.levels?.levels||[]).some(l=>Number(l.status?.sourcesCount||0)>0 || l.sourcePaths));
  const hasCustomImage = !!(state.images?.overview?.custom || state.images?.overview?.exists || (state.levels?.levels||[]).some(l=>l.status?.hasOverviewImage));
  return !hasDevices && roomsCount===0 && !hasZones && !hasSources && !hasCustomImage;
}
function renderProjectSetupEmptyPrompt(){
  const box=el('project-setup-empty');
  if(!box) return;
  const show = !state.edit && !state.ui.kioskMode && canEditLayout() && isProjectSetupEmpty();
  box.classList.toggle('hidden', !show);
}

function renderOverview(){
  fitStage('overview');
  renderOverviewZones();
  renderOverviewMetrics();
  renderOverviewMarkers();
}
function renderOverviewZones(){
  const layer=el('overview-zones'); layer.innerHTML='';
  if(state.ui.showZones===false)return;
  ROOMS.filter(r=>r.id!=='overview').forEach(r0=>{
    const r=roomWithLayout(r0.id);
    if(!hasZoneShape(r)) return;
    const pts=zonePoints(r);
    const c=zoneCentroid(pts);
    const z=document.createElement('button');
    z.className='room-zone'+(hasZonePolygon(r)?' zone-polygon':'')+(isSelectedEdit('zone', r.id, 'overview')?' edit-selected':''); z.dataset.room=r.id;
    if(hasZonePolygon(r)){
      Object.assign(z.style,{left:'0%',top:'0%',width:'100%',height:'100%',transform:'none',clipPath:zoneClipPath(pts),borderRadius:'0'});
      z.style.setProperty('--zone-label-left', `${c.x}%`);
      z.style.setProperty('--zone-label-top', `${c.y}%`);
      z.style.setProperty('--zone-label-rotation', '0deg');
    } else {
      const angle=Number(r.a ?? r.angle ?? r.rotate ?? 0) || 0;
      Object.assign(z.style,{left:r.x+'%',top:r.y+'%',width:r.w+'%',height:r.h+'%',transform:`translate(-50%,-50%) rotate(${angle}deg)`});
      z.style.setProperty('--zone-label-rotation', `${-angle}deg`);
    }
    z.innerHTML=`<span class="zone-label">${esc(r.label)}</span>`;
    z.addEventListener('pointerdown', zoneDown);
    z.onclick=e=>{if(isKioskInputLocked()){showToast('Киоск заблокирован'); return;} if(state.edit||state.suppressClick){state.suppressClick=false;return} selectRoom(r.id)};
    layer.appendChild(z);
  });
}
function metricContent(r){
  const items = standardMetricItems(r);
  if(!items.length) return '';
  return items.map(({def,value})=>{
    const icon = def.icon || def.shortLabel || def.label;
    const aria = `${def.label}: ${value}`;
    return `<span class="metric-item metric-${esc(def.key)} compact-metric-item" title="${esc(aria)}" aria-label="${esc(aria)}"><span class="metric-icon" aria-hidden="true">${esc(icon)}</span><span class="metric-value">${esc(value)}</span></span>`;
  }).join(' ');
}
function defaultMetricPos(r){ if(!hasZoneRect(r)) return null; return {x:clamp(Number(r.x)-Number(r.w)/4,2,98),y:clamp(Number(r.y)-Number(r.h)/4,2,98)} }
function safeMetricPoint(stored, fallback){
  const x=Number(stored?.x), y=Number(stored?.y);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>100||y<0.5||y>100) return fallback;
  return {x:clamp(x,0,100), y:clamp(y,0,100)};
}
function renderOverviewMetrics(){
  const layer=el('overview-metrics'); layer.innerHTML=''; if(!el('toggle-sensors')?.checked)return;
  ROOMS.filter(r=>r.id!=='overview').forEach(r0=>{
    const r=roomWithLayout(r0.id); const html=metricContent(r); if(!html)return;
    const fallback=defaultMetricPos(r); if(!fallback) return;
    const p=safeMetricPoint(state.layout.overviewMetrics?.[r.id], fallback);
    const b=document.createElement('div'); b.className='badge'+(isSelectedEdit('overviewMetric', r.id, 'overview')?' edit-selected':''); b.dataset.kind='overviewMetric'; b.dataset.room=r.id; b.style.left=p.x+'%'; b.style.top=p.y+'%'; b.innerHTML=html;
    b.addEventListener('pointerdown', metricDown); layer.appendChild(b);
  })
}
function renderOverviewMarkers(){
  const layer=el('overview-markers'); layer.innerHTML=''; if(!el('toggle-devices').checked)return;
  Object.entries(state.layout.overviewMarkers||{}).forEach(([id,p])=>{
    const d=devices().find(x=>x.entity_id===id); if(!d)return;
    layer.appendChild(markerEl(d,p,'overview'));
  });
  requestAnimationFrame(updateLiveCoordinateDebug);
}
function renderRoom(){
  const r=room(state.selectedRoom); if(!r)return;
  const img=el('room-image');
  const afterRoomImageReady = ()=>{
    fitStage('room');
    if(migrateCurrentRoomCoordinateSpace()) return;
    renderRoomMetrics();
    renderRoomMarkers();
    renderQuickActions();
  };
  img.onload=afterRoomImageReady;
  const src = roomImageSrc(r.id);
  if(img.src !== new URL(src, location.href).href) img.src = src;
  else if(img.complete) afterRoomImageReady();
  el('room-title').textContent=r.label;
  el('room-climate-line').innerHTML=metricContent(r)||'<span class="muted">Нет назначенных стандартных датчиков комнаты</span>';
}
function renderRoomMetrics(){
  const layer=el('room-metrics'); layer.innerHTML=''; if(!el('toggle-sensors')?.checked)return; const r=room(state.selectedRoom); const html=metricContent(r); if(!html)return;
  const stored=safeMetricPoint(state.layout.roomMetrics?.[r.id], {x:16,y:16});
  const p=roomStoredToImagePos(r.id, stored);
  const b=document.createElement('div'); b.className='badge'+(isSelectedEdit('roomMetric', r.id, 'room')?' edit-selected':''); b.dataset.kind='roomMetric'; b.dataset.room=r.id; b.style.left=p.x+'%'; b.style.top=p.y+'%'; b.innerHTML=html;
  b.addEventListener('pointerdown', metricDown); layer.appendChild(b);
}
function renderRoomMarkers(){
  const layer=el('room-markers'); layer.innerHTML=''; if(!el('toggle-devices').checked)return;
  Object.entries(state.layout.roomMarkers?.[state.selectedRoom]||{}).forEach(([id,p])=>{
    const d=devices().find(x=>x.entity_id===id); if(!d)return;
    layer.appendChild(markerEl(d,p,'room'));
  });
  requestAnimationFrame(updateLiveCoordinateDebug);
}
function markerEl(d,p,scope){
  const renderPos = scope==='room' ? roomStoredToImagePos(state.selectedRoom, p) : p;
  const editSimple = !!state.edit;
  const isSensorAnchor = d.domain==='sensor' || d.domain==='binary_sensor' || shouldRenderSensorTextMarker(d, scope);
  const anchor=document.createElement('div');
  anchor.className='marker-anchor'+(isSensorAnchor?' sensor-anchor':'');
  anchor.dataset.entity=d.entity_id;
  anchor.dataset.scope=scope;
  anchor.style.left=clamp(Number(renderPos.x)||0,0,100)+'%';
  anchor.style.top=clamp(Number(renderPos.y)||0,0,100)+'%';

  const b=document.createElement('button');
  b.type='button';
  b.className='device-marker '+(editSimple?'edit-static':visualClass(d))+(shouldRenderSensorTextMarker(d, scope) && !editSimple?' text-marker sensor-readout':'')+(isSelectedEdit('marker', d.entity_id, scope)?' edit-selected':'');
  b.dataset.entity=d.entity_id; b.dataset.scope=scope; b.dataset.domain=d.domain||domainOf(d.entity_id); b.title=`${displayName(d)}\n${d.entity_id}`;
  if(!editSimple) b.style.cssText += visualStyle(d);
  b.innerHTML=editSimple?`<span class="edit-marker-icon">${iconMarkup(d)}</span>`:markerInnerHtml(d, scope);

  if(state.edit){
    attachEditMarkerActions(b,d,scope);
  } else {
    attachPressActions(b,d);
    b.addEventListener('contextmenu',e=>{
      e.preventDefault();
      openDeviceModal(d);
    });
  }
  anchor.appendChild(b);
  return anchor;
}
/* ── Точечное обновление маркера без пересоздания DOM ────────── */
function patchMarkerForEntity(entity_id){
  if(state.edit) return false;
  const d=devices().find(x=>x.entity_id===entity_id);
  if(!d) return false; // нет на плане
  let patched=false;
  qsa(`.marker-anchor[data-entity="${CSS.escape(entity_id)}"]`).forEach(anchor=>{
    const scope=anchor.dataset.scope||'overview';
    const btn=anchor.querySelector('.device-marker');
    if(!btn) return;
    const isSensor=shouldRenderSensorTextMarker(d, scope);
    btn.className='device-marker '+visualClass(d)+(isSensor?' text-marker sensor-readout':'');
    // Обновляем только CSS-переменные ореола — всё остальное в таблице стилей
    const vs=visualStyle(d);
    const am=vs.match(/--halo-alpha:([\d.]+)/);
    const sm=vs.match(/--halo-scale:([\d.]+)/);
    if(am) btn.style.setProperty('--halo-alpha',am[1]); else btn.style.removeProperty('--halo-alpha');
    if(sm) btn.style.setProperty('--halo-scale',sm[1]); else btn.style.removeProperty('--halo-scale');
    btn.innerHTML=markerInnerHtml(d, scope);
    btn.title=`${displayName(d)}\n${entity_id}`;
    patched=true;
  });
  // Обновляем строку метрик комнаты (стандартные датчики)
  if(state.selectedRoom!=='overview'){
    const rClimate=el('room-climate-line');
    const r=room(state.selectedRoom);
    if(rClimate && r){
      const html=metricContent(r);
      rClimate.innerHTML=html||'<span class="muted">Нет назначенных стандартных датчиков комнаты</span>';
    }
  }
  return patched;
}

function attachEditMarkerActions(b,d,scope){
  let timer=null, sx=0, sy=0, longFired=false;
  const clear=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
  b.addEventListener('pointerdown', e=>{
    if(e.button!==undefined && e.button!==0) return;
    e.stopPropagation();
    sx=e.clientX; sy=e.clientY; longFired=false;
    clear();
    timer=setTimeout(()=>{
      longFired=true;
      selectEditObject({kind:'marker', id:d.entity_id, scope, label:displayName(d)});
      openPlacementEditor(d.entity_id);
    },650);
  });
  b.addEventListener('pointermove', e=>{
    if(!timer) return;
    if(Math.hypot(e.clientX-sx,e.clientY-sy)>8) clear();
  });
  ['pointerup','pointercancel','pointerleave'].forEach(evt=>b.addEventListener(evt, clear));
  b.addEventListener('click', e=>{
    e.preventDefault(); e.stopPropagation();
    if(longFired){ longFired=false; return; }
    selectEditObject({kind:'marker', id:d.entity_id, scope, label:displayName(d)});
    showToast('Маркер выбран. Удерживайте его для перемещения через SVG Layout Editor.');
  });
}
function quickActionsHtml(list){
  return list.length?list.map(d=>`<button type="button" class="quick-action ${visualClass(d)}" style="${visualStyle(d)}" data-quick="${esc(d.entity_id)}"><span class="quick-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</span><span>${esc(displayName(d))}</span><span class="muted">${esc(markerValueLabel(d)||stateText(d))}</span></button>`).join(''):'<p class="muted">Нет быстрых действий</p>';
}
function bindQuickActions(container){
  qsa('[data-quick]',container).forEach(btn=>{const d=devices().find(x=>x.entity_id===btn.dataset.quick); if(d) attachPressActions(btn,d)});
}
function renderQuickActions(){
  if(state.edit){ const box=el('quick-actions'); if(box) box.innerHTML='<p class="muted">Быстрые действия отключены в режиме редактирования.</p>'; const over=el('quick-overlay-list'); if(over) over.innerHTML=''; return; }
  const list=roomDevices(state.selectedRoom).filter(d=>['light','switch','cover','climate','media_player','fan','humidifier','input_number','input_select','valve','button','script','automation'].includes(d.domain)).slice(0,24);
  const box=el('quick-actions'); if(box){ box.innerHTML=quickActionsHtml(list); bindQuickActions(box); }
  const over=el('quick-overlay-list'); if(over){ over.innerHTML=quickActionsHtml(list); bindQuickActions(over); }
}
function canEditDeviceInCurrentScope(d){
  if(!state.edit) return false;
  if(state.selectedRoom==='overview') return true;
  return normalizedRoomId(d.room)===normalizedRoomId(state.selectedRoom);
}
function deviceCardHtml(d, showAllInRoom=false){
  const sameRoom = state.selectedRoom==='overview' || normalizedRoomId(d.room)===normalizedRoomId(state.selectedRoom);
  const canPlace = canEditDeviceInCurrentScope(d);
  const roomLabel = ROOM_MAP[normalizedRoomId(d.room)]?.label || d.room || 'Без комнаты';
  const extra = showAllInRoom && !sameRoom ? ` · ${esc(roomLabel)}` : '';
  const title = canPlace ? `${d.entity_id}
Редактирование через SVG Layout Editor` : `${d.entity_id}
Устройство из другой комнаты. Перенос между комнатами отключён.`;
  return `<div class="device-card ${visualClass(d)} ${sameRoom?'':'out-room'}" style="${visualStyle(d)}" data-entity="${esc(d.entity_id)}" title="${esc(title)}"><div class="dev-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</div><div><div class="name">${esc(displayName(d))}</div><div class="meta">${esc(d.category||roomLabel||'')} · ${esc(d.domain)}${extra}</div></div><button class="state" data-toggle="${esc(d.entity_id)}">${esc(stateText(d))}</button></div>`;
}
function bindDeviceCards(list){
  qsa('.device-card',list).forEach(card=>{
    const d=devices().find(x=>x.entity_id===card.dataset.entity);
    if(state.edit){
      card.addEventListener('click', e=>{
        if(e.target.closest('button')) return;
        if(!d) return;
        e.preventDefault(); e.stopPropagation();
        openPlacementEditor(d.entity_id);
      });
    } else if(d){
      attachPressActions(card,d,{ignoreSelector:'button'});
    }
  });
  qsa('[data-toggle]',list).forEach(btn=>{const d=devices().find(x=>x.entity_id===btn.dataset.toggle); if(d && !state.edit) attachPressActions(btn,d)});
}

// Stable edit workflow: edit mode uses a lightweight picker and SVG Layout Editor, not the live map.
function devicePickerCardHtml(d){
  const rid=effectiveDeviceRoomId(d);
  const roomLabel = ROOM_MAP[normalizedRoomId(rid)]?.label || d.room || d.haArea?.name || 'Без комнаты';
  return `<button type="button" class="device-picker-item ${visualClass(d)}" data-picker-entity="${esc(d.entity_id)}" style="${visualStyle(d)}"><span class="dev-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</span><span class="device-picker-text"><b>${esc(displayName(d))}</b><small>${esc(roomLabel)} · ${esc(d.domain)} · ${esc(d.entity_id)}</small></span><span class="device-picker-select">Выбрать</span></button>`;
}
function currentPickerDevices(){
  const showAll = !!state.devicePickerShowAll;
  if(state.selectedRoom==='overview' || showAll) return devices();
  return roomDevices(state.selectedRoom);
}
function buildPickerGroups(filtered){
  const currentMarkers = markerMapForCurrentEditScope();
  const showAll = !!state.devicePickerShowAll;
  const visible = showAll ? filtered : filtered.filter(d=>!currentMarkers[d.entity_id]);
  const byRoom = new Map();
  visible.forEach(d=>{
    const rid = effectiveDeviceRoomId(d) || '__noroom';
    const groupId = (!rid || rid==='unassigned' || rid==='__noroom') ? '__unplaced' : rid;
    if(!byRoom.has(groupId)) byRoom.set(groupId, []);
    byRoom.get(groupId).push(d);
  });
  const ordered=[];
  const selectedRid=normalizedRoomId(state.selectedRoom);
  if(state.selectedRoom!=='overview'){
    const arr=byRoom.get(selectedRid);
    if(arr?.length) ordered.push({id:selectedRid,label:ROOM_MAP[selectedRid]?.label||selectedRid,items:arr});
  }
  ROOMS.forEach(r=>{
    const rid=normalizedRoomId(r.id);
    if(rid===selectedRid && state.selectedRoom!=='overview') return;
    const arr=byRoom.get(rid);
    if(arr?.length) ordered.push({id:rid,label:r.label,items:arr});
  });
  const noRoom=byRoom.get('__unplaced');
  if(noRoom?.length) ordered.push({id:'__unplaced',label:'Неразмещённые / без комнаты',items:noRoom});
  [...byRoom.entries()].filter(([rid])=>rid!=='__unplaced' && !ROOM_MAP[rid] && !(rid===selectedRid && state.selectedRoom!=='overview')).sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'ru')).forEach(([rid,arr])=>ordered.push({id:rid,label:roomGroupLabel(rid),items:arr}));
  return {ordered, visible};
}
function renderDevicePicker(){
  const list=el('device-picker-list'); if(!list) return;
  const q=(el('device-picker-search')?.value||'').toLowerCase().trim();
  const current=currentPickerDevices().filter(d=>IMPORTANT_DOMAINS.has(d.domain));
  const filtered=current.filter(d=>(displayName(d)+' '+d.entity_id+' '+(d.category||'')+' '+(ROOM_MAP[effectiveDeviceRoomId(d)]?.label||'')+' '+(ROOM_MAP[normalizedRoomId(d.room)]?.label||'')).toLowerCase().includes(q));
  const {ordered, visible}=buildPickerGroups(filtered);
  const selectedRid=normalizedRoomId(state.selectedRoom);
  if(state.selectedRoom!=='overview' && !state.openDevicePickerGroup && ordered.some(g=>g.id===selectedRid)) state.openDevicePickerGroup=selectedRid;
  if(state.openDevicePickerGroup && !ordered.some(g=>g.id===state.openDevicePickerGroup)) state.openDevicePickerGroup='';
  if(!state.openDevicePickerGroup && q && ordered.length===1) state.openDevicePickerGroup=ordered[0].id;
  const count=el('device-picker-count'); if(count) count.textContent=`${ordered.length} групп · ${visible.length} устройств`;
  const title=el('device-picker-title'); if(title) title.textContent=state.selectedRoom==='overview'?'Выбрать устройство для общего плана':`Выбрать устройство: ${room(state.selectedRoom)?.label||state.selectedRoom}`;
  const subtitle=el('device-picker-subtitle'); if(subtitle) subtitle.textContent='Тапните устройство: откроется SVG Layout Editor. Перетаскивание отключено.';
  if(!ordered.length){ list.innerHTML=`<p class="muted device-empty">Нет устройств для размещения. Включите “Показать уже размещённые” или измените поиск.</p>`; return; }
  list.innerHTML=`<div class="device-picker-groups">${ordered.map(g=>{
    const open=g.id===state.openDevicePickerGroup;
    const currentMarkers=markerMapForCurrentEditScope();
    const unp=g.items.filter(d=>!currentMarkers[d.entity_id]).length;
    const sub=state.devicePickerShowAll ? `${g.items.length} устройств${unp?`, ${unp} без маркера`:''}` : `${g.items.length} без маркера`;
    return `<section class="device-picker-group ${open?'open':''}"><button type="button" class="device-picker-group-head" data-picker-group="${esc(g.id)}"><span>${open?'▾':'▸'} ${esc(g.label)}</span><b>${esc(sub)}</b></button>${open?`<div class="device-picker-items">${g.items.map(devicePickerCardHtml).join('')}</div>`:''}</section>`;
  }).join('')}</div>`;
  qsa('[data-picker-group]',list).forEach(btn=>btn.onclick=()=>{state.openDevicePickerGroup=state.openDevicePickerGroup===btn.dataset.pickerGroup?'':btn.dataset.pickerGroup; renderDevicePicker();});
  qsa('[data-picker-entity]',list).forEach(btn=>btn.onclick=()=>{ const id=btn.dataset.pickerEntity; closeDevicePicker(); openDeviceLayoutEditor(id); });
}
function openDevicePicker(){
  if(!state.edit){ setPanelHidden('hideDevicePanel', false); return; }
  state.ui.hideDevicePanel=true;
  state.openDevicePickerGroup = state.selectedRoom==='overview' ? (state.openDevicePickerGroup||'') : normalizedRoomId(state.selectedRoom);
  const search=el('device-picker-search'); if(search) search.value='';
  const showAll=el('device-picker-show-all'); if(showAll) showAll.checked=!!state.devicePickerShowAll;
  const modal=el('device-picker-modal'); if(modal) modal.classList.remove('hidden');
  document.body.classList.add('device-picker-open');
  renderDevicePicker();
  setTimeout(()=>{try{search?.focus({preventScroll:true});}catch(_){ }},60);
}
function closeDevicePicker(){
  const modal=el('device-picker-modal'); if(modal) modal.classList.add('hidden');
  document.body.classList.remove('device-picker-open');
}
function toggleDeviceListOrPicker(){
  if(state.edit) openDevicePicker();
  else setPanelHidden('hideDevicePanel', !state.ui.hideDevicePanel);
}
function showDeviceListOrPicker(){
  if(state.edit) openDevicePicker();
  else setPanelHidden('hideDevicePanel', false);
}
function roomGroupLabel(roomId){
  if(roomId==='__unplaced') return 'Неразмещённые';
  if(roomId==='__noroom') return 'Без комнаты';
  return ROOM_MAP[normalizedRoomId(roomId)]?.label || roomId || 'Без комнаты';
}
const CLIENT_ROOM_PATTERNS = [
  [/гостин|living|зал|тв гост/i, 'living'],
  [/кухн|kitchen/i, 'kitchen'],
  [/левая.*спаль|спальня левая|left.*bedroom|bedroom1/i, 'bedroom1'],
  [/правая.*спаль|спальня правая|right.*bedroom|bedroom2/i, 'bedroom2'],
  [/кабинет|office/i, 'office'],
  [/гардер|wardrobe/i, 'wardrobe'],
  [/постир|котель|laundry|boiler/i, 'laundry'],
  [/основ.*сан|санузел основ|main.*bath/i, 'mainbath'],
  [/гост.*сан|guest.*bath/i, 'guestbath'],
  [/прихож|entrance/i, 'entrance'],
  [/коридор|corridor/i, 'corridor'],
  [/сантех|протеч|кран|plumb/i, 'plumbing'],
  [/систем|system/i, 'system']
];
function inferRoomIdFromDevice(d){
  const text=[displayName(d), d.name, d.panelName, d.label, d.cardTitle, d.category, d.entity_id].filter(Boolean).join(' ');
  for(const [re,rid] of CLIENT_ROOM_PATTERNS){ if(re.test(text)) return rid; }
  return '';
}
function effectiveDeviceRoomId(d){
  const direct=normalizedRoomId(d?.room);
  if(direct && direct!=='unassigned' && direct!=='__noroom'){
    if(direct==='media'){
      const inferred=inferRoomIdFromDevice(d);
      const haRoom=normalizedRoomId(d?.haArea?.room);
      return inferred || (haRoom && haRoom!=='unassigned' ? haRoom : '') || direct;
    }
    return direct;
  }
  const inferred=inferRoomIdFromDevice(d);
  if(inferred) return inferred;
  const haRoom=normalizedRoomId(d?.haArea?.room);
  if(haRoom && haRoom!=='unassigned') return haRoom;
  return direct || '__noroom';
}
function markerMapForCurrentEditScope(){
  if(state.selectedRoom==='overview') return state.layout.overviewMarkers || {};
  return (state.layout.roomMarkers||{})[normalizedRoomId(state.selectedRoom)] || {};
}
function renderEditDeviceGroups(list, filtered, q, current){
  const currentMarkers = markerMapForCurrentEditScope();
  const showAll = !!state.ui.showAllDevicesInRoom;

  // В edit mode не дублируем устройства между группой “Неразмещённые” и комнатами.
  // По умолчанию показываем только устройства без маркера в текущем scope;
  // если включена галочка “показывать все устройства” — показываем и уже размещённые.
  const visible = showAll ? filtered : filtered.filter(d=>!currentMarkers[d.entity_id]);
  const totalMissing = filtered.filter(d=>!currentMarkers[d.entity_id]).length;

  const byRoom = new Map();
  visible.forEach(d=>{
    const rid = effectiveDeviceRoomId(d) || '__noroom';
    const groupId = (!rid || rid==='unassigned' || rid==='__noroom') ? '__unplaced' : rid;
    if(!byRoom.has(groupId)) byRoom.set(groupId, []);
    byRoom.get(groupId).push(d);
  });

  const ordered = [];
  const selectedRid = normalizedRoomId(state.selectedRoom);

  if(state.selectedRoom!=='overview'){
    const currentRoomItems = byRoom.get(selectedRid);
    if(currentRoomItems?.length) ordered.push({id:selectedRid, label:ROOM_MAP[selectedRid]?.label || selectedRid, items:currentRoomItems});
  }

  ROOMS.forEach(r=>{
    const rid=normalizedRoomId(r.id);
    if(rid===selectedRid && state.selectedRoom!=='overview') return;
    const arr=byRoom.get(rid);
    if(arr?.length) ordered.push({id:rid, label:r.label, items:arr});
  });

  const noRoom = byRoom.get('__unplaced');
  if(noRoom?.length) ordered.push({id:'__unplaced', label:'Неразмещённые / без комнаты', items:noRoom});

  [...byRoom.entries()]
    .filter(([rid])=>rid!=='__unplaced' && !ROOM_MAP[rid] && !(rid===selectedRid && state.selectedRoom!=='overview'))
    .sort((a,b)=>String(a[0]).localeCompare(String(b[0]),'ru'))
    .forEach(([rid,arr])=>ordered.push({id:rid, label:roomGroupLabel(rid), items:arr}));

  if(!ordered.length){
    const msg = showAll ? 'Нет устройств по текущему фильтру' : 'Все устройства по текущему фильтру уже размещены. Включите “показывать все устройства”, чтобы увидеть размещённые.';
    list.innerHTML=`<p class="muted device-empty">${esc(msg)}</p>`;
    el('device-count').textContent=q ? `0 групп · ${filtered.length} найдено` : `0 к размещению · ${totalMissing} без маркера`;
    return;
  }

  if(state.openDeviceRoomGroup && !ordered.some(g=>g.id===state.openDeviceRoomGroup)) state.openDeviceRoomGroup='';
  if(state.selectedRoom!=='overview'){
    const selectedGroup = ordered.find(g=>g.id===selectedRid);
    if(!state.openDeviceRoomGroup && selectedGroup) state.openDeviceRoomGroup = selectedRid;
  }

  el('devices-title').textContent=state.selectedRoom==='overview' ? 'Добавить на общий план' : `Добавить в комнату: ${room(state.selectedRoom)?.label || state.selectedRoom}`;
  el('device-count').textContent=q
    ? `${ordered.length} групп · ${visible.length} показано · ${filtered.length} найдено`
    : `${ordered.length} групп · ${visible.length} показано · ${totalMissing} без маркера`;

  list.innerHTML = `<div class="device-groups edit-accordion">${ordered.map(g=>{
    const open = g.id===state.openDeviceRoomGroup;
    const placed = g.items.filter(d=>currentMarkers[d.entity_id]).length;
    const unp = g.items.length - placed;
    const limit = q ? 90 : 80;
    const items = open ? g.items.slice(0, limit).map(d=>deviceCardHtml(d, state.selectedRoom!=='overview')).join('') : '';
    const more = open && g.items.length > limit ? `<div class="device-group-more">Показано ${limit} из ${g.items.length}. Используйте поиск.</div>` : '';
    let sub = showAll ? `${g.items.length} устройств` : `${g.items.length} без маркера`;
    if(showAll && unp) sub += `, ${unp} без маркера`;
    return `<section class="device-group ${open?'open':''}" data-group="${esc(g.id)}"><button type="button" class="device-group-head" data-device-group="${esc(g.id)}"><span>${open?'▾':'▸'} ${esc(g.label)}</span><b>${esc(sub)}</b></button>${open?`<div class="device-group-items">${items}${more}</div>`:''}</section>`;
  }).join('')}</div>`;
  qsa('[data-device-group]',list).forEach(btn=>btn.onclick=()=>{
    state.openDeviceRoomGroup = state.openDeviceRoomGroup===btn.dataset.deviceGroup ? '' : btn.dataset.deviceGroup;
    renderDevices();
  });
  bindDeviceCards(list);
}
function renderDevices(){
  const list=el('device-list');
  const q=(el('device-search').value||'').toLowerCase();
  const editGrouped = !!state.edit;
  const showAllInRoom = state.selectedRoom!=='overview' && state.edit && !!state.ui.showAllDevicesInRoom;
  const current=editGrouped ? devices() : (state.selectedRoom==='overview'||showAllInRoom?devices():roomDevices(state.selectedRoom));
  let filtered=current
    .filter(d=>IMPORTANT_DOMAINS.has(d.domain))
    .filter(d=>(displayName(d)+' '+d.entity_id+' '+(d.category||'')+' '+(ROOM_MAP[effectiveDeviceRoomId(d)]?.label||'')+' '+(ROOM_MAP[normalizedRoomId(d.room)]?.label||'')).toLowerCase().includes(q));
  if(editGrouped){
    if(list){
      el('devices-title').textContent='Выбор устройства';
      el('device-count').textContent='открывается отдельным окном';
      list.innerHTML='<button type="button" class="open-picker-inline" onclick="openDevicePicker()">Выбрать устройство</button><p class="muted device-empty">В режиме редактирования список устройств открывается отдельным лёгким окном, чтобы карта и скролл не мерцали.</p>';
    }
    return;
  }
  let countSuffix = `${filtered.length} из ${current.length}`;
  el('devices-title').textContent=state.selectedRoom==='overview'?'Все устройства':(showAllInRoom?`Все устройства · ${room(state.selectedRoom).label}`:`Устройства: ${room(state.selectedRoom).label}`);
  el('device-count').textContent=countSuffix;
  list.innerHTML=filtered.map(d=>deviceCardHtml(d, showAllInRoom)).join('');
  bindDeviceCards(list);
}

function openDevice(d){ if(isKioskInputLocked()){showToast('Киоск заблокирован'); return;} openDeviceModal(d); }
function shortDeviceAction(d){ if(isKioskInputLocked()){showToast('Киоск заблокирован'); return;} if(d.domain==='camera'){ openCameraStream(d); return; } if(canPrimaryAction(d)) return toggleDevice(d); openDeviceModal(d); }
function attachPressActions(node,d,opts={}){
  let timer=null, longFired=false, sx=0, sy=0, pointerId=null;
  const cancelTimer=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
  node.addEventListener('pointerdown', e=>{
    if(opts.ignoreSelector && e.target.closest(opts.ignoreSelector)) return;
    if(state.edit) return;
    if(e.button !== undefined && e.button !== 0) return;
    pointerId=e.pointerId; sx=e.clientX; sy=e.clientY; longFired=false;
    try{ node.setPointerCapture(pointerId); }catch(_){}
    timer=setTimeout(()=>{ longFired=true; timer=null; openDeviceModal(d); }, LONG_PRESS_MS);
  }, {passive:false});
  node.addEventListener('pointermove', e=>{
    if(pointerId!==null && e.pointerId!==pointerId) return;
    if(timer && (Math.abs(e.clientX-sx)>GESTURE_MOVE_PX || Math.abs(e.clientY-sy)>GESTURE_MOVE_PX)) cancelTimer();
  }, {passive:false});
  node.addEventListener('pointercancel', e=>{ cancelTimer(); pointerId=null; longFired=false; });
  node.addEventListener('pointerup', e=>{
    if(pointerId!==null && e.pointerId!==pointerId) return;
    const moved=Math.abs(e.clientX-sx)>GESTURE_MOVE_PX || Math.abs(e.clientY-sy)>GESTURE_MOVE_PX;
    cancelTimer(); try{ node.releasePointerCapture(e.pointerId); }catch(_){} pointerId=null;
    if(longFired || moved){ e.preventDefault(); e.stopPropagation(); return; }
    if(state.edit || state.suppressClick){ state.suppressClick=false; return; }
    if(opts.ignoreSelector && e.target.closest(opts.ignoreSelector)) return;
    e.preventDefault(); e.stopPropagation(); shortDeviceAction(d);
  }, {passive:false});
  node.addEventListener('contextmenu', e=>{
    e.preventDefault();
    if(!state.edit) openDevice(d);
  });
}
function modalRow(label,value){return `<div class="device-modal-row"><span>${esc(label)}</span><b>${esc(value??'')}</b></div>`}
function domainControls(d){
  const s=getState(d.entity_id); const a=s?.attributes||{}; const rows=[];
  if(canPrimaryAction(d)) rows.push(`<div class="device-modal-actions"><button data-action="toggle">${primaryActionLabel(d,s)}</button></div>`);
  if(d.domain==='light'){
    if(isDimmableLight(d)) rows.push(`<label class="slider-row">Яркость <input type="range" min="1" max="100" value="${currentBrightnessPct(d)}" data-action="brightness"><span id="brightness-value">${currentBrightnessPct(d)}%</span></label>`);
  } else if(d.domain==='climate'){
    const modes=Array.isArray(a.hvac_modes)?a.hvac_modes:['off','heat','cool','fan_only'];
    rows.push(`<div class="device-modal-actions mode-grid">${modes.map(m=>`<button class="${String(s?.state)===m?'selected':''}" data-action="hvac" data-mode="${esc(m)}">${esc(modeLabel(m))}</button>`).join('')}</div>`);
    if(a.temperature!==undefined || a.current_temperature!==undefined){
      const min=Number(a.min_temp||16), max=Number(a.max_temp||30), val=Number(a.temperature||a.current_temperature||22);
      rows.push(`<label class="slider-row">Целевая температура <input type="range" min="${min}" max="${max}" step="0.5" value="${val}" data-action="target-temp"><span id="target-temp-value">${String(val).replace('.',',')}°</span></label>`);
    }
  } else if(d.domain==='cover'){
    rows.push(`<div class="device-modal-actions mode-grid"><button data-action="cover" data-service="open_cover">Открыть</button><button data-action="cover" data-service="stop_cover">Стоп</button><button data-action="cover" data-service="close_cover">Закрыть</button></div>`);
    if(a.current_position!==undefined) rows.push(`<label class="slider-row">Позиция <input type="range" min="0" max="100" value="${Number(a.current_position)||0}" data-action="cover-position"><span id="cover-position-value">${Number(a.current_position)||0}%</span></label>`);
  } else if(d.domain==='media_player'){
    rows.push(`<div class="device-modal-actions mode-grid"><button data-action="media" data-service="media_play_pause">Play/Pause</button><button data-action="media" data-service="volume_down">Тише</button><button data-action="media" data-service="volume_up">Громче</button></div>`);
  } else if(d.domain==='valve'){
    rows.push(`<div class="device-modal-actions mode-grid"><button data-action="valve" data-service="open_valve">Открыть</button><button data-action="valve" data-service="close_valve">Закрыть</button></div>`);
  } else if(d.domain==='button'){
    rows.push(`<p class="muted">Кнопка выполняет одноразовое действие через Home Assistant service <b>button.press</b>.</p>`);
  } else if(d.domain==='script'){
    rows.push(`<p class="muted">Скрипт запускается через <b>script.turn_on</b>.</p>`);
  } else if(d.domain==='automation'){
    rows.push(`<div class="device-modal-actions mode-grid"><button data-action="automation" data-service="trigger">Запустить</button><button data-action="automation" data-service="turn_on">Включить</button><button data-action="automation" data-service="turn_off">Выключить</button></div>`);
  } else if(d.domain==='input_number'){
    const min=Number(a.min ?? 0), max=Number(a.max ?? 100), step=Number(a.step ?? 1), val=Number(s?.state ?? min);
    const unit=esc(a.unit_of_measurement||'');
    rows.push(`<label class="slider-row">Значение <input type="range" min="${min}" max="${max}" step="${step}" value="${Number.isFinite(val)?val:min}" data-action="input-number"><span id="input-number-value">${String(Number.isFinite(val)?val:min).replace('.',',')}${unit}</span></label>`);
    rows.push(`<label class="slider-row">Точное значение <input type="number" min="${min}" max="${max}" step="${step}" value="${Number.isFinite(val)?val:min}" data-action="input-number-text"><span>${unit}</span></label>`);
  } else if(d.domain==='input_select'){
    const options=Array.isArray(a.options)?a.options:[];
    if(options.length) rows.push(`<label class="slider-row">Значение <select data-action="input-select">${options.map(o=>`<option value="${esc(o)}" ${String(s?.state)===String(o)?'selected':''}>${esc(o)}</option>`).join('')}</select></label>`);
  } else if(d.domain==='fan'){
    if(a.percentage!==undefined) rows.push(`<label class="slider-row">Скорость <input type="range" min="0" max="100" value="${Number(a.percentage)||0}" data-action="fan-percentage"><span id="fan-percentage-value">${Number(a.percentage)||0}%</span></label>`);
  }
  rows.push(`<details class="rename-box"><summary>Переименовать в этой системе</summary><label class="slider-row rename-row">Новое имя <input type="text" value="${esc(displayName(d))}" data-action="rename-local"><button type="button" data-action="rename-save">Сохранить имя</button></label><p class="muted">Имя меняется только здесь, Home Assistant не трогаем.</p></details>`);
  return rows.join('');
}
function modeLabel(m){return ({off:'Выкл',heat:'Обогрев',cool:'Охлаждение',heat_cool:'Авто',auto:'Авто',fan_only:'Вентиляция',dry:'Осушение'})[m]||m}
function openDeviceModal(d){
  const s=getState(d.entity_id); const a=s?.attributes||{};
  const modal=el('device-modal'); const body=el('device-modal-body');
  el('device-modal-title').textContent=displayName(d);
  body.innerHTML=`
    <div class="device-modal-top"><div class="device-modal-icon ${visualClass(d)}" style="${visualStyle(d)}">${iconMarkup(d)}</div><div><div class="device-modal-name">${esc(displayName(d))}</div><div class="muted">${esc(d.entity_id)}</div></div></div>
    ${modalRow('Состояние', stateText(d))}
    ${a.brightness!==undefined?modalRow('Яркость', Math.round(Number(a.brightness)/255*100)+'%'):''}
    ${a.current_temperature!==undefined?modalRow('Текущая температура', String(a.current_temperature).replace('.',',')+'°'):''}
    ${a.hvac_action?modalRow('Действие климата', a.hvac_action):''}
    ${a.current_position!==undefined?modalRow('Позиция', a.current_position+'%'):''}
    <div class="device-controls">${domainControls(d)}${dangerousSectionHtml(d)}${attentionSectionHtml(d)}</div>`;
  modal.classList.remove('hidden'); bindDeviceModalActions(d);
}
function closeDeviceModal(){el('device-modal').classList.add('hidden')}
async function requestPin(message='Введите PIN-код'){
  const pin=window.prompt(message+'\n4 цифры.','');
  if(pin===null) return null;
  return String(pin).trim();
}
async function callService(domain,service,data,opts={}){
  const payload={domain,service,data,confirmDangerous:!!opts.confirmDangerous};
  if(opts.pin) payload.pin=opts.pin;
  try{
    await apiJson('api/ha/service',{method:'POST',body:JSON.stringify(payload)});
    await loadStates();
  }catch(e){
    if(e.status===409 && e.data?.requiresPin){
      const pin=await requestPin(e.data.message || `Введите PIN для ${domain}.${service}`);
      if(pin){
        await callService(domain,service,data,{...opts,pin,confirmDangerous:!!opts.confirmDangerous});
        return;
      }
    }
    if(e.status===409 && e.data?.requiresConfirmation){
      const msg=e.data.message || `Подтвердить опасную команду ${domain}.${service}?`;
      if(window.confirm(msg)){
        await callService(domain,service,data,{...opts,confirmDangerous:true});
        return;
      }
    }
    throw e;
  }
}
function bindDeviceModalActions(d){
  const body=el('device-modal-body');
  qsa('[data-action]',body).forEach(ctrl=>{
    if(ctrl.type==='range'){
      ctrl.oninput=()=>{ const span=el(ctrl.dataset.action==='target-temp'?'target-temp-value':ctrl.dataset.action==='cover-position'?'cover-position-value':ctrl.dataset.action==='fan-percentage'?'fan-percentage-value':ctrl.dataset.action==='input-number'?'input-number-value':'brightness-value'); if(span){ const unit = ctrl.dataset.action==='target-temp' ? '°' : (ctrl.dataset.action==='input-number' ? (getState(d.entity_id)?.attributes?.unit_of_measurement || '') : '%'); span.textContent=String(ctrl.value).replace('.', ',')+unit; } };
      ctrl.onchange=async()=>{try{
        if(ctrl.dataset.action==='brightness') await callService('light','turn_on',{entity_id:d.entity_id,brightness_pct:Number(ctrl.value)});
        if(ctrl.dataset.action==='target-temp') await callService('climate','set_temperature',{entity_id:d.entity_id,temperature:Number(ctrl.value)});
        if(ctrl.dataset.action==='cover-position') await callService('cover','set_cover_position',{entity_id:d.entity_id,position:Number(ctrl.value)});
        if(ctrl.dataset.action==='fan-percentage') await callService('fan','set_percentage',{entity_id:d.entity_id,percentage:Number(ctrl.value)});
        if(ctrl.dataset.action==='input-number') await callService('input_number','set_value',{entity_id:d.entity_id,value:Number(ctrl.value)});
        openDeviceModal(d);
      }catch(e){showToast('Ошибка: '+e.message)}};
    } else {
      const runAction=async()=>{try{
        const action=ctrl.dataset.action;
        if(action==='attention-toggle'){ await toggleAttentionRule(d); return; }
        if(action==='dangerous-toggle'){ await toggleDangerousRule(d); return; }
        if(action==='rename-save'){ const input=body.querySelector('[data-action=\"rename-local\"]'); const name=(input?.value||'').trim(); if(!state.layout.customNames) state.layout.customNames={}; if(name) state.layout.customNames[d.entity_id]=name; else delete state.layout.customNames[d.entity_id]; await saveLayout(false); showToast('Имя сохранено'); render(); openDeviceModal(d); return; }
        if(action==='rename-local') return;
        if(action==='toggle') await toggleDevice(d);
        else if(action==='hvac') await callService('climate','set_hvac_mode',{entity_id:d.entity_id,hvac_mode:ctrl.dataset.mode});
        else if(action==='cover') await callService('cover',ctrl.dataset.service,{entity_id:d.entity_id});
        else if(action==='media') await callService('media_player',ctrl.dataset.service,{entity_id:d.entity_id});
        else if(action==='valve') await callService('valve',ctrl.dataset.service,{entity_id:d.entity_id});
        else if(action==='automation') await callService('automation',ctrl.dataset.service,{entity_id:d.entity_id});
        else if(action==='input-number-text') await callService('input_number','set_value',{entity_id:d.entity_id,value:Number(ctrl.value)});
        else if(action==='input-select') await callService('input_select','select_option',{entity_id:d.entity_id,option:ctrl.value});
        openDeviceModal(d);
      }catch(e){showToast('Ошибка: '+e.message)}};
      if(ctrl.tagName==='INPUT') ctrl.onchange=runAction; else ctrl.onclick=runAction;
    }
  });
}
function deviceRoomId(entityId){ const d=devices().find(x=>x.entity_id===entityId) || allDevices().find(x=>x.entity_id===entityId); return normalizedRoomId(d?.room || state.selectedRoom); }
function ensureRoomMarkerMap(roomId){ if(!state.layout.roomMarkers)state.layout.roomMarkers={};
  if(!state.layout.customNames)state.layout.customNames={}; if(!state.layout.roomMarkers[roomId])state.layout.roomMarkers[roomId]={}; return state.layout.roomMarkers[roomId]; }
function roomBounds(roomId){ const r=roomWithLayout(normalizedRoomId(roomId)); if(!r) return null; return {left:r.x-r.w/2, top:r.y-r.h/2, w:r.w, h:r.h}; }
function roomToOverviewPos(roomId,p){ const b=roomBounds(roomId); if(!b) return p; return {x:clamp(b.left + (Number(p.x)||0)/100*b.w,0,100), y:clamp(b.top + (Number(p.y)||0)/100*b.h,0,100)}; }
function overviewToRoomPos(roomId,p){ const b=roomBounds(roomId); if(!b) return p; return {x:clamp(((Number(p.x)||0)-b.left)/b.w*100,0,100), y:clamp(((Number(p.y)||0)-b.top)/b.h*100,0,100)}; }
function legacyCurrentRoomGeometryForMigrationOnly(){
  const stage = el('room-stage');
  const content = el('room-content');
  if(!stage || !content) return null;
  const stageRect = stage.getBoundingClientRect();
  const contentRect = content.getBoundingClientRect();
  if(!stageRect.width || !stageRect.height || !contentRect.width || !contentRect.height) return null;
  return {
    stageW: stageRect.width,
    stageH: stageRect.height,
    contentW: contentRect.width,
    contentH: contentRect.height,
    offsetX: contentRect.left - stageRect.left,
    offsetY: contentRect.top - stageRect.top
  };
}
function legacyStageToRoomContentPosForMigrationOnly(p){
  const g=legacyCurrentRoomGeometryForMigrationOnly(); if(!g) return p;
  const absX=(Number(p.x)||0)/100*g.stageW;
  const absY=(Number(p.y)||0)/100*g.stageH;
  const imagePos = {
    x: clamp((absX-g.offsetX)/g.contentW*100,0,100),
    y: clamp((absY-g.offsetY)/g.contentH*100,0,100)
  };
  return roomImageToStoredPos(state.selectedRoom, imagePos);
}
function migrateCurrentRoomCoordinateSpace(){
  const roomId=normalizedRoomId(state.selectedRoom);
  if(!roomId || roomId==='overview') return false;
  if(state.layout.coordinateSpace!=='legacy-stage') return false;
  if(state.layout.roomCoordinateMigrated?.[roomId]) return false;
  const map=state.layout.roomMarkers?.[roomId]||{};
  const metrics=state.layout.roomMetrics||{};
  let changed=false;
  for(const [eid,p] of Object.entries(map)){
    const np=legacyStageToRoomContentPosForMigrationOnly(p);
    state.layout.roomMarkers[roomId][eid]=np;
    changed=true;
  }
  if(metrics[roomId]){
    state.layout.roomMetrics[roomId]=legacyStageToRoomContentPosForMigrationOnly(metrics[roomId]);
    changed=true;
  }
  if(!state.layout.roomCoordinateMigrated) state.layout.roomCoordinateMigrated={};
  state.layout.roomCoordinateMigrated[roomId]=true;
  if(changed){
    saveLayout(false);
    renderRoomMetrics();
    renderRoomMarkers();
    renderQuickActions();
  }
  return changed;
}
function setMarkerPosition(entityId,scope,p){
  if(!state.layout.overviewMarkers)state.layout.overviewMarkers={};
  if(scope==='overview'){
    state.layout.overviewMarkers[entityId]=p;
  } else {
    const roomId=normalizedRoomId(state.selectedRoom);
    ensureRoomMarkerMap(roomId)[entityId]=p;
    if(!state.layout.roomCoordinateMigrated) state.layout.roomCoordinateMigrated={};
    state.layout.roomCoordinateMigrated[roomId]=true;
  }
}


function placementImageSrc(kind){
  if(kind==='overview') return el('overview-image')?.getAttribute('src') || overviewImageSrc();
  const r=room(state.selectedRoom);
  return el('room-image')?.getAttribute('src') || roomImageSrc(state.selectedRoom) || r?.image || '';
}
function existingMarkerEntriesForPlacement(kind){
  if(kind==='overview') return Object.entries(state.layout.overviewMarkers||{}).map(([id,p])=>({id,p}));
  const rid=normalizedRoomId(state.selectedRoom);
  return Object.entries(state.layout.roomMarkers?.[rid]||{}).map(([id,p])=>({id,p:roomStoredToImagePos(rid,p)}));
}
function placementEditorDims(){
  const pe=state.placementEditor || {};
  return {w: Number(pe.w)||100, h: Number(pe.h)||100};
}
function pctToPlacementSvgPoint(x,y){
  const d=placementEditorDims();
  return {x: clamp(Number(x)||0,0,100)/100*d.w, y: clamp(Number(y)||0,0,100)/100*d.h};
}
function placementSvgPointToPct(x,y){
  const d=placementEditorDims();
  return {x: clamp((Number(x)||0)/Math.max(1,d.w)*100,0,100), y: clamp((Number(y)||0)/Math.max(1,d.h)*100,0,100)};
}
function applyPlacementEditorViewBox(){
  const svg=el('placement-editor-svg'), img=el('placement-editor-image');
  if(!svg || !img || !state.placementEditor) return;
  const d=placementEditorDims();
  svg.setAttribute('viewBox',`0 0 ${d.w} ${d.h}`);
  svg.setAttribute('preserveAspectRatio','xMidYMid meet');
  img.setAttribute('x','0'); img.setAttribute('y','0');
  img.setAttribute('width',String(d.w)); img.setAttribute('height',String(d.h));
  img.setAttribute('preserveAspectRatio','none');
  svg.style.aspectRatio=`${d.w} / ${d.h}`;
  fitPlacementEditorSvg();
}
function fitPlacementEditorSvg(){
  const svg=el('placement-editor-svg');
  const wrap=svg?.closest('.placement-editor-canvas-wrap');
  if(!svg || !wrap || !state.placementEditor) return;
  const d=placementEditorDims();
  if(!d.w || !d.h) return;
  const rect=wrap.getBoundingClientRect();
  const padX=0, padY=0;
  const ww=Math.max(1, rect.width-padX);
  const wh=Math.max(1, rect.height-padY);
  const scale=Math.min(ww/d.w, wh/d.h);
  if(!Number.isFinite(scale) || scale<=0) return;
  const width=Math.max(1, Math.floor(d.w*scale));
  const height=Math.max(1, Math.floor(d.h*scale));
  svg.style.width=`${width}px`;
  svg.style.height=`${height}px`;
  svg.style.maxWidth='100%';
  svg.style.maxHeight='100%';
  updatePlacementDebug();
}
function refitPlacementEditorSoon(){
  if(!state.placementEditor) return;
  requestAnimationFrame(()=>{
    fitPlacementEditorSvg();
    requestAnimationFrame(()=>fitPlacementEditorSvg());
  });
}
function buildPlacementGrid(){
  const g=el('placement-editor-grid'); if(!g) return;
  const d=placementEditorDims();
  let html='';
  for(let i=0;i<=100;i+=5){
    const major=i%10===0;
    const x=i/100*d.w, y=i/100*d.h;
    html+=`<line class="${major?'major':''}" x1="${x}" x2="${x}" y1="0" y2="${d.h}"></line><line class="${major?'major':''}" y1="${y}" y2="${y}" x1="0" x2="${d.w}"></line>`;
  }
  const fs=Math.max(10, Math.min(d.w,d.h)*0.025);
  for(const i of [0,25,50,75,100]){
    const x=i/100*d.w, y=i/100*d.h;
    html+=`<text font-size="${fs}" x="${i===100?d.w-fs*2:x+fs*.35}" y="${fs*1.25}">${i}</text><text font-size="${fs}" x="${fs*.35}" y="${i===0?fs*1.25:i===100?d.h-fs*.5:y}">${i}</text>`;
  }
  g.innerHTML=html;
}
function updatePlacementEditorAspect(src){
  const svg=el('placement-editor-svg'); if(!svg || !state.placementEditor) return;
  const img=new Image();
  img.onload=()=>{
    const w=img.naturalWidth||100,h=img.naturalHeight||100;
    // v3.4.32: the editor uses the real image pixel coordinate space.
    // The UI still stores percentages, but SVG works in natural image units,
    // so the point applied to the live map round-trips without aspect distortion.
    state.placementEditor.w=w; state.placementEditor.h=h;
    applyPlacementEditorViewBox();
    buildPlacementGrid();
    renderPlacementEditorExisting();
    setPlacementEditorPoint(state.placementEditor.x, state.placementEditor.y);
    refitPlacementEditorSoon();
  };
  img.src=src;
}
function renderPlacementEditorExisting(){
  const layer=el('placement-editor-existing'); if(!layer || !state.placementEditor) return;
  const current=state.placementEditor.entityId;
  const d=placementEditorDims();
  const r=Math.max(3, Math.min(d.w,d.h)*0.009);
  layer.innerHTML=existingMarkerEntriesForPlacement(state.placementEditor.kind)
    .filter(x=>x.id!==current)
    .map(x=>{ const p=pctToPlacementSvgPoint(x.p?.x, x.p?.y); return `<circle cx="${p.x}" cy="${p.y}" r="${r}"><title>${esc(x.id)}</title></circle>`; }).join('');
  renderPlacementEditorExistingZones();
}
function svgPointsAttr(points){ return sanitizeZonePoints(points).map(p=>{const q=pctToPlacementSvgPoint(p.x,p.y); return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;}).join(' '); }
function renderPlacementEditorExistingZones(){
  const layer=el('placement-editor-existing-zones'); if(!layer || !state.placementEditor) return;
  // v3.5.9.4: existing room zones are an overlay only for the zone editor.
  // When placing/moving a device inside a room, showing all overview zones makes the
  // room placement grid unreadable and can be mistaken for editable room geometry.
  if(state.placementEditor.targetType !== 'zone'){
    layer.innerHTML='';
    return;
  }
  const current=normalizedRoomId(state.placementEditor.zoneRoomId||'');
  const rows=[];
  for(const r0 of ROOMS.filter(r=>r.id!=='overview')){
    const rid=normalizedRoomId(r0.id);
    const r=roomWithLayout(rid);
    if(!hasZoneShape(r)) continue;
    const pts=zonePoints(r);
    const c=pctToPlacementSvgPoint(zoneCentroid(pts).x, zoneCentroid(pts).y);
    const cls=rid===current?'current':'';
    rows.push(`<polygon class="${cls}" data-zone-room="${esc(rid)}" points="${svgPointsAttr(pts)}"><title>${esc(r.label||rid)}</title></polygon><text class="${cls}" data-zone-room-label="${esc(rid)}" x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}">${esc(r.label||rid)}</text>`);
  }
  layer.innerHTML=rows.join('');
}
function updatePlacementEditorZoneLabels(){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const rid=normalizedRoomId(state.placementEditor.zoneRoomId);
  const r=room(rid);
  const dev=el('placement-editor-device'); if(dev) dev.textContent=`Зона: ${r?.label||rid}`;
  const scope=el('placement-editor-scope'); if(scope) scope.textContent='Общий план · выберите существующую зону или обведите новую';
}
function selectPlacementEditorZone(roomId){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const rid=normalizedRoomId(roomId);
  const r=roomWithLayout(rid);
  if(!r) return;
  const pts=hasZoneShape(r) ? zonePoints(r) : [];
  const b=pts.length ? zoneBounds(pts) : {x:50,y:50,w:1,h:1};
  Object.assign(state.placementEditor,{zoneRoomId:rid,x:b.x,y:b.y,wPct:b.w,hPct:b.h,points:pts,drawing:false});
  setPlacementEditorPoint(b.x,b.y);
  renderZoneDrawPath();
  renderPlacementEditorExistingZones();
  updatePlacementEditorZoneLabels();
  showToast('Выбрана зона: '+(room(rid)?.label||rid));
}
function renderZoneDrawPath(){
  const path=el('placement-editor-zone-draw'); if(!path || !state.placementEditor) return;
  const pts=sanitizeZonePoints(state.placementEditor.points);
  if(!pts.length){ path.setAttribute('points',''); path.classList.add('hidden'); return; }
  path.setAttribute('points', svgPointsAttr(pts));
  path.classList.remove('hidden');
  path.classList.toggle('closed', pts.length>=3 && !state.placementEditor.drawing);
}
function addZoneDrawPoint(p, force=false){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const pts=state.placementEditor.points || [];
  const last=pts[pts.length-1];
  if(!force && last && dist(last,p)<0.65) return;
  pts.push({x:clamp(p.x,0,100), y:clamp(p.y,0,100)});
  state.placementEditor.points=pts;
  const b=zoneBounds(pts.length>=3?pts:[...pts,{x:p.x+1,y:p.y+1}]);
  state.placementEditor.x=b.x; state.placementEditor.y=b.y; state.placementEditor.wPct=b.w; state.placementEditor.hPct=b.h;
  renderZoneDrawPath();
  renderPlacementEditorZoneRect();
  updatePlacementDebug();
}
function clearZoneDraw(){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  state.placementEditor.points=[];
  renderZoneDrawPath();
  showToast('Обводка очищена');
}
function setPlacementEditorPoint(x,y){
  if(!state.placementEditor) return;
  const isZone=state.placementEditor.targetType==='zone';
  const w=isZone ? clamp(Number(state.placementEditor.wPct)||10,1,100) : 0;
  const h=isZone ? clamp(Number(state.placementEditor.hPct)||10,1,100) : 0;
  state.placementEditor.x=clamp(Number(x)||0,isZone?w/2:0,isZone?100-w/2:100);
  state.placementEditor.y=clamp(Number(y)||0,isZone?h/2:0,isZone?100-h/2:100);
  const d=placementEditorDims();
  const p=pctToPlacementSvgPoint(state.placementEditor.x,state.placementEditor.y);
  const m=el('placement-editor-marker'), hl=el('placement-editor-hline'), vl=el('placement-editor-vline');
  const r=Math.max(5, Math.min(d.w,d.h)*0.018);
  if(m){ m.setAttribute('cx',p.x); m.setAttribute('cy',p.y); m.setAttribute('r',String(r)); }
  if(hl){ hl.setAttribute('x1','0'); hl.setAttribute('x2',String(d.w)); hl.setAttribute('y1',p.y); hl.setAttribute('y2',p.y); }
  if(vl){ vl.setAttribute('y1','0'); vl.setAttribute('y2',String(d.h)); vl.setAttribute('x1',p.x); vl.setAttribute('x2',p.x); }
  const xi=el('placement-editor-x'), yi=el('placement-editor-y');
  if(xi) xi.value=state.placementEditor.x.toFixed(1);
  if(yi) yi.value=state.placementEditor.y.toFixed(1);
  renderPlacementEditorZoneRect();
  updatePlacementDebug();
}
function setZoneEditorSize(w,h){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const x=clamp(Number(state.placementEditor.x)||50,0,100);
  const y=clamp(Number(state.placementEditor.y)||50,0,100);
  const maxW=Math.max(1, 2*Math.min(x,100-x));
  const maxH=Math.max(1, 2*Math.min(y,100-y));
  state.placementEditor.wPct=clamp(Number(w)||1,1,maxW);
  state.placementEditor.hPct=clamp(Number(h)||1,1,maxH);
  setPlacementEditorPoint(x,y);
  renderPlacementEditorZoneRect();
  const wi=el('placement-editor-w'), hi=el('placement-editor-h');
  if(wi) wi.value=state.placementEditor.wPct.toFixed(1);
  if(hi) hi.value=state.placementEditor.hPct.toFixed(1);
  updatePlacementDebug();
}
function renderPlacementEditorZoneRect(){
  const z=el('placement-editor-zone-rect');
  const m=el('placement-editor-marker'), hl=el('placement-editor-hline'), vl=el('placement-editor-vline');
  if(!z || !state.placementEditor) return;
  const isZone=state.placementEditor.targetType==='zone';
  // v3.5.9.2: freehand zone editor must not show the old rectangle fallback.
  // Empty zone = no shape until the user draws or selects an existing polygon.
  z.classList.toggle('hidden', true);
  if(m) m.classList.toggle('hidden', isZone);
  if(hl) hl.classList.toggle('hidden', false);
  if(vl) vl.classList.toggle('hidden', false);
  if(!isZone) return;
  const d=placementEditorDims();
  const x=clamp(Number(state.placementEditor.x)||50,0,100);
  const y=clamp(Number(state.placementEditor.y)||50,0,100);
  const w=clamp(Number(state.placementEditor.wPct)||10,1,100);
  const h=clamp(Number(state.placementEditor.hPct)||10,1,100);
  const angle=Number(state.placementEditor.angleDeg ?? state.placementEditor.a ?? 0) || 0;
  const p=pctToPlacementSvgPoint(x,y);
  const rw=w/100*d.w, rh=h/100*d.h;
  z.setAttribute('x',String(p.x-rw/2));
  z.setAttribute('y',String(p.y-rh/2));
  z.setAttribute('width',String(rw));
  z.setAttribute('height',String(rh));
  z.setAttribute('transform',`rotate(${angle} ${p.x} ${p.y})`);
}
function nudgeZoneEditorSize(dw,dh){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const step=Number(el('placement-editor-step')?.value||0.5);
  setZoneEditorSize((state.placementEditor.wPct||10)+dw*step,(state.placementEditor.hPct||10)+dh*step);
}
function setZoneEditorAngle(a){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  let v=Number(a)||0;
  v=((v%360)+360)%360;
  if(v>180) v-=360;
  state.placementEditor.angleDeg=v;
  const ai=el('placement-editor-angle'); if(ai) ai.value=v.toFixed(0);
  renderPlacementEditorZoneRect();
  updatePlacementDebug();
}
function nudgeZoneEditorAngle(dir){
  if(!state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const step=Math.max(1, Number(el('placement-editor-angle-step')?.value||5));
  setZoneEditorAngle((Number(state.placementEditor.angleDeg)||0)+dir*step);
}
function placementEditorImageMetrics(){
  const svg=el('placement-editor-svg');
  if(!svg) return null;
  const rect=svg.getBoundingClientRect();
  if(!rect.width || !rect.height) return null;
  const d=placementEditorDims();
  if(!d.w || !d.h) return null;
  // v3.4.38: do not use getScreenCTM() for pointer coordinates.
  // In Chromium/WebView, getScreenCTM() may be wrong when an ancestor has
  // overflow:auto scroll or when the SVG is letterboxed by xMidYMid meet.
  // getBoundingClientRect() is viewport-relative and already includes ancestor
  // scrolling, so we manually map the visible image rectangle to 0..100%.
  const scale=Math.min(rect.width/d.w, rect.height/d.h);
  const imgW=d.w*scale, imgH=d.h*scale;
  const offsetX=(rect.width-imgW)/2, offsetY=(rect.height-imgH)/2;
  return {rect,d,scale,imgW,imgH,offsetX,offsetY};
}
function updatePlacementDebug(extra){
  const box=el('placement-editor-debug');
  if(!box || !state.placementEditor || !state.ui.debugMode) return;
  const m=placementEditorImageMetrics();
  const wrap=el('placement-editor-svg')?.closest('.placement-editor-canvas-wrap');
  const pe=state.placementEditor;
  const lines=[];
  lines.push(`scope: ${pe.kind} | entity: ${pe.entityId||''}`);
  lines.push(`saved/edit x/y: ${Number(pe.x||0).toFixed(2)}%, ${Number(pe.y||0).toFixed(2)}%`);
  if(m){
    lines.push(`natural: ${Math.round(m.d.w)} × ${Math.round(m.d.h)}`);
    lines.push(`svg rect: ${Math.round(m.rect.width)} × ${Math.round(m.rect.height)} @ ${Math.round(m.rect.left)},${Math.round(m.rect.top)}`);
    lines.push(`image rect: ${Math.round(m.imgW)} × ${Math.round(m.imgH)} offset ${m.offsetX.toFixed(1)},${m.offsetY.toFixed(1)}`);
    lines.push(`scale: ${m.scale.toFixed(5)}`);
  }
  if(wrap){
    lines.push(`wrap scroll: ${Math.round(wrap.scrollLeft||0)}, ${Math.round(wrap.scrollTop||0)}`);
  }
  if(extra){
    if(extra.clientX!=null) lines.push(`event client: ${Math.round(extra.clientX)}, ${Math.round(extra.clientY)}`);
    if(extra.rawX!=null) lines.push(`raw x/y: ${extra.rawX.toFixed(2)}%, ${extra.rawY.toFixed(2)}%`);
    if(extra.clampedX!=null) lines.push(`clamped x/y: ${extra.clampedX.toFixed(2)}%, ${extra.clampedY.toFixed(2)}%`);
  }
  box.textContent=lines.join('\n');
}
function liveMarkerElement(entityId, scope){
  return qsa('.device-marker').find(n=>n.dataset.entity===entityId && n.dataset.scope===scope) || null;
}
function liveCoordinateMetrics(entityId, scope){
  const kind = scope==='overview' ? 'overview' : 'room';
  const img = el(kind==='overview'?'overview-image':'room-image');
  const stage = el(kind==='overview'?'overview-stage':'room-stage');
  const content = el(kind==='overview'?'overview-content':'room-content');
  const layer = el(kind==='overview'?'overview-markers':'room-markers');
  const marker = liveMarkerElement(entityId, scope);
  const stored = scope==='overview'
    ? state.layout.overviewMarkers?.[entityId]
    : state.layout.roomMarkers?.[normalizedRoomId(state.selectedRoom)]?.[entityId];
  const renderPos = stored ? (scope==='room' ? roomStoredToImagePos(state.selectedRoom, stored) : stored) : null;
  const imgRect = img?.getBoundingClientRect?.();
  const stageRect = stage?.getBoundingClientRect?.();
  const contentRect = content?.getBoundingClientRect?.();
  const layerRect = layer?.getBoundingClientRect?.();
  const markerRect = marker?.getBoundingClientRect?.();
  let expectedFromLayer=null, expectedFromImage=null, actualCenter=null;
  if(renderPos && layerRect?.width && layerRect?.height){
    expectedFromLayer={x:layerRect.left+layerRect.width*renderPos.x/100, y:layerRect.top+layerRect.height*renderPos.y/100};
  }
  if(renderPos && imgRect?.width && imgRect?.height){
    expectedFromImage={x:imgRect.left+imgRect.width*renderPos.x/100, y:imgRect.top+imgRect.height*renderPos.y/100};
  }
  if(markerRect?.width || markerRect?.height){
    actualCenter={x:markerRect.left+markerRect.width/2, y:markerRect.top+markerRect.height/2};
  }
  const diffLayer = expectedFromLayer && actualCenter ? {x:actualCenter.x-expectedFromLayer.x, y:actualCenter.y-expectedFromLayer.y} : null;
  const diffImage = expectedFromImage && actualCenter ? {x:actualCenter.x-expectedFromImage.x, y:actualCenter.y-expectedFromImage.y} : null;
  return {kind, img, stage, content, layer, marker, stored, renderPos, imgRect, stageRect, contentRect, layerRect, markerRect, expectedFromLayer, expectedFromImage, actualCenter, diffLayer, diffImage};
}
function rectLine(name,r){
  if(!r) return `${name}: —`;
  return `${name}: ${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`;
}
function pointLine(name,p){
  if(!p) return `${name}: —`;
  return `${name}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`;
}
function updateLiveCoordinateDebug(){
  const panel=el('live-coordinate-debug-panel'), box=el('live-coordinate-debug');
  if(!panel || !box) return;
  if(!state.ui.debugMode){ panel.classList.add('hidden'); box.textContent='—'; return; }
  const sel=state.selectedEdit;
  if(!state.edit || !sel || sel.kind!=='marker'){
    panel.classList.add('hidden');
    box.textContent='—';
    return;
  }
  const m=liveCoordinateMetrics(sel.id, sel.scope||activeStageKind());
  panel.classList.remove('hidden');
  const v=getViewport(m.kind);
  const hardware=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5);
  const lines=[];
  lines.push(`scope: ${sel.scope} | entity: ${sel.id}`);
  lines.push(`selected label: ${sel.label||''}`);
  lines.push(`stored x/y: ${m.stored ? `${Number(m.stored.x).toFixed(2)}%, ${Number(m.stored.y).toFixed(2)}%` : '—'}`);
  lines.push(`render x/y: ${m.renderPos ? `${Number(m.renderPos.x).toFixed(2)}%, ${Number(m.renderPos.y).toFixed(2)}%` : '—'}`);
  lines.push(`viewport zoom/pan/hw: ${Number(v?.zoom||1).toFixed(3)} / ${Math.round(v?.panX||0)},${Math.round(v?.panY||0)} / ${hardware.toFixed(2)}`);
  lines.push(rectLine('stageRect', m.stageRect));
  lines.push(rectLine('contentRect', m.contentRect));
  lines.push(rectLine('imageRect', m.imgRect));
  lines.push(rectLine('markerLayerRect', m.layerRect));
  lines.push(rectLine('markerRect', m.markerRect));
  lines.push(pointLine('expected from image', m.expectedFromImage));
  lines.push(pointLine('expected from layer', m.expectedFromLayer));
  lines.push(pointLine('actual marker center', m.actualCenter));
  lines.push(pointLine('actual - image', m.diffImage));
  lines.push(pointLine('actual - layer', m.diffLayer));
  if(m.imgRect && m.layerRect){
    lines.push(`image vs layer dXY: ${(m.layerRect.left-m.imgRect.left).toFixed(1)}, ${(m.layerRect.top-m.imgRect.top).toFixed(1)}`);
    lines.push(`image vs layer dWH: ${(m.layerRect.width-m.imgRect.width).toFixed(1)}, ${(m.layerRect.height-m.imgRect.height).toFixed(1)}`);
  }
  if(m.contentRect && m.imgRect){
    lines.push(`image vs content dXY: ${(m.imgRect.left-m.contentRect.left).toFixed(1)}, ${(m.imgRect.top-m.contentRect.top).toFixed(1)}`);
    lines.push(`image vs content dWH: ${(m.imgRect.width-m.contentRect.width).toFixed(1)}, ${(m.imgRect.height-m.contentRect.height).toFixed(1)}`);
  }
  box.textContent=lines.join('\n');
}

function placementSvgPointFromEvent(e){
  const m=placementEditorImageMetrics();
  if(!m) return null;
  const rawX=((e.clientX-m.rect.left-m.offsetX)/Math.max(1,m.imgW))*100;
  const rawY=((e.clientY-m.rect.top-m.offsetY)/Math.max(1,m.imgH))*100;
  const p={x:clamp(rawX,0,100), y:clamp(rawY,0,100)};
  updatePlacementDebug({clientX:e.clientX,clientY:e.clientY,rawX,rawY,clampedX:p.x,clampedY:p.y});
  return p;
}
function getInitialPlacementPoint(kind,entityId){
  if(kind==='overview'){
    const p=state.layout.overviewMarkers?.[entityId];
    return p ? {x:clamp(Number(p.x)||50,0,100), y:clamp(Number(p.y)||50,0,100)} : {x:50,y:50};
  }
  const rid=normalizedRoomId(state.selectedRoom);
  const p=state.layout.roomMarkers?.[rid]?.[entityId];
  return p ? roomStoredToImagePos(rid,p) : {x:50,y:50};
}
function openPlacementEditor(entityId){
  if(!state.edit) return;
  const d=devices().find(x=>x.entity_id===entityId);
  if(!d || !canEditDeviceInCurrentScope(d)){ showToast('Это устройство нельзя редактировать в текущем scope'); return; }
  const kind=activeStageKind();
  closeDevicePicker();
  const initial=getInitialPlacementPoint(kind,entityId);
  state.placementEditor={targetType:'marker', entityId, kind, x:initial.x, y:initial.y};
  const src=placementImageSrc(kind);
  const img=el('placement-editor-image'); if(img) img.setAttribute('href',src);
  updatePlacementEditorAspect(src);
  buildPlacementGrid();
  renderPlacementEditorExisting();
  const exists = !!(kind==='overview' ? state.layout.overviewMarkers?.[entityId] : state.layout.roomMarkers?.[normalizedRoomId(state.selectedRoom)]?.[entityId]);
  const title=el('placement-editor-title'); if(title) title.textContent=exists?'Перемещение устройства':'Размещение устройства';
  const dev=el('placement-editor-device'); if(dev) dev.textContent=d?displayName(d):entityId;
  const scope=el('placement-editor-scope'); if(scope) scope.textContent=kind==='overview'?'Общий план':(room(state.selectedRoom)?.label||state.selectedRoom);
  const sizeBox=el('placement-editor-size-controls'); if(sizeBox) sizeBox.classList.add('hidden');
  const zr=el('placement-editor-zone-rect'); if(zr) zr.classList.add('hidden');
  const pm=el('placement-editor-marker'); if(pm) pm.classList.remove('hidden');
  const modal=el('placement-editor-modal'); if(modal) modal.classList.remove('hidden');
  ['btn-clear-zone-draw','btn-delete-placement-zone'].forEach(id=>{const b=el(id); if(b) b.classList.add('hidden');});
  document.body.classList.add('placement-editor-open');
  setPlacementEditorPoint(initial.x,initial.y);
  refitPlacementEditorSoon();
}
function nudgePlacementEditor(dx,dy){
  if(!state.placementEditor) return;
  const step=Number(el('placement-editor-step')?.value||0.5);
  setPlacementEditorPoint(state.placementEditor.x+dx*step,state.placementEditor.y+dy*step);
}
function applyPlacementEditor(){
  if(!state.edit || !state.placementEditor) return;
  pushUndo();
  const pe=state.placementEditor;
  const kind=pe.kind, p={x:pe.x,y:pe.y};
  if(pe.targetType==='zone'){
    const rid=normalizedRoomId(pe.zoneRoomId);
    const pts=sanitizeZonePoints(pe.points);
    if(pts.length<3){ showToast('Обведите зону: нужно минимум 3 точки'); return; }
    if(!state.layout.zones) state.layout.zones={};
    const base=state.layout.zones[rid] || {};
    const b=zoneBounds(pts);
    state.layout.zones[rid]={...base,x:clamp(Number(b.x)||0,0,100),y:clamp(Number(b.y)||0,0,100),w:clamp(Number(b.w)||1,1,100),h:clamp(Number(b.h)||1,1,100),a:0,points:pts};
    closePlacementEditor();
    setLayoutDirty(true);
    renderOverviewZones();
    selectEditObject({kind:'zone',id:rid,scope:'overview',label:room(rid)?.label||rid});
    renderEditSheet();
    showToast('Зона обновлена');
    return;
  }
  if(pe.targetType==='overviewMetric'){
    if(!state.layout.overviewMetrics) state.layout.overviewMetrics={};
    state.layout.overviewMetrics[pe.metricRoomId]=p;
    closePlacementEditor();
    setLayoutDirty(true);
    renderOverviewMetrics();
    selectEditObject({kind:'overviewMetric',id:pe.metricRoomId,scope:'overview',label:room(pe.metricRoomId)?.label||pe.metricRoomId});
    renderEditSheet();
    showToast('Показатель размещён');
    return;
  }
  if(pe.targetType==='roomMetric'){
    const rid=normalizedRoomId(pe.metricRoomId || state.selectedRoom);
    if(!state.layout.roomMetrics) state.layout.roomMetrics={};
    state.layout.roomMetrics[rid]=roomImageToStoredPos(rid,p);
    closePlacementEditor();
    setLayoutDirty(true);
    renderRoomMetrics();
    selectEditObject({kind:'roomMetric',id:rid,scope:'room',label:room(rid)?.label||rid});
    renderEditSheet();
    showToast('Показатель размещён');
    return;
  }
  const id=pe.entityId;
  const d=devices().find(x=>x.entity_id===id);
  if(kind==='room' && d && normalizedRoomId(d.room)!==normalizedRoomId(state.selectedRoom)){
    showToast('Перенос устройств между комнатами пока отключён');
    return;
  }
  setMarkerPosition(id,kind,kind==='room'?roomImageToStoredPos(state.selectedRoom,p):p);
  closePlacementEditor();
  setLayoutDirty(true);
  if(kind==='overview') renderOverviewMarkers(); else renderRoomMarkers();
  selectEditObject({kind:'marker',id,scope:kind,label:d?displayName(d):id});
  renderEditSheet();
  showToast('Устройство размещено');
}

function openDeviceLayoutEditor(entityId){ openPlacementEditor(entityId); }


function deletePlacementEditorZone(){
  if(!state.edit || !state.placementEditor || state.placementEditor.targetType!=='zone') return;
  const rid=normalizedRoomId(state.placementEditor.zoneRoomId);
  if(!rid) return;
  if(!confirm('Удалить выбранную зону?')) return;
  pushUndo();
  if(state.layout.zones) delete state.layout.zones[rid];
  setLayoutDirty(true);
  renderOverviewZones();
  state.selectedEdit=null;
  renderEditSheet();
  showToast('Зона удалена');
  // Остаёмся в редакторе — сбрасываем в пустое состояние для той же комнаты
  state.placementEditor={ ...state.placementEditor, x:50, y:50, wPct:20, hPct:20, angleDeg:0, points:[], drawing:false };
  renderZoneDrawPath();
  renderPlacementEditorExistingZones();
}

function openZoneLayoutEditor(roomId){
  if(!state.edit) return;
  const rid=normalizedRoomId(roomId);
  const r=roomWithLayout(rid);
  if(!r){ showToast('Комната не найдена'); return; }
  closeDevicePicker();
  const pts=hasZoneShape(r) ? zonePoints(r) : [];
  const b=pts.length ? zoneBounds(pts) : {x:50,y:50,w:1,h:1};
  state.placementEditor={targetType:'zone', zoneRoomId:rid, kind:'overview', x:b.x, y:b.y, wPct:b.w, hPct:b.h, angleDeg:0, points:pts, drawing:false};
  const src=placementImageSrc('overview');
  const img=el('placement-editor-image'); if(img) img.setAttribute('href',src);
  updatePlacementEditorAspect(src);
  buildPlacementGrid();
  renderPlacementEditorExisting();
  const title=el('placement-editor-title'); if(title) title.textContent='Редактирование зоны комнаты';
  updatePlacementEditorZoneLabels();
  const sizeBox=el('placement-editor-size-controls'); if(sizeBox) sizeBox.classList.add('hidden');
  const modal=el('placement-editor-modal'); if(modal) modal.classList.remove('hidden');
  ['btn-clear-zone-draw','btn-delete-placement-zone'].forEach(id=>{const b=el(id); if(b) b.classList.remove('hidden');});
  document.body.classList.add('placement-editor-open');
  setPlacementEditorPoint(b.x,b.y);
  renderZoneDrawPath();
  renderPlacementEditorExistingZones();
  refitPlacementEditorSoon();
}

function openMetricLayoutEditor(metricKind, roomId){
  if(!state.edit) return;
  const rid=normalizedRoomId(roomId || state.selectedRoom);
  const kind = metricKind==='overviewMetric' ? 'overview' : 'room';
  closeDevicePicker();
  let initial;
  if(metricKind==='overviewMetric'){
    const r=roomWithLayout(rid);
    initial=safeMetricPoint(state.layout.overviewMetrics?.[rid], defaultMetricPos(r));
  } else {
    const stored=safeMetricPoint(state.layout.roomMetrics?.[rid], {x:16,y:16});
    initial=roomStoredToImagePos(rid, stored);
  }
  state.placementEditor={targetType:metricKind, metricRoomId:rid, kind, x:initial.x, y:initial.y};
  const src=placementImageSrc(kind);
  const img=el('placement-editor-image'); if(img) img.setAttribute('href',src);
  updatePlacementEditorAspect(src);
  buildPlacementGrid();
  renderPlacementEditorExisting();
  const title=el('placement-editor-title'); if(title) title.textContent='Перемещение системного датчика';
  const dev=el('placement-editor-device'); if(dev) dev.textContent=`${room(rid)?.label||rid}: температура/влажность`;
  const scope=el('placement-editor-scope'); if(scope) scope.textContent=kind==='overview'?'Общий план':(room(rid)?.label||rid);
  const sizeBox=el('placement-editor-size-controls'); if(sizeBox) sizeBox.classList.add('hidden');
  const zr=el('placement-editor-zone-rect'); if(zr) zr.classList.add('hidden');
  const pm=el('placement-editor-marker'); if(pm) pm.classList.remove('hidden');
  const modal=el('placement-editor-modal'); if(modal) modal.classList.remove('hidden');
  ['btn-clear-zone-draw','btn-delete-placement-zone'].forEach(id=>{const b=el(id); if(b) b.classList.add('hidden');});
  document.body.classList.add('placement-editor-open');
  setPlacementEditorPoint(initial.x,initial.y);
  refitPlacementEditorSoon();
}


function isSelectedEdit(kind,id,scope){
  const s=state.selectedEdit;
  return !!(s && s.kind===kind && s.id===id && (!scope || s.scope===scope));
}
function selectEditObject(obj){
  if(!state.edit) return;
  state.selectedEdit = obj;
  renderEditSheet();
  qsa('.edit-selected').forEach(x=>x.classList.remove('edit-selected'));
  const selector = obj.kind==='marker'
    ? `.device-marker[data-entity="${CSS.escape(obj.id)}"][data-scope="${CSS.escape(obj.scope)}"]`
    : obj.kind==='zone'
      ? `.room-zone[data-room="${CSS.escape(obj.id)}"]`
      : obj.kind==='overviewMetric'
        ? `.badge[data-kind="overviewMetric"][data-room="${CSS.escape(obj.id)}"]`
        : `.badge[data-kind="roomMetric"][data-room="${CSS.escape(obj.id)}"]`;
  document.querySelector(selector)?.classList.add('edit-selected');
  requestAnimationFrame(updateLiveCoordinateDebug);
}
function selectedEditLabel(){
  const s=state.selectedEdit;
  if(!s) return 'Ничего не выбрано';
  if(s.kind==='marker') return s.label || s.id;
  const r=room(s.id);
  if(s.kind==='zone') return `Зона: ${r?.label||s.id}`;
  return `Показатель: ${r?.label||s.id}`;
}
function renderEditSheet(){
  const sheet=el('edit-action-sheet'); if(!sheet) return;
  sheet.classList.toggle('hidden', !state.edit);
  const title=el('edit-sheet-title'); if(title) title.textContent=selectedEditLabel();
  const hint=el('edit-sheet-hint');
  const isMetric=!!(state.selectedEdit && (state.selectedEdit.kind==='overviewMetric'||state.selectedEdit.kind==='roomMetric'));
  const isZone=!!(state.selectedEdit && state.selectedEdit.kind==='zone');
  if(hint){
    if(!state.selectedEdit) hint.textContent='Короткий тап выбирает объект. Удержание открывает SVG Layout Editor. Устройства добавляются через кнопку “Устройства”.';
    else if(isMetric) hint.textContent='Это системный сдвоенный датчик. Короткий тап выбирает его, удержание открывает SVG Layout Editor для перемещения. Удалить окончательно нельзя.';
    else if(isZone) hint.textContent='Зона выбрана. Удержание открывает SVG Layout Editor: X/Y перемещают прямоугольник, W/H меняют ширину и высоту отдельно. Форма остаётся прямоугольной.';
    else hint.textContent='Маркер выбран. Для перемещения удерживайте его, затем в SVG Layout Editor кликните/тапните новую точку и нажмите “Применить”.';
  }
  const del=el('btn-delete-selected');
  const reset=el('btn-reset-selected');
  if(del){ del.disabled=!(state.selectedEdit && state.selectedEdit.kind==='marker'); del.textContent='Удалить маркер'; }
  if(reset){ reset.disabled=!state.selectedEdit; reset.textContent=isMetric?'Сбросить позицию':(isZone?'Сбросить зону':'Сбросить/убрать'); }
}
function deleteSelectedEditObject(){
  const s=state.selectedEdit;
  if(!state.edit || !s) return;
  if(s.kind!=='marker'){ showToast('Удалять можно только маркеры устройств'); return; }
  pushUndo();
  removeMarker(s.id, s.scope);
  state.selectedEdit=null;
  setLayoutDirty(true);
  render();
}
function resetSelectedEditObject(){
  const s=state.selectedEdit;
  if(!state.edit || !s) return;
  pushUndo();
  if(s.kind==='marker'){
    removeMarker(s.id, s.scope);
    state.selectedEdit=null;
    showToast('Маркер убран с плана');
  } else if(s.kind==='zone'){
    if(state.layout.zones) delete state.layout.zones[s.id];
    showToast('Зона возвращена к исходному положению');
  } else if(s.kind==='overviewMetric'){
    if(state.layout.overviewMetrics) delete state.layout.overviewMetrics[s.id];
    showToast('Показатель возвращён к исходному положению');
  } else if(s.kind==='roomMetric'){
    if(state.layout.roomMetrics) delete state.layout.roomMetrics[s.id];
    showToast('Показатель комнаты возвращён к исходному положению');
  }
  setLayoutDirty(true);
  render();
}

function removeMarker(entityId,scope){
  if(scope==='overview'){
    if(state.layout.overviewMarkers) delete state.layout.overviewMarkers[entityId];
    return;
  }
  const rid=normalizedRoomId(state.selectedRoom) || deviceRoomId(entityId);
  if(state.layout.roomMarkers?.[rid]) delete state.layout.roomMarkers[rid][entityId];
}
async function toggleDevice(d){
  const s=getState(d.entity_id); const st=String(s?.state||'').toLowerCase();
  let domain=d.domain, service='toggle', data={entity_id:d.entity_id};
  if(['light','switch','fan','input_boolean'].includes(domain)) service=st==='on'?'turn_off':'turn_on';
  else if(domain==='cover') { service=st==='open'?'close_cover':'open_cover'; }
  else if(domain==='media_player') { service=st==='off'?'turn_on':'turn_off'; }
  else if(domain==='climate') { service=st==='off'?'turn_on':'turn_off'; }
  else if(domain==='humidifier') { service=st==='on'?'turn_off':'turn_on'; }
  else if(domain==='valve') { service=(st==='open' || st==='opening') ? 'close_valve' : 'open_valve'; }
  else if(domain==='button') { service='press'; }
  else if(domain==='script') { service='turn_on'; }
  else if(domain==='automation') { service=st==='on' ? 'trigger' : 'turn_on'; }
  else { openDevice(d); return; }
  try{ await callService(domain,service,data); showToast(`${displayName(d)}: команда отправлена`); }
  catch(e){showToast('Ошибка управления: '+e.message)}
}

function zoneDown(e){
  if(!state.edit) return;
  e.preventDefault(); e.stopPropagation();
  const z=e.currentTarget; const id=z.dataset.room; const r=roomWithLayout(id);
  let timer=null, sx=e.clientX, sy=e.clientY, longFired=false;
  const select=()=>selectEditObject({kind:'zone',id,scope:'overview',label:r.label});
  const finish=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
  timer=setTimeout(()=>{ longFired=true; select(); openZoneLayoutEditor(id); },650);
  const move=ev=>{ if(timer && Math.hypot(ev.clientX-sx,ev.clientY-sy)>8) finish(); };
  const up=()=>{ finish(); window.removeEventListener('pointermove',move,true); window.removeEventListener('pointerup',up,true); window.removeEventListener('pointercancel',up,true); if(!longFired) select(); };
  window.addEventListener('pointermove',move,true);
  window.addEventListener('pointerup',up,true);
  window.addEventListener('pointercancel',up,true);
}
function metricDown(e){
  if(!state.edit) return;
  e.preventDefault(); e.stopPropagation();
  const b=e.currentTarget;
  const kind=b.dataset.kind;
  const rid=b.dataset.room;
  let timer=null, sx=e.clientX, sy=e.clientY, longFired=false;
  const finish=()=>{ if(timer){clearTimeout(timer); timer=null;} };
  const select=()=>{
    selectEditObject({kind,id:rid,scope:kind==='overviewMetric'?'overview':'room',label:room(rid)?.label||rid});
  };
  timer=setTimeout(()=>{
    longFired=true;
    select();
    openMetricLayoutEditor(kind, rid);
  },650);
  const move=ev=>{ if(timer && Math.hypot(ev.clientX-sx,ev.clientY-sy)>8) finish(); };
  const up=ev=>{
    finish();
    window.removeEventListener('pointermove',move,true);
    window.removeEventListener('pointerup',up,true);
    window.removeEventListener('pointercancel',up,true);
    if(!longFired) select();
  };
  window.addEventListener('pointermove',move,true);
  window.addEventListener('pointerup',up,true);
  window.addEventListener('pointercancel',up,true);
}function pointerPoint(e){return {id:e.pointerId,x:e.clientX,y:e.clientY}}
function stageKindFromEl(stage){return stage && stage.id==='overview-stage'?'overview':'room'}
function isStageInteractiveTarget(target){return !!target.closest('.device-marker,.badge,.room-zone,button,a,input,textarea,select,label,.device-card,.edit-action-sheet,.quick-overlay')}
function bindStageGestures(){
  [[el('overview-stage'),'overview'],[el('room-stage'),'room']].forEach(([stage,kind])=>{
    if(!stage || stage.dataset.gestureBound) return;
    stage.dataset.gestureBound='1';
    stage.addEventListener('pointerdown', e=>{
      if(state.edit) return;
      if(e.button !== undefined && e.button !== 0) return;
      const isInteractive=isStageInteractiveTarget(e.target);
      if(isInteractive && !state.stageGesture) return;
      e.preventDefault();
      if(!state.stageGesture || state.stageGesture.kind!==kind){
        state.stageGesture={kind, pointers:new Map(), startViewport:{...getViewport(kind)}, moved:false, mode:'pan', startedOnInteractive:isInteractive};
      }
      const g=state.stageGesture;
      g.pointers.set(e.pointerId, pointerPoint(e));
      try{stage.setPointerCapture(e.pointerId)}catch(_){}
      const pts=[...g.pointers.values()];
      g.startViewport={...getViewport(kind)};
      if(pts.length>=2){
        g.mode='pinch';
        g.startDistance=Math.max(1, dist(pts[0],pts[1]));
        g.startMid=midpoint(pts[0],pts[1]);
        g.moved=true;
      } else if(!isInteractive) {
        g.mode='pan';
        g.startPoint=pointerPoint(e);
      }
    }, {passive:false});
    stage.addEventListener('pointermove', e=>{
      const g=state.stageGesture; if(!g || g.kind!==kind || !g.pointers.has(e.pointerId)) return;
      e.preventDefault();
      g.pointers.set(e.pointerId, pointerPoint(e));
      const pts=[...g.pointers.values()];
      if(pts.length>=2){
        const mid=midpoint(pts[0],pts[1]);
        const newDist=Math.max(1, dist(pts[0],pts[1]));
        const factor=newDist/(g.startDistance||newDist);
        const nextZoom=clamp((g.startViewport.zoom||1)*factor, .5, 4);
        const dx=mid.x-(g.startMid?.x||mid.x), dy=mid.y-(g.startMid?.y||mid.y);
        setViewport(kind,{zoom:nextZoom, panX:(g.startViewport.panX||0)+dx, panY:(g.startViewport.panY||0)+dy}, false);
        g.moved=true;
        state.suppressClick=true;
      } else if(g.mode==='pan' && g.startPoint){
        const pt=pts[0]; const dx=pt.x-g.startPoint.x, dy=pt.y-g.startPoint.y;
        if(Math.abs(dx)>2 || Math.abs(dy)>2) g.moved=true;
        setViewport(kind,{panX:(g.startViewport.panX||0)+dx, panY:(g.startViewport.panY||0)+dy}, false);
      }
    }, {passive:false});
    const end=e=>{
      const g=state.stageGesture; if(!g || g.kind!==kind || !g.pointers.has(e.pointerId)) return;
      g.pointers.delete(e.pointerId);
      try{stage.releasePointerCapture(e.pointerId)}catch(_){}
      if(g.pointers.size===0){
        if(g.moved){ saveViewportPrefs(); state.suppressClick=true; setTimeout(()=>state.suppressClick=false,DRAG_SUPPRESS_MS); }
        state.stageGesture=null;
      } else {
        const pts=[...g.pointers.values()];
        g.startViewport={...getViewport(kind)};
        g.startPoint=pts[0];
      }
    };
    stage.addEventListener('pointerup', end, {passive:false});
    stage.addEventListener('pointercancel', end, {passive:false});
    stage.addEventListener('dblclick', e=>{ if(isStageInteractiveTarget(e.target)) return; e.preventDefault(); resetViewport(kind); });
    stage.addEventListener('wheel', e=>{ if(!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoomViewport(kind, e.deltaY<0?1.12:.89); }, {passive:false});
  });
}

function hideKioskRooms(){
  const o=el('kiosk-room-overlay');
  if(o) o.classList.add('hidden');
  if(state.kioskRoomTimer){ clearTimeout(state.kioskRoomTimer); state.kioskRoomTimer=null; }
}

function canManageAttention(){ return panelMode()==='admin' && !isKioskInputLocked(); }
function attentionRule(entityId){ return (state.attention?.rules||[]).find(r=>r.entity_id===entityId); }
function updateAttentionFromStates(){
  const rules=(state.attention?.rules||[]).map(r=>{
    const st=getState(r.entity_id);
    const current_state = st ? String(st.state) : (r.current_state || 'unknown');
    return {...r, current_state, alert: r.enabled!==false && current_state !== String(r.normal_state), last_changed: st?.last_changed || r.last_changed || null};
  });
  state.attention={ok:true, rules, hasAlerts: rules.some(r=>r.alert)};
  renderAttentionButton();
}
async function loadAttention(){
  try{ state.attention=await apiJson('api/attention'); updateAttentionFromStates(); }
  catch(e){ console.warn('attention load failed', e); state.attention={ok:false,hasAlerts:false,rules:[]}; renderAttentionButton(); }
}
function renderAttentionButton(){
  const btn=el('btn-kiosk-attention'); if(!btn) return;
  const count=(state.attention?.rules||[]).filter(r=>r.alert).length;
  const hasAlert=!!state.attention?.hasAlerts;
  btn.classList.toggle('has-alert', hasAlert);
  btn.classList.toggle('hidden', !hasAlert);
  btn.textContent = count>1 ? `! ${count}` : '!';
  btn.title = hasAlert ? 'Открыть окно Внимание' : 'Нет активных alerts';
}
function attentionStatusText(rule){ return rule?.alert ? 'Внимание' : 'OK'; }
function renderAttentionModal(){
  updateAttentionFromStates();
  const body=el('attention-body'); if(!body) return;
  const rules=state.attention?.rules||[];
  const active=rules.filter(r=>r.alert), ok=rules.filter(r=>!r.alert);
  const section=(title,list)=>`<h3>${esc(title)}</h3>`+(list.length?`<div class="attention-list">${list.map(r=>`<div class="attention-row ${r.alert?'alert':'ok'}" data-attention-entity="${esc(r.entity_id)}"><div><b>${esc(r.name||r.entity_id)}</b><span>${esc(r.entity_id)}</span></div><div><span>Сейчас: <b>${esc(attentionStateText(r,r.current_state))}</b></span><span>Норма: <b>${esc(attentionStateText(r,r.normal_state))}</b></span><span>${esc(attentionStatusText(r))}</span></div></div>`).join('')}</div>`:'<p class="muted">—</p>');
  body.innerHTML=`<p class="muted">Список глобальный: alert показывается в киоске независимо от текущей комнаты.</p>${section('Активные',active)}${section('Наблюдаются',ok)}`;
  qsa('[data-attention-entity]', body).forEach(row=>bindHold(row, async()=>{
    if(!canManageAttention()){ showToast('Изменение доступно только в admin mode и при разблокированном киоске'); return; }
    const eid=row.dataset.attentionEntity;
    await apiJson('api/attention/'+encodeURIComponent(eid),{method:'DELETE'});
    await loadAttention();
  await loadSecurityRules(); renderAttentionModal(); showToast('Удалено из Внимание');
  }));
}
function openAttentionModal(){ renderAttentionModal(); el('attention-modal')?.classList.remove('hidden'); document.body.classList.add('modal-open'); }
function closeAttentionModal(){ el('attention-modal')?.classList.add('hidden'); document.body.classList.remove('modal-open'); }
function bindHold(node, fn, ms=3000){
  let t=null, done=false;
  const clear=()=>{ if(t){ clearTimeout(t); t=null; } node.classList.remove('holding'); };
  node.addEventListener('pointerdown', e=>{ done=false; node.classList.add('holding'); t=setTimeout(async()=>{ done=true; clear(); await fn(e); }, ms); }, {passive:true});
  ['pointerup','pointercancel','pointerleave'].forEach(ev=>node.addEventListener(ev, e=>{ clear(); if(done){ e.preventDefault?.(); e.stopPropagation?.(); } }, {passive:false}));
}
async function toggleAttentionRule(d){
  if(!canManageAttention()){ showToast('Изменение доступно только в admin mode и при разблокированном киоске'); return; }
  const exists=attentionRule(d.entity_id);
  if(exists) await apiJson('api/attention/'+encodeURIComponent(d.entity_id),{method:'DELETE'});
  else await apiJson('api/attention',{method:'POST',body:JSON.stringify({entity_id:d.entity_id,name:displayName(d)})});
  await loadAttention();
  openDeviceModal(d);
}
function securityRules(){ return state.securityRules || {forceDangerous:[],forceSafe:[]}; }
function isEntityForceDangerous(entityId){ return (securityRules().forceDangerous||[]).includes(entityId); }
function isEntityForceSafe(entityId){ return (securityRules().forceSafe||[]).includes(entityId); }
function isDomainDangerous(d){ const dom=String(d?.domain||String(d?.entity_id||'').split('.')[0]||''); return ['lock','valve','button','script','automation'].includes(dom); }
function isDangerousDevice(d){ if(isEntityForceSafe(d.entity_id)) return false; if(isEntityForceDangerous(d.entity_id)) return true; return isDomainDangerous(d); }
function canManageDangerous(){ return panelMode()==='admin'; }
async function loadSecurityRules(){ try{ const res=await apiJson('api/security/rules'); state.securityRules=res.rules||{forceDangerous:[],forceSafe:[]}; if(res.security){ state.config={...(state.config||{}), security:{...(state.config?.security||{}), ...res.security}}; } }catch(e){ console.warn('security rules load failed',e); state.securityRules={forceDangerous:[],forceSafe:[]}; } }
async function toggleDangerousRule(d){ if(!canManageDangerous()){ showToast('Dangerous можно менять только в admin mode'); return; } const dangerous=!isDangerousDevice(d); const res=await apiJson('api/security/dangerous',{method:'POST',body:JSON.stringify({entity_id:d.entity_id,dangerous})}); state.securityRules=res.rules||securityRules(); openDeviceModal(d); showToast(dangerous?'Устройство помечено dangerous':'Устройство исключено из dangerous'); }
function dangerousSectionHtml(d){
  const admin=canManageDangerous(); const dang=isDangerousDevice(d); const src=isEntityForceSafe(d.entity_id)?'исключено вручную':isEntityForceDangerous(d.entity_id)?'помечено вручную':isDomainDangerous(d)?'опасное по типу устройства':'обычное';
  return `<section class="device-security-section"><h3>Безопасность</h3><div class="attention-mini ${dang?'alert':'ok'}"><b>${dang?'Dangerous':'Safe'}</b><span>${esc(src)}</span></div><button type="button" data-action="dangerous-toggle" ${admin?'':'disabled'}>${dang?'Сделать не dangerous':'Сделать dangerous'}</button>${admin?'':'<p class="muted">Изменение dangerous доступно только в admin mode.</p>'}</section>`;
}
function attentionSectionHtml(d){
  const r=attentionRule(d.entity_id); const admin=canManageAttention();
  const current=stateText(d);
  return `<section class="device-attention-section"><h3>Внимание</h3><p class="muted">Правило глобальное: кнопка “Внимание!” в киоске сработает независимо от комнаты, где сейчас открыт экран.</p>${r?`<div class="attention-mini ${r.alert?'alert':'ok'}"><b>${r.alert?'Внимание':'OK'}</b><span>Норма: ${esc(r.normal_state)}</span><span>Сейчас: ${esc(r.current_state||current)}</span></div>`:`<p class="muted">Сейчас: ${esc(current)}. При включении это состояние будет сохранено как норма.</p>`}<button type="button" data-action="attention-toggle" ${admin?'':'disabled'}>${r?'Не следить':'Следить за изменением состояния'}</button>${admin?'':'<p class="muted">Изменение доступно только в admin mode и при разблокированном киоске.</p>'}</section>`;
}

function renderKioskRoomOverlay(){
  const list=el('kiosk-room-list'); if(!list) return;
  list.innerHTML='';
  ROOMS.forEach(r=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='kiosk-room-item'+(normalizedRoomId(state.selectedRoom)===normalizedRoomId(r.id)?' active':'');
    b.textContent=r.label;
    b.onclick=()=>{
      state.kioskTilePage=0;
      selectRoom(r.id);
      hideKioskRooms();
    };
    list.appendChild(b);
  });
}
function openKioskRooms(){
  renderKioskRoomOverlay();
  const o=el('kiosk-room-overlay'); if(!o) return;
  o.classList.remove('hidden');
  if(state.kioskRoomTimer) clearTimeout(state.kioskRoomTimer);
  state.kioskRoomTimer=setTimeout(hideKioskRooms, 10000);
}

function selectRoom(id){
  state.selectedRoom=id;
  if(state.ui.mobileMode || state.ui.autoHide){
    state.ui.hideSidebar=true; state.ui.hideDevicePanel=true;
  }
  saveUiPrefs();
  render();
}
function setConnection(ok,text,mode){const cls=mode==='live'?'connected':mode==='polling'?'polling':ok?'connected':'disconnected';el('connection-dot').className='dot '+cls;el('connection-text').textContent=text}
/* ── Mobile auth token (set by Capacitor app via URL hash) ─────────── */
const _mobileAuth = (()=>{
  try{
    // Capacitor передаёт через fragment: #_mt=TOKEN&_did=DEVICE_ID&_local=URL&_remote=URL
    const hash = location.hash.slice(1);
    if(hash.includes('_mt=')){
      const p = new URLSearchParams(hash);
      const mt = p.get('_mt'), did = p.get('_did');
      if(mt && did){
        localStorage.setItem('_mobile_token', mt);
        localStorage.setItem('_mobile_did', did);
        const loc = p.get('_local'); if(loc) localStorage.setItem('_mobile_local', loc);
        const rem = p.get('_remote'); if(rem) localStorage.setItem('_mobile_remote', rem);
        history.replaceState(null,'', location.pathname + location.search);
      }
    }
    const token    = localStorage.getItem('_mobile_token')  || '';
    const deviceId = localStorage.getItem('_mobile_did')    || '';
    const localUrl = localStorage.getItem('_mobile_local')  || '';
    const remoteUrl= localStorage.getItem('_mobile_remote') || '';
    return { token, deviceId, localUrl, remoteUrl, active: !!(token && deviceId) };
  }catch{ return { token:'', deviceId:'', localUrl:'', remoteUrl:'', active:false }; }
})();

/* ── Per-client ID (stable per browser/device, used for /api/prefs) ── */
const _clientId = (() => {
  if(_mobileAuth.active) return _mobileAuth.deviceId; // мобилка — device_id уже есть
  try{
    let id = localStorage.getItem('_client_id');
    if(!id){
      id = crypto.randomUUID ? crypto.randomUUID()
         : (Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem('_client_id', id);
    }
    return id;
  }catch{ return ''; }
})();

/* ── Mobile offline overlay (только когда _mobileAuth.active) ──────── */
let _mobileOfflineCount = 0;
function _mobileShowOffline(){
  let ov = document.getElementById('_mob-offline');
  if(!ov){
    ov = document.createElement('div');
    ov.id = '_mob-offline';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(14,16,19,.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:32px;font-family:system-ui,sans-serif';
    ov.innerHTML = '<div style="font-size:48px">📡</div>'
      + '<div style="font-size:20px;font-weight:700;color:#e8edf4">Нет связи с сервером</div>'
      + '<div id="_mob-status" style="font-size:14px;color:#6f7a8a;text-align:center"></div>'
      + '<button id="_mob-retry" style="background:#f0b34b;color:#1a1000;border:none;border-radius:12px;padding:14px 28px;font-size:16px;font-weight:700;min-width:200px;cursor:pointer">Попробовать снова</button>';
    document.body.appendChild(ov);
    document.getElementById('_mob-retry').onclick = _mobileReconnect;
  }
  ov.style.display = 'flex';
  _mobileAutoRetry();
}
function _mobileHideOffline(){
  const ov = document.getElementById('_mob-offline');
  if(ov) ov.style.display = 'none';
  _mobileOfflineCount = 0;
}
let _mobileRetryTimer = null;
function _mobileAutoRetry(){
  if(_mobileRetryTimer) return;
  let secs = 15;
  const tick = () => {
    const st = document.getElementById('_mob-status');
    if(st) st.textContent = `Повтор через ${secs}с...`;
    if(--secs < 0){ secs = 15; _mobileReconnect(); }
  };
  tick();
  _mobileRetryTimer = setInterval(tick, 1000);
}
async function _mobileReconnect(){
  clearInterval(_mobileRetryTimer); _mobileRetryTimer = null;
  const st = document.getElementById('_mob-status');
  const { token, deviceId, localUrl, remoteUrl } = _mobileAuth;
  const tryUrl = async (url) => {
    if(!url) return false;
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url + '/api/health', { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      return res.ok;
    }catch{ return false; }
  };
  const currentOrigin = location.origin;
  const isLocal = localUrl && currentOrigin === new URL(localUrl).origin;
  const ordered = isLocal ? [localUrl, remoteUrl] : [remoteUrl, localUrl];
  for(const url of ordered){
    if(!url) continue;
    if(st) st.textContent = `Проверка ${url.replace(/https?:\/\//,'')}…`;
    if(await tryUrl(url)){
      const hp = new URLSearchParams();
      hp.set('_mt', token); hp.set('_did', deviceId);
      if(localUrl)  hp.set('_local', localUrl);
      if(remoteUrl) hp.set('_remote', remoteUrl);
      window.location.href = `${url}/#${hp.toString()}`;
      return;
    }
  }
  if(st) st.textContent = 'Сервер недоступен.';
  _mobileAutoRetry();
}

async function apiJson(url,opt={}){
  const headers = {'Content-Type':'application/json', ...(opt.headers||{})};
  if(_mobileAuth.active){
    headers['Authorization'] = `Bearer ${_mobileAuth.token}`;
    headers['X-Device-ID'] = _mobileAuth.deviceId;
  }
  if(_clientId) headers['X-Client-ID'] = _clientId;
  const res=await fetch(url,{...opt,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){const err=new Error(data.error||data.message||res.status);err.status=res.status;err.data=data;throw err;}
  return data;
}
async function loadLayout(){try{const l=await apiJson('api/layout'); state.layout={version:8,coordinateSpace:'room-content-box',overviewRoomSync:false,roomCoordinateMigrated:{},overviewMarkers:{},roomMarkers:{},overviewMetrics:{},roomMetrics:{},zones:{},customNames:{},...l}; if(!('coordinateSpace' in (l||{}))) state.layout.coordinateSpace='legacy-stage'; if(!('roomCoordinateMigrated' in (l||{}))) state.layout.roomCoordinateMigrated={}; if(!state.layout.overviewMarkers&&state.layout.markers)state.layout.overviewMarkers=state.layout.markers; migrateLayout();}catch(e){console.warn('layout load failed',e)}}
function migrateLayout(){
  if(!state.layout.roomMarkers)state.layout.roomMarkers={};
  if(state.layout.roomMarkers.boiler){
    state.layout.roomMarkers.laundry={...(state.layout.roomMarkers.laundry||{}),...state.layout.roomMarkers.boiler};
    delete state.layout.roomMarkers.boiler;
  }
  if(state.layout.zones?.boiler) delete state.layout.zones.boiler;
  if(!state.layout.overviewMarkers) state.layout.overviewMarkers={};
  if(state.layout.coordinateSpace==='room-content'){
    for(const [rid,map] of Object.entries(state.layout.roomMarkers||{})){
      for(const [eid,p] of Object.entries(map||{})) state.layout.roomMarkers[rid][eid]=roomImageToStoredPos(rid,p);
    }
    for(const [rid,p] of Object.entries(state.layout.roomMetrics||{})) state.layout.roomMetrics[rid]=roomImageToStoredPos(rid,p);
    state.layout.coordinateSpace='room-content-box';
  }
  // v3.2.3: positions on the overview and inside rooms are independent.
  state.layout.overviewRoomSync=false;
}
async function saveLayout(show=true){try{await apiJson('api/layout',{method:'POST',body:JSON.stringify(state.layout)}); if(show) showToast('Layout сохранен'); return true;}catch(e){if(show) showToast(e.message); throw e;}}
async function loadConfig(){const cfg=await apiJson('api/config');state.config=cfg;applyGlobalConfig(cfg);const hu=el('ha-url'); if(hu) hu.value=cfg.haUrl||'';const pi=el('poll-interval'); if(pi) pi.value=Math.round((cfg.pollIntervalMs||6000)/1000);return cfg}



function currentLevelList(){ return Array.isArray(state.levels?.levels) ? state.levels.levels : []; }
function activeLevelMeta(){
  const levels=currentLevelList();
  const activeId=state.levels?.activeLevelId || levels.find(l=>l.active)?.id || '';
  return levels.find(l=>l.id===activeId || l.active) || {id:activeId, name:activeId || 'Уровень'};
}
function renderLevelSwitcher(){
  const levels=currentLevelList();
  const active=activeLevelMeta();
  const others=levels.filter(l=>l.id !== active.id);
  const levelHtml = levels.length > 1 ? others.map(l=>`<button type="button" class="level-switch-btn" data-quick-level="${esc(l.id)}">${esc(l.name||l.id)}</button>`).join('') : '';
  const overviewHtml = (state.ui.kioskMode && state.selectedRoom!=='overview') ? '<button type="button" class="level-switch-btn overview-switch-btn" data-kiosk-overview-home="1">Общий план</button>' : '';
  const html = overviewHtml + levelHtml;
  ['level-switcher','kiosk-level-switcher'].forEach(id=>{
    const box=el(id);
    if(!box) return;
    const useHtml = html;
    box.innerHTML=useHtml;
    box.classList.toggle('hidden', !useHtml);
  });
}
async function loadRuntimeScripts(){
  const token=Date.now();
  const [devicesJs, lovelaceJs] = await Promise.all([
    fetch(`devices.js?t=${token}`, {cache:'no-store'}).then(r=>{ if(!r.ok) throw new Error('devices.js '+r.status); return r.text(); }),
    fetch(`lovelace-source.js?t=${token}`, {cache:'no-store'}).then(r=>{ if(!r.ok) throw new Error('lovelace-source.js '+r.status); return r.text(); })
  ]);
  Function(devicesJs)();
  Function(lovelaceJs)();
}
async function reloadActiveLevelRuntime(){
  await loadRuntimeScripts();
  await loadLayout();
  await loadSourceConfig();
  await loadImagesInfo();
  const overviewImg=el('overview-image');
  if(overviewImg) overviewImg.src = overviewImageSrc();
  await loadRoomsSettings();
  state.selectedRoom='overview';
  applySourceConfig();
  refreshRuntimeRooms();
  renderSourceSettings();
  renderRoomsZonesManager();
  renderLayoutMaintenanceTools();
  render();
  requestAnimationFrame(()=>fitStage('overview'));
}
async function activateLevelSmooth(levelId, opts={}){
  if(!levelId || state.levelSwitching) return;
  if(state.edit){ showToast('Сначала сохраните или отмените редактирование'); return; }
  state.levelSwitching=true;
  document.body.classList.add('level-switching');
  try{
    const res=await apiJson(`api/levels/${encodeURIComponent(levelId)}/activate`,{method:'POST'});
    state.levels=res;
    renderLevelSwitcher();
    renderLevelsManager();
    await reloadActiveLevelRuntime();
    showToast('Уровень переключён');
  }catch(e){
    showToast('Ошибка переключения уровня: '+e.message);
  }finally{
    setTimeout(()=>document.body.classList.remove('level-switching'), 160);
    state.levelSwitching=false;
  }
}
async function activateLevelQuick(levelId){ return activateLevelSmooth(levelId); }

async function loadProfilesInfo(){
  try{
    state.profiles = await apiJson('api/profiles');
    renderProfilesManager();
    return state.profiles;
  }catch(e){
    state.profiles = null;
    const box=el('profiles-manager');
    if(box) box.innerHTML='<p class="muted">Ошибка чтения профилей: '+esc(e.message)+'</p>';
    return null;
  }
}

function profileCopyButtons(targetId, profiles){
  const other = (profiles||[]).filter(x=>x.id!==targetId);
  const disabled = other.length ? '' : 'disabled';
  const options = other.map(x=>`<option value="${esc(x.id)}">${esc(x.name||x.id)} (${esc(x.id)})</option>`).join('');
  const kinds = [
    ['zones','Копировать зоны из'],
    ['sensors','Копировать датчики из'],
    ['markers','Копировать расположение маркеров и сенсоров из'],
    ['rooms','Копировать комнаты из'],
    ['overview','Копировать общий план из'],
    ['all','Копировать все настройки из']
  ];
  return kinds.map(([kind,label])=>`<div class="profile-copy-action"><button type="button" data-profile-copy-kind="${kind}" data-profile-copy-target="${esc(targetId)}" ${disabled}>${label}</button><select data-profile-copy-source="${esc(targetId)}:${kind}" ${disabled}>${options}</select></div>`).join('');
}
function describeCopyKind(kind){
  return ({zones:'зоны',sensors:'стандартные датчики комнат',markers:'расположение маркеров и сенсоров',rooms:'комнаты',overview:'общий план',all:'все настройки активного уровня профиля'})[kind] || kind;
}
function mismatchWarningText(data){
  const c=data?.comparison || {};
  const s=c.source || {}, t=c.target || {};
  return 'Размеры или aspect ratio overview-карт источника и назначения не совпадают. Координаты могут сместиться, после копирования может потребоваться ручное редактирование.\n\nИсточник: '+(s.width&&s.height?`${s.width}×${s.height}, aspect ${s.aspectRatio}`:'карта не найдена')+'\nНазначение: '+(t.width&&t.height?`${t.width}×${t.height}, aspect ${t.aspectRatio}`:'карта не найдена')+'\n\nПродолжить?';
}
async function copyProfileDataFromSettings(targetId, kind){
  if(!canEditLayout()){ showToast('Копирование профилей доступно только в admin mode'); return; }
  const sel=document.querySelector(`[data-profile-copy-source="${CSS.escape(targetId+':'+kind)}"]`);
  const sourceProfileId=sel?.value || '';
  if(!sourceProfileId){ showToast('Выберите профиль-источник'); return; }
  if(!confirm(`Скопировать ${describeCopyKind(kind)} из профиля ${sourceProfileId} в профиль ${targetId}? Перед операцией будет создан backup профиля назначения.`)) return;
  try{
    let res=await apiJson(`api/profiles/${encodeURIComponent(targetId)}/copy-from`,{method:'POST',body:JSON.stringify({kind,sourceProfileId})});
    if(res.needsConfirmation){
      if(!confirm(mismatchWarningText(res))) return;
      res=await apiJson(`api/profiles/${encodeURIComponent(targetId)}/copy-from`,{method:'POST',body:JSON.stringify({kind,sourceProfileId,confirmMismatch:true})});
    }
    if(res.profiles) state.profiles=res.profiles; else await loadProfilesInfo();
    renderProfilesManager();
    showToast('Копирование выполнено. Backup: '+(res.backup||'—'));
    if(targetId === (state.profiles?.activeProfileId || 'profile-1')) setTimeout(()=>location.reload(),700);
  }catch(e){ showToast('Ошибка копирования профиля: '+e.message); }
}
function renderProfilesManager(){
  const box=el('profiles-manager');
  if(!box) return;
  const admin=canEditLayout();
  const data=state.profiles;
  if(!data){ box.innerHTML='<p class="muted">Профили ещё не загружены.</p>'; return; }
  const profiles=Array.isArray(data.profiles) ? data.profiles : [];
  const globalActiveId=data.activeProfileId || profiles.find(p=>p.active)?.id || 'profile-1';
  const clientActiveId=state._clientActiveProfileId || globalActiveId;
  const canCreate=profiles.length < (data.max || 5);
  const rows=profiles.map(p=>{
    const globalActive=p.id===globalActiveId || p.active;
    const clientActive=p.id===clientActiveId;
    let badges='';
    if(globalActive) badges+=' <span class="profile-badge">общий</span>';
    if(clientActive) badges+=' <span class="profile-badge profile-badge-device">это устройство</span>';
    return `<div class="profile-row${clientActive?' active-profile':''}" data-profile-row="${esc(p.id)}">`+
      `<div><strong>${esc(p.name||p.id)}</strong>${badges}<br>`+
      `<span class="muted">${esc(p.id)} · ${p.exists?'папка есть':'папка не найдена'}${p.updatedAt?' · '+esc(new Date(p.updatedAt).toLocaleString()):''}</span></div>`+
      `<div class="profile-actions">`+
      `<button type="button" data-profile-activate-device="${esc(p.id)}" ${clientActive?'disabled':''}>Для этого устройства</button>`+
      `<button type="button" data-profile-activate="${esc(p.id)}" ${globalActive?'disabled':''}>Глобально</button>`+
      `<button type="button" data-profile-rename="${esc(p.id)}">Переименовать</button>`+
      `<button type="button" data-profile-duplicate="${esc(p.id)}" ${canCreate?'':'disabled'}>Дублировать</button>`+
      `<button type="button" class="danger-button small-danger" data-profile-delete="${esc(p.id)}" ${profiles.length<=1?'disabled':''}>Удалить</button>`+
      `</div></div>`+
      `<details class="profile-copy-tools"><summary>Копирование из другого профиля</summary>`+
      `<div class="profile-copy-grid">${profileCopyButtons(p.id, profiles)}</div>`+
      `<p class="muted">Для зон и маркеров приложение сравнит overview-карты источника и назначения. При несовпадении размера или aspect ratio появится предупреждение.</p>`+
      `</details>`;
  }).join('');
  box.innerHTML=`<div class="profile-summary"><strong>Общий профиль:</strong> ${esc(globalActiveId)} · <strong>Этот клиент:</strong> ${esc(clientActiveId)} · ${profiles.length}/${data.max||3}</div>`+
    `<p class="muted" style="margin:4px 0 12px">«Для этого устройства» — только эта вкладка/телефон переключится на выбранный профиль. «Глобально» — все устройства без своего профиля будут видеть этот профиль.</p>`+
    `<div class="profile-create-card"><h4>Создать новый профиль</h4>`+
    `<label>Название профиля <input id="new-profile-name" type="text" placeholder="Например: Этаж 2 / Двор / Тест"></label>`+
    `<label class="settings-check"><input type="checkbox" id="new-profile-copy-zones"> Дублировать зоны из текущего профиля</label>`+
    `<label class="settings-check"><input type="checkbox" id="new-profile-copy-markers"> Дублировать значки/маркеры из текущего профиля</label>`+
    `<p class="muted">Создать профиль с нуля = пустой профиль без комнат/устройств/источников. Дублирование профиля = полная копия. Галочки копируют только зоны/значки, без автопарсинга старых карт.</p>`+
    `<button type="button" id="btn-open-project-setup-wizard" ${canCreate?'':'disabled'}>Мастер настройки</button>`+
    `<button type="button" id="btn-create-profile" ${canCreate?'':'disabled'}>${canCreate?'Создать профиль':'Максимум 5 профилей'}</button></div>`+
    `<div class="profiles-list">${rows}</div>`+
    `<p class="muted">Security/PIN, dangerous rules и Attention Monitor остаются общими для всех профилей.</p>`;
  qsa('button,input,select', box).forEach(ctrl=>{ if(!admin) ctrl.disabled=true; });
}
async function createProfileFromSettings(){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  const name=el('new-profile-name')?.value?.trim() || '';
  const duplicateZones=!!el('new-profile-copy-zones')?.checked;
  const duplicateMarkers=!!el('new-profile-copy-markers')?.checked;
  try{
    state.profiles=await apiJson('api/profiles',{method:'POST',body:JSON.stringify({name,duplicateZones,duplicateMarkers})});
    renderProfilesManager();
    showToast('Профиль создан');
  }catch(e){ showToast('Ошибка создания профиля: '+e.message); }
}
async function duplicateProfileFromSettings(profileId){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  const current=state.profiles?.profiles?.find(p=>p.id===profileId);
  const name=window.prompt('Название копии профиля', current ? `Копия ${current.name}` : 'Копия профиля');
  if(name===null) return;
  try{
    state.profiles=await apiJson(`api/profiles/${encodeURIComponent(profileId)}/duplicate`,{method:'POST',body:JSON.stringify({name})});
    renderProfilesManager();
    showToast('Профиль продублирован');
  }catch(e){ showToast('Ошибка дублирования профиля: '+e.message); }
}
async function activateProfileFromSettings(profileId){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  if(!confirm('Переключить глобальный профиль? Все устройства без своего профиля увидят его. После переключения страница будет перезагружена.')) return;
  try{
    await apiJson(`api/profiles/${encodeURIComponent(profileId)}/activate`,{method:'POST'});
    showToast('Профиль переключён. Перезагрузка...');
    setTimeout(()=>location.reload(), 700);
  }catch(e){ showToast('Ошибка переключения профиля: '+e.message); }
}
async function activateProfileForDevice(profileId){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  try{
    await apiJson(`api/profiles/${encodeURIComponent(profileId)}/activate-for-client`,{method:'POST'});
    state._clientActiveProfileId = profileId;
    await saveClientPrefs().catch(()=>{});
    showToast('Профиль переключён для этого устройства. Перезагрузка...');
    setTimeout(()=>location.reload(), 700);
  }catch(e){ showToast('Ошибка переключения профиля: '+e.message); }
}
async function renameProfileFromSettings(profileId){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  const current=state.profiles?.profiles?.find(p=>p.id===profileId);
  const name=window.prompt('Новое название профиля', current?.name || profileId);
  if(name===null) return;
  try{
    state.profiles=await apiJson(`api/profiles/${encodeURIComponent(profileId)}`,{method:'PATCH',body:JSON.stringify({name})});
    renderProfilesManager();
    showToast('Профиль переименован');
  }catch(e){ showToast('Ошибка переименования профиля: '+e.message); }
}
async function deleteProfileFromSettings(profileId){
  if(!canEditLayout()){ showToast('Профили доступны только в admin mode'); return; }
  const list=state.profiles?.profiles || [];
  if(list.length<=1){ showToast('Нельзя удалить последний профиль'); return; }
  const current=list.find(p=>p.id===profileId);
  if(!confirm(`Удалить профиль "${current?.name||profileId}"? Перед удалением будет создан backup профиля.`)) return;
  const word=window.prompt('Для удаления введите DELETE');
  if(word !== 'DELETE'){ showToast('Удаление отменено'); return; }
  try{
    const wasActive = profileId === (state.profiles?.activeProfileId || 'profile-1');
    const res=await apiJson(`api/profiles/${encodeURIComponent(profileId)}`,{method:'DELETE',body:JSON.stringify({})});
    state.profiles=res;
    renderProfilesManager();
    showToast('Профиль удалён. Backup: '+(res.backup||'—'));
    if(wasActive) setTimeout(()=>location.reload(),700);
  }catch(e){ showToast('Ошибка удаления профиля: '+e.message); }
}


async function loadLevelsInfo(){
  try{
    state.levels = await apiJson('api/levels');
    renderLevelsManager();
    renderLevelSwitcher();
    return state.levels;
  }catch(e){
    state.levels = null;
    const box=el('levels-manager');
    if(box) box.innerHTML='<p class="muted">Ошибка загрузки уровней: '+esc(e.message)+'</p>';
  }
}
function renderLevelsManager(){
  const box=el('levels-manager');
  if(!box) return;
  const data=state.levels;
  const admin=canEditLayout();
  if(!data){ box.innerHTML='<p class="muted">Уровни ещё не загружены.</p>'; return; }
  const levels=Array.isArray(data.levels) ? data.levels : [];
  const activeId=data.activeLevelId || levels.find(l=>l.active)?.id || 'level-1';
  const rows=levels.map(l=>{
    const active=l.id===activeId || l.active;
    const sc=l.sourceConfig || {};
    const st=l.status || {};
    const sourceText=String(sc.dashboardPathText || (Array.isArray(sc.dashboardPaths)?sc.dashboardPaths.join('\n'):'') || '');
    const statusHtml = `<div class="level-status-grid">`+
      `<span class="level-status-chip ${st.hasOverviewImage?'ok':'warn'}">Карта: ${st.hasOverviewImage?'есть':'fallback'}</span>`+
      `<span class="level-status-chip ${st.hasSources?'ok':'warn'}">Источники: ${Number(st.sourcesCount||0)}</span>`+
      `<span class="level-status-chip">Устройства: ${Number(st.devicesCount||0)}</span>`+
      `<span class="level-status-chip">Комнаты: ${Number(st.roomsCount||0)}</span>`+
      `<span class="level-status-chip">Зоны: ${Number(st.zonesCount||0)}</span>`+
      `<span class="level-status-chip">Маркеры: ${Number(st.overviewMarkersCount||0)+Number(st.roomMarkersCount||0)}</span>`+
      `</div>`;
    return `<div class="profile-row level-row${active?' active-profile':''}" data-level-row="${esc(l.id)}">`+
      `<div class="level-row-top"><div><strong>${esc(l.name||l.id)}</strong>${active?' <span class="profile-badge">текущий</span>':''}<br>`+
      `<small class="muted">${esc(l.id)} · ${l.exists?'папка есть':'папка не найдена'}</small></div>`+
      `<div class="profile-actions">`+
      `<button type="button" data-level-init="${esc(l.id)}">Мастер настройки</button>`+
      `<button type="button" data-level-activate="${esc(l.id)}" ${active?'disabled':''}>Переключить</button>`+
      `<button type="button" data-level-rename="${esc(l.id)}">Переименовать</button>`+
      `<button type="button" data-level-duplicate="${esc(l.id)}">Дублировать</button>`+
      `<button type="button" class="danger-button small-danger" data-level-delete="${esc(l.id)}" ${levels.length<=1?'disabled':''}>Удалить</button>`+
      `</div></div>`+statusHtml+
      `<details class="level-source-details" ${active?'open':''}><summary>Источники Lovelace этого уровня</summary>`+
      `<label>Адреса панелей / карточек для парсинга уровня<textarea rows="3" data-level-source-paths="${esc(l.id)}" placeholder="dashboard-unknown/0\ndashboard-unknown/1\ndashboard-unknown/media">${esc(sourceText)}</textarea></label>`+
      `<div class="level-source-actions"><button type="button" data-level-source-save="${esc(l.id)}">Сохранить источники</button><button type="button" data-level-source-import="${esc(l.id)}">Перечитать этот уровень</button></div>`+
      `<p class="muted">Источники хранятся отдельно для каждого уровня. Новый уровень с нуля не перечитывает старые карты без явного выбора.</p>`+
      `</details></div>`;
  }).join('');
  box.innerHTML=`<div class="profile-summary"><strong>Текущий уровень/область:</strong> ${esc((levels.find(l=>l.id===activeId)||{}).name||activeId)} · ${levels.length}/${data.max||12}</div>`+
    `<div class="profile-create-card"><h4>Создать уровень / область</h4>`+
    `<label>Название уровня <input id="new-level-name" type="text" placeholder="Например: Этаж 2 / Мансарда / Двор"></label>`+
    `<label class="settings-check"><input type="checkbox" id="new-level-copy-zones"> Дублировать зоны из текущего уровня</label>`+
    `<label class="settings-check"><input type="checkbox" id="new-level-copy-markers"> Дублировать значки/маркеры из текущего уровня</label>`+
    `<label class="settings-check"><input type="checkbox" id="new-level-copy-images"> Дублировать картинки</label>`+
    `<label class="settings-check"><input type="checkbox" id="new-level-copy-sources"> Дублировать Lovelace-источники и устройства</label>`+
    `<p class="muted">Создать уровень с нуля = пустой уровень без комнат/устройств/зон/источников. Источники Lovelace задаются в карточке каждого уровня отдельно.</p>`+
    `<button type="button" id="btn-create-level">Создать уровень</button></div>`+
    `<div class="profiles-list">${rows}</div>`+
    `<p class="muted">Переключение для использования выполняется на главной карте и в kiosk mode. Настройки нужны для создания/редактирования уровней и их источников.</p>`;
  qsa('button,input,textarea', box).forEach(ctrl=>{ if(!admin) ctrl.disabled=true; });
}
async function createLevelFromSettings(){
  if(!canEditLayout()){ showToast('Уровни доступны только в admin mode'); return; }
  const body={
    name: el('new-level-name')?.value?.trim() || '',
    duplicateZones: !!el('new-level-copy-zones')?.checked,
    duplicateMarkers: !!el('new-level-copy-markers')?.checked,
    duplicateImages: !!el('new-level-copy-images')?.checked,
    duplicateSources: !!el('new-level-copy-sources')?.checked
  };
  try{ state.levels=await apiJson('api/levels',{method:'POST',body:JSON.stringify(body)}); renderLevelsManager(); showToast('Уровень создан'); }
  catch(e){ showToast('Ошибка создания уровня: '+e.message); }
}
async function duplicateLevelFromSettings(levelId){
  if(!canEditLayout()){ showToast('Уровни доступны только в admin mode'); return; }
  const current=state.levels?.levels?.find(l=>l.id===levelId);
  const name=window.prompt('Название копии уровня', current ? `Копия ${current.name}` : 'Копия уровня');
  if(name===null) return;
  try{ state.levels=await apiJson(`api/levels/${encodeURIComponent(levelId)}/duplicate`,{method:'POST',body:JSON.stringify({name})}); renderLevelsManager(); showToast('Уровень продублирован'); }
  catch(e){ showToast('Ошибка дублирования уровня: '+e.message); }
}
async function activateLevelFromSettings(levelId){
  if(!canEditLayout()){ showToast('Уровни доступны только в admin mode'); return; }
  await activateLevelSmooth(levelId, {fromSettings:true});
}
async function saveLevelSources(levelId){
  if(!canEditLayout()){ showToast('Источники уровня доступны только в admin mode'); return; }
  const ta=document.querySelector(`[data-level-source-paths="${CSS.escape(levelId)}"]`);
  const dashboardPathText=(ta?.value||'').trim();
  try{
    const res=await apiJson(`api/levels/${encodeURIComponent(levelId)}/source-config`,{method:'PATCH',body:JSON.stringify({dashboardPathText})});
    if(res.levels) state.levels=res.levels;
    renderLevelsManager();
    showToast('Источники уровня сохранены');
  }catch(e){ showToast('Ошибка сохранения источников уровня: '+e.message); }
}
async function importLevelSources(levelId){
  if(!canEditLayout()){ showToast('Импорт уровня доступен только в admin mode'); return; }
  const ta=document.querySelector(`[data-level-source-paths="${CSS.escape(levelId)}"]`);
  const dashboardPathText=(ta?.value||'').trim();
  if(!dashboardPathText && !confirm('Источники уровня пустые. Перечитать уровень без адресов?')) return;
  try{
    showToast('Перечитываю уровень...');
    const res=await apiJson(`api/levels/${encodeURIComponent(levelId)}/lovelace/import`,{method:'POST',body:JSON.stringify({dashboardPathText})});
    if(res.levels) state.levels=res.levels;
    renderLevelsManager();
    if(levelId === (state.levels?.activeLevelId || 'level-1')) await reloadActiveLevelRuntime();
    const imp=res.import||{};
    showToast(`Уровень перечитан. Устройств: ${imp.devices ?? 0}`);
  }catch(e){ showToast('Ошибка перечитывания уровня: '+e.message); }
}


function normalizeWizardLevelCount(v){ return clamp(parseInt(v,10)||1,1,10); }
function defaultWizardLevelName(i,count){
  if(count===1) return 'Основной уровень';
  if(i===0) return '1 этаж';
  if(i===1) return '2 этаж';
  if(i===2) return 'Мансарда';
  return `Уровень ${i+1}`;
}
function ensureSetupWizardDefaults(){
  const w=state.setupWizard || (state.setupWizard={step:1,profileName:'Дом',levelCount:1,levelNames:['1 этаж'],createdProfileId:null});
  w.levelCount=normalizeWizardLevelCount(w.levelCount);
  if(!Array.isArray(w.levelNames)) w.levelNames=[];
  for(let i=0;i<w.levelCount;i++) if(!String(w.levelNames[i]||'').trim()) w.levelNames[i]=defaultWizardLevelName(i,w.levelCount);
  w.levelNames=w.levelNames.slice(0,w.levelCount);
  if(!String(w.profileName||'').trim()) w.profileName='Дом';
  return w;
}
function renderProjectSetupWizard(){
  const body=el('project-setup-wizard-body');
  const title=el('project-setup-wizard-title');
  if(!body) return;
  const w=ensureSetupWizardDefaults();
  const step=clamp(Number(w.step)||1,1,4);
  w.step=step;
  if(title) title.textContent='Мастер настройки';
  const stepsHead=`<div class="project-wizard-progress">${[1,2,3,4].map(n=>`<span class="${n===step?'active':''}${n<step?' done':''}">${n}</span>`).join('')}</div>`;
  let html='';
  if(step===1){
    html=`<div class="level-wizard-summary"><strong>Шаг 1 — профиль</strong><br><span class="muted">Создайте новый профиль проекта. Профиль хранит свои уровни, карты, layout, зоны, комнаты, устройства и Lovelace-источники.</span></div>`+
      `<label class="wizard-field"><span>Название профиля</span><input id="setup-profile-name" type="text" value="${esc(w.profileName)}" placeholder="Дом / Квартира / Дача / Офис"></label>`+
      `<p class="muted">Security/PIN, dangerous rules, Attention Monitor и command log остаются глобальными, как и раньше.</p>`;
  }else if(step===2){
    html=`<div class="level-wizard-summary"><strong>Шаг 2 — уровни / области</strong><br><span class="muted">Укажите сколько этажей или областей нужно создать внутри профиля.</span></div>`+
      `<label class="wizard-field"><span>Количество уровней / областей</span><input id="setup-level-count" type="number" min="1" max="10" value="${esc(w.levelCount)}"></label>`+
      `<p class="muted">Например: 1 уровень, 2 этажа, мансарда, двор, гараж, участок. Пустые уровни не копируют карты, зоны, комнаты, источники, маркеры и устройства без явного дублирования.</p>`;
  }else if(step===3){
    html=`<div class="level-wizard-summary"><strong>Шаг 3 — названия уровней</strong><br><span class="muted">Названия уровней вводятся вручную и не берутся из HA/Lovelace или имён картинок.</span></div>`+
      `<div class="wizard-level-names">${Array.from({length:w.levelCount},(_,i)=>`<label class="wizard-field"><span>Уровень ${i+1}</span><input data-setup-level-name="${i}" type="text" value="${esc(w.levelNames[i]||defaultWizardLevelName(i,w.levelCount))}"></label>`).join('')}</div>`;
  }else{
    html=`<div class="level-wizard-summary"><strong>Шаг 4 — создание структуры</strong><br><span class="muted">Будет создан новый профиль и уровни. После этого мастер откроет пошаговую настройку первого уровня: карта → источники → перечитать → комнаты → зоны/датчики.</span></div>`+
      `<div class="wizard-review"><p><b>Профиль:</b> ${esc(w.profileName)}</p><p><b>Уровней:</b> ${esc(w.levelCount)}</p><ol>${w.levelNames.map(x=>`<li>${esc(x)}</li>`).join('')}</ol></div>`+
      `<p class="level-wizard-warning">Мастер не подтягивает старые источники, комнаты, зоны или картинки. Каждый уровень создаётся пустым и настраивается отдельно.</p>`;
  }
  body.innerHTML=stepsHead + html;
  const back=el('btn-project-setup-back'), next=el('btn-project-setup-next'), create=el('btn-project-setup-create');
  if(back) back.disabled=step<=1;
  if(next) next.classList.toggle('hidden', step>=4);
  if(create) create.classList.toggle('hidden', step<4);
}
function syncProjectSetupWizardInputs(){
  const w=ensureSetupWizardDefaults();
  const profile=el('setup-profile-name'); if(profile) w.profileName=profile.value.trim() || 'Дом';
  const count=el('setup-level-count');
  if(count){
    const old=w.levelCount; w.levelCount=normalizeWizardLevelCount(count.value);
    if(w.levelCount!==old){ for(let i=0;i<w.levelCount;i++) if(!w.levelNames[i]) w.levelNames[i]=defaultWizardLevelName(i,w.levelCount); w.levelNames=w.levelNames.slice(0,w.levelCount); }
  }
  qsa('[data-setup-level-name]').forEach(inp=>{ const i=Number(inp.dataset.setupLevelName); w.levelNames[i]=inp.value.trim() || defaultWizardLevelName(i,w.levelCount); });
}
function openProjectSetupWizard(){
  if(!canEditLayout()){ showToast('Мастер настройки доступен только в admin mode'); return; }
  state.setupWizard={step:1, profileName:'Дом', levelCount:1, levelNames:['1 этаж'], createdProfileId:null};
  renderProjectSetupWizard();
  openModal('project-setup-wizard-modal');
}
function closeProjectSetupWizard(){ closeModal('project-setup-wizard-modal'); }
function projectSetupNext(delta){
  syncProjectSetupWizardInputs();
  const w=ensureSetupWizardDefaults();
  w.step=clamp((Number(w.step)||1)+delta,1,4);
  renderProjectSetupWizard();
}
async function createProjectFromSetupWizard(){
  if(!canEditLayout()){ showToast('Мастер настройки доступен только в admin mode'); return; }
  syncProjectSetupWizardInputs();
  const w=ensureSetupWizardDefaults();
  const btn=el('btn-project-setup-create'); if(btn) btn.disabled=true;
  try{
    showToast('Создаю профиль...');
    const before=(state.profiles?.profiles||[]).map(p=>p.id);
    const profRes=await apiJson('api/profiles',{method:'POST',body:JSON.stringify({name:w.profileName})});
    const profiles=profRes.profiles||[];
    let newProfile=profiles.find(p=>!before.includes(p.id)) || profiles.slice(-1)[0];
    if(!newProfile) throw new Error('Новый профиль не найден после создания');
    await apiJson(`api/profiles/${encodeURIComponent(newProfile.id)}/activate`,{method:'POST'});
    state.profiles=await apiJson('api/profiles');
    state.levels=await apiJson('api/levels');
    const firstLevelId=state.levels?.activeLevelId || state.levels?.levels?.[0]?.id || 'level-1';
    await apiJson(`api/levels/${encodeURIComponent(firstLevelId)}`,{method:'PATCH',body:JSON.stringify({name:w.levelNames[0]||'Основной уровень'})});
    for(let i=1;i<w.levelCount;i++){
      await apiJson('api/levels',{method:'POST',body:JSON.stringify({name:w.levelNames[i]||defaultWizardLevelName(i,w.levelCount)})});
    }
    state.profiles=await apiJson('api/profiles');
    state.levels=await apiJson('api/levels');
    renderProfilesManager();
    renderLevelsManager();
    renderLevelSwitcher();
    closeProjectSetupWizard();
    await reloadActiveLevelRuntime();
    showToast('Структура создана. Открываю мастер первого уровня.');
    openSettingsPanel('levels');
    openLevelSetupWizard(firstLevelId);
  }catch(e){
    showToast('Ошибка мастера настройки: '+e.message);
  }finally{
    if(btn) btn.disabled=false;
  }
}

function levelWizardStep({num,title,ok,warning,body,actions}){
  return `<div class="level-wizard-step ${ok?'ok':'warn'}">`+
    `<div class="level-wizard-step-head"><span class="level-wizard-num">${num}</span><div><strong>${esc(title)}</strong>${ok?' <span class="level-wizard-badge ok">готово</span>':' <span class="level-wizard-badge warn">нужно настроить</span>'}</div></div>`+
    `<p class="muted">${esc(body||'')}</p>`+
    (warning?`<p class="level-wizard-warning">${esc(warning)}</p>`:'')+
    (actions?`<div class="level-wizard-step-actions">${actions}</div>`:'')+
    `</div>`;
}
function renderLevelSetupWizard(levelId){
  const body=el('level-setup-wizard-body');
  const title=el('level-setup-wizard-title');
  if(!body) return;
  const levels=state.levels?.levels || [];
  const activeId=state.levels?.activeLevelId || levels.find(l=>l.active)?.id || 'level-1';
  const level=levels.find(l=>l.id===levelId) || levels.find(l=>l.id===activeId);
  if(!level){ body.innerHTML='<p class="muted">Уровень не найден. Обновите список уровней.</p>'; return; }
  const st=level.status || {};
  const sc=level.sourceConfig || {};
  const sourceText=String(sc.dashboardPathText || (Array.isArray(sc.dashboardPaths)?sc.dashboardPaths.join('\n'):'') || '').trim();
  const isActive=level.id===activeId || level.active;
  if(title) title.textContent='Мастер настройки: '+(level.name||level.id);
  const activeWarn=isActive?'':'Этот уровень сейчас не активен. Для загрузки карты, проверки комнат, зон и датчиков мастер сначала переключит приложение на него.';
  const activateAction=isActive?'':`<button type="button" data-level-wizard-activate="${esc(level.id)}">Сделать текущим</button>`;
  const steps=[
    levelWizardStep({num:1,title:'Выбрать уровень',ok:isActive,warning:activeWarn,body:isActive?'Уровень активен. Можно настраивать карту, комнаты, зоны и датчики.':'Перед настройкой карты и зон лучше переключиться на этот уровень.',actions:activateAction}),
    levelWizardStep({num:2,title:'Карта уровня',ok:!!st.hasOverviewImage,body:st.hasOverviewImage?'Карта уровня загружена.':'Загрузите отдельную overview-карту для этого этажа/области. Пустой уровень не должен копировать карту другого уровня без явной галки.',actions:`<button type="button" data-level-wizard-images="${esc(level.id)}">Открыть загрузку карты</button>`}),
    levelWizardStep({num:3,title:'Источники Lovelace',ok:!!st.hasSources || !!sourceText,body:(st.hasSources||sourceText)?`Задано источников: ${Number(st.sourcesCount||sourceText.split(/\n+/).filter(Boolean).length||0)}. Источники хранятся отдельно для каждого уровня.`:'Укажите dashboard/panel/card sources именно для этого уровня. Старые источники других уровней не подтягиваются.',actions:`<button type="button" data-level-wizard-sources="${esc(level.id)}">Настроить источники</button>`}),
    levelWizardStep({num:4,title:'Перечитать уровень',ok:Number(st.devicesCount||0)>0 || Number(st.roomsCount||0)>0,body:`Сейчас найдено устройств: ${Number(st.devicesCount||0)}, комнат: ${Number(st.roomsCount||0)}. Перечитывание должно затрагивать только этот уровень.`,actions:`<button type="button" data-level-wizard-import="${esc(level.id)}">Перечитать этот уровень</button>`}),
    levelWizardStep({num:5,title:'Комнаты',ok:Number(st.roomsCount||0)>0,body:Number(st.roomsCount||0)>0?`Найдено комнат: ${Number(st.roomsCount||0)}. Проверьте названия и картинки комнат.`:'Комнаты появятся после импорта Lovelace/HA sources. Имена картинок не должны создавать комнаты.',actions:`<button type="button" data-level-wizard-rooms="${esc(level.id)}">Проверить комнаты</button>`}),
    levelWizardStep({num:6,title:'Зоны и стандартные датчики',ok:Number(st.zonesCount||0)>0,body:`Зон создано: ${Number(st.zonesCount||0)}. Стандартные датчики задаются вручную по комнатам и не появляются из hardcode.`,actions:`<button type="button" data-level-wizard-zones="${esc(level.id)}">Настроить зоны / датчики</button>`})
  ];
  body.innerHTML=`<div class="level-wizard-summary"><strong>${esc(level.name||level.id)}</strong><br><span class="muted">${esc(level.id)} · ${isActive?'текущий уровень':'не текущий уровень'}</span></div>`+steps.join('')+`<div class="level-wizard-finish"><strong>Финал</strong><p class="muted">Когда карта, источники, комнаты, зоны и датчики готовы, переходите на карту. Мастер можно открыть повторно из настроек.</p><button type="button" id="btn-level-wizard-map">Перейти на карту</button></div><p class="muted level-wizard-note">Мастер ничего не делает скрыто: каждый шаг открывает нужный раздел или запускает явное действие по кнопке.</p>`;
  const mapBtn=el('btn-level-wizard-map'); if(mapBtn) mapBtn.onclick=()=>{ closeModal('level-setup-wizard-modal'); closeModal('settings-modal'); selectRoom('overview'); };
}
function openLevelSetupWizard(levelId){
  if(!levelId) return;
  state.levelSetupWizardId=levelId;
  hideWizardReturn();
  renderLevelSetupWizard(levelId);
  openModal('level-setup-wizard-modal');
}
async function ensureWizardLevelActive(levelId){
  if(levelId && levelId !== (state.levels?.activeLevelId || 'level-1')){
    await activateLevelSmooth(levelId, {fromSettings:true});
    await loadLevelsInfo();
  }
}
async function openWizardPanel(levelId, panel){
  state.levelSetupWizardId = levelId || state.levelSetupWizardId;
  closeModal('level-setup-wizard-modal');
  openModal('settings-modal');
  if(panel==='images' || panel==='rooms') await ensureWizardLevelActive(levelId);
  openSettingsPanel(panel);
  const labels={images:'↩ Вернуться в мастер после загрузки карты', rooms:'↩ Вернуться в мастер после проверки комнат/зон'};
  showWizardReturn(levelId, labels[panel] || '↩ Вернуться в мастер настройки');
}
function focusLevelSources(levelId){
  state.levelSetupWizardId = levelId || state.levelSetupWizardId;
  closeModal('level-setup-wizard-modal');
  openModal('settings-modal');
  openSettingsPanel('levels');
  showWizardReturn(levelId, '↩ Вернуться в мастер после настройки источников');
  setTimeout(()=>{
    const row=document.querySelector(`[data-level-row="${CSS.escape(levelId)}"]`);
    const details=row?.querySelector('.level-source-details');
    if(details) details.open=true;
    const ta=row?.querySelector(`[data-level-source-paths="${CSS.escape(levelId)}"]`);
    if(row) row.scrollIntoView({block:'center', behavior:'smooth'});
    if(ta) ta.focus();
  }, 80);
}
function showWizardReturn(levelId, label){
  state.levelSetupWizardId = levelId || state.levelSetupWizardId;
  const btn=el('wizard-return-button');
  if(!btn) return;
  btn.dataset.returnLevelWizard = state.levelSetupWizardId || '';
  btn.textContent = label || '↩ Вернуться в мастер настройки';
  btn.classList.remove('hidden');
}
function hideWizardReturn(){
  const btn=el('wizard-return-button');
  if(btn) btn.classList.add('hidden');
}
async function returnToLevelSetupWizard(){
  const levelId = el('wizard-return-button')?.dataset.returnLevelWizard || state.levelSetupWizardId;
  if(!levelId){ hideWizardReturn(); return; }
  await loadLevelsInfo();
  openLevelSetupWizard(levelId);
  hideWizardReturn();
}
async function initializeLevelFromSettings(levelId){
  if(!levelId) return;
  openLevelSetupWizard(levelId);
}

async function renameLevelFromSettings(levelId){
  if(!canEditLayout()){ showToast('Уровни доступны только в admin mode'); return; }
  const current=state.levels?.levels?.find(l=>l.id===levelId);
  const name=window.prompt('Новое название уровня/области', current?.name || levelId);
  if(name===null) return;
  try{ state.levels=await apiJson(`api/levels/${encodeURIComponent(levelId)}`,{method:'PATCH',body:JSON.stringify({name})}); renderLevelsManager(); showToast('Уровень переименован'); }
  catch(e){ showToast('Ошибка переименования уровня: '+e.message); }
}
async function deleteLevelFromSettings(levelId){
  if(!canEditLayout()){ showToast('Уровни доступны только в admin mode'); return; }
  const list=state.levels?.levels || [];
  if(list.length<=1){ showToast('Нельзя удалить последний уровень'); return; }
  const current=list.find(l=>l.id===levelId);
  if(!confirm(`Удалить уровень "${current?.name||levelId}"? Перед удалением будет создан backup уровня.`)) return;
  const word=window.prompt('Для удаления введите DELETE');
  if(word !== 'DELETE'){ showToast('Удаление отменено'); return; }
  try{
    const wasActive=levelId === (state.levels?.activeLevelId || 'level-1');
    const res=await apiJson(`api/levels/${encodeURIComponent(levelId)}`,{method:'DELETE'});
    state.levels=res; renderLevelsManager(); showToast('Уровень удалён. Backup: '+(res.backup||'—'));
    if(wasActive) setTimeout(()=>location.reload(),700);
  }catch(e){ showToast('Ошибка удаления уровня: '+e.message); }
}

async function loadImagesInfo(){
  try{
    state.images = await apiJson('api/images');
    renderImagesSettings();
    renderRoomImagesSettings();
    return state.images;
  }catch(e){
    state.images = null;
    const box = el('overview-image-status');
    if(box) box.textContent = 'Ошибка чтения images storage: ' + e.message;
    return null;
  }
}

async function loadRoomsSettings(){
  try{
    state.roomsSettings = await apiJson('api/rooms');
    refreshRuntimeRooms();
    renderRooms();
    renderRoomsZonesManager();
    renderLayoutMaintenanceTools();
    return state.roomsSettings;
  }catch(e){
    state.roomsSettings = {version:1, rooms:{}};
    const box=el('rooms-zones-manager');
    if(box) box.innerHTML='<p class="muted">Ошибка чтения rooms.json: '+esc(e.message)+'</p>';
    return state.roomsSettings;
  }
}

function standardSensorDraftKey(roomId, key){ return `${normalizedRoomId(roomId)}::${key}`; }
function ensureStandardSensorDrafts(){ if(!state.standardSensorDrafts || typeof state.standardSensorDrafts!=='object') state.standardSensorDrafts={}; return state.standardSensorDrafts; }
function rememberStandardSensorInput(input){
  const card=input?.closest?.('[data-room-manager]');
  const key=input?.dataset?.standardSensorInput;
  const roomId=card?.dataset?.roomManager;
  if(!roomId || !key) return;
  ensureStandardSensorDrafts()[standardSensorDraftKey(roomId,key)] = input.value;
}
function rememberAllStandardSensorInputs(){
  qsa('#rooms-zones-manager [data-standard-sensor-input]').forEach(rememberStandardSensorInput);
}
function isEditingStandardSensorInputs(){
  const active=document.activeElement;
  return !!(active && active.closest && active.closest('#rooms-zones-manager') && active.matches('[data-standard-sensor-input]'));
}
function standardSensorsForSettings(roomId){ return state.roomsSettings?.rooms?.[normalizedRoomId(roomId)]?.standardSensors || {}; }
function standardSensorInputValue(roomId, key, savedValue){
  const drafts=ensureStandardSensorDrafts();
  const k=standardSensorDraftKey(roomId,key);
  return Object.prototype.hasOwnProperty.call(drafts,k) ? drafts[k] : (savedValue || '');
}

function renderRoomsZonesManager(){
  const box=el('rooms-zones-manager');
  if(!box) return;
  if(isEditingStandardSensorInputs()){
    rememberAllStandardSensorInputs();
    return;
  }
  rememberAllStandardSensorInputs();
  const admin = canEditLayout();
  const rooms=layoutEditableRooms();
  if(!rooms.length){ box.innerHTML='<p class="muted">Комнаты пока не найдены. Список комнат появится только после настройки источников текущего уровня и сканирования Lovelace / HA Areas / entity names.</p>'; return; }
  box.innerHTML=rooms.map(r=>{
    const rid=normalizedRoomId(r.id);
    const hasZone=!!state.layout?.zones?.[rid];
    const sensors=standardSensorsForSettings(rid);
    const active=STANDARD_SENSOR_DEFS.filter(def=>String(sensors[def.key]||'').trim()).map(def=>def.label).join(', ') || 'не заданы';
    const fields=STANDARD_SENSOR_DEFS.map(def=>`<label class="standard-sensor-field"><span>${esc(def.label)}</span><input type="text" value="${esc(standardSensorInputValue(rid, def.key, sensors[def.key]||''))}" placeholder="${esc(def.placeholder)}" data-standard-sensor-input="${esc(def.key)}"><button type="button" data-clear-standard-sensor="${esc(def.key)}">Очистить</button></label>`).join('');
    const open = state.openStandardSensorRooms instanceof Set && state.openStandardSensorRooms.has(rid);
    return `<div class="room-manager-card${admin?'':' room-manager-disabled'}" data-room-manager="${esc(rid)}">`+
      `<div class="room-manager-head"><div><strong>${esc(r.label||rid)}</strong><br><span class="muted">room_id: ${esc(rid)} · зона: ${hasZone?'есть':'нет'} · датчики: ${esc(active)}</span></div>`+
      `<div class="room-manager-actions"><button type="button" data-room-zone-create="${esc(rid)}">${hasZone?'Редактировать зону':'Назначить / пересоздать зону'}</button>${hasZone?`<button type="button" data-room-zone-delete="${esc(rid)}" class="danger-button small-danger">Удалить зону</button>`:''}</div></div>`+
      `<details class="standard-sensors-details" data-standard-details="${esc(rid)}" ${open?'open':''}><summary>Стандартные датчики комнаты</summary><div class="standard-sensors-grid">${fields}</div><p class="muted">Пустые entity не отображаются. Если очистить все entity, строка/поле стандартных датчиков этой комнаты на карте не показывается. Entity можно отредактировать вручную.</p><button type="button" data-save-standard-sensors="${esc(rid)}">Сохранить датчики</button></details>`+
      `</div>`;
  }).join('');
  qsa('button,input', box).forEach(ctrl=>ctrl.disabled=!admin);
  qsa('[data-standard-details]', box).forEach(d=>d.addEventListener('toggle',()=>{
    if(!(state.openStandardSensorRooms instanceof Set)) state.openStandardSensorRooms=new Set();
    const rid=d.dataset.standardDetails;
    if(d.open) state.openStandardSensorRooms.add(rid); else state.openStandardSensorRooms.delete(rid);
  }));
  qsa('[data-standard-sensor-input]', box).forEach(input=>{
    input.addEventListener('input',()=>rememberStandardSensorInput(input));
    input.addEventListener('focus',()=>rememberStandardSensorInput(input));
  });
}
function readStandardSensorInputs(roomId){
  const card=document.querySelector(`[data-room-manager="${CSS.escape(roomId)}"]`);
  const standardSensors={};
  if(!card) return standardSensors;
  STANDARD_SENSOR_DEFS.forEach(def=>{
    const v=card.querySelector(`[data-standard-sensor-input="${CSS.escape(def.key)}"]`)?.value?.trim() || '';
    if(v) standardSensors[def.key]=v;
  });
  return standardSensors;
}
async function saveRoomStandardSensors(roomId){
  if(!canEditLayout()){ showToast('Настройка датчиков доступна только в admin mode'); return; }
  const standardSensors=readStandardSensorInputs(roomId);
  try{
    state.roomsSettings = await apiJson(`api/rooms/${encodeURIComponent(roomId)}/standard-sensors`, { method:'PATCH', body:JSON.stringify({standardSensors}) });
    if(state.standardSensorDrafts){ STANDARD_SENSOR_DEFS.forEach(def=>delete state.standardSensorDrafts[standardSensorDraftKey(roomId, def.key)]); }
    renderRoomsZonesManager();
    render();
    showToast(Object.keys(standardSensors).length ? 'Стандартные датчики сохранены' : 'Все стандартные датчики комнаты очищены');
  }catch(e){ showToast('Ошибка сохранения датчиков: '+e.message); }
}
function clearStandardSensorInput(roomId, key){
  const card=document.querySelector(`[data-room-manager="${CSS.escape(roomId)}"]`);
  const input=card?.querySelector(`[data-standard-sensor-input="${CSS.escape(key)}"]`);
  if(input){ input.value=''; rememberStandardSensorInput(input); }
}
function deleteRoomZoneFromSettings(roomId){
  if(!canEditLayout()){ showToast('Удаление зоны доступно только в admin mode'); return; }
  const r=room(roomId);
  if(!confirm(`Удалить зону комнаты "${r?.label||roomId}"? Маркеры и датчики не удаляются.`)) return;
  if(state.layout.zones) delete state.layout.zones[roomId];
  state.layoutDirty=true;
  render();
  renderRoomsZonesManager();
  renderLayoutMaintenanceTools();
  showToast('Зона удалена. Нажмите “Сохранить изменения” в edit mode, чтобы записать layout.');
}
function renderImagesSettings(){
  const box = el('overview-image-status');
  if(!box) return;
  const overview = state.images?.overview;
  if(!overview){ box.textContent = 'Нет данных о картинке общего плана'; return; }
  const mode = overview.mode === 'custom' ? 'custom' : 'fallback';
  const size = overview.processedWidth && overview.processedHeight ? `${overview.processedWidth}×${overview.processedHeight}` : 'размер неизвестен';
  const original = overview.originalWidth && overview.originalHeight && overview.mode === 'custom' ? ` · original ${overview.originalWidth}×${overview.originalHeight}` : '';
  const fmt = overview.format ? ` · ${overview.format}` : '';
  const ratio = overview.aspectRatio ? ` · aspect ${overview.aspectRatio}` : '';
  const converter = overview.converter ? ` · ${overview.converter}` : '';
  box.textContent = `Текущая картинка: ${mode} · ${size}${original}${fmt}${ratio}${converter}`;
}

function imageStatusText(info){
  if(!info) return 'нет данных';
  const mode = info.mode === 'custom' ? 'custom' : 'fallback';
  const size = info.processedWidth && info.processedHeight ? `${info.processedWidth}×${info.processedHeight}` : 'размер неизвестен';
  const original = info.originalWidth && info.originalHeight && info.mode === 'custom' ? ` · original ${info.originalWidth}×${info.originalHeight}` : '';
  const fmt = info.format ? ` · ${info.format}` : '';
  const ratio = info.aspectRatio ? ` · aspect ${info.aspectRatio}` : '';
  const converter = info.converter ? ` · ${info.converter}` : '';
  return `${mode} · ${size}${original}${fmt}${ratio}${converter}`;
}
function renderRoomImagesSettings(){
  const box = el('room-images-list');
  if(!box) return;
  const rooms = ROOMS.filter(r=>r.id !== 'overview');
  if(!rooms.length){ box.innerHTML = '<p class="muted">Комнаты пока не найдены.</p>'; return; }
  box.innerHTML = rooms.map(r=>{
    const info = state.images?.rooms?.[r.id];
    return `<div class="image-card room-image-card" data-room-image-card="${esc(r.id)}">`+
      `<div><strong>${esc(r.label||r.id)}</strong><br><span class="muted">room_id: ${esc(r.id)} · ${esc(imageStatusText(info))}</span></div>`+
      `<div class="image-buttons"><button type="button" data-upload-room-image="${esc(r.id)}">Загрузить / заменить</button><button type="button" data-reset-room-image="${esc(r.id)}">Сбросить к fallback</button></div>`+
      `</div>`;
  }).join('');
}

function imageFileDimensions(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{ const out={width:img.naturalWidth||img.width,height:img.naturalHeight||img.height,aspectRatio:(img.naturalWidth||img.width)/(img.naturalHeight||img.height)}; URL.revokeObjectURL(url); resolve(out); };
    img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать размеры картинки')); };
    img.src=url;
  });
}
function showAspectDecision(kind, oldRatio, newRatio){
  return new Promise(resolve=>{
    const old=document.getElementById('aspect-warning-modal'); if(old) old.remove();
    const modal=document.createElement('div');
    modal.id='aspect-warning-modal';
    modal.className='modal';
    modal.innerHTML=`<div class="modal-card"><div class="modal-head"><h2>Изменилось соотношение сторон</h2></div><div class="info-content"><p>Новая картинка имеет другое соотношение сторон. Маркеры и зоны могут визуально сместиться.</p><p class="muted">Текущее: ${Number(oldRatio).toFixed(3)} · новое: ${Number(newRatio).toFixed(3)}</p></div><div class="modal-actions"><button type="button" data-aspect-choice="backup">Бэкап и продолжить</button><button type="button" data-aspect-choice="continue">Продолжить</button><button type="button" data-aspect-choice="cancel">Отмена</button></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{
      const btn=e.target.closest('[data-aspect-choice]');
      if(!btn && e.target!==modal) return;
      const choice=btn ? btn.dataset.aspectChoice : 'cancel';
      modal.remove();
      resolve(choice);
    });
  });
}
async function askImageBackupIfAspectChanged(kind, file, currentInfo){
  if(!currentInfo || currentInfo.mode!=='custom' || !currentInfo.aspectRatio) return {cancel:false, backup:false};
  try{
    const dim=await imageFileDimensions(file);
    if(dim.aspectRatio && Math.abs(Number(currentInfo.aspectRatio)-dim.aspectRatio)>0.01){
      const choice=await showAspectDecision(kind, Number(currentInfo.aspectRatio), dim.aspectRatio);
      if(choice==='cancel') return {cancel:true, backup:false};
      return {cancel:false, backup:choice==='backup'};
    }
  }catch(e){}
  return {cancel:false, backup:false};
}

async function uploadOverviewImage(file){
  if(!file) return;
  const typeOk = /^image\/(png|jpeg|webp)$/i.test(file.type || '');
  const nameOk = /\.(png|jpe?g|webp)$/i.test(file.name || '');
  if(!typeOk && !nameOk){ showToast('Поддерживаются PNG, JPG и WEBP'); return; }
  if(file.size > 25 * 1024 * 1024){ showToast('Файл слишком большой. Максимум 25 MB.'); return; }
  const decision = await askImageBackupIfAspectChanged('overview', file, state.images?.overview);
  if(decision.cancel){ showToast('Замена картинки отменена'); return; }
  const status = el('overview-image-status');
  if(status) status.textContent = 'Загрузка общего плана...';
  try{
    const res = await fetch('api/images/overview'+(decision.backup?'?backup=1':''), { method:'POST', headers:{ 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || 'overview') }, body:file });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || res.status);
    state.images = { ...(state.images||{}), ...data };
    await loadImagesInfo();
    const img = el('overview-image');
    if(img) img.src = overviewImageSrc();
    fitStage('overview');
    render();
    showToast(data.backup ? 'Общий план заменён. Backup создан.' : 'Общий план заменён.');
  }catch(e){
    if(status) status.textContent = 'Ошибка загрузки: ' + e.message;
    showToast('Ошибка загрузки общего плана: ' + e.message);
  }
}
async function resetOverviewImage(){
  if(!confirm('Сбросить пользовательскую картинку общего плана к fallback? Layout и маркеры сохранятся, но могут визуально не совпадать с fallback-планом. Backup автоматически не создаётся.')) return;
  const status = el('overview-image-status');
  if(status) status.textContent = 'Сброс картинки общего плана...';
  try{
    const data = await apiJson('api/images/overview', { method:'DELETE' });
    state.images = { ...(state.images||{}), ...data };
    await loadImagesInfo();
    const img = el('overview-image');
    if(img) img.src = overviewImageSrc();
    fitStage('overview');
    render();
    showToast('Общий план сброшен к fallback.');
  }catch(e){
    if(status) status.textContent = 'Ошибка сброса: ' + e.message;
    showToast('Ошибка сброса картинки: ' + e.message);
  }
}

function validateImageFileForUpload(file){
  if(!file) return 'Файл не выбран';
  const typeOk = /^image\/(png|jpeg|webp)$/i.test(file.type || '');
  const nameOk = /\.(png|jpe?g|webp)$/i.test(file.name || '');
  if(!typeOk && !nameOk) return 'Поддерживаются PNG, JPG и WEBP';
  if(file.size > 25 * 1024 * 1024) return 'Файл слишком большой. Максимум 25 MB.';
  return '';
}
function cacheBustedImageUrl(src, token){
  const base = String(src || '');
  const sep = base.includes('?') ? '&' : '?';
  return base + sep + 't=' + encodeURIComponent(token || Date.now());
}
function roomImageSrc(roomId){
  const info = state.images?.rooms?.[roomId];
  const src = info?.src || room(roomId)?.image || `media/images/rooms/${encodeURIComponent(roomId)}.webp`;
  return cacheBustedImageUrl(src, info?.cacheToken || 'pending');
}
function overviewImageSrc(){
  const info = state.images?.overview;
  return cacheBustedImageUrl(info?.src || 'media/images/overview.webp', info?.cacheToken || 'pending');
}
function refreshRoomImageIfOpen(roomId){
  if(state.selectedRoom !== roomId) return;
  const img = el('room-image');
  if(img) img.src = roomImageSrc(roomId);
  fitStage('room');
  renderRoom();
}
async function uploadRoomImage(roomId, file){
  const validationError = validateImageFileForUpload(file);
  if(validationError){ showToast(validationError); return; }
  const decision = await askImageBackupIfAspectChanged('room', file, state.images?.rooms?.[roomId]);
  if(decision.cancel){ showToast('Замена картинки отменена'); return; }
  const card = document.querySelector(`[data-room-image-card="${CSS.escape(roomId)}"] .muted`);
  if(card) card.textContent = `room_id: ${roomId} · загрузка...`;
  try{
    const res = await fetch(`api/images/rooms/${encodeURIComponent(roomId)}${decision.backup?'?backup=1':''}`, { method:'POST', headers:{ 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name || roomId) }, body:file });
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error || res.status);
    await loadImagesInfo();
    refreshRoomImageIfOpen(roomId);
    showToast(data.backup ? 'Картинка комнаты заменена. Backup создан.' : 'Картинка комнаты заменена.');
  }catch(e){
    await loadImagesInfo();
    showToast('Ошибка загрузки картинки комнаты: ' + e.message);
  }
}
async function resetRoomImage(roomId){
  const r = room(roomId);
  if(!confirm(`Сбросить пользовательскую картинку комнаты "${r?.label||roomId}" к fallback? Layout и маркеры сохранятся, но могут визуально не совпадать с fallback-картинкой. Backup автоматически не создаётся.`)) return;
  try{
    await apiJson(`api/images/rooms/${encodeURIComponent(roomId)}`, { method:'DELETE' });
    await loadImagesInfo();
    refreshRoomImageIfOpen(roomId);
    showToast('Картинка комнаты сброшена к fallback.');
  }catch(e){
    showToast('Ошибка сброса картинки комнаты: ' + e.message);
  }
}


async function loadBackupsInfo(){
  try{ state.backups=await apiJson('api/backups'); renderBackupManager(); return state.backups; }
  catch(e){ const box=el('backup-manager'); if(box) box.innerHTML='<p class="muted">Ошибка чтения backup-ов: '+esc(e.message)+'</p>'; }
}
function renderBackupManager(){
  const box=el('backup-manager'); if(!box) return;
  const data=state.backups?.backups || state.diagnostics?.backups || {items:[]};
  const items=Array.isArray(data.items)?data.items:[];
  box.innerHTML=`<div class="backup-summary"><strong>Backup-файлов:</strong> ${data.count||items.length} · <strong>Размер:</strong> ${formatBytes(data.totalSize||0)}<br><span class="muted">Старый: ${data.oldest?esc(new Date(data.oldest).toLocaleString()):'—'} · Новый: ${data.newest?esc(new Date(data.newest).toLocaleString()):'—'}</span></div>`+
    `<div class="backup-actions"><button type="button" id="btn-create-manual-backup">Создать backup сейчас</button><button type="button" id="btn-delete-old-backups">Очистить старые backup-и</button><button type="button" id="btn-delete-all-backups" class="danger-button">Удалить все backup-и</button></div>`+
    `<div class="backup-list">${items.slice(0,50).map(b=>`<div class="backup-row"><div><b>${esc(b.name)}</b><br><span>${esc(b.type||'file')} · ${esc(new Date(b.mtime).toLocaleString())} · ${formatBytes(b.size)}</span></div><div><button data-delete-backup="${esc(b.name)}">Удалить</button></div></div>`).join('') || '<p class="muted">Backup пока нет.</p>'}</div>`;
}
async function createManualBackup(){
  try{ state.backups=await apiJson('api/backups/create',{method:'POST',body:JSON.stringify({reason:'manual'})}); renderBackupManager(); showToast('Ручной backup создан'); }
  catch(e){ showToast('Ошибка создания backup: '+e.message); }
}
async function deleteBackup(name){
  if(!confirm('Удалить backup '+name+'? Активные данные не будут затронуты.')) return;
  try{ state.backups=await apiJson('api/backups/delete',{method:'POST',body:JSON.stringify({name})}); renderBackupManager(); showToast('Backup удалён'); }
  catch(e){ showToast('Ошибка удаления backup: '+e.message); }
}

async function restoreFullBackup(name){
  if(!confirm('Восстановить backup '+name+'? Текущие данные будут сохранены в предоперационный backup, затем заменены содержимым выбранного backup.')) return;
  const word=window.prompt('Для восстановления введите RESTORE BACKUP');
  if(word!=='RESTORE BACKUP'){ showToast('Восстановление отменено'); return; }
  try{
    const res=await apiJson('api/backups/restore-full',{method:'POST',body:JSON.stringify({name,confirm:word})});
    state.backups={ok:true,backups:res.backups};
    renderBackupManager();
    showToast('Backup восстановлен. Перезагрузка...');
    setTimeout(()=>location.reload(),900);
  }catch(e){ showToast('Ошибка восстановления backup: '+e.message); }
}
async function deleteOldBackups(){
  if(!confirm('Удалить старые backup-и, оставив последние 10?')) return;
  try{ state.backups=await apiJson('api/backups/delete-old',{method:'POST',body:JSON.stringify({keep:10})}); renderBackupManager(); showToast('Старые backup-и очищены'); }
  catch(e){ showToast('Ошибка очистки backup: '+e.message); }
}
async function deleteAllBackups(){
  const word=window.prompt('Для удаления всех backup-ов введите DELETE BACKUPS');
  if(word!=='DELETE BACKUPS') return;
  try{ state.backups=await apiJson('api/backups/delete-all',{method:'POST',body:JSON.stringify({confirm:word})}); renderBackupManager(); showToast('Все backup-и удалены'); }
  catch(e){ showToast('Ошибка удаления backup-ов: '+e.message); }
}

async function clearLayoutMarkers(){
  if(!canEditLayout()){ showToast('Очистка маркеров доступна только в admin mode'); return; }
  if(!confirm('Очистить все маркеры устройств и датчиков? Перед очисткой будет создан backup layout.json. Зоны, комнаты, картинки, PIN, dangerous и Attention не будут затронуты.')) return;
  try{
    const r=await apiJson('api/layout/clear-markers', { method:'POST' });
    state.layout = { ...state.layout, ...(r.layout||{}) };
    render();
    renderLayoutMaintenanceTools();
    showToast('Маркеры очищены. Backup: '+(r.backup||'—'));
  }catch(e){ showToast('Ошибка очистки маркеров: '+e.message); }
}
async function clearLayoutZones(){
  if(!canEditLayout()){ showToast('Очистка зон доступна только в admin mode'); return; }
  if(!confirm('Очистить все зоны комнат на общем плане? Перед очисткой будет создан backup layout.json. Маркеры, комнаты, картинки, PIN, dangerous и Attention не будут затронуты.')) return;
  try{
    const r=await apiJson('api/layout/clear-zones', { method:'POST' });
    state.layout = { ...state.layout, ...(r.layout||{}) };
    render();
    renderLayoutMaintenanceTools();
    showToast('Зоны очищены. Backup: '+(r.backup||'—'));
  }catch(e){ showToast('Ошибка очистки зон: '+e.message); }
}
function layoutEditableRooms(){
  return ROOMS.filter(r=>r && r.id && normalizedRoomId(r.id)!=='overview');
}
function renderZoneCreateSelect(){
  const sel=el('zone-create-room');
  if(!sel) return;
  const current=sel.value;
  const rooms=layoutEditableRooms();
  sel.innerHTML=rooms.map(r=>{
    const rid=normalizedRoomId(r.id);
    const has=!!state.layout?.zones?.[rid];
    return `<option value="${esc(rid)}">${esc(r.label||rid)}${has?' · зона есть':' · зоны нет'}</option>`;
  }).join('');
  if(current && rooms.some(r=>normalizedRoomId(r.id)===current)) sel.value=current;
}
function closeSettingsModal(){ const m=el('settings-modal'); if(m) m.classList.add('hidden'); }
function startEditModeForLayoutTool(){
  if(!canEditLayout()){ showToast('Доступно только в admin mode'); return false; }
  if(!state.edit) enterEditMode();
  return !!state.edit;
}
function createZoneFromSettings(){
  if(!startEditModeForLayoutTool()) return;
  const rid=el('zone-create-room')?.value || layoutEditableRooms()[0]?.id;
  if(!rid){ showToast('Нет найденных комнат для создания зоны'); return; }
  state.selectedRoom='overview';
  closeSettingsModal();
  render();
  openZoneLayoutEditor(rid);
}
function openMarkerPlacementFromSettings(){
  if(!startEditModeForLayoutTool()) return;
  closeSettingsModal();
  render();
  openDevicePicker();
}
function renderLayoutMaintenanceTools(){
  const box=el('layout-maintenance-tools');
  if(!box) return;
  const admin=canEditLayout();
  box.classList.toggle('layout-tools-disabled', !admin);
  renderZoneCreateSelect();
  renderRoomsZonesManager();
  qsa('button,select', box).forEach(ctrl=>ctrl.disabled=!admin);
  const status=el('layout-maintenance-status');
  if(status) status.textContent = admin ? 'Admin mode. Перед очисткой создаётся backup layout.json. Создание зон и маркеров открывает SVG Layout Editor.' : 'Доступно только в admin mode.';
}

async function saveConfig(){
  const status=el('settings-status');
  try{
    status.textContent='Сохраняю настройки add-on...';
    saveUiPrefs();
    const sec = buildSecurityConfigPayload();
    if(sec.security) delete sec.security.panelMode; // per-client
    const payload={pollIntervalMs:Math.max(2000,Number(el('poll-interval')?.value||6)*1000),...buildGlobalConfigPayload(),...sec};
    const res=await apiJson('api/config',{method:'POST',body:JSON.stringify(payload)});
    state.config=res.config||state.config;
    saveClientPrefs().catch(()=>{});
    status.textContent='Настройки сохранены. Проверяю подключение к Home Assistant...';
    await testConnection({keepModal:true});
    status.textContent='Настройки сохранены.';
    closeModal('settings-modal');
  }catch(e){
    status.textContent='Ошибка сохранения настроек: '+e.message;
    setConnection(false,'Ошибка настроек');
  }
}
function applyFactoryResetClientState(res={}){
  window.ALL_DEVICES = [];
  window.DEVICES = [];
  window.LOVELACE_SOURCE = { version:1, views:[] };
  state.selectedRoom = 'overview';
  state.states = {};
  state.sourceConfig = defaultSourceConfig();
  state.layout = res.layout || { version:8, coordinateSpace:'room-content-box', overviewRoomSync:false, roomCoordinateMigrated:{}, overviewMarkers:{}, roomMarkers:{}, overviewMetrics:{}, roomMetrics:{}, zones:{}, customNames:{} };
  state.roomsSettings = { version:1, rooms:{}, knownRooms:[] };
  state.images = { version:1, overview:null, rooms:{} };
  state.profiles = res.profiles || null;
  state.levels = res.levels || null;
  state.serverUiState = res.uiState || null;
  state.ui = { ...state.ui, hideSidebar:true, hideDevicePanel:true, hideToolbar:false, kioskMode:false, mobileMode:true, autoHide:false, compact:false, showZones:true, invisibleZones:false, showMarkers:true, showSensors:true };
  if(res.uiState && res.uiState.ui){ state.ui = { ...state.ui, ...pickKeys(res.uiState.ui, DEVICE_UI_KEYS), hideSidebar:true, hideDevicePanel:true }; }
  try{
    ['ui_prefs','last_view','viewport_prefs','kiosk_locked','card_font_size'].forEach(k=>localStorage.removeItem(k));
    sessionStorage.clear();
  }catch(e){}
  state.viewport = { overview:{zoom:1,panX:0,panY:0}, rooms:{} };
  refreshRuntimeRooms();
  applyUiPrefs();
  render();
}
async function clearConfig(){
  const status=el('settings-status');
  const message = 'Будут удалены все пользовательские настройки, комнаты, устройства, зоны, маркеры, картинки, источники Lovelace/панелей, данные импорта, Attention, dangerous-правила и пользовательский PIN. Перед сбросом будет создан backup текущего runtime-состояния. Продолжить?';
  if(!confirm(message)) return;
  const word=window.prompt('Для полного сброса введите RESET');
  if(word !== 'RESET'){ status.textContent='Сброс отменён.'; return; }
  try{
    status.textContent='Выполняю полный сброс проекта...';
    const res=await apiJson('api/factory-reset',{method:'POST',body:JSON.stringify({confirm:'RESET'})});
    applyFactoryResetClientState(res);
    status.textContent='Полный сброс выполнен. Backup: '+(res.backup||'создан/не требовался')+'. Перезагрузка страницы...';
    showToast('Проект полностью сброшен к дефолту');
    setTimeout(()=>{ location.href = location.pathname + '?reset=' + Date.now(); }, 900);
  }catch(e){
    status.textContent='Ошибка полного сброса: '+e.message;
  }
}
async function testConnection(options={}){try{await apiJson('api/ha/test');setConnection(true,'Подключено');if(!options.keepModal)closeModal('settings-modal');await loadStates();startPolling();el('settings-status').textContent=options.keepModal?'Add-on подключен к HA.':'Подключено.'}catch(e){setConnection(false,'Ошибка подключения');el('settings-status').textContent=e.message}}
async function loadStates(){try{const data=await apiJson('api/ha/states');state.states=Object.fromEntries(data.states.map(s=>[s.entity_id,s]));applySourceConfig();refreshRuntimeRooms();updateAttentionFromStates();if(!state.edit && !state.livePaused) render();const sseOpen=state._sseSource&&state._sseSource.readyState===1;if(_mobileAuth.active) _mobileHideOffline();if(state.edit)setConnection(true,'Редактор · live paused');else if(sseOpen)setConnection(true,'Live ●','live');else setConnection(true,'Поллинг ↺','polling')}catch(e){setConnection(false,'Нет связи ✗');console.error(e);if(_mobileAuth.active){_mobileOfflineCount++;if(_mobileOfflineCount>=2)_mobileShowOffline();}}}
function startPolling(){
  if(state.pollTimer)clearInterval(state.pollTimer);
  if(state.edit || state.livePaused) return;
  // Если SSE активен — поллинг раз в 60 с (страховка), иначе — по настройке
  // readyState 1 = OPEN; если SSE работает — поллинг только как fallback раз в 60 с
  const interval = (state._sseSource && state._sseSource.readyState===1) ? 60_000 : (state.config?.pollIntervalMs||6000);
  state.pollTimer=setInterval(loadStates, interval);
}

/* ── SSE подписка (real-time state_changed от сервера) ─────────── */
(function(){
  let retryTimer=null;
  // Батч-рендер: если несколько state_changed подряд — рендерим один раз
  let pendingRender=false;
  let renderTimer=null;
  function scheduleRender(){
    pendingRender=true;
    clearTimeout(renderTimer);
    renderTimer=setTimeout(()=>{
      if(!pendingRender) return;
      pendingRender=false;
      applySourceConfig(); refreshRuntimeRooms(); updateAttentionFromStates();
      if(!state.edit && !state.livePaused) render();
    }, 80);
  }

  function connectSse(){
    if(state._sseSource){ try{state._sseSource.close();}catch(e){} state._sseSource=null; }
    if(typeof EventSource==='undefined') return; // SSR/old browser fallback
    const es=new EventSource('api/ha/events');
    state._sseSource=es;

    es.addEventListener('initial_states', e=>{
      try{
        const states=JSON.parse(e.data);
        if(!Array.isArray(states)||!states.length) return;
        states.forEach(s=>{ state.states[s.entity_id]=s; });
        applySourceConfig(); refreshRuntimeRooms(); updateAttentionFromStates();
        if(!state.edit && !state.livePaused) render();
        if(_mobileAuth.active) _mobileHideOffline();
        setConnection(true, state.edit?'Редактор · live paused':'Live ●', state.edit?'':'live');
        // Перезапускаем поллинг с длинным интервалом (fallback)
        startPolling();
      }catch(err){ console.error('SSE initial_states',err); }
    });

    es.addEventListener('state_changed', e=>{
      try{
        const s=JSON.parse(e.data);
        if(!s?.entity_id) return;
        const wasKnown=!!state.states[s.entity_id];
        state.states[s.entity_id]=s;
        if(state.livePaused) return;
        if(wasKnown && !state.edit){
          // Точечный патч: обновляем только маркер изменившейся entity
          const patched=patchMarkerForEntity(s.entity_id);
          updateAttentionFromStates();
          // Entity не на плане (не patched) — достаточно обновить панель устройств
          if(!patched) scheduleRender();
        } else {
          // Новая entity или режим редактирования → полный ре-рендер
          scheduleRender();
        }
      }catch(err){ console.error('SSE state_changed',err); }
    });
    es.addEventListener('state_removed', e=>{
      try{
        const {entity_id}=JSON.parse(e.data);
        if(entity_id){ delete state.states[entity_id]; scheduleRender(); }
      }catch(err){}
    });

    es.onerror=()=>{
      state._sseSource=null; es.close();
      setConnection(true,'Поллинг ↺','polling');
      startPolling();
      clearTimeout(retryTimer);
      retryTimer=setTimeout(connectSse, 8000);
    };
  }

  // Экспортируем для вызова из initialHaSync
  state._connectSse=connectSse;
})();

function defaultSourceConfig(){return{version:1,selectedCards:{},defaultInclude:true,excludedCards:{'Физические устройства::Системные':true,'Вирт.устройства::Вирт.устройства':true},includeUnknownFromApi:false}}
function isSourceKeyEnabled(sourceKey){const cfg=state.sourceConfig||defaultSourceConfig(); if(Object.prototype.hasOwnProperty.call(cfg.selectedCards||{},sourceKey))return!!cfg.selectedCards[sourceKey]; if((cfg.excludedCards||{})[sourceKey])return false; return cfg.defaultInclude!==false}
function extraDeviceFromState(s){
  const domain=String(s.entity_id||'').split('.')[0] || 'entity';
  return {
    entity_id:s.entity_id,
    name:friendlyEntityName(s.entity_id),
    panelName:friendlyEntityName(s.entity_id),
    label:friendlyEntityName(s.entity_id),
    category:'Новые из HA',
    room:'overview',
    domain,
    emoji:TYPE_ICONS[domain] || '•',
    sourceKey:'Home Assistant API::Новые из HA',
    viewTitle:'Home Assistant API',
    cardTitle:'Новые из HA'
  };
}
function applySourceConfig(){
  const cfg=state.sourceConfig||defaultSourceConfig();
  const list=allDevices().filter(d=>isSourceKeyEnabled(d.sourceKey));
  if(cfg.includeUnknownFromApi && state.states){
    const known=new Set(allDevices().map(d=>d.entity_id));
    Object.values(state.states).forEach(s=>{
      if(!known.has(s.entity_id)) list.push(extraDeviceFromState(s));
    });
  }
  window.DEVICES=list;
}
async function loadSourceConfig(){try{state.sourceConfig=await apiJson('api/source-config')}catch(e){state.sourceConfig=defaultSourceConfig()} applySourceConfig()}
async function saveSourceConfig(){await apiJson('api/source-config',{method:'POST',body:JSON.stringify(state.sourceConfig||defaultSourceConfig())});applySourceConfig();renderSourceSettings();render();el('settings-status').textContent=`Источники сохранены. Активно: ${devices().length} из ${allDevices().length}`}
function setSourceKeyEnabled(k,v){if(!state.sourceConfig)state.sourceConfig=defaultSourceConfig(); if(!state.sourceConfig.selectedCards)state.sourceConfig.selectedCards={}; state.sourceConfig.selectedCards[k]=!!v}
function setAllSources(v){(window.LOVELACE_SOURCE?.views||[]).forEach(view=>(view.cards||[]).forEach(c=>setSourceKeyEnabled(c.sourceKey,v)));applySourceConfig();renderSourceSettings();render()}
function setSafeSources(){setAllSources(false);const excluded=new Set(['Хрень всякая','Системные']);(window.LOVELACE_SOURCE?.views||[]).forEach(v=>(v.cards||[]).forEach(c=>{const ok=(v.title==='Физические устройства'||v.title==='Медиа')&&!excluded.has(c.title);setSourceKeyEnabled(c.sourceKey,ok)}));applySourceConfig();renderSourceSettings();render()}
function renderSourceSettings(){const box=el('source-settings'); if(!box||!window.LOVELACE_SOURCE)return; const cfg=state.sourceConfig||defaultSourceConfig(); box.innerHTML=`<p class="muted">Активно: <b>${devices().length}</b> из <b>${allDevices().length}</b></p><label class="source-card source-card-inline"><input type="checkbox" id="include-unknown-api" ${cfg.includeUnknownFromApi?'checked':''}> Добавлять новые сущности из Home Assistant API</label>`+(LOVELACE_SOURCE.views||[]).map(view=>`<details class="source-view"><summary>${esc(view.title)} · ${(view.cards||[]).length} карточек</summary><div class="source-cards">${(view.cards||[]).map(card=>`<label class="source-card"><input type="checkbox" data-source-key="${esc(card.sourceKey)}" ${isSourceKeyEnabled(card.sourceKey)?'checked':''}> ${esc(card.title)} (${(card.devices||[]).length})</label>`).join('')}</div></details>`).join(''); const unknown=el('include-unknown-api'); if(unknown) unknown.onchange=()=>{ state.sourceConfig={...cfg,includeUnknownFromApi:unknown.checked}; applySourceConfig(); renderSourceSettings(); render(); }; qsa('[data-source-key]',box).forEach(cb=>cb.onchange=()=>{setSourceKeyEnabled(cb.dataset.sourceKey,cb.checked);applySourceConfig();renderSourceSettings();render()})}


async function readLovelaceRaw(){
  const status=el('settings-status');
  try{
    status.textContent='Читаю RAW панели из Home Assistant и пересобираю устройства...';
    const dashboardPathText=(state.sourceConfig?.dashboardPathText || (state.sourceConfig?.dashboardPaths||[]).join('\n') || '').trim();
    const data=await apiJson('api/ha/lovelace/import',{method:'POST',body:JSON.stringify({dashboardPathText})});
    const ok=(data.results||[]).filter(x=>x.ok).length;
    const bad=(data.results||[]).filter(x=>!x.ok).length;
    const imp=data.import||{};
    status.textContent=`RAW прочитан: успешно ${ok}, ошибок ${bad}. Устройств: ${imp.devices||0}, карточек: ${imp.cards||0}, templates: ${imp.templatesUsed||0}. Страница перезагрузится.`;
    setTimeout(()=>location.reload(), 1400);
  }catch(e){
    status.textContent='Ошибка чтения/импорта RAW панели: '+e.message;
  }
}


function formatBytes(n){ n=Number(n)||0; if(n<1024) return n+' B'; if(n<1024*1024) return Math.round(n/102.4)/10+' KB'; return Math.round(n/104857.6)/10+' MB'; }
function renderKioskWidget(){
  const clock=el('kiosk-clock'); if(clock){ const d=new Date(); clock.textContent=d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
  const wbox=el('kiosk-weather'); if(!wbox) return;
  const id=String(state.ui.weatherEntity||'').trim();
  if(!id){ wbox.textContent=''; return; }
  const s=getState(id);
  if(!s){ wbox.textContent=id+' недоступен'; return; }
  const unit=s.attributes?.unit_of_measurement || (id.startsWith('weather.') ? '' : '');
  const temp=s.attributes?.temperature;
  const text = temp!==undefined ? `${s.state}, ${temp}°` : `${s.state}${unit}`;
  wbox.textContent=text;
}
function startClock(){ if(state.clockTimer) clearInterval(state.clockTimer); renderKioskWidget(); state.clockTimer=setInterval(renderKioskWidget, 1000); }
async function openInfoModal(tab='summary'){
  state.infoTab=tab; el('info-modal').classList.remove('hidden'); await loadDiagnostics();
}
async function loadDiagnostics(){
  const box=el('info-content'); if(box) box.textContent='Загрузка диагностики...';
  try{ state.diagnostics=await apiJson('api/diagnostics'); renderInfoModal(); }
  catch(e){ if(box) box.textContent='Ошибка диагностики: '+e.message; }
}
function infoRow(k,v,copyable=false){
  const value = String(v ?? '—');
  const copyBtn = copyable && value && value !== '—' ? ` <button type="button" class="copy-inline" data-copy-text="${esc(value)}">Копировать</button>` : '';
  return `<tr><th>${esc(k)}</th><td class="${copyable?'copyable':''}"><span class="copyable-value">${esc(value)}</span>${copyBtn}</td></tr>`;
}
function infoSection(title){ return `<tr class="info-section-row"><th colspan="2">${esc(title)}</th></tr>`; }
function renderInfoModal(){
  const d=state.diagnostics; const box=el('info-content'); if(!box||!d) return;
  qsa('[data-info-tab]').forEach(b=>b.classList.toggle('active', b.dataset.infoTab===state.infoTab));
  if(state.infoTab==='summary'){
    const ld=d.layoutDiagnostics||{};
    box.innerHTML=`<table class="info-table">${[
      infoSection('Система'),
      infoRow('Название',d.brand?.name||'ALLHA-2D'),
      infoRow('Версия add-on',d.version, true),
      infoRow('Разработчик',d.brand?.developer||'Lepi4'),
      infoRow('HA API',d.ok?'OK':'Ошибка'),
      infoRow('Ошибка HA',d.haError||'—'),
      infoRow('Режим',d.mode),
      infoRow('DATA_DIR',d.dataDir, true),
      infoRow('Supervisor token',d.hasSupervisorToken?'есть':'нет'),
      infoRow('States в кэше',String(d.liveStatesCache??'—')),
      infoSection('Dashboard / доступ'),
      infoRow('Локальный адрес без Home Assistant', d.dashboardProxy?.directLocal?.url || 'http://IP_HOME_ASSISTANT:8099/', true),
      infoRow('Direct local port', String(d.dashboardProxy?.directLocal?.port || 8099), true),
      infoRow('Direct local candidates', (d.dashboardProxy?.directLocal?.candidates||[]).map(x=>`${x.label}: ${x.url}`).join(' | ') || 'http://IP_HOME_ASSISTANT:8099/', true),
      infoRow('Ingress для карточки', d.dashboardProxy?.dashboardUrl || 'Используйте ingress-aware Lovelace card / Addon Iframe Card', true),
      infoRow('Direct route для reverse proxy', d.dashboardProxy?.directRoute || '/allha-2d-direct/', true),
      infoRow('Proxy updated', d.dashboardProxy?.updatedAt || '—'),
      infoRow('Dashboard hint', d.dashboardProxy?.directLocal?.hint || d.dashboardProxy?.hint || '—'),
      infoSection('Runtime storage'),
      infoRow('layout.json в /data',d.storage?.layoutExists?'есть':'нет'),
      infoRow('ui_state.json в /data',d.storage?.uiStateExists?'есть':'нет'),
      infoRow('rooms.json в /data',d.storage?.roomsSettingsExists?'есть':'нет'),
      infoRow('devices.js в /data',d.storage?.devicesInData?'есть':'fallback'),
      infoRow('lovelace-source.js в /data',d.storage?.lovelaceInData?'есть':'fallback'),
      infoSection('Profiles'),
      infoRow('active profile', d.profiles?.activeProfileId || 'profile-1'),
      infoRow('profiles count', ((d.profiles?.count ?? 1)+' / '+(d.profiles?.max ?? 5))),
      infoRow('active profile dir', d.profiles?.activePaths?.dir || '—', true),
      infoSection('Levels / areas'),
      infoRow('active level', d.levels?.activeLevelId || 'level-1'),
      infoRow('levels count', ((d.levels?.count ?? 1)+' / '+(d.levels?.max ?? 12))),
      infoRow('active level dir', d.levels?.activePaths?.dir || '—', true),
      infoSection('Images storage'),
      infoRow('/data/images',d.images?.exists?'есть':'нет'),
      infoRow('/data/images/overview',d.images?.overviewDirExists?'есть':'нет'),
      infoRow('/data/images/rooms',d.images?.roomsDirExists?'есть':'нет'),
      infoRow('/data/images/originals',d.images?.originalsDirExists?'есть':'нет'),
      infoRow('/data/images/originals/rooms',d.images?.originalsRoomsDirExists?'есть':'нет'),
      infoRow('/data/backups',d.images?.backupsDirExists?'есть':'нет'),
      infoRow('overview image',d.images?.overview?.mode||'—'),
      infoRow('rooms images count',d.images?.customRoomImages??0),
      infoRow('images_meta.json',d.images?.metaOk?'OK':'error/missing'),
      infoRow('converter',d.images?.converterAvailable?'sharp/webp':'copy fallback'),
      infoRow('overview max long side',d.images?.uploadLimits?.overviewMaxLongSide||'—'),
      infoRow('room max long side',d.images?.uploadLimits?.roomMaxLongSide||'—'),
      infoRow('max upload',d.images?.uploadLimits?.maxBytes?Math.round(d.images.uploadLimits.maxBytes/1024/1024)+' MB':'—'),
      infoSection('Layout'),
      infoRow('Layout координаты',ld.ok?'OK':'есть проблемы'),
      infoRow('Pixel-like координаты',ld.problems?.pixelLike?.length||0),
      infoRow('Координаты вне 0–100',ld.problems?.outOfRange?.length||0),
      infoSection('Devices'),
      infoRow('Устройств из панели',d.counts?.devices),
      infoRow('Entity из HA',d.counts?.haStates),
      infoRow('Не найдены в HA',d.counts?.missingInHa),
      infoRow('Дубли entity_id',d.counts?.duplicates),
      infoRow('Без комнаты',d.counts?.noRoom),
      infoRow('Без координат',d.counts?.noCoordinates),
      infoRow('Backup layout',d.counts?.backups),
      infoRow('Сформировано',d.generatedAt)
    ].join('')}</table>`;
  } else if(state.infoTab==='entities'){
    box.innerHTML=`<h3>Проблемы entity_id</h3><p class="muted">Показаны первые 200 записей каждого типа.</p>`+
      `<h4>Не найдены в HA (${d.counts?.missingInHa||0})</h4><div class="info-list">${(d.missingInHa||[]).map(x=>`<code>${esc(x.entity_id)}</code> <span>${esc(x.name||'')}</span>`).join('<br>')||'—'}</div>`+
      `<h4>Дубли (${d.counts?.duplicates||0})</h4><div class="info-list">${(d.duplicates||[]).map(x=>`<code>${esc(x.entity_id)}</code> × ${x.count}`).join('<br>')||'—'}</div>`+
      `<h4>Без координат (${d.counts?.noCoordinates||0})</h4><div class="info-list">${(d.noCoordinates||[]).map(x=>`<code>${esc(x)}</code>`).join('<br>')||'—'}</div>`;
  } else if(state.infoTab==='layout'){
    const ld=d.layoutDiagnostics||{};
    const p=ld.problems||{};
    const cnt=ld.counts||{};
    const hasFix=(p.pixelLike?.length||0)||(p.outOfRange?.length||0)||(p.invalidPoints?.length||0);
    box.innerHTML=`<h3>Диагностика layout</h3><p class="muted">Layout должен хранить координаты только в процентах 0–100. Zoom, pan и hardware scale хранятся отдельно и не должны менять координаты.</p>`+
      `<table class="info-table">${[
        ['Статус',ld.ok?'OK':'Есть проблемы'],['Overview markers',cnt.overviewMarkers||0],['Room markers',cnt.roomMarkers||0],['Overview metrics',cnt.overviewMetrics||0],['Room metrics',cnt.roomMetrics||0],['Zones',cnt.zones||0],['Pixel-like координаты',p.pixelLike?.length||0],['Вне диапазона 0–100',p.outOfRange?.length||0],['Некорректные точки',p.invalidPoints?.length||0],['Неизвестные top-level поля',(p.unknownTopLevel||[]).join(', ')||'—']
      ].map(x=>infoRow(x[0],x[1])).join('')}</table>`+
      `${hasFix?'<p><button type="button" id="btn-normalize-layout">Нормализовать координаты</button></p>':''}`+
      `<h4>Первые проблемы</h4><div class="info-list">${[...(p.pixelLike||[]),...(p.outOfRange||[]),...(p.invalidPoints||[])].slice(0,80).map(x=>`<code>${esc(x.path||'')}</code> ${esc(JSON.stringify(x))}`).join('<br>')||'—'}</div>`;
    const btn=el('btn-normalize-layout');
    if(btn) btn.onclick=async()=>{ if(!confirm('Создать backup и нормализовать layout в проценты 0–100?')) return; const r=await apiJson('api/layout/normalize',{method:'POST'}); state.layout=r.diagnostics?.normalizedPreview || state.layout; await loadDiagnostics(); render(); showToast('Layout нормализован'); };
  } else if(state.infoTab==='backups'){
    const backups=d.backups||{items:[]}; box.innerHTML=`<h3>Backup / архивы</h3><p class="muted">Показываются все backup-и в /data/backups. Создание и удаление доступно в Настройки → Backup / архивы.</p><div class="backup-summary">Файлов: ${backups.count||0} · Размер: ${formatBytes(backups.totalSize||0)}</div><div class="backup-list">${(backups.items||[]).slice(0,50).map(b=>`<div class="backup-row"><div><b>${esc(b.name)}</b><br><span>${esc(b.type||'file')} · ${esc(new Date(b.mtime).toLocaleString())} · ${formatBytes(b.size)}</span></div><div>${/^layout-.*\.json$/.test(b.name)?`<button data-restore-backup="${esc(b.name)}">Восстановить layout</button>`:''}<button data-delete-backup="${esc(b.name)}">Удалить</button></div></div>`).join('')||'Backup пока нет'}</div>`;
    qsa('[data-restore-backup]',box).forEach(btn=>btn.onclick=async()=>{ if(!confirm('Восстановить '+btn.dataset.restoreBackup+'? Текущий layout будет сохранён в backup.')) return; const r=await apiJson('api/backups/restore',{method:'POST',body:JSON.stringify({name:btn.dataset.restoreBackup})}); state.layout={...state.layout,...r.layout}; await loadDiagnostics(); render(); showToast('Layout восстановлен'); });
    qsa('[data-delete-backup]',box).forEach(btn=>btn.onclick=async()=>{ await apiJson('api/backups/delete',{method:'POST',body:JSON.stringify({name:btn.dataset.deleteBackup})}); await loadDiagnostics(); });
  } else if(state.infoTab==='allowlist'){
    box.innerHTML=`<h3>Команды Home Assistant</h3><p class="muted">viewer — просмотр. control panel — управление, dangerous через подтверждение/PIN. admin — полный доступ.</p><div class="info-list"><b>Режим панели</b>: ${esc(d.security?.panelMode||'admin')}<br><b>PIN установлен</b>: ${d.security?.pinEnabled?'да':'нет'}<br><b>Dangerous через PIN</b>: ${d.security?.dangerousRequirePin?'да':'нет'}<br><b>Подтверждение</b>: ${d.security?.confirmDangerousServices!==false?'включено':'выключено'}</div><h4>Safe</h4><div class="info-list">${Object.entries(d.safeServices||d.allowedServices||{}).map(([dom,arr])=>`<b>${esc(dom)}</b>: ${arr.map(esc).join(', ')}`).join('<br>')}</div><h4>Dangerous</h4><div class="info-list">${Object.entries(d.dangerousServices||{}).map(([dom,arr])=>`<b>${esc(dom)}</b>: ${arr.map(esc).join(', ')}`).join('<br>') || '—'}</div><h4>Последние команды</h4><div class="info-list">${(d.commandLog||[]).slice(0,30).map(x=>`${esc(x.time)} — <b>${esc(x.domain)}.${esc(x.service)}</b> ${esc(x.entity_id||'')} — ${esc(x.result||'')}`).join('<br>') || '—'}</div>`;
  } else if(state.infoTab==='about'){
    const brand=d.brand||{};
    box.innerHTML=`<div class="about-brand-card"><div class="about-brand-logo"><img src="brand-logo.svg" alt="ALLHA-2D"></div><div><h3>ALLHA-2D</h3><p class="muted">Local 2D floor-plan Smart Home UI for Home Assistant.</p></div></div>`+
      `<table class="info-table">${[
        ['Название', brand.name || 'ALLHA-2D'],
        ['Версия', d.version || '—'],
        ['Разработчик', brand.developer || 'Lepi4'],
        ['GitHub', brand.github || 'https://github.com/Lepi4/smart-home-ui'],
        ['Copyright', brand.copyright || '© Lepi4'],
        ['Режим', d.mode || 'home-assistant-addon']
      ].map(x=>infoRow(x[0],x[1])).join('')}</table>`+
      `<p class="muted">ALLHA-2D шифрует инициалы автора, Home Assistant и 2D/floor-plan подход. Репозиторий остаётся прежним: <code>https://github.com/Lepi4/smart-home-ui</code>.</p>`;
  }
}


/* v3.4.12: settings modal performance helpers */
function openModal(id){ const m=el(id); if(m){ m.classList.remove('hidden'); syncModalOpenClass(); } }
function closeModal(id){ const m=el(id); if(m){ m.classList.add('hidden'); syncModalOpenClass(); } }


/* ── Mobile access UI ─────────────────────────────────────────────── */
let _mobileCodeTimer = null;

function mobileCodeTick(){
  const disp = el('mobile-code-display');
  const timer = el('mobile-code-timer');
  if(!disp || !timer) return;
  apiJson('api/mobile/code').then(d=>{
    if(d && d.code && d.expires_in > 0){
      disp.textContent = d.code;
      timer.textContent = `${d.expires_in} с`;
    } else {
      disp.textContent = '——————';
      timer.textContent = '';
      if(_mobileCodeTimer){ clearInterval(_mobileCodeTimer); _mobileCodeTimer = null; }
    }
  }).catch(()=>{});
}

function startMobileCodePoll(){
  if(_mobileCodeTimer) clearInterval(_mobileCodeTimer);
  mobileCodeTick();
  _mobileCodeTimer = setInterval(mobileCodeTick, 2000);
}

function stopMobileCodePoll(){
  if(_mobileCodeTimer){ clearInterval(_mobileCodeTimer); _mobileCodeTimer = null; }
  const disp = el('mobile-code-display'); if(disp) disp.textContent = '——————';
  const timer = el('mobile-code-timer'); if(timer) timer.textContent = '';
}

async function loadMobileSettings(){
  try{
    const cfg = await apiJson('api/config');
    const m = cfg.mobileAccess || {};
    const chk = el('mobile-access-enabled'); if(chk) chk.checked = !!m.enabled;
    const lu = el('mobile-local-url'); if(lu) lu.value = m.localUrl || '';
    const ru = el('mobile-remote-url'); if(ru) ru.value = m.remoteUrl || '';
    const pp = el('mobile-pairing-password'); if(pp){ pp.value = ''; pp.placeholder = m.hasPairingPassword ? '••••• (установлен, введите новый чтобы изменить)' : 'Например: МойДом2024'; }
    const cnt = el('mobile-devices-count'); if(cnt) cnt.textContent = `(${m.pairedDevices || 0})`;
    await loadMobileDevices();
    startMobileCodePoll();
  }catch(e){ console.error('loadMobileSettings', e); }
}

async function loadMobileDevices(){
  const list = el('mobile-devices-list');
  if(!list) return;
  try{
    const data = await apiJson('api/mobile/devices');
    const devs = data.devices || [];
    const cnt = el('mobile-devices-count'); if(cnt) cnt.textContent = `(${devs.length})`;
    if(!devs.length){ list.innerHTML = '<p class="muted">Нет привязанных устройств</p>'; return; }
    list.innerHTML = devs.map(d=>`
      <div class="mobile-device-row" data-did="${esc(d.device_id)}">
        <input type="text" class="mobile-device-name" value="${esc(d.name)}" placeholder="Имя устройства">
        <span class="muted" style="font-size:11px">Привязано: ${d.paired_at?.slice(0,10)||'—'} · Был: ${d.last_seen?.slice(0,10)||'—'}</span>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button type="button" class="btn-mobile-rename" data-did="${esc(d.device_id)}">Переименовать</button>
          <button type="button" class="btn-mobile-revoke" data-did="${esc(d.device_id)}">Отозвать</button>
        </div>
      </div>`).join('');
  }catch(e){ list.innerHTML = `<p class="muted">Ошибка: ${esc(e.message)}</p>`; }
}

function bindMobileSettings(){
  const saveCfg = el('btn-save-mobile-config');
  if(saveCfg) saveCfg.onclick = async()=>{
    const ppVal = (el('mobile-pairing-password')?.value||'').trim();
    const mobilePayload = {
      enabled: !!el('mobile-access-enabled')?.checked,
      localUrl: el('mobile-local-url')?.value||'',
      remoteUrl: el('mobile-remote-url')?.value||''
    };
    if(ppVal) mobilePayload.pairingPassword = ppVal;
    const payload = { mobileAccess: mobilePayload };
    try{ await apiJson('api/config',{method:'POST',body:JSON.stringify(payload)}); showToast('Настройки мобильного доступа сохранены'); }
    catch(e){ showToast('Ошибка: '+e.message); }
  };

  const genCode = el('btn-mobile-gen-code');
  if(genCode) genCode.onclick = async()=>{
    try{ await apiJson('api/mobile/code/new',{method:'POST'}); startMobileCodePoll(); }
    catch(e){ showToast('Ошибка генерации кода: '+e.message); }
  };

  const cancelCode = el('btn-mobile-cancel-code');
  if(cancelCode) cancelCode.onclick = async()=>{
    try{ await apiJson('api/mobile/code',{method:'DELETE'}); stopMobileCodePoll(); }
    catch(e){ showToast('Ошибка: '+e.message); }
  };

  const revokeAll = el('btn-mobile-revoke-all');
  if(revokeAll) revokeAll.onclick = async()=>{
    if(!confirm('Отозвать токены всех устройств? Им придётся пройти паринг заново.')) return;
    try{ await apiJson('api/mobile/devices',{method:'DELETE'}); await loadMobileDevices(); showToast('Все токены отозваны'); }
    catch(e){ showToast('Ошибка: '+e.message); }
  };

  const devList = el('mobile-devices-list');
  if(devList) devList.addEventListener('click', async e=>{
    const renameBtn = e.target.closest('.btn-mobile-rename');
    const revokeBtn = e.target.closest('.btn-mobile-revoke');
    if(renameBtn){
      const did = renameBtn.dataset.did;
      const row = devList.querySelector(`[data-did="${did}"]`);
      const name = row?.querySelector('.mobile-device-name')?.value || '';
      try{ await apiJson(`api/mobile/devices/${encodeURIComponent(did)}`,{method:'PATCH',body:JSON.stringify({name})}); showToast('Имя сохранено'); }
      catch(e){ showToast('Ошибка: '+e.message); }
    }
    if(revokeBtn){
      const did = revokeBtn.dataset.did;
      if(!confirm('Отозвать токен этого устройства?')) return;
      try{ await apiJson(`api/mobile/devices/${encodeURIComponent(did)}`,{method:'DELETE'}); await loadMobileDevices(); showToast('Токен отозван'); }
      catch(e){ showToast('Ошибка: '+e.message); }
    }
  });
}

function openSettingsPanel(name){
  const map={images:'settings-panel-images', layout:'layout-maintenance-tools', rooms:'settings-panel-rooms', sources:'settings-panel-sources', profiles:'settings-panel-profiles', levels:'settings-panel-levels', backups:'settings-panel-backups', mobile:'settings-panel-mobile'};
  const id=map[name]||name;
  qsa('#settings-modal .settings-section-panel').forEach(panel=>panel.classList.add('hidden'));
  qsa('#settings-modal [data-settings-panel]').forEach(btn=>btn.classList.toggle('active', btn.dataset.settingsPanel===name));
  const panel=el(id);
  if(panel){
    panel.classList.remove('hidden');
    if(name==='backups') loadBackupsInfo();
    if(name==='mobile') loadMobileSettings();
    const scroll=el('settings-modal')?.querySelector('.settings-scroll');
    setTimeout(()=>panel.scrollIntoView({block:'start', behavior:'smooth'}), 0);
    if(scroll) setTimeout(()=>{ scroll.scrollTop=Math.max(0, panel.offsetTop-10); }, 80);
  }
}
async function cancelSettingsChanges(){
  try{
    await loadConfig();
    await loadImagesInfo();
    await loadRoomsSettings();
    closeModal('settings-modal');
    showToast('Несохранённые настройки отменены');
  }catch(e){
    closeModal('settings-modal');
  }
}


async function copyTextToClipboard(text){
  const value=String(text||'');
  if(!value){ showToast('Нечего копировать'); return; }
  try{
    await navigator.clipboard.writeText(value);
    showToast('Скопировано');
  }catch(e){
    const ta=document.createElement('textarea');
    ta.value=value; ta.className='copy-fallback-textarea';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try{ document.execCommand('copy'); showToast('Скопировано'); }catch(err){ showToast('Не удалось скопировать'); }
    ta.remove();
  }
}
function bindGlobal(){
  loadUiPrefs();
    document.addEventListener('contextmenu', e=>{ if(e.target.closest('.plan-stage,.room-image-wrap,.device-marker,.badge,.room-zone')) e.preventDefault(); });
  ['pointerdown','touchstart','keydown'].forEach(evt=>document.addEventListener(evt, registerKioskActivity, {passive:true}));
  el('btn-settings').onclick=()=>openModal('settings-modal');
  el('btn-close-settings').onclick=()=>closeModal('settings-modal');
  const closeLevelWizard=()=>closeModal('level-setup-wizard-modal');
  const bwc=el('btn-close-level-setup-wizard'); if(bwc) bwc.onclick=closeLevelWizard;
  const wrb=el('wizard-return-button'); if(wrb) wrb.onclick=()=>returnToLevelSetupWizard();
  const closeProjectWizard=()=>closeProjectSetupWizard();
  const pswClose=el('btn-close-project-setup-wizard'); if(pswClose) pswClose.onclick=closeProjectWizard;
  const pswCancel=el('btn-project-setup-cancel'); if(pswCancel) pswCancel.onclick=closeProjectWizard;
  const pswBack=el('btn-project-setup-back'); if(pswBack) pswBack.onclick=()=>projectSetupNext(-1);
  const pswNext=el('btn-project-setup-next'); if(pswNext) pswNext.onclick=()=>projectSetupNext(1);
  const pswCreate=el('btn-project-setup-create'); if(pswCreate) pswCreate.onclick=createProjectFromSetupWizard;
  const pswModal=el('project-setup-wizard-modal'); if(pswModal) pswModal.addEventListener('click',e=>{ if(e.target.id==='project-setup-wizard-modal') closeProjectSetupWizard(); });
  const bwc2=el('btn-level-setup-close'); if(bwc2) bwc2.onclick=closeLevelWizard;
  const bwr=el('btn-level-setup-refresh'); if(bwr) bwr.onclick=async()=>{ await loadLevelsInfo(); renderLevelSetupWizard(state.levelSetupWizardId); };
  el('btn-close-device').onclick=closeDeviceModal;
  el('device-modal').addEventListener('click',e=>{if(e.target.id==='device-modal')closeDeviceModal()});
  el('btn-close-info').onclick=()=>el('info-modal').classList.add('hidden');
  el('info-modal').addEventListener('click',e=>{if(e.target.id==='info-modal')el('info-modal').classList.add('hidden')});
  async function loadFaqContent(){
    const box=el('faq-content');
    if(!box || box.dataset.loaded==='1') return;
    try{
      const res=await fetch('FAQ.html?ts='+Date.now(), {cache:'no-store'});
      const html=await res.text();
      const doc=new DOMParser().parseFromString(html, 'text/html');
      box.innerHTML=doc.body ? doc.body.innerHTML : html;
      box.dataset.loaded='1';
      box.scrollTop=0;
    }catch(e){
      box.innerHTML='<h1>FAQ / Помощь</h1><p>Не удалось загрузить FAQ. Откройте README или FAQ.md из дистрибутива.</p>';
    }
  }
  el('btn-faq-settings').onclick=async()=>{ await loadFaqContent(); openModal('faq-modal'); setTimeout(()=>{ const b=el('faq-content'); if(b) b.scrollTop=0; }, 50); };
  bindMobileSettings();
  el('btn-close-faq').onclick=()=>closeModal('faq-modal');
  el('faq-modal').addEventListener('click',e=>{if(e.target.id==='faq-modal')closeModal('faq-modal')});
  el('btn-refresh-info').onclick=loadDiagnostics;
  const overviewFile=el('overview-image-file');
  el('btn-upload-overview-image').onclick=()=>overviewFile?.click();
  if(overviewFile) overviewFile.onchange=e=>{ const file=e.target.files?.[0]; uploadOverviewImage(file); e.target.value=''; };
  el('btn-reset-overview-image').onclick=resetOverviewImage;
  const roomFile=el('room-image-file');
  let pendingRoomImageId='';
  const roomImagesList=el('room-images-list');
  if(roomImagesList) roomImagesList.addEventListener('click', e=>{
    const upload=e.target.closest('[data-upload-room-image]');
    const reset=e.target.closest('[data-reset-room-image]');
    if(upload){ pendingRoomImageId=upload.dataset.uploadRoomImage; roomFile?.click(); }
    if(reset){ resetRoomImage(reset.dataset.resetRoomImage); }
  });
  if(roomFile) roomFile.onchange=e=>{ const file=e.target.files?.[0]; const roomId=pendingRoomImageId; e.target.value=''; pendingRoomImageId=''; if(roomId) uploadRoomImage(roomId, file); };
  const clearMarkersBtn=el('btn-clear-markers'); if(clearMarkersBtn) clearMarkersBtn.onclick=clearLayoutMarkers;
  const clearZonesBtn=el('btn-clear-zones'); if(clearZonesBtn) clearZonesBtn.onclick=clearLayoutZones;
  const createZoneBtn=el('btn-create-zone'); if(createZoneBtn) createZoneBtn.onclick=createZoneFromSettings;
  const openPlacementBtn=el('btn-open-device-placement'); if(openPlacementBtn) openPlacementBtn.onclick=openMarkerPlacementFromSettings;
  const profilesManager=el('profiles-manager');
  document.addEventListener('click', e=>{ const copy=e.target.closest('[data-copy-text]'); if(copy){ copyTextToClipboard(copy.dataset.copyText); } });
  if(profilesManager) profilesManager.addEventListener('click', e=>{
    const setup=e.target.closest('#btn-open-project-setup-wizard'); if(setup){ openProjectSetupWizard(); return; }
    const create=e.target.closest('#btn-create-profile'); if(create){ createProfileFromSettings(); return; }
    const actDevice=e.target.closest('[data-profile-activate-device]'); if(actDevice){ activateProfileForDevice(actDevice.dataset.profileActivateDevice); return; }
    const act=e.target.closest('[data-profile-activate]'); if(act){ activateProfileFromSettings(act.dataset.profileActivate); return; }
    const ren=e.target.closest('[data-profile-rename]'); if(ren){ renameProfileFromSettings(ren.dataset.profileRename); return; }
    const dup=e.target.closest('[data-profile-duplicate]'); if(dup){ duplicateProfileFromSettings(dup.dataset.profileDuplicate); return; }
    const del=e.target.closest('[data-profile-delete]'); if(del){ deleteProfileFromSettings(del.dataset.profileDelete); return; }
    const copy=e.target.closest('[data-profile-copy-kind]'); if(copy){ copyProfileDataFromSettings(copy.dataset.profileCopyTarget, copy.dataset.profileCopyKind); return; }
  });
  document.addEventListener('click', e=>{ const home=e.target.closest('[data-kiosk-overview-home]'); if(home){ selectRoom('overview'); return; } const q=e.target.closest('[data-quick-level]'); if(q){ activateLevelQuick(q.dataset.quickLevel); } });
  const levelWizardModal=el('level-setup-wizard-modal');
  if(levelWizardModal) levelWizardModal.addEventListener('click', e=>{
    const wizActivate=e.target.closest('[data-level-wizard-activate]'); if(wizActivate){ (async()=>{ await ensureWizardLevelActive(wizActivate.dataset.levelWizardActivate); openLevelSetupWizard(wizActivate.dataset.levelWizardActivate); })(); return; }
    const wizImages=e.target.closest('[data-level-wizard-images]'); if(wizImages){ openWizardPanel(wizImages.dataset.levelWizardImages,'images'); return; }
    const wizSources=e.target.closest('[data-level-wizard-sources]'); if(wizSources){ focusLevelSources(wizSources.dataset.levelWizardSources); return; }
    const wizImport=e.target.closest('[data-level-wizard-import]'); if(wizImport){ (async()=>{ await importLevelSources(wizImport.dataset.levelWizardImport); await loadLevelsInfo(); openLevelSetupWizard(wizImport.dataset.levelWizardImport); })(); return; }
    const wizRooms=e.target.closest('[data-level-wizard-rooms]'); if(wizRooms){ openWizardPanel(wizRooms.dataset.levelWizardRooms,'rooms'); return; }
    const wizZones=e.target.closest('[data-level-wizard-zones]'); if(wizZones){ openWizardPanel(wizZones.dataset.levelWizardZones,'rooms'); return; }
    if(e.target.id==='level-setup-wizard-modal') closeModal('level-setup-wizard-modal');
  });
  const levelsManager=el('levels-manager');
  if(levelsManager) levelsManager.addEventListener('click', e=>{
    const create=e.target.closest('#btn-create-level'); if(create){ createLevelFromSettings(); return; }
    const init=e.target.closest('[data-level-init]'); if(init){ initializeLevelFromSettings(init.dataset.levelInit); return; }
    const wizActivate=e.target.closest('[data-level-wizard-activate]'); if(wizActivate){ (async()=>{ await ensureWizardLevelActive(wizActivate.dataset.levelWizardActivate); openLevelSetupWizard(wizActivate.dataset.levelWizardActivate); })(); return; }
    const wizImages=e.target.closest('[data-level-wizard-images]'); if(wizImages){ openWizardPanel(wizImages.dataset.levelWizardImages,'images'); return; }
    const wizSources=e.target.closest('[data-level-wizard-sources]'); if(wizSources){ focusLevelSources(wizSources.dataset.levelWizardSources); return; }
    const wizImport=e.target.closest('[data-level-wizard-import]'); if(wizImport){ (async()=>{ await importLevelSources(wizImport.dataset.levelWizardImport); await loadLevelsInfo(); openLevelSetupWizard(wizImport.dataset.levelWizardImport); })(); return; }
    const wizRooms=e.target.closest('[data-level-wizard-rooms]'); if(wizRooms){ openWizardPanel(wizRooms.dataset.levelWizardRooms,'rooms'); return; }
    const wizZones=e.target.closest('[data-level-wizard-zones]'); if(wizZones){ openWizardPanel(wizZones.dataset.levelWizardZones,'rooms'); return; }
    const act=e.target.closest('[data-level-activate]'); if(act){ activateLevelFromSettings(act.dataset.levelActivate); return; }
    const ren=e.target.closest('[data-level-rename]'); if(ren){ renameLevelFromSettings(ren.dataset.levelRename); return; }
    const saveSrc=e.target.closest('[data-level-source-save]'); if(saveSrc){ saveLevelSources(saveSrc.dataset.levelSourceSave); return; }
    const importSrc=e.target.closest('[data-level-source-import]'); if(importSrc){ importLevelSources(importSrc.dataset.levelSourceImport); return; }
    const dup=e.target.closest('[data-level-duplicate]'); if(dup){ duplicateLevelFromSettings(dup.dataset.levelDuplicate); return; }
    const del=e.target.closest('[data-level-delete]'); if(del){ deleteLevelFromSettings(del.dataset.levelDelete); return; }
  });
  const backupManager=el('backup-manager');
  if(backupManager) backupManager.addEventListener('click', e=>{
    if(e.target.closest('#btn-create-manual-backup')){ createManualBackup(); return; }
    if(e.target.closest('#btn-delete-old-backups')){ deleteOldBackups(); return; }
    if(e.target.closest('#btn-delete-all-backups')){ deleteAllBackups(); return; }
    const restore=e.target.closest('[data-restore-full-backup]'); if(restore){ restoreFullBackup(restore.dataset.restoreFullBackup); return; }
    const del=e.target.closest('[data-delete-backup]'); if(del){ deleteBackup(del.dataset.deleteBackup); return; }
  });
  const roomsManager=el('rooms-zones-manager');
  if(roomsManager) roomsManager.addEventListener('click', e=>{
    const zoneBtn=e.target.closest('[data-room-zone-create]');
    const delZone=e.target.closest('[data-room-zone-delete]');
    const saveSensors=e.target.closest('[data-save-standard-sensors]');
    const clearSensor=e.target.closest('[data-clear-standard-sensor]');
    const card=e.target.closest('[data-room-manager]');
    const roomId=card?.dataset.roomManager;
    if(zoneBtn){ if(startEditModeForLayoutTool()){ state.selectedRoom='overview'; closeSettingsModal(); render(); openZoneLayoutEditor(zoneBtn.dataset.roomZoneCreate); } }
    if(delZone){ deleteRoomZoneFromSettings(delZone.dataset.roomZoneDelete); }
    if(saveSensors){ saveRoomStandardSensors(saveSensors.dataset.saveStandardSensors); }
    if(clearSensor && roomId){ clearStandardSensorInput(roomId, clearSensor.dataset.clearStandardSensor); }
  });
  qsa('[data-info-tab]').forEach(b=>b.onclick=()=>{state.infoTab=b.dataset.infoTab; renderInfoModal();});
  el('btn-save-config').onclick=()=>saveConfig(); const clearConfigBtn=el('btn-clear-config'); if(clearConfigBtn) clearConfigBtn.onclick=()=>clearConfig(); const cancelSettingsBtn=el('btn-cancel-settings'); if(cancelSettingsBtn) cancelSettingsBtn.onclick=()=>cancelSettingsChanges(); qsa('[data-settings-panel]').forEach(b=>b.onclick=()=>openSettingsPanel(b.dataset.settingsPanel)); el('btn-info-settings').onclick=()=>openInfoModal('summary'); el('btn-refresh').onclick=loadStates; el('btn-overview').onclick=()=>selectRoom('overview');
  el('toggle-zones').onchange=e=>{state.ui.showZones=e.target.checked; saveUiPrefs(); applyUiPrefs(); render();}; el('toggle-devices').onchange=e=>{state.ui.showMarkers=e.target.checked; saveUiPrefs(); render();}; el('toggle-sensors').onchange=e=>{state.ui.showSensors=e.target.checked; saveUiPrefs(); render();};
  const editBtn=el('btn-edit');
  const startEditHold=()=>{ if(state.edit) return; if(!canEditLayout()){ showToast('Редактирование доступно только в admin mode'); updateEditButtons(); return; } editBtn.classList.add('holding'); showToast('Удерживайте 2 секунды для входа в редактор'); state.editHoldTimer=setTimeout(()=>{ editBtn.classList.remove('holding'); state.editHoldTimer=null; enterEditMode(); },2000); };
  const cancelEditHold=()=>{ if(state.editHoldTimer){ clearTimeout(state.editHoldTimer); state.editHoldTimer=null; editBtn.classList.remove('holding'); } };
  editBtn.addEventListener('pointerdown',e=>{ if(e.button!==undefined && e.button!==0) return; startEditHold(); });
  editBtn.addEventListener('pointerup',cancelEditHold); editBtn.addEventListener('pointercancel',cancelEditHold); editBtn.addEventListener('pointerleave',cancelEditHold);
  editBtn.onclick=e=>{ e.preventDefault(); };
  editBtn.title='Удерживайте 2 секунды, чтобы войти в режим редактирования';
  el('btn-save-edit').onclick=()=>saveEditChanges().catch(e=>showToast('Ошибка сохранения: '+e.message));
  el('btn-cancel-edit').onclick=cancelEditChanges;
  const delSel=el('btn-delete-selected'); if(delSel) delSel.onclick=deleteSelectedEditObject;
  const resetSel=el('btn-reset-selected'); if(resetSel) resetSel.onclick=resetSelectedEditObject;
  const closeEdit=el('btn-close-edit-sheet'); if(closeEdit) closeEdit.onclick=()=>{state.selectedEdit=null; render();};
  const sheetSave=el('btn-sheet-save-edit'); if(sheetSave) sheetSave.onclick=()=>saveEditChanges().catch(e=>showToast('Ошибка сохранения: '+e.message));
  const sheetCancel=el('btn-sheet-cancel-edit'); if(sheetCancel) sheetCancel.onclick=cancelEditChanges;
  el('device-search').oninput=renderDevices;
  el('btn-save-source-config').onclick=saveSourceConfig; el('btn-read-lovelace-raw').onclick=readLovelaceRaw; el('btn-select-all-sources').onclick=()=>setAllSources(true); el('btn-select-safe-sources').onclick=setSafeSources;
  const font=el('card-font-size'), saved=localStorage.getItem('card_font_size')||'13'; document.documentElement.style.setProperty('--card-font-size',saved+'px'); font.value=saved; font.oninput=()=>{localStorage.setItem('card_font_size',font.value);document.documentElement.style.setProperty('--card-font-size',font.value+'px')};
  el('overview-image').onload=()=>fitStage('overview'); bindStageGestures(); window.addEventListener('resize',()=>{syncAutoMobileMode();fitStage('overview');fitStage('room');refitPlacementEditorSoon()}); window.addEventListener('orientationchange',()=>setTimeout(()=>{syncAutoMobileMode();fitStage('overview');fitStage('room');refitPlacementEditorSoon()},180)); window.addEventListener('beforeunload',e=>{ if(state.edit && state.layoutDirty){ e.preventDefault(); e.returnValue=''; } }); 

  el('btn-hide-sidebar').onclick=()=>setPanelHidden('hideSidebar', !state.ui.hideSidebar);
  el('btn-show-sidebar').onclick=()=>setPanelHidden('hideSidebar', false);
  el('btn-toggle-devices-panel').onclick=toggleDeviceListOrPicker;
  el('btn-show-device-panel').onclick=showDeviceListOrPicker;
  el('btn-toggle-toolbar').onclick=()=>setPanelHidden('hideToolbar', !state.ui.hideToolbar);
  el('btn-show-toolbar').onclick=()=>setPanelHidden('hideToolbar', false);
  el('btn-mobile-sidebar').onclick=()=>{ const open=state.ui.hideSidebar; state.ui.hideSidebar=!open; state.ui.hideDevicePanel=true; saveUiPrefs(); };
  el('btn-mobile-devices').onclick=()=>{ if(state.edit){ openDevicePicker(); return; } const open=state.ui.hideDevicePanel; state.ui.hideDevicePanel=!open; state.ui.hideSidebar=true; saveUiPrefs(); };
  const closeMobileDevicePanel=el('btn-close-mobile-device-panel'); if(closeMobileDevicePanel) closeMobileDevicePanel.onclick=()=>setPanelHidden('hideDevicePanel', true);
  const closePicker=el('btn-close-device-picker'); if(closePicker) closePicker.onclick=closeDevicePicker;
  const pickerModal=el('device-picker-modal'); if(pickerModal) pickerModal.addEventListener('click',e=>{ if(e.target.id==='device-picker-modal') closeDevicePicker(); });
  const pickerSearch=el('device-picker-search'); if(pickerSearch) pickerSearch.oninput=renderDevicePicker;
  const pickerShowAll=el('device-picker-show-all'); if(pickerShowAll) pickerShowAll.onchange=e=>{ state.devicePickerShowAll=e.target.checked; renderDevicePicker(); };

  const placementModal=el('placement-editor-modal'); if(placementModal) placementModal.addEventListener('click',e=>{ if(e.target.id==='placement-editor-modal') closePlacementEditor(); });
  const placementSvg=el('placement-editor-svg'); if(placementSvg){
    placementSvg.addEventListener('pointerdown',e=>{
      const zoneTarget=e.target?.closest?.('[data-zone-room]');
      if(state.placementEditor?.targetType==='zone' && zoneTarget){
        e.preventDefault();
        e.stopPropagation();
        selectPlacementEditorZone(zoneTarget.dataset.zoneRoom);
        return;
      }
      const p=placementSvgPointFromEvent(e); if(!p) return;
      if(state.placementEditor?.targetType==='zone'){
        e.preventDefault();
        state.placementEditor.drawing=true;
        state.placementEditor.points=[];
        placementSvg.setPointerCapture?.(e.pointerId);
        addZoneDrawPoint(p,true);
        return;
      }
      setPlacementEditorPoint(p.x,p.y);
    });
    placementSvg.addEventListener('pointermove',e=>{
      if(!state.placementEditor?.drawing || state.placementEditor?.targetType!=='zone') return;
      const p=placementSvgPointFromEvent(e); if(p) addZoneDrawPoint(p,false);
    });
    const finishZoneDraw=e=>{
      if(!state.placementEditor?.drawing || state.placementEditor?.targetType!=='zone') return;
      state.placementEditor.drawing=false;
      placementSvg.releasePointerCapture?.(e.pointerId);
      renderZoneDrawPath();
      if(sanitizeZonePoints(state.placementEditor.points).length<3) showToast('Слишком короткая обводка. Обведите область минимум тремя точками.');
    };
    placementSvg.addEventListener('pointerup',finishZoneDraw);
    placementSvg.addEventListener('pointercancel',finishZoneDraw);
  }
  const px=el('placement-editor-x'); if(px) px.onchange=()=>setPlacementEditorPoint(px.value, state.placementEditor?.y ?? 50);
  const py=el('placement-editor-y'); if(py) py.onchange=()=>setPlacementEditorPoint(state.placementEditor?.x ?? 50, py.value);
  const pw=el('placement-editor-w'); if(pw) pw.onchange=()=>setZoneEditorSize(pw.value, state.placementEditor?.hPct ?? 10);
  const ph=el('placement-editor-h'); if(ph) ph.onchange=()=>setZoneEditorSize(state.placementEditor?.wPct ?? 10, ph.value);
  const pa=el('placement-editor-angle'); if(pa) pa.onchange=()=>setZoneEditorAngle(pa.value);
  const pam=el('btn-zone-angle-dec'); if(pam) pam.onclick=()=>nudgeZoneEditorAngle(-1);
  const pap=el('btn-zone-angle-inc'); if(pap) pap.onclick=()=>nudgeZoneEditorAngle(1);
  const prz=el('btn-zone-angle-reset'); if(prz) prz.onclick=()=>setZoneEditorAngle(0);
  const bzwm=el('btn-zone-w-dec'); if(bzwm) bzwm.onclick=()=>nudgeZoneEditorSize(-1,0);
  const bzwp=el('btn-zone-w-inc'); if(bzwp) bzwp.onclick=()=>nudgeZoneEditorSize(1,0);
  const bzhm=el('btn-zone-h-dec'); if(bzhm) bzhm.onclick=()=>nudgeZoneEditorSize(0,-1);
  const bzhp=el('btn-zone-h-inc'); if(bzhp) bzhp.onclick=()=>nudgeZoneEditorSize(0,1);
  const bpu=el('btn-place-up'); if(bpu) bpu.onclick=()=>nudgePlacementEditor(0,-1);
  const bpd=el('btn-place-down'); if(bpd) bpd.onclick=()=>nudgePlacementEditor(0,1);
  const bpl=el('btn-place-left'); if(bpl) bpl.onclick=()=>nudgePlacementEditor(-1,0);
  const bpr=el('btn-place-right'); if(bpr) bpr.onclick=()=>nudgePlacementEditor(1,0);
  const bpa=el('btn-apply-placement-editor'); if(bpa) bpa.onclick=applyPlacementEditor;
  const bpc=el('btn-cancel-placement-editor'); if(bpc) bpc.onclick=closePlacementEditor;
  const bpclr=el('btn-clear-zone-draw'); if(bpclr) bpclr.onclick=clearZoneDraw;
  const bpdelz=el('btn-delete-placement-zone'); if(bpdelz) bpdelz.onclick=deletePlacementEditorZone;
  const bpx=el('btn-close-placement-editor'); if(bpx) bpx.onclick=closePlacementEditor;
  const setupEmpty=el('btn-project-setup-empty'); if(setupEmpty) setupEmpty.onclick=openProjectSetupWizard;
  const settingsWizardBtn=el('btn-open-project-setup-wizard-settings'); if(settingsWizardBtn) settingsWizardBtn.onclick=openProjectSetupWizard;
  const toolbarKiosk=el('btn-toolbar-kiosk'); if(toolbarKiosk) toolbarKiosk.onclick=()=>{ state.ui.kioskMode=true; state.kioskLocked=false; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; state.ui.hideToolbar=true; saveUiPrefs(); render(); resetKioskAutoLock(); showToast('Режим киоска включён'); };
  el('btn-mobile-settings').onclick=()=>openModal('settings-modal');
  const exitKiosk=el('btn-exit-kiosk');
  if(exitKiosk) exitKiosk.onclick=()=>{ hideKioskRooms(); state.ui.kioskMode=false; state.kioskLocked=false; state.kioskTileRoomFilter=''; state.ui.hideToolbar=false; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; saveUiPrefs(); render(); showToast('Режим киоска выключен'); };
  const kioskMapMode=el('btn-kiosk-map-mode'); if(kioskMapMode) kioskMapMode.onclick=()=>{ state.ui.kioskTileMode=false; state.kioskTileRoomFilter=''; saveUiPrefs(); render(); };
  const kioskTileMode=el('btn-kiosk-tile-mode'); if(kioskTileMode) kioskTileMode.onclick=()=>{ state.ui.kioskTileMode=true; state.kioskTileRoomFilter=''; state.kioskTilePage=0; saveUiPrefs(); render(); if(state.selectedRoom==='overview') showToast('Выберите комнату: в режиме “Плитки” комната откроется карточками'); };
  const kioskAttention=el('btn-kiosk-attention'); if(kioskAttention) kioskAttention.onclick=openAttentionModal;
  const closeAttention=el('btn-close-attention'); if(closeAttention) closeAttention.onclick=closeAttentionModal;
  const attentionModal=el('attention-modal'); if(attentionModal) attentionModal.addEventListener('click',e=>{ if(e.target.id==='attention-modal') closeAttentionModal(); });
  const changePin=el('btn-change-pin'); if(changePin) changePin.onclick=async()=>{ const p1=window.prompt('Введите новый PIN, 4 цифры. Цифры отображаются при вводе.',''); if(p1===null) return; const p2=window.prompt('Повторите новый PIN',''); if(p2===null) return; try{ const res=await apiJson('api/security/pin/change',{method:'POST',body:JSON.stringify({pin:p1,pin2:p2})}); state.config={...(state.config||{}), security:{...(state.config?.security||{}), ...(res.security||{})}}; applyConfigToInputs(); showToast('PIN обновлён'); }catch(e){ showToast('Ошибка PIN: '+e.message); } };
  const resetPin=el('btn-reset-pin'); if(resetPin) resetPin.onclick=async()=>{ const p1=window.prompt('Введите PIN для сброса, 4 цифры.',''); if(p1===null) return; const p2=window.prompt('Повторите PIN для сброса',''); if(p2===null) return; try{ const res=await apiJson('api/security/pin/reset',{method:'POST',body:JSON.stringify({pin:p1,pin2:p2})}); state.config={...(state.config||{}), security:{...(state.config?.security||{}), ...(res.security||{})}}; applyConfigToInputs(); showToast('PIN сброшен'); }catch(e){ showToast('Ошибка сброса PIN: '+e.message); } };
  const clearAttention=el('btn-clear-attention'); if(clearAttention) bindHold(clearAttention, async()=>{ if(!canManageAttention()){ showToast('Очистка доступна только в admin mode и при разблокированном киоске'); return; } await apiJson('api/attention/clear',{method:'POST'}); await loadAttention(); renderAttentionModal(); showToast('Список Внимание очищен'); });
  const kioskLock=el('btn-kiosk-lock'); if(kioskLock) kioskLock.onclick=()=>setKioskLocked(!state.kioskLocked);
  const kioskRooms=el('btn-kiosk-rooms'); if(kioskRooms) kioskRooms.onclick=openKioskRooms;
  const closeKioskRooms=el('btn-close-kiosk-rooms'); if(closeKioskRooms) closeKioskRooms.onclick=hideKioskRooms;
  const kioskOverview=el('btn-kiosk-overview'); if(kioskOverview) kioskOverview.onclick=()=>{ selectRoom('overview'); hideKioskRooms(); };
  el('pref-mobile-mode').onchange=e=>{ state.ui.mobileMode=!!e.target.checked; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; applyUiPrefs(); saveUiPrefs(); };
  el('pref-auto-hide').onchange=e=>{state.ui.autoHide=e.target.checked; saveUiPrefs();};
  el('pref-compact-mode').onchange=e=>{state.ui.compact=e.target.checked; saveUiPrefs();};
  el('pref-dark-theme').onchange=e=>{state.ui.darkTheme=e.target.checked; applyUiPrefs();};
  el('pref-kiosk-widget').onchange=e=>{state.ui.kioskWidget=e.target.checked; applyUiPrefs(); renderKioskWidget();};
  const dbgPref=el('pref-debug-mode'); if(dbgPref) dbgPref.onchange=e=>{state.ui.debugMode=e.target.checked; applyUiPrefs(); saveGlobalPrefs().catch(()=>{});};
  const invZones=el('pref-invisible-zones'); if(invZones) invZones.onchange=e=>{state.ui.invisibleZones=e.target.checked; saveUiPrefs(); applyUiPrefs(); render();};
  el('pref-kiosk-mode').onchange=e=>{state.ui.kioskMode=e.target.checked; if(e.target.checked){ state.kioskLocked=false; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; state.ui.hideToolbar=true; } saveUiPrefs(); render(); resetKioskAutoLock();};
  const ktp=el('pref-kiosk-navigation-mode'); if(ktp) ktp.onchange=e=>{ state.ui.kioskNavigationMode=e.target.value; if(e.target.value==='maps') state.ui.kioskTileMode=false; if(e.target.value==='tiles') state.ui.kioskTileMode=true; state.kioskTilePage=0; saveUiPrefs(); applyUiPrefs(); render(); };
  const oldKtp=el('pref-kiosk-tile-mode'); if(oldKtp) oldKtp.onchange=e=>{ state.ui.kioskTileMode=!!e.target.checked; state.kioskTilePage=0; saveUiPrefs(); render(); };
  const pal=el('pref-kiosk-autolock'); if(pal) pal.onchange=e=>{state.ui.kioskAutoLock=e.target.checked; applyUiPrefs(); saveGlobalPrefs().catch(()=>{});};
  const pas=el('pref-kiosk-autolock-seconds'); if(pas) pas.onchange=e=>{state.ui.kioskAutoLockSeconds=Math.max(5, Math.min(300, Number(e.target.value||15))); applyUiPrefs(); saveGlobalPrefs().catch(()=>{});};
  el('pref-weather-entity').onchange=e=>{state.ui.weatherEntity=e.target.value.trim(); renderKioskWidget();};
  const showAllPref=el('pref-show-all-devices-room'); if(showAllPref) showAllPref.onchange=e=>{state.ui.showAllDevicesInRoom=e.target.checked; renderDevices(); saveGlobalPrefs().catch(()=>{});};
  const pmodeSelect=el('pref-panel-mode');
  if(pmodeSelect) pmodeSelect.onchange=async()=>{
    const oldMode=state.config?.security?.panelMode||'admin';
    const newMode=pmodeSelect.value;
    if(state.config?.security?.pinEnabled && panelModeRank(newMode)>panelModeRank(oldMode)){
      const ok=await verifyPinPrompt('Введите PIN для перехода в более высокий режим');
      if(!ok){ pmodeSelect.value=oldMode; showToast('Неверный PIN'); return; }
    }
    saveGlobalPrefs().then(()=>{ if(!canEditLayout() && state.edit) cancelEditChanges(); updateEditButtons(); applyUiPrefs(); render(); }).catch(()=>{});
  };
  ['pref-confirm-dangerous','pref-dangerous-pin'].forEach(id=>{ const n=el(id); if(n) n.onchange=()=>{ saveGlobalPrefs().then(()=>{ updateEditButtons(); applyUiPrefs(); render(); }).catch(()=>{}); }; });
  bindRangePreview('pref-halo-scale','haloScale','pref-halo-scale-value');
  bindRangePreview('pref-hardware-scale','hardwareScale','pref-hardware-scale-value');
  bindRangePreview('pref-marker-scale','markerScale','pref-marker-scale-value');
  bindRangePreview('pref-sensor-scale','sensorScale','pref-sensor-scale-value');
  bindRangePreview('pref-room-label-scale','roomLabelScale','pref-room-label-scale-value');
  bindRangePreview('pref-marker-opacity','markerOpacity','pref-marker-opacity-value');
  bindRangePreview('pref-sensor-opacity','sensorOpacity','pref-sensor-opacity-value');
  const zb=el('btn-zoom-out'); if(zb) zb.onclick=()=>zoomViewport(activeStageKind(), .86);
  const zi=el('btn-zoom-in'); if(zi) zi.onclick=()=>zoomViewport(activeStageKind(), 1.16);
  const zf=el('btn-zoom-fit'); if(zf) zf.onclick=()=>fitViewport(activeStageKind());
  qsa('[data-ha-back]').forEach(a=>a.addEventListener('click',e=>{ if(state.selectedRoom!=='overview'){ e.preventDefault(); selectRoom('overview'); } }));
  el('btn-fullscreen').onclick=async()=>{try{ if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }catch(e){showToast('Полный экран недоступен: '+e.message)}};
  el('btn-quick-overlay').onclick=()=>{state.quickOverlayOpen=true; el('quick-overlay').classList.remove('hidden'); renderQuickActions();};
  el('btn-close-quick-overlay').onclick=()=>{state.quickOverlayOpen=false; el('quick-overlay').classList.add('hidden');};

  /* ── Тема оформления ─────────────────────────────────────────── */
  const ptSel=el('pref-theme');
  if(ptSel) ptSel.onchange=e=>{
    state.ui.theme=e.target.value;
    state.ui.darkTheme=['dark','midnight'].includes(e.target.value);
    applyUiPrefs();
    saveUiPrefs();
  };

  /* ── Undo / Redo кнопки ──────────────────────────────────────── */
  const undoBtn=el('btn-undo'); if(undoBtn) undoBtn.onclick=()=>doUndo();
  const redoBtn=el('btn-redo'); if(redoBtn) redoBtn.onclick=()=>doRedo();

  /* ── Ctrl+Z / Ctrl+Y ─────────────────────────────────────────── */
  document.addEventListener('keydown', e=>{
    if(e.target.closest('input,textarea,select')) return;
    if((e.ctrlKey||e.metaKey) && e.key==='z' && !e.shiftKey){ e.preventDefault(); doUndo(); }
    if((e.ctrlKey||e.metaKey) && (e.key==='y' || (e.key==='z' && e.shiftKey))){ e.preventDefault(); doRedo(); }
  });

  /* ── Камера: закрытие и обновление ──────────────────────────── */
  const closeCamBtn=el('btn-close-camera'); if(closeCamBtn) closeCamBtn.onclick=closeCameraModal;
  const camModal=el('camera-modal'); if(camModal) camModal.addEventListener('click',e=>{ if(e.target.id==='camera-modal') closeCameraModal(); });
  const camRefresh=el('btn-camera-refresh');
  if(camRefresh) camRefresh.onclick=()=>{
    const img=el('camera-stream-img');
    if(img && img.dataset.entity){ img.src=''; img.src='api/camera/stream/'+encodeURIComponent(img.dataset.entity)+'?t='+Date.now(); }
  };

  /* ── Свайп между комнатами (мобильный) ──────────────────────── */
  (function bindSwipe(){
    let sx=0, sy=0, sTime=0;
    const MIN_DIST=60, MAX_Y_RATIO=0.6, MAX_MS=400;
    function onSwipeStart(e){
      if(state.edit || state.quickOverlayOpen) return;
      const t=e.touches?.[0]||e;
      sx=t.clientX; sy=t.clientY; sTime=Date.now();
    }
    function onSwipeEnd(e){
      if(state.edit || state.quickOverlayOpen) return;
      if(!sTime) return;
      const t=e.changedTouches?.[0]||e;
      const dx=t.clientX-sx, dy=t.clientY-sy, dt=Date.now()-sTime;
      sTime=0;
      if(dt>MAX_MS || Math.abs(dx)<MIN_DIST || Math.abs(dy/dx)>MAX_Y_RATIO) return;
      const idx=ROOMS.findIndex(r=>r.id===state.selectedRoom);
      if(dx<0){ const next=ROOMS[idx+1]; if(next) selectRoom(next.id); }
      else { const prev=ROOMS[idx-1]; if(prev) selectRoom(prev.id); }
    }
    [el('overview-stage'),el('room-stage')].forEach(s=>{
      if(!s) return;
      s.addEventListener('touchstart',onSwipeStart,{passive:true});
      s.addEventListener('touchend',onSwipeEnd,{passive:true});
    });
  })();

  /* ── Экспорт / Импорт планировки ────────────────────────────── */
  const exportBtn=el('btn-export-layout');
  if(exportBtn) exportBtn.onclick=async()=>{
    try{
      const res=await fetch('api/export/layout');
      if(!res.ok) throw new Error(await res.text());
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url; a.download='allha2d-layout.json'; a.click();
      URL.revokeObjectURL(url);
    }catch(e){ showToast('Экспорт: '+e.message); }
  };
  const importBtn=el('btn-import-layout');
  const importFile=el('import-layout-file');
  if(importBtn && importFile){
    importBtn.onclick=()=>importFile.click();
    importFile.onchange=async e=>{
      const file=e.target.files?.[0]; e.target.value='';
      if(!file) return;
      try{
        const text=await file.text();
        const data=JSON.parse(text);
        const res=await apiJson('api/import/layout',{method:'POST',body:JSON.stringify(data)});
        if(res.ok){ showToast('Планировка импортирована, перезагрузка…'); setTimeout(()=>location.reload(),1200); }
      }catch(e){ showToast('Импорт: '+e.message); }
    };
  }
}

async function initialHaSync(){
  try{
    await testConnection({keepModal:true});
    if(state._connectSse) state._connectSse(); // запускаем WS-подписку через SSE
  }catch(e){
    console.error('initial HA sync failed', e);
    setConnection(false,'Ошибка подключения');
    startPolling(); // fallback если SSE недоступен
  }
}

(async function init(){
  await loadLayout();
  await loadSourceConfig();
  await loadPersistedUiState();
  await loadAttention();
  await loadImagesInfo();
  await loadRoomsSettings();
  await loadProfilesInfo();
  await loadLevelsInfo();
  loadKioskLockLocal();
  bindGlobal();
  startClock();
  renderSourceSettings();
  render();
  try{
    await loadConfig();
    await loadClientPrefs(); // применяем per-device настройки поверх глобальных
    await loadSecurityRules();
    applyConfigToInputs();
    renderProfilesManager();
    renderLevelsManager();
  }catch(e){
    console.error('config load failed', e);
  }
  await initialHaSync();
})();

window.addEventListener('resize', ()=>{ syncAutoMobileMode(); applyUiPrefs(); renderKioskTiles(); applyStageTransform(activeStageKind()); updateZoomControls(); refitPlacementEditorSoon(); }, {passive:true});
window.addEventListener('orientationchange', ()=>setTimeout(()=>{ syncAutoMobileMode(); applyUiPrefs(); renderKioskTiles(); applyStageTransform(activeStageKind()); updateZoomControls(); refitPlacementEditorSoon(); }, 250), {passive:true});
window.addEventListener('load', ()=>{ lockViewportScroll(); applyStageTransform(activeStageKind()); });
document.addEventListener('touchmove', e=>{ if(e.target.closest('.modal,.device-list,.sidebar,.device-panel,.source-settings,.info-content,.faq-frame,.faq-modal-card')) return; e.preventDefault(); }, {passive:false});


/* v3.4.12: keep mobile bottom bar and kiosk controls from covering open modals */
function syncModalOpenClass(){
  const anyOpen = Array.from(document.querySelectorAll('.modal')).some(m=>!m.classList.contains('hidden'));
  document.body.classList.toggle('modal-open', anyOpen);
}
const _modalClassObserver = new MutationObserver(syncModalOpenClass);
window.addEventListener('DOMContentLoaded',()=>{
  document.querySelectorAll('.modal').forEach(m=>_modalClassObserver.observe(m,{attributes:true,attributeFilter:['class']}));
  syncModalOpenClass();
});


// v3.4.14: mobile panel stability. Tap outside Rooms/Devices sheets closes them.
document.addEventListener('pointerdown', e=>{
  if(!isMobilePanelMode() || state.ui.kioskMode || document.body.classList.contains('modal-open')) return;
  if(state.ui.hideSidebar && state.ui.hideDevicePanel) return;
  if(e.target.closest('.sidebar,.device-panel,.mobile-menu-bar,.floating-menu-btn,.modal,.device-modal-card,.kiosk-room-overlay')) return;
  closeMobilePanels();
}, {capture:true});

window.openDevicePicker=openDevicePicker;
