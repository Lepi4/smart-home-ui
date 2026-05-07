# CHANGELOG — ALLHA-3D v3.5.4

## Главное

Реализована загрузка, замена и сброс пользовательских картинок найденных комнат.

## Добавлено

- Раздел **Настройки → Картинки / План → Картинки найденных комнат**.
- Список найденных комнат с отдельными действиями для каждой комнаты.
- Кнопка **Загрузить / заменить** для картинки комнаты.
- Кнопка **Сбросить к fallback** для картинки комнаты.
- API:
  - `POST /api/images/rooms/:room_id`
  - `DELETE /api/images/rooms/:room_id`
- Сохранение рабочих room images в `/data/images/rooms/<room_id>.webp`.
- Сохранение оригиналов в `/data/images/originals/rooms/<room_id>-original.<ext>`.
- Обновление `images_meta.json` для каждой комнаты.
- Backup перед заменой/сбросом картинки комнаты:
  - текущая room image;
  - `images_meta.json`;
  - `layout.json`.
- Обновление открытой комнаты после загрузки или сброса её картинки.
- Диагностика подпапки `/data/images/originals/rooms`.

## Сохранено

- Комнаты не создаются вручную.
- Layout, markers, zones, devices, security/PIN и attention rules не удаляются при сбросе картинки.
- Обработка upload продолжает использовать pipeline v3.5.3: PNG/JPG/WEBP, лимит 25 MB на один файл, WebP через `sharp`, сохранение aspect ratio.

## Документация

- Обновлены README/FAQ/FAQ.html.
- Changelog добавлен в архив.
- Roadmap/next steps публикуется отдельным md-файлом вне архива.
