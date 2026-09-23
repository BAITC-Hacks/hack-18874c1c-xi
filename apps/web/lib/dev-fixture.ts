import type { AnalysisResult, GraphNode, Role } from "@money-graph/contracts";

/**
 * Hand-authored UI examples, never a result of analysing uploaded files.
 * The application loads this module lazily only in development with ?fixture=1.
 * Roles, scores, ordering and metrics below are test inputs, not analytical rules.
 */
type FixtureRow = [
  gid: string, role: Role, cluster: number, priority: number, depth: number, seed: boolean,
  inDegree: number, outDegree: number, inKzt: string, outKzt: string,
  nTxIn: number, nTxOut: number, outInRatio: number | null,
];

const rows: FixtureRow[] = [
  ["9007199254740993", "coordinator", 1, 0.98, 0, true, 0, 2, "0", "18014398509481986.02", 0, 2, null],
  ["9007199254740994", "transit", 1, 0.96, 1, false, 1, 1, "9007199254740993.01", "9007199254740993.01", 1, 1, 1],
  ["9007199254740995", "transit", 1, 0.94, 1, false, 1, 1, "9007199254740993.01", "9007199254740993.01", 1, 1, 1],
  ["9007199254740996", "consolidator", 1, 0.92, 2, false, 2, 2, "18014398509481986.02", "18014398509481986.02", 2, 2, 1],
  ["9007199254740997", "transit", 1, 0.90, 3, false, 1, 1, "9007199254740993.01", "9007199254740993.01", 1, 1, 1],
  ["9007199254740998", "transit", 1, 0.88, 3, false, 1, 1, "9007199254740993.01", "9007199254740993.01", 1, 1, 1],
  ["9007199254740999", "peripheral", 1, 0.86, 4, false, 1, 0, "9007199254740993.01", "0", 1, 0, 0],
  ["9007199254741000", "peripheral", 1, 0.84, 4, false, 1, 0, "9007199254740993.01", "0", 1, 0, 0],
  ["9007199254741001", "coordinator", 2, 0.82, 0, true, 0, 3, "0", "15000.00", 0, 3, null],
  ["9007199254741002", "transit", 2, 0.80, 1, false, 1, 1, "5000.00", "5000.00", 1, 1, 1],
  ["9007199254741003", "terminal", 2, 0.78, 2, false, 1, 0, "5000.00", "0", 1, 0, 0],
  ["9007199254741004", "distributor", 2, 0.76, 1, false, 1, 2, "5000.00", "10000.00", 1, 2, 2],
  ["9007199254741005", "peripheral", 2, 0.74, 2, false, 1, 0, "5000.00", "0", 1, 0, 0],
  ["9007199254741006", "peripheral", 2, 0.72, 2, false, 1, 0, "5000.00", "0", 1, 0, 0],
  ["9007199254741007", "transit", 2, 0.70, 1, false, 1, 1, "5000.00", "5000.00", 1, 1, 1],
  ["9007199254741008", "terminal", 2, 0.68, 2, false, 1, 0, "5000.00", "0", 1, 0, 0],
  ["9007199254741009", "distributor", 3, 0.66, 0, true, 0, 6, "0", "75003.00", 0, 6, null],
  ["9007199254741010", "peripheral", 3, 0.64, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9007199254741011", "peripheral", 3, 0.62, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9007199254741012", "terminal", 3, 0.60, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9007199254741013", "peripheral", 3, 0.58, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9007199254741014", "peripheral", 3, 0.56, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9007199254741015", "peripheral", 3, 0.54, 1, false, 1, 0, "12500.50", "0", 1, 0, 0],
  ["9223372036854775807", "peripheral", 4, 0.52, 0, true, 0, 0, "0", "0", 0, 0, null],
];

const nodes: GraphNode[] = rows.map(([
  gid, role, cluster_id, priority_score, depth, is_seed,
  in_degree, out_degree, in_sum_kzt, out_sum_kzt, n_tx_in, n_tx_out, out_in_ratio,
]) => ({
  gid, role, cluster_id, priority_score, depth, is_seed,
  role_score: 0.8,
  evidence: "Dev-fixture: роль и оценки заданы вручную для проверки интерфейса. Это не результат анализа.",
  metrics: { in_degree, out_degree, in_sum_kzt, out_sum_kzt, n_tx_in, n_tx_out, out_in_ratio },
  limitations: [
    "Синтетический пример: численные значения не получены из реального датасета.",
    "Наблюдаемые потоки не являются полным балансом. Отсутствие исходящих связей не доказывает удержание средств.",
  ],
}));

// Explicit test explanations exercise seed, zero-denominator and depth-four states.
nodes[0].limitations.push("Входящие потоки seed неполны; при нулевом входящем обороте отношение не определено.");
nodes[6].limitations.push("Глубина 4 — граница выборки; отсутствие исходящих переводов не подтверждает роль terminal.");
nodes[23].limitations.push("Изолированный seed остаётся в графе. Связей для вывода о движении средств недостаточно.");

export const fixtureResult: AnalysisResult = {
  metadata: {
    schema_version: "1.0",
    n_nodes: 24,
    n_edges: 21,
    n_transactions: 21,
    n_seeds: 4,
    elapsed_ms: 0,
    warnings: [
      "DEV-FIXTURE: синтетические данные для проверки интерфейса. Файлы Parquet не обрабатывались.",
      "Роли, кластеры и оценки заданы вручную; время расчёта не измерялось. CSV отсутствуют.",
    ],
  },
  nodes,
  edges: [
    { src: "9007199254740993", dst: "9007199254740994", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 1 },
    { src: "9007199254740993", dst: "9007199254740995", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 1 },
    { src: "9007199254740994", dst: "9007199254740996", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 2 },
    { src: "9007199254740995", dst: "9007199254740996", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 2 },
    { src: "9007199254740996", dst: "9007199254740997", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 3 },
    { src: "9007199254740996", dst: "9007199254740998", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 3 },
    { src: "9007199254740997", dst: "9007199254740999", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 4 },
    { src: "9007199254740998", dst: "9007199254741000", sum_kzt: "9007199254740993.01", n_tx: 1, depth: 4 },
    { src: "9007199254741001", dst: "9007199254741002", sum_kzt: "5000.00", n_tx: 1, depth: 1 },
    { src: "9007199254741002", dst: "9007199254741003", sum_kzt: "5000.00", n_tx: 1, depth: 2 },
    { src: "9007199254741001", dst: "9007199254741004", sum_kzt: "5000.00", n_tx: 1, depth: 1 },
    { src: "9007199254741004", dst: "9007199254741005", sum_kzt: "5000.00", n_tx: 1, depth: 2 },
    { src: "9007199254741004", dst: "9007199254741006", sum_kzt: "5000.00", n_tx: 1, depth: 2 },
    { src: "9007199254741001", dst: "9007199254741007", sum_kzt: "5000.00", n_tx: 1, depth: 1 },
    { src: "9007199254741007", dst: "9007199254741008", sum_kzt: "5000.00", n_tx: 1, depth: 2 },
    { src: "9007199254741009", dst: "9007199254741010", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
    { src: "9007199254741009", dst: "9007199254741011", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
    { src: "9007199254741009", dst: "9007199254741012", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
    { src: "9007199254741009", dst: "9007199254741013", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
    { src: "9007199254741009", dst: "9007199254741014", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
    { src: "9007199254741009", dst: "9007199254741015", sum_kzt: "12500.50", n_tx: 1, depth: 1 },
  ],
  clusters: [
    { cluster_id: 1, n_nodes: 8, n_seed: 1, sum_kzt_internal: "72057594037927944.08", top_gids: ["9007199254740993", "9007199254740996"], hypothesis: "Dev-fixture: связанная группа для проверки отображения кластера и больших денежных строк; аналитической гипотезы нет." },
    { cluster_id: 2, n_nodes: 8, n_seed: 1, sum_kzt_internal: "35000.00", top_gids: ["9007199254741001", "9007199254741004"], hypothesis: "Dev-fixture: разветвлённая группа для проверки направлений связей. Назначение реального кластера неизвестно." },
    { cluster_id: 3, n_nodes: 7, n_seed: 1, sum_kzt_internal: "75003.00", top_gids: ["9007199254741009"], hypothesis: "Dev-fixture: группа для проверки перехода от узла к соседям. Это демонстрационная структура." },
    { cluster_id: 4, n_nodes: 1, n_seed: 1, sum_kzt_internal: "0", top_gids: ["9223372036854775807"], hypothesis: "Dev-fixture: изолированный seed; связей для предположения о назначении кластера недостаточно." },
  ],
  // Rows are already hand-ordered; no priority calculation or sorting occurs here.
  top_nodes: nodes.slice(0, 20).map((node, index) => ({
    rank: index + 1,
    gid: node.gid,
    role: node.role,
    priority_score: node.priority_score,
    why: "Dev-fixture: тестовый приоритет задан вручную для проверки таблицы и выбора узла; это не рекомендация аналитики.",
  })),
};
