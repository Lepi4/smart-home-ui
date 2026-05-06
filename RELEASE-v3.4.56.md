# ALLHA-3D v3.4.56

Техническая релизная версия.

## Что изменено

- Исправлен `.github/workflows/docker.yml`.
- Убрана битая `sed`-подстановка с управляющим символом.
- Версия в workflow безопасно читается через `awk`.
- При tag `v3.4.56` workflow должен:
  - собрать GHCR images для `amd64` и `aarch64`;
  - опубликовать `ghcr.io/lepi4/smart-home-ui-amd64:3.4.56`;
  - опубликовать `ghcr.io/lepi4/smart-home-ui-aarch64:3.4.56`;
  - создать GitHub Release `ALLHA-3D v3.4.56`;
  - прикрепить release zip.

## Функциональность UI

Новая функциональность не добавлялась. База остаётся от рабочей v3.4.55.
