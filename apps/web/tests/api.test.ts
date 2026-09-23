import assert from "node:assert/strict";
import test from "node:test";
import { ApiRequestError, createRun, getExport, getResult, getRun, type InputFiles } from "../lib/api";

function files(): InputFiles {
  return Object.fromEntries(["nodes", "edges", "transactions"].map((name) => [name, new File(["PAR1"], `${name}.parquet`)])) as InputFiles;
}

const running = { run_id: "run-1", status: "running", elapsed_ms: 10, error: null };

test("uploads exactly the three multipart fields and lets fetch set the boundary", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.ok(url.endsWith("/api/runs"));
    assert.equal(options.method, "POST");
    assert.equal(new Headers(options.headers).has("Content-Type"), false);
    assert.ok(options.body instanceof FormData);
    assert.deepEqual([...options.body.keys()], ["nodes", "edges", "transactions"]);
    assert.equal((options.body.get("nodes") as File).name, "nodes.parquet");
    return Response.json({ run_id: "run-1", status: "running" }, { status: 202 });
  });
  assert.deepEqual(await createRun(files()), { run_id: "run-1", status: "running" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("rejects missing or empty input before making a request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(running));
  await assert.rejects(createRun({ ...files(), edges: new File([], "edges.parquet") }), { code: "INVALID_FILES" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("does not accept a success-shaped response with the wrong HTTP status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ run_id: "run-1", status: "running" }));
  await assert.rejects(createRun(files()), { code: "INVALID_RESPONSE" });
});

test("validates the status of the requested run", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(options.cache, "no-store");
    return Response.json(running);
  });
  assert.deepEqual(await getRun("run-1"), running);
  await assert.rejects(getRun("run-2"), /другой запуск/);
});

test("returns a valid empty result and rejects malformed result data", async (t) => {
  const empty = { metadata: { schema_version: "1.0", n_nodes: 0, n_edges: 0, n_transactions: 0, n_seeds: 0, elapsed_ms: 5, warnings: [] }, nodes: [], edges: [], clusters: [], top_nodes: [] };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(empty));
  assert.deepEqual(await getResult("run-1"), empty);
  fetchMock.mock.mockImplementation(async () => Response.json({ nodes: [] }));
  await assert.rejects(getResult("run-1"), /Некорректный ответ API/);
});

test("preserves API errors; never substitutes fixture data", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "PIPELINE_NOT_IMPLEMENTED", message: "Расчёт не реализован." } }, { status: 501 }));
  await assert.rejects(getResult("run-1"), (error: unknown) => error instanceof ApiRequestError && error.status === 501 && error.code === "PIPELINE_NOT_IMPLEMENTED" && error.message === "Расчёт не реализован.");
  fetchMock.mock.mockImplementation(async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(getRun("run-1"), { code: "NETWORK_ERROR" });
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("handles non-JSON HTTP errors and malformed success JSON", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("<html>gateway error</html>", { status: 502 }));
  await assert.rejects(getRun("run-1"), { status: 502, code: "HTTP_502" });
  fetchMock.mock.mockImplementation(async () => new Response("<html>not JSON</html>"));
  await assert.rejects(getRun("run-1"), { code: "INVALID_RESPONSE" });
});

test("downloads backend CSV bytes and only allows the three contract filenames", async (t) => {
  const bytes = "gid,role\r\n9223372036854775807,peripheral\r\n";
  const fetchMock = t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.endsWith("/api/runs/run%2F1/exports/nodes_roles.csv"));
    return new Response(bytes, { headers: { "Content-Type": "text/csv" } });
  });
  assert.equal(await (await getExport("run/1", "nodes_roles.csv")).text(), bytes);
  await assert.rejects(getExport("run/1", "../secrets" as "nodes_roles.csv"), { code: "INVALID_EXPORT" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("rejects already aborted and in-flight requests without reporting a network error", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const controller = new AbortController();
  const pending = getRun("run-1", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(getRun("run-1", controller.signal), { name: "AbortError" });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("times out GET after 15 seconds and multipart upload after 120 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  const getPending = getRun("run-1");
  const getRejected = assert.rejects(getPending, { code: "TIMEOUT" });
  t.mock.timers.tick(15_000);
  await getRejected;
  const uploadPending = createRun(files());
  const uploadRejected = assert.rejects(uploadPending, { code: "TIMEOUT" });
  t.mock.timers.tick(120_000);
  await uploadRejected;
});
