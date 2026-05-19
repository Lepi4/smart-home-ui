# ALLHA-2D FAQ — v5.1.0-beta.2

## Как установить как Home Assistant add-on?
Добавьте репозиторий в Home Assistant Add-on Store, установите add-on `smart-home-ui-local`, запустите его и откройте через Ingress.

## Как открыть локальный Docker?
Распакуйте Docker-архив, перейдите в папку и выполните:

```powershell
docker compose down
docker compose build --no-cache
docker compose up -d
```

## Где открывается web-клиент?
Базовый LAN-адрес `http://IP:8099/` открывает страницу создания/выбора web-клиента. Постоянные панели открываются через `/client/<slug>`.

## Где мобильный доступ?
Мобильный вход работает на порту `32457`. В настройках `Мобильный доступ` создаётся pairing code и QR для APK.

## Где backup?
`Настройки → Backup / архивы`. Там можно создать, скачать, восстановить, удалить и загрузить backup.

## Что такое Server client?
В HA add-on / Ingress основной интерфейс работает как служебный клиент `Server`, не как обычный `/client/<slug>`.

## Что делать после обновления, если UI выглядит старым?
Сделайте Ctrl+F5 или очистите кэш/service worker браузера.
