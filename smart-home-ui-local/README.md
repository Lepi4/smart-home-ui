# Smart Home UI Local

Home Assistant add-on для локального UI-плана квартиры.

- Работает через Home Assistant Ingress.
- Не требует ввода HA URL и long-lived token.
- Использует Supervisor API через `homeassistant_api: true`.
- Layout сохраняется в `/data/layout.json`.
- Перед сохранением layout создаётся backup в `/data/backups`.

## Layout editing

Обычный режим: **Редактировать**.

Режим редактирования: **Сохранить изменения** и **Отменить изменения**.

Изменения не пишутся в `layout.json` после каждого движения. Запись происходит только после явного сохранения.
