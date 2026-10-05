# devenv-pilot: Локальный API и PostgreSQL через pinned devenv и CC apps

Lifecycle: completed
Planning status: accepted

## Outcome

Пилот локального API с PostgreSQL через pinned devenv, доступный из CC apps и из feature-контекста. Пользователь согласовал предложенный пилот сообщением «Делаем».

## Non-goals

Production, bootstrap нового CC, миграция sibling-проектов и изменение их исходников. Текущие пользовательские изменения сохраняются.

## Evidence and current behavior

- `flake.nix`: обычный devShell и C++ examples; lock отсутствует.
- `cc`: Bash 3.2 ломает пустой массив overrides; Nix требует включить nix-command/flakes.
- `nix/lib/default.nix`: чистые packages/checks и явно запускаемые apps.
- `scripts/worktrees.py`: feature source inputs подменяются через manifest.
- Репозиторий является шаблоном; `control-center.json` и catalog пока отсутствуют.

## Affected scope

| Repository | Worktree | Read/write | Interfaces |
| --- | --- | --- | --- |
| control_center | текущий корень CC | write | cc, flake, examples/devenv, tests, docs |

## Invariants and decisions

- Режим изменения существующего шаблона: migration одного vertical slice, installer не нужен.
- Preserve: существующие проекты, workflows, контракты и незакоммиченные изменения.
- Transform: CLI совместимость; add: pinned devenv и учебный runtime workflow.
- Полный CLI devenv используется для жизненного цикла процессов и тестов; версия фиксируется flake input.
- Runtime-состояние локально и разделено по feature; внешние сервисы и секреты не нужны.
- Альтернатива: ручной process supervisor поверх mkShell. Devenv выбран для готовых сервисов и lifecycle.
- Чистые проверки выполняются через checks; HTTP/БД проверяются отдельным app.

## Open questions

Закрыты для пилота: CLI 2.1.2 и runtime проверены на aarch64-darwin. Остальные платформы требуют отдельного runtime-прогона.

## Work packages

| ID | Outcome | Write scope | Depends on | Completion check |
| --- | --- | --- | --- | --- |
| cli | Надёжный вызов Nix и overrides | cc, tests/test_cc_dispatch.py | — | cli-contracts |
| runtime | API/PG через devenv | flake.nix, flake.lock, nix/devenv, examples/devenv, .gitignore | cli | show, check, runtime app |
| integration | Проверка двух окружений и cleanup | tests, runtime verification app | runtime | два параллельных запуска с раздельными данными |
| knowledge | Проверенные границы и reflection | docs, этот plan | integration | knowledge check, reviewed reflection |

## Integration and verification

Проверить flake outputs, регрессионные CLI contracts, API/PG round-trip, параллельные feature-окружения, корректный cleanup. Итоговая проверка — `./cc check`; runtime verification — явный app.

## Failure, rollback and stop conditions

При сбое сохранить диагностику и устранить причину в контракте. Недоступные платформы отметить явно. Rollback ограничен добавленным pilot workflow и зависимостью devenv; существующие workflows сохраняются.

## Acceptance criteria

- `./cc show` и `./cc check` успешны на доступной платформе.
- Devenv и все удалённые inputs зафиксированы в flake.lock.
- API использует PostgreSQL; runtime test подтверждает запись и чтение.
- Два feature-окружения запускаются параллельно, имеют раздельные порты и данные.
- Завершение runtime test останавливает его процессы.
- Knowledge отражает проверенные границы, plan имеет reviewed reflection.

## Execution observations

- CLI contracts прошли через Nix на aarch64-darwin, включая системный Bash 3.2 и пути с пробелами.
- Пакет CLI взят из pinned nixpkgs; source hash модулей проверяется assertion. Дополнительный cache требовал доверия daemon, поэтому выбран стандартный пакет 2.1.2.
- Загрузка исходника из binary cache задержалась; та же pinned-ревизия успешно получена напрямую через Nix.
- Nix-модуль включён в store вместе с каталогом относительных зависимостей; clean shell содержит CLI для `wait_for_processes`. Обе ошибки обнаружены и устранены runtime-прогонами.
- `./cc show`, `./cc check` и одиночный `./cc run devenv-pilot-test` прошли на aarch64-darwin.
- `./cc run devenv-pilot-verify` прошёл: реальные worktrees alpha/beta вернули разные source labels, API использовали 18080/18081, PostgreSQL — 5432/5433. Проверены одновременная работа, раздельные данные, неизменность flake.lock и остановка процессов; временные worktrees удалены через CC.

## Knowledge consolidation

Reflection status: reviewed
Reflection summary: Полный CLI devenv интегрирован через CC apps с единым flake lock и feature-изоляцией; границы и условие пересмотра закреплены в ADR 0006.
Reflection evidence:
- 2026-10-01, aarch64-darwin: ./cc show, ./cc check, ./cc run devenv-pilot-test и ./cc run devenv-pilot-verify прошли; два worktree подтвердили source overrides, раздельные порты и данные, неизменность lock и cleanup.
Knowledge delta:
- docs/decisions/0006-devenv-local-runtime.md
## Lifecycle closure

- state: completed
- date: 2026-10-01
- evidence: 2026-10-01, aarch64-darwin: итоговый ./cc check прошёл после reviewed reflection; ./cc show, одиночный runtime test и verify двух feature worktrees прошли. Подтверждены API/PostgreSQL round-trip, source overrides, раздельные порты и данные, неизменность flake.lock и остановка процессов.
