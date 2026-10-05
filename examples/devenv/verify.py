"""Exercise real CC feature overrides and concurrent PostgreSQL environments."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run(*args, cwd, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def init_repo(path):
    run("git", "init", "-b", "main", cwd=path)
    run("git", "add", ".", cwd=path)
    run("git", "-c", "user.name=CC Test", "-c", "user.email=cc-test@example.invalid",
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
        "commit", "-m", "Pilot fixture", cwd=path)


def main():
    source = Path(sys.argv[1])
    parent = Path(tempfile.mkdtemp(prefix="cc-devenv-verify-"))
    root = parent / "control-center"
    shutil.copytree(source, root)
    root.chmod(0o755)
    # Store source files are read-only; this fixture owns its copied contents.
    for path in root.rglob("*"):
        path.chmod(path.stat().st_mode | 0o200)
    manifest = json.loads((root / "templates/control-center.json").read_text())
    manifest["name"] = "devenv-acceptance"
    (root / "control-center.json").write_text(json.dumps(manifest))
    base = parent / "repos/pilot"
    base.parent.mkdir()
    shutil.copytree(root / "examples/devenv/fixture", base)
    for path in base.iterdir():
        path.chmod(0o644)
    init_repo(base)
    run("git", "remote", "add", "origin", base.as_uri(), cwd=base)
    run("./cc", "repo", "add", "pilot", "--remote", base.as_uri(), "--role", "example",
        "--source-input", "pilot-src", cwd=root)
    init_repo(root)
    lock_before = (root / "flake.lock").read_bytes()
    for feature in ("alpha", "beta"):
        run("./cc", "worktree", "create", feature, "pilot", "--branch", f"codex/pilot-{feature}", cwd=root)
        (parent / f"worktrees/{feature}/pilot_wt/label.txt").write_text(feature + "\n")
    barrier = parent / "barrier"
    barrier.mkdir()
    env = dict(os.environ, CC_PILOT_BARRIER=str(barrier))
    env.pop("CC_FEATURE", None)
    children = []
    try:
        for feature in ("alpha", "beta"):
            log = (parent / f"{feature}.log").open("w")
            child = subprocess.Popen(["./cc", "feature", feature, "run", "devenv-pilot-test"],
                                     cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)
            children.append((child, log, feature))
        for child, log, feature in children:
            status = child.wait(timeout=900)
            log.close()
            if status:
                raise RuntimeError(f"{feature} failed ({status}); see {parent / (feature + '.log')}")
        reports = [json.loads((root / f".cc-local/devenv/{feature}/test-report.json").read_text())
                   for feature in ("alpha", "beta")]
        for feature, report in zip(("alpha", "beta"), reports):
            assert report["label"] == feature, "feature source override was ignored"
            assert report["cleanup"] == "passed"
        for field in ("api_port", "pg_port", "pgdata"):
            assert reports[0][field] != reports[1][field], f"features share {field}"
        assert (root / "flake.lock").read_bytes() == lock_before, "feature override changed the lock"
        for feature in ("alpha", "beta"):
            (parent / f"worktrees/{feature}/pilot_wt/label.txt").write_text(
                (base / "label.txt").read_text())
            run("./cc", "worktree", "remove", feature, cwd=root)
        print(json.dumps(reports, indent=2))
        print("Two feature worktrees: source overrides, ports, database isolation and cleanup passed.")
        shutil.rmtree(parent)
        return 0
    except BaseException:
        print(f"Acceptance diagnostics retained in {parent}", file=sys.stderr)
        raise
    finally:
        for child, log, _ in children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=40)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            log.close()


if __name__ == "__main__":
    raise SystemExit(main())
