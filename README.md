# Smart Home UI Local — Home Assistant Add-on

Локальный UI-план квартиры для Home Assistant без Home Assistant frontend внутри приложения.

## Что внутри

- Home Assistant add-on с Ingress.
- Не нужен ввод Home Assistant URL.
- Не нужен long-lived token.
- Подключение к Home Assistant Core идёт через Supervisor API и `SUPERVISOR_TOKEN`.
- Runtime-данные сохраняются в `/data` add-on:
  - `layout.json`
  - `addon_config.json`
  - `source_config.json`
  - `devices.js`
  - `lovelace-source.js`
  - `backups/`

## Важное решение по layout

В обычном режиме есть кнопка **Редактировать**.

В режиме редактирования появляются две кнопки:

- **Сохранить изменения** — создаёт backup и записывает новый layout.
- **Отменить изменения** — откатывает изменения текущей сессии редактирования.

Автосохранения после каждого движения нет.

## Как выгрузить на GitHub

### 1. Создай репозиторий

Например:

```bash
gh repo create smart-home-ui-ha-addon --public --source=. --remote=origin --push
```

Или создай пустой репозиторий через GitHub UI.

### 2. Залей файлы вручную через git

```bash
git init
git add .
git commit -m "Initial Home Assistant add-on"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/smart-home-ui-ha-addon.git
git push -u origin main
```

Перед push замени `YOUR_GITHUB_USERNAME` в:

- `repository.yaml`
- `smart-home-ui-local/config.yaml`

### 3. Добавь репозиторий в Home Assistant

Home Assistant → Settings → Add-ons → Add-on Store → меню ⋮ → Repositories.

Добавь URL своего GitHub-репозитория:

```text
https://github.com/YOUR_GITHUB_USERNAME/smart-home-ui-ha-addon
```

После этого появится add-on **Smart Home UI Local**.

### 4. Установи и запусти add-on

Открой add-on, нажми:

1. Install
2. Start
3. Open Web UI

## Опции add-on

```yaml
pollIntervalMs: 6000
dashboardPaths: []
```

`dashboardPaths` можно оставить пустым и указать панели через настройки UI.

Примеры:

```yaml
dashboardPaths:
  - dashboard-unknown/0
  - dashboard-unknown/1
  - dashboard-unknown/media
```

## Безопасность

Порт наружу не публикуется. Доступ идёт через Home Assistant Ingress.

Не добавляй `ports:` и не запускай этот add-on как открытый LAN-сервис без дополнительной авторизации.
