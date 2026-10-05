---
id: glossary.wt
title: wt — worktree
status: active
summary: wt — единая аббревиатура worktree в этом CC; покрывает папку wt/<task>/<repo> движка loopeng и суффикс <repo>_wt в контракте opencode-фич.
verified_at: 2026-10-05
evidence:
  - loopeng/cc.config.json
  - loopeng/runtime/core/lib/controller.mjs
  - templates/control-center.json
  - scripts/worktrees.py
relations:
  - docs/glossary/index.md
  - docs/rules/worktrees.md
  - docs/decisions/0007-loopeng-execution-engine.md
---

# wt — worktree

## Определение

`wt` — стандартное сокращение «worktree» (Git worktree) в этом репозитории. Встречается в двух формах:

- `loopeng/wt/<task>/<repo>` — worktree-родитель движка loopeng (`worktreeParent` в `loopeng/cc.config.json`); feature-работа агентных циклов Pi идёт здесь.
- `../worktrees/<feature>/<repo>_wt/` — feature worktrees opencode-контракта CC (`worktreePattern` в `templates/control-center.json`); создаются через `./cc worktree`.

Обе формы — изолированные изменяемые checkout от общей базы; base checkout остаётся чистым.

## Не путать с

- `../repos/<repo>/` — базовые clones для синхронизации и создания worktrees, не место feature-изменений.
- `../worktrees/` (без `_wt`) — корневая папка feature-worktrees CC, а не worktree сам по себе.
- Историческое `WorkTree/` — прежнее имя папки loopeng до переименования в `wt`; встретить его можно только в старых снапшотах и backup.

## Границы применимости

Термин описывает топологию этого CC и его sibling-проектов; на чужие репозитории и документацию loopeng upstream не переносится. Правила создания, проверки и удаления worktrees задают `docs/rules/worktrees.md` (CC) и `loopeng/AGENTS.md` (движок); заметка фиксирует только значение аббревиатуры.
