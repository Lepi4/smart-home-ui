const state = {
  selectedRoom: 'overview',
  states: {},
  pollTimer: null,
  config: null,
  sourceConfig: null,
  layout: { version: 8, coordinateSpace: 'room-content-box', overviewRoomSync: false, roomCoordinateMigrated: {}, overviewMarkers: {}, roomMarkers: {}, overviewMetrics: {}, roomMetrics: {}, zones: {}, customNames: {} },
  edit: false,
  editSnapshot: null,
  layoutDirty: false,
  dragged: null,
  dragMoved: false,
  selectedEdit: null,
  suppressClick: false,
  quickOverlayOpen: false,
  serverUiState: null,
  ui: { hideSidebar:false, hideDevicePanel:false, hideToolbar:false, mobileMode:false, autoHide:false, compact:false, haloScale:0.50, hardwareScale:1.00, markerScale:1.00, sensorScale:1.00, markerOpacity:0.00, sensorOpacity:0.00, showAllDevicesInRoom:false, darkTheme:true, kioskWidget:false, kioskMode:false, weatherEntity:'' },
  viewport: { overview:{zoom:1,panX:0,panY:0}, rooms:{} },
  stageGesture: null, editHoldTimer:null, diagnostics:null, infoTab:'summary', clockTimer:null, persistTimer:null
};

const ROOMS = window.PLAN_CONFIG.rooms || [];
const ROOM_MAP = Object.fromEntries(ROOMS.map(r => [r.id, r]));
const TYPE_ICONS = { light:'💡', switch:'🔌', cover:'▤', climate:'❄️', media_player:'▶️', humidifier:'💧', sensor:'📟', binary_sensor:'●', valve:'🚰', lock:'🔒', scene:'✨', fan:'💨', input_boolean:'✅', input_number:'🔢', input_select:'▾', button:'⏺', script:'▶', automation:'⚙', person:'👤' };
const TOGGLE_DOMAINS = new Set(['light','switch','fan','input_boolean','cover','media_player','climate','humidifier','valve']);
const IMPORTANT_DOMAINS = new Set(['light','switch','cover','climate','media_player','humidifier','fan','sensor','binary_sensor','input_boolean','input_number','input_select','valve','lock','button','script','automation']);
const LONG_PRESS_MS = 560;
const GESTURE_MOVE_PX = 14;
const DRAG_SUPPRESS_MS = 420;

function el(id){return document.getElementById(id)}
function qsa(s,p=document){return [...p.querySelectorAll(s)]}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
function midpoint(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}}
function room(id){return ROOM_MAP[id]}
function roomWithLayout(id){const r=room(id); return {...r,...(state.layout.zones?.[id]||{})}}
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
    const saved=JSON.parse(localStorage.getItem('ui_prefs')||'{}');
    const last=JSON.parse(localStorage.getItem('last_view')||'{}');
    const autoMobile = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    state.ui = { ...state.ui, ...(server.ui||{}), ...saved };
    if(autoMobile){
      state.ui.mobileMode = true;
      // На телефоне панели должны стартовать закрытыми. Иначе их может заблокировать CSS/Ingress,
      // а нижние кнопки выглядят нерабочими.
      state.ui.hideSidebar = true;
      state.ui.hideDevicePanel = true;
    }
    if(last.selectedRoom || server.selectedRoom) state.selectedRoom = last.selectedRoom || server.selectedRoom || state.selectedRoom;
    if(state.selectedRoom !== 'overview' && !ROOM_MAP[state.selectedRoom]) state.selectedRoom='overview';
    loadViewportPrefs();
    applyUiPrefs();
  }catch(e){ loadViewportPrefs(); applyUiPrefs(); }
}
function currentUiStatePayload(){ return { selectedRoom: state.selectedRoom, ui: state.ui, viewport: state.viewport }; }
function persistUiStateSoon(){
  clearTimeout(state.persistTimer);
  state.persistTimer=setTimeout(()=>{
    fetch('api/ui-state',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(currentUiStatePayload())}).catch(()=>{});
  }, 500);
}
function saveUiPrefs(){
  localStorage.setItem('ui_prefs', JSON.stringify(state.ui));
  localStorage.setItem('last_view', JSON.stringify({selectedRoom:state.selectedRoom, updatedAt:new Date().toISOString()}));
  applyUiPrefs();
  persistUiStateSoon();
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
function setViewport(kind, next, persist=true){
  const v=getViewport(kind);
  v.zoom=clamp(Number(next.zoom ?? v.zoom)||1, 0.5, 4);
  v.panX=clamp(Number(next.panX ?? v.panX)||0, -5000, 5000);
  v.panY=clamp(Number(next.panY ?? v.panY)||0, -5000, 5000);
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
  const hardware=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5);
  const scale=hardware*v.zoom;
  content.style.transformOrigin='0 0';
  content.style.transform=`translate(${v.panX}px, ${v.panY}px) scale(${scale})`;
  content.dataset.scale=String(scale);
}
function activeStageKind(){ return state.selectedRoom==='overview'?'overview':'room'; }
function updateZoomControls(){
  const zv=el('zoom-value'); if(zv){ const v=getViewport(activeStageKind()); const hw=clamp(Number(state.ui.hardwareScale ?? 1), .3, 1.5); zv.textContent=Math.round(v.zoom*hw*100)+'%'; }
}
function fitViewport(kind){ resetViewport(kind); }
function setPanelHidden(key, value){ state.ui[key]=!!value; saveUiPrefs(); }
function applyUiPrefs(){
  document.body.classList.toggle('touch-capable', !!(navigator.maxTouchPoints && navigator.maxTouchPoints > 0));
  document.body.classList.toggle('hide-sidebar', !!state.ui.hideSidebar);
  document.body.classList.toggle('hide-device-panel', !!state.ui.hideDevicePanel);
  document.body.classList.toggle('hide-toolbar', !!state.ui.hideToolbar);
  document.body.classList.toggle('mobile-mode', !!state.ui.mobileMode);
  document.body.classList.toggle('auto-hide-menus', !!state.ui.autoHide);
  document.body.classList.toggle('compact-mode', !!state.ui.compact);
  document.body.classList.toggle('dark-theme', !!state.ui.darkTheme);
  document.body.classList.toggle('kiosk-mode', !!state.ui.kioskMode);
  const isNarrowMobile = window.matchMedia && window.matchMedia('(max-width: 560px)').matches;
  const mobileMarkerFactor = isNarrowMobile ? 0.84 : 1;
  const mobileSensorFactor = isNarrowMobile ? 0.72 : 1;
  document.documentElement.style.setProperty('--marker-scale', String(clamp(Number(state.ui.markerScale ?? 1), .5, 2) * mobileMarkerFactor));
  document.documentElement.style.setProperty('--sensor-scale', String(clamp(Number(state.ui.sensorScale ?? 1), .5, 2) * mobileSensorFactor));
  document.documentElement.style.setProperty('--marker-bg-opacity', String(clamp(1 - Number(state.ui.markerOpacity ?? 0), 0, 1))); // setting is background transparency
  document.documentElement.style.setProperty('--sensor-bg-opacity', String(clamp(1 - Number(state.ui.sensorOpacity ?? 0), 0, 1))); // setting is background transparency
  const bs=el('btn-show-sidebar'); if(bs) bs.classList.toggle('hidden', !state.ui.hideSidebar || state.ui.kioskMode);
  const bd=el('btn-show-device-panel'); if(bd) bd.classList.toggle('hidden', !state.ui.hideDevicePanel || state.ui.kioskMode);
  const bt=el('btn-show-toolbar'); if(bt) bt.classList.toggle('hidden', !state.ui.hideToolbar || state.ui.kioskMode);
  const hs=el('btn-hide-sidebar'); if(hs) hs.textContent=state.ui.hideSidebar?'Показать':'Скрыть';
  const td=el('btn-toggle-devices-panel'); if(td) td.textContent=state.ui.hideDevicePanel?'Показать список':'Скрыть список';
  const tt=el('btn-toggle-toolbar'); if(tt) tt.textContent=state.ui.hideToolbar?'Показать верх':'Скрыть верх';
  const pm=el('pref-mobile-mode'); if(pm) pm.checked=!!state.ui.mobileMode;
  const pa=el('pref-auto-hide'); if(pa) pa.checked=!!state.ui.autoHide;
  const pc=el('pref-compact-mode'); if(pc) pc.checked=!!state.ui.compact;
  const dt=el('pref-dark-theme'); if(dt) dt.checked=!!state.ui.darkTheme;
  const kw=el('pref-kiosk-widget'); if(kw) kw.checked=!!state.ui.kioskWidget;
  const km=el('pref-kiosk-mode'); if(km) km.checked=!!state.ui.kioskMode;
  const we=el('pref-weather-entity'); if(we) we.value=state.ui.weatherEntity||'';
  const widget=el('kiosk-widget'); if(widget) widget.classList.toggle('hidden', !state.ui.kioskWidget);
  const showAll=el('pref-show-all-devices-room'); if(showAll) showAll.checked=!!state.ui.showAllDevicesInRoom;
  const ph=el('pref-halo-scale'); if(ph){ ph.value=String(Math.round(Number(state.ui.haloScale ?? 0.50)*100)); const hv=el('pref-halo-scale-value'); if(hv) hv.textContent=ph.value+'%'; }
  const hw=el('pref-hardware-scale'); if(hw){ hw.value=String(Math.round(Number(state.ui.hardwareScale ?? 1)*100)); const hv=el('pref-hardware-scale-value'); if(hv) hv.textContent=hw.value+'%'; }
  const ms=el('pref-marker-scale'); if(ms){ ms.value=String(Math.round(Number(state.ui.markerScale ?? 1)*100)); const mv=el('pref-marker-scale-value'); if(mv) mv.textContent=ms.value+'%'; }
  const ss=el('pref-sensor-scale'); if(ss){ ss.value=String(Math.round(Number(state.ui.sensorScale ?? 1)*100)); const sv=el('pref-sensor-scale-value'); if(sv) sv.textContent=ss.value+'%'; }
  const mo=el('pref-marker-opacity'); if(mo){ mo.value=String(Math.round(Number(state.ui.markerOpacity ?? 0)*100)); const mv=el('pref-marker-opacity-value'); if(mv) mv.textContent=mo.value+'%'; }
  const so=el('pref-sensor-opacity'); if(so){ so.value=String(Math.round(Number(state.ui.sensorOpacity ?? 0)*100)); const sv=el('pref-sensor-opacity-value'); if(sv) sv.textContent=so.value+'%'; }
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
  const digits = kind==='temperature' ? 1 : 0;
  if(kind==='temperature' || kind==='humidity' || kind==='illuminance' || kind==='noise'){
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
function stateText(d){const s=getState(d.entity_id); if(!s)return 'нет данных'; if(s.state==='unavailable')return 'недоступно'; return s.state}
function fmtNum(v, digits){const n=Number(v); return Number.isFinite(n)?n.toFixed(digits).replace('.',','):''}
function tempValue(entity){const s=getState(entity); return s?fmtNum(s.state,1):''}
function humValue(entity){const s=getState(entity); return s?String(Math.round(Number(s.state)||0)):''}
function findClimateEntity(r, kind){
  const explicit = kind==='temperature' ? r.temp : r.humidity;
  if(explicit && getState(explicit)) return explicit;
  const names = kind==='temperature' ? ['температура','temperature','external_sensor'] : ['влажность','humidity'];
  const list = allDevices().filter(d=>normalizedRoomId(d.room)===normalizedRoomId(r.id) && d.domain==='sensor');
  const exact = list.find(d=>names.some(n=>(`${d.label} ${d.name} ${d.entity_id}`).toLowerCase().includes(n)) && getState(d.entity_id));
  return exact?.entity_id || explicit || '';
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


function cloneLayout(layout){ return JSON.parse(JSON.stringify(layout || {})); }
function setLayoutDirty(value=true){
  state.layoutDirty=!!value;
  updateEditButtons();
}
function updateEditButtons(){
  const eb=el('edit-mode-badge'); if(eb){ eb.textContent=state.edit?(state.layoutDirty?'Редактирование · есть изменения':'Редактирование'):'Режим управления'; eb.className='edit-mode-badge '+(state.edit?'is-edit':'is-view'); }
  const editBtn=el('btn-edit'), saveBtn=el('btn-save-edit'), cancelBtn=el('btn-cancel-edit');
  if(editBtn) editBtn.classList.toggle('hidden', state.edit);
  if(saveBtn){ saveBtn.classList.toggle('hidden', !state.edit); saveBtn.disabled=false; saveBtn.textContent='Сохранить изменения'; }
  if(cancelBtn) cancelBtn.classList.toggle('hidden', !state.edit);
}
function enterEditMode(){
  state.editSnapshot=cloneLayout(state.layout);
  state.selectedEdit=null;
  state.edit=true;
  setLayoutDirty(false);
  showToast('Режим редактирования: изменения применятся только после сохранения.');
  render();
}
async function saveEditChanges(){
  if(!state.edit) return;
  if(!state.layoutDirty){
    state.edit=false;
    state.editSnapshot=null;
    updateEditButtons();
    showToast('Изменений нет');
    render();
    return;
  }
  await saveLayout(true);
  state.edit=false;
  state.editSnapshot=null;
  state.selectedEdit=null;
  setLayoutDirty(false);
  showToast('Изменения сохранены');
  render();
}
function cancelEditChanges(){
  if(!state.edit) return;
  if(state.editSnapshot) state.layout=cloneLayout(state.editSnapshot);
  state.edit=false;
  state.editSnapshot=null;
  state.selectedEdit=null;
  setLayoutDirty(false);
  showToast('Изменения отменены');
  render();
}

function render(){
  document.body.classList.toggle('editing', state.edit);
  document.body.classList.toggle('viewing', !state.edit);
  const eb=el('edit-mode-badge'); if(eb){ eb.textContent=state.edit?(state.layoutDirty?'Редактирование · есть изменения':'Редактирование'):'Режим управления'; eb.className='edit-mode-badge '+(state.edit?'is-edit':'is-view'); }
  const be=el('btn-edit'); if(be){ be.classList.toggle('edit-active', state.edit); be.setAttribute('aria-pressed', String(state.edit)); }
  updateEditButtons();
  const isOverview = state.selectedRoom==='overview';
  const qbtn=el('btn-quick-overlay'); if(qbtn) qbtn.classList.toggle('hidden', isOverview);
  el('overview-view').classList.toggle('active', isOverview);
  el('room-view').classList.toggle('active', !isOverview);
  el('page-title').textContent = isOverview ? 'Общий план' : room(state.selectedRoom).label;
  el('page-subtitle').textContent = isOverview ? 'Тап по комнате открывает отдельный вид помещения' : 'Тап по устройству — действие, удержание — функции';
  renderNav();
  if(isOverview){ renderOverview(); } else { renderRoom(); }
  renderDevices();
  renderEditSheet();
  renderKioskWidget();
  updateZoomControls();
}

function renderOverview(){
  fitStage('overview');
  renderOverviewZones();
  renderOverviewMetrics();
  renderOverviewMarkers();
}
function renderOverviewZones(){
  const layer=el('overview-zones'); layer.innerHTML='';
  if(!el('toggle-zones').checked)return;
  ROOMS.filter(r=>r.id!=='overview').forEach(r0=>{
    const r=roomWithLayout(r0.id);
    const z=document.createElement('button');
    z.className='room-zone'+(isSelectedEdit('zone', r.id, 'overview')?' edit-selected':''); z.dataset.room=r.id;
    Object.assign(z.style,{left:r.x+'%',top:r.y+'%',width:r.w+'%',height:r.h+'%'});
    z.innerHTML=`<span class="zone-label">${esc(r.label)}</span><span class="zone-handle" data-handle="resize"></span>`;
    z.addEventListener('pointerdown', zoneDown);
    z.onclick=e=>{if(state.edit||state.suppressClick){state.suppressClick=false;return} selectRoom(r.id)};
    layer.appendChild(z);
  });
}
function metricContent(r){
  const tempEntity = findClimateEntity(r,'temperature');
  const humEntity = findClimateEntity(r,'humidity');
  const t = tempEntity ? tempValue(tempEntity) : '';
  const h = humEntity ? humValue(humEntity) : '';
  if(!t && !h) return '';
  return `<span class="temp">${t||'—'}°</span>${h?`<span class="drop">💧</span> ${h}%`:''}`;
}
function defaultMetricPos(r){return {x:clamp(r.x-r.w/4,2,98),y:clamp(r.y-r.h/4,2,98)}}
function renderOverviewMetrics(){
  const layer=el('overview-metrics'); layer.innerHTML=''; if(!el('toggle-sensors')?.checked)return;
  ROOMS.filter(r=>r.id!=='overview').forEach(r0=>{
    const r=roomWithLayout(r0.id); const html=metricContent(r); if(!html)return;
    const p=state.layout.overviewMetrics?.[r.id] || defaultMetricPos(r);
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
  if(img.src!==location.origin+r.image) img.src=r.image;
  else if(img.complete) afterRoomImageReady();
  el('room-title').textContent=r.label;
  el('room-climate-line').innerHTML=metricContent(r)||'<span class="muted">Нет назначенных датчиков температуры/влажности</span>';
}
function renderRoomMetrics(){
  const layer=el('room-metrics'); layer.innerHTML=''; if(!el('toggle-sensors')?.checked)return; const r=room(state.selectedRoom); const html=metricContent(r); if(!html)return;
  const stored=state.layout.roomMetrics?.[r.id] || {x:16,y:16};
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
}
function markerEl(d,p,scope){
  const b=document.createElement('button');
  const renderPos = scope==='room' ? roomStoredToImagePos(state.selectedRoom, p) : p;
  b.className='device-marker '+visualClass(d)+(shouldRenderSensorTextMarker(d, scope)?' text-marker sensor-readout':'')+(isSelectedEdit('marker', d.entity_id, scope)?' edit-selected':'');
  b.dataset.entity=d.entity_id; b.dataset.scope=scope; b.dataset.domain=d.domain||domainOf(d.entity_id); b.title=`${displayName(d)}\n${d.entity_id}`;
  b.style.left=renderPos.x+'%'; b.style.top=renderPos.y+'%'; b.style.cssText += visualStyle(d); b.innerHTML=markerInnerHtml(d, scope);
  attachPressActions(b,d,{dragHandler:markerDown});
  b.addEventListener('contextmenu',e=>{
    e.preventDefault();
    if(state.edit){ selectEditObject({kind:'marker', id:d.entity_id, scope, label:displayName(d)}); }
    else openDeviceModal(d);
  });
  return b;
}
function quickActionsHtml(list){
  return list.length?list.map(d=>`<button type="button" class="quick-action ${visualClass(d)}" style="${visualStyle(d)}" data-quick="${esc(d.entity_id)}"><span class="quick-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</span><span>${esc(displayName(d))}</span><span class="muted">${esc(markerValueLabel(d)||stateText(d))}</span></button>`).join(''):'<p class="muted">Нет быстрых действий</p>';
}
function bindQuickActions(container){
  qsa('[data-quick]',container).forEach(btn=>{const d=devices().find(x=>x.entity_id===btn.dataset.quick); if(d) attachPressActions(btn,d)});
}
function renderQuickActions(){
  const list=roomDevices(state.selectedRoom).filter(d=>['light','switch','cover','climate','media_player','fan','humidifier','input_number','input_select','valve','button','script','automation'].includes(d.domain)).slice(0,24);
  const box=el('quick-actions'); if(box){ box.innerHTML=quickActionsHtml(list); bindQuickActions(box); }
  const over=el('quick-overlay-list'); if(over){ over.innerHTML=quickActionsHtml(list); bindQuickActions(over); }
}
function canDragDeviceFromList(d){
  if(!state.edit) return false;
  if(state.selectedRoom==='overview') return true;
  return normalizedRoomId(d.room)===normalizedRoomId(state.selectedRoom);
}
function renderDevices(){
  const list=el('device-list');
  const q=(el('device-search').value||'').toLowerCase();
  const showAllInRoom = state.selectedRoom!=='overview' && state.edit && !!state.ui.showAllDevicesInRoom;
  const current=state.selectedRoom==='overview'||showAllInRoom?devices():roomDevices(state.selectedRoom);
  const filtered=current.filter(d=>IMPORTANT_DOMAINS.has(d.domain)).filter(d=>(displayName(d)+' '+d.entity_id+' '+(d.category||'')+' '+(ROOM_MAP[d.room]?.label||'')).toLowerCase().includes(q));
  el('devices-title').textContent=state.selectedRoom==='overview'?'Все устройства':(showAllInRoom?`Все устройства · ${room(state.selectedRoom).label}`:`Устройства: ${room(state.selectedRoom).label}`);
  el('device-count').textContent=`${filtered.length} из ${current.length}`;
  list.innerHTML=filtered.map(d=>{
    const sameRoom = state.selectedRoom==='overview' || normalizedRoomId(d.room)===normalizedRoomId(state.selectedRoom);
    const draggable = canDragDeviceFromList(d);
    const roomLabel = ROOM_MAP[normalizedRoomId(d.room)]?.label || d.room || 'Без комнаты';
    const extra = showAllInRoom && !sameRoom ? ` · ${esc(roomLabel)}` : '';
    const title = draggable ? d.entity_id : `${d.entity_id}\nУстройство из другой комнаты. В этом патче перенос в текущую комнату отключён.`;
    return `<div class="device-card ${visualClass(d)} ${sameRoom?'':'out-room'}" style="${visualStyle(d)}" draggable="${draggable?'true':'false'}" data-entity="${esc(d.entity_id)}" title="${esc(title)}"><div class="dev-icon">${iconMarkup(d)}${markerValueHtml(d,'quick')}</div><div><div class="name">${esc(displayName(d))}</div><div class="meta">${esc(d.category||roomLabel||'')} · ${esc(d.domain)}${extra}</div></div><button class="state" data-toggle="${esc(d.entity_id)}">${esc(stateText(d))}</button></div>`;
  }).join('');
  qsa('.device-card',list).forEach(card=>{
    card.ondragstart=e=>{
      const d=devices().find(x=>x.entity_id===card.dataset.entity);
      if(!d || !canDragDeviceFromList(d)){ e.preventDefault(); showToast('Перенос устройств между комнатами пока отключён'); return; }
      e.dataTransfer.setData('text/entity-id',card.dataset.entity);e.dataTransfer.effectAllowed='copy';
    };
    const d=devices().find(x=>x.entity_id===card.dataset.entity); if(d) attachPressActions(card,d,{ignoreSelector:'button'});
  });
  qsa('[data-toggle]',list).forEach(btn=>{const d=devices().find(x=>x.entity_id===btn.dataset.toggle); if(d) attachPressActions(btn,d)});
}

function openDevice(d){ openDeviceModal(d); }
function shortDeviceAction(d){ if(canPrimaryAction(d)) return toggleDevice(d); openDeviceModal(d); }
function attachPressActions(node,d,opts={}){
  let timer=null, longFired=false, sx=0, sy=0, pointerId=null;
  const cancelTimer=()=>{ if(timer){ clearTimeout(timer); timer=null; } };
  node.addEventListener('pointerdown', e=>{
    if(opts.ignoreSelector && e.target.closest(opts.ignoreSelector)) return;
    if(opts.dragHandler && state.edit){ opts.dragHandler(e); return; }
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
    if(!state.edit) openDeviceModal(d);
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
    <div class="device-controls">${domainControls(d)}</div>`;
  modal.classList.remove('hidden'); bindDeviceModalActions(d);
}
function closeDeviceModal(){el('device-modal').classList.add('hidden')}
async function callService(domain,service,data){ await apiJson('api/ha/service',{method:'POST',body:JSON.stringify({domain,service,data})}); await loadStates(); }
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
function currentRoomGeometry(){
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
function legacyStageToRoomContentPos(p){
  const g=currentRoomGeometry(); if(!g) return p;
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
    const np=legacyStageToRoomContentPos(p);
    state.layout.roomMarkers[roomId][eid]=np;
    changed=true;
  }
  if(metrics[roomId]){
    state.layout.roomMetrics[roomId]=legacyStageToRoomContentPos(metrics[roomId]);
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
  if(hint) hint.textContent = state.selectedEdit ? 'Перетащите выбранный объект пальцем или мышью. Управление устройствами в редакторе отключено.' : 'Коснитесь зоны, маркера или показателя, чтобы выбрать. Затем перетащите.';
  const del=el('btn-delete-selected');
  const reset=el('btn-reset-selected');
  if(del) del.disabled=!(state.selectedEdit && state.selectedEdit.kind==='marker');
  if(reset) reset.disabled=!state.selectedEdit;
}
function deleteSelectedEditObject(){
  const s=state.selectedEdit;
  if(!state.edit || !s) return;
  if(s.kind!=='marker'){ showToast('Удалять можно только маркеры устройств'); return; }
  removeMarker(s.id, s.scope);
  state.selectedEdit=null;
  setLayoutDirty(true);
  render();
}
function resetSelectedEditObject(){
  const s=state.selectedEdit;
  if(!state.edit || !s) return;
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
  try{ await apiJson('api/ha/service',{method:'POST',body:JSON.stringify({domain,service,data})}); showToast(`${displayName(d)}: команда отправлена`); await loadStates(); }
  catch(e){showToast('Ошибка управления: '+e.message)}
}

function percentIn(element,cx,cy){const r=element.getBoundingClientRect();return {x:clamp((cx-r.left)/r.width*100,0,100),y:clamp((cy-r.top)/r.height*100,0,100)}}
function zoneDown(e){ if(!state.edit)return; e.preventDefault(); e.stopPropagation(); const z=e.currentTarget; const id=z.dataset.room; const r=roomWithLayout(id); selectEditObject({kind:'zone',id,scope:'overview',label:r.label}); const p=percentIn(el('overview-content'),e.clientX,e.clientY); state.dragged={kind:e.target.dataset.handle==='resize'?'zoneResize':'zone',id,start:p,room:{...r},el:z}; bindDrag(); }
function metricDown(e){ if(!state.edit)return; e.preventDefault(); e.stopPropagation(); const b=e.currentTarget; const parent=b.dataset.kind==='overviewMetric'?el('overview-content'):el('room-content'); selectEditObject({kind:b.dataset.kind,id:b.dataset.room,scope:b.dataset.kind==='overviewMetric'?'overview':'room',label:room(b.dataset.room)?.label||b.dataset.room}); state.dragged={kind:b.dataset.kind,id:b.dataset.room,el:b,parent}; bindDrag(); }
function markerDown(e){ if(!state.edit)return; e.preventDefault(); e.stopPropagation(); const b=e.currentTarget; const d=devices().find(x=>x.entity_id===b.dataset.entity); selectEditObject({kind:'marker',id:b.dataset.entity,scope:b.dataset.scope,label:d?displayName(d):b.dataset.entity}); const parent=b.dataset.scope==='overview'?el('overview-content'):el('room-content'); state.dragged={kind:'marker',id:b.dataset.entity,scope:b.dataset.scope,el:b,parent}; bindDrag(); }
function bindDrag(){state.dragMoved=false; document.addEventListener('pointermove',dragMove); document.addEventListener('pointerup',dragUp,{once:true})}
function dragMove(e){ const d=state.dragged; if(!d)return; state.dragMoved=true; if(d.kind==='zone'||d.kind==='zoneResize'){ const p=percentIn(el('overview-content'),e.clientX,e.clientY); const dx=p.x-d.start.x, dy=p.y-d.start.y; let nr={...d.room}; if(d.kind==='zone'){nr.x=clamp(d.room.x+dx,nr.w/2,100-nr.w/2); nr.y=clamp(d.room.y+dy,nr.h/2,100-nr.h/2)} else {nr.w=clamp(d.room.w+dx,4,55); nr.h=clamp(d.room.h+dy,4,55)} state.layout.zones[d.id]={x:nr.x,y:nr.y,w:nr.w,h:nr.h}; Object.assign(d.el.style,{left:nr.x+'%',top:nr.y+'%',width:nr.w+'%',height:nr.h+'%'}); return; }
  const p=percentIn(d.parent,e.clientX,e.clientY);
  if(d.kind==='overviewMetric'){ d.el.style.left=p.x+'%'; d.el.style.top=p.y+'%'; state.layout.overviewMetrics[d.id]=p; }
  else if(d.kind==='roomMetric'){ const stored=roomImageToStoredPos(d.id, p); const renderPos=roomStoredToImagePos(d.id, stored); d.el.style.left=renderPos.x+'%'; d.el.style.top=renderPos.y+'%'; if(!state.layout.roomMetrics)state.layout.roomMetrics={}; state.layout.roomMetrics[d.id]=stored; }
  else if(d.kind==='marker'){ if(d.scope==='room'){ const stored=roomImageToStoredPos(state.selectedRoom, p); const renderPos=roomStoredToImagePos(state.selectedRoom, stored); d.el.style.left=renderPos.x+'%'; d.el.style.top=renderPos.y+'%'; setMarkerPosition(d.id,d.scope,stored); } else { d.el.style.left=p.x+'%'; d.el.style.top=p.y+'%'; setMarkerPosition(d.id,d.scope,p); } } }
function dragUp(){ if(state.dragMoved){ state.suppressClick=true; setLayoutDirty(true); renderEditSheet(); } state.dragged=null; setTimeout(()=>state.suppressClick=false,DRAG_SUPPRESS_MS) }


function pointerPoint(e){return {id:e.pointerId,x:e.clientX,y:e.clientY}}
function stageKindFromEl(stage){return stage && stage.id==='overview-stage'?'overview':'room'}
function isStageInteractiveTarget(target){return !!target.closest('.device-marker,.badge,.room-zone,.zone-handle,button,a,input,textarea,select,label,.device-card,.edit-action-sheet,.quick-overlay')}
function bindStageGestures(){
  [[el('overview-stage'),'overview'],[el('room-stage'),'room']].forEach(([stage,kind])=>{
    if(!stage || stage.dataset.gestureBound) return;
    stage.dataset.gestureBound='1';
    stage.addEventListener('pointerdown', e=>{
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

function bindDrops(){
  [[el('overview-stage'),'overview'],[el('room-stage'),'room']].forEach(([stage,scope])=>{
    stage.addEventListener('dragover',e=>{
      if(state.edit && e.dataTransfer.types.includes('text/entity-id')){e.preventDefault();e.dataTransfer.dropEffect='copy'}
    });
    stage.addEventListener('drop',e=>{
      if(!state.edit) return;
      const id=e.dataTransfer.getData('text/entity-id'); if(!id)return;
      const d=devices().find(x=>x.entity_id===id);
      if(scope==='room' && d && normalizedRoomId(d.room)!==normalizedRoomId(state.selectedRoom)){ e.preventDefault(); showToast('Перенос устройств между комнатами пока отключён'); return; }
      e.preventDefault();
      const parent=scope==='overview'?el('overview-content'):el('room-content');
      const p=percentIn(parent,e.clientX,e.clientY);
      setMarkerPosition(id,scope,scope==='room' ? roomImageToStoredPos(state.selectedRoom, p) : p);
      setLayoutDirty(true); render();
    });
  });
}

function hideKioskRooms(){
  const o=el('kiosk-room-overlay');
  if(o) o.classList.add('hidden');
  if(state.kioskRoomTimer){ clearTimeout(state.kioskRoomTimer); state.kioskRoomTimer=null; }
}
function renderKioskRoomOverlay(){
  const list=el('kiosk-room-list'); if(!list) return;
  list.innerHTML='';
  ROOMS.forEach(r=>{
    const b=document.createElement('button');
    b.type='button';
    b.className='kiosk-room-item'+(normalizedRoomId(state.selectedRoom)===normalizedRoomId(r.id)?' active':'');
    b.textContent=r.label;
    b.onclick=()=>{ selectRoom(r.id); hideKioskRooms(); };
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
  if(state.ui.autoHide && state.ui.mobileMode){
    state.ui.hideSidebar=true; state.ui.hideDevicePanel=true;
  }
  saveUiPrefs();
  render();
}
function setConnection(ok,text){el('connection-dot').className='dot '+(ok?'connected':'disconnected');el('connection-text').textContent=text}
async function apiJson(url,opt={}){const res=await fetch(url,{headers:{'Content-Type':'application/json'},...opt});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||data.message||res.status);return data}
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
async function loadConfig(){const cfg=await apiJson('api/config');state.config=cfg;const hu=el('ha-url'); if(hu) hu.value=cfg.haUrl||'';const dp=el('ha-dashboard-paths'); if(dp) dp.value=cfg.dashboardPathText||((cfg.dashboardPaths||[]).join('\n'));el('poll-interval').value=Math.round((cfg.pollIntervalMs||6000)/1000);return cfg}
async function saveConfig(){
  const status=el('settings-status');
  try{
    status.textContent='Сохраняю настройки add-on...';
    const payload={dashboardPathText:(el('ha-dashboard-paths')?.value||'').trim(),pollIntervalMs:Math.max(2000,Number(el('poll-interval').value||6)*1000)};
    const res=await apiJson('api/config',{method:'POST',body:JSON.stringify(payload)});
    state.config=res.config||state.config;
    status.textContent='Настройки сохранены. Проверяю подключение к Home Assistant...';
    await testConnection({keepModal:true});
  }catch(e){
    status.textContent='Ошибка сохранения настроек: '+e.message;
    setConnection(false,'Ошибка настроек');
  }
}
async function clearConfig(){
  const status=el('settings-status');
  try{
    status.textContent='Сбрасываю настройки add-on...';
    const res=await apiJson('api/config/clear',{method:'POST'});
    state.config=res.config||{configured:true,haUrl:'Home Assistant Supervisor API',hasToken:true,pollIntervalMs:6000,dashboardPaths:[]};
    const dp=el('ha-dashboard-paths'); if(dp) dp.value=''; el('poll-interval').value='6';
    status.textContent='Настройки сброшены.';
    await testConnection({keepModal:true});
    render();
  }catch(e){
    status.textContent='Ошибка сброса настроек: '+e.message;
  }
}
async function testConnection(options={}){try{await apiJson('api/ha/test');setConnection(true,'Подключено');if(!options.keepModal)el('settings-modal').classList.add('hidden');await loadStates();startPolling();el('settings-status').textContent=options.keepModal?'Add-on подключен к HA.':'Подключено.'}catch(e){setConnection(false,'Ошибка подключения');el('settings-status').textContent=e.message}}
async function loadStates(){try{const data=await apiJson('api/ha/states');state.states=Object.fromEntries(data.states.map(s=>[s.entity_id,s]));applySourceConfig();render();setConnection(true,'Подключено')}catch(e){setConnection(false,'Ошибка обновления');console.error(e)}}
function startPolling(){if(state.pollTimer)clearInterval(state.pollTimer);state.pollTimer=setInterval(loadStates,state.config?.pollIntervalMs||6000)}

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
function renderSourceSettings(){const box=el('source-settings'); if(!box||!window.LOVELACE_SOURCE)return; const cfg=state.sourceConfig||defaultSourceConfig(); box.innerHTML=`<p class="muted">Активно: <b>${devices().length}</b> из <b>${allDevices().length}</b></p><label class="source-card source-card-inline"><input type="checkbox" id="include-unknown-api" ${cfg.includeUnknownFromApi?'checked':''}> Добавлять новые сущности из Home Assistant API</label>`+(LOVELACE_SOURCE.views||[]).map(view=>`<details class="source-view" open><summary>${esc(view.title)} · ${(view.cards||[]).length} карточек</summary><div class="source-cards">${(view.cards||[]).map(card=>`<label class="source-card"><input type="checkbox" data-source-key="${esc(card.sourceKey)}" ${isSourceKeyEnabled(card.sourceKey)?'checked':''}> ${esc(card.title)} (${(card.devices||[]).length})</label>`).join('')}</div></details>`).join(''); const unknown=el('include-unknown-api'); if(unknown) unknown.onchange=()=>{ state.sourceConfig={...cfg,includeUnknownFromApi:unknown.checked}; applySourceConfig(); renderSourceSettings(); render(); }; qsa('[data-source-key]',box).forEach(cb=>cb.onchange=()=>{setSourceKeyEnabled(cb.dataset.sourceKey,cb.checked);applySourceConfig();renderSourceSettings();render()})}


async function readLovelaceRaw(){
  const status=el('settings-status');
  try{
    status.textContent='Читаю RAW панели из Home Assistant и пересобираю устройства...';
    const dashboardPathText=(el('ha-dashboard-paths')?.value||'').trim();
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
function infoRow(k,v){ return `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`; }
function renderInfoModal(){
  const d=state.diagnostics; const box=el('info-content'); if(!box||!d) return;
  qsa('[data-info-tab]').forEach(b=>b.classList.toggle('active', b.dataset.infoTab===state.infoTab));
  if(state.infoTab==='summary'){
    box.innerHTML=`<table class="info-table">${[
      ['Версия add-on',d.version],['HA API',d.ok?'OK':'Ошибка'],['Ошибка HA',d.haError||'—'],['Режим',d.mode],['DATA_DIR',d.dataDir],['HA API base',d.haApiBase],['Supervisor token',d.hasSupervisorToken?'есть':'нет'],['layout.json в /data',d.storage?.layoutExists?'есть':'нет'],['ui_state.json в /data',d.storage?.uiStateExists?'есть':'нет'],['devices.js в /data',d.storage?.devicesInData?'есть':'fallback'],['lovelace-source.js в /data',d.storage?.lovelaceInData?'есть':'fallback'],['Устройств из панели',d.counts?.devices],['Entity из HA',d.counts?.haStates],['Не найдены в HA',d.counts?.missingInHa],['Дубли entity_id',d.counts?.duplicates],['Без комнаты',d.counts?.noRoom],['Без координат',d.counts?.noCoordinates],['Backup layout',d.counts?.backups],['Сформировано',d.generatedAt]
    ].map(x=>infoRow(x[0],x[1])).join('')}</table>`;
  } else if(state.infoTab==='entities'){
    box.innerHTML=`<h3>Проблемы entity_id</h3><p class="muted">Показаны первые 200 записей каждого типа.</p>`+
      `<h4>Не найдены в HA (${d.counts?.missingInHa||0})</h4><div class="info-list">${(d.missingInHa||[]).map(x=>`<code>${esc(x.entity_id)}</code> <span>${esc(x.name||'')}</span>`).join('<br>')||'—'}</div>`+
      `<h4>Дубли (${d.counts?.duplicates||0})</h4><div class="info-list">${(d.duplicates||[]).map(x=>`<code>${esc(x.entity_id)}</code> × ${x.count}`).join('<br>')||'—'}</div>`+
      `<h4>Без координат (${d.counts?.noCoordinates||0})</h4><div class="info-list">${(d.noCoordinates||[]).map(x=>`<code>${esc(x)}</code>`).join('<br>')||'—'}</div>`;
  } else if(state.infoTab==='backups'){
    box.innerHTML=`<h3>Резервные копии layout</h3><p class="muted">Перед каждым сохранением создаётся backup. Хранятся последние 20 копий.</p><div class="backup-list">${(d.backups||[]).map(b=>`<div class="backup-row"><div><b>${esc(b.name)}</b><br><span>${esc(new Date(b.mtime).toLocaleString())} · ${formatBytes(b.size)}</span></div><div><button data-restore-backup="${esc(b.name)}">Восстановить</button><button data-delete-backup="${esc(b.name)}">Удалить</button></div></div>`).join('')||'Backup пока нет'}</div>`;
    qsa('[data-restore-backup]',box).forEach(btn=>btn.onclick=async()=>{ if(!confirm('Восстановить '+btn.dataset.restoreBackup+'? Текущий layout будет сохранён в backup.')) return; const r=await apiJson('api/backups/restore',{method:'POST',body:JSON.stringify({name:btn.dataset.restoreBackup})}); state.layout={...state.layout,...r.layout}; await loadDiagnostics(); render(); showToast('Layout восстановлен'); });
    qsa('[data-delete-backup]',box).forEach(btn=>btn.onclick=async()=>{ await apiJson('api/backups/delete',{method:'POST',body:JSON.stringify({name:btn.dataset.deleteBackup})}); await loadDiagnostics(); });
  } else if(state.infoTab==='allowlist'){
    box.innerHTML=`<h3>Разрешённые команды Home Assistant</h3><p class="muted">Сервер блокирует service calls вне этого списка.</p><div class="info-list">${Object.entries(d.allowedServices||{}).map(([dom,arr])=>`<b>${esc(dom)}</b>: ${arr.map(esc).join(', ')}`).join('<br>')}</div>`;
  }
}

function bindGlobal(){
  loadUiPrefs();
  document.addEventListener('contextmenu', e=>{ if(e.target.closest('.plan-stage,.room-image-wrap,.device-marker,.badge,.room-zone')) e.preventDefault(); });
  el('btn-settings').onclick=()=>el('settings-modal').classList.remove('hidden');
  el('btn-close-settings').onclick=()=>el('settings-modal').classList.add('hidden');
  el('btn-close-device').onclick=closeDeviceModal;
  el('device-modal').addEventListener('click',e=>{if(e.target.id==='device-modal')closeDeviceModal()});
  el('btn-close-info').onclick=()=>el('info-modal').classList.add('hidden');
  el('info-modal').addEventListener('click',e=>{if(e.target.id==='info-modal')el('info-modal').classList.add('hidden')});
  el('btn-refresh-info').onclick=loadDiagnostics;
  qsa('[data-info-tab]').forEach(b=>b.onclick=()=>{state.infoTab=b.dataset.infoTab; renderInfoModal();});
  el('btn-save-config').onclick=()=>saveConfig(); el('btn-clear-config').onclick=()=>clearConfig(); el('btn-info-settings').onclick=()=>openInfoModal('summary'); el('btn-refresh').onclick=loadStates; el('btn-overview').onclick=()=>selectRoom('overview');
  el('toggle-zones').onchange=render; el('toggle-devices').onchange=render; el('toggle-sensors').onchange=render;
  const editBtn=el('btn-edit');
  const startEditHold=()=>{ if(state.edit) return; editBtn.classList.add('holding'); showToast('Удерживайте 2 секунды для входа в редактор'); state.editHoldTimer=setTimeout(()=>{ editBtn.classList.remove('holding'); state.editHoldTimer=null; enterEditMode(); },2000); };
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
  el('overview-image').onload=()=>fitStage('overview'); bindStageGestures(); window.addEventListener('resize',()=>{fitStage('overview');fitStage('room')}); window.addEventListener('beforeunload',e=>{ if(state.edit && state.layoutDirty){ e.preventDefault(); e.returnValue=''; } }); bindDrops();

  el('btn-hide-sidebar').onclick=()=>setPanelHidden('hideSidebar', !state.ui.hideSidebar);
  el('btn-show-sidebar').onclick=()=>setPanelHidden('hideSidebar', false);
  el('btn-toggle-devices-panel').onclick=()=>setPanelHidden('hideDevicePanel', !state.ui.hideDevicePanel);
  el('btn-show-device-panel').onclick=()=>setPanelHidden('hideDevicePanel', false);
  el('btn-toggle-toolbar').onclick=()=>setPanelHidden('hideToolbar', !state.ui.hideToolbar);
  el('btn-show-toolbar').onclick=()=>setPanelHidden('hideToolbar', false);
  el('btn-mobile-sidebar').onclick=()=>setPanelHidden('hideSidebar', !state.ui.hideSidebar);
  el('btn-mobile-devices').onclick=()=>setPanelHidden('hideDevicePanel', !state.ui.hideDevicePanel);
  const closeMobileDevicePanel=el('btn-close-mobile-device-panel'); if(closeMobileDevicePanel) closeMobileDevicePanel.onclick=()=>setPanelHidden('hideDevicePanel', true);
  const toolbarKiosk=el('btn-toolbar-kiosk'); if(toolbarKiosk) toolbarKiosk.onclick=()=>{ state.ui.kioskMode=true; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; state.ui.hideToolbar=true; saveUiPrefs(); render(); showToast('Режим киоска включён'); };
  el('btn-mobile-settings').onclick=()=>el('settings-modal').classList.remove('hidden');
  const exitKiosk=el('btn-exit-kiosk');
  if(exitKiosk) exitKiosk.onclick=()=>{ hideKioskRooms(); state.ui.kioskMode=false; state.ui.hideToolbar=false; state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; saveUiPrefs(); render(); showToast('Режим киоска выключен'); };
  const kioskRooms=el('btn-kiosk-rooms'); if(kioskRooms) kioskRooms.onclick=openKioskRooms;
  const closeKioskRooms=el('btn-close-kiosk-rooms'); if(closeKioskRooms) closeKioskRooms.onclick=hideKioskRooms;
  const kioskOverview=el('btn-kiosk-overview'); if(kioskOverview) kioskOverview.onclick=()=>{ selectRoom('overview'); hideKioskRooms(); };
  el('pref-mobile-mode').onchange=e=>{state.ui.mobileMode=e.target.checked; saveUiPrefs();};
  el('pref-auto-hide').onchange=e=>{state.ui.autoHide=e.target.checked; saveUiPrefs();};
  el('pref-compact-mode').onchange=e=>{state.ui.compact=e.target.checked; saveUiPrefs();};
  el('pref-dark-theme').onchange=e=>{state.ui.darkTheme=e.target.checked; saveUiPrefs();};
  el('pref-kiosk-widget').onchange=e=>{state.ui.kioskWidget=e.target.checked; saveUiPrefs(); renderKioskWidget();};
  el('pref-kiosk-mode').onchange=e=>{state.ui.kioskMode=e.target.checked; if(e.target.checked){ state.ui.hideSidebar=true; state.ui.hideDevicePanel=true; state.ui.hideToolbar=true; } saveUiPrefs(); render();};
  el('pref-weather-entity').onchange=e=>{state.ui.weatherEntity=e.target.value.trim(); saveUiPrefs(); renderKioskWidget();};
  const showAllPref=el('pref-show-all-devices-room'); if(showAllPref) showAllPref.onchange=e=>{state.ui.showAllDevicesInRoom=e.target.checked; saveUiPrefs(); renderDevices();};
  el('pref-halo-scale').oninput=e=>{state.ui.haloScale=Number(e.target.value)/100; const hv=el('pref-halo-scale-value'); if(hv) hv.textContent=e.target.value+'%'; saveUiPrefs(); render();};
  const hwScale=el('pref-hardware-scale'); if(hwScale) hwScale.oninput=e=>{state.ui.hardwareScale=Number(e.target.value)/100; const hv=el('pref-hardware-scale-value'); if(hv) hv.textContent=e.target.value+'%'; saveUiPrefs(); applyStageTransform('overview'); applyStageTransform('room'); updateZoomControls();};
  const markerScale=el('pref-marker-scale'); if(markerScale) markerScale.oninput=e=>{state.ui.markerScale=Number(e.target.value)/100; const v=el('pref-marker-scale-value'); if(v) v.textContent=e.target.value+'%'; saveUiPrefs();};
  const sensorScale=el('pref-sensor-scale'); if(sensorScale) sensorScale.oninput=e=>{state.ui.sensorScale=Number(e.target.value)/100; const v=el('pref-sensor-scale-value'); if(v) v.textContent=e.target.value+'%'; saveUiPrefs();};
  const markerOpacity=el('pref-marker-opacity'); if(markerOpacity) markerOpacity.oninput=e=>{state.ui.markerOpacity=Number(e.target.value)/100; const v=el('pref-marker-opacity-value'); if(v) v.textContent=e.target.value+'%'; saveUiPrefs();};
  const sensorOpacity=el('pref-sensor-opacity'); if(sensorOpacity) sensorOpacity.oninput=e=>{state.ui.sensorOpacity=Number(e.target.value)/100; const v=el('pref-sensor-opacity-value'); if(v) v.textContent=e.target.value+'%'; saveUiPrefs();};
  const zb=el('btn-zoom-out'); if(zb) zb.onclick=()=>zoomViewport(activeStageKind(), .86);
  const zi=el('btn-zoom-in'); if(zi) zi.onclick=()=>zoomViewport(activeStageKind(), 1.16);
  const zf=el('btn-zoom-fit'); if(zf) zf.onclick=()=>fitViewport(activeStageKind());
  qsa('[data-ha-back]').forEach(a=>a.addEventListener('click',e=>{ if(state.selectedRoom!=='overview'){ e.preventDefault(); selectRoom('overview'); } }));
  el('btn-fullscreen').onclick=async()=>{try{ if(!document.fullscreenElement) await document.documentElement.requestFullscreen(); else await document.exitFullscreen(); }catch(e){showToast('Полный экран недоступен: '+e.message)}};
  el('btn-quick-overlay').onclick=()=>{state.quickOverlayOpen=true; el('quick-overlay').classList.remove('hidden'); renderQuickActions();};
  el('btn-close-quick-overlay').onclick=()=>{state.quickOverlayOpen=false; el('quick-overlay').classList.add('hidden');};
}

(async function init(){await loadLayout(); await loadSourceConfig(); await loadPersistedUiState(); bindGlobal(); startClock(); renderSourceSettings(); render(); try{const cfg=await loadConfig(); if(cfg.configured)await testConnection(); else el('settings-modal').classList.remove('hidden')}catch(e){console.error(e);el('settings-modal').classList.remove('hidden')}})();
