"""Materialize a pinned devenv environment outside the immutable Nix store."""

import argparse
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from pathlib import Path


def prepare(root, module, yaml, instance, barrier):
    root.mkdir(parents=True, exist_ok=True)
    # JSON string escaping is also valid for these Nix string literals;
    # escape Nix interpolation independently.
    quote = lambda value: json.dumps(str(value), ensure_ascii=False).replace("${", "\\${")
    (root / "devenv.nix").write_text(
        "{ ... }: { imports = [ " + str(module) + " ];\n"
        + "env.PILOT_INSTANCE = " + quote(instance) + ";\n"
        + "env.PILOT_BARRIER = " + quote(barrier) + ";\n}\n"
    )
    shutil.copyfile(yaml, root / "devenv.yaml")


def assert_stopped(report):
    deadline = time.monotonic() + 15
    while True:
        active = []
        for key in ("api_port", "pg_port"):
            with socket.socket() as sock:
                sock.settimeout(0.2)
                if sock.connect_ex(("127.0.0.1", report[key])) == 0:
                    active.append(key)
        if not active and not Path(report["pgdata"], "postmaster.pid").exists():
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"processes survived devenv test: {active}")
        time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--devenv", required=True)
    parser.add_argument("--module", type=Path, required=True)
    parser.add_argument("--yaml", type=Path, required=True)
    parser.add_argument("action", choices=("up", "down", "shell", "test"))
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    instance = os.environ.get("CC_FEATURE", "default")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", instance):
        parser.error("invalid CC_FEATURE")
    cc_root = Path(os.environ.get("CC_ROOT", os.getcwd())).resolve()
    base = cc_root / ".cc-local" / "devenv" / instance
    base.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="test-", dir=base)) if args.action == "test" else base / "dev"
    prepare(root, args.module, args.yaml, instance, os.environ.get("CC_PILOT_BARRIER", ""))
    action = ["processes", "down"] if args.action == "down" else [args.action]
    command = [args.devenv, "--no-tui", *action, *args.arguments]
    if args.action != "test":
        os.chdir(root)
        os.execv(args.devenv, command)
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    child = subprocess.Popen(command, cwd=root, start_new_session=True)
    try:
        status = child.wait()
        if status:
            log = root / "test.log"
            if log.exists():
                print(log.read_text(), flush=True)
            return status
        report = json.loads((root / "report.json").read_text())
        assert_stopped(report)
        report["cleanup"] = "passed"
        (base / "test-report.json").write_text(json.dumps(report, indent=2) + "\n")
        print("Runtime acceptance and cleanup passed", flush=True)
        shutil.rmtree(root)
        return 0
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGINT)
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        # Also ask the supervisor to stop after interrupted/failed tests.
        if root.exists():
            try:
                subprocess.run([args.devenv, "--no-tui", "processes", "down"], cwd=root, timeout=30)
            except subprocess.TimeoutExpired:
                print("Timed out while stopping the test supervisor", flush=True)
            print(f"Runtime diagnostics retained in {root}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
