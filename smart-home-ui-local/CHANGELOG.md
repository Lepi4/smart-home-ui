# Changelog — ALLHA-2D

## [3.6.0.7] — в разработке
- Индикатор режима соединения: Live ● / Поллинг ↺ / Нет связи
- Модуль `src/lovelace.js` — вынос парсинга Lovelace из server.js

## [3.6.0.6] — 2026-05-09

### Архитектура
- Новый модуль `src/ha.js`: haFetch, haWsCommand, statesCache, SSE-рассылка, WS-подписка
- `server.js` больше не импортирует `ws` и не определяет haFetch/haWsCommand напрямую

### Real-time обновления
- Постоянное WebSocket-соединение к HA (`state_changed` subscription)
- `/api/ha/events` — SSE-эндпоинт: `initial_states` при подключении + `state_changed` в реальном времени
- `/api/ha/states` отвечает из `statesCache` (мгновенно), fallback на HA REST только при пустом кэше
- Keepalive пинг каждые 25 с для SSE-соединений
- Экспоненциальный backoff реконнекта: 5 s → 10 s → 20 s → 40 s → 60 s max; сброс при успехе
- Обработка `state_removed`: entity удаляется из кэша и из UI

### Производительность
- `patchMarkerForEntity()` — точечное обновление маркера в DOM без полного re-render
- Обновляются только className, CSS-переменные ореола (--halo-alpha, --halo-scale), innerHTML кнопки
- Полный render() только при появлении новой entity или в режиме редактора
- Дебаунс 80 мс батчит несколько быстрых state_changed в один рендер
- Поллинг переходит в режим fallback (60 с) когда SSE активен

### Безопасность
- `haApiBase` и `haWsUrl` удалены из ответа `/api/diagnostics` и из UI-панели диагностики
- Взамен: `liveStatesCache` — количество entity в серверном кэше

### Исправления
- Исправлен критический баг: `readyState === 0` (CONNECTING) вместо `=== 1` (OPEN) — поллинг работал с обратным интервалом

---

## [3.6.0.5] — 2026-05-08

### Новые функции
- **PWA**: manifest.json + Service Worker (network-first, offline shell caching)
- **4 темы**: dark / light / midnight (AMOLED) / sepia через `body[data-theme]` + CSS custom properties
- **Undo / Redo** в редакторе планировки: snapshot-стек, кнопки ↩/↪ в тулбаре, Ctrl+Z / Ctrl+Y
- **Свайп между комнатами**: touch-жест влево/вправо по плану (минимум 60px, угол < 60°)
- **Камеры**: нажатие на маркер camera domain → модальное окно MJPEG-стрима
- **Экспорт / Импорт планировки**: JSON-файл через кнопки в Настройки → Layout

### Серверные эндпоинты
- `GET /api/camera/stream/:entity_id` — MJPEG-прокси через HA camera_proxy_stream, pipe через Node.js Readable.fromWeb
- `GET /api/camera/snapshot/:entity_id` — одиночный кадр (fallback / кнопка Обновить)
- `GET /api/export/layout` — скачать layout.json как attachment
- `POST /api/import/layout` — загрузить и применить layout (валидация через normalizeLayoutPayload)

### Безопасность
- Security headers middleware: X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Referrer-Policy
- In-memory rate limiter без внешних зависимостей: 30 req/min для `/api/ha/service`, 60 req/min для camera
- `/api/system` очищен от haApiBase, haWsUrl, dataDir
- Очистка rate-limit store каждые 5 минут (`.unref()`)

### Исправления
- Удаление зоны в редакторе больше не выбрасывает на главную карту — редактор остаётся открытым с пустым состоянием

---

## [3.6.0.4] и ранее

- Базовая функциональность: 2D-план, маркеры устройств, кик-режим, управление профилями/уровнями
- Backup-система, attention rules, диагностика
- Lovelace import, стандартные датчики комнат
- Поллинг состояний HA каждые N секунд
