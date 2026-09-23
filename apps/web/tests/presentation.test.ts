import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import { createGraphElements } from "../components/graph-view";
import { formatKzt, ROLES_PRESENTATION } from "../lib/presentation";

test("money formatting preserves int64-scale amounts and every decimal digit", () => {
  assert.equal(formatKzt("9223372036854775807.012345678900"), "9\u202f223\u202f372\u202f036\u202f854\u202f775\u202f807,012345678900 ₸");
  assert.equal(formatKzt("-9007199254740993.00"), "-9\u202f007\u202f199\u202f254\u202f740\u202f993,00 ₸");
  assert.equal(formatKzt("0"), "0 ₸");
  assert.equal(formatKzt("0.000000001"), "0,000000001 ₸");
});

test("all six roles remain distinguishable without color", () => {
  assert.equal(Object.keys(ROLES_PRESENTATION).length, 6);
  assert.equal(new Set(Object.values(ROLES_PRESENTATION).map((role) => role.shape)).size, 6);
});

test("graph preserves exact IDs and every isolated node at dataset scale", () => {
  const nodes: GraphNode[] = Array.from({ length: 2248 }, (_, index) => ({
    gid: (9223372036854775807n - BigInt(index)).toString(),
    role: "peripheral", role_score: 0, priority_score: 0,
    cluster_id: index % 17, evidence: "Synthetic graph structure test", depth: 4, is_seed: index === 0,
    metrics: { in_degree: 0, out_degree: 0, in_sum_kzt: "0", out_sum_kzt: "0", n_tx_in: 0, n_tx_out: 0, out_in_ratio: null },
    limitations: [],
  }));
  const result: AnalysisResult = {
    metadata: { schema_version: "1.0", n_nodes: nodes.length, n_edges: 1, n_transactions: 1, n_seeds: 1, elapsed_ms: 0, warnings: [] },
    nodes,
    edges: [{ src: nodes[0].gid, dst: nodes[1].gid, sum_kzt: "9007199254740993", n_tx: 1, depth: 4 }],
    clusters: [], top_nodes: [],
  };
  const before = JSON.stringify(result);
  const elements = createGraphElements(result);
  const clients = elements.filter((element) => element.data.gid !== undefined);
  assert.equal(clients.length, 2248);
  assert.deepEqual(new Set(clients.map((element) => element.data.id)), new Set(nodes.map((node) => node.gid)));
  assert.equal(new Set(elements.map((element) => element.data.id)).size, elements.length);
  assert.equal(new Set(clients.map((element) => `${element.position?.x}:${element.position?.y}`)).size, 2248);
  assert.equal(elements.at(-1)?.data.source, "9223372036854775807");
  assert.equal(elements.at(-1)?.data.target, "9223372036854775806");
  assert.equal(JSON.stringify(result), before);
});
