#!/usr/bin/env python3
"""Safely materialize a tracked template clone into its parent directory."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def tracked_files(source: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(source), "ls-files", "-z"],
        check=True,
        capture_output=True,
    )
    files = [Path(raw.decode()) for raw in result.stdout.split(b"\0") if raw]
    if not files:
        raise ValueError("template has no tracked files; use a committed clone")
    missing = [path for path in files if not (source / path).is_file()]
    if missing:
        raise ValueError(f"tracked template files are missing: {', '.join(map(str, missing))}")
    return files


def validate_target(source: Path, target: Path, files: list[Path]) -> None:
    if source == target or source in target.parents:
        raise ValueError("target must not be the template clone or one of its descendants")

    allowed_entries = {source.resolve()} if source.parent == target else set()
    allowed_names = {".DS_Store", ".git"}
    unexpected = [
        entry.name
        for entry in target.iterdir()
        if entry.resolve() not in allowed_entries and entry.name not in allowed_names
    ]
    if unexpected:
        raise ValueError(
            "new bootstrap requires an empty target except for the template clone; "
            f"found: {', '.join(sorted(unexpected))}. Use migration mode instead."
        )

    collisions = [str(path) for path in files if (target / path).exists()]
    if collisions:
        raise ValueError(f"refusing to overwrite target files: {', '.join(collisions)}")


def materialize(source: Path, target: Path) -> None:
    if shutil.which("git") is None:
        raise ValueError("git is required")
    files = tracked_files(source)
    validate_target(source, target, files)

    for relative in files:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, destination)

    seed = json.loads((source / "templates/control-center.json").read_text(encoding="utf-8"))
    seed["name"] = target.name
    (target / "control-center.json").write_text(
        json.dumps(seed, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    gitignore = target / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.exists() else ""
    missing = [entry for entry in ("/source_repos/", "/wt/") if entry not in existing]
    if missing:
        with gitignore.open("a", encoding="utf-8") as stream:
            if existing and not existing.endswith("\n"):
                stream.write("\n")
            for entry in missing:
                stream.write(f"{entry}\n")

    for relative in (
        "catalog/repositories",
        "catalog/workflows",
        "catalog/benchmarks",
        "plans/active",
        "plans/archived",
        "plans/completed",
    ):
        (target / relative).mkdir(parents=True, exist_ok=True)

    if not (target / ".git").exists():
        subprocess.run(["git", "init", "-b", "main", str(target)], check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", nargs="?", default=".")
    args = parser.parse_args()

    source = Path(__file__).resolve().parents[1]
    target = Path(args.target).resolve()
    target.mkdir(parents=True, exist_ok=True)

    try:
        materialize(source, target)
    except (OSError, subprocess.CalledProcessError, ValueError, json.JSONDecodeError) as error:
        return fail(str(error))

    print(f"materialized Control Center seed in {target}")
    print("next: continue the grill-cc-bootstrap session from the target root")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
