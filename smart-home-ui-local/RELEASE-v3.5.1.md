# ALLHA-3D v3.5.1 — FAQ restore + image storage foundation

Дата: 2026-05-07

## Что изменено

- В окно настроек добавлена кнопка **FAQ / Помощь** рядом с **Информация / диагностика**.
- Добавлено отдельное модальное окно FAQ с `FAQ.html` внутри интерфейса.
- Сервер при старте создаёт runtime-директории:

```text
/data/images/
/data/images/overview/
/data/images/rooms/
/data/images/originals/
/data/backups/
```

- Сервер создаёт `/data/images/images_meta.json`, если файла ещё нет.
- Добавлены media routes для картинок:

```text
GET /media/overview
GET /media/overview/:filename
GET /media/rooms/:room_id
GET /media/rooms/:room_id/:filename
GET /media/images/overview.webp
GET /media/images/rooms/:room_id.webp
```

- Добавлен API:

```text
GET /api/images
```

- Если пользовательская картинка отсутствует, используется fallback из `public/assets`.
- Overview и комнаты переключены на media routes, чтобы будущие upload/reset работали без изменения frontend-кода.
- Диагностика показывает состояние `/data/images`, `images_meta.json`, overview image и количество custom room images.
- README и FAQ обновлены под v3.5.1.

## Проверка

- `node -c server.js` — OK.
- `node -c public/app.js` — OK.
- Версии обновлены в `package.json` и `config.yaml`.

## Следующий шаг

Рекомендуемый следующий релиз: **v3.5.2 — upload overview + reset image**.
