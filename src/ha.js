'use strict';
const WebSocket = require('ws');

const HA_API_BASE = (process.env.HA_API_BASE || 'http://supervisor/core/api').replace(/\/$/, '');
const HA_WS_URL   = process.env.HA_WS_URL   || HA_API_BASE.replace(/^http/i, 'ws').replace(/\/api$/, '/websocket');
const HA_TOKEN    = process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '';

/* ── HTTP helper ─────────────────────────────────────────────────── */
async function haFetch(endpoint, init = {}) {
  if (!HA_TOKEN) throw new Error('SUPERVISOR_TOKEN недоступен. Проверь config.yaml: homeassistant_api: true');
  const res = await fetch(HA_API_BASE + endpoint, {
    ...init,
    headers: { 'Authorization': `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HA API ${res.status}${text ? ': ' + text.slice(0, 300) : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

/* ── One-shot WebSocket command ──────────────────────────────────── */
function haWsCommand(type, payload = {}) {
  if (!HA_TOKEN) return Promise.reject(new Error('SUPERVISOR_TOKEN недоступен'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HA_WS_URL);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('Timeout WebSocket Home Assistant')); }, 15000);
    let authed = false;
    const done = (err, data) => { clearTimeout(timer); try { ws.close(); } catch (e) {} err ? reject(err) : resolve(data); };
    ws.on('error', err => done(err));
    ws.on('message', buf => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      if (msg.type === 'auth_required') { ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN })); return; }
      if (msg.type === 'auth_invalid') return done(new Error(msg.message || 'HA auth invalid'));
      if (msg.type === 'auth_ok' && !authed) { authed = true; ws.send(JSON.stringify({ id: 1, type, ...payload })); return; }
      if (msg.id === 1) {
        if (msg.success === false) return done(new Error(msg.error?.message || JSON.stringify(msg.error || msg)));
        return done(null, msg.result ?? msg);
      }
    });
  });
}

/* ── Live state cache ────────────────────────────────────────────── */
const statesCache = new Map(); // entity_id → state object

/* ── SSE broadcast ───────────────────────────────────────────────── */
const sseClients = new Set();

function broadcastSseEvent(type, data) {
  if (!sseClients.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch (e) { sseClients.delete(res); }
  }
}

/* ── Persistent WS subscription to HA ───────────────────────────── */
let _wsRetryTimer = null;
let _wsRetryDelay = 5000; // начинаем с 5 с, растём до 60 с

function startHaWsSubscription() {
  if (!HA_TOKEN) return; // no token — skip (dev/direct mode)
  if (_wsRetryTimer) { clearTimeout(_wsRetryTimer); _wsRetryTimer = null; }

  const ws = new WebSocket(HA_WS_URL);
  let msgId = 1;
  let statesReqId = null;
  let subId = null;

  ws.on('open', () => { _wsRetryDelay = 5000; console.log('[HA WS] subscription connected'); });

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
      // 1. get initial states
      statesReqId = ++msgId;
      ws.send(JSON.stringify({ id: statesReqId, type: 'get_states' }));
      // 2. subscribe to state_changed
      subId = ++msgId;
      ws.send(JSON.stringify({ id: subId, type: 'subscribe_events', event_type: 'state_changed' }));
      return;
    }

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
            broadcastSseEvent('state_changed', newState);
          } else {
            // entity удалена
            statesCache.delete(eid);
            broadcastSseEvent('state_removed', { entity_id: eid });
          }
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    // Exponential backoff: 5 → 10 → 20 → 40 → 60 с (max)
    const delay = _wsRetryDelay;
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, 60_000);
    console.log(`[HA WS] subscription disconnected — retry in ${delay / 1000}s`);
    _wsRetryTimer = setTimeout(startHaWsSubscription, delay);
  });
  ws.on('error', err => {
    console.error('[HA WS] error:', err.message);
    // close triggers reconnect
  });
}

module.exports = { HA_API_BASE, HA_WS_URL, HA_TOKEN, haFetch, haWsCommand, statesCache, sseClients, broadcastSseEvent, startHaWsSubscription };
