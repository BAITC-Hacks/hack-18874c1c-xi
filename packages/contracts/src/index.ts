export const ROLES = ["consolidator", "transit", "distributor", "terminal", "coordinator", "peripheral"] as const;
export type Role = (typeof ROLES)[number];
export const CSV_FILES = ["nodes_roles.csv", "clusters.csv", "top_nodes.csv"] as const;
export type CsvFile = (typeof CSV_FILES)[number];
/** Exact int64 decimal text: never convert a gid to a JS number. */
export type Gid = string;
/** Exact decimal KZT text; computation belongs to Python. */
export type Kzt = string;
export type RunStatus = "running" | "completed" | "failed";
export interface ApiError { code: string; message: string }
export interface RunState { run_id: string; status: RunStatus; elapsed_ms: number; error: ApiError | null }
export interface HealthResponse { status: "ok"; service: "api"; analytics: "not_implemented" }
export interface NodeRole {
  gid: Gid; role: Role; role_score: number; cluster_id: number; priority_score: number; evidence: string;
}
export interface NodeMetrics {
  in_degree: number; out_degree: number; in_sum_kzt: Kzt; out_sum_kzt: Kzt;
  n_tx_in: number; n_tx_out: number; out_in_ratio: number | null;
}
export interface GraphNode extends NodeRole { depth: number; is_seed: boolean; metrics: NodeMetrics; limitations: string[] }
export interface GraphEdge { src: Gid; dst: Gid; sum_kzt: Kzt; n_tx: number; depth: number }
export interface Cluster { cluster_id: number; n_nodes: number; n_seed: number; sum_kzt_internal: Kzt; top_gids: Gid[]; hypothesis: string }
export interface TopNode { rank: number; gid: Gid; role: Role; priority_score: number; why: string }
export interface AnalysisResult {
  metadata: { schema_version: "1.0"; n_nodes: number; n_edges: number; n_transactions: number; n_seeds: number; elapsed_ms: number; warnings: string[] };
  nodes: GraphNode[]; edges: GraphEdge[]; clusters: Cluster[]; top_nodes: TopNode[];
}
