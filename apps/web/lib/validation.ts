import { ROLES, type AnalysisResult, type Cluster, type GraphEdge, type GraphNode, type Role, type RunState, type TopNode } from "@money-graph/contracts";

/** Reject broken responses before they can become apparently valid graph data. */
export class ContractError extends Error {
  constructor(path: string, expectation: string) {
    super(`Некорректный ответ API: ${path} — ${expectation}.`);
    this.name = "ContractError";
  }
}

function requireValue(condition: unknown, path: string, expectation: string): asserts condition {
  if (!condition) throw new ContractError(path, expectation);
}

function record(value: unknown, path: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), path, "ожидается объект");
  return value as Record<string, unknown>;
}

function list(value: unknown, path: string): unknown[] {
  requireValue(Array.isArray(value), path, "ожидается массив");
  return value;
}

function text(value: unknown, path: string, nonempty = true): string {
  requireValue(typeof value === "string" && (!nonempty || value.trim().length > 0), path, "ожидается строка" + (nonempty ? " с текстом" : ""));
  return value;
}

function texts(value: unknown, path: string): string[] {
  return list(value, path).map((entry, i) => text(entry, `${path}[${i}]`, false));
}

function finite(value: unknown, path: string, minimum?: number, maximum?: number): number {
  requireValue(typeof value === "number" && Number.isFinite(value), path, "ожидается конечное число");
  requireValue(minimum === undefined || value >= minimum, path, `число должно быть не меньше ${minimum}`);
  requireValue(maximum === undefined || value <= maximum, path, `число должно быть не больше ${maximum}`);
  return value;
}

function integer(value: unknown, path: string, minimum?: number): number {
  const result = finite(value, path, minimum);
  requireValue(Number.isSafeInteger(result), path, "ожидается целое число без потери точности");
  return result;
}

function gid(value: unknown, path: string): string {
  const result = text(value, path);
  requireValue(result.length <= 20 && /^-?(0|[1-9][0-9]*)$/.test(result), path, "ожидается десятичная строка int64");
  const exact = BigInt(result);
  requireValue(exact >= -9223372036854775808n && exact <= 9223372036854775807n, path, "идентификатор выходит за диапазон int64");
  return result;
}

function money(value: unknown, path: string): string {
  const result = text(value, path);
  requireValue(/^-?[0-9]+(\.[0-9]+)?$/.test(result), path, "ожидается точная десятичная строка KZT");
  return result;
}

function role(value: unknown, path: string): Role {
  requireValue(typeof value === "string" && (ROLES as readonly string[]).includes(value), path, "неизвестная роль");
  return value as Role;
}

function node(value: unknown, path: string): GraphNode {
  const entry = record(value, path);
  const metrics = record(entry.metrics, `${path}.metrics`);
  const evidence = text(entry.evidence, `${path}.evidence`);
  requireValue(Array.from(evidence).length <= 200, `${path}.evidence`, "объяснение превышает 200 символов");
  requireValue(typeof entry.is_seed === "boolean", `${path}.is_seed`, "ожидается boolean");
  return {
    gid: gid(entry.gid, `${path}.gid`),
    role: role(entry.role, `${path}.role`),
    role_score: finite(entry.role_score, `${path}.role_score`, 0, 1),
    cluster_id: integer(entry.cluster_id, `${path}.cluster_id`),
    priority_score: finite(entry.priority_score, `${path}.priority_score`, 0, 1),
    evidence,
    depth: integer(entry.depth, `${path}.depth`, 0),
    is_seed: entry.is_seed,
    metrics: {
      in_degree: integer(metrics.in_degree, `${path}.metrics.in_degree`, 0),
      out_degree: integer(metrics.out_degree, `${path}.metrics.out_degree`, 0),
      in_sum_kzt: money(metrics.in_sum_kzt, `${path}.metrics.in_sum_kzt`),
      out_sum_kzt: money(metrics.out_sum_kzt, `${path}.metrics.out_sum_kzt`),
      n_tx_in: integer(metrics.n_tx_in, `${path}.metrics.n_tx_in`, 0),
      n_tx_out: integer(metrics.n_tx_out, `${path}.metrics.n_tx_out`, 0),
      out_in_ratio: metrics.out_in_ratio === null ? null : finite(metrics.out_in_ratio, `${path}.metrics.out_in_ratio`),
    },
    limitations: texts(entry.limitations, `${path}.limitations`),
  };
}

function edge(value: unknown, path: string): GraphEdge {
  const entry = record(value, path);
  return {
    src: gid(entry.src, `${path}.src`), dst: gid(entry.dst, `${path}.dst`),
    sum_kzt: money(entry.sum_kzt, `${path}.sum_kzt`),
    n_tx: integer(entry.n_tx, `${path}.n_tx`, 0), depth: integer(entry.depth, `${path}.depth`, 0),
  };
}

function cluster(value: unknown, path: string): Cluster {
  const entry = record(value, path);
  return {
    cluster_id: integer(entry.cluster_id, `${path}.cluster_id`),
    n_nodes: integer(entry.n_nodes, `${path}.n_nodes`, 0),
    n_seed: integer(entry.n_seed, `${path}.n_seed`, 0),
    sum_kzt_internal: money(entry.sum_kzt_internal, `${path}.sum_kzt_internal`),
    top_gids: list(entry.top_gids, `${path}.top_gids`).map((value, i) => gid(value, `${path}.top_gids[${i}]`)),
    hypothesis: text(entry.hypothesis, `${path}.hypothesis`),
  };
}

function topNode(value: unknown, path: string): TopNode {
  const entry = record(value, path);
  return {
    rank: integer(entry.rank, `${path}.rank`, 1), gid: gid(entry.gid, `${path}.gid`),
    role: role(entry.role, `${path}.role`),
    priority_score: finite(entry.priority_score, `${path}.priority_score`, 0, 1),
    why: text(entry.why, `${path}.why`),
  };
}

export function parseAnalysisResult(value: unknown): AnalysisResult {
  const entry = record(value, "result");
  const metadata = record(entry.metadata, "metadata");
  requireValue(metadata.schema_version === "1.0", "metadata.schema_version", "поддерживается версия 1.0");
  const result: AnalysisResult = {
    metadata: {
      schema_version: "1.0",
      n_nodes: integer(metadata.n_nodes, "metadata.n_nodes", 0),
      n_edges: integer(metadata.n_edges, "metadata.n_edges", 0),
      n_transactions: integer(metadata.n_transactions, "metadata.n_transactions", 0),
      n_seeds: integer(metadata.n_seeds, "metadata.n_seeds", 0),
      elapsed_ms: finite(metadata.elapsed_ms, "metadata.elapsed_ms", 0),
      warnings: texts(metadata.warnings, "metadata.warnings"),
    },
    nodes: list(entry.nodes, "nodes").map((value, i) => node(value, `nodes[${i}]`)),
    edges: list(entry.edges, "edges").map((value, i) => edge(value, `edges[${i}]`)),
    clusters: list(entry.clusters, "clusters").map((value, i) => cluster(value, `clusters[${i}]`)),
    top_nodes: list(entry.top_nodes, "top_nodes").map((value, i) => topNode(value, `top_nodes[${i}]`)),
  };

  // These are integrity checks, never replacements for analytics or money arithmetic.
  requireValue(result.metadata.n_nodes === result.nodes.length, "metadata.n_nodes", "число узлов не совпадает с результатом");
  requireValue(result.metadata.n_edges === result.edges.length, "metadata.n_edges", "число рёбер не совпадает с результатом");
  const nodes = new Map<string, GraphNode>();
  const exactGids = new Set<bigint>();
  const members = new Map<number, { nodes: number; seeds: number }>();
  let nSeeds = 0;
  for (const entry of result.nodes) {
    const exact = BigInt(entry.gid);
    requireValue(!exactGids.has(exact), "nodes.gid", `повторяется gid ${entry.gid}`);
    exactGids.add(exact);
    nodes.set(entry.gid, entry);
    const counts = members.get(entry.cluster_id) ?? { nodes: 0, seeds: 0 };
    counts.nodes += 1;
    if (entry.is_seed) { counts.seeds += 1; nSeeds += 1; }
    members.set(entry.cluster_id, counts);
  }
  requireValue(result.metadata.n_seeds === nSeeds, "metadata.n_seeds", "число seeds не совпадает с узлами");
  const clusters = new Set<number>();
  for (const entry of result.clusters) {
    requireValue(!clusters.has(entry.cluster_id), "clusters.cluster_id", `повторяется кластер ${entry.cluster_id}`);
    clusters.add(entry.cluster_id);
    const counts = members.get(entry.cluster_id) ?? { nodes: 0, seeds: 0 };
    requireValue(entry.n_nodes === counts.nodes && entry.n_seed === counts.seeds, `clusters[${entry.cluster_id}]`, "счётчики кластера не совпадают с узлами");
    requireValue(new Set(entry.top_gids).size === entry.top_gids.length, "clusters.top_gids", "повторяется gid");
    for (const id of entry.top_gids) {
      requireValue(nodes.get(id)?.cluster_id === entry.cluster_id, "clusters.top_gids", `узел ${id} отсутствует в своём кластере`);
    }
  }
  for (const id of members.keys()) requireValue(clusters.has(id), "nodes.cluster_id", `отсутствует кластер ${id}`);
  const pairs = new Set<string>();
  for (const entry of result.edges) {
    requireValue(nodes.has(entry.src) && nodes.has(entry.dst), "edges", `неизвестный конец связи ${entry.src} → ${entry.dst}`);
    const pair = `${entry.src}:${entry.dst}`;
    requireValue(!pairs.has(pair), "edges", `повторяется агрегированная связь ${entry.src} → ${entry.dst}`);
    pairs.add(pair);
  }
  requireValue(result.top_nodes.length >= Math.min(20, nodes.size), "top_nodes", "не хватает приоритетных узлов");
  const topGids = new Set<string>();
  result.top_nodes.forEach((entry, index) => {
    const original = nodes.get(entry.gid);
    requireValue(original && original.role === entry.role && original.priority_score === entry.priority_score, `top_nodes[${index}]`, "узел, роль или приоритет не совпадают с nodes");
    requireValue(!topGids.has(entry.gid), "top_nodes.gid", `повторяется gid ${entry.gid}`);
    topGids.add(entry.gid);
    requireValue(entry.rank === index + 1, "top_nodes.rank", "ожидаются последовательные места от 1");
    const previous = result.top_nodes[index - 1];
    requireValue(!previous || previous.priority_score > entry.priority_score || (previous.priority_score === entry.priority_score && BigInt(previous.gid) < BigInt(entry.gid)), "top_nodes", "нарушен порядок приоритетов или числовых gid");
  });
  return result;
}

export function parseRunState(value: unknown, expectedRunId?: string): RunState {
  const entry = record(value, "run");
  const runId = text(entry.run_id, "run.run_id");
  requireValue(expectedRunId === undefined || runId === expectedRunId, "run.run_id", "API вернул другой запуск");
  requireValue(entry.status === "running" || entry.status === "completed" || entry.status === "failed", "run.status", "неизвестный статус");
  const error = entry.error === null ? null : record(entry.error, "run.error");
  return {
    run_id: runId, status: entry.status, elapsed_ms: finite(entry.elapsed_ms, "run.elapsed_ms", 0),
    error: error === null ? null : { code: text(error.code, "run.error.code"), message: text(error.message, "run.error.message") },
  };
}
