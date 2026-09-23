// Real-data acceptance only. No fixture fallback; a missing dataset is an error.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { openAsBlob } = require('node:fs');
const { mkdtemp, stat, readFile, rm } = require('node:fs/promises');
const { tmpdir, platform, arch, cpus } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApp } = require('../dist/bootstrap.js');

test('real dataset completes in <300 seconds with exact source gid coverage and downloadable exports', { timeout: 360000 }, async (t) => {
  assert.ok(process.env.REAL_DATA_DIR, 'Set REAL_DATA_DIR to the actual three-Parquet dataset.');
  assert.ok(process.env.PYTHON_BIN, 'Set PYTHON_BIN to the installed Python executable.');
  const input = resolve(process.env.REAL_DATA_DIR);
  const python = process.env.PYTHON_BIN;
  const files = ['nodes', 'edges', 'transactions'];
  const sizes = {};
  const body = new FormData();
  for (const name of files) {
    const path = join(input, `${name}.parquet`);
    sizes[name] = (await stat(path)).size;
    body.append(name, await openAsBlob(path), `${name}.parquet`);
  }
  // This is an acceptance check of source coverage, not analytic computation.
  const { stdout: sourceText } = await promisify(execFile)(python, ['-c',
    'import json,sys,pyarrow.parquet as pq; values=pq.read_table(sys.argv[1],columns=["gid"]).column("gid").to_pylist(); assert all(isinstance(x,int) and not isinstance(x,bool) for x in values); json.dump([str(x) for x in values],sys.stdout)',
    join(input, 'nodes.parquet')], { maxBuffer: 64 * 1024 * 1024, timeout: 30000, windowsHide: true });
  const sourceGids = new Set(JSON.parse(sourceText));
  const runsDir = await mkdtemp(join(tmpdir(), 'money-graph-acceptance-'));
  let processMs;
  const app = await createApp({ webOrigin: 'http://localhost:3000', logger: false,
    runs: { runsDir, pythonBin: python, timeoutMs: 330000,
      spawnProcess: (command, args, options) => {
        const started = performance.now();
        const child = spawn(command, args, options);
        child.once('close', () => { processMs = performance.now() - started; });
        return child;
      } } });
  t.after(async () => { await app.close(); await rm(runsDir, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  const accepted = await fetch(`${base}/runs`, { method: 'POST', body });
  assert.equal(accepted.status, 202);
  const { run_id } = await accepted.json();
  let state;
  do {
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await (await fetch(`${base}/runs/${run_id}`)).json();
  } while (state.status === 'running');
  assert.equal(state.status, 'completed', JSON.stringify(state));
  assert.ok(processMs < 300000, `Python process took ${processMs} ms`);
  assert.ok(state.elapsed_ms < 300000, `Process plus backend validation took ${state.elapsed_ms} ms`);
  const response = await fetch(`${base}/runs/${run_id}/result`);
  assert.equal(response.status, 200);
  const analysis = await response.json();
  assert.deepEqual(new Set(analysis.nodes.map(node => node.gid)), sourceGids);
  assert.equal(analysis.nodes.length, sourceGids.size);
  for (const name of ['nodes_roles.csv','clusters.csv','top_nodes.csv']) {
    const exported = await fetch(`${base}/runs/${run_id}/exports/${name}`);
    assert.equal(exported.status, 200);
    assert.deepEqual(Buffer.from(await exported.arrayBuffer()), await readFile(join(runsDir,run_id,'output',name)));
  }
  const version = await promisify(execFile)(python, ['--version'], { windowsHide: true });
  t.diagnostic(JSON.stringify({ process_ms: processMs, process_and_validation_ms: state.elapsed_ms,
    bytes: sizes, metadata: analysis.metadata, node: process.version, python: version.stdout.trim(),
    platform: platform(), arch: arch(), cpu: cpus()[0]?.model }));
});
