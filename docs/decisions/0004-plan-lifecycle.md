---
id: decision.0004-plan-lifecycle
title: Lifecycle планов
status: accepted
summary: Каждый task-plan существует ровно в одном состоянии active, archived или completed.
verified_at: 2026-07-21
evidence:
  - scripts/plans.py
  - plans/active/.gitkeep
  - plans/archived/.gitkeep
  - plans/completed/.gitkeep
relations:
  - docs/index.md
  - docs/rules/task-planning.md
---

# Lifecycle планов

## Контекст

Текущие, отменённые и выполненные планы нужны для разных задач: координации работы, объяснения отказа и проверки фактического результата.

## Решение

- `plans/active/` хранит текущие планы.
- `plans/archived/` хранит планы, которые решили не выполнять, с причиной.
- `plans/completed/` хранит выполненные планы с evidence приёмки.

Переход перемещает, а не копирует файл. Повторный plan ID в другом state считается ошибкой. В `completed` попадает только явно accepted plan.

## Последствия

История решения сохраняется, но `active` остаётся картой только текущей работы. Долгоживущие знания всё равно выносятся в ADR, glossary, hacks и debt.
