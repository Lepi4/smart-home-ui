# ALLHA-2D v5.1.0-beta.13 — MDI icon picker for markers

## Added

- **MDI icon picker** — long-press a device marker to open the device modal, then tap "Сменить иконку (MDI)" to open the icon picker. Full Material Design Icons library (7 400+ icons) with live search: type 2+ characters and matching icons appear instantly as a grid with SVG previews. Results are sorted: exact-prefix matches first, then partial matches, up to 300 shown.
- Custom icon is saved per entity to the server (SQLite `project_documents`). Icon persists across page reloads and all connected clients.
- "Сбросить (авто)" button restores the default domain icon.
- Custom MDI icon overrides the built-in SVG icon in floor plan markers, quick actions, and device cards.
- `public/mdi-icons.json` — pre-generated icon library (~2.7 MB, loaded lazily on first icon picker open).
- `scripts/gen-mdi.js` — regeneration script (`npm run gen:icons`) using `@mdi/svg` devDependency.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.13`.

# ALLHA-2D v5.1.0-beta.12 — window/leak sensor device_class detection

## Fixed

- Window and door sensors now show a halo regardless of entity name. `isWindowSensor` now checks the HA `device_class` attribute (`window`, `door`) first before falling back to name-based matching. Previously, sensors without "окно"/"window" in the name had no halo even when open.
- `isLeakSensor` similarly checks `device_class: moisture` first before name matching.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.12`.

# ALLHA-2D v5.1.0-beta.9 — light/climate marker opacity fix

## Fixed

- Light markers (`light-on`, `light-off`, `light-visual`) and `climate-visual` markers were not responding to the Marker Opacity slider. Root cause: early CSS block (line 13) had state-specific `background:#hex` rules with higher specificity (0,1,1,0) than the base `.device-marker` rule (0,0,1,0), overriding the CSS variable approach introduced in beta.8. Fixed by adding `!important` + `rgba()` with `--marker-bg-opacity` variable to all light and climate-visual state backgrounds.
- `climate-fan` / `climate-on` marker state backgrounds also updated for consistency.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.9`.

# ALLHA-2D v5.1.0-beta.11 — halos for all active markers

## Fixed

- All active device markers now show a halo. Previously `fan`, `humidifier`, `media_player`, `input_boolean`, `lock`, `valve` had no halo regardless of state. The `visualStyle` fallback now returns `haloCss(0.82, 1.90)` for any domain in the ON/active state.
- `switch-on` halo is now animated (pulsing). Previously the halo was visible but static.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.11`.

# ALLHA-2D v5.1.0-beta.10 — water_heater support, binary sensor halos, halo animation toggle

## Added

- **`water_heater` domain** — full support: boiler icon, on/off toggle, operation mode selector (electric, gas, heat_pump, eco, performance, heat_boost, away, auto), target temperature slider, orange halo when heating. Appears in device list, floor plan markers, and quick actions.
- **Binary sensor halos** — generic binary sensors (motion, door contact, etc.) now show a golden halo in the ON / detected state.
- **Halo animation toggle** — new checkbox in Settings → Map & Markers: "Анимация ореолов". When disabled, all halo pulses are removed while halos themselves remain visible.

## Fixed

- Added `water_heater` operation mode labels to `localizedRawState` (electric, gas, heat_pump, eco, performance, high_demand, heat_boost, away).
- Service Worker cache bumped to `allha2d-v5.1.0-beta.10`.

# ALLHA-2D v5.1.0-beta.8 — marker/badge opacity affects background only

## Fixed

- Marker and sensor opacity sliders now make only the **background** transparent. Previously `opacity` was applied to the whole element, making icons and text values transparent too.
- Converted all state-specific marker backgrounds (`switch-on`, `switch-off`, `climate-*`, `cover-*`, `window-*`, `media-*`, `leak-*`, `camera-visual`) from hardcoded hex colors to `rgba(r,g,b,var(--marker-bg-opacity))` so the opacity slider can affect them.
- `.badge` background now also uses `--sensor-bg-opacity`.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.8`.

# ALLHA-2D v5.1.0-beta.7 — badge opacity fix + version sync

## Fixed

- `.badge` elements (StandardSensor temperature/humidity/etc. readouts) now correctly respond to the Sensor Opacity slider. Previously `opacity:1` was hardcoded in CSS, overriding the `--sensor-opacity` variable set by `applyDisplayPrefsOnly()`.
- `Dockerfile.local` `BUILD_VERSION` was stuck at `5.1.0-beta.3` and now tracks the current version.
- `package-lock.json` version field synced to `5.1.0-beta.7`.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.7`.

# ALLHA-2D v5.1.0-beta.6 — display prefs live preview hotfix

## Fixed

- `refreshVisibleMarkersAfterDisplayPrefs()` extracted from `previewUiPrefsSoon()` and now called before `applyStageTransform` so marker re-render happens in the correct order.
- `renderOverviewMetrics()` / `renderRoomMetrics()` added to the refresh so sensor badges also update immediately when display settings change.

# ALLHA-2D v5.1.0-beta.5 — image and display fixes

## Fixed

- Room images with non-WebP format (PNG/JPG) now display correctly when `sharp` is unavailable. `roomImagePathForLevel` now tries all extensions (`webp`, `png`, `jpg`, `jpeg`) the same way `overviewImagePathForLevel` does. Previously a PNG saved via copy-fallback was silently replaced by a placeholder SVG.
- Scoped display settings (marker scale, sensor scale, room label scale, marker opacity, sensor opacity) now update immediately when switching between overview and room views. `applyDisplayPrefsOnly()` is called inside `selectRoom()` before `render()`, so CSS variables `--marker-scale`, `--sensor-scale`, `--room-label-scale`, `--marker-bg-opacity` and `--sensor-bg-opacity` always reflect the current view scope.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.5`.

# ALLHA-2D v5.1.0-beta.3 — CI/package-lock registry hotfix

- package-lock.json resolved tarball URLs changed from the sandbox internal registry to public https://registry.npmjs.org/.
- GitHub Actions GHCR login changed to a retrying docker login shell step to reduce transient ghcr.io timeout failures.
- Version metadata and Service Worker cache updated to v5.1.0-beta.3.

# ALLHA-2D v5.1.0-beta.3 — backup upload safety beta

- Backup upload limit raised to 350 MB for real full backups.
- Backup `.tar.gz/.tgz` import now uses streaming gunzip with output byte accounting and aborts when the decompressed tar exceeds the safety limit.
- Docker builds use `npm ci --omit=dev` with `package-lock.json` for reproducible installs.
- Docker `BUILD_VERSION` updated to `5.1.0-beta.3`.
- Mobile retry button now has `type="button"` and a null-safe handler.
- Service Worker cache updated to `allha2d-v5.1.0-beta.3`.

# ALLHA-2D v5.1.0-beta.3 — backup path hardening + SQLite LIKE cleanup

- Path traversal hardening for `restoreLayoutBackup()` and `deleteLayoutBackup()`: layout backup names no longer allow `/` or `\`, and paths are checked with `pathInside()`.
- SQLite `LIKE` cleanup in `clearProjectDocuments()`: `_`, `%`, and `\` are escaped with explicit `ESCAPE '\\'` to avoid deleting sibling profile/level document rows.
- Version metadata and Service Worker cache updated to `v5.1.0-beta.3`.

# ALLHA-2D v5.1.0-beta.3 — Sonnet audit micro-hotfix

- Added missing null guard in `renderOverviewZones()` for absent `overview-zones` layer.
- Added missing null guards in `openCameraStream()` for camera title/entity labels.
- Fixed `closeAttentionModal()` to call `syncModalOpenClass()` instead of manually removing `modal-open`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.3`.
- FAQ/README/version metadata updated to v5.1.0-beta.3.

## Added

- Backup upload action in Backup Manager for `.tar.gz/.tgz` backups downloaded from ALLHA-2D.
- Uploaded backups are validated, imported into the backup list, and restored only through the normal explicit restore flow.
- Updated screenshots in `docs/screenshots`.
- Full README and FAQ refreshed for v5.1.0-beta.3.

## Fixed

- Added null guards for UI render paths that could crash when a DOM element is absent.
- Fixed modal handling for Attention/FAQ/Diagnostics style flows so modal-open state stays consistent.
- Improved room image onload/onerror handling to avoid stale callbacks during fast room switches.
- Fixed climate slider numeric fallback for `unknown`/invalid Home Assistant values.
- Removed duplicate device-list scroll guard binding.
- Added `type="button"` to generated device-state buttons and StandardSensors modal close button.
- Fixed edit-mode CSS selectors that were broken by newline descendant combinators.
- Added missing CSS variable `--border`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.3`.
- FAQ version now matches v5.1.0-beta.3.
- Removed dead legacy display preference IDs from capture logic.

## Preserved

- v5 HA add-on / Ingress root behavior.
- LAN root registration flow.
- `/client/<slug>` web clients.
- Mobile port `32457`.
- Virtual rooms, StandardSensors, Attention mode, kiosk/mobile/card behavior.

## Docker update commands

```powershell
docker compose down

docker compose build --no-cache

docker compose up -d
```