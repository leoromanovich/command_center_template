# Control Center bootstrap

Этот файл — первая инструкция для модели, которую запустили из папки целевого CC.

## Определи корни

- `template_root` — папка с этим файлом; обычно `<target_root>/cc_template`.
- `target_root` — родитель `cc_template`; именно он станет CC.
- Не изменяй, не перемещай и не коммить `template_root` в целевой CC. Это read-only seed.

Сразу прочитай полностью `<template_root>/.opencode/skills/grill-cc-bootstrap/SKILL.md` и указанный в нём shared core. OpenCode не обнаруживает skills внутри дочернего Git-репозитория автоматически.

## Определи режим

- `new`: в `target_root`, кроме `cc_template`, нет CC-файлов. Выполни из `target_root`:

  ```bash
  ./cc_template/cc bootstrap install .
  ```

- `migration`: в `target_root` уже есть CC, каталог репозиториев, automation или знания другого формата. Не запускай installer. Сначала сделай read-only inventory, карту сопоставления и поэтапную миграцию.

Если режим неочевиден, не пиши в целевую папку до уточнения.

## Неизменная топология

```text
Projects/
├── project1_CC/
├── project2_CC/
├── repos/
│   ├── repo1/
│   └── repo2/
└── worktrees/
    ├── feature1/
    │   ├── repo1_wt/
    │   └── repo2_wt/
    └── feature2/
        └── ...
```

Относительно любого `<project>_CC`:

- base checkouts: `../repos/<repo>`;
- worktrees: `../worktrees/<feature>/<repo>_wt`;
- CC не копируется в feature-папку;
- локальные absolute paths не попадают в Git;
- Nix получает feature sources через `--override-input` из worktree manifest.

Изменить эту топологию можно только отдельным явным решением пользователя.

Используй исполняемый интерфейс, а не ручные `git worktree` в обычной работе:

```bash
./cc repo add <repo> --remote <git-url> --role <role> --clone
./cc worktree create <feature> <repo>...
./cc feature <feature> check
./cc worktree status <feature>
./cc worktree remove <feature>
```

`worktree remove` не использует force и отказывается работать с dirty или неопубликованным state.

## Критерий приёмки

Не объявляй bootstrap завершённым, пока:

1. `control-center.json` и catalog не отражают согласованную модель.
2. Каждый подключённый репозиторий имеет pinned source, Nix-adapter и check.
3. Workflow потребляют объявленные outputs, а не дублируют build-команды.
4. Неизвестные факты явно отмечены, противоречия разрешены.
5. `./cc bootstrap validate` и `./cc check` проходят либо непроверенная среда явно зафиксирована.
6. Целевой CC не зависит от содержимого `cc_template/`.

После этого сообщи пользователю, что `cc_template/` можно удалить. Сам его не удаляй.
