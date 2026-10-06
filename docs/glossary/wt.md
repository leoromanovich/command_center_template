---
id: glossary.wt
title: wt — worktree
status: active
summary: wt — единая аббревиатура worktree в этом CC; покрывает корневую папку wt/<feature>/<repo>_wt opencode-контракта и вложенную loopeng/wt/<task>/<repo> движка loopeng.
verified_at: 2026-10-06
evidence:
  - loopeng/cc.config.json
  - loopeng/runtime/core/lib/controller.mjs
  - templates/control-center.json
  - scripts/worktrees.py
relations:
  - docs/glossary/index.md
  - docs/rules/worktrees.md
  - docs/decisions/0007-loopeng-execution-engine.md
  - docs/decisions/0008-self-contained-cc-topology.md
---

# wt — worktree

## Определение

`wt` — стандартное сокращение «worktree» (Git worktree) в этом репозитории. Встречается в двух формах:

- `wt/<feature>/<repo>_wt/` в корне CC — feature worktrees opencode-контракта (`worktrees` в `templates/control-center.json`); создаются через `./cc worktree`; папка gitignored.
- `loopeng/wt/<task>/<repo>` — worktree-родитель движка loopeng (`worktreeParent` в `loopeng/cc.config.json`); feature-работа агентных циклов Pi идёт здесь.

Обе формы — изолированные изменяемые checkout от общей базы; base checkout остаётся чистым.

## Не путать с

- `source_repos/<repo>/` — базовые clones для синхронизации и создания worktrees, не место feature-изменений; gitignored.
- Историческое sibling-расположение worktrees снаружи корня CC — прежняя топология до decision 0008; встретить её можно только в старых снапшотах и завершённых планах.
- Историческое `WorkTree/` — прежнее имя папки loopeng до переименования в `wt`.

## Границы применимости

Термин описывает топологию этого CC и его sibling-проектов; на чужие репозитории и документацию loopeng upstream не переносится. Правила создания, проверки и удаления worktrees задают `docs/rules/worktrees.md` (CC) и `loopeng/AGENTS.md` (движок); заметка фиксирует только значение аббревиатуры.
