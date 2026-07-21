#!/usr/bin/env python3
"""Manage feature worktrees shared under Projects/worktrees."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


FEATURE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: root must be an object")
    return data


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def git(path: Path, *arguments: str, capture: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *arguments],
        check=True,
        capture_output=capture,
        text=True,
    )
    return result.stdout.strip() if capture else ""


class Context:
    def __init__(self, root: Path, feature: str):
        if not FEATURE.fullmatch(feature):
            raise ValueError("feature must be one directory name using letters, digits, dot, dash or underscore")
        self.root = root.resolve()
        self.feature = feature
        cc = load_json(self.root / "control-center.json")
        layout = cc["layout"]
        self.cc_name = str(cc["name"])
        self.projects_root = (self.root / layout["projectsRoot"]).resolve()
        self.repositories_root = (self.root / layout["repositories"]).resolve()
        self.worktrees_root = (self.root / layout["worktrees"]).resolve()
        self.feature_root = self.worktrees_root / feature
        self.manifest_path = self.feature_root / ".cc-worktree.json"

    def new_manifest(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "feature": self.feature,
            "controlCenter": self.cc_name,
            "repositories": {},
        }

    def load_manifest(self, required: bool = True) -> dict[str, Any]:
        if not self.manifest_path.exists():
            if required:
                raise ValueError(f"feature does not exist: {self.feature}")
            return self.new_manifest()
        data = load_json(self.manifest_path)
        if data.get("feature") != self.feature:
            raise ValueError(f"manifest feature mismatch: {self.manifest_path}")
        if data.get("controlCenter") != self.cc_name:
            raise ValueError(
                f"feature belongs to Control Center '{data.get('controlCenter')}', not '{self.cc_name}'"
            )
        return data

    def project_relative(self, path: Path) -> str:
        try:
            return str(path.resolve().relative_to(self.projects_root))
        except ValueError as error:
            raise ValueError(f"path escapes Projects root: {path}") from error

    def resolve_project_path(self, value: str) -> Path:
        path = (self.projects_root / value).resolve()
        if self.projects_root not in path.parents:
            raise ValueError(f"manifest path escapes Projects root: {value}")
        return path


def repository(root: Path, identifier: str) -> dict[str, Any]:
    data = load_json(root / "catalog" / "repositories" / f"{identifier}.json")
    if data.get("id") != identifier or data.get("checkout") != identifier:
        raise ValueError(f"invalid repository descriptor: {identifier}")
    return data


def select_base_ref(base: Path, default_branch: str) -> str:
    for candidate in (f"origin/{default_branch}", default_branch):
        result = subprocess.run(
            ["git", "-C", str(base), "rev-parse", "--verify", candidate],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return candidate
    raise ValueError(f"base branch not found: {default_branch}")


def add_repositories(context: Context, manifest: dict[str, Any], identifiers: list[str], branch: str | None) -> None:
    entries = manifest.setdefault("repositories", {})
    for identifier in identifiers:
        if identifier in entries:
            raise ValueError(f"repository already belongs to feature: {identifier}")
        descriptor = repository(context.root, identifier)
        base = context.repositories_root / identifier
        git(base, "rev-parse", "--is-inside-work-tree")
        destination = context.feature_root / f"{identifier}_wt"
        if destination.exists():
            raise ValueError(f"worktree destination already exists: {destination}")

        branch_name = branch or context.feature
        branch_check = subprocess.run(
            ["git", "check-ref-format", "--branch", branch_name],
            capture_output=True,
            text=True,
        )
        if branch_check.returncode != 0:
            raise ValueError(f"invalid branch name: {branch_name}")
        base_ref = select_base_ref(base, str(descriptor["defaultBranch"]))
        base_head = git(base, "rev-parse", base_ref)
        base_relative = context.project_relative(base)
        worktree_relative = context.project_relative(destination)
        local_branch = subprocess.run(
            ["git", "-C", str(base), "show-ref", "--verify", "--quiet", f"refs/heads/{branch_name}"]
        )
        if local_branch.returncode == 0:
            git(base, "worktree", "add", str(destination), branch_name, capture=False)
        else:
            git(base, "worktree", "add", "-b", branch_name, str(destination), base_ref, capture=False)

        entries[identifier] = {
            "sourceInput": descriptor["sourceInput"],
            "branch": branch_name,
            "baseRef": base_ref,
            "baseHead": base_head,
            "base": base_relative,
            "worktree": worktree_relative,
        }


def command_create(root: Path, args: argparse.Namespace) -> None:
    context = Context(root, args.feature)
    if context.manifest_path.exists():
        raise ValueError(f"feature already exists: {args.feature}")
    manifest = context.new_manifest()
    context.feature_root.mkdir(parents=True, exist_ok=True)
    write_json(context.manifest_path, manifest)
    for identifier in args.repositories:
        add_repositories(context, manifest, [identifier], args.branch)
        write_json(context.manifest_path, manifest)
    print(f"created feature {args.feature}: {len(args.repositories)} worktree(s)")


def command_add(root: Path, args: argparse.Namespace) -> None:
    context = Context(root, args.feature)
    manifest = context.load_manifest()
    for identifier in args.repositories:
        add_repositories(context, manifest, [identifier], args.branch)
        write_json(context.manifest_path, manifest)
    print(f"added {len(args.repositories)} worktree(s) to {args.feature}")


def unpublished_commits(worktree: Path, entry: dict[str, Any]) -> int:
    upstream = subprocess.run(
        ["git", "-C", str(worktree), "rev-parse", "--abbrev-ref", "@{upstream}"],
        capture_output=True,
        text=True,
    )
    if upstream.returncode == 0:
        return int(git(worktree, "rev-list", "--count", "@{upstream}..HEAD"))
    return int(git(worktree, "rev-list", "--count", f"{entry['baseHead']}..HEAD"))


def ensure_removable(worktree: Path, entry: dict[str, Any]) -> None:
    if git(worktree, "status", "--porcelain"):
        raise ValueError(f"worktree is dirty: {worktree}")
    unpublished = unpublished_commits(worktree, entry)
    if unpublished:
        raise ValueError(f"worktree has {unpublished} unpublished commit(s): {worktree}")


def command_remove(root: Path, args: argparse.Namespace) -> None:
    context = Context(root, args.feature)
    manifest = context.load_manifest()
    entries = manifest.get("repositories", {})
    identifiers = args.repositories or sorted(entries)
    for identifier in identifiers:
        if identifier not in entries:
            raise ValueError(f"repository does not belong to feature: {identifier}")
        entry = entries[identifier]
        worktree = context.resolve_project_path(entry["worktree"])
        ensure_removable(worktree, entry)

    for identifier in identifiers:
        entry = entries[identifier]
        base = context.resolve_project_path(entry["base"])
        worktree = context.resolve_project_path(entry["worktree"])
        git(base, "worktree", "remove", str(worktree), capture=False)
        del entries[identifier]
        if entries:
            write_json(context.manifest_path, manifest)

    if entries:
        write_json(context.manifest_path, manifest)
    else:
        context.manifest_path.unlink()
        context.feature_root.rmdir()
    print(f"removed {len(identifiers)} worktree(s) from {args.feature}; branches were preserved")


def command_status(root: Path, args: argparse.Namespace) -> None:
    context = Context(root, args.feature)
    manifest = context.load_manifest()
    entries = manifest.get("repositories", {})
    if not entries:
        print(f"{args.feature}: no worktrees")
        return
    print("REPOSITORY\tBRANCH\tHEAD\tDIRTY\tUNPUBLISHED\tWORKTREE")
    for identifier, entry in sorted(entries.items()):
        worktree = context.resolve_project_path(entry["worktree"])
        branch = git(worktree, "branch", "--show-current") or "detached"
        head = git(worktree, "rev-parse", "--short", "HEAD")
        dirty = "yes" if git(worktree, "status", "--porcelain") else "no"
        unpublished = str(unpublished_commits(worktree, entry))
        print(f"{identifier}\t{branch}\t{head}\t{dirty}\t{unpublished}\t{worktree}")


def command_nix_args(root: Path, args: argparse.Namespace) -> None:
    context = Context(root, args.feature)
    manifest = context.load_manifest()
    for entry in manifest.get("repositories", {}).values():
        worktree = context.resolve_project_path(entry["worktree"])
        if not worktree.is_dir():
            raise ValueError(f"worktree is missing: {worktree}")
        print("--override-input")
        print(entry["sourceInput"])
        print(f"path:{worktree}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("root", type=Path)
    subparsers = result.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("feature")
    create.add_argument("repositories", nargs="*")
    create.add_argument("--branch")
    create.set_defaults(handler=command_create)

    add = subparsers.add_parser("add")
    add.add_argument("feature")
    add.add_argument("repositories", nargs="+")
    add.add_argument("--branch")
    add.set_defaults(handler=command_add)

    remove = subparsers.add_parser("remove")
    remove.add_argument("feature")
    remove.add_argument("repositories", nargs="*")
    remove.set_defaults(handler=command_remove)

    status = subparsers.add_parser("status")
    status.add_argument("feature")
    status.set_defaults(handler=command_status)

    nix_args = subparsers.add_parser("nix-args")
    nix_args.add_argument("feature")
    nix_args.set_defaults(handler=command_nix_args)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args.root.resolve(), args)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
