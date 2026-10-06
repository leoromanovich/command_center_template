---
name: grill-cc-bootstrap
description: Conduct an evidence-first grilling session that creates a new Control Center from a temporary cc_template clone or migrates an existing CC of another format. Use when the user asks to bootstrap, configure, adapt, onboard, or migrate a Control Center and its repositories, workflows, benchmarks, executable Nix contracts, and durable knowledge.
---

# Grill CC bootstrap

Сначала прочитай полностью `../_shared/grilling-core.md`, затем `BOOTSTRAP.md`. Совмещай оба контракта.

## New CC

1. Определи `template_root` и `target_root` по `BOOTSTRAP.md`.
2. Выполни materialization; продолжай из `target_root`.
3. Зафиксируй имя, status и topology в `control-center.json`.
4. Подтверди policy обязательной task consolidation и режим daydreaming в `control-center.json`.
5. Собери use cases, границы и полномочия.
6. Составь repository inventory: закрой пробелы grilling-вопросами, затем запусти `./cc repo scan` — существующие клоны в `source_repos/` станут черновиками catalog (`discovered`). Не пиши adapters до согласования имён, ролей и связей.
7. Онборди по одному repo: `./cc repo add` (для отсутствующих клонов) или правка черновика → inspect → flake input/adapter → package/check → `./cc repo set-status <id> verified`.
8. Только затем собери workflows и benchmarks.
9. Замени template README и project map реальными данными; удали examples и placeholders.

## Migration

1. Не меняй файлы до read-only inventory.
2. Найди projects, workflows, build/test/deploy, knowledge, secrets boundaries и runtime integrations.
3. Сопоставь каждую сущность с `catalog`, `nix/projects`, `nix/workflows`, `benchmarks`, `docs` или `external`.
4. Отметь `preserve`, `transform`, `replace`, `drop`; для `drop` требуй причину и согласование.
5. Переноси один vertical slice за раз. Legacy считай oracle до проверки эквивалентности.
6. Не копируй Markdown-команды: восстанови исполняемый контракт из них и фактического CI.
7. Не удаляй legacy до проверки slice.

## Repository grilling

Сначала изучи repo и CI, затем закрой пробелы: remote/branch/role/owner; inputs/outputs/consumers; build/test interface; system/network dependencies; platforms/hardware; secrets/datasets/models/external state; минимальный adapter check.

Build-команды вводи здесь в Nix-adapter, а не в grilling-стенограмму.

## Acceptance

- `control-center.json` и catalog валидны.
- Все repos проверены или имеют явный blocker.
- Cross-repo связи представлены workflow/check.
- Критический path пройден end-to-end.
- Completion-gate требует reviewed task reflection.
- Целевой CC не зависит от `cc_template`.
