// Explicit integration command; requires an installed real Python CLI, never a mock.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApp } = require('../dist/bootstrap.js');

test('real Python CLI rejects invalid input, exposes no result, and accepts a subsequent run', async (t) => {
  assert.ok(process.env.PYTHON_BIN, 'Set PYTHON_BIN to the installed Python executable.');
  await promisify(execFile)(process.env.PYTHON_BIN, ['-m', 'money_graph', '--check-environment'], {
    timeout: 30000, windowsHide: true,
  });
  const runsDir = await mkdtemp(join(tmpdir(), 'money-graph-python-'));
  const app = await createApp({ webOrigin: 'http://localhost:3000', logger: false,
    runs: { runsDir, pythonBin: process.env.PYTHON_BIN, timeoutMs: 10000 } });
  t.after(async () => { await app.close(); await rm(runsDir, { recursive: true, force: true }); });
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  const ids = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = new FormData();
    for (const field of ['nodes','edges','transactions']) {
      body.append(field, new Blob(['deliberately invalid Parquet, not a dataset']), `${field}.parquet`);
    }
    const response = await fetch(`${base}/runs`, { method: 'POST', body });
    assert.equal(response.status, 202);
    const { run_id } = await response.json();
    assert.ok(!ids.has(run_id)); ids.add(run_id);
    let state;
    for (let i = 0; i < 300; i++) {
      state = await (await fetch(`${base}/runs/${run_id}`)).json();
      if (state.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(state.status, 'failed');
    // A missing interpreter/module is an environment failure, not a successful content test.
    assert.equal(state.error.code, 'PYTHON_FAILED');
    assert.equal((await fetch(`${base}/runs/${run_id}/result`)).status, 409);
    assert.equal((await fetch(`${base}/runs/${run_id}/exports/nodes_roles.csv`)).status, 409);
    t.diagnostic(`real Python run ${attempt + 1}: ${state.status}, ${state.error.code}, ${state.elapsed_ms} ms`);
  }
});
