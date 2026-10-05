---
name: consolidate-task-knowledge
description: Consolidate evidence from an implemented, accepted Control Center task before plan completion, and run session retro to improve the agent environment. Use after acceptance checks pass, when reviewing deviations, failures, discoveries, decisions, benchmarks, reusable lessons, or a hard session; promote only verified durable knowledge into catalog, Nix contracts, or linked docs, propose only environment fixes traceable to specific session moments, and keep speculative daydreaming candidates outside the canonical knowledge base.
---

# Consolidate task knowledge

Сначала прочитай полностью `../_shared/grilling-core.md`, active plan и `docs/rules/knowledge-consolidation.md`. Не завершай plan до этого прохода.

## Собери evidence

Используй только наблюдаемые артефакты: принятый plan; commits и diff затронутых worktrees; результаты checks и benchmarks; отклонения от плана; ошибки и подтверждённые причины; решения пользователя. Не сохраняй стенограмму, chain-of-thought и неподтверждённую причинность.

Если acceptance checks не прошли, верни задачу в implementation. Reflection не заменяет проверку результата.

## Сформируй кандидатов

Для каждого потенциального урока зафиксируй один claim по `templates/knowledge-candidate.md` в `.control-center-knowledge/candidates/<task-id>/`. Укажи scope, evidence, границы применимости, возможное опровержение и предполагаемый источник истины.

Не создавай кандидата ради обязательного результата. `knowledge delta: none` корректен.

## Проведи critic-pass

Проверь кандидатов свежим проходом, отделённым от генерации:

1. Evidence действительно подтверждает claim, а не только коррелирует с ним.
2. Урок применим повторно и сформулирован не шире evidence.
3. Он не выводится быстро из кода и не дублирует существующий узел.
4. Он не противоречит catalog, Nix, active docs и результатам проверок.
5. Известны контрпример, срок актуальности или условие пересмотра.

Отклонённый или спекулятивный кандидат оставь локальным. Не ослабляй формулировку до бессодержательной ради promotion.

## Продвинь знание

- Build, test, package, run или deploy — измени Nix output/check/app.
- Remote, роль, ownership или interface проекта — измени catalog descriptor.
- Устойчивый факт, инвариант, решение, хак или долг — создай либо обнови атомарный узел в `docs/`.
- Task-local подробность — оставь в retrospective плана.
- Непроверенная связь — оставь в candidate inbox.

Свяжи новое знание с project/workflow index. Provenance до исходного plan хранит его `Knowledge delta`, потому что путь active plan изменится при completion. Заменяемый узел пометь `superseded`, а не переписывай историю молча.

## Зафиксируй reflection

После promotion выполни один из вариантов:

```bash
./cc plan reflect <task-id> \
  --summary "<reusable conclusion>" \
  --evidence "<check, benchmark, commit or path>" \
  --knowledge docs/path/to/note.md

./cc plan reflect <task-id> \
  --summary "No durable reusable knowledge discovered" \
  --evidence "<acceptance evidence>" \
  --no-knowledge-delta
```

Затем запусти `./cc check` и только после успеха — `./cc plan complete`.

## Environment retro

Ретро меняет среду агента, а не код задачи. Запускай его в составе plan-прохода или по явному запросу после тяжёлой сессии, в том числе без active plan. Вход — текущая сессия в контексте либо явно указанная запись сессии opencode.

Ищи моменты, где агент мучился: долго искал файл или факт; допустил ошибку, которую поймал бы инструмент; сделал дорогой для результата tool call; не смог получить нужную информацию; повторил прежнюю ошибку. Гладкая сессия ничего не даёт — не выдумывай кандидатов.

Каждый кандидат обязан ссылаться на конкретный момент сессии; непрослеживаемый кандидат отбрасывается. Порядок severity — черновик, а не вердикт. Кандидат — только предложение: ничего не меняй, пока пользователь не выбрал. После выбора примени правку в источник истины и запусти `./cc check`.

| Момент сессии | Источник истины CC |
|---|---|
| Долго искал файл или факт | Навигационный указатель из файла, который агент уже читает: `AGENTS.md`, `docs/index.md` |
| Механическое нарушение: запрещённый API, форма импорта, расположение файла | Детерминированный Nix check; проза не заменяет падающую проверку |
| Judgement-call ошибка, которую не ловит проверка | Правило в `docs/rules/<тема>.md` |
| Разросшийся `AGENTS.md` | Вынести steering в `docs/rules` или check; оставить только указатели |
| No-op строки в steering | Кандидат на удаление по этой сессии |
| Дорогой для результата tool call | Упростить или заменить инструмент |
| Нужная информация недостижима | Расширить доступ через check или явно запускаемый app в рамках правил CC |
| Guardrail отсутствует вовсе | Отдельный finding |

Устойчивое знание о системе, а не о среде, продвигай обычным consolidation-путём. Стенограммы и рассуждения не сохраняй: применённые изменения живут в источниках истины.

## Daydreaming

Запускай необязательный daydream-pass только по явному запросу или принятой CC-политике. Выбери два тематически удалённых канонических узла, предложи проверяемую связь и проведи тот же critic-pass. Результат всегда сначала попадает в candidate inbox; novelty сама по себе не является evidence.
