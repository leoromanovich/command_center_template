# wt-rename: Переименование worktree-папки loopeng WorkTree в wt и глоссарная заметка

Lifecycle: completed
Planning status: accepted

## Outcome

Worktree-родитель движка loopeng переименован с `WorkTree` на `wt` согласованно по всему репозиторию (конфиг, дефолт runtime, тесты, фикстуры, генерируемые .gitignore, доки, заметка CC), и аббревиатура `wt = worktree` закреплена глоссарным узлом, покрывающим обе формы: `wt/<task>/<repo>` loopeng и суффикс `<repo>_wt` контракта CC.

## Non-goals

- Контракт CC `../worktrees/<feature>/<repo>_wt/` не меняется (суффикс `_wt` остался как был).
- Миграция on-disk состояния не нужна: папка `WorkTree/` ни разу не создавалась.
- Nix-контракты не меняются: npm-зависимости и FOD-хэш `nix/loopeng` не затронуты.

## Evidence and current behavior

До задачи: `worktreeParent: "WorkTree"` в `loopeng/cc.config.json`, дефолт `'../WorkTree'` в `loopeng/runtime/core/lib/controller.mjs`, ~30 упоминаний по репозиторию (тесты, демо-фикстуры, examples-профиль, генерируемые .gitignore в `setup-*.mjs`, доки, decision 0007). Папки `WorkTree/` на диске нет; CC-суффикс `_wt` — отдельная конвенция opencode-фич.

Решения пользователя (grilling, чат-сессия):

1. Переименуется папка loopeng `WorkTree`, не CC-суффикс.
2. Объём — полная согласованная правка (базовый коммит d2fbebc сделан пользователем до правок).
3. Заметка покрывает обе формы аббревиатуры.

## Affected scope

| Repository | Worktree | Read/write | Interfaces |
| --- | --- | --- | --- |
| control_center | — (правка в корне CC) | rw: `loopeng/**`, `docs/decisions/0007-loopeng-execution-engine.md`, `docs/glossary/wt.md` | `worktreeParent` profile-схемы loopeng; тексты AGENTS/docs |

## Invariants and decisions

- Дефолт `worktreeParent` и обе явные настройки (`cc.config.json`, examples-профиль) переименованы синхронно; сообщения валидации controller.mjs сделаны нейтральными к имени папки.
- Генерируемые .gitignore (`setup-demo.mjs`, `setup-docker-project.mjs`) и committed `loopeng/.gitignore` игнорируют `wt/`.
- Историческое имя `WorkTree` упомянуто только в справке глоссарного узла (намеренно).

## Open questions

| Question | Impact | Owner/next evidence |
| --- | --- | --- |
| — | — | — |

## Work packages

| ID | Outcome | Write scope | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| WP1 | config + runtime-дефолт + .gitignore | loopeng/cc.config.json, runtime/core/lib/controller.mjs, loopeng/.gitignore, setup-*.mjs, examples profile.json | — | `./cc profile`-эквивалент: валидация loadProfile |
| WP2 | тесты и демо-фикстуры | tests/*.test.mjs, runtime/core/tests, runtime/core/demo | WP1 | loopeng-unit зелёный |
| WP3 | доки loopeng | AGENTS.md, docs/, examples/python-catalog/** | WP1 | rg WorkTree чист вне справки |
| WP4 | знания CC | docs/decisions/0007, docs/glossary/wt.md (новый) | WP1 | check knowledge зелёный |
| WP5 | верификация | — | WP1–WP4 | `./cc check` зелёный |

## Integration and verification

`./cc check` (hermetic loopeng-unit покрывает все затронутые node-тесты; knowledge валидирует глоссарный узел; cli-contracts не затронуты, но прогоняются). `rg -n "WorkTree"` — один намеренный hit в `docs/glossary/wt.md`.

## Failure, rollback and stop conditions

Откат — git revert правок; on-disk состояния для миграции нет. Стоп-условие: падение loopeng-unit после правки фикстур означало бы пропущенный литерал `'WorkTree'` — лечится rg-проходом, не ослаблением теста.

## Acceptance criteria

- `worktreeParent: "wt"` в `loopeng/cc.config.json` и examples-профиле; дефолт `../wt` в controller.mjs.
- `./cc check` зелёный целиком.
- `rg WorkTree` по репозиторию находит только историческую справку в `docs/glossary/wt.md`.
- Глоссарный узел `glossary.wt` валиден (frontmatter, evidence, relations) и связан с decision 0007 и rules.worktrees.

## Execution observations

- Plan зарегистрирован ретроактивно: задача выполнена интерактивно (план утверждён в чате), решение о ретроактивной регистрации принял пользователь.
- Ответ пользователя на вопрос об объёме («Коммит текущей работы по loopeng сделан») интерпретирован как согласие на полную согласованную правку поверх чистого базового коммита d2fbebc; отклонений от этого объёма не потребовалось.
- Мелкие judgment-правки в рамках плана: сообщения валидации controller.mjs нейтральны к имени; regex ls-files-проверки в git-workflow.test.mjs заменён `/WorkTree|.../` → `/wt\/|.../`.
- Все проверки зелёные с первого прогона; отклонений, ошибок и повторов нет.
- Critic-pass, кандидаты сверх продвинутых узлов: (1) «переименование worktreeParent требует синхронной правки config+дефолт+тесты+gitignore+доки» — отклонён: быстро выводится rg-поиском, не содержит неочевидного инварианта; (2) «loopeng-unit покрывает тесты пайплайна» — отклонён: дословно дублирует decision 0007. Knowledge delta сверх `docs/glossary/wt.md` и обновления decision 0007 — `none`.
- Environment retro: сессия гладкая (поиск — два grep, check зелёный с первого раза); трассируемых «мучений» нет — кандидатов нет.

## Knowledge consolidation

Reflection status: reviewed
Reflection summary: Единая аббревиатура wt=worktree закреплена: worktreeParent loopeng переименован WorkTree→wt согласованно по 22 файлам, обе конвенции (wt/ и суффикс _wt) зафиксированы глоссарным узлом; Nix-контракты не менялись.
Reflection evidence:
- ./cc check: all checks passed (loopeng-unit, knowledge, cli-contracts) 2026-10-05
- rg WorkTree: единственный hit — намеренная историческая справка docs/glossary/wt.md
- git diff рабочей копии: 22 файла, +75/−38 поверх базового коммита d2fbebc
Knowledge delta:
- docs/glossary/wt.md
- docs/decisions/0007-loopeng-execution-engine.md
## Lifecycle closure

- state: completed
- date: 2026-10-05
- evidence: ./cc check all checks passed; rg WorkTree clean; diff verified in session
