---
id: rules.worktrees
title: Топология feature worktrees
status: active
summary: Базовые clones общие для CC и лежат в Projects/repos, а изменяемые repos задачи — в Projects/worktrees/feature/repo_wt.
verified_at: 2026-07-21
evidence:
  - BOOTSTRAP.md
  - scripts/worktrees.py
  - cc
  - templates/control-center.json
  - .opencode/skills/grill-task-planning/SKILL.md
relations:
  - docs/index.md
  - docs/architecture/control-center.md
  - docs/rules/bootstrap.md
  - docs/rules/project-adapters.md
  - docs/rules/task-planning.md
---

# Топология feature worktrees

## Инвариант

```text
Projects/
├── <project>_CC/
├── repos/<repo>/
└── worktrees/<feature>/<repo>_wt/
```

Base checkout нужен для синхронизации и создания worktrees; feature-изменения в нём не ведутся. Одна feature-папка объединяет только изменяемые repos одной задачи.

## Связь с Nix

Feature manifest в `../worktrees/<feature>/` сопоставляет catalog ID, base checkout, worktree, branch и HEAD. CC преобразует manifest в `--override-input <sourceInput> path:<worktree>`. Nix-adapter остаётся тем же, меняется только source.

`./cc feature <feature> check|build|run` передаёт overrides в Nix автоматически.

## Безопасность

Удаление worktree отклоняется при dirty state, неопубликованных commits или несовпадении manifest с Git state. Absolute paths и текущее состояние worktrees не коммитятся в CC.
