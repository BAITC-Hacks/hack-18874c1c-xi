import { resolve } from 'node:path';
import type { spawn } from 'node:child_process';

export interface RunConfig {
  runsDir: string;
  pythonBin: string;
  timeoutMs: number;
  killGraceMs: number;
  uploadMaxBytes: number;
  uploadTimeoutMs: number;
  spawnProcess?: typeof spawn;
}

export const RUN_CONFIG = Symbol('RUN_CONFIG');

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer at most 2147483647.`);
  }
  return parsed;
}

export function readRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
  const pythonBin = env.PYTHON_BIN ?? (process.platform === 'win32' ? 'python' : 'python3');
  if (!pythonBin.trim() || pythonBin.includes('\0')) throw new Error('PYTHON_BIN must name a Python executable.');
  const runsDir = env.RUNS_DIR ?? resolve(__dirname, '../../..', 'runs');
  if (!runsDir.trim() || runsDir.includes('\0')) throw new Error('RUNS_DIR must name a directory.');
  return {
    runsDir: resolve(runsDir), pythonBin,
    timeoutMs: positiveInteger(env.PYTHON_TIMEOUT_MS, 330_000, 'PYTHON_TIMEOUT_MS'),
    killGraceMs: 2_000,
    uploadMaxBytes: positiveInteger(env.UPLOAD_MAX_BYTES, 128 * 1024 * 1024, 'UPLOAD_MAX_BYTES'),
    uploadTimeoutMs: positiveInteger(env.UPLOAD_TIMEOUT_MS, 300_000, 'UPLOAD_TIMEOUT_MS'),
  };
}
