---
id: decision.0007-loopeng-execution-engine
title: Вендоренный loopeng как execution engine
status: accepted
summary: Пайплайн loopeng вендорен в loopeng/ внутри CC; git-клон CC самодостаточен для агентных циклов Pi+Docker и переживёт удаление upstream-репозитория.
verified_at: 2026-10-05
evidence:
  - loopeng/
  - nix/loopeng/default.nix
  - nix/loopeng/package.json
  - nix/loopeng/package-lock.json
  - flake.nix
relations:
  - docs/architecture/control-center.md
  - docs/decisions/0003-template-as-seed.md
  - docs/rules/executable-processes.md
  - docs/rules/worktrees.md
---

# Вендоренный loopeng как execution engine

## Решение

Код пайплайна loopeng («Command Center · Pi + Docker»: Planner → Builder в Docker-песочнице → checks → Reviewer) вендорен в каталог `loopeng/` этого репозитория и поглощён CC: правки пайплайна делаются здесь, upstream `leoromanovich/loopeng_pi` — read-only архив до удаления. Каталог `loopeng/` одновременно код и рабочий инстанс: машинное состояние (`.pi/`, `WorkTree/`, `cc.local.json`) изолирует собственный nested `.gitignore` loopeng. Роль: CC остаётся картой, знаниями и Nix-контрольной плоскостью для opencode; loopeng исполняет агентные циклы через Pi SDK.

Исполняемый контракт: hermetic check `loopeng-unit` (обе сюиты `node --test` в sandbox; Pi SDK и зависимости пинятся через закоммиченный `nix/loopeng/package-lock.json` и fixed-output derivation; docker-тесты без `CC_DOCKER_TEST` скипаются) и app `loopeng-build-image` (сборка `local/cc-builder` — сеть, явный запуск).

## Почему

Git-клон CC должен быть самодостаточным: `git clone control_center` на новой машине → `nix run .#loopeng-build-image` (или `cd loopeng && ./cc build-image`) → `repositories` в `cc.local.json` → `./start`. Пинить doomed-upstream через flake input бессмысленно: после удаления репозитория интеграция должна выжить. Вендоринг — absorption по аналогии с решением 0003 (seed после материализации не нужен), с той разницей что здесь поглощается сам runtime, а не только результат.

Lockfile-манифест `nix/loopeng/package.json` пинит `@earendil-works/pi-coding-agent@0.85.1` и его дерево для тестов; integrity для nested-пакетов под shrinkwrap добавлены вручную из registry (npm их не пишет). Runtime-движок это дерево не использует: боевой Pi ставится глобально на машину (`npm i -g @earendil-works/pi-coding-agent@0.85.1`), авторизация — в пользовательском конфиге Pi.

## Границы

- Инстанс машинно-локален по состоянию, но глобален по коду: `loopeng/.pi/`, `WorkTree/`, `cc.local.json` не коммитятся; код и конфиг профиля — коммитятся.
- Coexistence worktrees: loopeng создаёт свои `WorkTree/<task>/<repo>` от base checkout; opencode-фичи CC используют контракт `../worktrees/<feature>/<repo>_wt`. Base checkouts общие; source-пути в `repositories` указывают на существующие checkout без re-clone.
- `repositories` пока пусты: движок валидируется встроенным `./cc demo`; реальные репозитории подключаются через `cc.local.json` (машинные пути) + toolchain в `loopeng/docker/Dockerfile`.
- Неубираемый машинный остаток: Docker-daemon, Node ≥22.19 (или глобальный Pi), ключи моделей в Pi. Секреты и `.env` — вне смонтированных worktree (enforced песочницей).
- Правки пайплайна loopeng — по его собственному AGENTS («Разработка самого пайплайна»), отдельным запросом; его тесты включены в `./cc check`.

## Пересмотр

После стабилизации удалить upstream-репозиторий loopeng_pi; провенанс сохранён здесь (seed: git@github.com:leoromanovich/loopeng_pi, commit fdb28e4d3635193ef9cdbcec7848961d11965f33). Обновление Pi SDK (0.79.9/0.85.1 — поддерживаемые версии адаптера) требует одновременного обновления lockfile-манифеста и пересбора FOD. При подключении реальных репозиториев согласовать их checks и Dockerfile toolchain с Nix-контрактами CC, где проекты уже onboarded.
