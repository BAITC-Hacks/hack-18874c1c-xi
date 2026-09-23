"""Mutation tests prove the acceptance oracle rejects coherent wrong outputs.

Fixtures are synthetic, generated here; production is invoked only as an opaque
CLI to create a valid baseline. Oracle code never imports production algorithms.
"""

from __future__ import annotations

import copy
import csv
from datetime import date
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import main as pipeline_main, run_pipeline
from verify import SCHEMAS, VerificationError, expected_role, money, verify


def write_snapshot(directory: Path, snapshot: dict) -> None:
    """Write all four outputs coherently so the oracle cannot rely on CSV mismatch."""
    (directory / "analysis.json").write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    for filename, source in (("nodes_roles.csv", "nodes"), ("clusters.csv", "clusters"), ("top_nodes.csv", "top_nodes")):
        with (directory / filename).open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=SCHEMAS[filename])
            writer.writeheader()
            for obj in snapshot[source]:
                row = {key: obj[key] for key in SCHEMAS[filename]}
                if "top_gids" in row:
                    row["top_gids"] = json.dumps(row["top_gids"])
                writer.writerow(row)


class VerifierMutationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory(prefix="money-graph-oracle-synthetic-")
        cls.root = Path(cls.temp.name)
        cls.inputs = cls.root / "input"
        cls.inputs.mkdir()
        # Beyond JavaScript's exact integer range, but entirely synthetic IDs.
        base = 9_100_000_000_000_000
        depths = [0, 1, 2, 3, 4, 0, 0, 0, 0, 1]
        nodes = [{"gid": base + index, "depth": depth, "is_seed": depth == 0} for index, depth in enumerate(depths)]
        pairs = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (7, 1), (8, 1), (0, 9)]
        edges = [{"src": base + src, "dst": base + dst, "sum_kzt": 5000.01, "n_tx": 1, "depth": depths[src] + 1} for src, dst in pairs]
        transactions = [{"src": edge["src"], "dst": edge["dst"], "date": date(2026, 7, 1), "sum_kzt": edge["sum_kzt"]} for edge in edges]
        schemas = {
            "nodes": pa.schema([("gid", pa.int64()), ("depth", pa.int8()), ("is_seed", pa.bool_())]),
            "edges": pa.schema([("src", pa.int64()), ("dst", pa.int64()), ("sum_kzt", pa.float64()), ("n_tx", pa.int64()), ("depth", pa.int8())]),
            "transactions": pa.schema([("src", pa.int64()), ("dst", pa.int64()), ("date", pa.date32()), ("sum_kzt", pa.float64())]),
        }
        for name, records in (("nodes", nodes), ("edges", edges), ("transactions", transactions)):
            pq.write_table(pa.Table.from_pylist(records, schema=schemas[name]), cls.inputs / f"{name}.parquet")
        cls.baseline = cls.root / "baseline"
        process = subprocess.run([sys.executable, "-m", "money_graph", "--input-dir", str(cls.inputs), "--output-dir", str(cls.baseline)], capture_output=True, text=True, timeout=30)
        if process.returncode:
            raise AssertionError("Synthetic CLI baseline failed; install analytics in this Python runtime")
        cls.snapshot = json.loads((cls.baseline / "analysis.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temp.cleanup()

    def setUp(self) -> None:
        self.output = self.root / self.id().split(".")[-1]
        shutil.copytree(self.baseline, self.output)
        self.data = copy.deepcopy(self.snapshot)

    def assert_rejected(self, message: str) -> None:
        write_snapshot(self.output, self.data)
        with self.assertRaisesRegex(VerificationError, message):
            verify(self.inputs, self.output, "generic")

    def test_baseline_and_cases_pass(self) -> None:
        summary, cases = verify(self.inputs, self.output, "generic")
        self.assertEqual(summary["counts"]["n_nodes"], 10)
        self.assertEqual(summary["n_isolates"], 1)
        self.assertEqual(summary["n_inbound_only_seeds"], 1)
        self.assertEqual(summary["n_depth4"], 1)
        self.assertEqual(len(cases["arbitrary_gids"]), 3)
        self.assertEqual(cases["random_seed"], 42)

    def test_wrong_role_in_csv_and_json_is_rejected(self) -> None:
        node = next(node for node in self.data["nodes"] if node["role"] == "terminal")
        node["role"] = "peripheral"
        for row in self.data["top_nodes"]:
            if row["gid"] == node["gid"]:
                row["role"] = "peripheral"
        self.assert_rejected("first-match rule")

    def test_wrong_role_score_even_with_agreeing_csv_is_rejected(self) -> None:
        self.data["nodes"][0]["role_score"] = 0.11
        self.assert_rejected("Role score")

    def test_wrong_priority_even_with_agreeing_top_csv_is_rejected(self) -> None:
        node = self.data["nodes"][0]
        node["priority_score"] += 0.001
        for row in self.data["top_nodes"]:
            if row["gid"] == node["gid"]:
                row["priority_score"] = node["priority_score"]
        self.assert_rejected("Priority contradicts")

    def test_omitted_isolate_is_rejected(self) -> None:
        self.data["nodes"] = [node for node in self.data["nodes"] if node["metrics"]["in_degree"] + node["metrics"]["out_degree"]]
        self.assert_rejected("gid set differs")

    def test_duplicate_gid_is_rejected(self) -> None:
        self.data["nodes"][0]["gid"] = self.data["nodes"][1]["gid"]
        self.assert_rejected("Duplicate output node")

    def test_number_gid_is_rejected(self) -> None:
        self.data["nodes"][0]["gid"] = int(self.data["nodes"][0]["gid"])
        self.assert_rejected("canonical decimal text")

    def test_nonfinite_score_is_rejected(self) -> None:
        self.data["nodes"][0]["role_score"] = float("nan")
        self.assert_rejected("Non-finite JSON")

    def test_long_unicode_evidence_is_rejected(self) -> None:
        self.data["nodes"][0]["evidence"] = "я" * 201
        self.assert_rejected("Unicode character limit")

    def test_empty_evidence_is_rejected(self) -> None:
        self.data["nodes"][0]["evidence"] = " "
        self.assert_rejected("evidence")

    def test_numerically_false_evidence_is_rejected(self) -> None:
        self.data["nodes"][0]["evidence"] = "Недостаточно признаков: вход=9999, выход=9999."
        self.assert_rejected("actual directed degree")

    def test_missing_edge_is_rejected(self) -> None:
        self.data["edges"].pop()
        self.assert_rejected("edge coverage incomplete")

    def test_edge_money_precision_is_rejected(self) -> None:
        self.data["edges"][0]["sum_kzt"] = "5000.001"
        self.assert_rejected("sub-tiyn")

    def test_edge_money_changed_by_one_tiyn_is_rejected(self) -> None:
        self.data["edges"][0]["sum_kzt"] = "5000.02"
        self.assert_rejected("edge amount differs")

    def test_changed_node_money_is_rejected(self) -> None:
        self.data["nodes"][0]["metrics"]["out_sum_kzt"] = "15000.00"
        self.assert_rejected("money metric differs")

    def test_missing_seed_caveat_is_rejected(self) -> None:
        self.data["nodes"][0]["limitations"] = ["Внешние данные недоступны."]
        self.assert_rejected("Seed limitation")

    def test_boundary_cannot_be_terminal(self) -> None:
        next(node for node in self.data["nodes"] if node["depth"] == 4)["role"] = "terminal"
        self.assert_rejected("first-match rule")

    def test_zero_denominator_cannot_be_zero_ratio(self) -> None:
        self.data["nodes"][0]["metrics"]["out_in_ratio"] = 0
        self.assert_rejected("null ratio")

    def test_doubled_internal_turnover_is_rejected(self) -> None:
        self.data["clusters"][0]["sum_kzt_internal"] = str(money(self.data["clusters"][0]["sum_kzt_internal"]) * 2 / 100)
        self.assert_rejected("exact directed sum")

    def test_cluster_seed_count_is_rejected(self) -> None:
        self.data["clusters"][0]["n_seed"] += 1
        self.assert_rejected("seed count mismatch")

    def test_cluster_representative_gap_is_rejected(self) -> None:
        self.data["clusters"][0]["top_gids"] = []
        self.assert_rejected("top-three policy")

    def test_missing_top_row_is_rejected(self) -> None:
        self.data["top_nodes"].pop()
        self.assert_rejected("first 20")

    def test_rank_gap_is_rejected(self) -> None:
        self.data["top_nodes"][1]["rank"] = 3
        self.assert_rejected("Top ranking")

    def test_empty_priority_why_is_rejected(self) -> None:
        self.data["top_nodes"][0]["why"] = ""
        self.assert_rejected("why")

    def test_false_priority_why_with_correct_weights_is_rejected(self) -> None:
        self.data["top_nodes"][0]["why"] = "0.35×объём(0.000) + 0.35×вход(0.000) + 0.1×выход(0.000) + 0.2×признаки(0.000)"
        self.assert_rejected("actual normalized terms")

    def test_csv_json_disagreement_is_rejected(self) -> None:
        path = self.output / "nodes_roles.csv"
        path.write_text(path.read_text(encoding="utf-8").replace("peripheral", "terminal", 1), encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "CSV/JSON"):
            verify(self.inputs, self.output, "generic")

    def test_missing_csv_is_not_skipped(self) -> None:
        (self.output / "clusters.csv").unlink()
        with self.assertRaisesRegex(VerificationError, "Cannot read CSV"):
            verify(self.inputs, self.output, "generic")

    def test_synthetic_cannot_pass_as_official(self) -> None:
        with self.assertRaisesRegex(VerificationError, "Official dataset dimensions"):
            verify(self.inputs, self.output, "official")

    def test_missing_input_cannot_be_skipped(self) -> None:
        with self.assertRaisesRegex(VerificationError, "Required input missing"):
            verify(self.root / "absent", self.output, "official")

    def test_two_fresh_cli_runs_are_deterministic(self) -> None:
        report = run_pipeline(self.inputs, self.output / "pipeline", "generic")
        self.assertEqual(report["status"], "passed")
        self.assertTrue(report["deterministic_csv_bytes"])
        self.assertTrue(all(run["full_process_seconds"] < 300 for run in report["runs"]))
        self.assertTrue((self.output / "pipeline" / "cases.json").is_file())

    def test_existing_report_is_never_overwritten(self) -> None:
        report_dir = self.output / "existing"
        report_dir.mkdir()
        sentinel = report_dir / "pipeline.json"
        sentinel.write_text('{"sentinel":true}', encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "fresh report"):
            run_pipeline(self.inputs, report_dir, "generic")
        self.assertEqual(sentinel.read_text(), '{"sentinel":true}')

    def test_timeout_writes_failed_report_and_nonzero_exit(self) -> None:
        report_dir = self.output / "timeout"
        argv = ["pipeline.py", "--input-dir", str(self.inputs), "--report-dir", str(report_dir), "--mode", "generic"]
        with patch.object(sys, "argv", argv), patch("pipeline.subprocess.run", side_effect=subprocess.TimeoutExpired("synthetic", 300)):
            self.assertEqual(pipeline_main(), 1)
        report = json.loads((report_dir / "pipeline.json").read_text())
        self.assertEqual(report["status"], "failed")
        self.assertIn("300", report["error"])

    def test_missing_data_writes_failed_report_and_nonzero_exit(self) -> None:
        report_dir = self.output / "missing"
        argv = ["pipeline.py", "--input-dir", str(self.root / "absent"), "--report-dir", str(report_dir)]
        with patch.object(sys, "argv", argv):
            self.assertEqual(pipeline_main(), 1)
        self.assertEqual(json.loads((report_dir / "pipeline.json").read_text())["status"], "failed")


class ExactThresholdTests(unittest.TestCase):
    def test_one_tiyn_beyond_transit_boundaries_does_not_round_in(self) -> None:
        node = {"is_seed": False, "depth": 1}
        incoming = 10**18
        for outgoing in (incoming * 4 // 5 - 1, incoming * 6 // 5 + 1):
            fact = {"incoming": {"a"}, "outgoing": {"b"}, "in_minor": incoming, "out_minor": outgoing}
            self.assertEqual(expected_role(node, fact, 0)[0], "peripheral")

    def test_exact_transit_boundaries_are_inclusive(self) -> None:
        node = {"is_seed": False, "depth": 1}
        for outgoing in (80, 120):
            fact = {"incoming": {"a"}, "outgoing": {"b"}, "in_minor": 100, "out_minor": outgoing}
            self.assertEqual(expected_role(node, fact, 0)[0], "transit")


if __name__ == "__main__":
    unittest.main()
