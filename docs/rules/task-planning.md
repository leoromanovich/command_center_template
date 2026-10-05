---
id: rules.task-planning
title: Планирование задач для агентов
status: active
summary: Grilling превращает неясную задачу в evidence-backed план с непересекающимися work packages и проверяемой приёмкой.
verified_at: 2026-07-21
evidence:
  - .opencode/skills/_shared/grilling-core.md
  - .opencode/skills/grill-task-planning/SKILL.md
  - scripts/plans.py
  - templates/task-plan.md
relations:
  - docs/index.md
  - docs/decisions/0004-plan-lifecycle.md
  - docs/rules/knowledge-layout.md
  - docs/rules/knowledge-consolidation.md
  - docs/rules/worktrees.md
  - docs/glossary/index.md
---

# Планирование задач для агентов

## Граница плана

Task-plan хранит цель, объём, неизвестные, граф работ и приёмку одной задачи. Он не заменяет catalog, Nix-контракт и долгоживущие docs.

План фиксируется только если он нужен между сессиями или агентами. Текущий план живёт в `plans/active/`; после решения не выполнять переносится в `plans/archived/`, после доказанного выполнения — в `plans/completed/`. Полезные в будущем решения, термины, хаки и долг живут отдельно.

## Lifecycle

- `./cc plan create` создаёт active plan из template.
- `./cc plan accept` фиксирует явное согласование до implementation.
- `./cc plan archive` требует причину отказа.
- `./cc plan reflect` фиксирует evidence-backed retrospective и knowledge delta.
- `./cc plan complete` требует accepted plan, reviewed reflection и evidence приёмки.
- Копии одного plan ID в нескольких states запрещены.

## Агентный граф

Каждый work package имеет один outcome, точную write scope, inputs, outputs, dependencies и completion check. Параллельные packages не изменяют одни и те же файлы или interfaces. Integration и final verification следуют после component work.

План готов, когда агент без доступа к grilling может однозначно выбрать worktree, границы изменения, проверку и stop condition.
