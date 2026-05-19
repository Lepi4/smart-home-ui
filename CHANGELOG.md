# ALLHA-2D v5.1.0-beta.2 — CI/package-lock registry hotfix

- package-lock.json resolved tarball URLs changed from the sandbox internal registry to public https://registry.npmjs.org/.
- GitHub Actions GHCR login changed to a retrying docker login shell step to reduce transient ghcr.io timeout failures.
- Version metadata and Service Worker cache updated to v5.1.0-beta.2.

# ALLHA-2D v5.1.0-beta.2 — backup upload safety beta

- Backup upload limit raised to 350 MB for real full backups.
- Backup `.tar.gz/.tgz` import now uses streaming gunzip with output byte accounting and aborts when the decompressed tar exceeds the safety limit.
- Docker builds use `npm ci --omit=dev` with `package-lock.json` for reproducible installs.
- Docker `BUILD_VERSION` updated to `5.1.0-beta.2`.
- Mobile retry button now has `type="button"` and a null-safe handler.
- Service Worker cache updated to `allha2d-v5.1.0-beta.2`.

# ALLHA-2D v5.1.0-beta.2 — backup path hardening + SQLite LIKE cleanup

- Path traversal hardening for `restoreLayoutBackup()` and `deleteLayoutBackup()`: layout backup names no longer allow `/` or `\`, and paths are checked with `pathInside()`.
- SQLite `LIKE` cleanup in `clearProjectDocuments()`: `_`, `%`, and `\` are escaped with explicit `ESCAPE '\\'` to avoid deleting sibling profile/level document rows.
- Version metadata and Service Worker cache updated to `v5.1.0-beta.2`.

# ALLHA-2D v5.1.0-beta.2 — Sonnet audit micro-hotfix

- Added missing null guard in `renderOverviewZones()` for absent `overview-zones` layer.
- Added missing null guards in `openCameraStream()` for camera title/entity labels.
- Fixed `closeAttentionModal()` to call `syncModalOpenClass()` instead of manually removing `modal-open`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.2`.
- FAQ/README/version metadata updated to v5.1.0-beta.2.

## Added

- Backup upload action in Backup Manager for `.tar.gz/.tgz` backups downloaded from ALLHA-2D.
- Uploaded backups are validated, imported into the backup list, and restored only through the normal explicit restore flow.
- Updated screenshots in `docs/screenshots`.
- Full README and FAQ refreshed for v5.1.0-beta.2.

## Fixed

- Added null guards for UI render paths that could crash when a DOM element is absent.
- Fixed modal handling for Attention/FAQ/Diagnostics style flows so modal-open state stays consistent.
- Improved room image onload/onerror handling to avoid stale callbacks during fast room switches.
- Fixed climate slider numeric fallback for `unknown`/invalid Home Assistant values.
- Removed duplicate device-list scroll guard binding.
- Added `type="button"` to generated device-state buttons and StandardSensors modal close button.
- Fixed edit-mode CSS selectors that were broken by newline descendant combinators.
- Added missing CSS variable `--border`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.2`.
- FAQ version now matches v5.1.0-beta.2.
- Removed dead legacy display preference IDs from capture logic.

## Preserved

- v5 HA add-on / Ingress root behavior.
- LAN root registration flow.
- `/client/<slug>` web clients.
- Mobile port `32457`.
- Virtual rooms, StandardSensors, Attention mode, kiosk/mobile/card behavior.

## Docker update commands

```powershell
docker compose down

docker compose build --no-cache

docker compose up -d
```