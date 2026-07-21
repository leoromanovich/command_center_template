#!/usr/bin/env python3
"""Validate the machine-readable Control Center bootstrap contract."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
CC_STATUSES = {"discovery", "adapting", "ready"}
REPOSITORY_STATUSES = {"discovered", "adapted", "verified", "blocked"}
EXPECTED_LAYOUT = {
    "projectsRoot": "..",
    "repositories": "../repos",
    "worktrees": "../worktrees",
    "worktreePattern": "{feature}/{repository}_wt",
}
PLAN_LIFECYCLES = ("active", "archived", "completed")


def load_json(path: Path, errors: list[str]) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{path}: required file is missing")
        return None
    except json.JSONDecodeError as error:
        errors.append(f"{path}: invalid JSON: {error}")
        return None
    if not isinstance(value, dict):
        errors.append(f"{path}: root must be an object")
        return None
    return value


def placeholder_paths(value: Any, prefix: str = "") -> list[str]:
    paths: list[str] = []
    if isinstance(value, str) and ("__" in value or value == "replace-me"):
        paths.append(prefix)
    elif isinstance(value, dict):
        for key, child in value.items():
            paths.extend(placeholder_paths(child, f"{prefix}.{key}" if prefix else key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            paths.extend(placeholder_paths(child, f"{prefix}[{index}]"))
    return paths


def validate_repository(root: Path, path: Path, errors: list[str]) -> str | None:
    data = load_json(path, errors)
    if data is None:
        return None
    relative = path.relative_to(root)
    identifier = data.get("id")
    if not isinstance(identifier, str) or not ID.fullmatch(identifier):
        errors.append(f"{relative}: id must use lowercase hyphen-case")
        return None
    if path.stem != identifier:
        errors.append(f"{relative}: filename must equal id")
    if data.get("schemaVersion") != 1:
        errors.append(f"{relative}: schemaVersion must be 1")
    if data.get("status") not in REPOSITORY_STATUSES:
        errors.append(f"{relative}: unsupported status '{data.get('status')}'")
    for field in ("remote", "defaultBranch", "role", "sourceInput", "adapter"):
        if not isinstance(data.get(field), str) or not data[field]:
            errors.append(f"{relative}: '{field}' must be a non-empty string")
    remote = data.get("remote")
    if isinstance(remote, str) and Path(remote).is_absolute():
        errors.append(f"{relative}: remote must not be an absolute local path")
    adapter = data.get("adapter")
    if isinstance(adapter, str) and (Path(adapter).is_absolute() or ".." in Path(adapter).parts):
        errors.append(f"{relative}: adapter must stay inside the Control Center")
    source_input = data.get("sourceInput")
    if isinstance(source_input, str) and not ID.fullmatch(source_input):
        errors.append(f"{relative}: sourceInput must use lowercase hyphen-case")
    checkout = data.get("checkout")
    if not isinstance(checkout, str) or checkout != identifier:
        errors.append(f"{relative}: checkout must equal id to preserve worktree naming")
    if data.get("status") in {"adapted", "verified"}:
        adapter = data.get("adapter")
        if isinstance(adapter, str) and not (root / adapter).is_file():
            errors.append(f"{relative}: adapter does not exist: {adapter}")
    for field in placeholder_paths(data):
        errors.append(f"{relative}: unresolved placeholder at {field}")
    return identifier


def validate_descriptor_group(root: Path, group: str, errors: list[str]) -> None:
    directory = root / "catalog" / group
    if not directory.is_dir():
        errors.append(f"catalog/{group}: directory is missing")
        return
    for path in sorted(directory.glob("*.json")):
        data = load_json(path, errors)
        if data is None:
            continue
        relative = path.relative_to(root)
        identifier = data.get("id")
        if not isinstance(identifier, str) or not ID.fullmatch(identifier):
            errors.append(f"{relative}: id must use lowercase hyphen-case")
        elif path.stem != identifier:
            errors.append(f"{relative}: filename must equal id")
        if data.get("schemaVersion") != 1:
            errors.append(f"{relative}: schemaVersion must be 1")
        adapter = data.get("adapter")
        if isinstance(adapter, str) and (Path(adapter).is_absolute() or ".." in Path(adapter).parts):
            errors.append(f"{relative}: adapter must stay inside the Control Center")
        if not isinstance(adapter, str) or not (root / adapter).is_file():
            errors.append(f"{relative}: adapter does not exist: {adapter}")
        for field in placeholder_paths(data):
            errors.append(f"{relative}: unresolved placeholder at {field}")


def validate_plans(root: Path, errors: list[str]) -> None:
    plans_root = root / "plans"
    if not plans_root.is_dir():
        errors.append("plans/: directory is missing")
        return
    for path in plans_root.glob("*.md"):
        errors.append(f"{path.relative_to(root)}: plans must live in a lifecycle directory")

    seen: dict[str, Path] = {}
    for lifecycle in PLAN_LIFECYCLES:
        directory = plans_root / lifecycle
        if not directory.is_dir():
            errors.append(f"plans/{lifecycle}: directory is missing")
            continue
        for path in sorted(directory.glob("*.md")):
            relative = path.relative_to(root)
            identifier = path.stem
            if not ID.fullmatch(identifier):
                errors.append(f"{relative}: filename must use lowercase hyphen-case")
            if identifier in seen:
                errors.append(f"{relative}: duplicate plan also exists at {seen[identifier].relative_to(root)}")
            seen[identifier] = path
            text = path.read_text(encoding="utf-8")
            lifecycle_fields = re.findall(r"^Lifecycle:\s+(.+)$", text, re.MULTILINE)
            if lifecycle_fields != [lifecycle]:
                errors.append(f"{relative}: Lifecycle must uniquely equal '{lifecycle}'")
            planning_status = re.findall(r"^Planning status:\s+(.+)$", text, re.MULTILINE)
            if len(planning_status) != 1 or planning_status[0] not in {"draft", "accepted"}:
                errors.append(f"{relative}: Planning status must uniquely equal 'draft' or 'accepted'")
            if lifecycle == "completed" and planning_status != ["accepted"]:
                errors.append(f"{relative}: completed plan must have Planning status 'accepted'")


def validate(root: Path) -> list[str]:
    root = root.resolve()
    errors: list[str] = []
    manifest = load_json(root / "control-center.json", errors)
    if manifest is None:
        return errors

    if manifest.get("schemaVersion") != 1:
        errors.append("control-center.json: schemaVersion must be 1")
    if not isinstance(manifest.get("name"), str) or not manifest["name"].strip():
        errors.append("control-center.json: name must be a non-empty string")
    status = manifest.get("status")
    if status not in CC_STATUSES:
        errors.append(f"control-center.json: unsupported status '{status}'")
    if manifest.get("layout") != EXPECTED_LAYOUT:
        errors.append("control-center.json: layout does not match the Projects/repos/worktrees contract")
    for field in placeholder_paths(manifest):
        errors.append(f"control-center.json: unresolved placeholder at {field}")

    repositories_dir = root / "catalog" / "repositories"
    if not repositories_dir.is_dir():
        errors.append("catalog/repositories: directory is missing")
        repositories: list[Path] = []
    else:
        repositories = sorted(repositories_dir.glob("*.json"))
    seen: set[str] = set()
    for path in repositories:
        identifier = validate_repository(root, path, errors)
        if identifier in seen:
            errors.append(f"catalog/repositories: duplicate id '{identifier}'")
        if identifier:
            seen.add(identifier)

    validate_descriptor_group(root, "workflows", errors)
    validate_descriptor_group(root, "benchmarks", errors)
    validate_plans(root, errors)

    if status == "ready":
        if not repositories:
            errors.append("control-center.json: ready CC must contain at least one repository")
        for path in repositories:
            data = load_json(path, errors)
            if data and data.get("status") != "verified":
                errors.append(f"{path.relative_to(root)}: ready CC requires status 'verified'")
    return errors


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    errors = validate(root)
    if errors:
        print("control-center validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("control-center bootstrap contract passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
