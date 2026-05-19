# ALLHA-2D — v5.1.0-beta.1

Backup upload safety beta: загрузка backup до 350 MB, streaming gunzip с лимитом распаковки, воспроизводимые Docker-сборки через npm ci.

ALLHA-2D is a 2D dashboard for Home Assistant with floor plans, rooms, devices, standard room sensors, virtual rooms, kiosk/mobile modes, web clients, backups and Home Assistant add-on / Ingress support.

## Main features

- Home Assistant add-on mode through Ingress.
- Local Docker mode for Windows development/testing.
- Direct mobile API on port `32457`.
- Web clients through permanent `/client/<slug>` links.
- Fixed HA add-on/root client context named `Server`.
- Profiles and levels/areas.
- Lovelace/device source import per level.
- Overview map and room maps.
- Device markers, room zones, standard room sensor badges.
- Virtual rooms with automatic device cards and hidden devices per virtual room.
- Kiosk mode, card mode, mobile mode and per-client display settings.
- Attention mode for monitored states and deviations.
- Manual backup manager with create, download, upload, restore and delete actions.

## Access model

- `admin`: full functionality.
- `control`: device control and allowed per-client display/profile settings.
- `viewer`: read-only.

`Server` is the HA add-on / Ingress root client. It is separate from `/client/<slug>` web clients and from mobile devices.

## URL model

- `http://IP:8099/` opens the web-client registration / selection page.
- `http://IP:8099/client/<slug>` opens a specific web client.
- HA add-on Ingress root opens the main UI as the `Server` client.
- `http://IP:32457/` is the mobile entry / mobile API port.

## Backup manager

The Backup section supports:

- create manual backup;
- download backup;
- upload `.tar.gz/.tgz` backup previously downloaded from ALLHA-2D;
- restore full backup with explicit confirmation;
- restore marker/sensor placement backup when applicable;
- delete individual backups;
- delete old backups;
- delete all backups with confirmation.

Backup restore and upload are admin-only. Secrets/tokens/PIN-like fields are redacted during backup creation by key-name masking.

## Standard room sensors

Supported standard room sensor types:

- Temperature;
- Humidity;
- Motion;
- Noise;
- CO2;
- Illuminance.

Standard sensor badges are dynamic: only configured types are displayed. Long-press opens the standard sensor window. The window shows sensor type, value and entity ID. Badge orientation is configurable separately for overview and room views.

## Virtual rooms

A room can be marked as virtual. In a virtual room:

- devices are displayed as cards instead of markers;
- map/card toggle changes only the background/visual mode;
- hidden devices are configured in room settings;
- card size, text size and transparency are per-client display settings.

Manual tile layout, drag/drop tile grid and custom tile sizes are intentionally postponed until after ESP panel work.

## Individual settings

Individual settings are per current client: mobile device, web client or `Server` UI. They do not change other devices. Settings include display scale, opacity, visibility, kiosk/mobile behavior, card settings and client navigation.

## Screenshots

![Overview with standard sensors](docs/screenshots/overview-standard-sensors.png)
![Virtual room in kiosk](docs/screenshots/kiosk-virtual-room.png)
![Room view](docs/screenshots/kiosk-room.png)
![Edit mode](docs/screenshots/edit-mode.png)
![Settings: map and markers](docs/screenshots/map-markers.png)
![Profiles](docs/screenshots/profiles.png)
![Web clients](docs/screenshots/web-clients.png)
![Mobile access](docs/screenshots/mobile-access.png)

## Local Docker update commands

```powershell
docker compose down

docker compose build --no-cache

docker compose up -d
```

## Release hygiene

Release archives must not include:

- `/data`;
- `/data/allha2d.db`;
- `/data/backups`;
- `/data/logs`;
- `config/local-config.json`;
- tokens, PIN, secrets;
- `node_modules`;
- `*.db`, `*.db-wal`, `*.db-shm`.

Debug logging and automatic backups are disabled by default.
