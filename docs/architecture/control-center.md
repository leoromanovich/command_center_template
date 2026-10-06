---
id: architecture.control-center
title: Границы Control Center
status: active
summary: Control Center хранит карту, исполняемые межпроектные контракты и контекст; клоны sibling-репозиториев лежат внутри корня, но вне Git-истории CC.
verified_at: 2026-10-06
evidence:
  - templates/control-center.json
  - flake.nix
  - nix/lib/default.nix
relations:
  - docs/index.md
  - docs/rules/bootstrap.md
  - docs/rules/executable-processes.md
  - docs/rules/knowledge-consolidation.md
  - docs/rules/project-adapters.md
  - docs/rules/worktrees.md
  - docs/decisions/0006-devenv-local-runtime.md
  - docs/decisions/0008-self-contained-cc-topology.md
---

# Границы Control Center

## Внутри

- flake inputs и project adapters;
- машиночитаемый catalog репозиториев, workflow и benchmarks;
- межпроектные derivation-графы и checks;
- apps для внешних и привилегированных операций;
- правила знаний и журнал межпроектных решений;
- reviewed task reflections и ссылки на продвинутые knowledge deltas;
- ссылки на runtime-источники истины.

## Снаружи

- исходный код sibling-проектов;
- секреты;
- фактическое состояние production;
- полные копии проектной документации;
- непроверенные reflection/daydreaming-кандидаты;
- универсальный UI.

Base clones и feature worktrees находятся внутри корня CC в gitignored `source_repos/` и `wt/<feature>/` — физически локально, но вне Git-истории и flake-source CC (см. [decision 0008](../decisions/0008-self-contained-cc-topology.md)).

## Поток

```text
sibling sources → project adapters → packages/checks
                                      ↓
                              cross-project workflow
                                      ↓
                           artifact → runtime app → verify
```

Markdown объясняет границы и причины. Nix-граф доказывает, что процесс всё ещё выполняется.

[Devenv обслуживает локальный runtime](../decisions/0006-devenv-local-runtime.md) через CC apps. Версии и source overrides задаются flake-контрактом.

[Вендоренный loopeng в `loopeng/`](../decisions/0007-loopeng-execution-engine.md) исполняет агентные циклы Pi+Docker; его тесты включены в checks CC.
