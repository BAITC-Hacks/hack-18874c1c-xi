"""Tests of the scaffold boundary, not of an implemented analytical pipeline."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from money_graph.cli import main


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="money-graph-cli-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.input_dir = self.root / "input"
        self.output_dir = self.root / "output"
        self.input_dir.mkdir()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        source = str(Path(__file__).resolve().parents[1] / "src")
        env["PYTHONPATH"] = source + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "money_graph", *args],
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
            timeout=10,
        )

    def analysis_args(self) -> tuple[str, ...]:
        return ("--input-dir", str(self.input_dir), "--output-dir", str(self.output_dir))

    def create_presence_fixtures(self) -> None:
        # Presence-only dev fixtures. The scaffold does not parse or validate Parquet.
        for name in ("nodes.parquet", "edges.parquet", "transactions.parquet"):
            (self.input_dir / name).write_bytes(b"dev fixture: not real Parquet")

    def test_module_entrypoint_help_succeeds_without_running_analysis(self) -> None:
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--input-dir", result.stdout)
        self.assertIn("not implemented", result.stdout)
        self.assertFalse(self.output_dir.exists())

    def test_analysis_paths_are_required(self) -> None:
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires both", result.stderr)

    def test_missing_inputs_fail_without_creating_outputs(self) -> None:
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 2)
        self.assertIn("INPUT_FILES_MISSING", result.stderr)
        self.assertIn("nodes.parquet", result.stderr)
        self.assertIn("edges.parquet", result.stderr)
        self.assertIn("transactions.parquet", result.stderr)
        self.assertFalse(self.output_dir.exists())

    def test_directory_does_not_satisfy_required_input_file(self) -> None:
        self.create_presence_fixtures()
        (self.input_dir / "edges.parquet").unlink()
        (self.input_dir / "edges.parquet").mkdir()
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 2)
        self.assertIn("INPUT_FILES_MISSING", result.stderr)
        self.assertIn("edges.parquet", result.stderr)
        self.assertFalse(self.output_dir.exists())

    def test_present_inputs_report_unimplemented_and_never_fake_success(self) -> None:
        self.create_presence_fixtures()
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 3)
        self.assertIn("PIPELINE_NOT_IMPLEMENTED", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.output_dir.exists())

    def test_unimplemented_analysis_does_not_overwrite_existing_results(self) -> None:
        self.create_presence_fixtures()
        self.output_dir.mkdir()
        existing = self.output_dir / "nodes_roles.csv"
        existing.write_text("previous result must remain unchanged", encoding="utf-8")
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 3)
        self.assertEqual(existing.read_text(encoding="utf-8"), "previous result must remain unchanged")
        self.assertEqual(list(self.output_dir.iterdir()), [existing])

    def test_environment_check_cannot_be_mistaken_for_analysis(self) -> None:
        result = self.run_cli("--check-environment", *self.analysis_args())
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot be combined", result.stderr)
        self.assertFalse(self.output_dir.exists())

    def test_environment_check_reports_import_failure(self) -> None:
        stderr = io.StringIO()
        with patch("money_graph.cli.importlib.import_module", side_effect=ImportError("missing dependency")):
            with redirect_stderr(stderr):
                code = main(["--check-environment"])
        self.assertEqual(code, 4)
        self.assertIn("DEPENDENCY_IMPORT_FAILED: pandas", stderr.getvalue())

    def test_environment_check_marks_pipeline_as_unimplemented(self) -> None:
        stdout = io.StringIO()
        with patch("money_graph.cli.importlib.import_module", return_value=SimpleNamespace(__version__="dev-test")):
            with redirect_stdout(stdout):
                code = main(["--check-environment"])
        self.assertEqual(code, 0)
        report = json.loads(stdout.getvalue())
        self.assertFalse(report["pipeline_implemented"])
        self.assertEqual(set(report["dependencies"]), {"pandas", "pyarrow", "networkx"})


if __name__ == "__main__":
    unittest.main()
