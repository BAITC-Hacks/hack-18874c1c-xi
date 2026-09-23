const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createApp } = require('../dist/bootstrap.js');
const { createAnalysis, writeArtifacts } = require('./fixtures/artifacts.cjs');

// These are transport bytes, deliberately NOT a real Parquet dataset.
function upload(fields = ['nodes', 'edges', 'transactions'], contents = 'synthetic-input') {
  const body = new FormData();
  for (const name of fields) body.append(name, new Blob([contents]), '../../client-name.parquet');
  return body;
}

async function setup(t, overrides = {}) {
  const runsDir = await mkdtemp(join(tmpdir(), 'money-graph-api-'));
  const processes = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => { setImmediate(() => child.emit('close', null, signal)); return true; };
    const outputDir = args[args.indexOf('--output-dir') + 1];
    processes.push({ command, args, options, child, outputExistsAtSpawn: existsSync(outputDir) });
    return child;
  };
  const app = await createApp({ webOrigin: 'http://localhost:3000', logger: false,
    runs: { runsDir, pythonBin: 'server-python', timeoutMs: 5000, spawnProcess, ...overrides } });
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  t.after(async () => { await app.close(); await rm(runsDir, { recursive: true, force: true }); });
  return { app, runsDir, processes, base,
    post: (body = upload()) => fetch(`${base}/runs`, { method: 'POST', body }) };
}

async function terminal(base, id) {
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`${base}/runs/${id}`);
    assert.equal(response.status, 200);
    const status = await response.json();
    if (status.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('run did not reach terminal status');
}

test('invalid multipart inputs reject with 400, leave no run, and release the slot', async (t) => {
  const api = await setup(t, { uploadMaxBytes: 32 });
  const textField = upload(); textField.append('path', '/outside');
  for (const body of [upload(['nodes']), upload(['nodes','nodes','edges','transactions']),
    upload(['nodes','edges','transactions','extra']), upload(undefined, ''), upload(undefined, 'x'.repeat(33)), textField]) {
    const response = await api.post(body);
    assert.equal(response.status, 400, await response.text());
    assert.deepEqual(await readdir(api.runsDir), []);
  }
  assert.equal(api.processes.length, 0);
  assert.equal((await api.post()).status, 202);
});

test('accepts isolated server paths, reserves one slot, blocks early reads, and recovers from Python failure', async (t) => {
  const api = await setup(t);
  const response = await api.post();
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.deepEqual(Object.keys(created).sort(), ['run_id','status']);
  assert.equal(created.status, 'running');
  const status = await (await fetch(`${api.base}/runs/${created.run_id}`)).json();
  assert.equal(status.error, null);
  assert.ok(status.elapsed_ms >= 0);
  assert.equal((await api.post()).status, 409);
  assert.equal((await fetch(`${api.base}/runs`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal((await fetch(`${api.base}/runs/${created.run_id}/result`)).status, 409);
  assert.equal((await fetch(`${api.base}/runs/${created.run_id}/exports/nodes_roles.csv`)).status, 409);
  for (const filename of ['analysis.json', 'secret.csv', '..%2Fanalysis.json', 'nodes_roles.csv%00']) {
    assert.equal((await fetch(`${api.base}/runs/${created.run_id}/exports/${filename}`)).status, 404);
  }
  assert.equal(api.processes.length, 1);
  const process = api.processes[0];
  assert.equal(process.command, 'server-python');
  assert.equal(process.options.shell, false);
  const input = join(api.runsDir, created.run_id, 'input');
  const output = join(api.runsDir, created.run_id, 'output');
  assert.deepEqual(process.args, ['-m','money_graph','--input-dir',input,'--output-dir',output]);
  assert.deepEqual((await readdir(input)).sort(), ['edges.parquet','nodes.parquet','transactions.parquet']);
  assert.equal(await readFile(join(input, 'nodes.parquet'), 'utf8'), 'synthetic-input');
  process.child.stderr.write('private path /secret/machine/trace');
  process.child.emit('close', 3, null);
  const failed = await terminal(api.base, created.run_id);
  assert.equal(failed.status, 'failed');
  assert.equal(typeof failed.error.code, 'string');
  assert.doesNotMatch(failed.error.message, /secret|trace/);
  assert.equal((await fetch(`${api.base}/runs/${created.run_id}/result`)).status, 409);
  const next = await api.post();
  assert.equal(next.status, 202);
  assert.notEqual((await next.json()).run_id, created.run_id);
  assert.equal((await (await fetch(`${api.base}/runs/${created.run_id}`)).json()).elapsed_ms, failed.elapsed_ms);
});

test('parallel POSTs start exactly one process', async (t) => {
  const api = await setup(t);
  const replies = await Promise.all([api.post(), api.post(), api.post()]);
  assert.deepEqual(replies.map((r) => r.status).sort(), [202,409,409]);
  assert.equal(api.processes.length, 1);
});

test('leaves the output path absent so Python can publish atomically on Windows too', async (t) => {
  const api = await setup(t);
  const response = await api.post();
  assert.equal(response.status, 202);
  const { run_id } = await response.json();
  assert.equal(api.processes.length, 1);
  assert.equal(api.processes[0].outputExistsAtSpawn, false);
  await assert.rejects(readdir(join(api.runsDir, run_id, 'output')), { code: 'ENOENT' });
  assert.equal((await fetch(`${api.base}/runs/${run_id}/result`)).status, 409);
});

test('a successful exit with missing artifacts fails and releases the slot', async (t) => {
  const api = await setup(t);
  const response = await api.post();
  assert.equal(response.status, 202);
  const { run_id } = await response.json();
  api.processes[0].child.emit('close', 0, null);
  const failed = await terminal(api.base, run_id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'ARTIFACTS_INVALID');
  assert.equal((await fetch(`${api.base}/runs/${run_id}/exports/clusters.csv`)).status, 409);
  assert.equal((await api.post()).status, 202);
});

test('publishes only after close and validation, preserving exact JSON and original CSV bytes per run', async (t) => {
  const api = await setup(t);
  const response = await api.post();
  const { run_id } = await response.json();
  const output = join(api.runsDir, run_id, 'output');
  const analysis = await writeArtifacts(output);
  const original = await readFile(join(output, 'clusters.csv'));
  api.processes[0].child.emit('exit', 0, null);
  assert.equal((await fetch(`${api.base}/runs/${run_id}/result`)).status, 409);
  api.processes[0].child.emit('close', 0, null);
  assert.equal((await terminal(api.base, run_id)).status, 'completed');
  assert.deepEqual(await (await fetch(`${api.base}/runs/${run_id}/result`)).json(), analysis);
  for (const file of ['nodes_roles.csv', 'clusters.csv', 'top_nodes.csv']) {
    const download = await fetch(`${api.base}/runs/${run_id}/exports/${file}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /text\/csv/);
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${file}"`);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), await readFile(join(output, file)));
  }
  // A validated snapshot cannot be replaced on disk while being downloaded.
  await writeFile(join(output, 'clusters.csv'), 'corrupted later');
  assert.deepEqual(Buffer.from(await (await fetch(`${api.base}/runs/${run_id}/exports/clusters.csv`)).arrayBuffer()), original);
  const next = await (await api.post()).json();
  assert.notEqual(next.run_id, run_id);
  await assert.rejects(readdir(join(api.runsDir, next.run_id, 'output')), { code: 'ENOENT' });
  api.processes[1].child.emit('close', 0, null);
  assert.equal((await terminal(api.base, next.run_id)).status, 'failed');
  assert.equal((await fetch(`${api.base}/runs/${next.run_id}/result`)).status, 409);
  assert.deepEqual(await (await fetch(`${api.base}/runs/${run_id}/result`)).json(), analysis);
});

test('corrupt or inconsistent artifacts never become completed and the next run is accepted', async (t) => {
  const api = await setup(t);
  for (const corrupt of [
    async (output) => writeFile(join(output, 'analysis.json'), '{'),
    async (output) => writeFile(join(output, 'nodes_roles.csv'), 'wrong,columns\n'),
    async (output) => { const a = createAnalysis(); a.nodes[0].gid = 9007199254740992; await writeFile(join(output, 'analysis.json'), JSON.stringify(a)); },
  ]) {
    const response = await api.post(); assert.equal(response.status, 202);
    const { run_id } = await response.json();
    const output = join(api.runsDir, run_id, 'output');
    await writeArtifacts(output); await corrupt(output);
    api.processes.at(-1).child.emit('close', 0, null);
    assert.equal((await terminal(api.base, run_id)).status, 'failed');
  }
});

test('Python start errors and timeout release the slot without publishing partial results', async (t) => {
  for (const mode of ['throw', 'error', 'timeout']) {
    await t.test(mode, async (t) => {
      const api = await setup(t, { timeoutMs: 30, killGraceMs: 10,
        ...(mode === 'throw' ? { spawnProcess: () => { throw new Error('private executable path'); } } : {}) });
      const { run_id } = await (await api.post()).json();
      if (mode === 'error') {
        api.processes[0].child.emit('error', new Error('ENOENT /secret/path'));
        api.processes[0].child.emit('close', -2, null);
      }
      const state = await terminal(api.base, run_id);
      assert.equal(state.status, 'failed');
      assert.equal(state.error.code, mode === 'timeout' ? 'PYTHON_TIMEOUT' : 'PYTHON_START_FAILED');
      assert.doesNotMatch(state.error.message, /secret|private/);
      assert.equal((await api.post()).status, 202);
    });
  }
});

test('aborted and timed-out uploads clean partial files and release the slot', async (t) => {
  for (const abort of [true, false]) {
    await t.test(abort ? 'disconnect' : 'timeout', async (t) => {
      const api = await setup(t, { uploadTimeoutMs: 150 });
      const request = http.request(`${api.base}/runs`, { method: 'POST', headers: {
        'content-type': 'multipart/form-data; boundary=partial',
      } });
      request.on('error', () => {});
      request.write('--partial\r\nContent-Disposition: form-data; name="nodes"; filename="a.parquet"\r\n\r\npartial');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await api.post()).status, 409);
      if (abort) request.destroy();
      else {
        const response = await new Promise((resolve) => request.once('response', resolve));
        assert.equal(response.statusCode, 400); response.resume(); request.destroy();
      }
      for (let i = 0; i < 100 && (await readdir(api.runsDir)).length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(await readdir(api.runsDir), []);
      assert.equal(api.processes.length, 0);
      assert.equal((await api.post()).status, 202);
    });
  }
});
