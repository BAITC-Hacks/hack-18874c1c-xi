const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const { Logger } = require('@nestjs/common');
const { runPython, PythonProcessError } = require('../dist/python-runner.js');

Logger.overrideLogger(false);

function controlledProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

function options(child, overrides = {}) {
  return {
    pythonBin: 'C:/Program Files/Python/python.exe',
    inputDir: 'C:/server runs/private input;$(command)',
    outputDir: 'C:/server runs/private output',
    timeoutMs: 1000,
    spawnProcess: () => child,
    ...overrides,
  };
}

function capture(promise) {
  let settled = false;
  const outcome = promise.then(
    () => { settled = true; return null; },
    (error) => { settled = true; return error; },
  );
  return { outcome, settled: () => settled };
}

async function waitForSignals(child, count) {
  const deadline = Date.now() + 2000;
  while (child.signals.length < count && Date.now() < deadline) await delay(5);
  assert.equal(child.signals.length, count);
}

test('spawns a fixed Python module without shell and waits for close after exit', async () => {
  const child = controlledProcess();
  let invocation;
  const config = options(child, { spawnProcess: (...args) => { invocation = args; return child; } });
  const result = capture(runPython(config));
  assert.deepEqual(invocation, [config.pythonBin, [
    '-m', 'money_graph', '--input-dir', config.inputDir, '--output-dir', config.outputDir,
  ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }]);
  child.emit('spawn');
  child.stdout.write('ordinary output');
  child.emit('exit', 0, null);
  await delay(0);
  assert.equal(result.settled(), false);
  child.stderr.write('a late diagnostic');
  child.emit('close', 0, null);
  assert.equal(await result.outcome, null);
});

test('synchronous spawn failure returns a safe error with server diagnostics', async () => {
  const result = await capture(runPython(options(null, {
    spawnProcess: () => { throw new Error('ENOENT C:/private/python.exe'); },
  }))).outcome;
  assert.ok(result instanceof PythonProcessError);
  assert.equal(result.code, 'PYTHON_START_FAILED');
  assert.doesNotMatch(result.message, /private|ENOENT/);
  assert.match(result.diagnostics.processError, /ENOENT C:\/private/);
  assert.doesNotMatch(JSON.stringify(result), /private|ENOENT/);
});

test('asynchronous process start error waits for close and cannot become success', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child)));
  child.emit('error', new Error('ENOENT C:/private/python.exe'));
  await delay(0);
  assert.equal(result.settled(), false);
  child.emit('close', 0, null);
  const error = await result.outcome;
  assert.equal(error.code, 'PYTHON_START_FAILED');
  assert.doesNotMatch(error.message, /private|ENOENT/);
});

test('nonzero exit drains both streams and retains only bounded diagnostic tails', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child)));
  child.emit('spawn');
  child.stdout.write('a'.repeat(100000));
  child.stderr.write('b'.repeat(100000));
  child.emit('exit', 7, null);
  child.stdout.write(' stdout tail');
  child.stderr.write(' private stderr tail');
  child.emit('close', 7, null);
  const error = await result.outcome;
  assert.equal(error.code, 'PYTHON_FAILED');
  assert.equal(error.diagnostics.exitCode, 7);
  assert.ok(Buffer.byteLength(error.diagnostics.stdout) <= 16384);
  assert.ok(Buffer.byteLength(error.diagnostics.stderr) <= 16384);
  assert.ok(error.diagnostics.stdout.endsWith(' stdout tail'));
  assert.ok(error.diagnostics.stderr.endsWith(' private stderr tail'));
  assert.doesNotMatch(error.message, /private|stderr tail/);
});

test('a signal termination is a failure even without an exit code', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child)));
  child.emit('spawn');
  child.emit('close', null, 'SIGTERM');
  const error = await result.outcome;
  assert.equal(error.code, 'PYTHON_FAILED');
  assert.equal(error.diagnostics.signal, 'SIGTERM');
});

test('an error from an already running process is a failure', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child)));
  child.emit('spawn');
  child.emit('error', new Error('running process error'));
  child.emit('close', 0, null);
  assert.equal((await result.outcome).code, 'PYTHON_FAILED');
});

test('timeout sends TERM but does not settle or release the process before close', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child, { timeoutMs: 10, killGraceMs: 500 })));
  await waitForSignals(child, 1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(result.settled(), false);
  child.emit('close', 0, null);
  assert.equal((await result.outcome).code, 'PYTHON_TIMEOUT');
  await delay(20);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('timeout escalates to KILL and still waits for close', async () => {
  const child = controlledProcess();
  const result = capture(runPython(options(child, { timeoutMs: 10, killGraceMs: 10 })));
  await waitForSignals(child, 2);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(result.settled(), false);
  child.emit('close', null, 'SIGKILL');
  assert.equal((await result.outcome).code, 'PYTHON_TIMEOUT');
});

test('successful close clears process timeout', async () => {
  const child = controlledProcess();
  const result = runPython(options(child, { timeoutMs: 10, killGraceMs: 10 }));
  child.emit('close', 0, null);
  await result;
  await delay(40);
  assert.deepEqual(child.signals, []);
});

test('aborted shutdown signal prevents spawning', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  const result = await capture(runPython(options(null, {
    signal: controller.signal,
    spawnProcess: () => { spawned = true; throw new Error('must not spawn'); },
  }))).outcome;
  assert.equal(spawned, false);
  assert.equal(result.code, 'PYTHON_CANCELLED');
});

test('shutdown abort terminates the process and waits for close', async () => {
  const child = controlledProcess();
  const controller = new AbortController();
  const result = capture(runPython(options(child, { signal: controller.signal, killGraceMs: 500 })));
  controller.abort();
  assert.deepEqual(child.signals, ['SIGTERM']);
  await delay(0);
  assert.equal(result.settled(), false);
  child.emit('close', null, 'SIGTERM');
  assert.equal((await result.outcome).code, 'PYTHON_CANCELLED');
});

test('a real missing executable is reported safely after Node emits error and close', async () => {
  const result = await capture(runPython(options(null, {
    pythonBin: join(tmpdir(), `missing-money-graph-python-${randomUUID()}`),
    spawnProcess: spawn,
  }))).outcome;
  assert.equal(result.code, 'PYTHON_START_FAILED');
  assert.match(result.diagnostics.processError, /ENOENT/);
  assert.doesNotMatch(result.message, /ENOENT|missing-money-graph/);
});

test('a real controlled process drains output before successful completion', async () => {
  await runPython(options(null, {
    spawnProcess: (_command, _args, spawnOptions) => spawn(process.execPath, [
      '-e', 'process.stdout.write("x".repeat(262144)); process.stderr.write("y".repeat(262144));',
    ], spawnOptions),
    timeoutMs: 5000,
  }));
});

test('a real controlled process is reaped before timeout rejection', async () => {
  let child;
  const result = await capture(runPython(options(null, {
    spawnProcess: (_command, _args, spawnOptions) => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], spawnOptions);
      return child;
    },
    timeoutMs: 100,
    killGraceMs: 100,
  }))).outcome;
  assert.equal(result.code, 'PYTHON_TIMEOUT');
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
