---
name: grill-task-planning
description: Conduct an evidence-first grilling session that turns an ambiguous engineering request into an accepted, agent-ready implementation plan with repository/worktree scope, dependency-aware work packages, durable ADRs and glossary terms, failure modes, and verifiable acceptance criteria. Use before complex, architectural, multi-repository, or multi-agent work in a configured Control Center.
---

# Grill task planning

Сначала прочитай полностью `../_shared/grilling-core.md`. Проводи только planning: не создавай worktrees и не начинай implementation до явного согласования плана.

## Frame

Построй доказуемую модель: outcome; non-goals; current behavior/evidence; affected repos, workflows, interfaces и users; domain entities/invariants; compatibility, performance, security, data и rollout constraints; failure modes/rollback; acceptance criteria и проверяющий CC output.

Не путай requested implementation с outcome. Проверь предложенное решение на контрпримерах и сравни с минимум одной реальной альтернативой.

## Plan lifecycle

Если план нужен между сессиями или агентами, создай его через `./cc plan create <task-id> --title <outcome>` в `plans/active/`. Иначе оставь план в диалоге.

- `active` — текущие планы;
- `archived` — планы, которые решили не выполнять;
- `completed` — выполненные планы.

После решения не выполнять план выполни `./cc plan archive <task-id> --reason <reason>`. После проверенной реализации — `./cc plan complete <task-id> --evidence <evidence>`. Не копируй план между states.

После явного согласования плана выполни `./cc plan accept <task-id>`. Несогласованный plan нельзя перевести в `completed`.

После implementation этот skill не проводит retrospective: загрузи `consolidate-task-knowledge`, зафиксируй reviewed reflection и только затем завершай plan.

## Worktree scope

Выбери стабильный `task-id`; ему соответствует `../worktrees/<task-id>/<repo>_wt`. Включай только изменяемые repos; read-only dependency не требует worktree.

После перехода к implementation используй `./cc worktree create <task-id> <repo>...` и `./cc feature <task-id> ...`.

## Agent-ready plan

Каждый work package должен иметь: один outcome; точную write scope; inputs/outputs; dependencies; completion check. Параллельные packages не изменяют одни и те же файлы или interfaces. Выводи параллельность из графа, а не из желаемого числа агентов. Отдели integration/final verification.

В plan храни task-local assumptions, risks, alternatives и unknowns. ADR создавай только для решения, важного за пределами задачи; glossary term — если без него агенты могут по-разному понять domain.

## Acceptance

План готов, если агент без доступа к grilling может однозначно определить: что изменить/не менять; repo/worktree; сохраняемые interfaces/invariants; проверку готовности; stop condition. Получи явное согласование до implementation.
