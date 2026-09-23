"""Render a provided local analysis snapshot through intercepted API responses.

Set ANALYSIS_JSON to an existing local analysis.json. The snapshot is read in
memory and never copied into tracked files. This measures browser interaction,
not a new analytical run or the correctness of the snapshot's analytics.
"""

import asyncio
import json
import os
from pathlib import Path
from time import perf_counter

from playwright.async_api import async_playwright, expect
from browser_smoke import (
    ARTIFACTS, WEB_URL, ApiScenario, assert_neighbors_inside_canvas, assert_no_horizontal_overflow,
    check_repeated_selection, check_workspace_expansion, search, stable_graph_frame, upload,
)


def read_local_result():
    configured = os.environ.get("ANALYSIS_JSON")
    if not configured:
        raise SystemExit("Set ANALYSIS_JSON to an existing local analysis.json; this test does not generate datasets.")
    path = Path(configured).resolve(strict=True)
    result = json.loads(path.read_text(encoding="utf-8-sig"))
    assert result["metadata"]["n_nodes"] == len(result["nodes"])
    assert result["metadata"]["n_edges"] == len(result["edges"])
    return result


async def main():
    expect.set_options(timeout=20000)
    result = read_local_result()
    scenario = ApiScenario("scale", result)
    connected = {edge[end] for edge in result["edges"] for end in ("src", "dst")}
    isolate = next(node for node in result["nodes"] if node["is_seed"] and node["gid"] not in connected)
    depth_four = next(node for node in result["nodes"] if node["depth"] == 4)
    representative = next(node for node in result["nodes"] if node["gid"] in connected
                          and 0 < node["metrics"]["in_degree"] + node["metrics"]["out_degree"] <= 6)
    expected_counts = [len(result["nodes"]), len(result["edges"])]

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "chrome"), headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, locale="ru-RU")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        console_messages = []
        page.on("console", lambda message: console_messages.append({"type": message.type, "text": message.text})
                if message.type in ("warning", "error") else None)
        starts = []
        page.on("response", lambda response: starts.append(perf_counter()) if response.url.endswith("/result") else None)
        await page.route("**/api/**", scenario.route)
        try:
            await page.goto(WEB_URL)
            await upload(page)
            await expect(page.locator(".graph-canvas")).to_have_attribute("aria-busy", "false")
            await stable_graph_frame(page)
            render_ms = (perf_counter() - starts[-1]) * 1000
            counts = await page.locator(".graph-canvas").evaluate("el => { const cy=el._cyreg.cy; return [cy.nodes('.client').length, cy.edges().length]; }")
            assert counts == expected_counts, counts
            await expect(page.locator("table tbody tr")).to_have_count(len(result["top_nodes"]))
            await page.evaluate("""() => {
              const cy = document.querySelector('.graph-canvas')._cyreg.cy;
              window.__scaleGraph = {cy, layouts: 0, positions: JSON.stringify(cy.nodes('.client').map(node => [node.id(), node.position()]))};
              cy.on('layoutstart layoutstop', () => window.__scaleGraph.layouts++);
            }""")
            searches = []
            for label, node in [("isolated_seed", isolate), ("depth_four", depth_four), ("connected_node", representative)]:
                started = perf_counter()
                await search(page, node["gid"])
                assert await page.locator(".graph-canvas").evaluate("(el, gid) => el._cyreg.cy.getElementById(gid).visible() && el._cyreg.cy.getElementById(gid).hasClass('focused')", node["gid"])
                if label == "connected_node":
                    await assert_neighbors_inside_canvas(page)
                searches.append({"case": label, "elapsed_ms": round((perf_counter() - started) * 1000)})
            await page.get_by_role("button", name="Весь граф", exact=True).click()
            assert await page.evaluate("""() => {
              const previous = window.__scaleGraph, cy = document.querySelector('.graph-canvas')._cyreg.cy;
              return previous.positions === JSON.stringify(cy.nodes('.client').map(node => [node.id(), node.position()]));
            }"""), "reset did not restore overview positions"
            await page.locator("#graph-workspace").screenshot(path=str(ARTIFACTS / "scale-overview.png"))

            # Filtering must keep every node searchable, including an isolated seed.
            other_cluster = next(cluster for cluster in result["clusters"] if cluster["cluster_id"] != isolate["cluster_id"])
            await page.get_by_label("Кластер на графе", exact=True).select_option(str(other_cluster["cluster_id"]))
            assert await page.locator(".graph-canvas").evaluate("el => el._cyreg.cy.nodes('.client:visible').length") == other_cluster["n_nodes"]
            assert not await page.locator(".graph-canvas").evaluate("(el, gid) => el._cyreg.cy.getElementById(gid).visible()", isolate["gid"])
            await search(page, isolate["gid"])
            assert await page.locator(".graph-canvas").evaluate("(el, gid) => el._cyreg.cy.getElementById(gid).visible()", isolate["gid"])
            await search(page, representative["gid"])
            await check_repeated_selection(page, result["top_nodes"][0]["gid"])
            await search(page, representative["gid"])
            await assert_neighbors_inside_canvas(page)
            await check_workspace_expansion(page, representative["gid"], "scale-desktop")
            await assert_no_horizontal_overflow(page)
            await page.locator("#graph-workspace").screenshot(path=str(ARTIFACTS / "scale-graph.png"))
            await page.screenshot(path=str(ARTIFACTS / "scale-result-desktop.png"), full_page=True)
            await page.set_viewport_size({"width": 390, "height": 844})
            await search(page, isolate["gid"])
            await check_workspace_expansion(page, isolate["gid"], "scale-mobile")
            await assert_no_horizontal_overflow(page)
            assert await page.evaluate("""() => {
              const previous = window.__scaleGraph, cy = document.querySelector('.graph-canvas')._cyreg.cy;
              return cy === previous.cy;
            }"""), "search/filter/fullscreen recreated the graph"
            assert not errors, errors
            report = {"source": "provided_local_analysis", "intercepted_api": True, "browser": browser.version,
                      "nodes": counts[0], "edges": counts[1], "result_response_to_render_ms": round(render_ms),
                      "searches": searches, "fullscreen_desktop_mobile": "passed", "page_errors": errors,
                      "console_messages": console_messages,
                      "note": "Provided local snapshot, loaded through browser route interception. Includes automation overhead; no pipeline or analytics validation."}
            (ARTIFACTS / "scale-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(report))
        except Exception:
            await page.screenshot(path=str(ARTIFACTS / "FAILED-scale.png"), full_page=True, caret="initial")
            raise
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
