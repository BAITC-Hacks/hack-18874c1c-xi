const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { createApp } = require('../dist/bootstrap.js');
const { readConfig } = require('../dist/config.js');

let app;
let baseUrl;
const webOrigin = 'http://localhost:3000';

before(async () => {
  app = await createApp({ webOrigin, logger: false });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

after(async () => {
  await app?.close();
});

test('health reports a running API and an explicitly unfinished analytics pipeline', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'api',
    analytics: 'not_implemented',
  });
});

test('unknown runs return 404 and an incomplete upload returns 400', async (t) => {
  for (const [method, path] of [
    ['POST', '/api/runs'],
    ['GET', '/api/runs/example'],
    ['GET', '/api/runs/example/result'],
    ['GET', '/api/runs/example/exports/nodes_roles.csv'],
  ]) {
    await t.test(`${method} ${path}`, async () => {
      const response = await fetch(`${baseUrl}${path}`, { method });
      const body = await response.json();
      assert.equal(response.status, method === 'POST' ? 400 : 404);
      assert.equal(typeof body.error.code, 'string');
      assert.equal(typeof body.error.message, 'string');
      assert.equal(Object.hasOwn(body, 'run_id'), false);
    });
  }
});

test('CORS allows the configured frontend origin rather than arbitrary origins', async () => {
  const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: webOrigin } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), webOrigin);

  const otherOrigin = 'https://unrelated.example';
  const disallowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: otherOrigin } });
  assert.notEqual(disallowed.headers.get('access-control-allow-origin'), otherOrigin);
  assert.notEqual(disallowed.headers.get('access-control-allow-origin'), '*');
});

test('invalid deployment configuration fails before opening a listener', () => {
  assert.throws(() => readConfig({ PORT: 'not-a-port' }), /PORT/);
  assert.throws(() => readConfig({ PORT: '70000' }), /PORT/);
  assert.throws(() => readConfig({ WEB_ORIGIN: 'https://example.com/path' }), /WEB_ORIGIN/);
});
