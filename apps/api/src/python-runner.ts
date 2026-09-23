import { Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';

export interface RunPythonOptions {
  pythonBin: string;
  inputDir: string;
  outputDir: string;
  timeoutMs: number;
  killGraceMs?: number;
  spawnProcess?: typeof spawn;
  signal?: AbortSignal;
}

type ProcessErrorCode = 'PYTHON_START_FAILED' | 'PYTHON_FAILED' | 'PYTHON_TIMEOUT' | 'PYTHON_CANCELLED';

export interface PythonDiagnostics {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processError?: string;
}

const MESSAGES: Record<ProcessErrorCode, string> = {
  PYTHON_START_FAILED: 'Unable to start the Python analysis process.',
  PYTHON_FAILED: 'The Python analysis process failed. Check the server diagnostics.',
  PYTHON_TIMEOUT: 'The Python analysis process exceeded its execution timeout.',
  PYTHON_CANCELLED: 'The Python analysis process was stopped because the API is shutting down.',
};
const LOG_LIMIT = 16 * 1024;

export class PythonProcessError extends Error {
  declare readonly diagnostics: PythonDiagnostics;

  constructor(readonly code: ProcessErrorCode, diagnostics: PythonDiagnostics) {
    super(MESSAGES[code]);
    this.name = 'PythonProcessError';
    // Explicitly inspectable by the server, omitted by accidental JSON serialization.
    Object.defineProperty(this, 'diagnostics', { value: diagnostics, enumerable: false });
  }
}

function appendTail(previous: Buffer, chunk: Buffer | string): Buffer {
  const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (next.length >= LOG_LIMIT) return Buffer.from(next.subarray(-LOG_LIMIT));
  return Buffer.from(Buffer.concat([previous, next]).subarray(-LOG_LIMIT));
}

function tailText(buffer: Buffer): string {
  let start = 0;
  // Avoid introducing a replacement character when the retained UTF-8 tail
  // starts in the middle of a multibyte character.
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function failure(code: ProcessErrorCode, diagnostics: PythonDiagnostics): PythonProcessError {
  Logger.error(JSON.stringify({ code, ...diagnostics }), 'PythonRunner');
  return new PythonProcessError(code, diagnostics);
}

export function runPython(options: RunPythonOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const diagnostics: PythonDiagnostics = { stdout: '', stderr: '', exitCode: null, signal: null };
    if (options.signal?.aborted) {
      reject(failure('PYTHON_CANCELLED', diagnostics));
      return;
    }

    let child: ChildProcess;
    try {
      child = (options.spawnProcess ?? spawn)(options.pythonBin, [
        '-m', 'money_graph', '--input-dir', options.inputDir, '--output-dir', options.outputDir,
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      diagnostics.processError = String(error).slice(-LOG_LIMIT);
      reject(failure('PYTHON_START_FAILED', diagnostics));
      return;
    }

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let spawned = false;
    let closed = false;
    let stopCode: 'PYTHON_TIMEOUT' | 'PYTHON_CANCELLED' | undefined;
    let processErrorCode: 'PYTHON_START_FAILED' | 'PYTHON_FAILED' | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let killTimeout: NodeJS.Timeout | undefined;

    const kill = (signal: NodeJS.Signals) => {
      try {
        child.kill(signal);
      } catch (error) {
        diagnostics.processError = String(error).slice(-LOG_LIMIT);
      }
    };
    const stop = (code: 'PYTHON_TIMEOUT' | 'PYTHON_CANCELLED') => {
      if (closed || stopCode) return;
      stopCode = code;
      kill('SIGTERM');
      if (!closed) {
        killTimeout = setTimeout(() => { if (!closed) kill('SIGKILL'); }, options.killGraceMs ?? 1000);
      }
      // The caller owns the active slot until close confirms the process ended.
    };
    const onAbort = () => stop('PYTHON_CANCELLED');

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = appendTail(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = appendTail(stderr, chunk); });
    child.once('spawn', () => { spawned = true; });
    child.on('error', (error: Error) => {
      processErrorCode = spawned ? 'PYTHON_FAILED' : 'PYTHON_START_FAILED';
      diagnostics.processError = String(error).slice(-LOG_LIMIT);
    });
    child.once('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      options.signal?.removeEventListener('abort', onAbort);
      Object.assign(diagnostics, {
        stdout: tailText(stdout), stderr: tailText(stderr), exitCode, signal,
      });
      const code = stopCode ?? processErrorCode ?? ((exitCode !== 0 || signal) ? 'PYTHON_FAILED' : undefined);
      if (code) reject(failure(code, diagnostics));
      else resolve();
    });
    timeout = setTimeout(() => stop('PYTHON_TIMEOUT'), options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
}
