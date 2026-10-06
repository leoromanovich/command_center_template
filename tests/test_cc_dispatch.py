"""CLI contract: empty overrides, paths with spaces and feature propagation."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1]


class DispatchTest(unittest.TestCase):
    def test_nix_commands_with_and_without_feature(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = parent / "control center"
            root.mkdir()
            shutil.copy2(SOURCE / "cc", root / "cc")
            (root / "scripts").mkdir()
            shutil.copy2(SOURCE / "scripts/worktrees.py", root / "scripts/worktrees.py")
            manifest = json.loads((SOURCE / "templates/control-center.json").read_text())
            manifest["name"] = "test-cc"
            (root / "control-center.json").write_text(json.dumps(manifest))
            feature = parent / "worktrees/feature-one"
            worktree = feature / "pilot_wt"
            worktree.mkdir(parents=True)
            (feature / ".cc-worktree.json").write_text(json.dumps({
                "feature": "feature-one", "controlCenter": "test-cc",
                "repositories": {"pilot": {"sourceInput": "pilot-src",
                    "worktree": "worktrees/feature-one/pilot_wt"}},
            }))
            binary = parent / "bin"
            binary.mkdir()
            fake = binary / "nix"
            fake.write_text(f"#!{sys.executable}\nimport json, os, sys\n"
                            "print(json.dumps([sys.argv[1:], os.getenv('CC_ROOT'), os.getenv('CC_FEATURE')]))\n")
            fake.chmod(0o755)
            env = dict(os.environ, PATH=f"{binary}{os.pathsep}{os.environ['PATH']}")
            env.pop("CC_FEATURE", None)
            shells = {shutil.which("bash")}
            if sys.platform == "darwin":
                shells.add("/bin/bash")
            for shell in shells:
                for feature_name in (None, "feature-one"):
                    for command in ("show", "check", "build", "run"):
                        with self.subTest(shell=shell, feature=feature_name, command=command):
                            arguments = (["feature", feature_name] if feature_name else []) + [command]
                            if command in ("build", "run"):
                                arguments += ["pilot"]
                            arguments += ["two words"]
                            result = subprocess.run([shell, str(root / "cc"), *arguments],
                                env=env, cwd=parent, capture_output=True, text=True)
                            self.assertEqual(result.returncode, 0, result.stderr)
                            actual, cc_root, cc_feature = json.loads(result.stdout)
                            expected = ["--extra-experimental-features", "nix-command flakes"]
                            expected += ["flake", command] if command in ("show", "check") else [command]
                            if feature_name:
                                expected += ["--override-input", "pilot-src", f"path:{worktree.resolve()}"]
                            expected += [str(root) + ("#pilot" if command in ("build", "run") else "")]
                            if command == "check":
                                expected += ["--keep-going"]
                            if command == "run":
                                expected += ["--"]
                                self.assertEqual(cc_root, str(root))
                            expected += ["two words"]
                            self.assertEqual(actual, expected)
                            self.assertEqual(cc_feature, feature_name)
