"""Reload/resume acceptance with explicit intercepted API responses.

Run against an already running development Next.js server. These tests use the
existing dev-fixture as response data and never invoke a real analytical run.
WEB_URL and BROWSER_CHANNEL follow browser_smoke.py; TEST_API_BASE must match the
web build's API URL when it differs from http://localhost:3001/api.
"""

import asyncio
import json
import os
from urllib.parse import parse_qs, quote, urlencode, urlparse

from playwright.async_api import async_playwright, expect
from browser_smoke import ARTIFACTS, WEB_URL, EXPORTS, EXPORT_BYTES, GID_ISOLATE, ready_graph, search, upload


RUN_A = "11111111-1111-4111-8111-111111111111"
RUN_B = "22222222-2222-4222-8222-222222222222"
API_BASE = os.environ.get("TEST_API_BASE", "http://localhost:3001/api").rstrip("/")
STORAGE_KEY = "money-graph:run:v1:" + quote(API_BASE, safe="~()*!.'")
WEB_ORIGIN = f"{urlparse(WEB_URL).scheme}://{urlparse(WEB_URL).netloc}"


def saved(run_id):
    return json.dumps({"version": 1, "runId": run_id})


def run_url(run_id, **extra):
    return WEB_URL + "/?" + urlencode({"run": run_id, **extra})


class ReloadApi:
    def __init__(self, fixture):
        self.fixture = fixture
        self.calls = []
        self.posts = 0
        self.status = {RUN_A: "completed", RUN_B: "completed"}
        self.status_calls = {RUN_A: 0, RUN_B: 0}
        self.result_calls = {RUN_A: 0, RUN_B: 0}
        self.post_plan = []
        self.post_started = asyncio.Event()
        self.post_gate = asyncio.Event()
        self.post_gate.set()
        self.network_down = False
        self.missing = False
        self.exports = []

    async def route(self, route):
        request = route.request
        path = urlparse(request.url).path
        if request.method == "OPTIONS":
            await route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS"})
            return
        self.calls.append((request.method, path))

        async def reply(data, status=200):
            await route.fulfill(status=status, json=data, headers={"Access-Control-Allow-Origin": "*"})

        if request.method == "POST" and path.endswith("/runs"):
            self.posts += 1
            body = request.post_data_buffer or b""
            assert all(f'name="{name}"'.encode() in body for name in ("nodes", "edges", "transactions"))
            self.post_started.set()
            await self.post_gate.wait()
            response = self.post_plan.pop(0) if self.post_plan else {"status": 202, "run_id": RUN_A}
            if response["status"] == 202:
                await reply({"run_id": response["run_id"], "status": "running"}, 202)
            else:
                await reply({"error": {"code": "UPLOAD_REJECTED", "message": "Тестовый API отклонил новый комплект файлов."}}, response["status"])
            return
        if "/exports/" in path:
            run_id, _, filename = path.rsplit("/", 3)[-3:]
            assert filename in EXPORTS
            self.exports.append((run_id, filename))
            await route.fulfill(body=EXPORT_BYTES, content_type="text/csv", headers={"Access-Control-Allow-Origin": "*"})
            return
        if path.endswith("/result"):
            run_id = path.split("/")[-2]
            self.result_calls[run_id] += 1
            await reply(self.fixture)
            return
        if "/runs/" in path:
            run_id = path.rsplit("/", 1)[-1]
            assert run_id in self.status, f"Unexpected restored run: {run_id}"
            self.status_calls[run_id] += 1
            if self.network_down:
                await route.abort("failed")
                return
            if self.missing:
                await reply({"error": {"code": "RUN_NOT_FOUND", "message": "Запуск не найден: сервер больше не хранит эти результаты."}}, 404)
                return
            status = self.status[run_id]
            await reply({"run_id": run_id, "status": status, "elapsed_ms": 1234,
                "error": {"code": "INPUT_INVALID", "message": "Тестовый расчёт завершился ошибкой проверки Parquet."} if status == "failed" else None})
            return
        await reply({"error": {"code": "UNEXPECTED_REQUEST", "message": path}}, 404)


async def pointer(page, run_id, gid=None):
    await page.wait_for_function("run => new URL(location.href).searchParams.get('run') === run", arg=run_id)
    query = parse_qs(urlparse(page.url).query)
    if gid is not None:
        assert query.get("gid") == [gid], query
    raw = await page.evaluate("key => localStorage.getItem(key)", STORAGE_KEY)
    assert json.loads(raw) == {"version": 1, "runId": run_id}, raw
    stored = await page.evaluate("Object.entries(localStorage).filter(([key]) => key.startsWith('money-graph:'))")
    assert all(len(value) < 1024 and 'schema_version' not in value and '.parquet' not in value for _, value in stored), "browser stored results or input files instead of a run reference"


async def completed(page, run_id):
    await ready_graph(page)
    await expect(page.locator(".run-id")).to_have_text(run_id)
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Результат получен")


async def download_three(page, api, prefix):
    for filename in EXPORTS:
        async with page.expect_download() as event:
            await page.locator(".export-buttons").get_by_role("button", name=filename).click()
        download = await event.value
        path = ARTIFACTS / f"reload-{prefix}-{filename}"
        await download.save_as(path)
        assert download.suggested_filename == filename and path.read_bytes() == EXPORT_BYTES
    assert api.exports[-3:] == [(RUN_A, filename) for filename in EXPORTS]


async def completed_reload(page, api):
    await page.goto(WEB_URL)
    await upload(page)
    await completed(page, RUN_A)
    await search(page, GID_ISOLATE)
    await pointer(page, RUN_A, GID_ISOLATE)
    await page.reload()
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    await pointer(page, RUN_A, GID_ISOLATE)
    assert await page.locator('.upload-panel input[type="file"]').evaluate_all("inputs => inputs.every(input => input.files.length === 0)")
    assert api.posts == 1 and api.result_calls[RUN_A] >= 2
    await download_three(page, api, "completed")
    count = api.status_calls[RUN_A]
    await page.wait_for_timeout(1100)
    assert api.status_calls[RUN_A] == count, "restored completed run kept polling"
    await page.locator("#graph-workspace").screenshot(path=str(ARTIFACTS / "reloaded-completed.png"), caret="initial")
    await page.set_viewport_size({"width": 390, "height": 844})
    await page.reload()
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "restored mobile page overflows horizontally"
    assert api.posts == 1
    await page.screenshot(path=str(ARTIFACTS / "reloaded-mobile.png"), full_page=True, caret="initial")


async def running_reload(page, api):
    api.status[RUN_A] = "running"
    await page.goto(run_url(RUN_A))
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Выполняется расчёт")
    await page.reload()
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Выполняется расчёт")
    api.status[RUN_A] = "completed"
    await completed(page, RUN_A)
    assert api.posts == 0 and api.status_calls[RUN_A] >= 2 and api.result_calls[RUN_A] >= 1


async def failed_reload(page, api):
    api.status[RUN_A] = "failed"
    await page.goto(run_url(RUN_A))
    await expect(page.locator(".run-error")).to_contain_text("INPUT_INVALID")
    await page.reload()
    await expect(page.locator(".run-error")).to_contain_text("INPUT_INVALID")
    await expect(page.locator(".run-id")).to_have_text(RUN_A)
    await expect(page.get_by_role("button", name="Повторить получение", exact=True)).to_have_count(0)
    assert api.posts == 0 and api.result_calls[RUN_A] == 0


async def network_retry(page, api):
    api.network_down = True
    await page.goto(WEB_URL)
    await expect(page.locator(".run-error")).to_contain_text("NETWORK_ERROR")
    await pointer(page, RUN_A)
    api.network_down = False
    await page.get_by_role("button", name="Повторить получение", exact=True).click()
    await completed(page, RUN_A)
    await pointer(page, RUN_A)
    assert api.posts == 0


async def missing_reload(page, api):
    api.missing = True
    await page.goto(WEB_URL)
    await expect(page.locator(".run-error")).to_contain_text("недоступен")
    await expect(page.get_by_role("button", name="Повторить получение", exact=True)).to_have_count(0)
    assert not parse_qs(urlparse(page.url).query).get("run")
    assert await page.evaluate("key => localStorage.getItem(key)", STORAGE_KEY) is None
    count = api.status_calls[RUN_A]
    await page.reload()
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Готов к загрузке")
    assert api.status_calls[RUN_A] == count and api.posts == 0 and api.result_calls[RUN_A] == 0


async def accepted_replacement(page, api):
    await page.goto(run_url(RUN_A, gid=GID_ISOLATE))
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    api.post_plan = [{"status": 202, "run_id": RUN_B}]
    api.post_gate.clear()
    await upload(page)
    await asyncio.wait_for(api.post_started.wait(), 10)
    await pointer(page, RUN_A, GID_ISOLATE)
    api.post_gate.set()
    await completed(page, RUN_B)
    await pointer(page, RUN_B)
    assert "gid" not in parse_qs(urlparse(page.url).query), "accepted replacement kept a gid from the old run"
    await page.reload()
    await completed(page, RUN_B)
    assert api.posts == 1


async def rejected_replacement(page, api):
    await page.goto(run_url(RUN_A, gid=GID_ISOLATE))
    await completed(page, RUN_A)
    api.post_plan = [{"status": 400}]
    await upload(page)
    await expect(page.locator(".run-error")).to_contain_text("UPLOAD_REJECTED")
    await pointer(page, RUN_A, GID_ISOLATE)
    await page.reload()
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    assert api.posts == 1


async def corrupt_storage(page, api):
    await page.goto(WEB_URL)
    await page.wait_for_timeout(250)
    assert not api.calls, "corrupt storage produced an API request"
    await upload(page)
    await completed(page, RUN_A)
    await pointer(page, RUN_A)


async def blocked_storage(page, api):
    await page.goto(WEB_URL)
    await upload(page)
    await completed(page, RUN_A)
    assert parse_qs(urlparse(page.url).query).get("run") == [RUN_A]
    await search(page, GID_ISOLATE)
    await page.reload()
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    assert api.posts == 1


async def fixture_isolation(page, api):
    await page.goto(run_url(RUN_A, fixture="1", gid=GID_ISOLATE))
    await expect(page.locator(".fixture-banner")).to_be_visible()
    await page.wait_for_timeout(250)
    assert not api.calls, "development fixture restored a real run"
    await page.locator('.upload-panel button[type="submit"]').click()
    await ready_graph(page)
    assert not api.calls
    await pointer(page, RUN_A, GID_ISOLATE)
    await page.goto(WEB_URL)
    await completed(page, RUN_A)
    assert api.posts == 0


async def url_priority(page, api):
    await page.goto(run_url(RUN_B))
    await completed(page, RUN_B)
    assert api.status_calls[RUN_A] == 0 and api.result_calls[RUN_A] == 0 and api.posts == 0


async def api_namespace(page, api):
    await page.goto(WEB_URL)
    await page.wait_for_timeout(250)
    assert not api.calls, "a different API's reference was restored"
    await upload(page)
    await completed(page, RUN_A)
    await pointer(page, RUN_A)


async def invalid_url(page, api):
    await page.goto(run_url(RUN_A) + "&run=" + RUN_B)
    await expect(page.locator(".run-error")).to_be_visible()
    assert not api.calls, "ambiguous URL silently fell back to a saved run"


async def new_analysis_reset(page, api):
    await page.goto(run_url(RUN_A, gid=GID_ISOLATE))
    await completed(page, RUN_A)
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_ISOLATE)
    await page.get_by_role("button", name="Новый анализ", exact=True).click()
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Готов к загрузке")
    await expect(page.locator(".graph-canvas")).to_have_count(0)
    query = parse_qs(urlparse(page.url).query)
    assert "run" not in query and "gid" not in query
    assert await page.evaluate("key => localStorage.getItem(key)", STORAGE_KEY) is None
    assert await page.locator('.upload-panel input[type="file"]').evaluate_all("inputs => inputs.every(input => input.files.length === 0)")
    calls = list(api.calls)
    await page.reload()
    await expect(page.locator(".run-status [role=status] strong")).to_have_text("Готов к загрузке")
    assert api.calls == calls and api.posts == 0, "reset run resumed after refresh"


async def main():
    expect.set_options(timeout=20000)
    fixture = json.loads((ARTIFACTS / "fixture.json").read_text(encoding="utf-8-sig"))
    seed = {STORAGE_KEY: saved(RUN_A)}
    cases = [
        ("completed", completed_reload, {}, False),
        ("running", running_reload, seed, False),
        ("failed", failed_reload, seed, False),
        ("network_retry", network_retry, seed, False),
        ("missing", missing_reload, seed, False),
        ("accepted_replacement", accepted_replacement, seed, False),
        ("rejected_replacement", rejected_replacement, seed, False),
        ("corrupt_storage", corrupt_storage, {STORAGE_KEY: "{broken-json"}, False),
        ("blocked_storage", blocked_storage, {}, True),
        ("fixture_isolation", fixture_isolation, seed, False),
        ("url_priority", url_priority, seed, False),
        ("api_namespace", api_namespace, {"money-graph:run:v1:https%3A%2F%2Fother.invalid%2Fapi": saved(RUN_B)}, False),
        ("invalid_url", invalid_url, seed, False),
        ("new_analysis_reset", new_analysis_reset, seed, False),
    ]
    selected = set(filter(None, os.environ.get("RELOAD_CASES", "").split(",")))
    assert selected <= {name for name, *_ in cases}, "Unknown RELOAD_CASES value"
    reports = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "chrome"), headless=True)
        for name, check, storage, blocked in cases:
            if selected and name not in selected:
                continue
            context = await browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU", accept_downloads=True,
                storage_state={"cookies": [], "origins": [{"origin": WEB_ORIGIN, "localStorage": [{"name": key, "value": value} for key, value in storage.items()]}]})
            if blocked:
                await context.add_init_script("Object.defineProperty(window, 'localStorage', {configurable: true, get() { throw new DOMException('Storage blocked by browser test', 'SecurityError'); }});")
            page = await context.new_page()
            page.set_default_timeout(20000)
            errors = []
            console_errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
            api = ReloadApi(fixture)
            await page.route("**/api/**", api.route)
            try:
                await check(page, api)
                assert not errors, errors
                assert not any("hydration" in error.lower() or "hydrated" in error.lower() for error in console_errors), console_errors
                reports.append({"case": name, "status": "passed", "posts": api.posts, "calls": api.calls, "page_errors": errors})
                print(f"PASS reload/{name}", flush=True)
            except Exception as error:
                await page.screenshot(path=str(ARTIFACTS / f"FAILED-reload-{name}.png"), full_page=True, caret="initial")
                reports.append({"case": name, "status": "failed", "error": str(error), "calls": api.calls, "page_errors": errors, "console_errors": console_errors})
                raise
            finally:
                api.post_gate.set()
                (ARTIFACTS / "reload-results.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
                await context.close()
        await browser.close()
    print("Reload scenarios passed with intercepted API responses. No real analytical process was run.")


if __name__ == "__main__":
    asyncio.run(main())
