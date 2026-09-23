"""Synthetic contract fixtures, not conclusions about the supplied dataset."""

import copy
import csv
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from money_graph.contracts import CSV_COLUMNS
from money_graph.output import OutputError, validate_snapshot, write_outputs


def snapshot_fixture(count=2):
    nodes = []
    clusters = []
    for index in range(count):
        gid = str(9007199254740993 + index)
        nodes.append({
            "gid": gid, "role": "peripheral", "role_score": 0.2,
            "cluster_id": index, "priority_score": 0.0,
            "evidence": 'Наблюдаемых связей: 0; "роль" — гипотеза.',
            "depth": 0, "is_seed": True,
            "metrics": {"in_degree": 0, "out_degree": 0, "in_sum_kzt": "0",
                        "out_sum_kzt": "0", "n_tx_in": 0, "n_tx_out": 0,
                        "out_in_ratio": None},
            "limitations": ["Нет наблюдаемых операций."],
        })
        clusters.append({"cluster_id": index, "n_nodes": 1, "n_seed": 1,
                         "sum_kzt_internal": "0", "top_gids": [gid],
                         "hypothesis": "Изолят; назначение неизвестно."})
    return {
        "metadata": {"schema_version": "1.0", "n_nodes": count, "n_edges": 0,
                     "n_transactions": 0, "n_seeds": count, "elapsed_ms": 0.5,
                     "warnings": ["Синтетический тест."]},
        "nodes": nodes, "edges": [], "clusters": clusters,
        "top_nodes": [{"rank": index + 1, "gid": node["gid"], "role": node["role"],
                       "priority_score": node["priority_score"],
                       "why": "Приоритет 0: наблюдаемых операций нет."}
                      for index, node in enumerate(nodes)],
    }


def connected_fixture():
    result = snapshot_fixture()
    first, second = result["nodes"]
    amount = "123456789012345678901234567890.12"
    result["edges"] = [{"src": first["gid"], "dst": second["gid"],
                        "sum_kzt": amount, "n_tx": 2, "depth": 1}]
    result["metadata"].update(n_edges=1, n_transactions=2)
    first["metrics"].update(out_degree=1, out_sum_kzt=amount, n_tx_out=2)
    second["metrics"].update(in_degree=1, in_sum_kzt=amount, n_tx_in=2, out_in_ratio=0)
    second["cluster_id"] = 0
    result["clusters"] = [{"cluster_id": 0, "n_nodes": 2, "n_seed": 2,
                           "sum_kzt_internal": amount,
                           "top_gids": [first["gid"], second["gid"]],
                           "hypothesis": "Одна наблюдаемая связь; требуется проверка."}]
    return result


class SnapshotTests(unittest.TestCase):
    def test_isolates_and_precise_large_amounts_are_valid(self):
        validate_snapshot(snapshot_fixture())
        validate_snapshot(connected_fixture())

    def test_aggregation_does_not_round_beyond_decimal_default_precision(self):
        value = snapshot_fixture(3)
        first, second, third = value["nodes"]
        large = "123456789012345678901234567890.12"
        total = "123456789012345678901234567890.13"
        value["edges"] = [
            {"src": first["gid"], "dst": second["gid"], "sum_kzt": large, "n_tx": 2, "depth": 1},
            {"src": first["gid"], "dst": third["gid"], "sum_kzt": "0.01", "n_tx": 1, "depth": 1},
        ]
        value["metadata"].update(n_edges=2, n_transactions=3)
        first["metrics"].update(out_degree=2, out_sum_kzt=total, n_tx_out=3)
        second["metrics"].update(in_degree=1, in_sum_kzt=large, n_tx_in=2, out_in_ratio=0)
        third["metrics"].update(in_degree=1, in_sum_kzt="0.01", n_tx_in=1, out_in_ratio=0)
        for node in value["nodes"]:
            node["cluster_id"] = 0
        value["clusters"] = [{"cluster_id": 0, "n_nodes": 3, "n_seed": 3,
                              "sum_kzt_internal": total, "top_gids": [first["gid"]],
                              "hypothesis": "Синтетический пример точной агрегации."}]
        validate_snapshot(value)
        value["clusters"][0]["sum_kzt_internal"] = "123456789012345678901234567890.14"
        with self.assertRaises(OutputError):
            validate_snapshot(value)

    def test_numeric_gid_tiebreak_and_both_int64_bounds(self):
        value = snapshot_fixture(5)
        for index, gid in enumerate((str(-(2**63)), "-1", "2", "10", str(2**63 - 1))):
            value["nodes"][index]["gid"] = gid
            value["clusters"][index]["top_gids"] = [gid]
            value["top_nodes"][index]["gid"] = gid
        validate_snapshot(value)
        value["top_nodes"][2]["gid"], value["top_nodes"][3]["gid"] = "10", "2"
        with self.assertRaises(OutputError):
            validate_snapshot(value)

    def test_intercluster_transfers_are_not_internal_cluster_turnover(self):
        value = connected_fixture()
        value["nodes"][1]["cluster_id"] = 1
        value["clusters"] = snapshot_fixture()["clusters"]
        validate_snapshot(value)

    def test_self_loop_counts_one_counterparty_and_one_internal_transfer(self):
        value = snapshot_fixture(1)
        node = value["nodes"][0]
        value["edges"] = [{"src": node["gid"], "dst": node["gid"],
                           "sum_kzt": "5.50", "n_tx": 1, "depth": 1}]
        value["metadata"].update(n_edges=1, n_transactions=1)
        node["metrics"].update(in_degree=1, out_degree=1, in_sum_kzt="5.50", out_sum_kzt="5.50",
                               n_tx_in=1, n_tx_out=1, out_in_ratio=1)
        value["clusters"][0]["sum_kzt_internal"] = "5.50"
        validate_snapshot(value)

    def test_validation_does_not_mutate_snapshot(self):
        value = connected_fixture()
        original = copy.deepcopy(value)
        validate_snapshot(value)
        self.assertEqual(value, original)

    def test_strict_shapes_and_json_types(self):
        for mutate in (
            lambda s: s.update(extra=True),
            lambda s: s["nodes"][0].pop("metrics"),
            lambda s: s["nodes"][0].update(gid=9007199254740993),
            lambda s: s["nodes"][0].update(gid="9223372036854775808"),
            lambda s: s["nodes"][0].update(gid="09007199254740993"),
            lambda s: s["nodes"][0].update(is_seed=1),
            lambda s: s["nodes"][0].update(depth=True),
            lambda s: s["nodes"][0].update(cluster_id=0.0),
            lambda s: s["nodes"][0].update(role="organizer"),
            lambda s: s["nodes"][0].update(evidence=" " * 2),
            lambda s: s["nodes"][0].update(evidence="я" * 201),
            lambda s: s["nodes"][0].update(limitations=[None]),
            lambda s: s["nodes"][0]["metrics"].update(in_sum_kzt=0),
            lambda s: s["nodes"][0]["metrics"].update(in_sum_kzt="1e3"),
            lambda s: s["nodes"][0]["metrics"].update(in_sum_kzt="NaN"),
            lambda s: s["nodes"][0]["metrics"].update(extra=1),
            lambda s: s["metadata"].update(warnings="warning"),
            lambda s: s["metadata"].update(n_nodes=True),
            lambda s: s["metadata"].update(schema_version="2.0"),
        ):
            value = snapshot_fixture()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(OutputError):
                validate_snapshot(value)

    def test_scores_and_elapsed_must_be_finite_and_bounded(self):
        for score in (float("nan"), float("inf"), float("-inf"), -0.1, 1.1, True, "0.5"):
            for field in ("role_score", "priority_score"):
                value = snapshot_fixture()
                value["nodes"][0][field] = score
                with self.subTest(score=score, field=field), self.assertRaises(OutputError):
                    validate_snapshot(value)
        for elapsed in (float("nan"), float("inf"), -1, True):
            value = snapshot_fixture()
            value["metadata"]["elapsed_ms"] = elapsed
            with self.subTest(elapsed=elapsed), self.assertRaises(OutputError):
                validate_snapshot(value)

    def test_counts_and_references_must_match(self):
        mutations = (
            lambda s: s["metadata"].update(n_nodes=3),
            lambda s: s["metadata"].update(n_edges=1),
            lambda s: s["metadata"].update(n_transactions=1),
            lambda s: s["metadata"].update(n_seeds=1),
            lambda s: s["nodes"].append(copy.deepcopy(s["nodes"][0])),
            lambda s: s["nodes"][0].update(cluster_id=999),
            lambda s: s["clusters"][0].update(n_nodes=2),
            lambda s: s["clusters"][0].update(n_seed=0),
            lambda s: s["clusters"][0].update(sum_kzt_internal="0.01"),
            lambda s: s["clusters"][0].update(top_gids=[s["nodes"][1]["gid"]]),
            lambda s: s["clusters"][0]["top_gids"].append(s["nodes"][0]["gid"]),
            lambda s: s["clusters"].append(copy.deepcopy(s["clusters"][0])),
            lambda s: s["clusters"].append({**s["clusters"][0], "cluster_id": 99}),
        )
        for mutate in mutations:
            value = snapshot_fixture()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(OutputError):
                validate_snapshot(value)

    def test_edge_and_metric_consistency(self):
        for mutate in (
            lambda s: s["edges"][0].update(src="0"),
            lambda s: s["edges"][0].update(dst="0"),
            lambda s: s["edges"].append(copy.deepcopy(s["edges"][0])),
            lambda s: s["edges"][0].update(n_tx=0),
            lambda s: s["nodes"][0]["metrics"].update(out_degree=2),
            lambda s: s["nodes"][1]["metrics"].update(n_tx_in=1),
            lambda s: s["nodes"][0]["metrics"].update(out_sum_kzt="123456789012345678901234567890.13"),
            lambda s: s["nodes"][1]["metrics"].update(out_in_ratio=None),
            lambda s: s["nodes"][1]["metrics"].update(out_in_ratio=0.1),
            lambda s: s["nodes"][1]["metrics"].update(out_in_ratio=float("nan")),
            lambda s: s["nodes"][0]["metrics"].update(out_in_ratio=0),
        ):
            value = connected_fixture()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(OutputError):
                validate_snapshot(value)

    def test_ranking_count_order_and_node_correspondence(self):
        for mutate in (
            lambda s: s["top_nodes"].pop(),
            lambda s: s["top_nodes"].reverse(),
            lambda s: s["top_nodes"][0].update(rank=2),
            lambda s: s["top_nodes"][0].update(role="transit"),
            lambda s: s["top_nodes"][0].update(priority_score=0.1),
            lambda s: s["top_nodes"][0].update(gid="1"),
            lambda s: s["top_nodes"][1].update(gid=s["top_nodes"][0]["gid"]),
            lambda s: s["top_nodes"][0].update(why=""),
        ):
            value = snapshot_fixture()
            mutate(value)
            with self.subTest(value=value), self.assertRaises(OutputError):
                validate_snapshot(value)
        value = snapshot_fixture(21)
        value["top_nodes"] = value["top_nodes"][:20]
        validate_snapshot(value)
        value["top_nodes"] = value["top_nodes"][:19]
        with self.assertRaises(OutputError):
            validate_snapshot(value)

    def test_ranking_requires_global_top_not_an_arbitrary_sorted_subset(self):
        value = snapshot_fixture(21)
        value["top_nodes"] = value["top_nodes"][1:]
        for rank, node in enumerate(value["top_nodes"], start=1):
            node["rank"] = rank
        with self.assertRaises(OutputError):
            validate_snapshot(value)


class OutputTests(unittest.TestCase):
    def test_csv_and_json_roundtrip_and_exact_columns(self):
        value = connected_fixture()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result"
            write_outputs(value, target)
            self.assertEqual(set(path.name for path in target.iterdir()), {*CSV_COLUMNS, "analysis.json"})
            self.assertEqual(json.loads((target / "analysis.json").read_text(encoding="utf-8")), value)
            for name, columns in CSV_COLUMNS.items():
                with (target / name).open(encoding="utf-8", newline="") as handle:
                    reader = csv.DictReader(handle)
                    rows = list(reader)
                    self.assertEqual(reader.fieldnames, list(columns))
                    self.assertTrue(rows)
            with (target / "clusters.csv").open(encoding="utf-8", newline="") as handle:
                row = next(csv.DictReader(handle))
                self.assertEqual(row["sum_kzt_internal"], value["clusters"][0]["sum_kzt_internal"])
                self.assertEqual(json.loads(row["top_gids"]), value["clusters"][0]["top_gids"])
            with (target / "nodes_roles.csv").open(encoding="utf-8", newline="") as handle:
                row = next(csv.DictReader(handle))
                self.assertEqual(row["gid"], value["nodes"][0]["gid"])
                self.assertEqual(row["evidence"], value["nodes"][0]["evidence"])

    def test_accepts_existing_empty_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "empty"
            target.mkdir()
            write_outputs(snapshot_fixture(), target)
            self.assertEqual(set(path.name for path in target.iterdir()), {*CSV_COLUMNS, "analysis.json"})
            self.assertEqual(json.loads((target / "analysis.json").read_text(encoding="utf-8")),
                             snapshot_fixture())

    @unittest.skipUnless(os.name == "nt", "Windows directory publication fallback")
    def test_windows_retry_failure_restores_empty_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "empty"
            target.mkdir()
            with patch("money_graph.output.os.rename", side_effect=[
                FileExistsError("destination exists"), OSError("retry failed"),
            ]):
                with self.assertRaisesRegex(OutputError, "retry failed"):
                    write_outputs(snapshot_fixture(), target)
            self.assertTrue(target.is_dir())
            self.assertEqual(list(target.iterdir()), [])
            self.assertEqual(list(Path(directory).iterdir()), [target])

    @unittest.skipUnless(os.name == "nt", "Windows directory publication fallback")
    def test_windows_retry_preserves_concurrently_created_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "empty"
            target.mkdir()
            rename = os.rename

            def publish(source, destination):
                if not target.exists():
                    target.write_text("concurrent result")
                return rename(source, destination)

            with patch("money_graph.output.os.rename", side_effect=publish):
                with self.assertRaises(OutputError):
                    write_outputs(snapshot_fixture(), target)
            self.assertTrue(target.is_file())
            self.assertEqual(target.read_text(), "concurrent result")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    @unittest.skipUnless(os.name == "nt", "Windows directory publication fallback")
    def test_windows_never_removes_directory_filled_before_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "empty"
            target.mkdir()
            rmdir = Path.rmdir

            def remove(path):
                if path == target:
                    (target / "concurrent.txt").write_text("untouched")
                return rmdir(path)

            with patch.object(Path, "rmdir", remove):
                with self.assertRaises(OutputError):
                    write_outputs(snapshot_fixture(), target)
            self.assertEqual((target / "concurrent.txt").read_text(), "untouched")
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_repeat_write_preserves_previous_result(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result"
            write_outputs(snapshot_fixture(), target)
            before = {path.name: path.read_bytes() for path in target.iterdir()}
            with self.assertRaises(OutputError):
                write_outputs(connected_fixture(), target)
            self.assertEqual(before, {path.name: path.read_bytes() for path in target.iterdir()})

    def test_nonempty_input_directory_and_file_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "nodes.parquet").write_bytes(b"untouched")
            file = root / "file"
            file.write_text("untouched")
            for target in (root, file):
                with self.subTest(target=target), self.assertRaises(OutputError):
                    write_outputs(snapshot_fixture(), target)
            self.assertEqual((root / "nodes.parquet").read_bytes(), b"untouched")
            self.assertEqual(file.read_text(), "untouched")

    def test_directory_symlink_is_refused(self):
        self._assert_symlink_refused(dangling=False)

    def test_dangling_symlink_is_refused(self):
        self._assert_symlink_refused(dangling=True)

    def _assert_symlink_refused(self, *, dangling):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "destination"
            if not dangling:
                destination.mkdir()
            link = root / "link"
            try:
                link.symlink_to(destination, target_is_directory=True)
            except OSError as error:
                if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                    self.skipTest("Windows account lacks symlink privilege; run this check in Docker/Linux")
                raise
            with self.assertRaisesRegex(OutputError, "symlinks are not allowed"):
                write_outputs(snapshot_fixture(), link)
            self.assertTrue(link.is_symlink())
            self.assertEqual(set(root.iterdir()), {link} if dangling else {link, destination})
            if not dangling:
                self.assertEqual(list(destination.iterdir()), [])

    def test_invalid_snapshot_never_creates_target(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result"
            invalid = snapshot_fixture()
            invalid["metadata"]["n_nodes"] = 99
            with self.assertRaises(OutputError):
                write_outputs(invalid, target)
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_failed_publication_cleans_temporary_files_only(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result"
            target.mkdir()
            with patch("money_graph.output.os.rename", side_effect=OSError("simulated failure")):
                with self.assertRaises(OutputError):
                    write_outputs(snapshot_fixture(), target)
            self.assertEqual(list(target.iterdir()), [])
            self.assertEqual(list(Path(directory).iterdir()), [target])

    def test_readback_corruption_blocks_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "result"
            with patch("money_graph.output.csv.DictReader", return_value=iter([])):
                with self.assertRaises(OutputError):
                    write_outputs(snapshot_fixture(), target)
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
