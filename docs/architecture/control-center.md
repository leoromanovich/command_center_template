---
id: architecture.control-center
title: Границы Control Center
status: active
summary: Control Center хранит карту, исполняемые межпроектные контракты и контекст, но не копирует sibling-репозитории.
verified_at: 2026-07-21
evidence:
  - templates/control-center.json
  - flake.nix
  - nix/lib/default.nix
relations:
  - docs/index.md
  - docs/rules/bootstrap.md
  - docs/rules/executable-processes.md
  - docs/rules/project-adapters.md
  - docs/rules/worktrees.md
---

# Границы Control Center

## Внутри

- flake inputs и project adapters;
- машиночитаемый catalog репозиториев, workflow и benchmarks;
- межпроектные derivation-графы и checks;
- apps для внешних и привилегированных операций;
- правила знаний и журнал межпроектных решений;
- ссылки на runtime-источники истины.

## Снаружи

- исходный код sibling-проектов;
- секреты;
- фактическое состояние production;
- полные копии проектной документации;
- универсальный UI.

Base clones и feature worktrees также находятся снаружи: `../repos/` и `../worktrees/<feature>/`.

## Поток

```text
sibling sources → project adapters → packages/checks
                                      ↓
                              cross-project workflow
                                      ↓
                           artifact → runtime app → verify
```

Markdown объясняет границы и причины. Nix-граф доказывает, что процесс всё ещё выполняется.
