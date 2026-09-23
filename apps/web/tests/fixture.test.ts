import assert from "node:assert/strict";
import test from "node:test";
import { ROLES } from "@money-graph/contracts";
import { fixtureResult } from "../lib/dev-fixture";

test("dev fixture covers all roles, exact int64, isolated seed and depth four", () => {
  const { nodes, edges, metadata, top_nodes } = fixtureResult;
  assert.equal(nodes.length, 24);
  assert.equal(metadata.n_nodes, nodes.length);
  assert.equal(metadata.n_edges, edges.length);
  assert.equal(new Set(nodes.map((node) => node.gid)).size, nodes.length);
  assert.deepEqual(new Set(nodes.map((node) => node.role)), new Set(ROLES));
  assert.ok(nodes.every((node) => typeof node.gid === "string" && BigInt(node.gid) > BigInt(Number.MAX_SAFE_INTEGER)));
  assert.ok(edges.every((edge) => nodes.some((node) => node.gid === edge.src) && nodes.some((node) => node.gid === edge.dst)));
  const isolate = nodes.find((node) => node.gid === "9223372036854775807");
  assert.ok(isolate?.is_seed);
  assert.equal(isolate.metrics.out_in_ratio, null);
  assert.ok(!edges.some((edge) => edge.src === isolate.gid || edge.dst === isolate.gid));
  assert.ok(!top_nodes.some((node) => node.gid === isolate.gid), "search must cover nodes outside the top list");
  assert.equal(nodes.find((node) => node.gid === "9007199254740999")?.depth, 4);
  assert.equal(edges[0].sum_kzt, "9007199254740993.01");
  assert.ok(metadata.warnings.some((warning) => warning.includes("DEV-FIXTURE")));
});

test("fixture priority rows and cluster memberships agree with the snapshot", () => {
  const { nodes, top_nodes, clusters, metadata } = fixtureResult;
  assert.equal(top_nodes.length, 20);
  assert.equal(new Set(top_nodes.map((node) => node.gid)).size, 20);
  top_nodes.forEach((top, index) => {
    const node = nodes.find((candidate) => candidate.gid === top.gid);
    assert.equal(top.rank, index + 1);
    assert.equal(top.role, node?.role);
    assert.equal(top.priority_score, node?.priority_score);
    assert.ok(top.why.startsWith("Dev-fixture:"));
    if (index > 0) assert.ok(top_nodes[index - 1].priority_score >= top.priority_score);
  });
  for (const cluster of clusters) {
    const members = nodes.filter((node) => node.cluster_id === cluster.cluster_id);
    assert.equal(cluster.n_nodes, members.length);
    assert.equal(cluster.n_seed, members.filter((node) => node.is_seed).length);
    assert.ok(cluster.top_gids.every((gid) => members.some((node) => node.gid === gid)));
  }
  assert.equal(metadata.n_seeds, nodes.filter((node) => node.is_seed).length);
  assert.ok(nodes.every((node) => node.evidence.length <= 200 && node.evidence.startsWith("Dev-fixture:")));
});
