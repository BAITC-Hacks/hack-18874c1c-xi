import { CSV_FILES, type AnalysisResult, type CsvFile, type RunState } from "@money-graph/contracts";
import { ContractError, parseAnalysisResult, parseRunState } from "./validation";

export type InputFiles = Record<"nodes" | "edges" | "transactions", File>;
export interface CreatedRun { run_id: string; status: "running" }

export class ApiRequestError extends Error {
  constructor(message: string, public readonly code: string, public readonly status?: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const apiBaseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api").replace(/\/+$/, "");
const GET_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 120_000;

function aborted(): DOMException {
  return new DOMException("Запрос отменён.", "AbortError");
}

async function httpError(response: Response): Promise<ApiRequestError> {
  let message: string | undefined;
  let code = `HTTP_${response.status}`;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const outer = body as Record<string, unknown>;
      const error = outer.error && typeof outer.error === "object" ? outer.error as Record<string, unknown> : outer;
      if (typeof error.code === "string") code = error.code;
      if (typeof error.message === "string" && error.message.trim()) message = error.message;
      if (Array.isArray(error.message) && error.message.every((value) => typeof value === "string")) message = error.message.join("; ");
    }
  } catch { /* Non-JSON responses get a clear status-based message. */ }
  const fallback: Record<number, string> = {
    400: "API отклонил загрузку. Проверьте три файла Parquet.",
    404: "Запуск или файл не найден на сервере.",
    409: "Расчёт уже выполняется или результат пока недоступен.",
    413: "Файлы превышают допустимый размер загрузки API.",
    501: "Расчёт ещё не реализован на backend.",
  };
  return new ApiRequestError(message || fallback[response.status] || `Ошибка API: HTTP ${response.status}.`, code, response.status);
}

async function request<T>(path: string, options: RequestInit, signal: AbortSignal | undefined, consume: (response: Response) => Promise<T>): Promise<T> {
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.method === "POST" ? UPLOAD_TIMEOUT_MS : GET_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, { ...options, cache: "no-store", signal: controller.signal });
    if (!response.ok) throw await httpError(response);
    const result = await consume(response);
    if (controller.signal.aborted) throw aborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw aborted();
    if (timedOut) throw new ApiRequestError(options.method === "POST"
      ? "Истекло время ожидания загрузки. Сервер мог принять запуск; проверьте backend перед повтором."
      : "API не ответил вовремя. Проверьте соединение и состояние backend.", "TIMEOUT");
    if (error instanceof ApiRequestError || error instanceof ContractError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof SyntaxError) throw new ApiRequestError("API вернул некорректный JSON.", "INVALID_RESPONSE");
    throw new ApiRequestError("Не удалось связаться с API. Проверьте, что NestJS запущен и адрес API доступен.", "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function runPath(runId: string): string {
  if (!runId.trim()) throw new ApiRequestError("Не указан идентификатор запуска.", "INVALID_RUN_ID");
  return `/runs/${encodeURIComponent(runId)}`;
}

export async function createRun(files: InputFiles, signal?: AbortSignal): Promise<CreatedRun> {
  const form = new FormData();
  for (const field of ["nodes", "edges", "transactions"] as const) {
    const file = files[field];
    if (!(file instanceof File) || file.size === 0) throw new ApiRequestError(`Выберите непустой файл ${field}.parquet.`, "INVALID_FILES");
    form.append(field, file, file.name);
  }
  return request("/runs", { method: "POST", body: form, headers: { Accept: "application/json" } }, signal, async (response) => {
    const value: unknown = await response.json();
    if (response.status !== 202 || !value || typeof value !== "object" || !("run_id" in value) || typeof value.run_id !== "string" || !value.run_id.trim() || !("status" in value) || value.status !== "running") {
      throw new ApiRequestError("API не подтвердил запуск расчёта по контракту (ожидается HTTP 202 и run_id).", "INVALID_RESPONSE");
    }
    return { run_id: value.run_id, status: "running" };
  });
}

export async function getRun(runId: string, signal?: AbortSignal): Promise<RunState> {
  return request(runPath(runId), { headers: { Accept: "application/json" } }, signal, async (response) => parseRunState(await response.json(), runId));
}

export async function getResult(runId: string, signal?: AbortSignal): Promise<AnalysisResult> {
  return request(`${runPath(runId)}/result`, { headers: { Accept: "application/json" } }, signal, async (response) => parseAnalysisResult(await response.json()));
}

export async function getExport(runId: string, filename: CsvFile, signal?: AbortSignal): Promise<Blob> {
  if (!(CSV_FILES as readonly string[]).includes(filename)) throw new ApiRequestError("Неизвестное имя CSV-файла.", "INVALID_EXPORT");
  return request(`${runPath(runId)}/exports/${encodeURIComponent(filename)}`, { headers: { Accept: "text/csv" } }, signal, async (response) => {
    const blob = await response.blob();
    if (!blob.size) throw new ApiRequestError("API вернул пустой файл экспорта.", "INVALID_EXPORT");
    return blob;
  });
}
