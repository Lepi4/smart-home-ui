# v5.0.1 — root routing + profile/backup/modal hotfix

- LAN/local root `:8099/` again opens web-client registration/selection instead of anonymous app UI.
- HA Ingress root still opens the app UI; mobile port `32457` still opens the mobile entry.
- Fixed per-device profile activation so `Для этого устройства` no longer changes the global profile.
- FAQ and diagnostics modals now open above the settings modal.
- Backup manager shows restore/download actions more consistently for admin.

## v5.0.0 — minimal HA add-on / Ingress restore

- Restored minimal Home Assistant add-on entry flow on top of stable v4.3.3.
- HA add-on root now opens the main ALLHA-2D app instead of the local /client landing page.
- Added dynamic base path for Home Assistant Ingress so JS/CSS/manifest/assets can load under `/api/hassio_ingress/<token>/`.
- Added `ingress_stream: true` to add-on config for streaming/SSE compatibility.
- Kept local Docker workflow and mobile direct port 32457 unchanged.
- Did not change virtual rooms, StandardSensors, Attention mode, web/mobile clients logic, or Server-client lifecycle yet.

## v4.3.3 — render/SSE diagnostics + release cleanup/docs
- Added a small cleanup for client-side render diagnostics: `states_batch/min` now resets together with `render/min` and `patch/min` in the minute window.
- Kept the existing render/SSE counters visible in diagnostics: client `batch/min`, `state_changed/min`, `patch/min`, `render/min`; server batch/state counters where available.
- Preserved v4.3.2 Attention mode UX and v4.3.1.x virtual room / StandardSensors fixes.
- Refreshed release docs, transfer prompt, and master roadmap for the next v5 planning step.

## v4.3.2 — Attention mode UX + StandardSensors orientation access fix

- Improved Attention modal: active deviations, normal/current state, duration, room/device shortcuts, accept current as normal, ignore always.
- Added server endpoint to accept current entity state as the new normal Attention state.
- Kept StandardSensors orientation editable in admin/control and read-only in viewer.
- Preserved v4.3.1.7 cleanup and working virtual room/StandardSensors fixes.

## v4.3.2 — cleanup after StandardSensors and virtual rooms

- Hid temporary virtual-room diagnostics from normal diagnostics UI; the copy button remains only in debug mode.
- Preserved v4.3.1.6 fixes: overview navigation persistence and separate StandardSensors orientation for overview/rooms.
- Preserved StandardSensors UX/stability changes and control-mode access fixes.
- Release cleanup: refreshed documentation, roadmap, transfer prompt, and package structure.

## v4.3.1.6 — overview navigation persistence + separate StandardSensors orientation

- Исправлено восстановление навигации: `Общий план` теперь сохраняется и восстанавливается как полноценное состояние, а не заменяется последней комнатой.
- Разделена ориентация плашек стандартных сенсоров для общего плана и режима комнат.
- Ориентация меняется в окне стандартных сенсоров: изменение в комнате больше не меняет общий план, и наоборот.
- Сохранены правки v4.3.1.5: разделение настроек карты/маркеров, control access, окно стандартных сенсоров по длинному нажатию.

## v4.3.1.5 — map sliders separation + StandardSensors modal/orientation
- Reorganized `Карта и маркеры`: global hardware scale first, then separate `Общий план` and `Комнаты` display sliders.
- Added separate overview-only and room-only marker/sensor/opacity controls.
- Ordinary sensor markers now follow marker scaling, while StandardSensors badges keep sensor scaling.
- Added StandardSensors group modal opened only by long press on the StandardSensors badge.
- StandardSensors modal shows configured sensor type, current value, and muted entity_id.
- Added StandardSensors badge orientation control inside the modal: horizontal/vertical; editable in admin/control, read-only in viewer.

## v4.3.1.4 — StandardSensors badge tap hotfix
- Rollback base to v4.3.1.2 clean line; v4.3.1.3 is not used.
- Fixed standard sensor badges on overview/room images catching taps above room zones.
- Short/long press on standard sensor values now uses normal device/sensor actions instead of opening the room underneath.
- Saving/clearing StandardSensors remains from v4.3.1.2.

## v4.3.1.2 — StandardSensors map metrics + control settings access hotfix
- fixed StandardSensors disappearing from the map/room image: metric rendering now keeps entity_id context and no longer throws while building standard sensor badges
- rebound short/long press handlers after live metric patch updates
- allowed control mode to edit checkboxes/sliders in Interface, Map and markers, Cards, Kiosk / Mobile panels
- kept weather/temperature entity field admin-only

## v4.3.1.1 — StandardSensors strict suggestions + control access hotfix
- StandardSensors suggestions now require type evidence; same-room alone no longer creates unrelated suggestions
- fixed false “Ошибка сохранения” after successful single sensor accept/save
- standard sensor metric badges now use normal device/sensor short/long press handling instead of opening the room
- Individual settings and “Для этого устройства” profile activation are available in control mode; admin-only actions remain admin-only

## v4.3.1 — virtual rooms cleanup + StandardSensors UX/stability
- Added StandardSensors source labels for selected room sensors: DB, room settings, cache, draft, suggestion or manual input.
- StandardSensors suggestions now show an explicit “Почему предложено” explanation.
- Opening a room StandardSensors panel now automatically loads suggestions if they are not cached yet.
- Improved save feedback and status colors for StandardSensors actions.
- Hid temporary virtual-room snapshot counter from normal diagnostics; it remains debug-only.
- Preserved v4.3.0.12 virtual-room behavior and additional settings panels.

## v4.3.0.12 — settings menu extra panels on Sonnet virtual-room baseline
- used user-provided Sonnet-fixed archive as new baseline; virtual-room checkbox/card positioning fixes from that archive are preserved
- added a separate “Дополнительные настройки отображения и поведения” menu block
- moved only previously top-level/orphaned sliders and checkboxes into new additional panels: Интерфейс, Карта и маркеры, Карточки, Kiosk / Mobile, Безопасность, Live / обновления
- existing large settings buttons/sections are unchanged
- kept existing input ids and handlers, so save/preview logic remains compatible

## v4.3.0.11 — virtual room render gate + image-aligned cards hotfix
- prevent early normal-room render before server room settings are ready
- force refresh current virtual room after /api/rooms and virtual checkbox changes
- align virtual card layer to the actual room image rect, not screen/stage center
- reinforce kiosk room overlay layer above kiosk controls

## v4.3.0.11 — frontend init recovery + independent virtual card size control
- restored missing applyConfigToInputs helper so refresh no longer aborts room settings hydration
- added independent “Размер карточек виртуальной комнаты” slider, separate from card text size
- card size slider changes tile size only; font remains controlled by “Размер текста карточек”
- kept virtual card transparency 0–100% as background-only setting
- strengthened kiosk room list overlay layering

## v4.3.0.11 — virtual diagnostics + bounded card grid + kiosk rooms overlay
- added temporary debug-mode virtual room diagnostics and `/api/debug/virtual-room-state`
- bounded adaptive virtual card grid so cards fit inside image area without becoming giant
- strengthened virtual room render stabilization after loading rooms settings
- raised kiosk room list overlay above kiosk controls

## v4.3.0.8 — virtual room font/transparency/render stabilization hotfix
- reduced and clamped virtual room adaptive card font
- fixed live preview for card font slider in virtual rooms
- fixed virtual card transparency as 0–100 percent without double division
- fixed live preview for virtual card background transparency
- guarded bindRangePreview render callback against boolean values
- added selected virtual room state stabilization after /api/rooms load

## v4.3.0.8 — virtual room adaptive cards + automation toggle hotfix
- canonical merged room settings for virtual room flags and hidden devices
- virtual/kiosk/card state updates patch existing card DOM instead of full-rendering on frequent SSE events
- automation cards toggle automation.turn_on / automation.turn_off and show Auto badge
- virtual room cards use adaptive 90% image-area grid
- added 0–100% virtual card background transparency setting for image mode

## v4.3.0.8 — virtual room broken-image geometry + settings-only hidden devices hotfix
- fixed virtual-room fallback geometry when room image is missing/404
- added fallback sizing for virtual-room card layer
- removed live hidden folder/button from virtual-room cards; hidden devices are settings-only
- hidden-device settings list now stays open across save/re-render

## v4.3.0.8 — virtual room image fallback + hidden devices settings
- virtual rooms now render cards even when the room image is missing or returns 404
- removed hide-on-long-press behavior from virtual room cards; long press stays reserved for device actions
- added per-room hidden device settings inside the room settings card
- hidden devices are stored per virtual room and do not touch markers, HA sources, or normal rooms
- raised kiosk room overlay above kiosk side controls and disables side controls while the room list is open

## v4.3.0.8 — virtual room cards visibility + hidden devices hotfix
- fixed empty virtual room card overlay after v4.3.0.3
- added per-room hidden devices for virtual rooms only
- long press/context menu hides a virtual-room card only in that room
- added `Скрытые` folder to restore hidden virtual-room devices

## v4.3.0.3 — virtual room cards polish + card live state hotfix
- virtual room cards now render inside room image bounds and target about 90% of room image space
- removed entity_id from visible virtual room cards
- improved card typography and added per-client card font size setting
- fixed virtual room card taps and card/kiosk live state refresh
- removed room image darkening in virtual room mode

## v4.3.0.1 — virtual room checkbox model hotfix

- Откат неправильной отдельной модели `virtualRooms` из v4.3.0: новая база собрана от v4.2.19 и реализует исходную идею через галочку у действующей комнаты.
- В настройках комнаты добавлена галочка `Виртуальная`.
- Виртуальная комната всегда показывает устройства карточками, а не маркерами/значками.
- Переключатель `Карта / Карточки` для виртуальной комнаты меняет только подложку/фон, набор устройств остаётся списком устройств этой комнаты.
- При снятии галочки маркеры комнаты не удаляются и возвращаются на прежние места.
- Старые endpoints `/api/virtual-rooms` и отдельные ручные virtualRooms не добавлялись в эту базу.

## v4.2.19 — SSE/runtime stability + Lovelace diagnostics

- Added SSE connection hardening: global limit, per-IP limit, per-client limit, heartbeat cleanup and diagnostics counters for connected/disconnected/rejected/heartbeat/state_changed events.
- Added runtime diagnostics for in-flight requests and graceful shutdown now waits briefly for active requests before closing DB.
- Extended maintenance diagnostics UI with server-side SSE counters, last SSE event, in-flight requests and shutdown state.
- Kept fallback polling selectable at 15/30/60 seconds; SSE-open clients use polling only as a safety fallback.
- Added Lovelace diagnostics endpoints for the current level and all profiles/levels: dashboards read, RAW status/errors, source_config summary, cards/entities/rooms counts, parser warnings, skipped views and unassigned devices.
- Level import keeps saved Lovelace sources unless a request explicitly sends new dashboard paths; import responses now include Lovelace diagnostics.
- No automatic backups were enabled; release archive excludes /data, SQLite DB files, node_modules and local secrets.

## v4.2.18 — maintenance cleanup + backup manager foundation

- Edit UI polish: undo/redo buttons in edit mode now show icons only while keeping full `title`/`aria-label` text; mobile edit zoom right rail is raised by 30px using a scoped mobile-edit variable.
- Mirror repair hardening: normal repair requires `REPAIR MIRROR`, backups are skipped by default, and backup repair requires explicit `includeBackups:true` plus `REPAIR MIRROR BACKUPS`.
- Mirror diagnostics now reports stale/deleted/missing client settings separately.
- Added stale client settings cleanup for DB-only `client_settings` documents of deleted/missing web/mobile clients; protected `Server` and active clients are not touched.
- Backup manager foundation: manual backup writes `backup-manifest.json`, `/api/backups` reads manifest/file stats instead of recursively sizing every backup, backup copies redact secret-like keys, restore requires explicit `RESTORE BACKUP`, and directory backups can be downloaded as `.tar.gz`.
- Automatic backups remain off by default; no `/data`, SQLite DB, node_modules or local secrets should be included in release archives.

## v4.2.17.4 — mobile edit zoom right-rail isolation hotfix

- Fixed mobile edit zoom controls overlapping the top edit toolbar and other buttons on screens narrower than about 1800 px.
- Zoom controls are now moved to the viewport/right-rail layer only during `mobile-mode + editing`.
- Normal mode, kiosk mode, desktop edit mode and non-edit zoom placement are restored/left unchanged.
- Kept v4.2.17.1/v4.2.17.3 fixes: edit arrows and `Действие` stay in the viewport layer, and compact edit labels remain on narrow screens.

## v4.2.17.3 — compact edit toolbar labels hotfix

- Shortened edit-mode top commands on mobile/narrow/short screens: `Сохранить изменения` → `Сохранить`, `Отменить изменения` → `Сброс`.
- Kept full command names in `title` and `aria-label`.
- Added compact spacing for edit save/cancel buttons so zoom controls have more room on screens below ~1800px wide.
- Did not change map pan/center/zoom behavior or server/data format.

## v4.2.17.2 — mobile edit zoom rail vertical position hotfix

- Moved edit-mode zoom controls down into the right rail on mobile/short screens.
- Kept the v4.2.17.1 fix: edit action and movement controls stay outside the map container so `position: fixed` uses the viewport.
- Did not change map pan/center/zoom behavior or server/data format.

## v4.2.17.1 — mobile edit fixed controls containing-block hotfix

- Fixed a real-device regression where right-side edit controls were positioned relative to `.canvas-card` instead of the viewport.
- Cause: `body.overview-edit-lite .canvas-card { contain: layout paint }` creates a containing block for `position: fixed` descendants on mobile browsers, so arrows could jump upward and the `Действие` button could disappear.
- Runtime now moves `#edit-map-nudge` and `#btn-edit-actions-float` to `document.body`, outside `.canvas-card`.
- CSS also disables `.canvas-card` containment during `mobile-mode + editing`.
- No backend/data format changes.

## v4.2.17 — grouped edit movement controls polish

- Zoom controls remain separate.
- The edit movement arrows and the “Действие” button are grouped visually in the right rail.
- The second row of movement buttons is positioned about 10% below screen center.
- Movement buttons are circular instead of vertical ovals.
- Added safer row/column spacing between movement buttons.

## v4.2.14 — edit controls safe spacing hotfix

- Fixed overlap between zoom controls, edit map movement arrows, and the floating “Действие” button on small mobile/landscape screens.
- The “Действие” button and arrow block now use separate fixed right-rail zones with explicit vertical spacing.
- Kept the two-row arrow layout and the center buttons from v4.2.11/v4.2.12.
- No data format or backend logic changes.

## v4.2.8 — edit mode map nudge arrows
- Added edit-mode map nudge arrows: up/down/left/right.
- Arrows appear near the “Действие” button and zoom controls, with touch-friendly spacing.
- Each tap pans the active map through the existing clamped viewport logic, so the map cannot be lost off-screen.
- Long-tap map panning was not added; explicit arrows avoid conflicts with selecting markers/sensors/zones.


## v4.2.8 — mobile/kiosk edit UI polish + release debug cleanup
- Replaced the long edit-mode banner with a short `Редактирование` indicator in the toolbar kiosk slot.
- Tapping `Редактирование` shows: `Режим управления отключён, пока идёт редактирование`.
- Renamed the hidden edit panel return button to `Действие` and moved it to the right side above Settings on mobile.
- Hid map diagnostics button from normal UI unless debug mode is enabled.
- Guarded temporary standard sensor console.debug output behind diagnostics/debug mode.

## v4.2.3 - dangerous command confirmation + kiosk/attention UI cleanup

- Fixed dangerous command confirmation flow: confirming a dangerous command no longer recursively hits the in-flight command lock, so the command executes after confirmation and the lock clears correctly.
- Removed the extra kiosk “Заблокировано” badge/toast on lock; the Lock/Unlock button is the state indicator.
- Centered the Attention/“Следить за состоянием” kiosk icon and increased it by roughly 20% for better visibility.


## v4.2.2 — DB consistency + kiosk switcher layout hotfix

- Added explicit DB transaction wrapper for multi-statement SQLite operations.
- Wrapped mobile/web client upsert/delete, project document clear, orphan cleanup, and standard sensor replacement in transactions.
- Kept deleted/nonexistent web-client settings writes from creating or resurrecting clients.
- Fixed kiosk “Карта/Карточки” switcher overlap by forcing a compact vertical stack with explicit height/gap/top reset.
- Updated package/report/prompt/roadmap for v4.2.2.

# v4.2.0.27 — rebased client lifecycle + control mode + Huawei/kiosk cleanup

- Rebuilt explicitly on top of v4.2.0.22 server archive.
- Deleted `/client/<slug>` no longer auto-recreates a web-client after refresh.
- Start page handles `?missingClient=` with a clear deleted/unavailable client message and clears stale localStorage client slug/id/url.
- Mobile WebView/public flow no longer reuses stored web-client slug unless URL is actually `/client/<slug>`.
- Added bulk web-client delete endpoint and UI action; service `Server` client is protected.
- Control mode can access profiles, levels, and individual client settings; viewer remains read-only.
- Kiosk mobile overlays are shifted away from left side buttons.
- Added old Android/Huawei fallback for placement editor / zone drawing and delayed map-dimension handling after settings restore.

# v4.2.0.21 — old Android/Huawei settings modal compatibility hotfix

- Added a mobile-only simple fullscreen settings panel fallback for old Huawei/Android Chrome/WebView.
- Disabled `contain`, `transform`, `filter`, `backdrop-filter` and `will-change` inside `#settings-modal` on `body.mobile-mode`.
- Kept settings scroll as a plain `overflow-y:auto` container with `-webkit-overflow-scrolling:touch`.
- Reinforced mobile room list scroll so the outer `.sidebar` does not capture touch scroll.

# Previous releases

See package reports and roadmap documents for earlier v4.2.0.x changes.


## v4.2.12 — edit map arrows positioning + wider safe pan

- В режиме редактирования добавлена центральная кнопка `◎` для возврата карты в центр.
- Стрелки перемещения карты перенесены так, чтобы не перекрывать блок масштаба и были доступны рядом с кнопкой `Действие`.
- Открытая панель действий теперь находится выше стрелок по z-index и может перекрывать их, как задумано.
- В режиме редактирования расширены безопасные пределы pan: край карты можно довести примерно на 20% за центр экрана, но карту нельзя полностью потерять.
- Long-tap pan не добавлялся, чтобы не конфликтовать с выбором объектов.


## v5.0.2
- HA Ingress root uses a fixed Server UI identity for per-client profile/settings actions.
- FAQ/Diagnostics modals open above Settings without stacked backdrops.
- Modal-open state hides mobile bottom bar reliably.
