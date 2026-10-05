# Настройка

`./start` объединяет `cc.config.json` и необязательный `cc.local.json`, формирует `.pi/cc-profile.json` и загружает extension. Ручной `--profile` для корневого launcher не требуется.

У нового CC `repositories: {}`. Первый `./start` показывает инструкции настройки без запуска модели. `./cc profile` и `./cc stats` работают с пустым профилем; подготовка задач требует хотя бы одного репозитория. `./start --resume` позволяет открыть прежние диалоги и задачи даже при пустом текущем списке репозиториев.

Вложенные объекты объединяются; массивы заменяются целиком. **`repositories` заменяется целиком**, чтобы прежние репозитории не оставались в области работы. Удаление списка/поля делайте в основном конфиге. `commandCenter` и `agentRuntime.command` вычисляет launcher по текущей папке и Node; вручную их задавать не нужно. Точка входа требует Docker и выключенный host `devRun`.

Общие настройки коммитьте в `cc.config.json`. Пути конкретной машины задавайте в `cc.local.json`; образец — `examples/cc.local.example.json`. `source`, `worktreeParent`, `stateRoot`, `draftsRoot` считаются от корня CC. `worktree` — путь внутри папки задачи. Проверьте итог через `./cc profile`, затем `./cc doctor`.

## Свои репозитории

Задайте карту `repositories`: source checkout, baseRef, worktree, проверки. Существующий source используется для `git worktree add`: повторного clone и копии всей истории нет. Разрешённое автоматическое клонирование отсутствующего source:

```json
{
  "workspace": { "autoCreate": true, "cloneMissing": true },
  "repositories": {
    "service": {
      "source": "../repositories/service",
      "cloneUrl": "ssh://git@your-git-host/team/service.git",
      "baseRef": "main",
      "worktree": "service",
      "git": { "branchPrefix": "feature/" },
      "checks": {
        "format": [["your-formatter", "."]],
        "formatCheck": [["your-formatter", "--check", "."]],
        "lint": [["your-linter", "."]],
        "test": [["your-test-runner"]]
      }
    }
  }
}
```

Это фрагмент для адаптации: укажите настоящий Git URL и установленные в вашем образе инструменты. Clone/fetch выполняет доверенный контроллер на хосте; доступ использует обычные Git credentials. По умолчанию `cloneMissing=false`; fetch запрашивается в плане явно. Результаты Git-команд журналируются.

Минимальные обязательные группы — `format`, `formatCheck`, `lint`; добавляйте `test` и `typecheck` по проекту. Каждая команда — массив argv. Для составного запуска используйте явный `sh -c` внутри контейнера. `integrationChecks` позволяет запускать проверки между репозиториями: элементы `{ "cwd": "service", "argv": [...] }`.

CSV-пример запускается только через `./cc example`, со своим профилем в `.local/examples/python-catalog/CommandCenter/.pi/cc-profile.json`. Его история и проверки не подключаются к рабочему CC. Для пользовательских checks создавайте файлы в `checks/` и явно добавляйте их в `sandbox.contextFiles`.

## Модели и расширения

`pi.model` используется в Planner/Orchestrator. `pi.models` задаёт `builder`, `reviewer`, `explorer`, `execution-reviewer`; Builder этапа базы использует `builder`. Сейчас во всех этих полях `zai/glm-5.3-flash`. Модельные ключи хранятся в Pi, в Git их не добавляйте. В Docker-режиме execution-reviewer не вызывается перед каждой командой: границу исполнения задаёт контейнер.

`pi.pricingFile` указывает на файл ручных тарифов за миллион токенов, по умолчанию `model-prices.json`. `/cc-stats` показывает расход и оценку стоимости; подробнее — [STATISTICS.md](STATISTICS.md). Файл тарифов не входит в frozen context задачи и перечитывается без нового одобрения.

`pi.plannerSearchExclude` исключает относительные каталоги из общего поиска `cc_find`/`cc_grep` от корня CC. По умолчанию это runtime, examples, tests, scripts и graphify-out. Явно указанный путь остаётся доступен для исследования и разработки пайплайна; это фильтр контекста, без изменения разрешений чтения. Knowledge и Docker context ограничены списками `knowledge` и `sandbox.contextFiles`.

Стандартные настройки Pi, доступные skills и prompts остаются у foreground-сессии. Глобальные extensions отключены флагом `--no-extensions`; нужные дополнительные расширения явно перечисляются в `pi.foregroundExtensions`. Относительные пути считаются от CC. Workers загружают только инструменты пайплайна. Новые настройки применяются при новом запуске; уже одобренные задачи сохраняют свои snapshots. Конфигурацию providers/thinking/Explorer лучше менять после остановки активных работников.

## Jira и публикация

Без Jira задача имеет `source: {"kind":"local"}`. Для чтения Jira настройте `pi.jiraRead` — argv вашего установленного адаптера с подстановкой `{ticket}`. Пример формы:

```json
{ "pi": { "jiraRead": ["/absolute/path/to/jira-read", "{ticket}"] } }
```

Адаптер должен только читать тикет и возвращать текст/JSON в stdout. Planner получает `cc_jira`, записывает ключ в `source: {"kind":"jira", "key":"TEAM-123"}`. Универсальный Jira-клиент и доступ к вашей Jira в шаблон не включены.

Локальный commit разрешён профилем, но запускается после приёмки из экрана публикации. Контроллер выбирает проверенные изменённые файлы, показывает сообщение и коммитит в feature-ветку. Сообщение можно отредактировать перед выполнением.

Push требует `git.allowPush=true` и единственного push URL у настроенного remote. MR/Jira-запись требуют адаптеров `hooks.mergeRequest` / `hooks.jiraUpdate`, согласованного `task.publication` и действия пользователя. Hooks — argv на хосте. Они получают `CC_TASK_ID`, `CC_FEATURE_ROOT`, `CC_RESULT_PATH`, `CC_JIRA_KEY`, `CC_PREVIOUS_HOOK_RESULT`, `CC_IDEMPOTENCY_KEY`. Успех — exit 0 и JSON `{ "id": "...", "url": "..." }` в stdout. Контракт реализации см. `runtime/core/lib/controller.mjs` и `publication.mjs`. После неизвестного исхода требуется сверить внешний сервис перед повтором; используйте idempotency key. Не добавляйте заглушку, имитирующую успешную публикацию.

Одобрение привязано к digest плана. Изменение checks, образа, состава репозиториев или правил требует нового prepare и одобрения. Новый template checkout не восстанавливает старые локальные задачи автоматически.
