import assert from "node:assert/strict";
import test from "node:test";
import {
  clearRunSession, isFixtureSession, isRunId, parseStoredRunReference,
  readRunSession, runSessionStorageKey, saveRunSession, writeRunSessionUrl, type RunSessionHost,
} from "../lib/run-session";

const API = "http://localhost:3001/api";

function browser(href = "http://localhost:3000/") {
  const storage = new Map<string, string>();
  const historyCalls: { state: unknown; url: string }[] = [];
  const host: RunSessionHost = {
    location: { href },
    history: {
      state: { __NA: true, tree: ["existing-router-state"] },
      replaceState(state: unknown, _unused: string, url?: string | URL | null) {
        host.location.href = new URL(String(url), host.location.href).href;
        historyCalls.push({ state, url: host.location.href });
      },
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: key => { storage.delete(key); },
    },
  };
  return { host, storage, historyCalls };
}

function stored(runId: string) { return JSON.stringify({ version: 1, runId }); }

test("opaque run ids keep exact text and do not require UUID or numeric conversion", () => {
  for (const value of ["run/2026?part=1#done", "9223372036854775807", "run с пробелом", "a".repeat(200)]) {
    assert.equal(isRunId(value), true);
    assert.equal(parseStoredRunReference(stored(value)), value);
  }
  for (const value of ["", "  ", "a".repeat(201), "run\n1", "run\u00001", "run\u007f1", "run\u00851", "\ud800", 1, null, {}]) {
    assert.equal(isRunId(value), false);
  }
});

test("corrupt, unsupported and wrong-shaped storage never produce a run reference", () => {
  for (const value of [null, "", "{", "null", "[]", '"run-1"', "1", '{"runId":"run-1"}', '{"version":2,"runId":"run-1"}', '{"version":1,"runId":123}']) {
    assert.equal(parseStoredRunReference(value), null);
  }
  const { host, storage } = browser();
  storage.set(runSessionStorageKey(API), "{corrupt");
  assert.deepEqual(readRunSession(API, host), { runId: null, source: null, invalid: false });
});

test("an explicit URL wins over local storage without changing either while reading", () => {
  const runId = "run/1?exact=9223372036854775807&part=2";
  const { host, storage, historyCalls } = browser(`http://localhost:3000/?run=${encodeURIComponent(runId)}#graph`);
  storage.set(runSessionStorageKey(API), stored("another-tab-run"));
  assert.deepEqual(readRunSession(API, host), { runId, source: "url", invalid: false });
  assert.equal(historyCalls.length, 0);
  assert.equal(storage.get(runSessionStorageKey(API)), stored("another-tab-run"));
});

test("invalid or ambiguous URL references do not silently restore a different stored run", () => {
  for (const query of ["run=", "run=%0Ahidden", "run=one&run=two", `run=${"a".repeat(201)}`]) {
    const { host, storage } = browser(`http://localhost:3000/?${query}`);
    storage.set(runSessionStorageKey(API), stored("otherwise-valid"));
    assert.deepEqual(readRunSession(API, host), { runId: null, source: "url", invalid: true });
  }
});

test("storage fallback is isolated by the complete API base and normalizes trailing slashes", () => {
  const { host, storage } = browser();
  storage.set(runSessionStorageKey(API), stored("first-api-run"));
  storage.set(runSessionStorageKey("http://localhost:4001/api"), stored("second-api-run"));
  assert.equal(readRunSession(API + "///", host).runId, "first-api-run");
  assert.equal(readRunSession("http://localhost:4001/api", host).runId, "second-api-run");
  assert.equal(readRunSession("http://localhost:3001/other-api", host).runId, null);
});

test("saving accepted runs persists only version and id, updates URL and removes stale selection", () => {
  const { host, storage, historyCalls } = browser("http://localhost:3000/view?mode=compact&run=old&gid=9223372036854775807&tag=a&tag=b#top-title");
  const runId = "new/run?part=1&x=2";
  saveRunSession(API, runId, host);
  const url = new URL(host.location.href);
  assert.equal(url.pathname, "/view");
  assert.equal(url.searchParams.get("run"), runId);
  assert.equal(url.searchParams.has("gid"), false);
  assert.equal(url.searchParams.get("mode"), "compact");
  assert.deepEqual(url.searchParams.getAll("tag"), ["a", "b"]);
  assert.equal(url.hash, "#top-title");
  assert.deepEqual(JSON.parse(storage.get(runSessionStorageKey(API))!), { version: 1, runId });
  assert.equal(storage.size, 1);
  assert.equal(historyCalls[0].state, host.history.state);
});

test("resuming the same URL or stored run preserves exact selected gid", () => {
  for (const withQuery of [true, false]) {
    const { host, storage } = browser(`http://localhost:3000/?gid=9223372036854775807${withQuery ? "&run=same" : ""}#graph-workspace`);
    storage.set(runSessionStorageKey(API), stored("same"));
    saveRunSession(API, "same", host);
    assert.equal(new URL(host.location.href).searchParams.get("gid"), "9223372036854775807");
    assert.equal(new URL(host.location.href).searchParams.get("run"), "same");
  }
});

test("invalid accepted ids cannot overwrite the previous valid reference", () => {
  const { host, storage, historyCalls } = browser("http://localhost:3000/?run=old&gid=9223372036854775807");
  storage.set(runSessionStorageKey(API), stored("old"));
  saveRunSession(API, "bad\nrun", host);
  assert.equal(historyCalls.length, 0);
  assert.equal(readRunSession(API, host).runId, "old");
  assert.equal(storage.get(runSessionStorageKey(API)), stored("old"));
});

test("blocked storage getter does not prevent URL restore, save or clear", () => {
  const { host } = browser("http://localhost:3000/?run=old&gid=42&mode=compact#graph");
  Object.defineProperty(host, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
  assert.equal(readRunSession(API, host).runId, "old");
  assert.doesNotThrow(() => saveRunSession(API, "new", host));
  assert.equal(readRunSession(API, host).runId, "new");
  assert.doesNotThrow(() => clearRunSession(API, host));
  assert.deepEqual(readRunSession(API, host), { runId: null, source: null, invalid: false });
  assert.equal(host.location.href, "http://localhost:3000/?mode=compact#graph");
});

test("storage quota errors keep a working URL reference", () => {
  const { host } = browser();
  host.localStorage.setItem = () => { throw new DOMException("full", "QuotaExceededError"); };
  assert.doesNotThrow(() => saveRunSession(API, "accepted", host));
  assert.equal(readRunSession(API, host).runId, "accepted");
});

test("unavailable history still permits storage persistence and independent cleanup", () => {
  const { host, storage } = browser();
  host.history.replaceState = () => { throw new DOMException("blocked", "SecurityError"); };
  assert.doesNotThrow(() => saveRunSession(API, "accepted", host));
  assert.deepEqual(readRunSession(API, host), { runId: "accepted", source: "storage", invalid: false });
  clearRunSession(API, host);
  assert.equal(storage.has(runSessionStorageKey(API)), false);
});

test("clear removes only this API reference and its selection, preserving other params and hash", () => {
  const { host, storage } = browser("http://localhost:3000/?run=old&gid=42&fixture=0&mode=compact#exports-title");
  storage.set(runSessionStorageKey(API), stored("old"));
  storage.set(runSessionStorageKey("http://localhost:4001/api"), stored("other"));
  clearRunSession(API, host);
  assert.equal(host.location.href, "http://localhost:3000/?fixture=0&mode=compact#exports-title");
  assert.equal(storage.has(runSessionStorageKey(API)), false);
  assert.equal(storage.get(runSessionStorageKey("http://localhost:4001/api")), stored("other"));
});

test("fixture query is explicitly development-only; production still uses real API persistence", () => {
  assert.equal(isFixtureSession("?fixture=1&run=real", true), true);
  assert.equal(isFixtureSession("?fixture=0&run=real", true), false);
  assert.equal(isFixtureSession("?run=real", true), false);
  assert.equal(isFixtureSession("?fixture=1&run=real", false), false);
});

test("an unconfirmed URL restore cannot overwrite another tab's last confirmed run", () => {
  const { host, storage } = browser("http://localhost:3000/?run=missing&gid=42");
  storage.set(runSessionStorageKey(API), stored("other-tab"));
  writeRunSessionUrl(API, "missing", host);
  assert.equal(storage.get(runSessionStorageKey(API)), stored("other-tab"));
  clearRunSession(API, host, "missing");
  assert.equal(new URL(host.location.href).searchParams.has("run"), false);
  assert.equal(new URL(host.location.href).searchParams.has("gid"), false);
  assert.equal(storage.get(runSessionStorageKey(API)), stored("other-tab"));
  // Explicit reset of the now unavailable run must still leave the other tab intact.
  clearRunSession(API, host, "missing");
  assert.equal(storage.get(runSessionStorageKey(API)), stored("other-tab"));
});

test("scoped cleanup removes its reference without clearing newer URL or storage selections", () => {
  const { host, storage } = browser("http://localhost:3000/?run=new&gid=9223372036854775807#graph");
  storage.set(runSessionStorageKey(API), stored("new"));
  clearRunSession(API, host, "old");
  assert.equal(host.location.href, "http://localhost:3000/?run=new&gid=9223372036854775807#graph");
  assert.equal(storage.get(runSessionStorageKey(API)), stored("new"));
  clearRunSession(API, host, "new");
  assert.equal(host.location.href, "http://localhost:3000/#graph");
  assert.equal(storage.has(runSessionStorageKey(API)), false);
});
