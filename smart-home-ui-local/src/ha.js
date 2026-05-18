'use strict';
require('./local-config').applyLocalConfig();
const WebSocket = require('ws');

const HA_API_BASE = (process.env.HA_API_BASE || 'http://supervisor/core/api').replace(/\/$/, '');
const HA_WS_URL   = process.env.HA_WS_URL   || HA_API_BASE.replace(/^http/i, 'ws').replace(/\/api$/, '/api/websocket');
const HA_TOKEN    = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';

/* ── HTTP helper ─────────────────────────────────────────────────── */
async function haFetch(endpoint, init = {}) {
  if (!HA_TOKEN) throw new Error(process.env.ALLHA_MODE === 'local-dev' ? 'HA_TOKEN недоступен. Проверь config/local-config.json: haUrl и haToken' : 'SUPERVISOR_TOKEN недоступен. Проверь config.yaml: homeassistant_api: true');
  const timeoutMs = Number(init.timeoutMs || process.env.ALLHA_HA_FETCH_TIMEOUT_MS || 10_000);
  const hasExternalSignal = !!init.signal;
  const controller = hasExternalSignal ? null : new AbortController();
  const timer = !hasExternalSignal && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new Error(`HA API timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;
  if(timer && timer.unref) timer.unref();
  const { timeoutMs: _timeoutMs, ...fetchInit } = init;
  let res;
  try {
    res = await fetch(HA_API_BASE + endpoint, {
      ...fetchInit,
      signal: hasExternalSignal ? init.signal : controller.signal,
      headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
  } catch (e) {
    if (e?.name === 'AbortError' || String(e?.message || '').includes('timeout')) {
      throw new Error(`HA API timeout: ${endpoint}`);
    }
    throw e;
  } finally {
    if(timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HA API ${res.status}${text ? ': ' + text.slice(0, 300) : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* ── Persistent WebSocket command helper ────────────────────────────── */
let _wsMsgId = 10;
const _pendingCommands = new Map(); // id → { resolve, reject, timer, type }

function clearPendingWsCommands(reason = 'HA WebSocket disconnected') {
  for (const [id, pending] of _pendingCommands.entries()) {
    _pendingCommands.delete(id);
    try { clearTimeout(pending.timer); } catch (e) {}
    try { pending.reject(new Error(reason)); } catch (e) {}
  }
}

function handlePendingWsResult(msg) {
  if (!msg || msg.type !== 'result' || !_pendingCommands.has(msg.id)) return false;
  const pending = _pendingCommands.get(msg.id);
  _pendingCommands.delete(msg.id);
  try { clearTimeout(pending.timer); } catch (e) {}
  if (msg.success === false) {
    pending.reject(new Error(msg.error?.message || JSON.stringify(msg.error || msg)));
  } else {
    pending.resolve(msg.result ?? msg);
  }
  return true;
}

function haWsCommand(type, payload = {}, options = {}) {
  if (!HA_TOKEN) return Promise.reject(new Error(process.env.ALLHA_MODE === 'local-dev' ? 'HA_TOKEN недоступен. Проверь config/local-config.json' : 'SUPERVISOR_TOKEN недоступен'));
  if (!_haWs || _haWs.readyState !== WebSocket.OPEN || !haStatus.connected) {
    return Promise.reject(new Error('HA WebSocket не подключён'));
  }
  return new Promise((resolve, reject) => {
    const id = ++_wsMsgId;
    const timeoutMs = Number(options.timeoutMs || process.env.ALLHA_HA_WS_COMMAND_TIMEOUT_MS || 15_000);
    const timer = setTimeout(() => {
      _pendingCommands.delete(id);
      reject(new Error(`Timeout команды WebSocket Home Assistant: ${type}`));
    }, timeoutMs);
    if (timer && timer.unref) timer.unref();
    _pendingCommands.set(id, { resolve, reject, timer, type });
    try {
      _haWs.send(JSON.stringify({ id, type, ...payload }));
    } catch (e) {
      _pendingCommands.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function haCallService(domain, service, data = {}, options = {}) {
  const serviceData = { ...(data || {}) };
  const target = {};
  for (const key of ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id']) {
    if (serviceData[key] !== undefined && serviceData[key] !== null && serviceData[key] !== '') {
      target[key] = serviceData[key];
      delete serviceData[key];
    }
  }
  const payload = { domain, service };
  if (Object.keys(target).length) payload.target = target;
  if (Object.keys(serviceData).length) payload.service_data = serviceData;
  try {
    return await haWsCommand('call_service', payload, { timeoutMs: Number(options.timeoutMs || process.env.ALLHA_HA_SERVICE_TIMEOUT_MS || 10_000) });
  } catch (e) {
    if (String(e?.message || '').includes('HA WebSocket не подключён')) {
      return haFetch(`/services/${domain}/${service}`, { method:'POST', body: JSON.stringify(data || {}), timeoutMs: Number(options.timeoutMs || process.env.ALLHA_HA_SERVICE_TIMEOUT_MS || 10_000) });
    }
    throw e;
  }
}

/* ── Live state cache ────────────────────────────────────────────── */
const statesCache = new Map(); // entity_id → state object

/* ── SSE broadcast ───────────────────────────────────────────────── */
const sseClients = new Set();
const sseRuntime = {
  connectedTotal:0,
  disconnectedTotal:0,
  rejectedTotal:0,
  heartbeatTotal:0,
  eventMinuteStartedAt:Date.now(),
  stateChangedMinute:0,
  stateRemovedMinute:0,
  statesBatchMinute:0,
  sseEventMinute:0,
  stateChangedBroadcastTotal:0,
  stateRemovedBroadcastTotal:0,
  statesBatchBroadcastTotal:0,
  statesBatchChangedTotal:0,
  statesBatchRemovedTotal:0,
  initialStatesSentTotal:0,
  batchDelayMs:0,
  batchPendingChanged:0,
  batchPendingRemoved:0,
  lastBatchSize:0,
  lastBatchAt:null,
  lastEventAt:null,
  lastHeartbeatAt:null
};
function bumpSseMinute(type){
  const now=Date.now();
  if(!sseRuntime.eventMinuteStartedAt || now-sseRuntime.eventMinuteStartedAt>60000){
    sseRuntime.eventMinuteStartedAt=now;
    sseRuntime.stateChangedMinute=0;
    sseRuntime.stateRemovedMinute=0;
    sseRuntime.sseEventMinute=0;
  }
  sseRuntime.sseEventMinute++;
  if(type==='state_changed') sseRuntime.stateChangedMinute++;
  if(type==='state_removed') sseRuntime.stateRemovedMinute++;
  if(type==='states_batch') sseRuntime.statesBatchMinute++;
}
function noteSseClientConnected(){ sseRuntime.connectedTotal++; }
function noteSseClientDisconnected(){ sseRuntime.disconnectedTotal++; }
function noteSseClientRejected(){ sseRuntime.rejectedTotal++; }
function noteSseHeartbeat(){ sseRuntime.heartbeatTotal++; sseRuntime.lastHeartbeatAt=new Date().toISOString(); }

function broadcastSseEvent(type, data) {
  if (!sseClients.size) return;
  bumpSseMinute(type);
  if(type==='state_changed') sseRuntime.stateChangedBroadcastTotal++;
  if(type==='state_removed') sseRuntime.stateRemovedBroadcastTotal++;
  if(type==='states_batch') sseRuntime.statesBatchBroadcastTotal++;
  if(type==='initial_states') sseRuntime.initialStatesSentTotal++;
  sseRuntime.lastEventAt=new Date().toISOString();
  haStatus.sseSentTotal += sseClients.size;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch (e) { sseClients.delete(res); noteSseClientDisconnected(); }
  }
}

function normalizeSseBatchMs(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return 1000;
  return Math.max(0, Math.min(60000, Math.round(n)));
}
let _sseBatchDelayMs = normalizeSseBatchMs(process.env.ALLHA_SSE_BATCH_MS || 1000);
const _batchChanged = new Map();
const _batchRemoved = new Set();
let _batchTimer = null;
sseRuntime.batchDelayMs = _sseBatchDelayMs;
function setSseBatchMs(value){
  _sseBatchDelayMs = normalizeSseBatchMs(value);
  sseRuntime.batchDelayMs = _sseBatchDelayMs;
  if(_sseBatchDelayMs === 0 && _batchTimer){
    clearTimeout(_batchTimer);
    _flushStateBatch();
  }
  return _sseBatchDelayMs;
}
function _flushStateBatch(){
  if(_batchTimer){ clearTimeout(_batchTimer); _batchTimer = null; }
  if(!_batchChanged.size && !_batchRemoved.size){
    sseRuntime.batchPendingChanged = 0;
    sseRuntime.batchPendingRemoved = 0;
    return;
  }
  const changed = [..._batchChanged.values()];
  const removed = [..._batchRemoved];
  _batchChanged.clear();
  _batchRemoved.clear();
  sseRuntime.batchPendingChanged = 0;
  sseRuntime.batchPendingRemoved = 0;
  sseRuntime.statesBatchChangedTotal += changed.length;
  sseRuntime.statesBatchRemovedTotal += removed.length;
  sseRuntime.lastBatchSize = changed.length + removed.length;
  sseRuntime.lastBatchAt = new Date().toISOString();
  broadcastSseEvent('states_batch', { changed, removed });
}
function enqueueStateBroadcast(newState, removedId){
  if(_sseBatchDelayMs <= 0){
    if(newState) broadcastSseEvent('state_changed', newState);
    if(removedId) broadcastSseEvent('state_removed', { entity_id: removedId });
    return;
  }
  if(newState && newState.entity_id){
    _batchChanged.set(newState.entity_id, newState);
    _batchRemoved.delete(newState.entity_id);
  }
  if(removedId){
    _batchRemoved.add(removedId);
    _batchChanged.delete(removedId);
  }
  sseRuntime.batchPendingChanged = _batchChanged.size;
  sseRuntime.batchPendingRemoved = _batchRemoved.size;
  if(!_batchTimer){
    _batchTimer = setTimeout(_flushStateBatch, _sseBatchDelayMs);
    _batchTimer.unref?.();
  }
}

/* ── Persistent WS subscription to HA ───────────────────────────── */
let _wsRetryTimer = null;
let _wsRetryDelay = 5000; // начинаем с 5 с, растём до 60 с
let _haWs = null;
const haStatus = { connected:false, lastConnectedAt:null, lastDisconnectedAt:null, lastError:'', reconnectDelayMs:0, stateChangedTotal:0, stateRemovedTotal:0, sseSentTotal:0 };

function startHaWsSubscription() {
  if (!HA_TOKEN) return; // no token — skip (dev/direct mode)
  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }

  const ws = new WebSocket(HA_WS_URL);
  let statesReqId = null;
  let subId = null;

  ws.on('open', () => { _wsRetryDelay = 5000; haStatus.lastError=''; haStatus.reconnectDelayMs=0; console.log('[HA WS] subscription socket opened'); });

  ws.on('message', buf => {
    let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }

    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      return;
    }
    if (msg.type === 'auth_invalid') {
      console.error('[HA WS] auth failed:', msg.message);
      ws.close();
      return;
    }
    if (msg.type === 'auth_ok') {
      _haWs = ws;
      haStatus.connected=true;
      haStatus.lastConnectedAt=new Date().toISOString();
      haStatus.lastError='';
      // 1. get initial states
      statesReqId = ++_wsMsgId;
      ws.send(JSON.stringify({ id: statesReqId, type: 'get_states' }));
      // 2. subscribe to state_changed
      subId = ++_wsMsgId;
      ws.send(JSON.stringify({ id: subId, type: 'subscribe_events', event_type: 'state_changed' }));
      console.log('[HA WS] subscription authenticated');
      return;
    }

    if (handlePendingWsResult(msg)) return;

    // initial states result
    if (msg.id === statesReqId && msg.type === 'result' && msg.success && Array.isArray(msg.result)) {
      msg.result.forEach(s => statesCache.set(s.entity_id, s));
      broadcastSseEvent('initial_states', [...statesCache.values()]);
      console.log(`[HA WS] states cache loaded: ${statesCache.size} entities`);
      return;
    }

    // live state_changed / state_removed events
    if (msg.type === 'event') {
      const et = msg.event?.event_type;
      if (et === 'state_changed') {
        const newState = msg.event.data?.new_state;
        const oldState = msg.event.data?.old_state;
        const eid = newState?.entity_id || oldState?.entity_id;
        if (eid) {
          if (newState) {
            statesCache.set(eid, newState);
            haStatus.stateChangedTotal++;
            enqueueStateBroadcast(newState, null);
          } else {
            // entity удалена
            statesCache.delete(eid);
            haStatus.stateRemovedTotal++;
            enqueueStateBroadcast(null, eid);
          }
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    if (_haWs === ws) _haWs = null;
    clearPendingWsCommands('HA WebSocket disconnected');
    haStatus.connected=false;
    haStatus.lastDisconnectedAt=new Date().toISOString();
    // Exponential backoff: 5 → 10 → 20 → 40 → 60 с (max)
    const delay = _wsRetryDelay;
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, 60_000);
    haStatus.reconnectDelayMs=delay;
    console.log(`[HA WS] subscription disconnected — retry in ${delay / 1000}s`);
    _wsRetryTimer = setTimeout(startHaWsSubscription, delay);
  });
  ws.on('error', err => {
    haStatus.lastError=err.message || String(err);
    console.error('[HA WS] error:', err.message);
    // close triggers reconnect
  });
}

function getHaStatus(){
  return { ...haStatus, statesCached: statesCache.size, sseClients: sseClients.size, pendingWsCommands: _pendingCommands.size, sseRuntime:{...sseRuntime} };
}
function stopHaWsSubscription(){
  try{ _flushStateBatch(); }catch(e){}
  if(_wsRetryTimer){ clearTimeout(_wsRetryTimer); _wsRetryTimer=null; }
  clearPendingWsCommands('HA WebSocket stopped');
  try{ if(_haWs) _haWs.close(); }catch(e){}
  _haWs=null;
  haStatus.connected=false;
}

module.exports = { HA_API_BASE, HA_WS_URL, HA_TOKEN, haFetch, haWsCommand, haCallService, statesCache, sseClients, broadcastSseEvent, setSseBatchMs, noteSseClientConnected, noteSseClientDisconnected, noteSseClientRejected, noteSseHeartbeat, startHaWsSubscription, getHaStatus, stopHaWsSubscription };
