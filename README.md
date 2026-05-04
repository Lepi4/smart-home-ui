# Smart Home UI Local — Home Assistant add-on

Репозиторий подготовлен под `https://github.com/Lepi4/smart-home-ui` и GHCR images:

```text
ghcr.io/lepi4/smart-home-ui-amd64:3.4.2
ghcr.io/lepi4/smart-home-ui-aarch64:3.4.2
```

Этот вариант рассчитан на установку Home Assistant add-on через готовые Docker images из GitHub Container Registry.

## Что нового в v3.4.2

- Нормализовано хранение runtime-данных в `/data`.
- Добавлен `/data/ui_state.json`: последний вид, скрытые панели, kiosk mode, масштаб и pan.
- После удаления/переустановки add-on без удаления данных система должна восстановиться в рабочем виде.
- Импортированные `devices.js` и `lovelace-source.js` теперь пишутся в `/data`, а `public/` используется только как fallback.
- Добавлен kiosk mode: скрывает панели и оставляет только план/комнату.
- Добавлены настройки масштаба и прозрачности маркеров/датчиков.
- Добавлены `icon.png` и `logo.png` для add-on.
- FAQ обновлён под v3.4.2.

## Как загрузить на GitHub

В корне репозитория должны лежать:

```text
repository.yaml
README.md
.github/workflows/docker.yml
smart-home-ui-local/
```

Через терминал:

```bash
git add .
git commit -m "Update Smart Home UI add-on to v3.4.2"
git push
```

## Как собрать Docker images

После push откройте в GitHub:

```text
Actions → Build and publish Home Assistant add-on images
```

Запустите workflow через `Run workflow`, либо дождитесь автоматического запуска после push в `main`.

## Как добавить add-on в Home Assistant

```text
Settings → Add-ons → Add-on Store → ⋮ → Repositories
```

Добавьте:

```text
https://github.com/Lepi4/smart-home-ui
```

После обновления магазина установите/обновите add-on **Smart Home UI Local**.

## Важно про данные

При удалении add-on Home Assistant спросит, удалять ли данные. Если выбрать **не удалять данные**, то после установки заново сохранятся:

```text
/data/layout.json
/data/backups/
/data/addon_config.json
/data/source_config.json
/data/ui_state.json
/data/devices.js
/data/lovelace-source.js
```
