import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOptions, mustHaveSummary } from '../acceptance/run.mjs';
import * as runner from '../acceptance/run.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

test('acceptance defaults to official data and never silently selects fixtures', () => {
  assert.deepEqual(parseOptions([]), { dataDir: 'data', noCache: false, help: false });
  assert.throws(() => parseOptions(['--synthetic']), /Unknown/);
});
test('acceptance validates CLI options without running Docker', () => {
  assert.deepEqual(parseOptions(['--data-dir', '/input data', '--no-cache']), {
    dataDir: '/input data', noCache: true, help: false,
  });
  assert.equal(parseOptions(['--help']).help, true);
  assert.throws(() => parseOptions(['--data-dir']), /requires/);
  assert.throws(() => parseOptions(['--data-dir', '--no-cache']), /requires/);
});
test('automation cannot mark human explanation or judging as passed', () => {
  const result = mustHaveSummary(true);
  assert.equal(result.M1.automated, 'passed');
  assert.equal(result.M3.automated, 'passed');
  assert.equal(result.M3.manual, 'pending');
  assert.equal(result.M1.manual, 'pending');
  assert.equal(result.M5.manual, 'pending');
  assert.equal(mustHaveSummary(false).M2.automated, 'not_confirmed');
});
test('Docker build contexts resolve from the explicit repository project-directory', () => {
  const compose = readFileSync(new URL('../../docker/compose.acceptance.yaml', import.meta.url), 'utf8');
  const contexts = [...compose.matchAll(/^\s+context:\s*(.+)$/gm)].map(match => match[1]);
  assert.equal(contexts.length, 5);
  assert.ok(contexts.every(context => context === '.'));
});

test('clean and IDE-only worktrees are not reported as dirty', () => {
  assert.equal(runner.isWorktreeDirty(''), false);
  assert.equal(runner.isWorktreeDirty('\n'), false);
  assert.equal(runner.isWorktreeDirty('?? .idea/\n'), false);
  assert.equal(runner.isWorktreeDirty('?? .idea/\n M README.md\n'), true);
  assert.equal(runner.isWorktreeDirty(' M .idea/settings.xml\n'), true);
  assert.equal(runner.isWorktreeDirty(null), null);
});

function fakeChild({ write = false, close = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => {
    if (write) child.stdout.write('synthetic test output');
    if (close) child.emit('close', 0, null);
  });
  return child;
}

test('log stream errors fail the command and terminate its process without an unhandled error', async () => {
  const child = fakeChild({ write: true });
  const result = await runner.runLoggedCommand('synthetic', [], {
    logPath: 'not-used', timeout: 1000, spawnCommand: () => child,
    openLog: () => new Writable({ write(_chunk, _encoding, callback) { callback(new Error('synthetic disk full')); } }),
  });
  assert.equal(result.passed, false);
  assert.match(result.logError, /disk full/);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('a log flush failure cannot turn process exit zero into a passed step', async () => {
  const result = await runner.runLoggedCommand('synthetic', [], {
    logPath: 'not-used', timeout: 1000, spawnCommand: () => fakeChild({ close: true }),
    openLog: () => new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { callback(new Error('synthetic flush failure')); } }),
  });
  assert.equal(result.code, 0);
  assert.equal(result.passed, false);
  assert.match(result.logError, /flush failure/);
});

test('cleanup command still runs when its log cannot be opened', async () => {
  let spawned = false;
  const result = await runner.runLoggedCommand('synthetic', [], {
    logPath: 'not-used', timeout: 1000, allowUnlogged: true,
    spawnCommand: () => { spawned = true; return fakeChild({ close: true }); },
    openLog: () => { throw new Error('synthetic log cannot open'); },
  });
  assert.equal(spawned, true);
  assert.equal(result.commandSucceeded, true);
  assert.equal(result.passed, false);
});

test('service log failure never prevents the isolated compose down step', async () => {
  const names = [];
  const result = await runner.cleanupProject(async (name, args, options) => {
    names.push(name);
    if (name === 'service-logs') throw new Error('synthetic logs failure');
    assert.ok(args.includes('down'));
    assert.equal(options.allowUnlogged, true);
    return true;
  }, ['compose', '--project-name', 'unique-test-only']);
  assert.deepEqual(names, ['service-logs', 'cleanup']);
  assert.equal(result.stopped, true);
  assert.match(result.logError, /logs failure/);
});

test('failed compose down is reported instead of being mistaken for cleanup', async () => {
  const result = await runner.cleanupProject(async name => {
    if (name === 'cleanup') throw new Error('synthetic down failure');
    return true;
  }, ['compose', '--project-name', 'unique-test-only']);
  assert.equal(result.stopped, false);
  assert.match(result.cleanupError, /down failure/);
});

test('manual cleanup command quotes paths and supplies required interpolation variables', () => {
  const command = runner.formatCleanupCommand(['compose', '--project-directory', "/tmp/team's project", '-f', '/tmp/team project/compose.yaml'], {
    COMPOSE_PROJECT_NAME: 'unique-test-only', ACCEPTANCE_DATA_DIR: '/tmp/input data', ACCEPTANCE_REPORT_DIR: '/tmp/test reports',
  }, 'darwin');
  assert.match(command, /^env /);
  assert.ok(command.includes("'ACCEPTANCE_DATA_DIR=/tmp/input data'"));
  assert.ok(command.includes("'ACCEPTANCE_REPORT_DIR=/tmp/test reports'"));
  assert.ok(command.includes("'/tmp/team'\\''s project'"));
  assert.ok(command.includes("'down' '--remove-orphans'"));
});

test('manual Windows cleanup uses quoted PowerShell values', () => {
  const command = runner.formatCleanupCommand(['compose', '--project-directory', "C:\\team's project"], {
    COMPOSE_PROJECT_NAME: 'unique-test-only', ACCEPTANCE_DATA_DIR: 'C:\\input data', ACCEPTANCE_REPORT_DIR: 'C:\\test reports',
  }, 'win32');
  assert.ok(command.includes("$env:ACCEPTANCE_DATA_DIR = 'C:\\input data'"));
  assert.ok(command.includes("'C:\\team''s project'"));
  assert.ok(command.includes("docker 'compose'"));
});
