---
id: hacks.index
title: Хаки
status: active
summary: Индекс временных обходов; каждый хак обязан иметь evidence и условие удаления.
verified_at: 2026-07-20
evidence:
  - docs/index.md
relations:
  - docs/index.md
  - docs/debt/index.md
---

# Хаки

Хак хранится отдельной заметкой и связывается минимум с решением либо техническим долгом. Запись объясняет причину, границы, риск и `remove_when`.

- [npm ci в FOD и ручная integrity для shrinkwrap-nested пакетов](npm-shrinkwrap-integrity.md) — hermetic node-check при отсутствии npm-deps builder в nixpkgs 26.05.

