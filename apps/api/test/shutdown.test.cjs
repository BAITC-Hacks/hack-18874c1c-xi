const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { createApp } = require('../dist/bootstrap.js');

test('shutdown closes an unfinished upload connection and awaits file cleanup', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'money-graph-shutdown-'));
  let startedProcesses = 0;
  const app = await createApp({
    webOrigin: 'http://localhost:3000', logger: false,
    runs: { runsDir, uploadTimeoutMs: 10000,
      spawnProcess: () => { startedProcesses++; throw new Error('An incomplete upload must not run Python.'); } },
  });
  let request;
  let closing;
  let timer;
  try {
    await app.listen(0, '127.0.0.1');
    request = http.request(`${await app.getUrl()}/api/runs`, {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=unfinished' },
    });
    request.on('error', () => {});
    request.on('response', (response) => response.resume());
    request.write('--unfinished\r\nContent-Disposition: form-data; name="nodes"; filename="nodes.parquet"\r\n\r\npartial input');
    const deadline = Date.now() + 2000;
    while ((await readdir(runsDir)).length === 0 && Date.now() < deadline) await delay(5);
    assert.equal((await readdir(runsDir)).length, 1, 'the upload must reserve its run before shutdown');

    // The client deliberately leaves its multipart body and socket open.
    closing = app.close();
    const closed = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), 1500); }),
    ]);
    assert.equal(closed, true, 'API shutdown must finish without waiting for the client to close its upload');
    assert.deepEqual(await readdir(runsDir), [], 'shutdown must await removal of partial input files');
    assert.equal(startedProcesses, 0);
  } finally {
    clearTimeout(timer);
    request?.destroy();
    await (closing ?? app.close());
    await rm(runsDir, { recursive: true, force: true });
  }
});
