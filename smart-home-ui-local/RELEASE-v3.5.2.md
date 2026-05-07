# ALLHA-3D v3.5.2

Дата: 2026-05-07

## Главное

v3.5.2 реализует следующий плановый шаг Setup from Scratch: загрузку и сброс пользовательской картинки общего плана через UI.

## Изменения

- Добавлен раздел `Настройки → Картинки / План`.
- Добавлена загрузка/замена общего плана через кнопку `Загрузить / заменить общий план`.
- Добавлен сброс общего плана к fallback через кнопку `Сбросить к fallback`.
- Добавлен API `POST /api/images/overview`.
- Добавлен API `DELETE /api/images/overview`.
- `GET /api/images` возвращает metadata актуальной картинки.
- Общий план отдаётся через `/media/images/overview.webp` с fallback на встроенный asset.
- Перед заменой или сбросом создаётся backup текущей картинки, `images_meta.json` и `layout.json`.
- Metadata общего плана сохраняется в `/data/images/images_meta.json`.
- Поддерживаются PNG, JPG/JPEG и WEBP до 25 MB.

## Хранение

```text
/data/images/overview/
/data/images/originals/
/data/images/images_meta.json
/data/backups/
```

## Важно

Если новая картинка имеет другое соотношение сторон, layout не удаляется, но маркеры и зоны могут визуально сместиться относительно нового изображения. Перед заменой создаётся backup.

## Следующий шаг

```text
v3.5.3 — image converter pipeline
```
