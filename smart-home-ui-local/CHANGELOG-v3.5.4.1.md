# CHANGELOG v3.5.4.1

## Исправлено

- Исправлена повторная загрузка той же картинки комнаты: file input очищается до запуска upload, поэтому выбор того же файла повторно снова вызывает замену.
- Исправлено обновление открытой комнаты после upload/reset room image.
- Room view теперь берёт картинку из `/api/images` / `/media/images/rooms/<room_id>.webp`, а не только из статического `config.js`.
- Исправлен reset room image: удаляется custom-картинка комнаты, обновляется `images_meta.json`, создаётся backup, UI получает cache-busted URL.
- Добавлен cache token для overview и room images, чтобы браузер не показывал старую картинку после замены/сброса.
- Media routes теперь отправляют `no-store/no-cache` headers.

## Изменено

- Fallback теперь означает нейтральную пустую SVG-заглушку, а не встроенную demo-картинку квартиры.
- Demo-картинки планов/комнат удалены из `public/assets` дистрибутива.
- Пользовательские картинки остаются только в `/data/images`.

## Проверка

- `node -c server.js` — OK
- `node -c public/app.js` — OK
- `unzip -t` — OK
