const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile, mkdir, symlink } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { validateArtifacts } = require('../dist/artifacts.js');
const { createAnalysis, writeArtifacts, serializeCsv, csvRows, HEADERS } = require('./fixtures/artifacts.cjs');

async function fixture(t, analysis = createAnalysis()) {
  const directory = await mkdtemp(join(tmpdir(), 'money-graph-artifacts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeArtifacts(directory, analysis);
  return directory;
}

test('valid synthetic artifacts retain exact int64, decimal money and original CSV bytes', async t => {
  const expected = createAnalysis();
  const directory = await fixture(t, expected);
  const result = await validateArtifacts(directory);
  assert.deepEqual(result.analysis, expected);
  assert.equal(result.analysis.nodes[0].gid, '9007199254740993');
  assert.equal(result.analysis.clusters[0].sum_kzt_internal, '9007199254740993.123456789012345678');
  for (const filename of Object.keys(HEADERS)) {
    assert.deepEqual(result.csv[filename], await readFile(join(directory, filename)));
  }
});

test('equivalent decimal formatting and CSV row order are accepted without rewriting bytes', async t => {
  const analysis = createAnalysis();
  const directory = await fixture(t, analysis);
  const rows = csvRows(analysis);
  rows['clusters.csv'][0][3] = '09007199254740993.12345678901234567800';
  rows['clusters.csv'][1][3] = '-0.000';
  const bytes = Buffer.from(serializeCsv([HEADERS['clusters.csv'], ...rows['clusters.csv'].reverse()]));
  await writeFile(join(directory, 'clusters.csv'), bytes);
  assert.deepEqual((await validateArtifacts(directory)).csv['clusters.csv'], bytes);
});

const semanticFailures = [
  ['int64 above maximum', a => { a.nodes[0].gid = '9223372036854775808'; }],
  ['int64 below minimum', a => { a.nodes[0].gid = '-9223372036854775809'; }],
  ['numeric gid', a => { a.nodes[0].gid = 9007199254740992; }],
  ['numeric money', a => { a.edges[0].sum_kzt = 123; }],
  ['duplicate gid', a => { a.nodes[1].gid = a.nodes[0].gid; }],
  ['missing mandatory field', a => { delete a.nodes[0].metrics.in_sum_kzt; }],
  ['invalid role', a => { a.nodes[0].role = 'criminal'; }],
  ['score outside range', a => { a.nodes[0].role_score = 1.01; }],
  ['evidence over 200 Unicode characters', a => { a.nodes[0].evidence = '😀'.repeat(201); }],
  ['blank evidence', a => { a.nodes[0].evidence = '  '; }],
  ['blank hypothesis', a => { a.clusters[0].hypothesis = '\n'; }],
  ['blank priority explanation', a => { a.top_nodes[0].why = ' '; }],
  ['unsafe integer counter', a => { a.metadata.n_transactions = 9007199254740992; }],
  ['unsafe cluster identifier', a => { a.clusters[0].cluster_id = 9007199254740992; }],
  ['incorrect node count', a => { a.metadata.n_nodes++; }],
  ['incorrect edge count', a => { a.metadata.n_edges++; }],
  ['incorrect seed count', a => { a.metadata.n_seeds++; }],
  ['dangling edge source', a => { a.edges[0].src = '123'; }],
  ['dangling edge destination', a => { a.edges[0].dst = '123'; }],
  ['duplicate aggregated edge', a => { a.edges.push({ ...a.edges[0] }); a.metadata.n_edges++; }],
  ['missing cluster', a => { a.nodes[0].cluster_id = 99; }],
  ['duplicate cluster', a => { a.clusters.push({ ...a.clusters[0] }); }],
  ['incorrect cluster node count', a => { a.clusters[0].n_nodes++; }],
  ['incorrect cluster seed count', a => { a.clusters[0].n_seed++; }],
  ['cluster representative in another cluster', a => { a.clusters[0].top_gids = [a.nodes[3].gid]; }],
  ['duplicate cluster representative', a => { a.clusters[0].top_gids.push(a.clusters[0].top_gids[0]); }],
  ['top too short for small graph', a => { a.top_nodes.pop(); }],
  ['top contains duplicate gid', a => { a.top_nodes[1].gid = a.top_nodes[0].gid; }],
  ['top contains unknown gid', a => { a.top_nodes[0].gid = '123'; }],
  ['top disagrees with node role', a => { a.top_nodes[0].role = 'terminal'; }],
  ['top disagrees with node score', a => { a.top_nodes[0].priority_score = 0.95; }],
  ['top rank is not consecutive', a => { a.top_nodes[1].rank = 3; }],
  ['top tie is not ordered by numeric gid', a => { [a.top_nodes[1], a.top_nodes[2]] = [a.top_nodes[2], a.top_nodes[1]]; a.top_nodes.forEach((n, i) => n.rank = i + 1); }],
  ['top is not ordered by descending priority', a => { a.top_nodes.reverse(); a.top_nodes.forEach((n, i) => n.rank = i + 1); }],
];
for (const [name, mutate] of semanticFailures) {
  test(`rejects ${name}`, async t => {
    const analysis = createAnalysis();
    mutate(analysis);
    const directory = await fixture(t, analysis);
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  });
}

for (const filename of ['analysis.json', ...Object.keys(HEADERS)]) {
  test(`rejects missing ${filename}`, async t => {
    const directory = await fixture(t);
    await rm(join(directory, filename));
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  });
  test(`rejects invalid UTF-8 in ${filename}`, async t => {
    const directory = await fixture(t);
    await writeFile(join(directory, filename), Buffer.from([0xff, 0xfe]));
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  });
}

test('rejects non-file artifacts', async t => {
  const directory = await fixture(t);
  await rm(join(directory, 'analysis.json'));
  await mkdir(join(directory, 'analysis.json'));
  await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
});

test('rejects a symbolic-link artifact before reading it', async t => {
  const directory = await fixture(t);
  const target = join(directory, 'target');
  await mkdir(target);
  await rm(join(directory, 'analysis.json'));
  // Windows junctions do not require the privilege needed for file symlinks.
  await symlink(target, join(directory, 'analysis.json'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
});

test('rejects truncated JSON and overflowed numeric literals', async t => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'analysis.json'), '{"metadata":');
  await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  await writeArtifacts(directory);
  const json = await readFile(join(directory, 'analysis.json'), 'utf8');
  await writeFile(join(directory, 'analysis.json'), json.replace('"elapsed_ms":12.5', '"elapsed_ms":1e999'));
  await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
});

const csvFailures = [
  ['wrong column order', rows => { [rows[0][0], rows[0][1]] = [rows[0][1], rows[0][0]]; }],
  ['additional column', rows => { rows.forEach(row => row.push('extra')); }],
  ['missing row', rows => { rows.pop(); }],
  ['duplicate row', rows => { rows.push(rows[1]); }],
  ['numeric precision changed', rows => { rows[1][0] = '9007199254740992'; }],
  ['role differs from JSON', rows => { rows[1][1] = 'terminal'; }],
  ['role score differs from JSON', rows => { rows[1][2] = '0.26'; }],
  ['cluster differs from JSON', rows => { rows[1][3] = '2'; }],
  ['priority differs from JSON', rows => { rows[1][4] = '0.91'; }],
  ['evidence differs from JSON', rows => { rows[1][5] = 'Different'; }],
  ['empty number', rows => { rows[1][2] = ''; }],
  ['non-decimal number', rows => { rows[1][3] = '0x1'; }],
];
for (const [name, mutate] of csvFailures) {
  test(`rejects nodes CSV ${name}`, async t => {
    const analysis = createAnalysis();
    const directory = await fixture(t, analysis);
    const rows = [HEADERS['nodes_roles.csv'].slice(), ...csvRows(analysis)['nodes_roles.csv']];
    mutate(rows);
    await writeFile(join(directory, 'nodes_roles.csv'), serializeCsv(rows));
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  });
}

for (const [filename, column, value] of [
  ['clusters.csv', 3, '9007199254740993.123456789012345679'],
  ['clusters.csv', 4, '[9007199254740993,"2"]'],
  ['clusters.csv', 4, '["2","9007199254740993"]'],
  ['clusters.csv', 5, 'Different hypothesis'],
  ['top_nodes.csv', 4, 'Different explanation'],
]) {
  test(`rejects ${filename} column ${column} mismatch: ${value}`, async t => {
    const analysis = createAnalysis();
    const directory = await fixture(t, analysis);
    const rows = csvRows(analysis)[filename];
    rows[0][column] = value;
    await writeFile(join(directory, filename), serializeCsv([HEADERS[filename], ...rows]));
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  });
}

test('rejects malformed CSV quoting and mismatched column counts', async t => {
  const directory = await fixture(t);
  for (const badCsv of ['gid,role\r\n"unterminated', serializeCsv([HEADERS['nodes_roles.csv'], ['2', 'peripheral']])]) {
    await writeFile(join(directory, 'nodes_roles.csv'), badCsv);
    await assert.rejects(validateArtifacts(directory), /Invalid artifact/);
  }
});
