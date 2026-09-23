import { HttpException, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { CSV_FILES, type CsvFile, type RunState } from '@money-graph/contracts';
import { RUN_CONFIG, type RunConfig } from './run-config';
import { receiveUpload } from './run-upload';
import { runPython, PythonProcessError } from './python-runner';
import { validateArtifacts } from './artifacts';

interface Run {
  state: RunState;
  started: number;
  artifacts?: Awaited<ReturnType<typeof validateArtifacts>>;
}

function httpError(status: number, code: string, message: string): never {
  throw new HttpException({ statusCode: status, error: { code, message } }, status);
}

@Injectable()
export class RunsService implements OnModuleDestroy {
  private readonly logger = new Logger(RunsService.name);
  private readonly runs = new Map<string, Run>();
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private closing = false;

  constructor(@Inject(RUN_CONFIG) private readonly config: RunConfig) {}

  async create(request: Request, response: Response): Promise<{ run_id: string; status: 'running' }> {
    if (this.active || this.closing) httpError(409, 'RUN_ACTIVE', 'Another run is active. Wait for it to finish.');
    if (!request.is('multipart/form-data')) httpError(400, 'UPLOAD_INVALID', 'Send nodes, edges and transactions as multipart files.');
    const id = randomUUID();
    let finish: () => void = () => {};
    const active = { id, abort: new AbortController(), done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.active = active; // Reserve before any I/O, including upload, so simultaneous POSTs cannot race.
    const runDir = join(this.config.runsDir, id);
    const inputDir = join(runDir, 'input');
    const outputDir = join(runDir, 'output');
    const abortUpload = () => active.abort.abort();
    request.once('aborted', abortUpload);
    const timer = setTimeout(abortUpload, this.config.uploadTimeoutMs);
    timer.unref();
    try {
      await mkdir(inputDir, { recursive: true });
      await mkdir(outputDir);
      await receiveUpload(request, response, inputDir, this.config.uploadMaxBytes, active.abort.signal);
      if (active.abort.signal.aborted) throw new Error('Upload interrupted.');
    } catch (error) {
      this.logger.warn(`Upload ${id} rejected: ${String(error)}`);
      await rm(runDir, { recursive: true, force: true }).catch((cleanup: unknown) => this.logger.error(cleanup));
      if (this.active === active) this.active = undefined;
      finish();
      httpError(400, 'UPLOAD_INVALID', 'Upload exactly one nonempty file in each of nodes, edges and transactions, within the configured size and time limits.');
    } finally {
      clearTimeout(timer);
      request.removeListener('aborted', abortUpload);
    }
    const run: Run = { started: performance.now(), state: { run_id: id, status: 'running', elapsed_ms: 0, error: null } };
    this.runs.set(id, run);
    void this.execute(run, inputDir, outputDir, active.abort.signal).finally(() => {
      if (this.active === active) this.active = undefined;
      finish();
    });
    return { run_id: id, status: 'running' };
  }

  private async execute(run: Run, inputDir: string, outputDir: string, signal: AbortSignal): Promise<void> {
    try {
      await runPython({ ...this.config, inputDir, outputDir, signal });
      run.artifacts = await validateArtifacts(outputDir);
      run.state.status = 'completed';
    } catch (error) {
      this.logger.error(`Run ${run.state.run_id}: ${String(error)}`, error instanceof PythonProcessError ? error.diagnostics : undefined);
      run.state.status = 'failed';
      run.state.error = error instanceof PythonProcessError
        ? { code: error.code, message: error.message }
        : { code: 'ARTIFACTS_INVALID', message: 'Python output is missing or violates the analysis/CSV contract. See the API log for details.' };
    } finally {
      run.state.elapsed_ms = Math.round(performance.now() - run.started);
    }
  }

  private find(id: string): Run {
    const run = this.runs.get(id);
    if (!run) httpError(404, 'RUN_NOT_FOUND', 'Run not found.');
    return run;
  }

  get(id: string): RunState {
    const run = this.find(id);
    return { ...run.state, elapsed_ms: run.state.status === 'running' ? Math.round(performance.now() - run.started) : run.state.elapsed_ms };
  }

  private completed(id: string): NonNullable<Run['artifacts']> {
    const run = this.find(id);
    if (run.state.status !== 'completed' || !run.artifacts) httpError(409, 'RUN_NOT_COMPLETED', 'Results are available only for a completed run.');
    return run.artifacts;
  }

  result(id: string) { return this.completed(id).analysis; }

  export(id: string, filename: string): Buffer {
    if (!(CSV_FILES as readonly string[]).includes(filename)) httpError(404, 'EXPORT_NOT_FOUND', 'Export not found.');
    return this.completed(id).csv[filename as CsvFile];
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.active?.abort.abort();
    await this.active?.done;
  }
}
