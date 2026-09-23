import assert from "node:assert/strict";
import test from "node:test";
import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import { createGraphElements, createNeighborhoodPositions } from "../lib/graph-layout";

function graph(count: number): AnalysisResult {
  const nodes: GraphNode[] = Array.from({ length: count }, (_, index) => ({
    gid: (9223372036854775807n - BigInt(index)).toString(),
    cluster_id: index < count - 3 ? 0 : index,
    role: "peripheral", role_score: 0.5, priority_score: index === 0 ? 1 : 0.1,
    evidence: "Synthetic layout test", depth: 4, is_seed: index === count - 1,
    metrics: { in_degree: 0, out_degree: 0, in_sum_kzt: "0", out_sum_kzt: "0", n_tx_in: 0, n_tx_out: 0, out_in_ratio: null }, limitations: [],
  }));
  const edges = nodes.slice(1, Math.max(1, count - 3)).map((node) => ({
    src: nodes[0].gid, dst: node.gid, sum_kzt: "9007199254740993", n_tx: 1, depth: 4,
  }));
  return {
    metadata: { schema_version: "1.0", n_nodes: count, n_edges: edges.length, n_transactions: edges.length, n_seeds: 1, elapsed_ms: 0, warnings: [] },
    nodes, edges, clusters: [], top_nodes: [],
  };
}

test("radial layout is deterministic across reordered input and preserves isolated exact IDs", () => {
  const input = graph(2248);
  const before = JSON.stringify(input);
  const elements = createGraphElements(input);
  const reordered = createGraphElements({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
  const positions = (items: typeof elements) => new Map(items.filter((item) => item.data.gid).map((item) => [item.data.gid, item.position]));
  assert.deepEqual(positions(elements), positions(reordered));
  assert.equal(positions(elements).size, 2248);
  assert.equal(new Set(elements.map((element) => element.data.id)).size, elements.length);
  assert.ok(positions(elements).has("9223372036854775807"));
  assert.ok(positions(elements).has(input.nodes.at(-1)!.gid));
  assert.equal(JSON.stringify(input), before);
  for (const position of positions(elements).values()) {
    assert.ok(Number.isFinite(position!.x) && Number.isFinite(position!.y));
  }
});

test("rings keep node markers apart and clusters have disjoint bounds", () => {
  const elements = createGraphElements(graph(150));
  const clients = elements.filter((element) => element.data.gid);
  for (let first = 0; first < clients.length; first += 1) {
    for (let second = first + 1; second < clients.length; second += 1) {
      const a = clients[first].position!;
      const b = clients[second].position!;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 65, "node markers must not overlap");
    }
  }
  const bounds = new Map<string, { left: number; right: number; top: number; bottom: number }>();
  for (const node of clients) {
    const p = node.position!;
    const parent = String(node.data.parent);
    const old = bounds.get(parent) ?? { left: p.x, right: p.x, top: p.y, bottom: p.y };
    bounds.set(parent, { left: Math.min(old.left, p.x), right: Math.max(old.right, p.x), top: Math.min(old.top, p.y), bottom: Math.max(old.bottom, p.y) });
  }
  const areas = [...bounds.values()];
  for (let first = 0; first < areas.length; first += 1) {
    for (let second = first + 1; second < areas.length; second += 1) {
      const a = areas[first];
      const b = areas[second];
      assert.ok(a.right + 65 < b.left || b.right + 65 < a.left || a.bottom + 65 < b.top || b.bottom + 65 < a.top);
    }
  }
});

test("empty graph has no invented nodes or positions", () => {
  assert.deepEqual(createGraphElements(graph(0)), []);
});

test("compact neighborhood preserves exact IDs and separates transfer directions", () => {
  const gid = "9223372036854775807";
  const incoming = "9007199254740993";
  const outgoing = "9007199254740994";
  const both = "9007199254740995";
  const positions = createNeighborhoodPositions(gid, [gid, incoming, incoming, both], [gid, outgoing, both]);
  assert.equal(positions.size, 4);
  assert.deepEqual(positions.get(gid), { x: 0, y: 0 });
  assert.ok(positions.get(incoming)!.x < 0);
  assert.ok(positions.get(outgoing)!.x > 0);
  assert.ok(positions.get(both)!.y < 0);
  assert.deepEqual(positions, createNeighborhoodPositions(gid, [both, incoming], [both, outgoing]));
  assert.deepEqual([...createNeighborhoodPositions(gid, [], [])], [[gid, { x: 0, y: 0 }]]);
});
