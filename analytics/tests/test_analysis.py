"""Synthetic unit-level graph fixtures, never organizer-derived client labels.

InputData is built in memory: these tests exercise analytical rules separately
from the loader's four-hop/schema validation, which has its own test suite.
"""

from copy import deepcopy
from datetime import date
from math import isfinite
import random
import unittest

import networkx as nx

from money_graph.analysis import analyze, classify, cluster_graph
from money_graph.config import DEFAULT_CONFIG
from money_graph.contracts import ROLES
from money_graph.input_data import InputData, InputError


def synthetic_features(inc=1, out=1, incoming=100_00, outgoing=100_00, external=0):
    return {
        "in_degree": inc, "out_degree": out,
        "in_minor": incoming, "out_minor": outgoing,
        "external_clusters": external,
        "out_in_ratio": outgoing / incoming if incoming else None,
    }


def synthetic_node(gid=1, depth=1, seed=False):
    return {"gid": gid, "depth": depth, "is_seed": seed}


def synthetic_data(nodes, edges=(), warnings=()):
    """Edges are (src, dst, amount_minor[, n_tx]) tuples; tiny test-only data."""
    records = []
    transactions = []
    for item in edges:
        src, dst, amount = item[:3]
        count = item[3] if len(item) > 3 else 1
        records.append({"src": src, "dst": dst, "amount_minor": amount,
                        "n_tx": count, "depth": 1})
        # Keep exact totals even where count does not divide the amount.
        whole, remainder = divmod(amount, count)
        for index in range(count):
            transactions.append({"src": src, "dst": dst,
                                 "amount_minor": whole + (index < remainder),
                                 "date": date(2026, 7, 1)})
    return InputData(nodes=list(nodes), edges=records, transactions=transactions,
                     warnings=list(warnings))


class ClassificationTests(unittest.TestCase):
    def test_all_six_roles_and_score_evidence_contract(self):
        cases = {
            "coordinator": synthetic_features(5, 5, external=2),
            "consolidator": synthetic_features(3, 1),
            "distributor": synthetic_features(1, 5),
            "transit": synthetic_features(1, 1),
            "terminal": synthetic_features(1, 0, outgoing=0),
            "peripheral": synthetic_features(1, 2, outgoing=300_00),
        }
        self.assertEqual(set(cases), set(ROLES))
        for expected, features in cases.items():
            with self.subTest(role=expected):
                role, score, evidence = classify(synthetic_node(), features)
                self.assertEqual(role, expected)
                self.assertTrue(isfinite(score))
                self.assertGreaterEqual(score, 0)
                self.assertLessEqual(score, 1)
                self.assertTrue(evidence)
                self.assertLessEqual(len(evidence), 200)
                self.assertTrue(any(char.isdigit() for char in evidence))

    def test_first_matching_rule_precedence(self):
        for features, expected in (
            (synthetic_features(10, 5, external=2), "coordinator"),
            (synthetic_features(5, 10, external=2), "coordinator"),
            (synthetic_features(3, 1), "consolidator"),  # also transit
            (synthetic_features(1, 5), "distributor"),   # also transit
            (synthetic_features(3, 0, outgoing=0), "consolidator"),  # also terminal
        ):
            with self.subTest(features=features):
                self.assertEqual(classify(synthetic_node(), features)[0], expected)

    def test_coordinator_needs_both_directions_and_other_communities(self):
        for inc, out, external in ((4, 5, 2), (5, 4, 2), (5, 5, 1), (0, 10, 3), (10, 0, 3)):
            with self.subTest(inc=inc, out=out, external=external):
                self.assertNotEqual(classify(synthetic_node(seed=True, depth=0),
                                            synthetic_features(inc, out, external=external))[0],
                                    "coordinator")
        for seed in (False, True):
            role = classify(synthetic_node(seed=seed, depth=0 if seed else 1),
                            synthetic_features(5, 5, external=2))[0]
            self.assertEqual(role, "coordinator")
        self.assertEqual(classify(synthetic_node(seed=True, depth=0),
                                 synthetic_features(0, 0, incoming=0, outgoing=0))[0],
                         "peripheral")

    def test_seeds_cannot_be_transit_or_terminal_from_incomplete_inflow(self):
        seed = synthetic_node(depth=0, seed=True)
        for features in (synthetic_features(), synthetic_features(out=0, outgoing=0)):
            role, _, evidence = classify(seed, features)
            self.assertEqual(role, "peripheral")
            self.assertIn("Seed", evidence)
            self.assertIn("неполны", evidence)

    def test_depth_four_never_becomes_terminal_due_to_no_outflow(self):
        boundary = synthetic_node(depth=4)
        for inc in (1, 2, 3, 10):
            role, _, evidence = classify(boundary, synthetic_features(inc, 0, outgoing=0))
            self.assertNotEqual(role, "terminal")
            self.assertIn("Граница", evidence)
        self.assertNotEqual(classify(boundary, synthetic_features())[0], "transit")

    def test_transit_inclusive_ratio_boundaries_and_outside(self):
        for outgoing, expected in ((80_00, "transit"), (120_00, "transit"),
                                   (79_99, "peripheral"), (120_01, "peripheral")):
            with self.subTest(outgoing=outgoing):
                role, score, _ = classify(synthetic_node(), synthetic_features(outgoing=outgoing))
                self.assertEqual(role, expected)
                self.assertTrue(isfinite(score))
        self.assertGreater(classify(synthetic_node(), synthetic_features())[1],
                           classify(synthetic_node(), synthetic_features(outgoing=80_00))[1])

    def test_zero_inflow_does_not_fabricate_ratio_or_transit(self):
        features = synthetic_features(0, 1, incoming=0)
        self.assertIsNone(features["out_in_ratio"])
        self.assertEqual(classify(synthetic_node(), features)[0], "peripheral")

    def test_transit_thresholds_use_exact_money_even_when_json_ratio_rounds(self):
        incoming = 10**18
        lower, upper = incoming * 4 // 5, incoming * 6 // 5
        # One tiyn outside a threshold can round to the identical JSON float.
        # Presentation precision must not decide membership in a financial rule.
        self.assertEqual((lower - 1) / incoming, lower / incoming)
        self.assertEqual((upper + 1) / incoming, upper / incoming)
        for outgoing, expected in (
            (lower - 1, "peripheral"), (lower, "transit"),
            (lower + 1, "transit"), (upper - 1, "transit"),
            (upper, "transit"), (upper + 1, "peripheral"),
        ):
            with self.subTest(outgoing=outgoing):
                features = synthetic_features(incoming=incoming, outgoing=outgoing)
                self.assertEqual(classify(synthetic_node(), features)[0], expected)

    def test_score_bounds_under_extreme_structural_strength(self):
        for features in (synthetic_features(10**6, 10**6, external=100),
                         synthetic_features(10**6, 0, outgoing=0),
                         synthetic_features(0, 10**6, incoming=0),
                         synthetic_features(0, 0, incoming=0, outgoing=0)):
            role, score, _ = classify(synthetic_node(), features)
            self.assertIn(role, ROLES)
            self.assertTrue(isfinite(score))
            self.assertGreaterEqual(score, 0)
            self.assertLessEqual(score, 1)

    def test_evidence_length_even_for_large_valid_monetary_values(self):
        # Exact financial values remain in metrics; role evidence must still
        # satisfy its <=200 Unicode-character contract, regardless of magnitude.
        for features, expected in (
            (synthetic_features(1, 5, outgoing=5 * 10**200), "distributor"),
            (synthetic_features(3, 0, incoming=3 * 10**200, outgoing=0), "consolidator"),
        ):
            with self.subTest(role=expected):
                role, _, evidence = classify(synthetic_node(), features)
                self.assertEqual(role, expected)
                self.assertLessEqual(len(evidence), 200)


class AnalyzeTests(unittest.TestCase):
    def test_isolated_nodes_get_individual_clusters_and_numeric_tie_breaking(self):
        # Neither 19 isolates nor 2248 nodes is an algorithmic constant.
        gids = [2, 10, 100] + list(range(1000, 1034))
        data = synthetic_data([synthetic_node(gid, depth=0, seed=True) for gid in reversed(gids)])
        result = analyze(data)
        self.assertEqual(len(result["nodes"]), len(gids))
        self.assertEqual(len(result["clusters"]), len(gids))
        self.assertEqual(len(result["top_nodes"]), DEFAULT_CONFIG.top_count)
        self.assertEqual([n["gid"] for n in result["top_nodes"]],
                         [str(gid) for gid in sorted(gids)[:DEFAULT_CONFIG.top_count]])
        self.assertEqual([n["rank"] for n in result["top_nodes"]], list(range(1, 21)))
        for node in result["nodes"]:
            self.assertEqual(node["role"], "peripheral")
            self.assertEqual(node["role_score"], 0)
            self.assertEqual(node["priority_score"], 0)
            self.assertIsNone(node["metrics"]["out_in_ratio"])
            self.assertIn("переводов нет", node["evidence"])
        for cluster in result["clusters"]:
            self.assertEqual(cluster["n_nodes"], 1)
            self.assertEqual(cluster["n_seed"], 1)
            self.assertEqual(cluster["sum_kzt_internal"], "0.00")
            self.assertEqual(len(cluster["top_gids"]), 1)
            self.assertIn("Изолированный", cluster["hypothesis"])

    def test_small_graph_top_contains_every_node(self):
        result = analyze(synthetic_data([synthetic_node(2, 0, True), synthetic_node(10, 0, True)]))
        self.assertEqual([n["gid"] for n in result["top_nodes"]], ["2", "10"])
        self.assertEqual([n["rank"] for n in result["top_nodes"]], [1, 2])

    def test_directions_degrees_counts_ratio_and_money_are_exact(self):
        source, middle, sink = 9_007_199_254_740_993, 9_007_199_254_740_994, 9_007_199_254_740_995
        result = analyze(synthetic_data(
            [synthetic_node(source, 0, True), synthetic_node(middle), synthetic_node(sink, 2)],
            [(source, middle, 12345, 3), (middle, sink, 12345, 2)],
        ))
        by_gid = {n["gid"]: n for n in result["nodes"]}
        self.assertEqual(by_gid[str(middle)]["metrics"], {
            "in_degree": 1, "out_degree": 1, "in_sum_kzt": "123.45", "out_sum_kzt": "123.45",
            "n_tx_in": 3, "n_tx_out": 2, "out_in_ratio": 1.0,
        })
        self.assertIsNone(by_gid[str(source)]["metrics"]["out_in_ratio"])
        self.assertEqual(by_gid[str(sink)]["metrics"]["out_in_ratio"], 0)
        self.assertEqual(by_gid[str(middle)]["role"], "transit")
        self.assertEqual(by_gid[str(sink)]["role"], "terminal")
        self.assertEqual(result["metadata"]["n_transactions"], 5)
        self.assertEqual(result["edges"][0]["src"], str(source))
        self.assertEqual(result["edges"][0]["dst"], str(middle))
        self.assertEqual(result["edges"][0]["sum_kzt"], "123.45")

    def test_observation_limitations_and_original_warnings_remain_visible(self):
        nodes = [synthetic_node(gid, gid, gid == 0) for gid in range(5)]
        nodes += [synthetic_node(6, 0, True), synthetic_node(7, 1), synthetic_node(9, 0, True)]
        edges = [(gid, gid + 1, 100_00) for gid in range(4)] + [(6, 7, 50_00)]
        result = analyze(synthetic_data(nodes, edges, warnings=["synthetic duplicate warning"]))
        by_gid = {n["gid"]: n for n in result["nodes"]}
        for node in result["nodes"]:
            text = " ".join(node["limitations"])
            self.assertIn("не являются полным балансом", text)
        self.assertIn("Seed", " ".join(by_gid["0"]["limitations"]))
        self.assertIn("не определён", " ".join(by_gid["0"]["limitations"]))
        self.assertIn("depth=4", " ".join(by_gid["4"]["limitations"]))
        self.assertNotEqual(by_gid["4"]["role"], "terminal")
        self.assertIn("Нет наблюдаемых рёбер", " ".join(by_gid["9"]["limitations"]))
        for gid in ("2", "7"):
            self.assertIn("не время удержания или остаток", " ".join(by_gid[gid]["limitations"]))
        warnings = " ".join(result["metadata"]["warnings"])
        self.assertIn("synthetic duplicate warning", warnings)
        self.assertIn("ground truth отсутствует", warnings)
        self.assertIn("5000 KZT", warnings)
        self.assertIn("не являются вероятностью", warnings)

    def test_reciprocal_edges_and_self_loop_count_once_in_financial_totals(self):
        result = analyze(synthetic_data(
            [synthetic_node(1, 0, True), synthetic_node(2)],
            [(1, 2, 1234), (2, 1, 456), (1, 1, 123)],
        ))
        self.assertEqual(len(result["clusters"]), 1)
        self.assertEqual(result["clusters"][0]["sum_kzt_internal"], "18.13")
        by_gid = {n["gid"]: n for n in result["nodes"]}
        self.assertEqual(by_gid["1"]["metrics"]["in_sum_kzt"], "5.79")
        self.assertEqual(by_gid["1"]["metrics"]["out_sum_kzt"], "13.57")
        self.assertEqual(by_gid["1"]["metrics"]["in_degree"], 2)
        self.assertEqual(by_gid["1"]["metrics"]["out_degree"], 2)
        self.assertEqual(len(result["edges"]), 3)

    def test_disconnected_components_never_merge_and_clusters_are_connected(self):
        graph = nx.DiGraph()
        graph.add_nodes_from([100, 101, 3, 2, 1, 20])
        for src, dst in ((1, 2), (2, 3), (3, 1), (100, 101)):
            graph.add_edge(src, dst, amount_minor=100_00)
        mapping = cluster_graph(graph)
        self.assertEqual(set(mapping), set(graph))
        self.assertEqual(mapping[1], mapping[2])
        self.assertEqual(mapping[1], mapping[3])
        self.assertEqual(mapping[100], mapping[101])
        self.assertNotEqual(mapping[1], mapping[100])
        self.assertNotIn(mapping[20], (mapping[1], mapping[100]))
        self.assertEqual(mapping[1], 0)  # largest first
        for cluster_id in set(mapping.values()):
            members = [gid for gid, cluster in mapping.items() if cluster == cluster_id]
            self.assertTrue(nx.is_connected(graph.subgraph(members).to_undirected()))

    def test_shuffled_inputs_are_deterministic_and_not_mutated(self):
        nodes = [synthetic_node(gid, 0, True) for gid in range(1, 14)]
        edges = []
        for start in (1, 5, 9):
            members = range(start, start + 4)
            edges.extend((a, b, 100_00 + a, 2) for a in members for b in members if a != b)
        edges.extend([(4, 5, 100), (8, 9, 100)])
        data = synthetic_data(nodes, edges)
        before = deepcopy(data)
        expected = analyze(data)
        self.assertEqual(data, before)
        for seed in range(4):
            shuffled = deepcopy(data)
            rng = random.Random(seed)
            rng.shuffle(shuffled.nodes)
            rng.shuffle(shuffled.edges)
            rng.shuffle(shuffled.transactions)
            self.assertEqual(analyze(shuffled), expected)

    def test_contract_types_scores_evidence_and_cluster_representatives(self):
        nodes = [synthetic_node(gid, 0, True) for gid in range(1, 31)]
        edges = [(1, gid, 10_001 * gid) for gid in range(2, 31)]
        result = analyze(synthetic_data(nodes, edges))
        by_gid = {n["gid"]: n for n in result["nodes"]}
        self.assertEqual(sum(c["n_nodes"] for c in result["clusters"]), len(nodes))
        self.assertEqual(sum(c["n_seed"] for c in result["clusters"]), len(nodes))
        for node in result["nodes"]:
            self.assertIs(type(node["gid"]), str)
            self.assertIn(node["role"], ROLES)
            self.assertGreater(len(node["evidence"]), 0)
            self.assertLessEqual(len(node["evidence"]), 200)
            for field in ("role_score", "priority_score"):
                self.assertTrue(isfinite(node[field]))
                self.assertGreaterEqual(node[field], 0)
                self.assertLessEqual(node[field], 1)
            for field in ("in_sum_kzt", "out_sum_kzt"):
                self.assertIs(type(node["metrics"][field]), str)
                self.assertRegex(node["metrics"][field], r"^\d+\.\d{2}$")
            for field in ("in_degree", "out_degree", "n_tx_in", "n_tx_out"):
                self.assertIs(type(node["metrics"][field]), int)
        for edge in result["edges"]:
            for field in ("src", "dst", "sum_kzt"):
                self.assertIs(type(edge[field]), str)
        for cluster in result["clusters"]:
            self.assertLessEqual(len(cluster["top_gids"]), DEFAULT_CONFIG.cluster_top_count)
            self.assertTrue(cluster["hypothesis"])
            self.assertIs(type(cluster["sum_kzt_internal"]), str)
            for gid in cluster["top_gids"]:
                self.assertIs(type(gid), str)
                self.assertEqual(by_gid[gid]["cluster_id"], cluster["cluster_id"])
        expected_top = sorted(result["nodes"], key=lambda n: (-n["priority_score"], int(n["gid"])))[:20]
        self.assertEqual([n["gid"] for n in result["top_nodes"]], [n["gid"] for n in expected_top])
        for top in result["top_nodes"]:
            self.assertEqual(top["role"], by_gid[top["gid"]]["role"])
            self.assertEqual(top["priority_score"], by_gid[top["gid"]]["priority_score"])
            self.assertIn("не риск виновности", top["why"])

    def test_extreme_projection_weights_succeed_or_give_controlled_input_error(self):
        # A finite float64-compatible amount must not escape as an unhandled
        # Louvain OverflowError. Exact calculation or explicit refusal is safe.
        data = synthetic_data(
            [synthetic_node(gid, 0, True) for gid in range(1, 7)],
            [(1, gid, 10**200) for gid in range(2, 7)],
        )
        try:
            result = analyze(data)
        except InputError:
            return
        self.assertEqual(result["nodes"][0]["role"], "distributor")
        for node in result["nodes"]:
            self.assertLessEqual(len(node["evidence"]), 200)


if __name__ == "__main__":
    unittest.main()
