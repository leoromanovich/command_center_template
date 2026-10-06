---
id: hacks.npm-shrinkwrap-integrity
title: npm ci в FOD и ручная integrity для shrinkwrap-nested пакетов
status: active
summary: nixpkgs 26.05 не имеет npm-deps builder для пакетов под npm-shrinkwrap; hermetic node-check собирается FOD с npm ci, а integrity nested-записей придётся добавлять вручную при каждом bump версии зависимости.
verified_at: 2026-10-05
evidence:
  - nix/loopeng/default.nix
  - nix/loopeng/package-lock.json
  - docs/decisions/0007-loopeng-execution-engine.md
relations:
  - docs/decisions/0007-loopeng-execution-engine.md
  - docs/hacks/index.md
---

# npm ci в FOD и ручная integrity для shrinkwrap-nested пакетов

## Контекст

Hermetic node-check CC для движка loopeng требует дерево `@earendil-works/pi-coding-agent@0.85.1`. Пакет публикуется с `npm-shrinkwrap.json`, поэтому npm разрешает его зависимости во вложенный `node_modules/<pkg>/node_modules/...` и не записывает для них `integrity` в lockfile.

## Утверждение

В nixpkgs 26.05 `buildNpmDependencies`/`buildNpmDeps` отсутствуют, а `fetchNpmDeps` паникует на nested-записях без integrity («non-git dependencies should have associated integrity»). Рабочая схема — fixed-output derivation (`outputHashMode = "recursive"`), выполняющая `npm ci` по закоммиченному lockfile; в sandbox-тесте дерево подключается через `PI_PACKAGE_ROOT`. При обновлении версии зависимости: `npm install` пересоздаёт `package-lock.json`, integrity для shrinkwrap-nested записей снова отсутствует — достраивается sha512 из registry-тарболов (`resolved`-URL каждой записи). Нужны writable npm-cache и `pkgs.cacert` (`npm_config_cafile`, `NODE_EXTRA_CA_CERTS`); `cp` из store требует явного имени назначения — store-файлы несут hash-префикс.

## Последствия

Бамп Pi SDK — это связанное изменение: `nix/loopeng/package.json` + регенерация lockfile + повторная инъекция integrity + новый recursive-хэш FOD. Удалять хак, когда nixpkgs вернёт builder с поддержкой shrinkwrap или npm начнёт писать integrity штатно. Для пакетов без shrinkwrap хак не нужен: integrity генерируется npm.

remove_when: nixpkgs предоставляет npm-deps builder с поддержкой shrinkwrap-nested integrity, либо npm пишет integrity для всех записей lockfile.
