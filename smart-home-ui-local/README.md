# ALLHA-2D — 2D Floor Plan Control Panel for Home Assistant

**Version 3.6.0.6**

Interactive 2D floor-plan dashboard for Home Assistant. Runs as an HA add-on with ingress. Also accessible directly from any browser on the local network without Home Assistant open.

---

## Features

### Real-time & Performance (new in 3.6.0.6)
- **WebSocket subscription** to HA `state_changed` — server always has fresh state, no poll lag
- **SSE push to browser** — state updates arrive in milliseconds, not on next poll tick
- **Selective re-render** — only the changed device marker updates in the DOM; full re-render only when entity list changes
- **Exponential backoff** reconnect: 5 s → 10 s → 20 s → 40 s → 60 s max
- **state_removed** handling — deleted entities disappear from UI immediately
- **Fallback polling** every 60 s when SSE is active (safety net); normal interval when SSE is down

### Dashboard & UI
- 2D floor plan with custom floor-plan images per room
- Swipe between rooms on mobile
- 4 themes: Dark, Light, Midnight (AMOLED), Sepia
- Kiosk mode with auto-lock for wall tablets
- PWA — install as app on iOS / Android / Desktop, offline UI shell

### Devices
- All HA domains: lights, switches, covers, climate, media players, sensors, locks, cameras, valves, etc.
- Halo glow indicators for brightness / on-off state
- Camera streams — tap icon → MJPEG live stream window
- Quick overlay for fast actions

### Layout Editor
- Drag & place markers on overview and room plans
- Freehand zone drawing on SVG overlay
- Undo / Redo (Ctrl+Z / Ctrl+Y) with full snapshot stack
- Export / Import layout JSON
- Automatic backup before every destructive action

### Security
- Security headers: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy
- Rate limiting: 30 req/min service calls, 60 req/min camera proxy
- Panel modes: admin / control / viewer with optional PIN
- Dangerous service confirmation (lock, valve, script, automation)
- HA token never sent to browser — all HA API calls proxied server-side
- Internal server URLs removed from diagnostics output

---

## Architecture

```
Browser ──SSE──▶ server.js (Express)
                      │
                 src/ha.js
                      │
            ────WS────▶ Home Assistant WebSocket API
            ────HTTP───▶ Home Assistant REST API
```

**Data flow:**
1. `startHaWsSubscription()` connects to HA WS on server start
2. Subscribes to `state_changed`; populates `statesCache` Map
3. Browser opens `/api/ha/events` (SSE); receives full cache as `initial_states`
4. Each HA state change → server broadcasts to all SSE clients
5. Browser: `patchMarkerForEntity()` updates the single marker, skips full re-render
6. 60 s fallback poll syncs anything missed

**Modules:**
- `server.js` — Express app, all routes and business logic
- `src/ha.js` — HA HTTP + WebSocket + SSE broadcast
- `public/` — static frontend (app.js, style.css, index.html, sw.js, manifest.json)

---

## Installation

### As HA Add-on
1. Settings → Add-ons → Add-on Store → Repositories → add repo URL
2. Install ALLHA-2D, enable Start on boot + Watchdog, Start

### Lovelace Card (embed in HA dashboard)
1. Copy `allha-card.js` to `/config/www/allha-card.js`
2. Settings → Dashboards → Resources → Add `/local/allha-card.js` (JS module)
3. Add custom card: `type: custom:allha-card`

Works locally and via Nabu Casa cloud — card auto-gets ingress session token.

### Direct Browser Access (local network, no HA needed)
```
http://<HA_IP>:8099/
```

---

## Development

```bash
npm install
PORT=8080 DATA_DIR=./data node server.js
# open http://localhost:8080
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md)
