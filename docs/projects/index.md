---
id: projects.index
title: Проекты
status: active
summary: Карта ролей подключённых sibling-проектов; исполняемый интерфейс находится в nix/projects.
verified_at: 2026-07-20
evidence:
  - nix/projects/default.nix
  - nix/devenv/default.nix
relations:
  - docs/index.md
  - docs/rules/project-adapters.md
  - docs/decisions/0006-devenv-local-runtime.md
---

# Проекты

| Проект | Роль | Исполняемый адаптер |
|---|---|---|
| `cpp-a` | Учебный C++-артефакт | `examples/cpp-docker-e2e/projects.nix` |
| `cpp-b` | Учебный C++-артефакт | `examples/cpp-docker-e2e/projects.nix` |
| `devenv-pilot` | Учебный API с PostgreSQL и feature-изоляцией | `nix/devenv/default.nix` |

После адаптации шаблона заменить example-строки реальными проектами. `./cc repo add` создаёт для каждого проекта `docs/projects/<id>/index.md`; он служит retrieval-root для следующих задач. Команды сборки здесь не хранить.
