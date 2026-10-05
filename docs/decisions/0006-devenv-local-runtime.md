---
id: decision.0006-devenv-local-runtime
title: Devenv для локального runtime
status: accepted
summary: Полный CLI devenv обслуживает локальные сервисы через CC apps; flake.lock остаётся источником версий.
verified_at: 2026-10-01
evidence:
  - flake.lock
  - nix/devenv/default.nix
  - nix/devenv/runner.py
  - examples/devenv/devenv.nix
  - examples/devenv/verify.py
relations:
  - docs/architecture/control-center.md
  - docs/rules/executable-processes.md
  - docs/rules/worktrees.md
  - docs/projects/index.md
---

# Devenv для локального runtime

## Решение

Полный CLI devenv управляет локальными процессами и интеграционными тестами через явно запускаемые CC apps. Сборки и проверки без runtime side effects остаются derivations. Учебный API потребляет pinned source input; feature manifest подменяет этот input обычным механизмом CC.

## Почему

Локальный стек требует порядка запуска, проверки готовности, выделения портов и остановки процессов. Готовый supervisor сокращает собственную обвязку CC. Интеграция только через flake devShell имеет ограничения lifecycle тестов; для пилота выбран полный CLI.

CLI берётся из закреплённого nixpkgs. Nix assertion требует совпадения hash его исходника с отдельным input модулей devenv. Это предотвращает незаметное расхождение схемы при обновлении зависимости. Сгенерированный runtime-конфиг получает store paths из flake inputs; локальный devenv.lock является производным файлом.

## Границы

- Состояние размещается в ignored `.cc-local/devenv/` и разделяется по feature.
- Каждый тест получает свежую БД; dev-окружение сохраняет свою БД между запусками.
- API и PostgreSQL слушают loopback; пилот предназначен для локальной разработки.
- Runtime acceptance проверяет два настоящих feature worktree, подмену исходников, порты, данные и cleanup.
- Runtime проверен на macOS arm64; для остальных платформ нужен отдельный прогон.
- Production, секреты и управление sibling-репозиториями остаются в соответствующих контрактах CC.

## Пересмотр

При обновлении CLI обновить input модулей и повторить runtime acceptance. При переходе на другой supervisor сохранить те же проверки изоляции и остановки процессов.
