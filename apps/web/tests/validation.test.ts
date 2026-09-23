import assert from "node:assert/strict";
import test from "node:test";
import { ROLES, type AnalysisResult } from "@money-graph/contracts";
import { fixtureResult } from "../lib/dev-fixture";
import { ContractError, parseAnalysisResult, parseRunState } from "../lib/validation";

function snapshot(count = 21): AnalysisResult {
  const nodes: AnalysisResult["nodes"] = Array.from({ length: count }, (_, index) => ({
    gid: (9223372036854775807n - BigInt(index)).toString(),
    role: ROLES[index % ROLES.length], role_score: 0.8, cluster_id: 0,
    priority_score: (count - index) / count, evidence: "Синтетическое объяснение из API.",
    depth: index % 5, is_seed: index === 0,
    metrics: { in_degree: 0, out_degree: 0, in_sum_kzt: "9007199254740993123.0123456789", out_sum_kzt: "0", n_tx_in: 0, n_tx_out: 0, out_in_ratio: null },
    limitations: ["Синтетический тест, не аналитический вывод."],
  }));
  return {
    metadata: { schema_version: "1.0", n_nodes: count, n_edges: 0, n_transactions: 0, n_seeds: count ? 1 : 0, elapsed_ms: 1.5, warnings: [] },
    nodes, edges: [],
    clusters: count ? [{ cluster_id: 0, n_nodes: count, n_seed: 1, sum_kzt_internal: "0", top_gids: [nodes[0].gid], hypothesis: "Синтетический кластер." }] : [],
    top_nodes: nodes.map((entry, i) => ({ rank: i + 1, gid: entry.gid, role: entry.role, priority_score: entry.priority_score, why: "Объяснение приоритета из API." })),
  };
}

test("preserves int64 IDs, decimal money, null ratios, every role and isolated nodes", () => {
  const source = snapshot();
  const result = parseAnalysisResult(source);
  assert.deepEqual(result, source);
  assert.equal(result.nodes[0].gid, "9223372036854775807");
  assert.equal(result.nodes[0].metrics.in_sum_kzt, "9007199254740993123.0123456789");
  assert.equal(new Set(result.nodes.map((entry) => entry.role)).size, 6);
  assert.equal(result.nodes.length, 21);
});

test("the actual development fixture passes the same validation as API results", () => {
  const result = parseAnalysisResult(fixtureResult);
  assert.deepEqual(result, fixtureResult);
  assert.equal(result.nodes.length, 24);
  assert.equal(result.edges.length, 21);
  assert.equal(result.top_nodes.length, 20);
  assert.equal(result.nodes.at(-1)?.gid, "9223372036854775807");
});

test("accepts a genuinely empty result and fewer than twenty nodes in small fixtures", () => {
  assert.deepEqual(parseAnalysisResult(snapshot(0)), snapshot(0));
  assert.equal(parseAnalysisResult(snapshot(2)).top_nodes.length, 2);
});

test("accepts the full negative int64 boundary and Unicode evidence of 200 code points", () => {
  const source = snapshot(1);
  source.nodes[0].gid = "-9223372036854775808";
  source.top_nodes[0].gid = source.nodes[0].gid;
  source.clusters[0].top_gids = [source.nodes[0].gid];
  source.nodes[0].evidence = "🔎".repeat(200);
  assert.equal(parseAnalysisResult(source).nodes[0].gid, "-9223372036854775808");
});

const invalidMutations: [string, (value: AnalysisResult) => void][] = [
  ["numeric gid", (value) => { (value.nodes[0] as unknown as Record<string, unknown>).gid = 9007199254740992; }],
  ["out-of-range gid", (value) => { value.nodes[0].gid = "9223372036854775808"; }],
  ["leading zero gid", (value) => { value.nodes[0].gid = "001"; }],
  ["numeric money", (value) => { (value.nodes[0].metrics as unknown as Record<string, unknown>).in_sum_kzt = 1; }],
  ["money with exponent", (value) => { value.nodes[0].metrics.in_sum_kzt = "1e12"; }],
  ["nonfinite ratio", (value) => { value.nodes[0].metrics.out_in_ratio = Infinity; }],
  ["nonfinite role score", (value) => { value.nodes[0].role_score = NaN; }],
  ["out-of-range priority", (value) => { value.nodes[0].priority_score = 1.1; }],
  ["unsafe count", (value) => { value.metadata.n_transactions = Number.MAX_SAFE_INTEGER + 1; }],
  ["fractional depth", (value) => { value.nodes[0].depth = 0.5; }],
  ["unsafe cluster id", (value) => { value.nodes[0].cluster_id = Number.MAX_SAFE_INTEGER + 1; }],
  ["unknown role", (value) => { (value.nodes[0] as unknown as Record<string, unknown>).role = "unknown"; }],
  ["missing required metric", (value) => { delete (value.nodes[0].metrics as unknown as Record<string, unknown>).n_tx_in; }],
  ["missing warnings", (value) => { delete (value.metadata as unknown as Record<string, unknown>).warnings; }],
  ["empty evidence", (value) => { value.nodes[0].evidence = " "; }],
  ["too long evidence", (value) => { value.nodes[0].evidence = "🔎".repeat(201); }],
  ["duplicate gid", (value) => { value.nodes[1].gid = value.nodes[0].gid; }],
  ["missing cluster", (value) => { value.nodes[0].cluster_id = 7; }],
  ["duplicate cluster", (value) => { value.clusters.push(structuredClone(value.clusters[0])); }],
  ["cluster count mismatch", (value) => { value.clusters[0].n_nodes = 1; }],
  ["seed count mismatch", (value) => { value.metadata.n_seeds = 0; }],
  ["missing cluster representative", (value) => { value.clusters[0].top_gids = ["1"]; }],
  ["dangling edge", (value) => { value.edges.push({ src: "1", dst: value.nodes[0].gid, n_tx: 1, depth: 1, sum_kzt: "1" }); value.metadata.n_edges = 1; }],
  ["missing priority rows", (value) => { value.top_nodes = value.top_nodes.slice(0, 19); }],
  ["duplicate priority row", (value) => { value.top_nodes[1] = { ...value.top_nodes[0], rank: 2 }; }],
  ["priority score mismatch", (value) => { value.top_nodes[0].priority_score = 0.01; }],
  ["priority role mismatch", (value) => { value.top_nodes[0].role = "peripheral"; }],
  ["rank gap", (value) => { value.top_nodes[1].rank = 3; }],
  ["missing why", (value) => { value.top_nodes[0].why = ""; }],
  ["wrong priority order", (value) => { [value.top_nodes[0], value.top_nodes[1]] = [value.top_nodes[1], value.top_nodes[0]]; value.top_nodes[0].rank = 1; value.top_nodes[1].rank = 2; }],
];

for (const [name, mutate] of invalidMutations) {
  test(`rejects ${name} instead of inventing a replacement`, () => {
    const source = snapshot();
    mutate(source);
    assert.throws(() => parseAnalysisResult(source), ContractError);
  });
}

test("validates tie order numerically with exact gid comparison", () => {
  const source = snapshot(2);
  source.nodes[0].priority_score = 0.5;
  source.nodes[1].priority_score = 0.5;
  source.top_nodes.forEach((entry) => { entry.priority_score = 0.5; });
  assert.throws(() => parseAnalysisResult(source), /порядок/);
  source.top_nodes.reverse().forEach((entry, index) => { entry.rank = index + 1; });
  assert.equal(parseAnalysisResult(source).top_nodes[0].gid, "9223372036854775806");
});

test("validates run identity, terminal state and backend error without changing it", () => {
  const source = { run_id: "run-1", status: "failed", elapsed_ms: 40.5, error: { code: "INVALID_PARQUET", message: "Нет столбца gid." } };
  assert.deepEqual(parseRunState(source, "run-1"), source);
  assert.throws(() => parseRunState(source, "run-2"), /другой запуск/);
  assert.throws(() => parseRunState({ ...source, status: "ready" }), ContractError);
  assert.throws(() => parseRunState({ ...source, elapsed_ms: Infinity }), ContractError);
  assert.throws(() => parseRunState({ ...source, error: undefined }), ContractError);
});
