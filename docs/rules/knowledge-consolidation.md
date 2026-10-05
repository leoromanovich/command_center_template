---
id: rules.knowledge-consolidation
title: Консолидация опыта задачи
status: active
summary: Accepted plan завершается только после evidence-backed reflection и явного продвижения устойчивых знаний; environment retro тяжёлой сессии улучшяет среду агента propose-only кандидатами.
verified_at: 2026-10-05
evidence:
  - .opencode/skills/consolidate-task-knowledge/SKILL.md
  - scripts/plans.py
  - templates/task-plan.md
  - templates/knowledge-candidate.md
relations:
  - docs/index.md
  - docs/rules/knowledge-layout.md
  - docs/rules/task-planning.md
  - docs/decisions/0005-evidence-gated-consolidation.md
---

# Консолидация опыта задачи

## Gate

После acceptance checks plan остаётся в `active`. Skill `consolidate-task-knowledge` извлекает кандидатов из наблюдаемых артефактов, проводит отдельный critic-pass и обновляет правильный источник истины. Затем `./cc plan reflect` фиксирует summary, evidence и knowledge delta. Только reviewed reflection разрешает `./cc plan complete`.

Отсутствие устойчивого урока фиксируется как `knowledge delta: none`. Это предпочтительнее выдуманного обобщения.

## Promotion

| Кандидат | Источник истины |
|---|---|
| Build/test/package/run/deploy | Nix output, check или app |
| Идентичность и интерфейс проекта | Catalog descriptor |
| Факт, инвариант, решение, хак, долг | Атомарный узел `docs/` |
| Подробность только этой задачи | Completed plan |
| Непроверенная связь | Локальный candidate inbox |

Канонический узел содержит evidence, scope и прямую связь с project/workflow index. Plan хранит обратную ссылку в `Knowledge delta`, но не дублирует знание; сам узел не ссылается на перемещаемый путь active plan.

## Environment retro

Отдельный проход skill `consolidate-task-knowledge`; адаптация [/retro](https://www.aihero.dev/skills-retro). Ретро меняет среду агента, а не код: по тяжёлой сессии (текущей в контексте или явно указанной записи opencode) предлагает кандидатов улучшений, каждый трассируется к конкретному моменту сессии. Кандидат применяется только после выбора пользователем и проверяется `./cc check`. Гладкая сессия кандидатов не даёт; `none` корректен и здесь.

| Момент сессии | Источник истины |
|---|---|
| Долгий поиск файла или факта | Указатель в `AGENTS.md` или `docs/index.md` |
| Механическое нарушение | Nix check |
| Judgement-call | Правило `docs/rules/` |
| Разросшийся steering, no-op строки | Вынос из `AGENTS.md`, удаление |
| Дорогой tool call | Упростить или заменить инструмент |
| Недостижимая информация | Check или явно запускаемый app |
| Отсутствие guardrail | Отдельный finding |

Граница: consolidation продвигает знания задачи, retro улучшает среду для следующих сессий; порядок severity — черновик, а не вердикт.

## Daydreaming

Подход вдохновлён [LLM Daydreaming](https://gwern.net/ai-daydreaming): генератор сопоставляет тематически удалённые знания, critic оценивает связь. В CC это необязательный режим discovery, а не источник фактов. Любой результат сначала сохраняется в `.control-center-knowledge/candidates/` и требует внешней проверки перед promotion.
