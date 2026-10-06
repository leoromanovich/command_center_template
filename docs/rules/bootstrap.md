---
id: rules.bootstrap
title: Bootstrap и миграция Control Center
status: active
summary: Template клонируется вложенным read-only seed, целевой CC создаётся в его родительской папке через evidence-first grilling; состав репозиториев определяют инвентаризация и ./cc repo scan.
verified_at: 2026-10-06
evidence:
  - BOOTSTRAP.md
  - scripts/materialize-template.py
  - scripts/repositories.py
  - .opencode/skills/grill-cc-bootstrap/SKILL.md
relations:
  - docs/index.md
  - docs/architecture/control-center.md
  - docs/decisions/0003-template-as-seed.md
  - docs/decisions/0008-self-contained-cc-topology.md
  - docs/rules/project-adapters.md
  - docs/rules/worktrees.md
---

# Bootstrap и миграция Control Center

## Граница

`cc_template/` — временный источник протокола и файлов. Он не становится submodule или каталогом итогового CC. Materialization копирует только зафиксированные Git-файлы и не перезаписывает непустую цель.

## Режимы

- `new`: безопасная materialization, затем grilling, `./cc repo scan` по существующим клонам в `source_repos/` и последовательный repository onboarding.
- `migration`: read-only inventory, mapping на целевую модель и vertical-slice миграция со сравнением с legacy behavior.

Миграция не оправдывает потерю семантики. Сущность либо сохраняется, либо её замена или удаление фиксируется решением.

## Состояние

`control-center.json` хранит версию схемы, имя, bootstrap status и топологию. `catalog/` хранит по одному descriptor на repository, workflow и benchmark. Пустые catalog-группы держи с `.gitkeep`: Git не трекает пустые папки, а bootstrap-чек валидирует CC из flake-source, где их не будет. Диалог и внутренние рассуждения не сохраняются.

`ready` означает, что descriptors согласованы с Nix-контрактами, а критический workflow проверен. Только после этого `cc_template/` больше не нужен.
