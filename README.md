# Smart Home UI Local — Home Assistant add-on

Этот архив подготовлен под репозиторий `https://github.com/Lepi4/smart-home-ui` и GHCR image `ghcr.io/lepi4/smart-home-ui-{arch}`.


Этот вариант рассчитан на установку Home Assistant add-on через готовые Docker images из GitHub Container Registry, а не через локальную сборку на Home Assistant.

## Важно перед загрузкой на GitHub

В файле:

```text
smart-home-ui-local/config.yaml
```

замените `YOUR_GITHUB_USERNAME` на ваш GitHub username:

```yaml
url: https://github.com/Lepi4/smart-home-ui
image: ghcr.io/Lepi4/smart-home-ui-{arch}
```

Например:

```yaml
url: https://github.com/alex/smart-home-ui
image: ghcr.io/alex/smart-home-ui-{arch}
```

## Как загрузить на GitHub

Создайте публичный репозиторий, например:

```text
smart-home-ui
```

Загрузите в корень репозитория содержимое этой папки:

```text
repository.yaml
README.md
.github/
smart-home-ui-local/
```

Через терминал:

```bash
git init
git add .
git commit -m "Initial Home Assistant add-on with GHCR images"
git branch -M main
git remote add origin https://github.com/Lepi4/smart-home-ui.git
git push -u origin main
```

## Как собрать Docker images

После push откройте в GitHub:

```text
Actions → Build and publish Home Assistant add-on images
```

Запустите workflow вручную через `Run workflow`, либо он запустится автоматически после push в `main`.

Будут опубликованы images:

```text
ghcr.io/Lepi4/smart-home-ui-amd64:3.3.1
ghcr.io/Lepi4/smart-home-ui-aarch64:3.3.1
ghcr.io/Lepi4/smart-home-ui-armv7:3.3.1
```

## Если Home Assistant не может скачать image

Откройте на GitHub страницу package и проверьте, что package публичный:

```text
GitHub → ваш профиль → Packages → smart-home-ui-amd64 → Package settings → Change visibility → Public
```

Повторите для `aarch64` и `armv7`, если используете их.

## Как добавить add-on в Home Assistant

В Home Assistant:

```text
Settings → Add-ons → Add-on Store → ⋮ → Repositories
```

Добавьте ссылку:

```text
https://github.com/Lepi4/smart-home-ui
```

После обновления магазина появится add-on:

```text
Smart Home UI Local
```

Установите его, запустите и откройте через `Open Web UI`.

## Проверка структуры репозитория

Правильно:

```text
repository.yaml
README.md
.github/workflows/docker.yml
smart-home-ui-local/config.yaml
smart-home-ui-local/Dockerfile
smart-home-ui-local/server.js
smart-home-ui-local/public/
```

Неправильно:

```text
smart-home-ui-repo/repository.yaml
smart-home-ui-repo/smart-home-ui-local/config.yaml
```

В GitHub не должно быть лишней верхней папки.

## v3.3.6 fix

This version fixes add-on startup errors like:

```text
Error: Cannot find module 'express'
```

The Docker image now verifies `express` and `ws` during build. The runtime `start.sh` also checks dependencies before launching `server.js`.


## v3.3.6 fix

Fixed Home Assistant Supervisor Core API paths: the add-on now calls `/states`, `/services/...`, and `/` relative to `http://supervisor/core/api` instead of accidentally calling `/api/states` and receiving 404.
