import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function parseOptions(args) {
  const options = { dataDir: 'data', noCache: false, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-cache') options.noCache = true;
    else if (args[i] === '--help') options.help = true;
    else if (args[i] === '--data-dir') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--data-dir requires a path');
      options.dataDir = args[++i];
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return options;
}

export function mustHaveSummary(passed) {
  const automated = passed ? 'passed' : 'not_confirmed';
  return {
    M1: { automated, manual: 'pending', evidence: 'pipeline.json; independent clean-machine reproduction still needs another operator' },
    M2: { automated, evidence: 'verify-1.json; download-verification.json' },
    M3: { automated, manual: 'pending', evidence: 'independent rule oracle + browser cards; three-gid human explanation <=60s is not automated' },
    M4: { automated, evidence: 'independent cluster totals and membership; browser cluster panel' },
    M5: { automated, manual: 'pending', evidence: 'browser report, live graph/search/downloads; timed team demo still required' },
  };
}

export function isWorktreeDirty(status) {
  if (status === null) return null; // Git unavailable is not evidence of a clean checkout.
  return status.split('\n').map(line => line.trim()).filter(Boolean)
    .some(line => line !== '?? .idea/');
}

export function formatCleanupCommand(compose, environment, hostPlatform = platform()) {
  const names = ['COMPOSE_PROJECT_NAME', 'ACCEPTANCE_DATA_DIR', 'ACCEPTANCE_REPORT_DIR'];
  const powershell = hostPlatform === 'win32';
  const quote = value => `'${String(value).replaceAll("'", powershell ? "''" : "'\\''")}'`;
  const command = `docker ${[...compose, 'down', '--remove-orphans'].map(quote).join(' ')}`;
  if (powershell) return `${names.map(name => `$env:${name} = ${quote(environment[name])}`).join('; ')}; ${command}`;
  return `env ${names.map(name => quote(`${name}=${environment[name]}`)).join(' ')} ${command}`;
}

// Dependency injection keeps I/O failure tests independent of Docker and user files.
export async function runLoggedCommand(command, args, {
  cwd, env, logPath, timeout = 1800000, allowUnlogged = false,
  spawnCommand = spawn, openLog = createWriteStream, onChild = () => {},
} = {}) {
  return new Promise(resolveResult => {
    let stream, child, timer, forceTimer;
    let code = null, signal = null, spawnError, logError;
    let timedOut = false, childClosed = false, settled = false;
    const finish = () => {
      if (settled || !childClosed || (stream && !logError && !stream.writableFinished)) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer);
      onChild(undefined);
      const commandSucceeded = code === 0 && !timedOut && !spawnError;
      resolveResult({ code, signal, timedOut, spawnError, logError, commandSucceeded, passed: commandSucceeded && !logError });
    };
    const stopChild = () => {
      if (!child || childClosed || forceTimer) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const onLogError = error => {
      logError ??= error.message;
      // Drain output after unpiping a failed sink; never echo dataset-derived logs.
      child?.stdout.unpipe(stream); child?.stderr.unpipe(stream);
      child?.stdout.resume(); child?.stderr.resume();
      if (!allowUnlogged) stopChild();
      finish();
    };
    try {
      stream = openLog(logPath, { flags: 'wx' });
      stream.on('error', onLogError);
      stream.once('finish', finish);
    } catch (error) {
      logError = error.message;
      if (!allowUnlogged) { childClosed = true; finish(); return; }
    }
    try {
      child = spawnCommand(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      onChild(child);
      child.once('error', error => { spawnError = error.message; });
      child.once('close', (exitCode, exitSignal) => {
        code = exitCode; signal = exitSignal; childClosed = true;
        clearTimeout(timer); clearTimeout(forceTimer);
        if (stream && !logError) stream.end();
        finish();
      });
      timer = setTimeout(() => { timedOut = true; stopChild(); }, timeout);
      if (stream && !logError) {
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream, { end: false });
      } else {
        child.stdout.resume(); child.stderr.resume();
      }
    } catch (error) {
      spawnError = error.message; childClosed = true;
      if (stream && !logError) stream.end();
      finish();
    }
  });
}

export async function cleanupProject(step, compose) {
  let logError, cleanupError, stopped = false;
  try {
    await step('service-logs', [...compose, 'logs', '--no-color', 'api', 'web'], { tolerateFailure: true, timeout: 30000 });
  } catch (error) {
    logError = error.message;
  } finally {
    // Even a broken/full report filesystem must not prevent the isolated down command.
    try {
      stopped = await step('cleanup', [...compose, 'down', '--remove-orphans', '--timeout', '10'], { tolerateFailure: true, timeout: 60000, allowUnlogged: true });
    } catch (error) {
      cleanupError = error.message;
    }
  }
  return { stopped, logError, cleanupError };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('node scripts/acceptance/run.mjs [--data-dir PATH] [--no-cache]\nRequires Node.js + Docker Compose and the three official Parquet files. No host npm/Python/browser installation is required. Reports stay in artifacts/acceptance-<unique>/.');
    return;
  }
  const input = resolve(root, options.dataDir);
  for (const name of ['nodes', 'edges', 'transactions']) {
    const path = join(input, `${name}.parquet`);
    if (!existsSync(path) || !statSync(path).isFile() || !statSync(path).size) {
      throw new Error(`Official dataset missing/empty: ${name}.parquet. Obtain the organizer files separately; fixtures are not a fallback.`);
    }
  }
  const id = `${new Date().toISOString().replace(/[^0-9]/g, '')}-${randomUUID().slice(0, 8)}`;
  const reportDir = join(root, 'artifacts', `acceptance-${id}`);
  mkdirSync(join(reportDir, 'logs'), { recursive: true });
  const project = `mg-acceptance-${id}`;
  const env = { ...process.env, COMPOSE_PROJECT_NAME: project,
    ACCEPTANCE_DATA_DIR: input, ACCEPTANCE_REPORT_DIR: reportDir,
    BUILDKIT_PROGRESS: 'plain', NEXT_TELEMETRY_DISABLED: '1' };
  const compose = ['compose', '--project-name', project, '--project-directory', root, '-f', join(root, 'docker/compose.acceptance.yaml')];
  const report = { schema_version: '1.0', status: 'running', dataset_mode: 'official',
    started_at: new Date().toISOString(), project, source_commit: git(['rev-parse', 'HEAD']),
    source_worktree_dirty: isWorktreeDirty(git(['status', '--porcelain', '--untracked-files=normal'])),
    host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
    build_cache_disabled: options.noCache, steps: [], must_have: mustHaveSummary(false),
    judging: { points_awarded: null, note: '25/25/25/15/10 are judging criteria, not automatically awarded scores. See docs/ACCEPTANCE.md.' },
    privacy: 'Local evidence may contain real gids/transactions. Do not commit/upload this directory.',
  };
  const save = () => writeFileSync(join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  save();
  console.log(`Acceptance project: ${project}\nLocal reports: ${reportDir}`);
  let activeChild;
  let interrupted = false;
  const onSignal = () => { interrupted = true; activeChild?.kill('SIGTERM'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  async function step(name, commandArgs, { tolerateFailure = false, timeout = 1800000, allowUnlogged = false } = {}) {
    if (interrupted && !tolerateFailure) throw new Error('Acceptance interrupted');
    const logPath = join(reportDir, 'logs', `${name}.log`);
    const started = performance.now();
    console.log(`[${name}] running; log: logs/${name}.log`);
    const result = await runLoggedCommand('docker', commandArgs, {
      cwd: root, env, logPath, timeout, allowUnlogged,
      onChild: child => { activeChild = child; },
    });
    const passed = result.passed;
    report.steps.push({ name, status: passed ? 'passed' : 'failed', duration_ms: Math.round(performance.now() - started),
      exit_code: result.code, signal: result.signal, timed_out: result.timedOut, error: result.spawnError, log_error: result.logError,
      log: `logs/${name}.log` });
    save();
    console.log(`[${name}] ${passed ? 'PASS' : 'FAIL'}`);
    if (!passed && !tolerateFailure) throw new Error(`${name} failed; inspect ${logPath}`);
    return allowUnlogged ? result.commandSucceeded : passed;
  }

  let failure;
  try {
    await step('docker-version', ['version']);
    await step('compose-version', ['compose', 'version']);
    await step('compose-config', [...compose, 'config', '--quiet']);
    await step('build', [...compose, 'build', '--pull', ...(options.noCache ? ['--no-cache'] : []), 'pipeline', 'checks', 'api', 'web', 'browser']);
    await step('component-tests', [...compose, 'run', '--rm', '--no-deps', 'checks']);
    await step('pipeline', [...compose, 'run', '--rm', '--no-deps', 'pipeline']);
    await step('http-integration', [...compose, 'run', '--rm', '--no-deps', 'integration']);
    await step('start', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '120', '--no-build', 'api', 'web']);
    await step('browser', [...compose, 'run', '--rm', '--no-deps', 'browser']);
    await step('download-verification', [...compose, 'run', '--rm', '--no-deps', 'verify-downloads']);
    report.status = 'automated_pass_manual_pending';
    report.must_have = mustHaveSummary(true);
    report.pipeline = JSON.parse(readFileSync(join(reportDir, 'pipeline.json'), 'utf8'));
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = error.message;
  } finally {
    // Only the freshly generated project is stopped; outputs and other stacks remain.
    const cleanup = await cleanupProject(step, compose);
    if (cleanup.logError) report.service_logs_error = cleanup.logError;
    if (cleanup.cleanupError) report.cleanup_error = cleanup.cleanupError;
    if (!cleanup.stopped) {
      report.cleanup_required = formatCleanupCommand(compose, env);
      report.cleanup_shell = platform() === 'win32' ? 'PowerShell' : 'POSIX shell';
      report.status = 'failed';
      failure ??= new Error('Test containers could not be stopped; see cleanup log and report.json');
    }
    report.finished_at = new Date().toISOString();
    save();
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
  if (failure) throw failure;
  console.log(`Automated acceptance passed. Human M3/demo and independent reproduction remain pending.\nReport: ${join(reportDir, 'report.json')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
