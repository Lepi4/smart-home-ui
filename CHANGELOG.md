# ALLHA-2D v5.2.3 — image upload level-bleed hotfix

## Fixed

- `POST/DELETE /api/images/overview` and `POST/DELETE /api/images/rooms/:room_id` called `activateProfileLevelForCurrentServer(profileId, levelId)`, which **permanently** rewrites the persisted `activeLevelId` in `levels.json` (and the in-memory globals) to whatever level the upload/delete targeted, with no restore afterward. Any other request that falls back to that global (rather than a per-client preference) would keep resolving to the last-uploaded-to level indefinitely, until the user happened to explicitly reactivate a different level again. Reported symptom: uploading an overview image for one floor caused a different floor (that was never touched) to display that same image.
- Fixed by replacing the permanent activation with the existing `withTemporaryLevel(profileId, levelId, fn)` helper (already used correctly by the `/media/*` static handler and `GET /api/images`), which resolves the correct level for the duration of the request only and restores the previous global state afterward - matching the read-path fix from 5.2.2 instead of fighting it.
- Verified against a live container under real concurrency (parallel activate + upload + background polling requests): each level now reliably keeps its own distinct overview image after the fix, where it previously bled across levels.
- Note: this fix stops *future* corruption; overview images already overwritten by the bug before upgrading need to be re-uploaded once per affected level.
- Version metadata (`config.yaml`, `package.json`, `Dockerfile`, `Dockerfile.local`) updated to `5.2.3`.

# ALLHA-2D v5.2.2 — level switch client-context hotfix

## Fixed

- `POST /api/levels/:id/activate` persisted the newly activated level only into the `web_client_settings` store keyed by the `x-client-id` header, via a hand-rolled `getClientPrefs`/`saveClientPrefs` pair. The HA add-on / Ingress root client ("Server" identity) is not a `web_client` and is never addressed by that header — its active-level preference lives in `data/client_settings/server_ui.json`, which the route never touched. As a result, every data-reading endpoint (`/api/rooms`, `/api/layout`, `/api/images`, ...) kept resolving the level through the stale `server_ui.json` value forever, regardless of which level was actually activated — rooms and images always showed whichever level was last active before the bug was hit, identical across all levels/floors.
- Fixed by persisting the new active level through `saveCurrentClientSettings(req, ...)`, the same identity-aware function `getCurrentClientSettings()` reads from (mobile device / web client / Server-ui.json), in addition to the existing header-based web-client write.
- Version metadata (`config.yaml`, `package.json`, `Dockerfile`, `Dockerfile.local`) updated to `5.2.2`.

# ALLHA-2D v5.2.1 — level switch persistence hotfix

## Fixed

- `POST /api/levels/:id/activate` wrapped `activateLevel()` in `withTemporaryLevel()`, whose `finally` block restored the previous `ACTIVE_LEVEL_ID`/`ACTIVE_LEVEL_DIR` right after the call. The new active level was correctly persisted to disk, but the live server state was immediately rolled back, so every subsequent request kept serving the old level's rooms/devices until a full server restart — in multi-level setups (e.g. floor 1 / floor 2 / outside) switching levels in the web UI appeared to do nothing, always showing whichever level was active at server start.
- Fixed by re-syncing live globals with `updateActiveProfilePaths()` right after the wrapped `activateLevel()` call, so the just-persisted level switch actually takes effect without requiring a restart.
- Version metadata (`config.yaml`, `package.json`, `Dockerfile`, `Dockerfile.local`) updated to `5.2.1`.

# ALLHA-2D v5.1.0-beta.3 — CI/package-lock registry hotfix

- package-lock.json resolved tarball URLs changed from the sandbox internal registry to public https://registry.npmjs.org/.
- GitHub Actions GHCR login changed to a retrying docker login shell step to reduce transient ghcr.io timeout failures.
- Version metadata and Service Worker cache updated to v5.1.0-beta.3.

# ALLHA-2D v5.1.0-beta.3 — backup upload safety beta

- Backup upload limit raised to 350 MB for real full backups.
- Backup `.tar.gz/.tgz` import now uses streaming gunzip with output byte accounting and aborts when the decompressed tar exceeds the safety limit.
- Docker builds use `npm ci --omit=dev` with `package-lock.json` for reproducible installs.
- Docker `BUILD_VERSION` updated to `5.1.0-beta.3`.
- Mobile retry button now has `type="button"` and a null-safe handler.
- Service Worker cache updated to `allha2d-v5.1.0-beta.3`.

# ALLHA-2D v5.1.0-beta.3 — backup path hardening + SQLite LIKE cleanup

- Path traversal hardening for `restoreLayoutBackup()` and `deleteLayoutBackup()`: layout backup names no longer allow `/` or `\`, and paths are checked with `pathInside()`.
- SQLite `LIKE` cleanup in `clearProjectDocuments()`: `_`, `%`, and `\` are escaped with explicit `ESCAPE '\\'` to avoid deleting sibling profile/level document rows.
- Version metadata and Service Worker cache updated to `v5.1.0-beta.3`.

# ALLHA-2D v5.1.0-beta.3 — Sonnet audit micro-hotfix

- Added missing null guard in `renderOverviewZones()` for absent `overview-zones` layer.
- Added missing null guards in `openCameraStream()` for camera title/entity labels.
- Fixed `closeAttentionModal()` to call `syncModalOpenClass()` instead of manually removing `modal-open`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.3`.
- FAQ/README/version metadata updated to v5.1.0-beta.3.

## Added

- Backup upload action in Backup Manager for `.tar.gz/.tgz` backups downloaded from ALLHA-2D.
- Uploaded backups are validated, imported into the backup list, and restored only through the normal explicit restore flow.
- Updated screenshots in `docs/screenshots`.
- Full README and FAQ refreshed for v5.1.0-beta.3.

## Fixed

- Added null guards for UI render paths that could crash when a DOM element is absent.
- Fixed modal handling for Attention/FAQ/Diagnostics style flows so modal-open state stays consistent.
- Improved room image onload/onerror handling to avoid stale callbacks during fast room switches.
- Fixed climate slider numeric fallback for `unknown`/invalid Home Assistant values.
- Removed duplicate device-list scroll guard binding.
- Added `type="button"` to generated device-state buttons and StandardSensors modal close button.
- Fixed edit-mode CSS selectors that were broken by newline descendant combinators.
- Added missing CSS variable `--border`.
- Updated Service Worker cache name to `allha2d-v5.1.0-beta.3`.
- FAQ version now matches v5.1.0-beta.3.
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