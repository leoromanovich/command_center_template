---
id: decision.0008-self-contained-cc-topology
title: Самодостаточная топология CC: source_repos и wt внутри корня
status: accepted
summary: Base clones и feature worktrees живут внутри корня CC в gitignored source_repos/ и wt/; клоны перестают быть разделяемыми между CC, а bootstrap определяет состав репозиториев через grilling и ./cc repo scan.
verified_at: 2026-10-06
evidence:
  - templates/control-center.json
  - scripts/validate-control-center.py
  - scripts/repositories.py
  - scripts/worktrees.py
  - scripts/materialize-template.py
  - .gitignore
  - tests/test_control_center_cli.py
relations:
  - docs/architecture/control-center.md
  - docs/rules/bootstrap.md
  - docs/rules/worktrees.md
  - docs/glossary/wt.md
  - docs/decisions/0007-loopeng-execution-engine.md
---

# Самодостаточная топология CC: source_repos и wt внутри корня

## Контекст

Топология первого поколения держала base clones в `../repos/`, а feature worktrees в `../worktrees/` — вне git-репозитория CC, в расчёте на несколько CC, разделяющих одни checkouts внутри папки `Projects/`. На практике CC используется по одному на рабочее окружение: разделяемые клоны не востребованы, а sibling-папки требуют договорённости вне Git и плохо переносятся.

## Решение

Клоны и worktrees живут внутри корня CC и игнорируются его Git:

- base checkouts: `source_repos/<repo>/`;
- feature worktrees: `wt/<feature>/<repo>_wt/`;
- layout-контракт: `projectsRoot: "."`, `repositories: "source_repos"`, `worktrees: "wt"`; `schemaVersion` не меняется, manifest `.cc-worktree.json` хранит пути относительно корня CC;
- `.gitignore` CC обязан содержать `/source_repos/` и `/wt/` — это проверяет `./cc bootstrap validate` наравне с layout.

Состав репозиториев при первичной настройке определяется двумя механизмами: инвентаризация в grilling-сессии bootstrap и исполняемая команда `./cc repo scan`, которая превращает существующие клоны в `source_repos/` в черновики catalog (`status: discovered`, `role: unassigned`) для подтверждения; роль, adapter и статус назначаются онбордингом.

## Рассмотренные варианты

- Сохранить sibling-топологию `Projects/repos` — отвергнута: разделяемые клоны не используются, а вне-Git договорённости о соседних папках хрупки.
- Переопределить layout только в этом инстансе, оставив шаблон со старым контрактом — отвергнуто: валидатор `EXPECTED_LAYOUT` зафиксировал бы противоречие между шаблоном и инстансом.
- Декларативный список репозиториев в `control-center.json` вместо сканера — отвергнут: дублировал бы catalog и создавал второй источник истины.

## Последствия

- Клоны per-CC: несколько CC на одной машине держат независимые checkouts; шаринг base clones между CC устранён сознательно.
- Gitignored-папки автоматически исключаются из flake-source CC; Nix получает рабочие источники только через pinned inputs и `--override-input path:` из manifest — контракт не изменился.
- `wt/` в корне CC (opencode-контракт) и `loopeng/wt/` (движок loopeng) — разные пути; обе формы покрывает глоссарный узел `wt`.
- Репозиторий без `origin` remote или с absolute local remote не драфтится сканером: unpinnable источник не входит в catalog.

## Условие пересмотра

Появится устойчивый сценарий нескольких CC, разделяющих одни и те же большие checkouts на одной машине.
