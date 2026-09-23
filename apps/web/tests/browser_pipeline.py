"""Accept a real Parquet -> NestJS -> Python -> browser -> CSV run.

Set INPUT_DIR to an existing directory containing the three input Parquet files.
WEB_URL defaults to http://localhost:3000; BROWSER_CHANNEL defaults to chrome.
Requires Python Playwright and Chrome. Input inspection uses local PyArrow when
available, or the running API container's PyArrow for inputs under the repository's
bind-mounted runs/ directory. No responses are intercepted and no fixture is used.
Screenshots, downloaded real CSV and the report stay in ignored .test-artifacts/.
"""

import asyncio
import csv
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from time import perf_counter
from urllib.parse import urlparse

from playwright.async_api import async_playwright, expect


ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS = Path(__file__).resolve().parents[1] / ".test-artifacts"
WEB_URL = os.environ.get("WEB_URL", "http://localhost:3000").rstrip("/")
FILES = ("nodes", "edges", "transactions")
HEADERS = {
    "nodes_roles.csv": ["gid", "role", "role_score", "cluster_id", "priority_score", "evidence"],
    "clusters.csv": ["cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"],
    "top_nodes.csv": ["rank", "gid", "role", "priority_score", "why"],
}
ROLE_LABELS = {
    "consolidator": "Консолидатор", "transit": "Транзитный",
    "distributor": "Распределитель", "terminal": "Терминальный",
    "coordinator": "Координатор", "peripheral": "Периферийный",
}
# This only reads source files and their schema/counts; it does not calculate roles.
PARQUET_FACTS = """
import hashlib, json, sys
from pathlib import Path
import pyarrow.parquet as pq
folder = Path(sys.argv[1])
nodes = pq.read_table(folder / 'nodes.parquet', columns=['gid', 'is_seed'])
names = ('nodes', 'edges', 'transactions')
print(json.dumps({
    'gids': [str(value) for value in nodes['gid'].to_pylist()],
    'n_seeds': sum(nodes['is_seed'].to_pylist()),
    'counts': {name: pq.read_metadata(folder / (name + '.parquet')).num_rows for name in names},
    'sha256': {name: hashlib.sha256((folder / (name + '.parquet')).read_bytes()).hexdigest() for name in names},
}))
"""


def read_inputs():
    configured = os.environ.get("INPUT_DIR")
    if not configured:
        raise SystemExit("Set INPUT_DIR to existing nodes.parquet, edges.parquet and transactions.parquet inputs.")
    folder = Path(configured).resolve(strict=True)
    paths = {name: (folder / f"{name}.parquet").resolve(strict=True) for name in FILES}
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()}
    try:
        import pyarrow  # noqa: F401 -- select the available reader, without installing dependencies
    except ImportError:
        try:
            relative = folder.relative_to((ROOT / "runs").resolve())
        except ValueError as error:
            raise SystemExit("PyArrow is absent: use inputs in the Docker runs/ mount or a Python with PyArrow.") from error
        command = ["docker", "compose", "exec", "-T", "api", "python", "-c", PARQUET_FACTS,
                   "/workspace/runs/" + relative.as_posix()]
    else:
        import sys
        command = [sys.executable, "-c", PARQUET_FACTS, str(folder)]
    read = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=60)
    if read.returncode:
        raise RuntimeError("Cannot inspect original Parquet inputs: " + read.stderr.strip())
    facts = json.loads(read.stdout)
    assert facts["sha256"] == hashes, "reader inspected different source files"
    assert len(facts["gids"]) == len(set(facts["gids"])) == facts["counts"]["nodes"]
    return paths, facts


def format_money(value):
    """Expected visible formatting keeps every original digit as text."""
    assert isinstance(value, str)
    sign, integer, fraction = re.fullmatch(r"(-?)(\d+)(?:\.(\d+))?", value).groups()
    groups = re.sub(r"\B(?=(\d{3})+(?!\d))", "\u202f", integer)
    return sign + groups + ("," + fraction if fraction is not None else "") + " ₸"


def validate_result(result, facts):
    metadata = result["metadata"]
    nodes = result["nodes"]
    assert metadata["n_nodes"] == len(nodes) == facts["counts"]["nodes"]
    assert metadata["n_edges"] == len(result["edges"]) == facts["counts"]["edges"]
    assert metadata["n_transactions"] == facts["counts"]["transactions"]
    assert metadata["n_seeds"] == facts["n_seeds"]
    assert all(isinstance(node["gid"], str) for node in nodes)
    assert {node["gid"] for node in nodes} == set(facts["gids"]), "API lost or changed an input gid"
    assert len(result["top_nodes"]) >= min(20, len(nodes))
    for node in nodes:
        for key in ("in_sum_kzt", "out_sum_kzt"):
            assert isinstance(node["metrics"][key], str)
    for edge in result["edges"]:
        assert all(isinstance(edge[key], str) for key in ("src", "dst", "sum_kzt"))


def validate_csv(filename, path, result):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        assert reader.fieldnames == HEADERS[filename], (filename, reader.fieldnames)
        rows = list(reader)
    if filename == "nodes_roles.csv":
        source = {node["gid"]: node for node in result["nodes"]}
        assert len(rows) == len(source) and {row["gid"] for row in rows} == set(source)
        for row in rows:
            node = source[row["gid"]]
            for field in ("gid", "role", "evidence"):
                assert row[field] == node[field], (filename, field)
            assert int(row["cluster_id"]) == node["cluster_id"]
            for field in ("role_score", "priority_score"):
                assert Decimal(row[field]) == Decimal(str(node[field])), (filename, field)
    elif filename == "clusters.csv":
        source = {cluster["cluster_id"]: cluster for cluster in result["clusters"]}
        assert len(rows) == len(source) and {int(row["cluster_id"]) for row in rows} == set(source)
        for row in rows:
            cluster = source[int(row["cluster_id"])]
            for field in ("n_nodes", "n_seed"):
                assert int(row[field]) == cluster[field], (filename, field)
            assert row["sum_kzt_internal"] == cluster["sum_kzt_internal"]
            assert json.loads(row["top_gids"]) == cluster["top_gids"]
            assert row["hypothesis"] == cluster["hypothesis"]
    else:
        assert len(rows) == len(result["top_nodes"])
        for row, node in zip(rows, result["top_nodes"]):
            assert int(row["rank"]) == node["rank"]
            for field in ("gid", "role", "why"):
                assert row[field] == node[field], (filename, field)
            assert Decimal(row["priority_score"]) == Decimal(str(node["priority_score"]))
    return rows


async def frames(page):
    await page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


async def check_card(page, node, result):
    started = perf_counter()
    await page.locator("#gid-search").fill(node["gid"])
    await page.locator(".search-form button[type=submit]").click()
    await expect(page.get_by_test_id("selected-gid")).to_have_text(node["gid"])
    panel = page.locator(".node-panel")
    await expect(panel.locator(".role-tag")).to_contain_text(ROLE_LABELS[node["role"]])
    await expect(panel.locator(".node-tags")).to_contain_text(f'Кластер {node["cluster_id"]}')
    await expect(panel.locator(".node-tags")).to_contain_text(f'Глубина {node["depth"]}')
    scores = await page.evaluate("scores => scores.map(score => score.toFixed(3))", [node["role_score"], node["priority_score"]])
    assert await panel.locator(".score-grid strong").all_text_contents() == scores
    assert await panel.locator(".evidence").text_content() == node["evidence"]
    money = await panel.locator(".metric-list").first.locator("dd").all_text_contents()
    assert money[:2] == [format_money(node["metrics"][key]) for key in ("in_sum_kzt", "out_sum_kzt")]
    edges = [edge for edge in result["edges"] if node["gid"] in (edge["src"], edge["dst"])]
    await expect(panel.locator(".connections li")).to_have_count(len(edges))
    for index, edge in enumerate(edges):
        row = panel.locator(".connections li").nth(index)
        other = edge["dst"] if edge["src"] == node["gid"] else edge["src"]
        assert await row.locator(".gid-button").text_content() == other
        assert await row.locator(".connection-amount").text_content() == format_money(edge["sum_kzt"])
    cluster = next(item for item in result["clusters"] if item["cluster_id"] == node["cluster_id"])
    detail = panel.locator("details").filter(has=page.locator("summary", has_text=f'Кластер {cluster["cluster_id"]} ·'))
    if not await detail.evaluate("el => el.open"):
        await detail.locator(":scope > summary").click()
    assert await detail.locator("dd").nth(1).text_content() == format_money(cluster["sum_kzt_internal"])
    assert await detail.locator("p").text_content() == cluster["hypothesis"]
    assert await detail.locator(".cluster-gids button").all_text_contents() == cluster["top_gids"]
    assert await page.locator(".graph-canvas").evaluate("(el, gid) => { const n = el._cyreg.cy.getElementById(gid); return n.visible() && n.hasClass('focused'); }", node["gid"])
    await panel.evaluate("el => el.scrollTo({top: 0, behavior: 'instant'})")
    return round((perf_counter() - started) * 1000)


async def check_fullscreen(page):
    toggle = page.get_by_role("button", name="На весь экран", exact=True)
    await toggle.scroll_into_view_if_needed()
    await frames(page)
    await page.evaluate("""() => {
      const cy = document.querySelector('.graph-canvas')._cyreg.cy, e = cy.extent();
      window.__pipelineFullscreen = {cy, zoom:cy.zoom(), x:(e.x1+e.x2)/2, y:(e.y1+e.y2)/2,
        positions:JSON.stringify(cy.nodes('.client').map(n => [n.id(), n.position()])),
        selected:JSON.stringify(cy.nodes('.focused').map(n => n.id())),
        overflow:document.body.style.overflow, scrollY};
    }""")
    await toggle.click()
    workspace = page.locator("#graph-workspace")
    await expect(workspace).to_have_attribute("aria-modal", "true")
    await expect(page.locator("#gid-search")).to_be_focused()
    await frames(page)
    bounds = await workspace.bounding_box()
    assert bounds and all(abs(bounds[key] - expected) < 2 for key, expected in (("x", 0), ("y", 0), ("width", 1440), ("height", 1000)))
    assert await page.evaluate("document.body.style.overflow === 'hidden'")
    assert await page.locator(".upload-panel").evaluate("el => !!el.closest('[inert]')")
    preserved = """() => {
      const p=window.__pipelineFullscreen, cy=document.querySelector('.graph-canvas')._cyreg.cy, e=cy.extent();
      return cy===p.cy && Math.abs(cy.zoom()-p.zoom)<0.001 && Math.abs((e.x1+e.x2)/2-p.x)<2 && Math.abs((e.y1+e.y2)/2-p.y)<2
        && p.positions===JSON.stringify(cy.nodes('.client').map(n => [n.id(),n.position()]))
        && p.selected===JSON.stringify(cy.nodes('.focused').map(n => n.id()));
    }"""
    assert await page.evaluate(preserved), "fullscreen changed graph, selection, positions or camera"
    await page.keyboard.press("Shift+Tab")
    assert await workspace.evaluate("el => el.contains(document.activeElement)")
    await page.screenshot(path=str(ARTIFACTS / "production-fullscreen.png"))
    await page.keyboard.press("Escape")
    await expect(toggle).to_be_focused()
    await frames(page)
    assert await page.evaluate(preserved), "leaving fullscreen changed graph state"
    assert await page.evaluate("document.body.style.overflow === window.__pipelineFullscreen.overflow && Math.abs(scrollY-window.__pipelineFullscreen.scrollY)<2")
    assert not await page.locator(".upload-panel").evaluate("el => !!el.closest('[inert]')")


async def main():
    expect.set_options(timeout=20000)
    paths, facts = read_inputs()
    ARTIFACTS.mkdir(exist_ok=True)
    report = {"mode": "real_api_real_parquet", "web_url": WEB_URL, "input_counts": facts["counts"],
              "input_sha256": facts["sha256"], "status": "running"}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel=os.environ.get("BROWSER_CHANNEL", "chrome"), headless=True)
        page = await browser.new_page(viewport={"width": 1440, "height": 1000}, locale="ru-RU", accept_downloads=True)
        errors, console_errors, requests, results, statuses = [], [], [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("request", lambda request: requests.append((request.method, urlparse(request.url).path)))

        def response_received(response):
            path = urlparse(response.url).path
            if response.request.method == "GET" and path.endswith("/result"):
                results.append((response, perf_counter()))
            elif response.request.method == "GET" and re.search(r"/runs/[^/]+$", path):
                statuses.append(response)

        page.on("response", response_received)
        try:
            await page.goto(WEB_URL)
            await expect(page.locator(".fixture-banner")).to_have_count(0)
            for index, name in enumerate(FILES):
                await page.locator('.upload-panel input[type="file"]').nth(index).set_input_files(str(paths[name]))
            started = perf_counter()
            async with page.expect_response(lambda response: response.request.method == "POST" and urlparse(response.url).path.endswith("/runs"), timeout=125000) as created_response:
                await page.locator('.upload-panel button[type="submit"]').click()
            created = await created_response.value
            assert created.status == 202, f"POST /runs returned {created.status}"
            accepted = await created.json()
            assert accepted["status"] == "running" and isinstance(accepted["run_id"], str)
            report["run_id"] = accepted["run_id"]
            report["upload_accepted_ms"] = round((perf_counter() - started) * 1000)
            await page.wait_for_function("() => document.querySelector('.run-status [role=status] strong')?.textContent === 'Результат получен' || !!document.querySelector('.run-error')", timeout=340000)
            assert not await page.locator(".run-error").count(), await page.locator(".run-error").all_text_contents()
            assert len(results) == 1 and results[0][0].status == 200
            result = await results[0][0].json()
            validate_result(result, facts)
            await expect(page.locator(".graph-canvas")).to_have_attribute("aria-busy", "false")
            await frames(page)
            report["upload_to_graph_ms"] = round((perf_counter() - started) * 1000)
            report["response_to_graph_ms"] = round((perf_counter() - results[0][1]) * 1000)
            report["analytics_elapsed_ms"] = result["metadata"]["elapsed_ms"]
            report["under_300_seconds_observed"] = report["upload_to_graph_ms"] < 300000
            state = await statuses[-1].json()
            assert state["run_id"] == accepted["run_id"] and state["status"] == "completed" and state["error"] is None
            report["api_elapsed_ms"] = state["elapsed_ms"]
            assert await page.locator(".run-id").text_content() == accepted["run_id"]
            assert not await page.locator(".upload-panel").evaluate("el => el.open")
            graph = await page.locator(".graph-canvas").evaluate("el => { const cy=el._cyreg.cy; return {gids:cy.nodes('.client').map(n=>n.id()), edges:cy.edges().length}; }")
            assert len(graph["gids"]) == len(facts["gids"]) and set(graph["gids"]) == set(facts["gids"])
            assert graph["edges"] == facts["counts"]["edges"]
            for label in ROLE_LABELS.values():
                await expect(page.locator(".graph-legend")).to_contain_text(label)
            await expect(page.locator(".priority-panel tbody tr")).to_have_count(len(result["top_nodes"]))
            for index, node in enumerate(result["top_nodes"]):
                row = page.locator(".priority-panel tbody tr").nth(index)
                assert await row.locator("td").first.text_content() == str(node["rank"])
                assert await row.locator("th button").text_content() == node["gid"]
                await expect(row.locator(".table-role")).to_contain_text(ROLE_LABELS[node["role"]])
                assert await row.locator(".score").text_content() == await page.evaluate("score => score.toFixed(3)", node["priority_score"])
                assert await row.locator(".why-preview").text_content() == node["why"]
            await page.locator("#graph-workspace").screenshot(path=str(ARTIFACTS / "production-overview.png"))
            await page.evaluate("""() => {
              const cy=document.querySelector('.graph-canvas')._cyreg.cy;
              window.__pipelineGraph={cy, layouts:0}; cy.on('layoutstart layoutstop',()=>window.__pipelineGraph.layouts++);
            }""")
            connected = {edge[end] for edge in result["edges"] for end in ("src", "dst")}
            cases = [
                ("isolated_seed", next(node for node in result["nodes"] if node["is_seed"] and node["gid"] not in connected)),
                ("depth_four", next(node for node in result["nodes"] if node["depth"] == 4)),
                ("connected_node", next(node for node in result["nodes"] if node["gid"] in connected and 0 < node["metrics"]["in_degree"] + node["metrics"]["out_degree"] <= 6)),
            ]
            report["searches"] = []
            for label, node in cases:
                report["searches"].append({"case": label, "elapsed_ms": await check_card(page, node, result)})
            await page.locator("#graph-workspace").screenshot(path=str(ARTIFACTS / "production-focus.png"))
            await check_fullscreen(page)
            assert await page.evaluate("window.__pipelineGraph.cy === document.querySelector('.graph-canvas')._cyreg.cy && window.__pipelineGraph.layouts === 0")
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
            report["csv_rows"] = {}
            for filename in HEADERS:
                async with page.expect_download() as download_info:
                    await page.locator(".export-buttons").get_by_role("button", name=filename).click()
                download = await download_info.value
                assert download.suggested_filename == filename
                target = ARTIFACTS / ("production-" + filename)
                await download.save_as(str(target))
                assert await download.failure() is None
                report["csv_rows"][filename] = len(validate_csv(filename, target, result))
            assert sum(method == "POST" and path.endswith("/runs") for method, path in requests) == 1
            assert len(results) == 1 and sum("/exports/" in path for method, path in requests if method == "GET") == 3
            assert not errors, errors
            assert not console_errors, console_errors
            assert {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in paths.items()} == facts["sha256"]
            report.update(status="passed", graph_nodes=len(graph["gids"]), graph_edges=graph["edges"],
                          clusters=len(result["clusters"]), top_nodes=len(result["top_nodes"]), javascript_errors=errors, console_errors=console_errors,
                          exact_input_gid_set=True, csv_api_ui_consistency=True, fullscreen_state_preserved=True,
                          elapsed_total_ms=round((perf_counter() - started) * 1000))
        except Exception as error:
            report.update(status="failed", error=str(error), javascript_errors=errors, console_errors=console_errors)
            await page.screenshot(path=str(ARTIFACTS / "production-failure.png"), full_page=True)
            raise
        finally:
            (ARTIFACTS / "production-pipeline-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            await browser.close()
    print(json.dumps({key: value for key, value in report.items() if key not in ("run_id", "input_sha256")}, ensure_ascii=True))


if __name__ == "__main__":
    asyncio.run(main())
