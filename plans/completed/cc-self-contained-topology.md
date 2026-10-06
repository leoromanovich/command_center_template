# cc-self-contained-topology: Самодостаточная топология CC: source_repos/ и wt/ внутри корня

Lifecycle: completed
Planning status: accepted

## Outcome

Base clones живут в `<cc_root>/source_repos/<repo>/`, feature worktrees — в `<cc_root>/wt/<feature>/<repo>_wt/`; обе папки gitignored. Контракт обновлён на уровне шаблона (layout, валидатор, materialize, тесты), этот CC стал первым инстансом новой топологии, а `./cc repo scan` при первичной настройке превращает существующие клоны в черновики catalog для grilling-подтверждения.

## Non-goals

- Onboarding репозитория `opencode` (catalog descriptor, Nix-adapter, check) — отдельная задача.
- Изменение Nix-слоя: override-input `path:` из manifest уже отвязан от расположения папок.
- Правка исторических планов `plans/completed/` и вендоренного `loopeng/` (его `loopeng/wt/` — отдельная сущность).
- Шаринг base clones между несколькими CC (устраняется новой топологией сознательно).

## Evidence and current behavior

- `templates/control-center.json:5-10` — layout `projectsRoot: ".."`, `repositories: "../repos"`, `worktrees: "../worktrees"`.
- `scripts/validate-control-center.py:16-21` — `EXPECTED_LAYOUT` дублирует старый layout.
- `scripts/worktrees.py:42-89` — containment manifest-путей внутри `projectsRoot`.
- `scripts/materialize-template.py` — копирует tracked-файлы (включая `.gitignore`) в пустой target.
- `flake.nix:65-70` — check `bootstrap` активируется автоматически при наличии `control-center.json`.
- `source_repos/` уже существует (клон `opencode`) и уже в `.gitignore`; `/wt/` в `.gitignore` нет; `../repos` и `../worktrees` не существуют — мигрировать нечего.
- Пользователь выбрал: правка шаблона + этого CC; grilling-контракт + сканер; opencode вне скоупа.

## Affected scope

| Repository | Worktree | Read/write | Interfaces |
| --- | --- | --- | --- |
| control_center | — | `templates/control-center.json`, `scripts/validate-control-center.py`, `scripts/worktrees.py`, `scripts/repositories.py`, `scripts/materialize-template.py`, `.gitignore`, `tests/*`, `control-center.json`, `catalog/**`, `BOOTSTRAP.md`, `AGENTS.md`, `docs/**`, `.opencode/skills/**` | layout-контракт CC, команды `repo`/`worktree`/`bootstrap`, check `bootstrap` |

## Invariants and decisions

- `layout`: `projectsRoot: "."`, `repositories: "source_repos"`, `worktrees: "wt"`, `worktreePattern: "{feature}/{repository}_wt"`; `schemaVersion: 1` не меняется.
- Manifest `.cc-worktree.json` хранит пути относительно корня CC: `source_repos/<id>`, `wt/<feature>/<id>_wt`; containment проверяется относительно корня CC.
- `.gitignore` CC обязан игнорировать `/source_repos/` и `/wt/` — проверяет `./cc bootstrap validate` (клоны внутри git-репо CC не трекаются и не попадают в flake-source).
- `./cc repo scan` создаёт только черновики `status: discovered` с `role: "unassigned"`; роль, adapter и статус назначает grilling/`repo add`/`repo set-status`.
- Coexistence: `wt/` в корне CC (opencode-контракт) и `loopeng/wt/` (движок loopeng) — разные пути, обе формы покрывает глоссарный узел `wt`.

## Open questions

| Question | Impact | Owner/next evidence |
| --- | --- | --- |
| — | — | — |

## Work packages

| ID | Outcome | Write scope | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| WP1 | Контракт layout | templates/control-center.json, validate-control-center.py, worktrees.py (сообщения), materialize-template.py, .gitignore | — | unit-тесты старые зелёные после правки fixture |
| WP2 | `./cc repo scan` | scripts/repositories.py, usage в `cc` | WP1 | тест repo scan зелёный |
| WP3 | Инстанс этого CC | control-center.json, catalog/{repositories,workflows,benchmarks}/ | WP1 | `./cc bootstrap validate` проходит; flake видит check `bootstrap` |
| WP4 | Тесты | tests/test_cc_dispatch.py, tests/test_control_center_cli.py | WP1, WP2 | `./cc check` → cli-contracts зелёный |
| WP5 | Знания | ADR 0008, AGENTS.md, BOOTSTRAP.md, docs/rules/*, docs/architecture/*, docs/glossary/wt.md, skills, docs/index.md | WP1–WP3 | check knowledge зелёный |

## Integration and verification

`./cc check` (knowledge + cli-contracts + автоматически появившийся bootstrap), `./cc bootstrap validate`, `rg '\.\./repos|\.\./worktrees'` по tracked-файлам — только исторические `plans/completed/`.

## Failure, rollback and stop conditions

- Любой check красный после WP — остановка, фикс до перехода к следующему WP.
- Откат — реверс коммита WP; контракт атомарен (layout+валидатор+тесты меняются одним изменением).

## Acceptance criteria

1. `./cc check` зелёный, включая `bootstrap` и `cli-contracts` с новыми тестами.
2. `./cc bootstrap validate` проходит на этом CC.
3. `rg '\.\./repos|\.\./worktrees'` по tracked-файлам даёт hits только в `plans/completed/`.
4. Тест `bootstrap install` доказывает: новый CC рождается с новой топологией и gitignore-инвариантом.
5. Тест `repo scan` доказывает: существующие клоны в `source_repos/` превращаются в черновики catalog за один шаг.

## Execution observations

Record only observable deviations, failures, decisions and verification results needed for consolidation. Do not store transcripts or chain-of-thought.

- Демо-запуск `./cc repo scan` на этом CC создал черновик `opencode`; удалён согласно non-goals, поведение покрыто unit-тестом.
- Первый прогон `./cc check` упал на untracked docs (flake не видит нестейдженные файлы) — устранено `git add`.
- Второй прогон упал на пустых `catalog/*` (Git не трекает пустые папки) — добавлен `.gitkeep`; правило перенесено в `docs/rules/bootstrap.md`.
- Тестам потребовался `git` в sandbox cli-contracts — добавлен в `makeBinPath` flake.nix.
- `./cc check` (incl. новый автоматический check `bootstrap`), `./cc bootstrap validate`, unittest 6/6, grep старых путей чист вне `plans/completed/` и вендоренного `loopeng/`.

## Knowledge consolidation

Reflection status: reviewed
Reflection summary: Топология CC переведена на самодостаточную схему source_repos/ и wt/ внутри корня с gitignore-инвариантом в валидаторе; состав репозиториев при bootstrap определяют grilling и ./cc repo scan; главный урок вне ADR — пустые catalog-группы требуют .gitkeep, иначе bootstrap-чек падает в flake-source.
Reflection evidence:
- ./cc check all passed (incl. new bootstrap check); ./cc bootstrap validate passed; unittest 6/6; stale-path grep clean outside plans/completed and loopeng/
Knowledge delta:
- docs/decisions/0008-self-contained-cc-topology.md
- docs/rules/bootstrap.md
## Lifecycle closure

- state: completed
- date: 2026-10-06
- evidence: ./cc check all passed; bootstrap validate passed
