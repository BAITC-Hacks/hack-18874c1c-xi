"""CLI behavior, using explicitly synthetic Parquet fixtures."""

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

import pyarrow as pa
import pyarrow.parquet as pq

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
        # Intentionally corrupt synthetic files, not organizer data.
        for name in ("nodes.parquet", "edges.parquet", "transactions.parquet"):
            (self.input_dir / name).write_bytes(b"dev fixture: not real Parquet")

    def test_module_entrypoint_help_succeeds_without_running_analysis(self) -> None:
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--input-dir", result.stdout)
        self.assertIn("three CSV", result.stdout)
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

    def test_invalid_parquet_never_fakes_success(self) -> None:
        self.create_presence_fixtures()
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 3)
        self.assertIn("INPUT_INVALID", result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertFalse(self.output_dir.exists())

    def test_invalid_analysis_does_not_overwrite_existing_results(self) -> None:
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

    def test_environment_check_reports_implementation_not_data_acceptance(self) -> None:
        stdout = io.StringIO()
        with patch("money_graph.cli.importlib.import_module", return_value=SimpleNamespace(__version__="dev-test")):
            with redirect_stdout(stdout):
                code = main(["--check-environment"])
        self.assertEqual(code, 0)
        report = json.loads(stdout.getvalue())
        self.assertTrue(report["pipeline_implemented"])
        self.assertEqual(set(report["dependencies"]), {"pandas", "pyarrow", "networkx"})

    def create_valid_synthetic_inputs(self) -> None:
        pq.write_table(pa.table({
            "gid": pa.array([9007199254740993, 9007199254740995], type=pa.int64()),
            "depth": pa.array([0, 0], type=pa.int64()), "is_seed": [True, True],
        }), self.input_dir / "nodes.parquet")
        for filename, schema in [
            ("edges", pa.schema([("src", pa.int64()), ("dst", pa.int64()), ("sum_kzt", pa.float64()), ("n_tx", pa.int64()), ("depth", pa.int8())])),
            ("transactions", pa.schema([("src", pa.int64()), ("dst", pa.int64()), ("date", pa.date32()), ("sum_kzt", pa.float64())])),
        ]:
            pq.write_table(pa.Table.from_pylist([], schema=schema), self.input_dir / f"{filename}.parquet")

    def test_real_module_run_produces_consistent_synthetic_artifacts(self) -> None:
        self.create_valid_synthetic_inputs()
        result = self.run_cli(*self.analysis_args())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "completed")
        self.assertEqual({p.name for p in self.output_dir.iterdir()}, {"nodes_roles.csv", "clusters.csv", "top_nodes.csv", "analysis.json"})
        snapshot = json.loads((self.output_dir / "analysis.json").read_text(encoding="utf-8"))
        self.assertEqual(snapshot["metadata"]["n_nodes"], 2)
        self.assertEqual([n["gid"] for n in snapshot["nodes"]], ["9007199254740993", "9007199254740995"])
        self.assertEqual(len(snapshot["clusters"]), 2)

    def test_successful_rerun_requires_new_output_and_preserves_old_files(self) -> None:
        self.create_valid_synthetic_inputs()
        first = self.run_cli(*self.analysis_args())
        self.assertEqual(first.returncode, 0, first.stderr)
        previous = {p.name: p.read_bytes() for p in self.output_dir.iterdir()}
        second = self.run_cli(*self.analysis_args())
        self.assertEqual(second.returncode, 5, second.stderr)
        self.assertIn("OUTPUT_FAILED", second.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.output_dir.iterdir()}, previous)


if __name__ == "__main__":
    unittest.main()
