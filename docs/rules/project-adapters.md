---
id: rules.project-adapters
title: Подключение sibling-проектов
status: active
summary: Каждый внешний репозиторий подключается catalog descriptor, pinned source и Nix-адаптером с packages, checks и apps.
verified_at: 2026-07-21
evidence:
  - scripts/repositories.py
  - nix/projects/default.nix
  - templates/project.nix
  - examples/cpp-docker-e2e/projects.nix
relations:
  - docs/architecture/control-center.md
  - docs/rules/executable-processes.md
  - docs/projects/index.md
---

# Подключение sibling-проектов

## Контракт проекта

`catalog/repositories/<id>.json` фиксирует remote, default branch, роль, flake input, adapter и onboarding status. Descriptor создаётся `./cc repo add`; команды сборки в него не пишутся.

Адаптер создаётся через `ccLib.mkProject` и объявляет:

- `src` — pinned flake input или локальный source override;
- `packages` — артефакты проекта;
- `checks` — сборки и тесты;
- `apps` — запуск, генерация, внешние интеграции;
- `metadata` — роль и владелец.

Удалённый source фиксируется в `flake.lock`. Локальная разработка не меняет контракт: тот же input временно переопределяется на `path:../repo`.

## Граница ответственности

Project adapter знает, как получить проверяемые outputs одного репозитория. Workflow знает, как связать outputs нескольких проектов. Логика сборки проекта не дублируется в workflow.

## Drift

Если upstream меняет структуру, зависимости или тестовый интерфейс, ломается adapter/check. Исправление вносится туда, а не маскируется обновлением Markdown.
