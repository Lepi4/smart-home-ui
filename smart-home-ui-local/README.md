# Smart Home UI Local — Home Assistant Add-on

**Smart Home UI Local** — локальная touch-first панель управления Home Assistant с планом квартиры, комнатами, маркерами устройств, датчиками, режимом киоска и безопасным локальным хранением данных в `/data`.

Репозиторий подготовлен под GitHub Container Registry:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.42
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.42
```

Add-on устанавливается в Home Assistant через Ingress и не требует ввода Home Assistant URL или long-lived token.

---

## Основная идея

Проект заменяет обычный Lovelace-dashboard отдельным локальным UI:

- общий план квартиры используется как главный экран;
- по тапу открывается отдельная картинка комнаты;
- устройства импортируются из Lovelace RAW / `device.txt`;
- состояния и управление берутся из Home Assistant API;
- управление рассчитано на мышь, телефон, планшет и настенную панель;
- layout хранится локально и не теряется при обновлении контейнера.

---

## Что умеет текущая версия v3.4.42

### Home Assistant add-on

- Работает через Home Assistant Ingress.
- Не требует ручного ввода URL/token.
- Использует Supervisor API через `homeassistant_api: true`.
- Docker images собираются через GitHub Actions и публикуются в GHCR.

### План квартиры и комнаты

- Главный экран: общий план квартиры.
- Отдельные картинки комнат.
- Зоны комнат на общем плане.
- Маркеры устройств.
- Датчики температуры/влажности/состояний.

### Touch-first управление

- Короткий тап — основное действие устройства.
- Долгое удержание — меню функций.
- Редактирование координат — только через SVG Layout Editor. Перетаскивание отключён.
- ПКМ на desktop можно использовать как дополнительный shortcut, но он не обязателен.

### Безопасное редактирование layout

- Вход в редактор — удержание кнопки **Редактировать** 2 секунды.
- В редакторе доступны **Сохранить изменения** и **Отменить изменения**.
- Layout не сохраняется после каждого движения.
- Перед сохранением создаётся backup.

### Масштабирование

- Pinch-to-zoom двумя пальцами.
- Pan карты.
- Кнопки `− / + / fit`.
- Аппаратный масштаб карты под конкретный экран.
- Отдельные масштабы:
  - маркеры устройств;
  - датчики;
  - названия помещений.
- Отдельная прозрачность фона датчиков и маркеров.

### Kiosk mode

- Скрывает лишние панели.
- Оставляет карту/комнату.
- Есть кнопка выхода.
- Есть кнопка **Комнаты** в киоске, чтобы перейти на общий план или в другую комнату.

### Диагностика

В настройках есть раздел **Информация / диагностика**:

- состояние HA API;
- количество устройств;
- количество HA entities;
- missing entity_id;
- дубли entity_id;
- устройства без координат;
- layout diagnostics;
- backups.

### Хранение данных вне контейнера

Runtime-данные хранятся в `/data`:

```text
/data/layout.json
/data/backups/
/data/addon_config.json
/data/source_config.json
/data/ui_state.json
/data/devices.js
/data/devices.json
/data/lovelace-source.js
/data/lovelace_raw.json
```

Если удалить add-on и при вопросе Home Assistant выбрать **не удалять данные**, после повторной установки система должна восстановиться с прежними layout/settings/devices.

---

## Установка

### 1. Добавить репозиторий в Home Assistant

```text
Settings → Add-ons → Add-on Store → ⋮ → Repositories
```

Добавить URL:

```text
https://github.com/Lepi4/smart-home-ui
```

### 2. Установить add-on

```text
Settings → Add-ons → Smart Home UI Local → Install
```

### 3. Запустить

```text
Start → Open Web UI
```

---

## Структура репозитория

В корне репозитория должно быть:

```text
repository.yaml
README.md
.github/workflows/docker.yml
smart-home-ui-local/
```

Внутри `smart-home-ui-local/`:

```text
config.yaml
Dockerfile
package.json
server.js
start.sh
icon.png
logo.png
public/
data/
```

---

## GitHub Actions / GHCR

После изменения версии или кода:

```bash
git add .
git commit -m "Update Smart Home UI add-on to v3.4.42"
git push
```

Затем GitHub Actions соберёт images:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.42
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.42
```

Если пакет GHCR private, Home Assistant не сможет скачать image. Нужно сделать package публичным:

```text
GitHub → Packages → Package settings → Change visibility → Public
```

---

## Как подготовить Lovelace-панель для сканирования устройств

Рекомендуется создать отдельную dashboard-панель, например **Smart Home UI Source**.

Пример YAML:

```yaml
title: Smart Home UI Source
views:
  - title: Комнаты
    path: smart-home-ui-source
    cards:
      - type: entities
        title: Кухня
        entities:
          - entity: light.kitchen_ceiling
            name: Люстра
          - entity: switch.kitchen_led
            name: Подсветка
          - entity: sensor.kitchen_temperature
            name: Температура

      - type: entities
        title: Гостиная
        entities:
          - entity: light.living_room_main
            name: Основной свет
          - entity: climate.living_room_ac
            name: Кондиционер
          - entity: cover.living_room_curtain
            name: Шторы

      - type: entities
        title: Ванная
        entities:
          - entity: light.bathroom_main
            name: Свет
          - entity: switch.bathroom_fan
            name: Вентиляция
          - entity: sensor.bathroom_humidity
            name: Влажность
```

Правила сканера:

```text
card.title = название комнаты
entity = устройство комнаты
entity.name = отображаемое имя устройства
```

---

## Важное про координаты layout

Координаты маркеров должны храниться в процентах относительно изображения:

```json
{
  "entity_id": "light.kitchen",
  "x": 51.4,
  "y": 37.8
}
```

Не в пикселях экрана:

```json
{
  "x": 513,
  "y": 244
}
```

Так маркеры остаются на тех же местах на ПК, телефоне и планшете.

---

## Roadmap

### v3.4.x Stability

- довести mobile/landscape/kiosk UX;
- нормализовать layout storage;
- улучшить диагностику;
- добавить безопасные режимы команд.

### v3.5.0 Setup from scratch

- загрузка общего плана;
- создание/переименование/удаление комнат;
- загрузка картинок комнат;
- прямоугольные зоны комнат;
- ручное добавление устройств;
- список неразмещённых устройств.

### v3.6.0 Portability

- экспорт проекта в ZIP;
- импорт проекта из ZIP;
- полный backup/restore;
- восстановление после переустановки add-on.

---

## Изменения v3.4.42

- В режиме редактирования общего плана панель устройств теперь сгруппирована по комнатам.
- Одновременно раскрыта только одна группа: открытие второй комнаты автоматически сворачивает предыдущую.
- Добавлена группа «Неразмещённые» для устройств без маркера на общем плане.
- В закрытых группах не рендерятся карточки устройств, поэтому общий план в edit mode меньше нагружает мобильный/landscape UI.
- Сценарий размещения в режиме редактирования переведён в SVG Layout Editor: выбрать устройство → клик/тап по сетке → точная подстройка X/Y → Применить.
- Поиск работает поверх групп и показывает только подходящие комнаты/устройства.

## v3.4.42 — overview edit accordion

This release optimizes overview editing on touch devices and landscape screens. Instead of rendering 180+ device cards at once, the Devices panel shows room groups as an accordion. Only the active group renders its cards, which reduces layout/repaint cost and makes selecting devices for the SVG Layout Editor easier.

## Изменения v3.4.42

- В режиме редактирования общего плана список устройств всегда работает как аккордеон по комнатам.
- Закрытые комнаты не рендерят карточки устройств, что снижает нагрузку на мобильных и в landscape.
- Одновременно раскрыта только одна группа; повторный тап закрывает группу.

## v3.4.42 — grouped edit device panel

In edit mode the device panel is now grouped by room on every screen, not only on mobile. Closed room groups do not render device cards, which reduces UI load on large dashboards. The media Lovelace parser also uses `heading` cards as source groups and tries to infer the actual room from the device name, so entries like “Алиса кабинет”, “Алиса гостиная”, or “ТВ гостиная” can be grouped with the corresponding room instead of falling into “Неразмещённые”.


## v3.4.42 — HA Area fallback and edit groups

- В режиме редактирования панель устройств всегда группируется по комнатам, без зависимости от мобильной/desktop версии.
- При редактировании конкретной комнаты её группа открывается сразу, чтобы не надо было раскрывать список вручную.
- Импорт Lovelace теперь дополнительно читает Home Assistant Area/Entity/Device registry через WebSocket API. Если комнату нельзя понять из карточки Lovelace или имени устройства, используется помещение сущности из Home Assistant.
- Для media-вкладок без карточек-комнат это помогает распределять устройства по реальным помещениям HA, а не отправлять их в “Неразмещённые”.


## Kiosk Lock / Auto-lock

В режиме киоска доступна кнопка Lock/Unlock в нижнем углу. В состоянии Lock тапы по устройствам, датчикам и зонам игнорируются, чтобы случайно ничего не включить. В настройках есть Auto-lock: при включении киоск автоматически блокируется после заданного времени бездействия, по умолчанию 15 секунд.

## v3.4.42: Device Picker в режиме редактирования

В режиме редактирования кнопка **Устройства** открывает отдельное окно выбора устройства. После выбора окно закрывается, а устройство ставится на карту следующим тапом. Это заменяет тяжёлую панель устройств поверх карты и работает одинаково на ПК и мобильных.


## v3.4.42 — Lightweight Edit Mode

В режиме редактирования приложение временно отключает живые обновления HA, glow-анимации, hover/long-press меню, быстрые действия и тяжёлые визуальные состояния маркеров. Редактор становится статичным и лёгким: выбрать устройство можно через Device Picker, затем открыть SVG Layout Editor, кликнуть/тапнуть точку на сетке, подстроить X/Y и нажать «Применить». После сохранения или отмены live dashboard включается снова.

## Изменения v3.4.42

- Это особенно важно при zoom/pan, hardwareScale, landscape-режиме и запуске через Home Assistant Ingress/Android WebView.
- Drag существующих маркеров также использует image-space координаты, чтобы маркер оставался там, где его отпустили.


## v3.4.42 — Placement Editor Rework

Новые устройства больше не размещаются через живую dashboard-карту с zoom/pan/transform. В режиме редактирования после выбора устройства открывается отдельный лёгкий редактор размещения на SVG-слое `viewBox 0 0 100 100`:

- картинка overview/room используется как координатная подложка;
- поверх неё показывается сетка 0–100%;
- клик/тап по изображению задаёт preview-точку;
- стрелки позволяют подстроить координаты шагом 0.1/0.5/1/2%;
- кнопка “Применить” записывает координаты в layout;
- live HA polling, меню, long press, hover и zoom/pan dashboard-карты не участвуют в расчёте координат.

Это основной способ точного размещения на мобильном, планшете и ПК.


## v3.4.42 — Placement Editor coordinate round-trip

Placement Editor now uses the natural image size as the SVG coordinate system and stores only percentages in layout. This fixes mismatches where a marker preview was correct in the editor but appeared shifted after applying it on the live overview/room map.


## v3.4.42 — Unified SVG Layout Editor

- Перетаскивание removed from edit mode.
- New device placement: Edit → Devices → select device → SVG Layout Editor → click/tap grid → adjust X/Y/arrows → Apply.
- Existing marker movement uses the same flow: select marker → click/tap new point in Layout Editor → adjust → Apply.
- Live dashboard, zoom/pan, hardware scale and old live placement overlay no longer participate in coordinate editing.


## v3.4.42 — cleanup old edit mechanisms

- Removed/disabled old старое размещение поверх live-карты UI.
- Disabled подсказки перетаскивания and старое размещение поверх live-карты in edit mode.
- Stage pan/zoom handlers do not run in edit mode.
- SVG Layout Editor is the only supported way to place or move markers.

## v3.4.42 — финальная очистка старого редактора

- Удалены устаревшие пользовательские сценарии размещения поверх live-карты.
- В режиме редактирования координаты меняются только через SVG Layout Editor.
- Список устройств открывает редактор; маркер выбирается кликом и редактируется кликом по сетке, X/Y и стрелками.
- Старое перетаскивание, live-map размещение и связанные подсказки отключены.

## v3.4.42 — Placement Editor coordinate debug

- Расчёт точки клика в SVG Layout Editor больше не использует `getScreenCTM()`.
- Новый расчёт использует `getBoundingClientRect()` и вручную учитывает letterbox от `preserveAspectRatio="xMidYMid meet"`.
- В редактор добавлен раскрываемый debug-блок с `clientX/clientY`, SVG rect, image rect, scale, offset и рассчитанными x/y процентами.


## v3.4.42

- Unified Marker Anchor: координата `x/y` теперь принадлежит нулевому anchor-слою, а визуальный маркер всегда центрируется на нём. Это убирает смещение разных типов маркеров из-за scale/transform.
- В режиме редактирования короткий тап по установленному устройству только выбирает маркер. Перемещение открывается долгим удержанием и выполняется через SVG Layout Editor.
- Системные сдвоенные датчики остаются видимыми в режиме редактирования и больше не должны падать в `y=0`; некорректные координаты заменяются безопасной дефолтной позицией.

## v3.4.42 — Stable Placement Editor Sizing

Placement/SVG Layout Editor no longer relies on a scrollable canvas or CSS `max-height: 100%` flex sizing. The editor canvas is locked with `overflow: hidden` and `touch-action: none`, while the SVG size is explicitly fitted in JavaScript using the image natural size and the available canvas rectangle. This keeps `getBoundingClientRect()` stable across desktop, mobile, BlueStacks/WebView and orientation changes.

This version keeps the v3.4.40 behavior: unified marker anchor, short tap selects a marker, long press opens the SVG editor for moving it, and system temperature/humidity badges remain protected.


## v3.4.42 — датчики и debug mode

- Системные датчики температуры/влажности снова позиционируются одинаково в режиме просмотра и редактирования.
- Системные датчики нельзя удалить, но их можно переместить: короткий тап выбирает, долгое удержание открывает SVG Layout Editor.
- Добавлена настройка Debug mode: координатные debug-окна показываются только при включённой галке.
