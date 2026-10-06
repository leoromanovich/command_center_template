---
id: rules.worktrees
title: Топология feature worktrees
status: active
summary: Базовые clones и feature worktrees лежат внутри корня CC в gitignored source_repos и wt/feature/repo_wt; manifest хранит пути относительно корня CC.
verified_at: 2026-10-06
evidence:
  - BOOTSTRAP.md
  - scripts/worktrees.py
  - cc
  - templates/control-center.json
  - .opencode/skills/grill-task-planning/SKILL.md
relations:
  - docs/index.md
  - docs/architecture/control-center.md
  - docs/decisions/0008-self-contained-cc-topology.md
  - docs/rules/bootstrap.md
  - docs/rules/project-adapters.md
  - docs/rules/task-planning.md
---

# Топология feature worktrees

## Инвариант

```text
<cc_root>/
├── source_repos/<repo>/
└── wt/<feature>/<repo>_wt/
```

Base checkout нужен для синхронизации и создания worktrees; feature-изменения в нём не ведутся. Одна feature-папка объединяет только изменяемые repos одной задачи. Оба каталога gitignored: клоны не входят в Git-историю и flake-source CC (см. decision 0008).

## Связь с Nix

Feature manifest в `wt/<feature>/` сопоставляет catalog ID, base checkout, worktree, branch и HEAD; пути хранятся относительно корня CC. CC преобразует manifest в `--override-input <sourceInput> path:<worktree>`. Nix-adapter остаётся тем же, меняется только source.

`./cc feature <feature> check|build|run` передаёт overrides в Nix автоматически.

## Безопасность

Удаление worktree отклоняется при dirty state, неопубликованных commits или несовпадении manifest с Git state. Absolute paths и текущее состояние worktrees не коммитятся в CC.
