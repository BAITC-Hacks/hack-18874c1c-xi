// Explicitly synthetic contract fixture. Never used by the production API or CLI.
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const HEADERS = {
  'nodes_roles.csv': ['gid', 'role', 'role_score', 'cluster_id', 'priority_score', 'evidence'],
  'clusters.csv': ['cluster_id', 'n_nodes', 'n_seed', 'sum_kzt_internal', 'top_gids', 'hypothesis'],
  'top_nodes.csv': ['rank', 'gid', 'role', 'priority_score', 'why'],
};

function createAnalysis() {
  const gids = ['9007199254740993', '2', '10', '-9223372036854775808'];
  const money = '9007199254740993.123456789012345678';
  return {
    metadata: { schema_version: '1.0', n_nodes: 4, n_edges: 1, n_transactions: 1, n_seeds: 2, elapsed_ms: 12.5, warnings: ['Synthetic test fixture'] },
    nodes: gids.map((gid, i) => ({
      gid, role: 'peripheral', role_score: 0.25, cluster_id: i === 3 ? 2 : 1,
      priority_score: [0.9, 0.8, 0.8, 0.1][i], evidence: 'Синтетический пример, "проверка" точности',
      depth: i === 3 ? 4 : i, is_seed: i === 0 || i === 3,
      metrics: {
        in_degree: i === 1 ? 1 : 0, out_degree: i === 0 ? 1 : 0,
        in_sum_kzt: i === 1 ? money : '0', out_sum_kzt: i === 0 ? money : '0',
        n_tx_in: i === 1 ? 1 : 0, n_tx_out: i === 0 ? 1 : 0, out_in_ratio: i === 1 ? 0 : null,
      },
      limitations: ['Синтетические данные; вывод о балансе невозможен'],
    })),
    edges: [{ src: gids[0], dst: gids[1], sum_kzt: money, n_tx: 1, depth: 1 }],
    clusters: [
      { cluster_id: 1, n_nodes: 3, n_seed: 1, sum_kzt_internal: money, top_gids: [gids[0], gids[1]], hypothesis: 'Тестовая гипотеза, требует проверки' },
      { cluster_id: 2, n_nodes: 1, n_seed: 1, sum_kzt_internal: '0', top_gids: [gids[3]], hypothesis: 'Изолят: недостаточно связей' },
    ],
    top_nodes: gids.map((gid, i) => ({ rank: i + 1, gid, role: 'peripheral', priority_score: [0.9, 0.8, 0.8, 0.1][i], why: 'Приоритет только для синтетического теста' })),
  };
}

function csvRows(analysis) {
  return {
    'nodes_roles.csv': analysis.nodes.map(node => HEADERS['nodes_roles.csv'].map(key => node[key])),
    'clusters.csv': analysis.clusters.map(cluster => HEADERS['clusters.csv'].map(key => key === 'top_gids' ? JSON.stringify(cluster[key]) : cluster[key])),
    'top_nodes.csv': analysis.top_nodes.map(node => HEADERS['top_nodes.csv'].map(key => node[key])),
  };
}

function serializeCsv(rows) {
  return rows.map(row => row.map(value => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(',')).join('\r\n') + '\r\n';
}

async function writeArtifacts(outputDir, analysis = createAnalysis()) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'analysis.json'), JSON.stringify(analysis), 'utf8');
  await Promise.all(Object.entries(csvRows(analysis)).map(([name, rows]) =>
    writeFile(join(outputDir, name), serializeCsv([HEADERS[name], ...rows]), 'utf8')));
  return analysis;
}

module.exports = { createAnalysis, writeArtifacts, serializeCsv, csvRows, HEADERS };
