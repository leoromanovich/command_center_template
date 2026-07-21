#!/usr/bin/env python3
"""Manage tracked repository descriptors and optional shared base clones."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
STATUSES = {"discovered", "adapted", "verified", "blocked"}


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: root must be an object")
    return data


def layout(root: Path) -> tuple[Path, Path]:
    manifest = load_json(root / "control-center.json")
    projects_root = (root / manifest["layout"]["projectsRoot"]).resolve()
    repositories_root = (root / manifest["layout"]["repositories"]).resolve()
    return projects_root, repositories_root


def descriptor_path(root: Path, identifier: str) -> Path:
    if not ID.fullmatch(identifier):
        raise ValueError("repository id must use lowercase hyphen-case")
    return root / "catalog" / "repositories" / f"{identifier}.json"


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def is_git_checkout(path: Path) -> bool:
    if not path.is_dir():
        return False
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def canonical_remote(value: str, base: Path) -> str:
    if "://" in value or re.match(r"^[^/@]+@[^:]+:", value):
        return value.rstrip("/")
    path = Path(value)
    return str((path if path.is_absolute() else base / path).resolve())


def require_remote(checkout: Path, expected: str, root: Path) -> None:
    if not is_git_checkout(checkout):
        return
    result = subprocess.run(
        ["git", "-C", str(checkout), "remote", "get-url", "origin"],
        check=True,
        capture_output=True,
        text=True,
    )
    actual = result.stdout.strip()
    if canonical_remote(actual, root) != canonical_remote(expected, root):
        raise ValueError(f"base checkout remote mismatch: expected {expected}, found {actual}")


def command_add(root: Path, args: argparse.Namespace) -> None:
    path = descriptor_path(root, args.id)
    if path.exists():
        raise ValueError(f"repository already exists: {args.id}")
    if Path(args.remote).is_absolute():
        raise ValueError("remote must be a portable Git URL, not an absolute local path")

    _, repositories_root = layout(root)
    checkout = repositories_root / args.id
    if args.clone:
        repositories_root.mkdir(parents=True, exist_ok=True)
        if checkout.exists() and not is_git_checkout(checkout):
            raise ValueError(f"checkout exists but is not a Git worktree: {checkout}")
        if not checkout.exists():
            subprocess.run(
                ["git", "clone", "--branch", args.branch, "--", args.remote, str(checkout)],
                check=True,
            )
        require_remote(checkout, args.remote, root)
    elif checkout.exists():
        if not is_git_checkout(checkout):
            raise ValueError(f"checkout exists but is not a Git worktree: {checkout}")
        require_remote(checkout, args.remote, root)

    write_json(
        path,
        {
            "schemaVersion": 1,
            "id": args.id,
            "checkout": args.id,
            "remote": args.remote,
            "defaultBranch": args.branch,
            "role": args.role,
            "sourceInput": args.source_input or args.id,
            "adapter": args.adapter or f"nix/projects/{args.id}.nix",
            "status": "discovered",
        },
    )
    state = "present" if is_git_checkout(checkout) else "absent"
    print(f"added {args.id}: base checkout {state} at {checkout}")


def command_list(root: Path, _: argparse.Namespace) -> None:
    _, repositories_root = layout(root)
    directory = root / "catalog" / "repositories"
    rows: list[tuple[str, str, str, str]] = []
    for path in sorted(directory.glob("*.json")):
        data = load_json(path)
        identifier = str(data.get("id", path.stem))
        present = "yes" if is_git_checkout(repositories_root / identifier) else "no"
        rows.append((identifier, str(data.get("status", "?")), present, str(data.get("role", "?"))))
    if not rows:
        print("no repositories")
        return
    print("ID\tSTATUS\tBASE\tROLE")
    for row in rows:
        print("\t".join(row))


def command_show(root: Path, args: argparse.Namespace) -> None:
    path = descriptor_path(root, args.id)
    print(path.read_text(encoding="utf-8"), end="")


def command_status(root: Path, args: argparse.Namespace) -> None:
    if args.status not in STATUSES:
        raise ValueError(f"unsupported status: {args.status}")
    path = descriptor_path(root, args.id)
    data = load_json(path)
    data["status"] = args.status
    write_json(path, data)
    print(f"{args.id}: {args.status}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("root", type=Path)
    subparsers = result.add_subparsers(dest="command", required=True)

    add = subparsers.add_parser("add")
    add.add_argument("id")
    add.add_argument("--remote", required=True)
    add.add_argument("--role", required=True)
    add.add_argument("--branch", default="main")
    add.add_argument("--source-input")
    add.add_argument("--adapter")
    add.add_argument("--clone", action="store_true")
    add.set_defaults(handler=command_add)

    listing = subparsers.add_parser("list")
    listing.set_defaults(handler=command_list)

    show = subparsers.add_parser("show")
    show.add_argument("id")
    show.set_defaults(handler=command_show)

    status = subparsers.add_parser("set-status")
    status.add_argument("id")
    status.add_argument("status")
    status.set_defaults(handler=command_status)
    return result


def main() -> int:
    args = parser().parse_args()
    root = args.root.resolve()
    try:
        args.handler(root, args)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
