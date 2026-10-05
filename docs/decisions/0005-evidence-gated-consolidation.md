---
id: decision.0005-evidence-gated-consolidation
title: Evidence-gated консолидация опыта
status: accepted
summary: Completion плана требует отдельной проверки извлечённых уроков; daydreaming не пишет напрямую в каноническую базу.
verified_at: 2026-07-21
evidence:
  - scripts/plans.py
  - .opencode/skills/consolidate-task-knowledge/SKILL.md
relations:
  - docs/index.md
  - docs/decisions/0002-atomic-linked-notes.md
  - docs/decisions/0004-plan-lifecycle.md
  - docs/rules/knowledge-consolidation.md
---

# Evidence-gated консолидация опыта

## Контекст

Реализация создаёт опыт, которого не было при planning: ошибочные предположения, реальные границы, failure modes и дешёвые способы проверки. Автоматическая запись self-reflection в канон превращает правдоподобные догадки модели в ложные факты.

## Решение

Разделить generator и critic. Сначала формировать локальные кандидаты, затем проверять evidence, применимость, дубликаты и противоречия. Продвигать только подтверждённый результат в catalog, Nix или атомарные docs. `plan complete` требует reviewed reflection, но допускает пустой knowledge delta.

Daydreaming использует тот же candidate boundary и никогда не получает прямого write-доступа к канону.

## Рассмотренные варианты

- Сохранять полную стенограмму: много шума, секретов и непроверяемых рассуждений.
- Позволять модели сразу редактировать docs: быстро, но создаёт self-reinforcing ошибки.
- Не делать retrospective: теряется опыт, который нельзя восстановить из финального diff.

## Последствия

- Completion требует дополнительного короткого прохода.
- База растёт медленнее, но каждый узел имеет provenance.
- Спекулятивный поиск можно масштабировать независимо от канонической памяти.

## Условие пересмотра

Пересмотреть gate, если измерения покажут, что он не улучшает следующие задачи либо создаёт несоразмерную стоимость.
