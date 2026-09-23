import { CSV_FILES, type AnalysisResult, type CsvFile } from '@money-graph/contracts';
import Ajv2020 from 'ajv/dist/2020';
import { parse } from 'csv-parse/sync';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';

const schema = new Ajv2020({ strictNumbers: true }).compile<AnalysisResult>(
  require('@money-graph/contracts/analysis.schema.json'),
);
const HEADERS: Record<CsvFile, string[]> = {
  'nodes_roles.csv': ['gid', 'role', 'role_score', 'cluster_id', 'priority_score', 'evidence'],
  'clusters.csv': ['cluster_id', 'n_nodes', 'n_seed', 'sum_kzt_internal', 'top_gids', 'hypothesis'],
  'top_nodes.csv': ['rank', 'gid', 'role', 'priority_score', 'why'],
};
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const MONEY = /^-?[0-9]+(\.[0-9]+)?$/;
const MIN_GID = -(1n << 63n);
const MAX_GID = (1n << 63n) - 1n;

export class ArtifactValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid artifact: ${message}`, options);
    this.name = 'ArtifactValidationError';
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ArtifactValidationError(message);
}

async function readArtifact(outputDir: string, filename: string): Promise<Buffer> {
  try {
    const path = join(outputDir, filename);
    const before = await lstat(path);
    ensure(before.isFile() && !before.isSymbolicLink(), `${filename} must be a regular file`);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      ensure(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino,
        `${filename} changed while opening`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    throw new ArtifactValidationError(`${filename} could not be read`, { cause: error });
  }
}

function utf8(buffer: Buffer, filename: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ArtifactValidationError(`${filename} is not valid UTF-8`, { cause: error });
  }
}

function checkGid(gid: string): void {
  const value = BigInt(gid);
  ensure(value >= MIN_GID && value <= MAX_GID, 'gid must fit signed int64');
}

function safeIntegers(values: number[]): void {
  ensure(values.every(Number.isSafeInteger), 'integer fields must be safe JSON integers');
}

function finiteNumbers(value: unknown): void {
  if (typeof value === 'number') ensure(Number.isFinite(value), 'numeric fields must be finite');
  else if (Array.isArray(value)) value.forEach(finiteNumbers);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteNumbers);
}

function checkAnalysis(analysis: AnalysisResult): void {
  const { metadata, nodes, edges, clusters, top_nodes: topNodes } = analysis;
  finiteNumbers(analysis);
  safeIntegers([metadata.n_nodes, metadata.n_edges, metadata.n_transactions, metadata.n_seeds]);
  ensure(metadata.n_nodes === nodes.length && metadata.n_edges === edges.length,
    'metadata counts disagree with nodes or edges');
  ensure(metadata.n_seeds === nodes.filter(node => node.is_seed).length,
    'metadata seed count disagrees with nodes');

  const nodeByGid = new Map(nodes.map(node => [node.gid, node]));
  const numericGids = new Set(nodes.map(node => BigInt(node.gid).toString()));
  ensure(numericGids.size === nodes.length, 'node gids must be unique');
  const clusterById = new Map(clusters.map(cluster => [cluster.cluster_id, cluster]));
  ensure(clusterById.size === clusters.length, 'cluster ids must be unique');
  const membership = new Map<number, { nodes: number; seeds: number }>();
  for (const node of nodes) {
    checkGid(node.gid);
    safeIntegers([node.cluster_id, node.depth, node.metrics.in_degree, node.metrics.out_degree,
      node.metrics.n_tx_in, node.metrics.n_tx_out]);
    ensure(node.evidence.trim().length > 0, 'node evidence must be nonblank');
    ensure(clusterById.has(node.cluster_id), 'node references an unknown cluster');
    const counts = membership.get(node.cluster_id) ?? { nodes: 0, seeds: 0 };
    counts.nodes++;
    if (node.is_seed) counts.seeds++;
    membership.set(node.cluster_id, counts);
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    checkGid(edge.src);
    checkGid(edge.dst);
    safeIntegers([edge.n_tx, edge.depth]);
    ensure(nodeByGid.has(edge.src) && nodeByGid.has(edge.dst), 'edge references an unknown node');
    const key = `${edge.src}:${edge.dst}`;
    ensure(!edgeKeys.has(key), 'aggregated directed edges must be unique');
    edgeKeys.add(key);
  }
  for (const cluster of clusters) {
    safeIntegers([cluster.cluster_id, cluster.n_nodes, cluster.n_seed]);
    const counts = membership.get(cluster.cluster_id) ?? { nodes: 0, seeds: 0 };
    ensure(cluster.n_nodes === counts.nodes && cluster.n_seed === counts.seeds,
      'cluster counts disagree with member nodes');
    ensure(cluster.hypothesis.trim().length > 0, 'cluster hypothesis must be nonblank');
    ensure(new Set(cluster.top_gids).size === cluster.top_gids.length,
      'cluster representatives must be unique');
    for (const gid of cluster.top_gids) {
      checkGid(gid);
      ensure(nodeByGid.get(gid)?.cluster_id === cluster.cluster_id,
        'cluster representative must belong to that cluster');
    }
  }
  ensure(topNodes.length >= Math.min(20, nodes.length), 'top nodes contain too few entries');
  const rankedGids = new Set<string>();
  for (const [index, top] of topNodes.entries()) {
    checkGid(top.gid);
    safeIntegers([top.rank]);
    ensure(top.rank === index + 1, 'top ranks must be consecutive starting at one');
    ensure(!rankedGids.has(top.gid), 'top node gids must be unique');
    rankedGids.add(top.gid);
    const node = nodeByGid.get(top.gid);
    ensure(node && node.role === top.role && node.priority_score === top.priority_score,
      'top node disagrees with its node role or priority');
    ensure(top.why.trim().length > 0, 'top node explanation must be nonblank');
    const previous = topNodes[index - 1];
    if (previous) {
      ensure(previous.priority_score > top.priority_score ||
        (previous.priority_score === top.priority_score && BigInt(previous.gid) < BigInt(top.gid)),
      'top nodes must be ordered by descending priority and ascending numeric gid');
    }
  }
}

// Normalization compares exact decimal text without rounding through Number.
function decimal(value: string): string {
  ensure(MONEY.test(value), 'CSV money must be decimal text');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const integer = whole.replace(/^0+(?=\d)/, '');
  const fractional = fraction.replace(/0+$/, '');
  const sign = negative && (integer !== '0' || fractional !== '') ? '-' : '';
  return `${sign}${integer}${fractional ? `.${fractional}` : ''}`;
}

function checkCsv(filename: CsvFile, buffer: Buffer, analysis: AnalysisResult): void {
  let rows: string[][];
  try {
    rows = parse(utf8(buffer, filename), { bom: true, skip_empty_lines: false, relax_column_count: false });
  } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    throw new ArtifactValidationError(`${filename} is not well-formed CSV`, { cause: error });
  }
  const headers = HEADERS[filename];
  ensure(JSON.stringify(rows.shift()) === JSON.stringify(headers), `${filename} headers or order are incorrect`);
  const expected = filename === 'nodes_roles.csv' ? analysis.nodes
    : filename === 'clusters.csv' ? analysis.clusters : analysis.top_nodes;
  ensure(rows.length === expected.length, `${filename} row count disagrees with analysis.json`);
  const key = headers[0];
  const objects = new Map(expected.map(item => {
    const record = item as unknown as Record<string, unknown>;
    return [String(record[key]), record] as const;
  }));
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    ensure(row.length === headers.length, `${filename} column count is incorrect`);
    ensure(!seen.has(row[0]), `${filename} contains a duplicate row`);
    seen.add(row[0]);
    const expectedRow = objects.get(row[0]);
    ensure(expectedRow, `${filename} contains an unknown row`);
    if (filename === 'top_nodes.csv') ensure(row[0] === String(index + 1), `${filename} rank order is incorrect`);
    headers.forEach((column, columnIndex) => {
      const actual = row[columnIndex];
      const value = expectedRow[column];
      const mismatch = `${filename} ${column} disagrees with analysis.json`;
      if (column === 'sum_kzt_internal') {
        ensure(decimal(actual) === decimal(value as string), mismatch);
      } else if (column === 'top_gids') {
        let gids: unknown;
        try { gids = JSON.parse(actual); } catch (error) {
          throw new ArtifactValidationError(`${filename} top_gids is not JSON`, { cause: error });
        }
        ensure(JSON.stringify(gids) === JSON.stringify(value), mismatch);
      } else if (typeof value === 'number') {
        const pattern = column.endsWith('_score') ? NUMBER : INTEGER;
        ensure(pattern.test(actual) && Number.isFinite(Number(actual)) && Number(actual) === value, mismatch);
      } else {
        ensure(actual === value, mismatch);
      }
    });
  }
}

export async function validateArtifacts(outputDir: string): Promise<{ analysis: AnalysisResult; csv: Record<CsvFile, Buffer> }> {
  const json = await readArtifact(outputDir, 'analysis.json');
  let analysis: unknown;
  try { analysis = JSON.parse(utf8(json, 'analysis.json')); } catch (error) {
    if (error instanceof ArtifactValidationError) throw error;
    throw new ArtifactValidationError('analysis.json is not valid JSON', { cause: error });
  }
  ensure(schema(analysis), `analysis.json does not match the contract: ${schema.errors?.[0]?.instancePath ?? ''} ${schema.errors?.[0]?.message ?? ''}`);
  checkAnalysis(analysis);
  const csv = {} as Record<CsvFile, Buffer>;
  for (const filename of CSV_FILES) {
    const buffer = await readArtifact(outputDir, filename);
    checkCsv(filename, buffer, analysis);
    csv[filename] = buffer;
  }
  return { analysis, csv };
}
