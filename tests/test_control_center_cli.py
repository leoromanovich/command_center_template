from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SOURCE = Path(__file__).resolve().parents[1]


class ControlCenterCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for lifecycle in ("active", "archived", "completed"):
            (self.root / "plans" / lifecycle).mkdir(parents=True)
        for group in ("repositories", "workflows", "benchmarks"):
            (self.root / "catalog" / group).mkdir(parents=True)
        (self.root / "templates").mkdir()
        shutil.copy2(SOURCE / "templates" / "task-plan.md", self.root / "templates" / "task-plan.md")
        shutil.copy2(
            SOURCE / "templates" / "project-knowledge-index.md",
            self.root / "templates" / "project-knowledge-index.md",
        )
        manifest = json.loads((SOURCE / "templates" / "control-center.json").read_text(encoding="utf-8"))
        manifest["name"] = "test-cc"
        (self.root / "control-center.json").write_text(json.dumps(manifest), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_script(self, script: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SOURCE / "scripts" / script), str(self.root), *arguments],
            capture_output=True,
            text=True,
        )

    def test_completion_requires_reviewed_reflection(self) -> None:
        self.assertEqual(self.run_script("plans.py", "create", "task-one", "--title", "Outcome").returncode, 0)
        self.assertEqual(self.run_script("plans.py", "accept", "task-one").returncode, 0)

        premature = self.run_script("plans.py", "complete", "task-one", "--evidence", "checks passed")
        self.assertEqual(premature.returncode, 1)
        self.assertIn("plan reflect", premature.stderr)

        reflected = self.run_script(
            "plans.py",
            "reflect",
            "task-one",
            "--summary",
            "No durable reusable knowledge discovered",
            "--evidence",
            "checks passed",
            "--no-knowledge-delta",
        )
        self.assertEqual(reflected.returncode, 0, reflected.stderr)
        self.assertEqual(
            self.run_script("plans.py", "complete", "task-one", "--evidence", "checks passed").returncode,
            0,
        )
        completed = (self.root / "plans" / "completed" / "task-one.md").read_text(encoding="utf-8")
        self.assertIn("Reflection status: reviewed", completed)
        self.assertIn("Knowledge delta:\n- none", completed)
        validated = self.run_script("validate-control-center.py")
        self.assertEqual(validated.returncode, 0, validated.stderr)

    def test_reflection_requires_existing_internal_knowledge_path(self) -> None:
        self.run_script("plans.py", "create", "task-two", "--title", "Outcome")
        self.run_script("plans.py", "accept", "task-two")
        invalid = self.run_script(
            "plans.py",
            "reflect",
            "task-two",
            "--summary",
            "Reusable lesson",
            "--evidence",
            "test output",
            "--knowledge",
            "docs/missing.md",
        )
        self.assertEqual(invalid.returncode, 1)
        self.assertIn("does not exist", invalid.stderr)

    def test_repo_add_creates_project_knowledge_index(self) -> None:
        added = self.run_script(
            "repositories.py",
            "add",
            "service-a",
            "--remote",
            "https://example.invalid/service-a.git",
            "--role",
            "service",
        )
        self.assertEqual(added.returncode, 0, added.stderr)
        descriptor = json.loads(
            (self.root / "catalog" / "repositories" / "service-a.json").read_text(encoding="utf-8")
        )
        self.assertEqual(descriptor["knowledge"], "docs/projects/service-a/index.md")
        note = self.root / descriptor["knowledge"]
        self.assertTrue(note.is_file())
        self.assertIn("id: projects.service-a", note.read_text(encoding="utf-8"))
        validated = self.run_script("validate-control-center.py")
        self.assertEqual(validated.returncode, 0, validated.stderr)


if __name__ == "__main__":
    unittest.main()
