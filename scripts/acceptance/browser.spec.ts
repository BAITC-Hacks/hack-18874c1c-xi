/** Real production UI -> NestJS -> Python -> UI/CSV; no fixture or response mocks.
 * Dataset-derived screenshots, downloads and traces belong only in ignored local reports.
 * The CLI baseline is independently created/validated by pipeline.py before this suite.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { Core } from "cytoscape";
import type { AnalysisResult, GraphNode } from "../../packages/contracts/src/index";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const webUrl = (process.env.WEB_URL ?? "http://web:3000").replace(/\/$/, "");
const apiUrl = (process.env.API_URL ?? "http://api:3001/api").replace(/\/$/, "");
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const reportDir = resolve(process.env.REPORT_DIR ?? "artifacts/acceptance");
const browserDir = resolve(reportDir, "browser");
const csvFiles = ["nodes_roles.csv", "clusters.csv", "top_nodes.csv"] as const;
const inputFields = ["nodes", "edges", "transactions"] as const;
const roleLabels = {
  consolidator: "Консолидатор", transit: "Транзитный", distributor: "Распределитель",
  terminal: "Терминальный", coordinator: "Координатор", peripheral: "Периферийный",
} as const;

type GraphContainer = HTMLElement & { _cyreg: { cy: Core } };
type InstrumentedWindow = Window & {
  __acceptanceGraph: { cy: Core; layouts: number; positions: string };
};
type RequestRecord = { method: string; path: string };
type RunTiming = { browser_submit_to_completed_ms: number; browser_submit_to_graph_ready_ms: number; api_elapsed_ms: number };

let context: BrowserContext;
let manualTraceStarted = false;
let page: Page;
let baseline: AnalysisResult;
let completedRunId: string;
const pageErrors: string[] = [];
const externalRequests: string[] = [];
const requests: RequestRecord[] = [];
const report: Record<string, unknown> = {
  status: "running",
  real_dataset: true,
  response_mocks: false,
  production_fixture_disabled: false,
  checks: [],
  timings: {},
  manual_acceptance: [
    "M3: automation verifies that facts, evidence and limitations can be retrieved; a human must explain three arbitrary nodes within one minute.",
    "Five-minute live demonstration and jury scoring remain manual; passing tests does not award points.",
    "No cluster filter exists: the actual graph retains every cluster and node; no invented hidden-filter scenario is claimed.",
  ],
};

const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const compact = (value: string) => value.replace(/\s/g, "");
const money = (decimal: string) => `${decimal.replace(".", ",")}₸`;
const runPosts = () => requests.filter(r => r.method === "POST" && r.path === "/api/runs").length;

function analyticDigest(result: AnalysisResult): string {
  return digest(JSON.stringify({ ...result, metadata: { ...result.metadata, elapsed_ms: 0 } }));
}

function same(actual: unknown, expected: unknown, message: string): void {
  // Boolean comparisons avoid putting real gids/evidence in terminal failure output.
  expect(JSON.stringify(actual) === JSON.stringify(expected), message).toBe(true);
}

function record(check: string): void {
  (report.checks as string[]).push(check);
}

async function selectFiles(invalidParquet = false): Promise<void> {
  for (const field of inputFields) {
    const input = page.locator('input[type="file"]').nth(inputFields.indexOf(field));
    if (invalidParquet && field === "nodes") {
      await input.setInputFiles({ name: "nodes.parquet", mimeType: "application/octet-stream", buffer: Buffer.from("NOT-A-PARQUET: intentional acceptance negative case") });
    } else await input.setInputFiles(resolve(dataDir, `${field}.parquet`));
  }
}

async function startAndComplete(): Promise<{ runId: string; timing: RunTiming }> {
  const createdPromise = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/runs");
  const completedPromise = page.waitForResponse(async r =>
    r.request().method() === "GET" && /\/api\/runs\/[^/]+$/.test(new URL(r.url()).pathname)
      && r.status() === 200 && (await r.json()).status === "completed", { timeout: 300_000 });
  const resultPromise = page.waitForResponse(r => /\/api\/runs\/[^/]+\/result$/.test(new URL(r.url()).pathname) && r.status() === 200, { timeout: 300_000 });
  const started = performance.now();
  await page.getByRole("button", { name: /^Запустить расчёт/ }).click();
  const created = await createdPromise;
  expect(created.status(), "Real multipart upload must be accepted").toBe(202);
  const { run_id: runId, status } = await created.json();
  expect(status).toBe("running");
  expect(typeof runId === "string" && runId.length > 0).toBe(true);
  const completed = await completedPromise;
  const completedMs = performance.now() - started;
  const state = await completed.json();
  same(state.run_id, runId, "Status belongs to this real upload");
  expect(state.error).toBeNull();
  const resultResponse = await resultPromise;
  expect(new URL(resultResponse.url()).pathname === `/api/runs/${runId}/result`).toBe(true);
  const actual: AnalysisResult = await resultResponse.json();
  same(analyticDigest(actual), analyticDigest(baseline), "API analytical result must match independent CLI output, excluding measured time");
  await writeFile(resolve(reportDir, "downloads/analysis.json"), JSON.stringify(actual));
  await expect(page.getByText("Результат получен", { exact: true })).toBeVisible({ timeout: 300_000 });
  await expect(page.locator(".graph-canvas")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
  await expect.poll(async () => await page.locator(".run-id").textContent() === runId, { message: "UI run identifier must belong to the latest upload" }).toBe(true);
  const timing = { browser_submit_to_completed_ms: completedMs, browser_submit_to_graph_ready_ms: performance.now() - started, api_elapsed_ms: state.elapsed_ms };
  expect(timing.browser_submit_to_completed_ms, "Real upload-to-completed wall time must be under five minutes").toBeLessThan(300_000);
  expect(Number.isFinite(timing.api_elapsed_ms) && timing.api_elapsed_ms >= 0 && timing.api_elapsed_ms < 300_000).toBe(true);
  return { runId, timing };
}

async function selectAndVerify(node: GraphNode): Promise<void> {
  await page.getByRole("searchbox", { name: "Поиск по точному gid" }).fill(node.gid);
  await page.getByRole("button", { name: "Найти узел ↗" }).click();
  await expect.poll(async () => (await page.getByTestId("selected-gid").textContent()) === node.gid, { message: "Search must preserve the complete int64 gid" }).toBe(true);
  const panel = page.getByLabel("Карточка узла");
  await expect(panel.locator(".role-tag")).toContainText(roleLabels[node.role]);
  await expect(panel.locator(".node-tags")).toContainText(`Кластер ${node.cluster_id}`);
  await expect(panel.locator(".node-tags")).toContainText(`Глубина ${node.depth}`);
  same(await panel.locator(".node-tags").getByText("Seed", { exact: true }).count(), node.is_seed ? 1 : 0, "Seed flag is preserved");
  same(await panel.locator(".score-grid strong").allTextContents(), [node.role_score.toFixed(3), node.priority_score.toFixed(3)], "Role score and priority are separate and API-sourced");
  same(await panel.locator(".evidence").textContent(), node.evidence, "Evidence is unchanged from Python/CSV");
  await expect(panel).toContainText("не является калиброванной вероятностью нарушения");
  const metricValues = (await panel.locator(":scope > .metric-list dd").allTextContents()).map(compact);
  same(metricValues.slice(0, 4), [money(node.metrics.in_sum_kzt), money(node.metrics.out_sum_kzt), `${node.metrics.in_degree}/${node.metrics.out_degree}`, `${node.metrics.n_tx_in}/${node.metrics.n_tx_out}`], "Amounts retain every supplied digit; in/out metrics match the result");
  same(metricValues[4], node.metrics.out_in_ratio === null ? "Неопределено" : compact(node.metrics.out_in_ratio.toLocaleString("ru-RU", { maximumFractionDigits: 6 })), "Null ratio is explicit rather than a fabricated zero");
  same(await panel.locator(".node-limitations li").allTextContents(), node.limitations, "All interpretation limits are visible");
  const incident = baseline.edges.filter(edge => edge.src === node.gid || edge.dst === node.gid);
  const actualConnections = await panel.locator(".connections li").evaluateAll(items => items.map(item => ({
    direction: item.querySelector("span")?.textContent,
    gid: item.querySelector("button")?.textContent,
    amount: item.querySelectorAll("span")[1]?.textContent?.replace(/\s/g, ""),
    details: item.querySelector("small")?.textContent,
  })));
  same(actualConnections, incident.map(edge => ({
    direction: edge.src === edge.dst ? "↻ Перевод себе" : edge.src === node.gid ? "→ Исходящий" : "← Входящий",
    gid: edge.src === node.gid ? edge.dst : edge.src,
    amount: money(edge.sum_kzt), details: `Транзакций: ${edge.n_tx} · глубина ${edge.depth}`,
  })), "Every observed incident edge has the correct direction, exact counterparty, amount and transaction count");
  if (!incident.length) await expect(panel).toContainText("Наблюдаемых связей нет. Узел сохранён на карте.");
  const cluster = baseline.clusters.find(item => item.cluster_id === node.cluster_id)!;
  const clusterDetails = panel.locator(".node-section").nth(1);
  same((await clusterDetails.locator("dd").allTextContents()).map(compact), [`${cluster.n_nodes}/${cluster.n_seed}`, money(cluster.sum_kzt_internal)], "Cluster counts and exact internal amount are API-sourced");
  same(await clusterDetails.locator(":scope > p").textContent(), cluster.hypothesis, "Cluster hypothesis is unchanged");
  same((await clusterDetails.locator(".cluster-gids button").allTextContents()).map(text => text.replace(/\s*↗$/, "")), cluster.top_gids, "Cluster representatives preserve full int64 ids");
  const graphChecks = await page.locator(".graph-canvas").evaluate((el, expected) => {
    const cy = (el as GraphContainer)._cyreg.cy;
    const selected = cy.getElementById(expected.gid);
    return {
      exactlySelected: cy.nodes(".focused").length === 1 && cy.nodes(".focused").first().id() === expected.gid,
      visible: selected.visible(),
      incidentCount: selected.connectedEdges().length,
      directionsCorrect: selected.connectedEdges().toArray().every(edge =>
        edge.visible() && edge.style("target-arrow-shape") === "triangle"
        && edge.hasClass("incoming") === (edge.target().id() === expected.gid)
        && edge.hasClass("outgoing") === (edge.source().id() === expected.gid)),
      allNeighborsVisible: selected.closedNeighborhood().toArray().every(element => element.visible() && !element.hasClass("muted")),
    };
  }, { gid: node.gid });
  same(graphChecks, { exactlySelected: true, visible: true, incidentCount: incident.length, directionsCorrect: true, allNeighborsVisible: true }, "Search focuses the actual graph node and preserves all observed connections");
}

test.describe.serial("Real must-have integration acceptance", () => {
  test.beforeAll(async ({ browser }) => {
    await mkdir(browserDir, { recursive: true });
    await mkdir(resolve(reportDir, "downloads"), { recursive: true });
    baseline = JSON.parse(await readFile(resolve(reportDir, "cli-1/analysis.json"), "utf8"));
    expect(baseline.nodes.length).toBe(2248);
    expect(baseline.edges.length).toBe(3119);
    expect(baseline.top_nodes.length).toBeGreaterThanOrEqual(20);
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ru-RU", timezoneId: "Asia/Almaty", acceptDownloads: true, serviceWorkers: "block" });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    manualTraceStarted = true;
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);
    page.on("pageerror", error => pageErrors.push(error.message));
    const allowedOrigins = new Set([new URL(webUrl).origin, new URL(apiUrl).origin]);
    context.on("request", request => {
      const url = new URL(request.url());
      if (!allowedOrigins.has(url.origin) && !["data:", "blob:", "about:"].includes(url.protocol)) externalRequests.push(`${url.protocol}//${url.host}`);
      if (url.origin === new URL(apiUrl).origin) requests.push({ method: request.method(), path: url.pathname });
    });
    report.browser_version = browser.version();
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
      report.status = "failed";
      if (page && !page.isClosed()) {
        await page.screenshot({ path: resolve(browserDir, `FAILED-${testInfo.title.replace(/[^a-zA-Z0-9-]/g, "_")}.png`), fullPage: true }).catch(() => {});
      }
    }
    report.page_error_count = pageErrors.length;
    report.unexpected_external_request_count = externalRequests.length;
    await writeFile(resolve(browserDir, "browser-report.json"), JSON.stringify(report, null, 2));
  });

  test.afterAll(async () => {
    if (context) {
      try {
        if (manualTraceStarted) {
          manualTraceStarted = false;
          await context.tracing.stop({ path: resolve(browserDir, "real-acceptance-trace.zip") });
        }
      } finally {
        await context.close();
      }
    }
  });

  test("M1: real production upload calculates all outputs and matches independent CLI", async () => {
    await page.goto(`${webUrl}/?fixture=1`);
    await expect(page.locator(".fixture-banner")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Запустить dev-fixture/ })).toHaveCount(0);
    report.production_fixture_disabled = true;
    await page.getByRole("button", { name: /^Запустить расчёт/ }).click();
    await expect(page.locator(".upload-panel").getByRole("alert")).toContainText("Выберите файлы");
    expect(runPosts(), "Missing files must not reach the API").toBe(0);
    await selectFiles();
    await page.locator('input[type="file"]').first().setInputFiles({ name: "nodes.csv", mimeType: "text/csv", buffer: Buffer.from("invalid,file") });
    await page.getByRole("button", { name: /^Запустить расчёт/ }).click();
    await expect(page.locator(".upload-panel").getByRole("alert")).toContainText("нужен непустой файл с расширением .parquet");
    expect(runPosts(), "Wrong filename must be rejected locally").toBe(0);
    await selectFiles();
    const run = await startAndComplete();
    completedRunId = run.runId;
    (report.timings as Record<string, unknown>).initial_run = run.timing;
    expect(runPosts()).toBe(1);
    record("M1: actual raw Parquet -> Python -> validated API snapshot -> production graph, under 300 seconds; CLI snapshot matches");
  });

  test("M2 M4 M5: full directed graph, six roles, all clusters and ranked explanations", async () => {
    const graphChecks = await page.locator(".graph-canvas").evaluate((el, result) => {
      const cy = (el as GraphContainer)._cyreg.cy;
      return {
        nodeCount: cy.nodes(".client").length, edgeCount: cy.edges().length, clusterCount: cy.nodes(".cluster").length,
        allNodesExact: result.nodes.every(node => {
          const found = cy.getElementById(node.gid);
          return found.length === 1 && found.data("gid") === node.gid && found.data("role") === node.role
            && found.parent().first().id() === `cluster:${node.cluster_id}` && found.visible();
        }),
        allEdgesExact: result.edges.every((edge, index) => {
          const found = cy.getElementById(`edge:${index}`);
          return found.length === 1 && found.source().id() === edge.src && found.target().id() === edge.dst
            && found.style("target-arrow-shape") === "triangle" && found.visible();
        }),
        distinctRoleShapes: new Set(cy.nodes(".client").map(node => node.style("shape"))).size,
      };
    }, baseline);
    same(graphChecks, { nodeCount: 2248, edgeCount: 3119, clusterCount: baseline.clusters.length, allNodesExact: true, allEdgesExact: true, distinctRoleShapes: 6 }, "Every original node, directed edge, role and cluster must be rendered without ID loss");
    const legend = page.getByLabel("Легенда ролей");
    await expect(legend.locator("li")).toHaveCount(6);
    for (const label of Object.values(roleLabels)) await expect(legend).toContainText(label);
    const rows = await page.locator(".priority-panel tbody tr").evaluateAll(items => items.map(row => {
      const cells = row.querySelectorAll("td, th");
      return Array.from(cells).map(cell => cell.textContent?.replace(/\s*↗$/, ""));
    }));
    same(rows, baseline.top_nodes.map(node => [String(node.rank).padStart(2, "0"), node.gid, roleLabels[node.role], node.priority_score.toFixed(3), node.why]), "Complete ranked top list, roles, rounded display scores and explanations preserve API ordering");
    await expect(page.locator("footer")).toContainText("Роли и кластеры — гипотезы для проверки");
    await page.locator(".graph-canvas").evaluate(el => {
      const cy = (el as GraphContainer)._cyreg.cy;
      const observed = { cy, layouts: 0, positions: JSON.stringify(cy.nodes(".client").map(node => [node.id(), node.position()])) };
      (window as unknown as InstrumentedWindow).__acceptanceGraph = observed;
      cy.on("layoutstart", () => observed.layouts++);
    });
    record("M2/M4/M5: 2248 exact client ids, 3119 correctly directed edges, six distinct role shapes, every cluster and full ranked top with why");
  });

  test("M3 M5: arbitrary gids and boundary cases retain exact cards and observed connections", async () => {
    const shuffled = [...baseline.nodes].sort((a, b) => digest(`must-have-v1:${a.gid}`).localeCompare(digest(`must-have-v1:${b.gid}`)));
    const topIds = new Set(baseline.top_nodes.map(node => node.gid));
    const special = [
      { name: "isolated_seed", node: shuffled.find(node => node.is_seed && node.metrics.in_degree === 0 && node.metrics.out_degree === 0) },
      { name: "inbound_only_seed", node: shuffled.find(node => node.is_seed && node.metrics.in_degree > 0 && node.metrics.out_degree === 0) },
      { name: "depth_four_boundary", node: shuffled.find(node => node.depth === 4) },
      { name: "non_top_node", node: shuffled.find(node => !topIds.has(node.gid)) },
      ...Object.keys(roleLabels).map(role => ({ name: `role_${role}`, node: shuffled.find(node => node.role === role) })),
    ];
    expect(special.every(item => item.node !== undefined), "Real dataset must contain the required edge cases and six role representatives").toBe(true);
    const postsBefore = runPosts();
    const arbitraryStarted = performance.now();
    for (const node of shuffled.slice(0, 3)) await selectAndVerify(node);
    const arbitraryMs = performance.now() - arbitraryStarted;
    expect(arbitraryMs, "Retrieval and machine verification of three arbitrary cards must fit one minute (not a human explanation test)").toBeLessThan(60_000);
    (report.timings as Record<string, unknown>).three_arbitrary_card_checks_ms = arbitraryMs;
    for (const item of special) await test.step(item.name, async () => selectAndVerify(item.node!));
    let missingGid = "9223372036854775807";
    while (baseline.nodes.some(node => node.gid === missingGid)) missingGid = (BigInt(missingGid) - 1n).toString();
    await page.getByRole("searchbox", { name: "Поиск по точному gid" }).fill(missingGid);
    await page.getByRole("button", { name: "Найти узел ↗" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Узел не найден" })).toBeVisible();
    await expect(page.getByTestId("selected-gid")).toHaveCount(0);
    await page.locator(".priority-panel tbody tr").first().getByRole("button").click();
    await expect.poll(async () => await page.getByTestId("selected-gid").textContent() === baseline.top_nodes[0].gid).toBe(true);
    const clicked = baseline.nodes.find(node => node.gid === baseline.top_nodes[0].gid)!;
    await selectAndVerify(clicked);
    // Click a different real visible canvas node, not a synthetic Cytoscape tap or an already-selected node.
    const target = await page.locator(".graph-canvas").evaluate((el, gid) => {
      const cy = (el as GraphContainer)._cyreg.cy;
      const center = cy.getElementById(gid).renderedPosition();
      return cy.nodes(".client").toArray().filter(node => {
        const p = node.renderedPosition();
        return node.id() !== gid && node.visible() && p.x > 20 && p.y > 20 && p.x < cy.width() - 20 && p.y < cy.height() - 20;
      }).map(node => ({ gid: node.id(), point: node.renderedPosition() }))
        .sort((a, b) => Math.hypot(a.point.x - center.x, a.point.y - center.y) - Math.hypot(b.point.x - center.x, b.point.y - center.y))[0];
    }, clicked.gid);
    expect(target !== undefined, "There must be another visible node for the actual canvas click").toBe(true);
    await page.locator(".graph-canvas").click({ position: target.point });
    await expect.poll(async () => await page.getByTestId("selected-gid").textContent() === target.gid, { message: "An actual pointer click must change the selected node card" }).toBe(true);
    expect(runPosts(), "Exploration must not recalculate").toBe(postsBefore);
    const stable = await page.locator(".graph-canvas").evaluate(el => {
      const cy = (el as GraphContainer)._cyreg.cy;
      const old = (window as unknown as InstrumentedWindow).__acceptanceGraph;
      return cy === old.cy && old.layouts === 0 && old.positions === JSON.stringify(cy.nodes(".client").map(node => [node.id(), node.position()]));
    });
    expect(stable, "Search/card/table/canvas selection must preserve graph instance, positions and layout count").toBe(true);
    record("M3/M5: three deterministically arbitrary nodes, isolated seed, inbound-only seed, depth=4, non-top and all six roles; exact metrics/evidence/limits/connections; table and actual canvas selection; no re-layout or recalculation");
  });

  test("M1 M5: three UI downloads are byte-identical to CLI and belong to current run", async () => {
    for (const filename of csvFiles) {
      const downloaded = page.waitForEvent("download");
      const response = page.waitForResponse(r => new URL(r.url()).pathname === `/api/runs/${completedRunId}/exports/${filename}`);
      await page.getByRole("button", { name: new RegExp(`^${filename.replaceAll(".", "\\.")}`) }).click();
      const download = await downloaded;
      expect((await response).status()).toBe(200);
      expect(download.suggestedFilename()).toBe(filename);
      const destination = resolve(reportDir, "downloads", filename);
      await download.saveAs(destination);
      same(digest(await readFile(destination)), digest(await readFile(resolve(reportDir, "cli-1", filename))), "Downloaded CSV bytes equal independent Python output");
    }
    const before = requests.filter(r => r.path === `/api/runs/${completedRunId}`).length;
    await page.waitForTimeout(1_300); // More than the documented 1-second status poll interval.
    expect(requests.filter(r => r.path === `/api/runs/${completedRunId}`).length, "Polling must stop after completion").toBe(before);
    expect(requests.filter(r => r.path === `/api/runs/${completedRunId}/result`).length, "Result fetched exactly once per run").toBe(1);
    record("M1/M5: nodes_roles.csv, clusters.csv, top_nodes.csv downloaded from the active real run and byte-identical to independent CLI; polling stopped");
  });

  test("Technical quality: desktop/mobile layout and local-only production resources", async () => {
    await expect(page.locator(".graph-canvas canvas").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Desktop page must not horizontally overflow").toBe(true);
    await page.screenshot({ path: resolve(browserDir, "real-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const isolated = baseline.nodes.find(node => node.is_seed && node.metrics.in_degree === 0 && node.metrics.out_degree === 0)!;
    await selectAndVerify(isolated);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Mobile page must not horizontally overflow").toBe(true);
    await expect(page.getByRole("button", { name: /^nodes_roles\.csv/ })).toBeEnabled();
    await page.screenshot({ path: resolve(browserDir, "real-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(pageErrors.length, "No uncaught browser errors").toBe(0);
    expect(externalRequests.length, "All resources must remain on the two local services").toBe(0);
    record("Technical: actual desktop/mobile screenshots, no page overflow, mobile exact-id search and export access, no external requests or uncaught browser errors");
  });

  test("Technical quality: invalid Parquet fails without stale results and valid retry succeeds", async () => {
    await selectFiles(true);
    const createdPromise = page.waitForResponse(r => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/runs");
    await page.getByRole("button", { name: /^Запустить расчёт/ }).click();
    const created = await createdPromise;
    expect(created.status()).toBe(202);
    const { run_id: failedId } = await created.json();
    expect(failedId !== completedRunId, "New failed run must not reuse the previous identity").toBe(true);
    await expect(page.getByText("Ошибка запуска", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".run-error").getByRole("alert")).toBeVisible();
    await expect(page.locator(".graph-canvas")).toHaveCount(0);
    await expect(page.locator(".priority-panel")).toHaveCount(0);
    await expect(page.locator(".exports-panel")).toHaveCount(0);
    await expect(page.getByTestId("selected-gid")).toHaveCount(0);
    await expect(page.locator(".fixture-banner")).toHaveCount(0);
    const failed = await context.request.get(`${apiUrl}/runs/${failedId}`);
    const state = await failed.json();
    expect(state.status).toBe("failed");
    expect(typeof state.error?.code === "string" && state.error.code.length > 0).toBe(true);
    const requestsBefore = requests.filter(r => r.path === `/api/runs/${failedId}`).length;
    await page.waitForTimeout(1_300);
    expect(requests.filter(r => r.path === `/api/runs/${failedId}`).length, "Polling must stop after failure").toBe(requestsBefore);
    for (const suffix of ["result", ...csvFiles.map(name => `exports/${name}`)]) {
      expect((await context.request.get(`${apiUrl}/runs/${failedId}/${suffix}`)).status(), "Failed run cannot serve a completed result or exports").toBe(409);
    }
    await page.screenshot({ path: resolve(browserDir, "real-invalid-parquet.png"), fullPage: true });
    await selectFiles();
    const retried = await startAndComplete();
    expect(retried.runId !== failedId && retried.runId !== completedRunId).toBe(true);
    completedRunId = retried.runId;
    (report.timings as Record<string, unknown>).retry_run = retried.timing;
    await selectAndVerify(baseline.nodes.find(node => node.depth === 4)!);
    const downloaded = page.waitForEvent("download");
    const currentExport = page.waitForResponse(r => new URL(r.url()).pathname === `/api/runs/${completedRunId}/exports/nodes_roles.csv`);
    await page.getByRole("button", { name: /^nodes_roles\.csv/ }).click();
    await (await downloaded).saveAs(resolve(reportDir, "downloads/retry_nodes_roles.csv"));
    expect((await currentExport).status()).toBe(200);
    same(digest(await readFile(resolve(reportDir, "downloads/retry_nodes_roles.csv"))), digest(await readFile(resolve(reportDir, "cli-1/nodes_roles.csv"))), "Retry export must be the real new run's exact output");
    record("Technical: real corrupt Parquet -> failed/no stale graph/top/export -> successful new run -> current-run exact CSV; failed artifacts return 409");
  });

  test("Technical quality: malformed requests are rejected and unknown results remain unavailable", async () => {
    const missing = await context.request.post(`${apiUrl}/runs`, { multipart: {
      nodes: { name: "nodes.parquet", mimeType: "application/octet-stream", buffer: await readFile(resolve(dataDir, "nodes.parquet")) },
    } });
    expect(missing.status()).toBe(400);
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const suffix of ["", "/result", "/exports/nodes_roles.csv"]) {
      expect((await context.request.get(`${apiUrl}/runs/${unknown}${suffix}`)).status()).toBe(404);
    }
    expect((await context.request.get(`${apiUrl}/runs/${completedRunId}/exports/not-allowed.csv`)).status()).toBe(404);
    expect(pageErrors.length, "No uncaught browser errors throughout the entire scenario").toBe(0);
    expect(externalRequests.length, "No external resources or data requests throughout the entire scenario").toBe(0);
    record("Technical: missing multipart field 400, unknown run/status/result/export 404, export allow-list 404; no external traffic or uncaught browser exceptions");
    report.status = "passed";
  });
});
