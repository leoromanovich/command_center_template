---
id: rules.bootstrap
title: Bootstrap и миграция Control Center
status: active
summary: Template клонируется вложенным read-only seed, а целевой CC создаётся в его родительской папке через evidence-first grilling.
verified_at: 2026-07-21
evidence:
  - BOOTSTRAP.md
  - scripts/materialize-template.py
  - .opencode/skills/grill-cc-bootstrap/SKILL.md
relations:
  - docs/index.md
  - docs/architecture/control-center.md
  - docs/decisions/0003-template-as-seed.md
  - docs/rules/project-adapters.md
  - docs/rules/worktrees.md
---

# Bootstrap и миграция Control Center

## Граница

`cc_template/` — временный источник протокола и файлов. Он не становится submodule или каталогом итогового CC. Materialization копирует только зафиксированные Git-файлы и не перезаписывает непустую цель.

## Режимы

- `new`: безопасная materialization, затем grilling и последовательный repository onboarding.
- `migration`: read-only inventory, mapping на целевую модель и vertical-slice миграция со сравнением с legacy behavior.

Миграция не оправдывает потерю семантики. Сущность либо сохраняется, либо её замена или удаление фиксируется решением.

## Состояние

`control-center.json` хранит версию схемы, имя, bootstrap status и топологию. `catalog/` хранит по одному descriptor на repository, workflow и benchmark. Диалог и внутренние рассуждения не сохраняются.

`ready` означает, что descriptors согласованы с Nix-контрактами, а критический workflow проверен. Только после этого `cc_template/` больше не нужен.
