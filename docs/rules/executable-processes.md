---
id: rules.executable-processes
title: Исполняемые процессы
status: active
summary: Все знания о сборке, тестировании, упаковке и запуске выражаются через Nix outputs.
verified_at: 2026-07-20
evidence:
  - flake.nix
  - nix/lib/default.nix
  - examples/cpp-docker-e2e/workflow.nix
relations:
  - docs/architecture/control-center.md
  - docs/rules/project-adapters.md
  - docs/decisions/0001-nix-executable-knowledge.md
---

# Исполняемые процессы

## Контракт

| Знание | Flake output | Свойство |
|---|---|---|
| Собираемый артефакт | `packages` | Чистый, кешируемый, воспроизводимый |
| Автоматическая проверка | `checks` | Выполняется через `nix flake check` |
| Запуск/деплой/E2E | `apps` | Явный runtime side effect |
| Окружение разработчика | `devShells` | Версии инструментов задаются кодом |
| Хост/сервис | `nixosModules` | Декларативное состояние и rollback |

## Инварианты

- Межпроектный workflow потребляет derivation outputs, а не ищет артефакты по случайным путям.
- Изменение source input инвалидирует зависимые сборки и проверки.
- Flake видит только tracked-файлы Git: новые файлы стейджатся (`git add`) до `./cc check`, иначе они невидимы для `${self}` и ссылки на них падают.
- Команда, найденная во время диагностики, не считается знанием, пока не выражена в Nix.
- Сетевые, интерактивные и privileged-действия не маскируются под чистые checks.
- Markdown может объяснить цель и компромисс, но не является runbook сборки.

## Пример

`examples/cpp-docker-e2e/` выражает цепочку:

```text
cpp-a derivation ─┐
                  ├→ dockerTools image → HTTP service → E2E app
cpp-b derivation ─┘
```

Сборка C++ и образа входит в checks. Запуск Docker остаётся app, потому что требует внешнего daemon.
