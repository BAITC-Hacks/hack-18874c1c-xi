/** A run reference only: never persist File objects, financial data or results. */
export interface RunSessionHost {
  location: Pick<Location, "href">;
  history: Pick<History, "state" | "replaceState">;
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export interface RunReference {
  runId: string | null;
  source: "url" | "storage" | null;
  invalid: boolean;
}

function browser(): RunSessionHost | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function isRunId(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

export function isFixtureSession(search: string, development: boolean): boolean {
  return development && new URLSearchParams(search).get("fixture") === "1";
}

export function runSessionStorageKey(apiBase: string): string {
  return `money-graph:run:v1:${encodeURIComponent(apiBase.replace(/\/+$/, ""))}`;
}

export function parseStoredRunReference(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return record.version === 1 && isRunId(record.runId) ? record.runId : null;
  } catch { return null; }
}

function locationUrl(host: RunSessionHost): URL | null {
  try { return new URL(host.location.href); } catch { return null; }
}

/** An explicit URL always wins, including an invalid URL that must not open another run. */
export function readRunSession(apiBase: string, host = browser()): RunReference {
  if (!host) return { runId: null, source: null, invalid: false };
  const url = locationUrl(host);
  if (url?.searchParams.has("run")) {
    const values = url.searchParams.getAll("run");
    return values.length === 1 && isRunId(values[0])
      ? { runId: values[0], source: "url", invalid: false }
      : { runId: null, source: "url", invalid: true };
  }
  try {
    const runId = parseStoredRunReference(host.localStorage.getItem(runSessionStorageKey(apiBase)));
    if (runId) return { runId, source: "storage", invalid: false };
  } catch { /* Storage may be disabled or unavailable; URL restoration still works. */ }
  return { runId: null, source: null, invalid: false };
}

/** Pin a tab's reference without replacing the last confirmed run in another tab. */
export function writeRunSessionUrl(apiBase: string, runId: string, host = browser()): void {
  if (!host || !isRunId(runId)) return;
  const previousRun = readRunSession(apiBase, host).runId;
  const url = locationUrl(host);
  if (url) {
    url.searchParams.set("run", runId);
    if (previousRun !== runId) url.searchParams.delete("gid");
    try { host.history.replaceState(host.history.state, "", url.href); } catch { /* The existing storage fallback may still work. */ }
  }
}

/** Called only after HTTP 202 or a successful status response for a restored run. */
export function saveRunSession(apiBase: string, runId: string, host = browser()): void {
  if (!host || !isRunId(runId)) return;
  writeRunSessionUrl(apiBase, runId, host);
  try {
    host.localStorage.setItem(runSessionStorageKey(apiBase), JSON.stringify({ version: 1, runId }));
  } catch { /* URL persistence works even with blocked storage or exhausted quota. */ }
}

/** Clear this browser reference; this never stops or deletes a server calculation. */
export function clearRunSession(apiBase: string, host = browser(), expectedRunId?: string): void {
  if (!host) return;
  const url = locationUrl(host);
  if (url && (expectedRunId === undefined || url.searchParams.get("run") === expectedRunId)) {
    url.searchParams.delete("run");
    url.searchParams.delete("gid");
    try { host.history.replaceState(host.history.state, "", url.href); } catch { /* Clear storage independently. */ }
  }
  try {
    const key = runSessionStorageKey(apiBase);
    if (expectedRunId === undefined || parseStoredRunReference(host.localStorage.getItem(key)) === expectedRunId) host.localStorage.removeItem(key);
  } catch { /* Storage may be disabled. */ }
}
