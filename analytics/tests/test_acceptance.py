"""Optional acceptance on the organizer files, never bundled into the repository.

This suite deliberately checks this one supplied dataset, not algorithm constants.
It is skipped in clean CI without data; synthetic tests still run there.
"""

import csv
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from time import perf_counter
import unittest

import networkx as nx
import pyarrow.parquet as pq

from money_graph.analysis import analyze
from money_graph.contracts import CSV_COLUMNS, INPUT_FILENAMES
from money_graph.input_data import load_inputs
from money_graph.output import validate_snapshot


class OrganizerAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parents[2]
        cls.input_dir = Path(os.environ.get("MONEY_GRAPH_DATA_DIR", str(cls.root / "data")))
        if not all((cls.input_dir / name).is_file() for name in INPUT_FILENAMES):
            raise unittest.SkipTest("Organizer Parquet files are not present; real-data acceptance was not run")
        cls.data = load_inputs(cls.input_dir)
        cls.snapshot = analyze(cls.data)

    def test_given_dataset_profile_and_exact_turnover(self):
        self.assertEqual((len(self.data.nodes), len(self.data.edges), len(self.data.transactions)), (2248, 3119, 4840))
        self.assertEqual(sum(n["is_seed"] for n in self.data.nodes), 81)
        self.assertEqual(sum(e["amount_minor"] for e in self.data.edges), 36589001201)
        self.assertEqual(sum(t["amount_minor"] for t in self.data.transactions), 36589001201)

    def test_every_original_node_and_observation_boundary_is_preserved(self):
        validate_snapshot(self.snapshot)
        self.assertEqual({int(n["gid"]) for n in self.snapshot["nodes"]}, {n["gid"] for n in self.data.nodes})
        graph = nx.DiGraph()
        graph.add_nodes_from(n["gid"] for n in self.data.nodes)
        graph.add_edges_from((e["src"], e["dst"]) for e in self.data.edges)
        isolates = set(nx.isolates(graph))
        self.assertEqual(len(isolates), 19)
        self.assertEqual(nx.number_weakly_connected_components(graph), 35)
        nodes = {int(n["gid"]): n for n in self.snapshot["nodes"]}
        clusters = {c["cluster_id"]: c for c in self.snapshot["clusters"]}
        for gid in isolates:
            self.assertEqual(nodes[gid]["role"], "peripheral")
            self.assertEqual(clusters[nodes[gid]["cluster_id"]]["n_nodes"], 1)
        for node in nodes.values():
            if node["depth"] == 4 or node["is_seed"]:
                self.assertNotEqual(node["role"], "terminal")
        for cluster_id in clusters:
            members = [gid for gid, node in nodes.items() if node["cluster_id"] == cluster_id]
            self.assertTrue(nx.is_weakly_connected(graph.subgraph(members)))
        self.assertEqual(sum(c["n_nodes"] for c in clusters.values()), 2248)
        self.assertEqual(sum(c["n_seed"] for c in clusters.values()), 81)

    def test_shuffled_real_parquet_rows_are_reproducible(self):
        with tempfile.TemporaryDirectory(prefix="money-graph-acceptance-shuffle-") as folder:
            directory = Path(folder)
            for name in INPUT_FILENAMES:
                table = pq.read_table(self.input_dir / name)
                pq.write_table(table.take(list(reversed(range(table.num_rows)))), directory / name)
            self.assertEqual(analyze(load_inputs(directory)), self.snapshot)

    def test_full_cli_and_csv_contract_under_five_minutes(self):
        with tempfile.TemporaryDirectory(prefix="money-graph-acceptance-cli-") as folder:
            output = Path(folder) / "run"
            env = os.environ.copy()
            env["PYTHONPATH"] = str(self.root / "analytics" / "src")
            started = perf_counter()
            completed = subprocess.run([
                sys.executable, "-m", "money_graph", "--input-dir", str(self.input_dir),
                "--output-dir", str(output),
            ], cwd=self.root, env=env, capture_output=True, text=True, timeout=300, check=False)
            wall_seconds = perf_counter() - started
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertLess(wall_seconds, 300)
            self.assertEqual(json.loads(completed.stdout)["status"], "completed")
            restored = json.loads((output / "analysis.json").read_text(encoding="utf-8"))
            validate_snapshot(restored)
            restored["metadata"]["elapsed_ms"] = 0.0
            self.assertEqual(restored, self.snapshot)
            for name, columns in CSV_COLUMNS.items():
                with (output / name).open(encoding="utf-8", newline="") as handle:
                    reader = csv.DictReader(handle)
                    self.assertEqual(reader.fieldnames, list(columns))
                    rows = list(reader)
                if name == "nodes_roles.csv":
                    self.assertEqual(len(rows), 2248)
                    self.assertEqual({int(row["gid"]) for row in rows}, {n["gid"] for n in self.data.nodes})
                elif name == "top_nodes.csv":
                    self.assertGreaterEqual(len(rows), 20)
                    self.assertEqual([int(row["rank"]) for row in rows], list(range(1, len(rows) + 1)))


if __name__ == "__main__":
    unittest.main()
