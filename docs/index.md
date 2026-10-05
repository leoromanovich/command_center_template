---
id: index
title: Карта знаний Control Center
status: active
summary: Минимальная точка входа в правила, архитектуру и историю решений.
verified_at: 2026-07-21
evidence:
  - AGENTS.md
relations:
  - docs/architecture/control-center.md
  - docs/rules/bootstrap.md
  - docs/rules/executable-processes.md
  - docs/rules/knowledge-layout.md
  - docs/rules/knowledge-consolidation.md
  - docs/rules/project-adapters.md
  - docs/rules/task-planning.md
  - docs/rules/worktrees.md
---

# Карта знаний

## Обязательные правила

- [Bootstrap и миграция](rules/bootstrap.md)
- [Исполняемые процессы](rules/executable-processes.md)
- [Укладка Markdown-знаний](rules/knowledge-layout.md)
- [Консолидация опыта задачи](rules/knowledge-consolidation.md)
- [Подключение sibling-проектов](rules/project-adapters.md)
- [Планирование агентных задач](rules/task-planning.md)
- [Топология worktrees](rules/worktrees.md)

## Архитектура

- [Границы Control Center](architecture/control-center.md)

## Решения

- [Nix как формат исполняемых знаний](decisions/0001-nix-executable-knowledge.md)
- [Атомарные связанные заметки](decisions/0002-atomic-linked-notes.md)
- [Template как временный seed](decisions/0003-template-as-seed.md)
- [Lifecycle планов](decisions/0004-plan-lifecycle.md)
- [Evidence-gated консолидация](decisions/0005-evidence-gated-consolidation.md)
- [Вендоренный loopeng как execution engine](decisions/0007-loopeng-execution-engine.md)

## Текущий контекст

- [Технический долг](debt/index.md)
- [Хаки](hacks/index.md)
- [Проекты](projects/index.md)
- [Глоссарий](glossary/index.md)
