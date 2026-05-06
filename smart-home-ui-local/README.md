# ALLHA-3D — Home Assistant Add-on

![ALLHA-3D](smart-home-ui-local/public/brand-label.svg)

**ALLHA-3D** — локальный 3D/floor-plan интерфейс управления Home Assistant с картой квартиры, комнатами, устройствами, датчиками, kiosk mode, SVG Layout Editor и безопасным хранением данных вне контейнера.

- **Developer:** Lepi4
- **GitHub:** https://github.com/Lepi4/smart-home-ui
- **Version:** v3.4.51
- **Copyright:** © Lepi4

Репозиторий остаётся прежним: `https://github.com/Lepi4/smart-home-ui`.

## Идея названия

`ALLHA-3D` шифрует личные инициалы/ФИО автора, **HA** как Home Assistant и **3D** как визуальный 3D/floor-plan подход к управлению домом.

## Возможности

- Home Assistant add-on через Ingress.
- Работа без ручного ввода HA URL и long-lived token.
- Supervisor API / `SUPERVISOR_TOKEN`.
- Overview-план квартиры и отдельные картинки комнат.
- Управление устройствами через HA services.
- Touch-first управление: тап, long press, kiosk-friendly UI.
- SVG Layout Editor вместо drag-and-drop.
- Координаты layout только в процентах `0–100`.
- Настройки и данные в `/data`, а не внутри Docker image.
- Backup layout.
- Entity diagnostics.
- Safe/dangerous service calls.
- Kiosk lock/autolock.
- Kiosk Attention Monitor.
- Debug mode для координат.

## Установка в Home Assistant

1. Открой Home Assistant:

```text
Settings → Add-ons → Add-on Store → ⋮ → Repositories
```

2. Добавь репозиторий:

```text
https://github.com/Lepi4/smart-home-ui
```

3. Установи add-on **ALLHA-3D**.
4. Запусти add-on и открой Web UI.

## GHCR images

GitHub Actions публикует образы:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.51
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.51
```

## Структура данных

Пользовательские данные должны храниться в `/data`:

```text
/data/layout.json
/data/addon_config.json
/data/source_config.json
/data/ui_state.json
/data/devices.js
/data/devices.json
/data/lovelace-source.js
/data/lovelace_raw.json
/data/attention_rules.json
/data/images/
/data/backups/
```

Если при удалении add-on в Home Assistant выбрать **не удалять данные**, после повторной установки система должна восстановиться.

## SVG Layout Editor

Drag-and-drop удалён из режима редактирования.

Установка нового устройства:

```text
Редактировать → Устройства → выбрать устройство → SVG Layout Editor → клик/тап по сетке → X/Y или стрелки → Применить
```

Перемещение существующего устройства:

```text
Редактировать → выбрать маркер → долгое удержание → SVG Layout Editor → новая точка → Применить
```

## Kiosk Attention Monitor

В long press меню устройства есть блок **Внимание**. При включении правила текущее состояние сохраняется как нормальное. Если устройство уйдёт из этого состояния, в kiosk mode появляется компактная тревожная кнопка `!`.

Alert глобальный и не зависит от текущей комнаты.

## Lovelace source panel

Рекомендуется отдельная Lovelace-панель с карточками комнат:

```yaml
title: Smart Home UI Source
views:
  - title: Комнаты
    cards:
      - type: entities
        title: Кухня
        entities:
          - entity: light.kitchen_ceiling
            name: Люстра
          - entity: sensor.kitchen_temperature
            name: Температура
```

Приоритет комнаты:

```text
1. Lovelace card / section title
2. имя устройства / entity_id
3. Home Assistant Area
4. Неразмещённые
```

## About

**ALLHA-3D**  
Developer: **Lepi4**  
GitHub: https://github.com/Lepi4/smart-home-ui  
Copyright: © Lepi4


## v3.4.51

- Added “Невидимые зоны”: zones can remain clickable while visually hidden.
- Edit button is hidden outside admin mode.
- Kiosk Attention button is now compact: no button when there are no alerts, “!” when alert is active.


## v3.4.51 — Roles, PIN and dangerous devices

- Panel modes simplified to `viewer`, `control panel`, and `admin`.
- `control panel` can run device actions; dangerous actions require confirmation or PIN if enabled.
- `admin` can mark any entity as dangerous or explicitly make an inherently dangerous entity safe from the long-press device menu.
- PIN is 4 digits and can be changed or reset from Settings.
- Attention rules can be changed only in admin mode.


## v3.4.51 — Zones / UI polish

- Rectangular zones are now edited through the SVG Layout Editor.
- Zones remain rectangles: X/Y move the zone, W changes width, H changes height. Width and height can be changed independently.
- Short tap/click on a zone in edit mode selects it; long press opens the zone editor.
- “Invisible zones” now depends on the main “Zones” checkbox: if Zones are off, zones are not visible and not clickable; if Zones are on and Invisible zones are on, zones stay clickable but are visually hidden outside edit mode.


## v3.4.51 — Zone center positioning and rotation

- Zone coordinates in SVG Layout Editor and live map now use the same center-based X/Y model.
- Rectangular zones can be resized separately by width and height.
- Rectangular zones can be rotated around their center point.
- Zone labels stay upright while the zone rectangle rotates.
- Zones remain rectangles; polygon zones are intentionally not introduced in this step.
