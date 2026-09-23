"use client";

import type { AnalysisResult } from "@money-graph/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, apiBaseUrl, createRun, getResult, getRun, type InputFiles } from "./api";
import { clearRunSession, isFixtureSession, isRunId, readRunSession, saveRunSession, writeRunSessionUrl } from "./run-session";
import { parseAnalysisResult } from "./validation";

type Phase = "idle" | "restoring" | "uploading" | "running" | "loading" | "completed" | "error";
export interface AnalysisState {
  phase: Phase; runId: string | null; result: AnalysisResult | null;
  elapsedMs: number; error: string | null; canResume: boolean; restored: boolean;
}
const initial: AnalysisState = { phase: "idle", runId: null, result: null, elapsedMs: 0, error: null, canResume: false, restored: false };

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>({ ...initial, phase: "restoring" });
  const active = useRef<AbortController | null>(null);

  const execute = useCallback(async (files: InputFiles | null, fixture: boolean, resumeId?: string) => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const signal = controller.signal;
    const current = () => active.current === controller && !signal.aborted;
    let runId = resumeId ?? null;
    let failedRun = false;
    const restored = resumeId !== undefined;
    setState({ ...initial, phase: restored ? "restoring" : "uploading", runId, restored });
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
      if (runId !== null && !isRunId(runId)) throw new ApiRequestError("Некорректный идентификатор сохранённого запуска. Начните новый анализ.", "INVALID_RUN_ID");
      if (!runId) {
        if (!files) throw new Error("Выберите все три файла Parquet.");
        const created = await createRun(files, signal);
        if (!current()) return;
        if (!isRunId(created.run_id)) throw new ApiRequestError("API вернул некорректный идентификатор запуска.", "INVALID_RESPONSE");
        runId = created.run_id;
      }
      if (!current()) return;
      // The old reference survives a rejected upload; replace it only after acceptance.
      if (restored) writeRunSessionUrl(apiBaseUrl, runId);
      else saveRunSession(apiBaseUrl, runId);
      setState({ ...initial, phase: restored ? "restoring" : "running", runId, restored });
      let referenceConfirmed = !restored;
      while (current()) {
        const status = await getRun(runId, signal);
        if (!current()) return;
        if (!referenceConfirmed) { saveRunSession(apiBaseUrl, runId); referenceConfirmed = true; }
        if (status.status === "failed") {
          failedRun = true;
          setState(previous => ({ ...previous, elapsedMs: status.elapsed_ms }));
          throw new Error(`${status.error?.code ?? "RUN_FAILED"}: ${status.error?.message ?? "Расчёт завершился ошибкой."}`);
        }
        setState(previous => ({ ...previous, phase: status.status === "completed" ? "loading" : "running", elapsedMs: status.elapsed_ms }));
        if (status.status === "completed") {
          const result = await getResult(runId, signal);
          if (current()) setState({ ...initial, phase: "completed", runId, result, elapsedMs: status.elapsed_ms, restored });
          return;
        }
        await pause(1000, signal);
      }
    } catch (error) {
      if (!current()) return;
      const unavailable = error instanceof ApiRequestError && error.status === 404;
      const invalidReference = error instanceof ApiRequestError && error.code === "INVALID_RUN_ID";
      if (unavailable && runId) clearRunSession(apiBaseUrl, undefined, runId);
      setState(previous => ({ ...previous, phase: "error", runId, result: null,
        error: unavailable ? "Сохранённый запуск недоступен на сервере: он удалён или API был перезапущен. Начните новый анализ, выбрав три файла Parquet."
          : error instanceof ApiRequestError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Не удалось получить результат.",
        canResume: !fixture && !!runId && !failedRun && !unavailable && !invalidReference }));
    }
  }, []);
  useEffect(() => {
    if (isFixtureSession(window.location.search, process.env.NODE_ENV === "development")) {
      setState(initial);
    } else {
      const reference = readRunSession(apiBaseUrl);
      if (reference.invalid) {
        setState({ ...initial, phase: "error", error: "В ссылке указан некорректный идентификатор запуска. Начните новый анализ." });
      } else if (reference.runId) {
        void execute(null, false, reference.runId);
      } else {
        setState(initial);
      }
    }
    // Each setup starts its own GET workflow, including React StrictMode's second setup.
    return () => { active.current?.abort(); active.current = null; };
  }, [execute]);
  const reset = useCallback(() => {
    active.current?.abort(); active.current = null;
    if (!isFixtureSession(window.location.search, process.env.NODE_ENV === "development")) {
      const reference = readRunSession(apiBaseUrl);
      clearRunSession(apiBaseUrl, undefined, state.runId ?? reference.runId ?? undefined);
    }
    setState(initial);
  }, [state.runId]);
  return { state, execute, reset };
}
