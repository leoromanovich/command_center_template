---
id: decision.0003-template-as-seed
title: Template как временный seed
status: accepted
summary: Клон cc_template остаётся read-only источником, а итоговый CC создаётся как отдельный Git-репозиторий в родительской папке.
verified_at: 2026-07-21
evidence:
  - BOOTSTRAP.md
  - scripts/materialize-template.py
relations:
  - docs/index.md
  - docs/rules/bootstrap.md
  - docs/rules/worktrees.md
---

# Template как временный seed

## Контекст

Пользователь запускает OpenCode из папки будущего CC. Там может быть пусто либо уже существовать CC другого формата. Вложенный Git-клон не должен определять жизненный цикл итогового проекта.

## Решение

Считать `cc_template/` read-only seed. В режиме `new` копировать его tracked files в родитель без overwrite. В режиме `migration` адаптировать после read-only inventory. После приёмки seed удаляется пользователем.

## Последствия

- Целевой CC имеет собственную Git-историю.
- Изменения template не проникают в конкретный CC незаметно.
- Начальная сессия должна явно указать `cc_template/BOOTSTRAP.md`, потому что OpenCode не ищет project skills внутри дочернего Git-репозитория.
