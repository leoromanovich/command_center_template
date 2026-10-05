# Control Center Template

Временный seed для создания или миграции agent-facing Control Center. Итоговый CC живёт в родительской папке, а клон template удаляется после приёмки.

Control Center хранит два вида знаний:

- **как выполнить процесс** — Nix `packages`, `checks`, `apps` и при необходимости NixOS-модули;
- **почему система устроена так** — атомарные связанные Markdown-заметки в `docs/`.

Пошаговые команды сборки, тестирования и деплоя не дублируются в Markdown. Если процесс изменился, должна сломаться исполняемая декларация.

## Создание CC

```bash
mkdir project1_CC
cd project1_CC
git clone <template-url> cc_template
opencode
```

Первый prompt:

> Создай здесь Control Center. Прочитай `cc_template/BOOTSTRAP.md`, считай `cc_template` read-only источником и начни grilling. Если здесь уже есть CC другого формата, мигрируй его без потери семантики.

OpenCode не обнаруживает project skills внутри дочернего Git-репозитория, поэтому ссылка на `BOOTSTRAP.md` в первом prompt обязательна. После materialization skill будет доступен из корня целевого CC.

После успешных `./cc bootstrap validate` и `./cc check` удалите `cc_template/` и зафиксируйте итоговый CC.

## Работа с готовым CC

```bash
./cc doctor
./cc show
./cc check
./cc build <package>
./cc run <app>
./cc repo list
./cc worktree status <feature>
./cc feature <feature> check
./cc plan list
```

Нужен Nix с flakes. Docker/Podman нужен только контейнерным workflow. На macOS Linux-образы требуют Linux builder или CI.

## Куда смотреть

- [AGENTS.md](AGENTS.md) — обязательный протокол для агентов.
- [BOOTSTRAP.md](BOOTSTRAP.md) — создание и миграция CC.
- [Карта знаний](docs/index.md) — вход в Obsidian-compatible `docs/`.
- [Исполняемые процессы](docs/rules/executable-processes.md) — что является источником истины.
- [Подключение проектов](docs/rules/project-adapters.md) — контракт sibling-репозитория.
- `nix/projects/` — адаптеры сборки отдельных проектов.
- `nix/workflows/` — межпроектные pipeline.
- `examples/cpp-docker-e2e/` — два C++-артефакта → HTTP service image → E2E.

## Repository onboarding и feature worktrees

```bash
./cc repo add repo1 --remote <git-url> --role service --clone
./cc worktree create feature1 repo1
./cc feature feature1 check
./cc worktree status feature1
./cc worktree remove feature1
```

`repo add` создаёт catalog descriptor; build-контракт добавляется следующим шагом в flake input и `nix/projects/<repo>.nix`. `feature` преобразует worktree manifest в Nix `--override-input`.

## Grilling и планы

- `grill-cc-bootstrap` — создание/миграция CC.
- `grill-task-planning` — подготовка agent-ready плана.
- `consolidate-task-knowledge` — проверяемая консолидация опыта перед completion.
- Общие grilling-инварианты живут в невызываемом shared core.

```bash
./cc plan create feature1 --title "Изменить наблюдаемое поведение"
./cc plan accept feature1
./cc plan reflect feature1 --summary "..." --evidence "nix check ..." --knowledge docs/projects/repo1/example.md
./cc plan complete feature1 --evidence "Acceptance checks passed"
```

Plan существует ровно в одном state: `plans/active/`, `plans/archived/` или `plans/completed/`. Перед completion skill `consolidate-task-knowledge` извлекает проверяемые уроки; если устойчивых знаний нет, используется `--no-knowledge-delta`. Альтернативный переход для отменённой работы: `./cc plan archive feature1 --reason "..."`.

Шаблон намеренно не содержит UI, секретов и прав на production.
