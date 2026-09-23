"use client";

import type { AnalysisResult } from "@money-graph/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, createRun, getResult, getRun, type InputFiles } from "./api";
import { parseAnalysisResult } from "./validation";

type Phase = "idle" | "uploading" | "running" | "loading" | "completed" | "error";
export interface AnalysisState {
  phase: Phase; runId: string | null; result: AnalysisResult | null;
  elapsedMs: number; error: string | null; canResume: boolean;
}
const initial: AnalysisState = { phase: "idle", runId: null, result: null, elapsedMs: 0, error: null, canResume: false };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>(initial);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const execute = useCallback(async (files: InputFiles | null, fixture: boolean, resumeId?: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = controller.signal;
    const current = () => active.current === controller && !signal.aborted;
    let runId = resumeId ?? null;
    let failedRun = false;
    setState({ ...initial, phase: resumeId ? "running" : "uploading", runId });
    try {
      if (fixture) {
        if (process.env.NODE_ENV !== "development") throw new Error("Dev-fixture доступен только при разработке.");
        runId = `dev-fixture-${Date.now()}`;
        setState({ ...initial, phase: "running", runId });
        const { fixtureResult } = await import("./dev-fixture");
        await pause(600, signal);
        const result = parseAnalysisResult(fixtureResult);
        if (current()) setState({ ...initial, phase: "completed", runId, result, elapsedMs: result.metadata.elapsed_ms });
        return;
      }
      if (!runId) {
        if (!files) throw new Error("Выберите все три файла Parquet.");
        const created = await createRun(files, signal);
        runId = created.run_id;
      }
      if (!current()) return;
      setState({ ...initial, phase: "running", runId });
      while (current()) {
        const status = await getRun(runId, signal);
        if (!current()) return;
        if (status.status === "failed") {
          failedRun = true;
          setState(previous => ({ ...previous, elapsedMs: status.elapsed_ms }));
          throw new Error(`${status.error?.code ?? "RUN_FAILED"}: ${status.error?.message ?? "Расчёт завершился ошибкой."}`);
        }
        setState(previous => ({ ...previous, phase: status.status === "completed" ? "loading" : "running", elapsedMs: status.elapsed_ms }));
        if (status.status === "completed") {
          const result = await getResult(runId, signal);
          if (current()) setState({ ...initial, phase: "completed", runId, result, elapsedMs: status.elapsed_ms });
          return;
        }
        await pause(1000, signal);
      }
    } catch (error) {
      if (!current()) return;
      setState(previous => ({ ...previous, phase: "error", runId, result: null,
        error: error instanceof ApiRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Не удалось получить результат.",
        canResume: !fixture && !!runId && !failedRun }));
    }
  }, []);
  const reset = useCallback(() => { active.current?.abort(); active.current = null; setState(initial); }, []);
  return { state, execute, reset };
}
