# loopeng-vendor: Вендоринг loopeng как execution engine CC

Lifecycle: completed
Planning status: accepted

## Outcome

Пайплайн loopeng вендорен в `loopeng/` внутри CC и поглощён: git-клон CC самодостаточен для агентных циклов Pi+Docker и переживает удаление upstream `leoromanovich/loopeng_pi`. Тесты движка включены в `./cc check` hermetic-деривацией и перестраиваются только при изменении поддерева `loopeng/`.

## Non-goals

- Подключение реальных репозиториев в `repositories` инстанса (отдельная задача).
- Правки самого пайплайна loopeng.
- Параллелизация `flake check` и split тест-сюит.

## Evidence and current behavior

- Seed-клон `git@github.com:leoromanovich/loopeng_pi.git`, commit `fdb28e4d3635193ef9cdbcec7848961d11965f33`, ветка `main`.
- Node ≥22.19 + Pi SDK 0.79.9/0.85.1 + Docker — контракт движка (`loopeng/README.md`); тесты движка используют только `node:*` и metadata-фикстуры Pi, docker-тесты гейтятся `CC_DOCKER_TEST=1`.
- CC: `nix/projects/default.nix` ранее импортировал только учебные examples; `control-center.json` отсутствует; валидатор требует layout `../repos`.

## Affected scope

| Repository | Worktree | Read/write | Interfaces |
| --- | --- | --- | --- |
| control_center | base checkout | `loopeng/`, `nix/loopeng/`, `flake.nix`, `docs/` | flake checks/apps; knowledge graph |

## Invariants and decisions

- Режим интеграции: vendoring (absorption), не catalog-проект и не flake input — upstream будет удалён.
- `loopeng/` — одновременно код и рабочий инстанс; машинное состояние изолирует nested `.gitignore`.
- Check `loopeng-unit` hermetic: Pi SDK пинится lockfile-манифестом + FOD, docker-тесты явно вне check.
- Src чеки — отфильтрованное поддерево `builtins.path`, не `${self}`: правки CC и runtime-состояние derivation не инвалидируют.

## Open questions

| Question | Impact | Owner/next evidence |
| --- | --- | --- |
| Пройдёт ли `./cc demo` end-to-end на этой машине | Полная валидация движка | Пользователь (интерактивный TUI) |

## Work packages

| ID | Outcome | Write scope | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| WP1 | Вендоринг seed → `loopeng/` (git archive, 125 файлов) | `loopeng/` | — | файлы в Git, exec-биты сохранены |
| WP2 | Nix-контракт: `loopeng-unit` + `loopeng-build-image` | `nix/loopeng/`, `flake.nix` | WP1 | `nix build .#checks...loopeng-unit` зелёный |
| WP3 | ADR 0007 + index/architecture | `docs/` | WP1, WP2 | knowledge-валидация |
| WP4 | Отвязка от `${self}` (filtered `builtins.path`) | `nix/loopeng/default.nix` | WP2 | drvPath-эксперименты: CC-правка и машинное состояние → кэш; правка движка → rebuild |

## Integration and verification

- `./cc check` зелёный (включая `loopeng-unit`, обе сюиты `node --test`).
- `nix run .#loopeng-build-image` работает; образы `local/cc-builder:0.1`, `local/cc-sandbox-python:0.1` собраны.
- drvPath-эксперименты декуплинга: `README.md` CC → drv без изменений; `cc.local.json`+`.pi/`+`WorkTree/` → без изменений; `loopeng/runtime/core/lib/policy.mjs` → drv изменился.

## Failure, rollback and stop conditions

- Откат — удалить `loopeng/`, `nix/loopeng/`, wiring flake и ADR (состояние коммита `6fac4f0`).
- Stop: если hermetic-чек движка невозможно стабилизировать в sandbox — вынести в явно запускаемый app (не сделано, не потребовалось).

## Acceptance criteria

1. `loopeng/` в Git CC; клон CC самодостаточен для запуска движка (с машинными prereqs: Docker, Node/Pi, ключи).
2. `./cc check` зелёный с `loopeng-unit`.
3. ADR 0007 отражает vendoring-модель; глоссарий и индексы связаны.
4. Правки CC вне `loopeng/` не перестраивают тесты движка.

## Execution observations

- План создан ретроактивно: задача выросла из информационного вопроса через grilling, решения принимал пользователь по ходу. Отклонение от протокола планирования зафиксировано здесь, не в канонических правилах.
- Первая реализация (инстанс в `.cc-local/` как template-seed) отвергнута пользователем: клон CC на новой машине не содержал бы движок после удаления upstream. Модель пересобрана: vendoring.
- `git subtree add` невозможен на dirty tree (требует merge-коммит чужой незавершённой работы) → `git archive`-экспорт + провенанс в ADR.
- nixpkgs 26.05: `buildNpmDependencies`/`buildNpmDeps` отсутствуют; `fetchNpmDeps` падает на shrinkwrap-nested зависимостях без integrity («non-git dependencies should have associated integrity») → FOD `runCommand` (recursive hash) с `npm ci`.
- npm не пишет `integrity` для nested-пакетов под `hasShrinkwrap` → sha512 инжектированы вручную из registry-тарболов в `nix/loopeng/package-lock.json`.
- Sandbox: npm требует writable cache и CA-bundle (`npm_config_cafile`, `NODE_EXTRA_CA_CERTS` с `pkgs.cacert`).
- `cp ${./package.json} dir/` сохраняет hash-префиксное store-имя → npm ci EUSAGE; лечится явным именем назначения.
- `${self}`-связь инвалидирует `loopeng-unit` любой правкой CC (~4 мин тестов) → filtered `builtins.path`; доказано drvPath-экспериментами.
- Новые незаstage-женные файлы невидимы для flake `${self}`: check упал на битой ссылке ADR до `git add`.
- Коммиты: `d2fbebc` (vendor), `a268b98` (scoped checks); `6fac4f0` (предыдущая работа CC) и `0d58d70` (wt-rename пользователя) — контекст задачи.

## Knowledge consolidation

Reflection status: reviewed
Reflection summary: Vendoring движка в loopeng/ самодостаточен для клона CC и переживёт удаление upstream; hermetic-чек движка отвязан от ${self} и перестраивается только по поддереву loopeng/
Reflection evidence:
- commit d2fbebc: loopeng/ + nix/loopeng/ в Git, ./cc check зелёный
- commit a268b98: drvPath-эксперименты — CC-правка и машинное состояние не меняют derivation, правка loopeng/runtime меняет
- nix build .#checks.aarch64-darwin.loopeng-unit exit 0 (обе сюиты node --test)
Knowledge delta:
- docs/hacks/npm-shrinkwrap-integrity.md
- docs/decisions/0007-loopeng-execution-engine.md
## Lifecycle closure

- state: completed
- date: 2026-10-06
- evidence: ./cc check зелёный; commits d2fbebc, a268b98; хак-заметка docs/hacks/npm-shrinkwrap-integrity.md
