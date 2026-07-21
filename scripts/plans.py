#!/usr/bin/env python3
"""Manage the tracked lifecycle of agent-ready task plans."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path


ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
LIFECYCLES = ("active", "archived", "completed")


def check_id(identifier: str) -> None:
    if not ID.fullmatch(identifier):
        raise ValueError("task id must use lowercase hyphen-case")


def lifecycle_dirs(root: Path) -> dict[str, Path]:
    result = {name: root / "plans" / name for name in LIFECYCLES}
    missing = [str(directory.relative_to(root)) for directory in result.values() if not directory.is_dir()]
    if missing:
        raise ValueError(f"plan lifecycle directories are missing: {', '.join(missing)}")
    return result


def locate(root: Path, identifier: str) -> tuple[str, Path] | None:
    check_id(identifier)
    matches = [
        (lifecycle, directory / f"{identifier}.md")
        for lifecycle, directory in lifecycle_dirs(root).items()
        if (directory / f"{identifier}.md").is_file()
    ]
    if len(matches) > 1:
        raise ValueError(f"plan exists in multiple lifecycle directories: {identifier}")
    return matches[0] if matches else None


def single_line(value: str, label: str) -> str:
    if not value.strip() or "\n" in value or "\r" in value:
        raise ValueError(f"{label} must be one non-empty line")
    return value.strip()


def command_create(root: Path, args: argparse.Namespace) -> None:
    check_id(args.id)
    if locate(root, args.id):
        raise ValueError(f"plan already exists: {args.id}")
    title = single_line(args.title, "title")
    template = (root / "templates" / "task-plan.md").read_text(encoding="utf-8")
    content = template.replace("<task-id>", args.id).replace("<outcome>", title)
    destination = lifecycle_dirs(root)["active"] / f"{args.id}.md"
    destination.write_text(content, encoding="utf-8")
    print(f"created active plan: {destination.relative_to(root)}")


def closure(content: str, lifecycle: str, detail_label: str, detail: str) -> str:
    updated, count = re.subn(
        r"^Lifecycle:\s+active$",
        f"Lifecycle: {lifecycle}",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError("active plan has no unique 'Lifecycle: active' field")
    updated, count = re.subn(
        r"## Lifecycle closure\n\nNot closed\.\s*$",
        (
            "## Lifecycle closure\n\n"
            + f"- state: {lifecycle}\n"
            + f"- date: {date.today().isoformat()}\n"
            + f"- {detail_label}: {detail}\n"
        ),
        updated,
        count=1,
    )
    if count != 1:
        raise ValueError("active plan lifecycle closure must still be 'Not closed.'")
    return updated


def transition(
    root: Path,
    identifier: str,
    lifecycle: str,
    label: str,
    detail: str,
    require_accepted: bool = False,
) -> None:
    found = locate(root, identifier)
    if found is None:
        raise ValueError(f"plan does not exist: {identifier}")
    current, source = found
    if current != "active":
        raise ValueError(f"only active plans can transition; {identifier} is {current}")
    detail = single_line(detail, label)
    source_content = source.read_text(encoding="utf-8")
    if require_accepted and not re.search(r"^Planning status:\s+accepted$", source_content, re.MULTILINE):
        raise ValueError("plan must be accepted before completion; run './cc plan accept'")
    destination = lifecycle_dirs(root)[lifecycle] / source.name
    if destination.exists():
        raise ValueError(f"destination already exists: {destination}")
    content = closure(source_content, lifecycle, label, detail)
    temporary = destination.with_suffix(".md.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(destination)
    source.unlink()
    print(f"moved plan to {destination.relative_to(root)}")


def command_archive(root: Path, args: argparse.Namespace) -> None:
    transition(root, args.id, "archived", "reason", args.reason)


def command_complete(root: Path, args: argparse.Namespace) -> None:
    transition(root, args.id, "completed", "evidence", args.evidence, require_accepted=True)


def command_accept(root: Path, args: argparse.Namespace) -> None:
    found = locate(root, args.id)
    if found is None:
        raise ValueError(f"plan does not exist: {args.id}")
    lifecycle, path = found
    if lifecycle != "active":
        raise ValueError(f"only active plans can be accepted; {args.id} is {lifecycle}")
    content = path.read_text(encoding="utf-8")
    if re.search(r"^Planning status:\s+accepted$", content, re.MULTILINE):
        print(f"plan is already accepted: {args.id}")
        return
    updated, count = re.subn(
        r"^Planning status:\s+draft$",
        "Planning status: accepted",
        content,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise ValueError("plan must have a unique 'Planning status: draft' field")
    temporary = path.with_suffix(".md.tmp")
    temporary.write_text(updated, encoding="utf-8")
    temporary.replace(path)
    print(f"accepted plan: {path.relative_to(root)}")


def command_list(root: Path, _: argparse.Namespace) -> None:
    rows: list[tuple[str, str, str]] = []
    for lifecycle, directory in lifecycle_dirs(root).items():
        for path in sorted(directory.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            status = re.search(r"^Planning status:\s+(.+)$", text, re.MULTILINE)
            rows.append((path.stem, lifecycle, status.group(1) if status else "?"))
    if not rows:
        print("no plans")
        return
    print("ID\tLIFECYCLE\tPLANNING_STATUS")
    for row in rows:
        print("\t".join(row))


def command_show(root: Path, args: argparse.Namespace) -> None:
    found = locate(root, args.id)
    if found is None:
        raise ValueError(f"plan does not exist: {args.id}")
    _, path = found
    print(path.read_text(encoding="utf-8"), end="")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("root", type=Path)
    subparsers = result.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create")
    create.add_argument("id")
    create.add_argument("--title", required=True)
    create.set_defaults(handler=command_create)

    archive = subparsers.add_parser("archive")
    archive.add_argument("id")
    archive.add_argument("--reason", required=True)
    archive.set_defaults(handler=command_archive)

    accept = subparsers.add_parser("accept")
    accept.add_argument("id")
    accept.set_defaults(handler=command_accept)

    complete = subparsers.add_parser("complete")
    complete.add_argument("id")
    complete.add_argument("--evidence", required=True)
    complete.set_defaults(handler=command_complete)

    listing = subparsers.add_parser("list")
    listing.set_defaults(handler=command_list)

    show = subparsers.add_parser("show")
    show.add_argument("id")
    show.set_defaults(handler=command_show)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args.root.resolve(), args)
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
