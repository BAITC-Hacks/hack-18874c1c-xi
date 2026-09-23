const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve } = require('node:path');

test('source runtime used by dev:api resolves controller dependencies', async () => {
  const script = `
    const {createApp} = require('./src/bootstrap.ts');
    (async () => {
      const app = await createApp({webOrigin:'http://localhost:3000',logger:false});
      await app.listen(0,'127.0.0.1');
      try {
        const response = await fetch((await app.getUrl())+'/api/runs/unknown');
        console.log(response.status);
      } finally { await app.close(); }
    })().catch(error => { console.error(error); process.exitCode=1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: resolve(__dirname, '..'), timeout: 15000,
  });
  assert.equal(stdout.trim(), '404');
});
