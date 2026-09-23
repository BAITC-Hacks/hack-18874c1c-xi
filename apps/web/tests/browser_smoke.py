"""Browser acceptance of UI behavior using explicit, intercepted contract responses.

Requires an already running development web server, Python Playwright and Chrome.
No API/server is created. Test uploads are dummy bytes, not valid Parquet files.
Export fixture.json using the command in apps/web/README.md before running.
"""

import asyncio
import copy
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect


WEB_URL = os.environ.get("WEB_URL", "http://localhost:3000").rstrip("/")
ARTIFACTS = Path(__file__).resolve().parents[1] / ".test-artifacts"
FILES = ("nodes", "edges", "transactions")
EXPORTS = ("nodes_roles.csv", "clusters.csv", "top_nodes.csv")
EXPORT_BYTES = b"test_only,source\nsynthetic,intercepted_API\n"
GID_SEED = "9007199254740993"
GID_DEPTH4 = "9007199254740999"
GID_ISOLATE = "9223372036854775807"


class ApiScenario:
    def __init__(self, mode, fixture):
        self.mode = mode
        self.fixture = fixture
        self.requests = []
        self.posts = 0
        self.status_calls = {}
        self.result_calls = {}
        self.release_old = asyncio.Event()
        self.old_pending = asyncio.Event()
        self.exports = []

    async def route(self, route):
        request = route.request
        path = urlparse(request.url).path
        self.requests.append((request.method, path))
        if request.method == "OPTIONS":
            await route.fulfill(status=204, headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "*",
            })
            return

        async def reply(data, status=200):
            await route.fulfill(status=status, json=data, headers={"Access-Control-Allow-Origin": "*"})

        if path.endswith("/runs") and request.method == "POST":
            self.posts += 1
            body = request.post_data_buffer or b""
            assert all(f'name="{field}"'.encode() in body for field in FILES), "multipart contract fields missing"
            if self.mode == "unimplemented":
                await reply({"error": {"code": "PIPELINE_NOT_IMPLEMENTED", "message": "PIPELINE_NOT_IMPLEMENTED: тестовый API ещё не выполняет расчёт."}}, 501)
                return
            run_id = f"browser-run-{self.posts}"
            await reply({"run_id": run_id, "status": "running"}, 202)
            return

        if "/exports/" in path:
            filename = path.rsplit("/", 1)[-1]
            assert filename in EXPORTS
            self.exports.append(filename)
            await route.fulfill(body=EXPORT_BYTES, content_type="text/csv", headers={"Access-Control-Allow-Origin": "*"})
            return

        if path.endswith("/result"):
            run_id = path.split("/")[-2]
            self.result_calls[run_id] = self.result_calls.get(run_id, 0) + 1
            if self.mode == "replacement" and run_id == "browser-run-1":
                self.old_pending.set()
                await self.release_old.wait()
                try:
                    await reply(empty_result())
                except Exception:
                    # The first request is intentionally aborted by the UI reset.
                    pass
                return
            if self.mode == "empty":
                await reply(empty_result())
                return
            payload = copy.deepcopy(self.fixture)
            if self.mode == "invalid":
                payload["nodes"][0]["gid"] = 9007199254740993
            if self.mode == "replacement":
                payload["metadata"]["warnings"] = ["BROWSER-TEST: результат нового запуска"]
            await reply(payload)
            return

        if "/runs/" in path:
            run_id = path.rsplit("/", 1)[-1]
            self.status_calls[run_id] = self.status_calls.get(run_id, 0) + 1
            status = "completed"
            if self.mode == "success" and self.status_calls[run_id] == 1:
                status = "running"
            if self.mode == "failed":
                status = "failed"
            await reply({"run_id": run_id, "status": status, "elapsed_ms": 1234,
                         "error": {"code": "INPUT_INVALID", "message": "Синтетическая ошибка проверки Parquet"} if status == "failed" else None})
            return
        await reply({"error": {"code": "UNEXPECTED_REQUEST", "message": path}}, 404)


def empty_result():
    return {"metadata": {"schema_version": "1.0", "n_nodes": 0, "n_edges": 0,
                         "n_transactions": 0, "n_seeds": 0, "elapsed_ms": 1,
                         "warnings": ["BROWSER-TEST: пустой синтетический снимок"]},
            "nodes": [], "edges": [], "clusters": [], "top_nodes": []}


async def upload(page, invalid=False):
    for index, field in enumerate(FILES):
        await page.locator('input[type="file"]').nth(index).set_input_files({
            "name": "nodes.csv" if invalid and index == 0 else f"{field}.parquet", "mimeType": "application/octet-stream",
            "buffer": b"PAR1-browser-contract-test-PAR1",
        })
    await page.get_by_role("button", name=re.compile("^Запустить расчёт")).click()


async def ready_graph(page):
    await expect(page.locator(".graph-canvas")).to_have_attribute("aria-busy", "false")
    await expect(page.locator(".graph-summary")).to_contain_text("24 узлов")
    await expect(page.locator("table tbody tr")).to_have_count(20)


async def search(page, gid):
    await page.locator("#gid-search").fill(gid)
    await page.get_by_role("button", name="Найти узел ↗").click()
    await expect(page.get_by_test_id("selected-gid")).to_have_text(gid)


async def assert_no_horizontal_overflow(page):
    assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "page horizontally overflows viewport"


async def fixture_case(page, scenario):
    await page.goto(f"{WEB_URL}/?fixture=1")
    await expect(page.locator(".fixture-banner")).to_be_visible()
    await expect(page.locator(".graph-canvas")).to_have_count(0)
    await page.get_by_role("button", name=re.compile("^Запустить dev-fixture")).click()
    await ready_graph(page)
    assert not scenario.requests, "fixture must not call the real API"
    await expect(page.get_by_label("Легенда ролей").locator("li")).to_have_count(6)
    await page.evaluate("""() => {
      const cy = document.querySelector('.graph-canvas')._cyreg.cy;
      window.__smokeGraph = {cy, layouts: 0, positions: JSON.stringify(cy.nodes('.client').map(n => [n.id(), n.position()]))};
      cy.on('layoutstart', () => window.__smokeGraph.layouts++);
      if (cy.nodes('.client').length !== 24 || cy.edges().length !== 21) throw Error('Incomplete graph');
    }""")
    await search(page, GID_SEED)
    await expect(page.locator(".node-panel .score-grid")).to_contain_text("role_score")
    await expect(page.locator(".node-panel .score-grid")).to_contain_text("priority_score")
    await expect(page.locator(".node-panel .connections li")).to_have_count(2)
    await page.locator(".node-panel .connections").get_by_role("button", name="9007199254740994", exact=True).click()
    await expect(page.get_by_test_id("selected-gid")).to_have_text("9007199254740994")
    text = await page.locator(".node-panel").inner_text()
    assert "9007199254740993,01" in re.sub(r"\s", "", text), "large monetary string lost precision"
    await search(page, GID_DEPTH4)
    await expect(page.locator(".node-panel")).to_contain_text("Глубина 4")
    await expect(page.locator(".node-panel .connections li")).to_have_count(1)
    await search(page, GID_ISOLATE)
    await expect(page.locator(".node-panel")).to_contain_text("Наблюдаемых связей нет")
    await expect(page.locator(".node-panel")).to_contain_text("Не определено")
    assert await page.evaluate("document.querySelector('.graph-canvas')._cyreg.cy.getElementById('9223372036854775807').hasClass('focused')")
    await search(page, "9007199254741015")
    await page.locator("#gid-search").fill("123456789")
    await page.get_by_role("button", name="Найти узел ↗").click()
    await expect(page.get_by_text("Узел не найден: 123456789", exact=True)).to_be_visible()
    await expect(page.get_by_test_id("selected-gid")).to_have_count(0)
    await page.locator("table tbody tr").first.get_by_role("button").click()
    await expect(page.get_by_test_id("selected-gid")).to_have_text(GID_SEED)
    # A real canvas pointer click must select the same node panel as search/table.
    await page.get_by_role("button", name="Весь граф", exact=True).click()
    point = await page.evaluate("document.querySelector('.graph-canvas')._cyreg.cy.getElementById('9007199254740996').renderedPosition()")
    await page.locator(".graph-canvas").click(position=point)
    await expect(page.get_by_test_id("selected-gid")).to_have_text("9007199254740996")
    assert await page.evaluate("""() => {
      const old = window.__smokeGraph, cy = document.querySelector('.graph-canvas')._cyreg.cy;
      return cy === old.cy && old.layouts === 0 && old.positions === JSON.stringify(cy.nodes('.client').map(n => [n.id(), n.position()]));
    }"""), "selection/search recreated the graph or restarted layout"
    for filename in EXPORTS:
        await expect(page.get_by_role("button", name=re.compile(re.escape(filename)))).to_be_disabled()
    await assert_no_horizontal_overflow(page)
    await page.screenshot(path=str(ARTIFACTS / "fixture-desktop.png"), full_page=True)
    await page.set_viewport_size({"width": 390, "height": 844})
    await search(page, GID_ISOLATE)
    await assert_no_horizontal_overflow(page)
    await page.screenshot(path=str(ARTIFACTS / "fixture-mobile.png"), full_page=True)


async def success_case(page, scenario):
    await page.goto(WEB_URL)
    await expect(page.locator(".fixture-banner")).to_have_count(0)
    await page.get_by_role("button", name=re.compile("^Запустить расчёт")).click()
    await expect(page.locator("main [role='alert']")).to_contain_text("Выберите файлы")
    assert scenario.posts == 0
    await upload(page, invalid=True)
    await expect(page.locator("main [role='alert']")).to_contain_text("нужен непустой файл с расширением .parquet")
    assert scenario.posts == 0
    await upload(page)
    await expect(page.get_by_text("Выполняется расчёт", exact=True)).to_be_visible()
    await ready_graph(page)
    for filename in EXPORTS:
        async with page.expect_download() as download_info:
            await page.get_by_role("button", name=re.compile(re.escape(filename))).click()
        download = await download_info.value
        assert download.suggested_filename == filename
        await download.save_as(ARTIFACTS / filename)
        assert (ARTIFACTS / filename).read_bytes() == EXPORT_BYTES
    assert scenario.exports == list(EXPORTS)
    assert scenario.posts == 1
    assert scenario.result_calls == {"browser-run-1": 1}
    await page.wait_for_timeout(1300)
    assert scenario.status_calls == {"browser-run-1": 2}, "polling continued after completion"
    await page.screenshot(path=str(ARTIFACTS / "intercepted-api-success.png"), full_page=True)


async def error_case(page, scenario):
    await page.goto(WEB_URL)
    await upload(page)
    expected = {
        "unimplemented": "PIPELINE_NOT_IMPLEMENTED",
        "failed": "INPUT_INVALID",
        "invalid": "Некорректный ответ API",
    }[scenario.mode]
    await expect(page.locator("main [role='alert']")).to_contain_text(expected)
    await expect(page.locator(".graph-canvas")).to_have_count(0)
    await expect(page.locator(".fixture-banner")).to_have_count(0)
    status_before = dict(scenario.status_calls)
    await page.wait_for_timeout(1300)
    assert scenario.status_calls == status_before, "polling continued after failure"
    await page.screenshot(path=str(ARTIFACTS / f"{scenario.mode}.png"), full_page=True)


async def empty_case(page, scenario):
    await page.goto(WEB_URL)
    await upload(page)
    await expect(page.get_by_role("heading", name="Пустой результат", exact=True)).to_be_visible()
    await expect(page.locator(".graph-canvas")).to_have_count(0)
    await expect(page.get_by_role("heading", name="Скачать CSV", exact=True)).to_be_visible()
    await page.screenshot(path=str(ARTIFACTS / "empty.png"), full_page=True)


async def replacement_case(page, scenario):
    failures = []
    page.on("requestfailed", lambda request: failures.append((request.url, request.failure)))
    await page.goto(WEB_URL)
    await upload(page)
    await asyncio.wait_for(scenario.old_pending.wait(), 15)
    await expect(page.get_by_text("Получаем результат", exact=True)).to_be_visible()
    await page.get_by_role("button", name="Прекратить ожидание", exact=True).click()
    await page.get_by_role("button", name=re.compile("^Запустить расчёт")).click()
    await ready_graph(page)
    await expect(page.locator(".run-id")).to_have_text("browser-run-2")
    scenario.release_old.set()
    await page.wait_for_timeout(1300)
    await expect(page.locator(".run-id")).to_have_text("browser-run-2")
    await expect(page.locator("table tbody tr")).to_have_count(20)
    await expect(page.get_by_role("heading", name="Пустой результат", exact=True)).to_have_count(0)
    assert any("browser-run-1/result" in url for url, _ in failures), "old result request was not aborted"
    assert scenario.posts == 2
    assert scenario.status_calls == {"browser-run-1": 1, "browser-run-2": 1}


async def main():
    expect.set_options(timeout=20000)
    fixture_path = ARTIFACTS / "fixture.json"
    if not fixture_path.exists():
        raise SystemExit(f"Missing {fixture_path}. Export fixtureResult first; see apps/web/README.md.")
    fixture = json.loads(fixture_path.read_text(encoding="utf-8-sig"))
    summary = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "chrome"), headless=True)
        for mode, check in [
            ("fixture", fixture_case), ("success", success_case),
            ("unimplemented", error_case), ("failed", error_case),
            ("invalid", error_case), ("empty", empty_case),
            ("replacement", replacement_case),
        ]:
            context = await browser.new_context(viewport={"width": 1440, "height": 1000}, locale="ru-RU", accept_downloads=True)
            page = await context.new_page()
            page.set_default_timeout(20000)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            scenario = ApiScenario(mode, fixture)
            await page.route("**/api/**", scenario.route)
            try:
                await check(page, scenario)
                assert not errors, f"Uncaught browser exceptions: {errors}"
                summary.append({"case": mode, "status": "passed", "api_requests": scenario.requests})
                print(f"PASS {mode}", flush=True)
            except Exception as error:
                await page.screenshot(path=str(ARTIFACTS / f"FAILED-{mode}.png"), full_page=True)
                summary.append({"case": mode, "status": "failed", "error": str(error), "page_errors": errors, "api_requests": scenario.requests})
                raise
            finally:
                scenario.release_old.set()
                (ARTIFACTS / "browser-results.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
                await context.close()
        await browser.close()
    print("All browser cases passed with synthetic fixture/intercepted API responses. Real analytics and CSV content are not validated.")


if __name__ == "__main__":
    asyncio.run(main())
