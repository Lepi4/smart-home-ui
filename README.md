# Smart Home UI Local — Home Assistant Add-on

**Smart Home UI Local** — локальная touch-first панель управления Home Assistant с планом квартиры, комнатами, маркерами устройств, датчиками, режимом киоска и безопасным локальным хранением данных в `/data`.

Репозиторий подготовлен под GitHub Container Registry:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.30
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.30
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

## Что умеет текущая версия v3.4.30

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
- Drag — только в режиме редактирования.
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
git commit -m "Update Smart Home UI add-on to v3.4.30"
git push
```

Затем GitHub Actions соберёт images:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.30
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.30
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

## Изменения v3.4.30

- Настройки переведены на более лёгкое окно: один внутренний scroll-контейнер, без тяжёлых sticky-слоёв внутри прокрутки.
- Слайдеры масштаба/прозрачности больше не сохраняют `/data/ui_state.json` на каждое движение пальца.
- Preview слайдеров применяется через `requestAnimationFrame`, сохранение происходит с debounce и при отпускании.
- README расширен: добавлено подробное описание проекта, установка, структура, GHCR, Lovelace source, `/data`, layout coordinate rules и roadmap.

## v3.4.30 — data consistency and security

This release separates shared settings from device-local state:

- shared settings are stored in `/data/addon_config.json` and are the same on PC, mobile and kiosk panels;
- device-local state such as zoom, pan, last opened room, hidden panels and kiosk state is stored separately in `/data/ui_state.json` / browser local state;
- marker/sensor/room-label scale, background transparency, dark theme and clock/weather visibility are global settings.

Security hardening:

- service calls are split into safe and dangerous groups;
- dangerous commands are disabled by default;
- dangerous commands can require confirmation;
- panel mode can be `viewer`, `control` or `admin`;
- the last service calls are logged in `/data/command_log.json` and shown in diagnostics.

Setup-from-scratch foundation:

- `/data/images` is created automatically;
- images from `/data/images` are exposed as `/media/...`, ready for the upcoming room/image manager.


## v3.4.30 — mobile panel stability

This release fixes mobile panel behavior after the security/data-consistency update:

- Rooms and Devices mobile panels are now mutually exclusive; opening one closes the other.
- Tapping outside an open mobile panel closes it.
- Rooms and Devices are rendered as compact bottom sheets above the mobile navigation bar.
- The map is dimmed while a mobile panel is open, but the bottom navigation remains usable.
- Selecting a room on mobile closes open panels automatically.
- Device list scrolling is contained inside the panel and no longer drags the whole page.

## v3.4.30

Исправлен режим редактирования общего плана: устройства теперь действительно отображаются аккордеоном по комнатам, а не старым плоским списком.


## v3.4.30 — HA Area fallback and edit groups

- В режиме редактирования панель устройств всегда группируется по комнатам, без зависимости от мобильной/desktop версии.
- При редактировании конкретной комнаты её группа открывается сразу, чтобы не надо было раскрывать список вручную.
- Импорт Lovelace теперь дополнительно читает Home Assistant Area/Entity/Device registry через WebSocket API. Если комнату нельзя понять из карточки Lovelace или имени устройства, используется помещение сущности из Home Assistant.
- Для media-вкладок без карточек-комнат это помогает распределять устройства по реальным помещениям HA, а не отправлять их в “Неразмещённые”.


## Kiosk Lock / Auto-lock

В режиме киоска доступна кнопка Lock/Unlock в нижнем углу. В состоянии Lock тапы по устройствам, датчикам и зонам игнорируются, чтобы случайно ничего не включить. В настройках есть Auto-lock: при включении киоск автоматически блокируется после заданного времени бездействия, по умолчанию 15 секунд.

## v3.4.30: Device Picker в режиме редактирования

В режиме редактирования кнопка **Устройства** больше не открывает тяжёлую живую панель поверх карты. Вместо этого открывается отдельное лёгкое окно выбора устройства:

1. Нажать **Устройства**.
2. Выбрать комнату/группу.
3. Выбрать устройство.
4. Тапнуть место на карте.

Такая логика используется одинаково на ПК, телефоне, планшете и в landscape, чтобы не зависеть от определения платформы и не вызывать мерцание/сброс скролла.


## v3.4.30 — Lightweight Edit Mode

В режиме редактирования приложение временно отключает живые обновления HA, glow-анимации, hover/long-press меню, быстрые действия и тяжёлые визуальные состояния маркеров. Редактор становится статичным и лёгким: выбрать устройство можно через Device Picker, затем тапнуть место на карте. После сохранения или отмены live dashboard включается снова.


## v3.4.30 — precise placement and protected sensors

- В редакторе после выбора устройства появляется режим точного размещения с прицелом.
- Для мобильных/landscape сценариев рекомендуется передвинуть план под прицел и нажать **Поставить здесь**.
- Тап по карте остаётся быстрым вариантом, но прицел даёт стабильные координаты при zoom/pan/hardware scale.
- Системные сдвоенные показатели температуры/влажности защищены от окончательного удаления: их можно двигать и сбрасывать позицию.


## v3.4.30 — placement crosshair fix

- Прицел размещения теперь скрывается при выходе из режима редактирования.
- В placement mode карта может двигаться под прицелом по обеим осям в ограниченных пределах.
- Размещение по тапу остаётся выключенным по умолчанию; основной способ — прицел + кнопка “Поставить здесь”.
