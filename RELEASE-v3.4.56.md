# ALLHA-3D v3.5.0

Техническая релизная версия.

## Что изменено

- Исправлен `.github/workflows/docker.yml`.
- Убрана битая `sed`-подстановка с управляющим символом.
- Версия в workflow безопасно читается через `awk`.
- При tag `v3.5.0` workflow должен:
  - собрать GHCR images для `amd64` и `aarch64`;
  - опубликовать `ghcr.io/lepi4/smart-home-ui-amd64:3.5.0`;
  - опубликовать `ghcr.io/lepi4/smart-home-ui-aarch64:3.5.0`;
  - создать GitHub Release `ALLHA-3D v3.5.0`;
  - прикрепить release zip.

## Функциональность UI

Новая функциональность не добавлялась. База остаётся от рабочей v3.5.0.
