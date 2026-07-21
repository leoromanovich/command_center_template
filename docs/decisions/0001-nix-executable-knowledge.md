---
id: decision.0001-nix-executable-knowledge
title: Nix как формат исполняемых знаний
status: accepted
summary: Процессы описываются Nix flakes; NixOS используется для машин и сервисов, а не как универсальный формат всего.
verified_at: 2026-07-20
evidence:
  - flake.nix
  - nix/lib/default.nix
relations:
  - docs/rules/executable-processes.md
  - docs/architecture/control-center.md
---

# Nix как формат исполняемых знаний

## Контекст

Markdown-команды устаревают незаметно. Межпроектная сборка должна ломаться сразу после несовместимого изменения.

## Решение

Использовать flake outputs как публичный интерфейс процессов:

- derivations/packages — сборка;
- checks — автоматическая верификация;
- apps — side effects и runtime;
- NixOS modules/tests — хосты и долгоживущие сервисы.

## Последствия

- Граф зависимостей становится вычислимым и кешируемым.
- Источники требуется пинить.
- Nix становится обязательным prerequisite.
- Docker E2E на macOS требует Linux builder/CI либо отдельного runtime-адаптера.

## Пересмотр

Если Nix не сможет выразить значимую часть реальных процессов без большого impure-слоя, сравнить Bazel, Earthly и CI-native workflow на одном pipeline.

