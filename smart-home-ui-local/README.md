# Smart Home UI Local — Home Assistant Add-on

**Smart Home UI Local** — локальная touch-first панель управления Home Assistant с планом квартиры, комнатами, маркерами устройств, датчиками, режимом киоска и безопасным локальным хранением данных в `/data`.

Репозиторий подготовлен под GitHub Container Registry:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.28
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.28
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

## Что умеет текущая версия v3.4.28

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
git commit -m "Update Smart Home UI add-on to v3.4.28"
git push
```

Затем GitHub Actions соберёт images:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.28
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.28
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

## Изменения v3.4.28

- В режиме редактирования общего плана панель устройств теперь сгруппирована по комнатам.
- Одновременно раскрыта только одна группа: открытие второй комнаты автоматически сворачивает предыдущую.
- Добавлена группа «Неразмещённые» для устройств без маркера на общем плане.
- В закрытых группах не рендерятся карточки устройств, поэтому общий план в edit mode меньше нагружает мобильный/landscape UI.
- Сценарий размещения через touch сохранён: открыть комнату в списке → тапнуть устройство → тапнуть место на карте.
- Поиск работает поверх групп и показывает только подходящие комнаты/устройства.

## v3.4.28 — overview edit accordion

This release optimizes overview editing on touch devices and landscape screens. Instead of rendering 180+ device cards at once, the Devices panel shows room groups as an accordion. Only the active group renders its cards, which reduces layout/repaint cost and makes placing devices on the overview map easier.

## Изменения v3.4.28

- В режиме редактирования общего плана список устройств всегда работает как аккордеон по комнатам.
- Закрытые комнаты не рендерят карточки устройств, что снижает нагрузку на мобильных и в landscape.
- Одновременно раскрыта только одна группа; повторный тап закрывает группу.

## v3.4.28 — grouped edit device panel

In edit mode the device panel is now grouped by room on every screen, not only on mobile. Closed room groups do not render device cards, which reduces UI load on large dashboards. The media Lovelace parser also uses `heading` cards as source groups and tries to infer the actual room from the device name, so entries like “Алиса кабинет”, “Алиса гостиная”, or “ТВ гостиная” can be grouped with the corresponding room instead of falling into “Неразмещённые”.


## v3.4.28 — HA Area fallback and edit groups

- В режиме редактирования панель устройств всегда группируется по комнатам, без зависимости от мобильной/desktop версии.
- При редактировании конкретной комнаты её группа открывается сразу, чтобы не надо было раскрывать список вручную.
- Импорт Lovelace теперь дополнительно читает Home Assistant Area/Entity/Device registry через WebSocket API. Если комнату нельзя понять из карточки Lovelace или имени устройства, используется помещение сущности из Home Assistant.
- Для media-вкладок без карточек-комнат это помогает распределять устройства по реальным помещениям HA, а не отправлять их в “Неразмещённые”.


## Kiosk Lock / Auto-lock

В режиме киоска доступна кнопка Lock/Unlock в нижнем углу. В состоянии Lock тапы по устройствам, датчикам и зонам игнорируются, чтобы случайно ничего не включить. В настройках есть Auto-lock: при включении киоск автоматически блокируется после заданного времени бездействия, по умолчанию 15 секунд.

## v3.4.28: Device Picker в режиме редактирования

В режиме редактирования кнопка **Устройства** открывает отдельное окно выбора устройства. После выбора окно закрывается, а устройство ставится на карту следующим тапом. Это заменяет тяжёлую панель устройств поверх карты и работает одинаково на ПК и мобильных.


## v3.4.28 — Lightweight Edit Mode

В режиме редактирования приложение временно отключает живые обновления HA, glow-анимации, hover/long-press меню, быстрые действия и тяжёлые визуальные состояния маркеров. Редактор становится статичным и лёгким: выбрать устройство можно через Device Picker, затем тапнуть место на карте. После сохранения или отмены live dashboard включается снова.

## Изменения v3.4.28

- Исправлена точность размещения устройств в редакторе: tap-to-place теперь считает координаты от фактического прямоугольника изображения, а не от контейнера карты.
- Это особенно важно при zoom/pan, hardwareScale, landscape-режиме и запуске через Home Assistant Ingress/Android WebView.
- Drag существующих маркеров также использует image-space координаты, чтобы маркер оставался там, где его отпустили.


## v3.4.28 — precise placement and protected sensors

- В редакторе после выбора устройства появляется режим точного размещения с прицелом.
- Для мобильных/landscape сценариев рекомендуется передвинуть план под прицел и нажать **Поставить здесь**.
- Тап по карте остаётся быстрым вариантом, но прицел даёт стабильные координаты при zoom/pan/hardware scale.
- Системные сдвоенные показатели температуры/влажности защищены от окончательного удаления: их можно двигать и сбрасывать позицию.
