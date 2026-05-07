# ALLHA-3D v3.5.1.1 — FAQ scroll + Images storage diagnostics hotfix

Дата: 2026-05-07

## Что исправлено

- FAQ modal из настроек получил стабильный вертикальный скролл.
- Touch scroll внутри FAQ больше не блокируется глобальным обработчиком `touchmove`.
- В диагностике добавлен явный раздел `Images storage`, чтобы состояние `/data/images` было видно не как отдельные строки, а как отдельный блок.
- Диагностика теперь показывает подпапки `/data/images/overview`, `/data/images/rooms`, `/data/images/originals`, `/data/backups`, состояние overview fallback/custom, количество room images и `images_meta.json`.

## Следующий плановый шаг

`v3.5.2 — upload overview + reset image`.
