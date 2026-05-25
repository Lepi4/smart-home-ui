# ALLHA-2D v5.1.0-beta.31 — cross-pack icon search + browse all without typing

## Changed

- **Поиск по всем пакетам** — при вводе 2+ символов поиск идёт по всем пакетам одновременно (MDI, Бренды, Phosphor, Tabler, Remix). Результаты сгруппированы по пакету, до 80 иконок с каждого.
- **Просмотр без поиска** — маленькие пакеты (Бренды, Phosphor, Remix) открываются сразу со всеми иконками при переключении на вкладку — без ввода запроса.
- Вкладки паков по-прежнему работают для просмотра отдельного пакета с группировкой по категориям.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.31`.

# ALLHA-2D v5.1.0-beta.30 — fix icon picker subtitle

## Fixed

- Заголовок окна выбора иконок теперь корректно отображает все пакеты: `MDI · Бренды · Phosphor · Tabler · Remix — 17 000+ иконок` (ранее осталась старая надпись «Поиск по библиотеке MDI»).
- Service Worker cache bumped to `allha2d-v5.1.0-beta.30`.

# ALLHA-2D v5.1.0-beta.29 — icon picker grouped by category

## Changed

- **Выбор иконок — группировка по категории** — иконки теперь отображаются сгруппированными по первому слову имени (например, все `apple-*` в группе **Apple**, все `google-*` в группе **Google**).
- Малые пакеты (Бренды, Phosphor, Remix — до 2000 иконок): открываются сразу со всеми иконками без поиска.
- Большие пакеты (MDI, Tabler — 2000+): поиск открывает сгруппированные результаты.
- Лимит результатов поиска увеличен с 300 до 500.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.29`.

# ALLHA-2D v5.1.0-beta.28 — fix camera fallback for HEVC/H.265 streams

## Fixed

- **Камера HEVC (H.265)** — ONVIF камеры с кодеком HEVC/H.265 теперь автоматически переключаются на MJPEG-поток при ошибке HLS. Ранее при фатальной ошибке HLS.js (неподдерживаемый кодек) срабатывал только снапшот-фолбэк вместо MJPEG. Теперь цепочка: HLS → MJPEG (entity_picture token) → снапшот.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.28`.

# ALLHA-2D v5.1.0-beta.27 — camera MJPEG stream + per-client icon settings

## Added

- **Видео с камеры (MJPEG)** — в Ingress-режиме браузер напрямую подключается к MJPEG-потоку HA через `entity_picture` токен. Поддерживаются ONVIF/NVT камеры (go2rtc не нужен). Порядок попыток: HLS (go2rtc) → MJPEG (entity_picture) → снапшот.
- **Глобальный цвет иконок** — палитра в Настройки → Интерфейс. Привязывается к текущему клиенту (устройству), не глобально.

## Changed

- **Иконки устройств → клиентские** — выбор иконок перенесён из SQLite в `localStorage`. Каждый браузер/устройство теперь хранит свои иконки независимо. Существующие иконки на сервере не читаются (сброс при первом открытии).
- **Цвет иконок устройств → клиентский** — аналогично иконкам, цвета теперь хранятся в `localStorage` per-client.
- Кнопка "Сменить иконку (MDI)" переименована в "Сменить иконку" (поддерживаются все пакеты).
- Service Worker cache bumped to `allha2d-v5.1.0-beta.27`.

# ALLHA-2D v5.1.0-beta.26 — multi-pack icon picker (MDI + Brands + Phosphor + Tabler + Remix)

## Added

- **Мультипаковый выбор иконок** — в редакторе иконок устройств теперь 5 пакетов на выбор:
  - **MDI** — Material Design Icons (7 400+ иконок)
  - **Бренды** — Custom Brand Icons от elax46 (1 580+ иконок устройств и брендов умного дома)
  - **Phosphor** — Phosphor Icons (1 510+ иконок, viewBox 256×256)
  - **Tabler** — Tabler Icons stroke-based (5 090+ иконок, чёткие линии)
  - **Remix** — Remix Icons line-варианты (1 540+ иконок)
- Пакеты загружаются лениво (только при первом переключении на пакет).
- Иконки хранятся с префиксом пакета: `cbi:`, `ph:`, `ti:`, `ri:`, MDI без префикса.
- Добавлены скрипты генерации JSON-файлов для каждого пакета в `scripts/`.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.26`.

# ALLHA-2D v5.1.0-beta.25 — marker value scale fix

## Fixed

- Ползунок "Размер значения на маркере" теперь влияет **только** на значения на маркерах плана этажа. Ранее он также увеличивал текст в плитках боковой панели (`.dev-icon`) и быстрых действиях (`.quick-icon`), делая их нечитаемыми. Исправлено: `--marker-value-scale` применяется только к `.device-marker`.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.25`.

# ALLHA-2D v5.1.0-beta.24 — HLS video player for cameras

## Added

- **HLS видеоплеер для камер** — встроен `hls.js` (v1.5.15). При открытии камеры сервер запрашивает у HA HLS-поток через WebSocket `camera/stream`. В Ingress-режиме браузер воспроизводит HLS напрямую с HA через `<video>` + HLS.js (Chrome/Firefox) или нативно (Safari). При ошибке — автоматический откат на снапшот.
- Новый эндпоинт `GET /api/camera/stream-url/:entity_id` — возвращает HLS URL от HA WebSocket.
- Таймаут ожидания MJPEG снижен с 8с до 1.5с — снапшот теперь появляется быстрее для камер без MJPEG.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.24`.

# ALLHA-2D v5.1.0-beta.22 — camera snapshot auth/sign_path fix

## Fixed

- Снапшот камеры: добавлен второй способ — `auth/sign_path` через WebSocket (тот же механизм, что Lovelace использует для `authSig`). Когда `camera_proxy` с Bearer-токеном возвращает 403 — сервер запрашивает подписанный URL через WebSocket и скачивает кадр по нему. Это должно починить NVT/ONVIF камеры (go2rtc).
- Исправлен баг: `haWsCommand({ type: 'camera_thumbnail' })` — передавался объект вместо строки типа. Теперь `camera_thumbnail` как третий вариант фолбэка тоже работает корректно.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.22`.

# ALLHA-2D v5.1.0-beta.21 — camera snapshot via WebSocket fallback + version display fix

## Fixed

- Снапшот камеры теперь использует резервный механизм `camera_thumbnail` через WebSocket (как Lovelace) когда `camera_proxy` возвращает 403. Камеры типа NVT/ONVIF (`camera.nvt_substream`) теперь показывают изображение.
- `Dockerfile` (HA add-on) имел устаревший `BUILD_VERSION=5.1.0-beta.15` — версия в разделе "Информация и диагностика" не обновлялась с beta.15. Исправлено: оба Dockerfile (`Dockerfile` и `Dockerfile.local`) синхронизированы с актуальной версией.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.21`.

# ALLHA-2D v5.1.0-beta.20 — fix MDI icons under HA Ingress

## Fixed

- `fetch('/mdi-icons.json')` заменён на `fetch('mdi-icons.json')` (относительный URL). Под HA Ingress абсолютный путь уходил на корень HA (`/mdi-icons.json`) вместо аддона → 404 → пустой словарь → поиск иконок не работал.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.20`.

# ALLHA-2D v5.1.0-beta.19 — custom icon color per device

## Added

- **Цвет иконки маркера** — в модале устройства (кнопка "Сменить иконку") появилась строка из 15 цветных кружков. Клик на кружок сохраняет цвет иконки этого устройства в SQLite (`custom-icon-colors`). Кнопка ✕ сбрасывает к жёлтому по умолчанию.
- Цвет применяется через CSS-переменную `--marker-icon-color` на `<span class="ico">` — ореолы и фон маркера не затрагиваются.
- Дефолтный цвет иконок маркеров `#ffd36e` (жёлтый) явно сохранён как фоллбэк в CSS-переменной — поведение для всех существующих устройств не меняется.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.19`.

# ALLHA-2D v5.1.0-beta.18 — camera MJPEG fix + snapshot fallback

## Fixed

- Убран `AbortSignal.timeout(10_000)` из прокси MJPEG-стрима на сервере — он убивал долгоживущее соединение раньше, чем камера успевала отдать первый кадр. Теперь соединение живёт пока браузер не закрыл вкладку/модал.
- Клиент: если MJPEG-стрим не отдал первый кадр за 8 секунд или вернул ошибку — автоматически переключается на JPEG-снапшот с обновлением каждые 3 с. При закрытии модала все таймеры очищаются.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.18`.

# ALLHA-2D v5.1.0-beta.17 — camera snapshot fallback + hotfixes

## Fixed

- Camera modal now falls back to JPEG snapshot (auto-refresh каждые 3 с) если MJPEG-стрим (`camera_proxy_stream`) недоступен. NVT/ONVIF-камеры типа `camera.nvt_substream` теперь показывают изображение.
- Добавлен `cameraRefreshTimer` в `state` — таймер корректно останавливается при закрытии модала.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.17`.

# ALLHA-2D v5.1.0-beta.16 — cameras on floor plan, sensor values on markers, clock date & scale

## Added

- **Camera entities in device picker** — `camera` domain added to `IMPORTANT_DOMAINS`; cameras now appear in the device list for adding to floor plan. Camera markers were already fully supported; they were just missing from the picker.
- **Generic sensor values on markers** — `sensor` entities without a known category (template sensors, custom sensors) now show their raw state value below the icon on the floor plan marker. Previously only temperature, humidity, CO2, noise, and illuminance sensors showed values.
- **Clock date / day-of-week** — new checkbox in Settings → Interface: "Показывать дату и день недели под часами". When enabled, the kiosk clock widget shows the weekday and date in Russian below the time.
- **Clock scale slider** — new slider in Settings → Interface: "Масштаб виджета часов" (40–250%). Scales the entire clock/weather widget via CSS `transform:scale(--clock-scale)`.
- **Marker value font-size slider** — new slider in Settings → Map & Markers: "Размер значения на маркере" (50–250%). Scales the value badge on device markers (brightness %, temperature setpoint, sensor reading) and the large sensor readout in room view.

## Fixed

- Service Worker cache bumped to `allha2d-v5.1.0-beta.16`.

# ALLHA-2D v5.1.0-beta.15 — SVG metric badge icons + CO2 sensor icon fix

## Fixed

- Standard sensor badge icons (temperature, humidity, motion, noise, illuminance) now render as inline SVG instead of emoji. Previously they appeared as squares on Raspberry Pi kiosk Chromium (missing emoji font).
- CO2 sensor was missing from `sensorIconMarkup` paths — markers for CO2 entities showed `undefined` inside the SVG instead of an icon. Fixed by adding `co2` path and refactoring paths to shared `SENSOR_SVG_PATHS` constant.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.15`.

# ALLHA-2D v5.1.0-beta.14 — SVG icons for all marker domains (Pi kiosk fix)

## Fixed

- Device markers for `switch`, `fan`, `humidifier`, `input_boolean`, `valve`, `lock`, `button`, `script`, `automation`, `input_number`, `input_select`, `scene` now use inline SVG icons instead of emoji characters. Previously these domains fell through to the emoji fallback (`TYPE_ICONS`), which rendered as empty squares on Raspberry Pi kiosk Chromium due to missing emoji fonts.
- Service Worker cache bumped to `allha2d-v5.1.0-beta.14`.

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