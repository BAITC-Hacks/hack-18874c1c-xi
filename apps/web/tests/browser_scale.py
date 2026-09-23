"""Rendering benchmark on synthetic 2248-node/3119-edge contract data, not analytics."""
import asyncio
import copy
import json
import os
from time import perf_counter

from playwright.async_api import async_playwright, expect
from browser_smoke import ARTIFACTS, WEB_URL, ApiScenario, GID_ISOLATE, upload


def scale_result():
    base = json.loads((ARTIFACTS / "fixture.json").read_text(encoding="utf-8-sig"))
    roles = ["consolidator", "transit", "distributor", "terminal", "coordinator", "peripheral"]
    nodes = []
    for index in range(2248):
        node = copy.deepcopy(base["nodes"][0])
        node.update(gid=str(9007199254740993 + index), cluster_id=index // 281,
                    role=roles[index % 6], is_seed=index in (0, 2247), priority_score=1,
                    evidence="SYNTHETIC RENDERING TEST: assigned fields, no analytical meaning.")
        nodes.append(node)
    nodes[-1]["gid"] = GID_ISOLATE
    pairs = [(i, i + 1) for i in range(2246)] + [(i, i + 2) for i in range(873)]
    edges = [{"src": nodes[a]["gid"], "dst": nodes[b]["gid"], "sum_kzt": "1.01", "n_tx": 1, "depth": 1} for a, b in pairs]
    clusters = []
    for cluster_id in range(8):
        members = nodes[cluster_id * 281:(cluster_id + 1) * 281]
        clusters.append({"cluster_id": cluster_id, "n_nodes": len(members),
                         "n_seed": sum(node["is_seed"] for node in members),
                         "sum_kzt_internal": "0", "top_gids": [members[0]["gid"]],
                         "hypothesis": "SYNTHETIC RENDERING TEST, no analytical meaning."})
    return {"metadata": {"schema_version": "1.0", "n_nodes": len(nodes), "n_edges": len(edges),
                         "n_seeds": 2, "n_transactions": len(edges), "elapsed_ms": 0,
                         "warnings": ["SYNTHETIC RENDERING TEST. Metrics, roles and sums are test inputs, not analysis."]},
            "nodes": nodes, "edges": edges, "clusters": clusters,
            "top_nodes": [{"rank": index + 1, "gid": node["gid"], "role": node["role"],
                           "priority_score": 1, "why": "Synthetic test input."} for index, node in enumerate(nodes[:20])]}


async def main():
    scenario = ApiScenario("scale", scale_result())
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "chrome"), headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        starts = []
        page.on("response", lambda response: starts.append(perf_counter()) if response.url.endswith("/result") else None)
        await page.route("**/api/**", scenario.route)
        await page.goto(WEB_URL)
        await upload(page)
        await expect(page.locator(".graph-canvas")).to_have_attribute("aria-busy", "false", timeout=20000)
        await page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        render_ms = (perf_counter() - starts[-1]) * 1000
        counts = await page.locator(".graph-canvas").evaluate("el => { const cy=el._cyreg.cy; return [cy.nodes('.client').length, cy.edges().length]; }")
        assert counts == [2248, 3119], counts
        await page.locator("#gid-search").fill(GID_ISOLATE)
        started = perf_counter()
        await page.locator(".search-form button").click()
        await expect(page.locator('[data-testid="selected-gid"]')).to_have_text(GID_ISOLATE)
        assert await page.locator(".graph-canvas").evaluate("el => el._cyreg.cy.nodes('.focused').id()") == GID_ISOLATE
        search_ms = (perf_counter() - started) * 1000
        assert not errors, errors
        await page.locator(".graph-panel").screenshot(path=str(ARTIFACTS / "scale-graph.png"))
        report = {"synthetic": True, "browser": browser.version, "nodes": counts[0], "edges": counts[1],
                  "result_response_to_render_ms": round(render_ms), "isolated_gid_search_ms": round(search_ms),
                  "page_errors": errors, "note": "Includes browser automation overhead; not a pipeline/real-data benchmark."}
        (ARTIFACTS / "scale-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
