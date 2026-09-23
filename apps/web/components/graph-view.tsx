"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisResult } from "@money-graph/contracts";
import type { Core, StylesheetJson } from "cytoscape";
import { createGraphElements, createNeighborhoodPositions } from "../lib/graph-layout";
import { ROLES_PRESENTATION } from "../lib/presentation";

export { createGraphElements } from "../lib/graph-layout";

interface GraphViewProps {
  result: AnalysisResult;
  selectedGid: string | null;
  onSelect: (gid: string) => void;
  onClearSelection?: () => void;
  selectionVersion?: number;
}
type Scope = { kind: "all" } | { kind: "cluster"; id: number } | { kind: "neighbors"; gid: string };

function graphStyles(container: HTMLElement): StylesheetJson {
  const styles = getComputedStyle(container);
  const color = (token: string) => styles.getPropertyValue(token).trim();
  const ink = color("--xi-ink");
  const paper = color("--xi-paper");
  const volt = color("--xi-volt");
  const slate = color("--xi-slate");
  return [
    { selector: "node.client", style: {
      width: "data(size)", height: "data(size)", "background-color": paper,
      "border-color": paper, "border-width": 1,
      label: "", color: paper, "font-family": "Arial, sans-serif", "font-size": 11,
      "text-wrap": "wrap", "text-valign": "bottom", "text-margin-y": 10,
      "text-background-color": ink, "text-background-opacity": 0.95, "text-background-padding": "4px",
      "overlay-opacity": 0,
    } },
    ...Object.entries(ROLES_PRESENTATION).map(([role, presentation]) => ({
      selector: `node.client[role = "${role}"]`,
      style: { shape: presentation.shape, "background-color": color(presentation.token) },
    })),
    { selector: "node.seed", style: { "border-style": "double", "border-width": 4 } },
    { selector: "node.cluster", style: {
      shape: "round-rectangle", label: "", padding: "32px",
      "background-color": color("--xi-ink-800"), "background-opacity": 0.18,
      "border-color": slate, "border-width": 1, "border-opacity": 0.45, "border-style": "dashed",
      color: color("--xi-slate-300"), "font-size": 20, "font-family": "Arial, sans-serif",
      "text-valign": "top", "text-halign": "center", "text-margin-y": -12,
      "min-zoomed-font-size": 9, "overlay-opacity": 0,
    } },
    { selector: "edge", style: {
      "curve-style": "bezier", width: 1.1, "line-color": slate,
      "target-arrow-color": slate, "target-arrow-shape": "triangle", "arrow-scale": 0.8,
      opacity: 0.34, "overlay-opacity": 0,
    } },
    { selector: "edge.cross-cluster", style: { width: 0.8, opacity: 0.12 } },
    { selector: "edge.in-scope", style: { opacity: 0.6, width: 1.4, "arrow-scale": 1.1 } },
    { selector: "node.neighbor", style: {
      "border-width": 2, label: "data(gid)", "min-zoomed-font-size": 10,
    } },
    { selector: "edge.incoming", style: {
      opacity: 0.92, width: 2.2, "line-style": "dashed", "line-color": paper, "target-arrow-color": paper,
      "arrow-scale": 1.3, "z-index": 5,
    } },
    { selector: "edge.outgoing", style: {
      opacity: 0.92, width: 2.2, "line-style": "solid", "line-color": volt, "target-arrow-color": volt,
      "arrow-scale": 1.3, "z-index": 6,
    } },
    { selector: "node.focused", style: {
      width: 34, height: 34, "border-color": volt, "border-width": 4,
      label: "data(label)", "min-zoomed-font-size": 0, "z-index": 10,
    } },
    { selector: ".scope-hidden", style: { display: "none" } },
    { selector: "node.cluster.context-cluster", style: { "background-opacity": 0, "border-opacity": 0, label: "" } },
  ];
}

/** Overview positions are restored when leaving the compact directional view. */
function applyScope(cy: Core, scope: Scope, selectedGid: string | null) {
  let overviewPositions = cy.scratch("overviewPositions") as Map<string, { x: number; y: number }> | undefined;
  if (!overviewPositions) {
    overviewPositions = new Map(cy.nodes(".client").map((node) => [node.id(), { ...node.position() }]));
    cy.scratch("overviewPositions", overviewPositions);
  }
  let visibleNodes = cy.nodes(".client");
  let visibleEdges = cy.edges();
  if (scope.kind === "cluster") {
    visibleNodes = visibleNodes.filter((node) => node.data("clusterId") === scope.id);
    visibleEdges = visibleNodes.edgesWith(visibleNodes);
  } else if (scope.kind === "neighbors") {
    const selected = cy.getElementById(scope.gid);
    visibleEdges = selected.connectedEdges();
    visibleNodes = selected.union(visibleEdges.connectedNodes()).nodes();
  }
  cy.batch(() => {
    cy.nodes(".client").positions((node) => overviewPositions!.get(node.id())!);
    cy.nodes(".client").removeStyle("font-size min-zoomed-font-size");
    cy.elements().removeClass("scope-hidden focused neighbor incoming outgoing in-scope context-cluster");
    if (scope.kind !== "all") {
      cy.elements().addClass("scope-hidden");
      visibleNodes.union(visibleEdges).union(visibleNodes.parents()).removeClass("scope-hidden");
      visibleEdges.addClass("in-scope");
    }
    if (scope.kind === "neighbors") {
      visibleNodes.parents().addClass("context-cluster");
      const incoming: string[] = [];
      const outgoing: string[] = [];
      visibleEdges.forEach((edge) => {
        if (edge.target().id() === scope.gid) incoming.push(edge.source().id());
        if (edge.source().id() === scope.gid) outgoing.push(edge.target().id());
      });
      const compact = createNeighborhoodPositions(scope.gid, incoming, outgoing);
      visibleNodes.positions((node) => compact.get(node.id())!);
    }
    if (selectedGid === null) return;
    const selected = cy.getElementById(selectedGid);
    if (selected.empty() || selected.hasClass("scope-hidden")) return;
    selected.closedNeighborhood().nodes().addClass("neighbor");
    selected.removeClass("neighbor").addClass("focused");
    selected.connectedEdges().forEach((edge) => {
      if (edge.target().id() === selectedGid) edge.addClass("incoming");
      if (edge.source().id() === selectedGid) edge.addClass("outgoing");
    });
  });
  return { nodes: visibleNodes.length, edges: visibleEdges.length };
}

function fitView(cy: Core, scope: Scope) {
  const visible = cy.nodes(".client").not(".scope-hidden");
  if (visible.empty()) return;
  cy.fit(visible, 48);
  if (cy.zoom() > 1.4) { cy.zoom(1.4); cy.center(visible); }
  if (scope.kind === "neighbors" && visible.length <= 25) {
    visible.style({ "font-size": Math.min(40, Math.max(11, 11 / cy.zoom())), "min-zoomed-font-size": 0 });
    cy.fit(visible, 40);
    if (cy.zoom() > 1.4) { cy.zoom(1.4); cy.center(visible); }
  }
}

export default function GraphView({ result, selectedGid, onSelect, onClearSelection, selectionVersion = 0 }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Core | null>(null);
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selectedGid);
  const scopeRef = useRef<Scope>({ kind: "all" });
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [counts, setCounts] = useState({ nodes: result.nodes.length, edges: result.edges.length });
  const [zoom, setZoom] = useState(100);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clusterOptions = useMemo(() => [...result.clusters].sort((a, b) => b.n_nodes - a.n_nodes || a.cluster_id - b.cluster_id), [result]);

  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    selectedRef.current = selectedGid;
    // Search/table selection always reveals the target after any cluster filter.
    if (selectedGid !== null) {
      const next: Scope = { kind: "neighbors", gid: selectedGid };
      scopeRef.current = next;
      setScope(next);
      if (graphRef.current) {
        setCounts(applyScope(graphRef.current, next, selectedGid));
        fitView(graphRef.current, next);
      }
    } else if (graphRef.current) {
      const leavingNeighborhood = scopeRef.current.kind === "neighbors";
      const next: Scope = leavingNeighborhood ? { kind: "all" } : scopeRef.current;
      scopeRef.current = next;
      setScope(next);
      setCounts(applyScope(graphRef.current, next, null));
      if (leavingNeighborhood) fitView(graphRef.current, next);
    }
  }, [selectedGid, selectionVersion]);

  useEffect(() => {
    const container = containerRef.current;
    setReady(false);
    setError(null);
    const initialScope: Scope = selectedRef.current === null ? { kind: "all" } : { kind: "neighbors", gid: selectedRef.current };
    scopeRef.current = initialScope;
    setScope(initialScope);
    setCounts({ nodes: result.nodes.length, edges: result.edges.length });
    if (!container || result.nodes.length === 0) return;
    let disposed = false;
    let cy: Core | null = null;
    let observer: ResizeObserver | null = null;
    let resizeFrame = 0;
    let zoomFrame = 0;
    let center = { x: 0, y: 0 };
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed) return;
      cy = cytoscape({
        container, elements: createGraphElements(result), style: graphStyles(container),
        layout: { name: "preset", fit: true, padding: 56 },
        minZoom: 0.01, maxZoom: 4, boxSelectionEnabled: false,
        autoungrabify: true, autounselectify: true,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      });
      graphRef.current = cy;
      const rememberViewport = () => {
        if (!cy || cy.destroyed()) return;
        const pan = cy.pan();
        center = { x: (cy.width() / 2 - pan.x) / cy.zoom(), y: (cy.height() / 2 - pan.y) / cy.zoom() };
        cancelAnimationFrame(zoomFrame);
        zoomFrame = requestAnimationFrame(() => {
          if (!cy || disposed) return;
          const scale = cy.zoom();
          setZoom(Math.round(scale * 100));
          // Label only groups wide enough to read at this scale. Adjusting text
          // during viewport changes never alters client positions or layouts.
          cy.batch(() => cy!.nodes(".cluster").forEach(cluster => {
            const show = scopeRef.current.kind !== "neighbors" && cluster.visible() && cluster.renderedWidth() >= 100;
            cluster.style({ label: show ? cluster.data("label") : "", "font-size": 12 / scale, "text-margin-y": -8 / scale });
          }));
        });
      };
      cy.on("tap", "node.client", (event) => selectRef.current(event.target.id()));
      cy.on("pan zoom", rememberViewport);
      setCounts(applyScope(cy, scopeRef.current, selectedRef.current));
      fitView(cy, scopeRef.current);
      rememberViewport();
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (!cy || disposed) return;
          const previousCenter = center;
          cy.resize();
          cy.pan({ x: cy.width() / 2 - previousCenter.x * cy.zoom(), y: cy.height() / 2 - previousCenter.y * cy.zoom() });
        });
      });
      observer.observe(container);
      setReady(true);
    }).catch((cause: unknown) => {
      if (disposed) return;
      observer?.disconnect();
      cy?.destroy();
      graphRef.current = null;
      setError(cause instanceof Error ? cause.message : "Не удалось отобразить граф.");
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(zoomFrame);
      observer?.disconnect();
      cy?.destroy();
      if (graphRef.current === cy) graphRef.current = null;
    };
    // One bounded layout per result. Filters, selection and fullscreen retain this instance.
  }, [result]);

  function changeScope(next: Scope) {
    const cy = graphRef.current;
    if (!cy) return;
    scopeRef.current = next;
    setScope(next);
    if (next.kind !== "neighbors") onClearSelection?.();
    setCounts(applyScope(cy, next, next.kind === "neighbors" ? selectedGid : null));
    fitView(cy, next);
  }
  function zoomBy(multiplier: number) {
    const cy = graphRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * multiplier, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }
  const scopeLabel = scope.kind === "all" ? "Обзор всех кластеров" : scope.kind === "cluster" ? `Кластер ${scope.id}` : "Узел и прямые связи";
  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <div className="graph-navigation" aria-label="Область графа">
          <button type="button" aria-pressed={scope.kind === "all"} disabled={!ready} onClick={() => changeScope({ kind: "all" })}>Весь граф</button>
          <button type="button" aria-pressed={scope.kind === "neighbors"} disabled={!ready || selectedGid === null} onClick={() => selectedGid !== null && changeScope({ kind: "neighbors", gid: selectedGid })}>Связи узла</button>
          <label className="graph-cluster-select"><span className="sr-only">Кластер на графе</span>
            <select aria-label="Кластер на графе" disabled={!ready} value={scope.kind === "cluster" ? String(scope.id) : ""} onChange={(event) => {
              const cluster = clusterOptions.find((option) => String(option.cluster_id) === event.target.value);
              changeScope(cluster ? { kind: "cluster", id: cluster.cluster_id } : { kind: "all" });
            }}>
              <option value="">Выбрать кластер</option>
              {clusterOptions.map((cluster) => <option key={cluster.cluster_id} value={String(cluster.cluster_id)}>Кластер {cluster.cluster_id} · {cluster.n_nodes} узлов</option>)}
            </select>
          </label>
        </div>
        <div className="graph-viewport-controls" aria-label="Масштаб графа">
          <button type="button" disabled={!ready} aria-label="Уменьшить граф" onClick={() => zoomBy(1 / 1.35)}>−</button>
          <output aria-label="Масштаб">{zoom}%</output>
          <button type="button" disabled={!ready} aria-label="Увеличить граф" onClick={() => zoomBy(1.35)}>+</button>
          <button type="button" disabled={!ready} onClick={() => graphRef.current && fitView(graphRef.current, scopeRef.current)}>Вписать</button>
        </div>
      </div>
      <div className="graph-scope" role="status"><strong>{scopeLabel}</strong><span>Показано {counts.nodes.toLocaleString("ru-RU")} из {result.nodes.length.toLocaleString("ru-RU")} узлов · {counts.edges.toLocaleString("ru-RU")} связей</span></div>
      {!ready && !error && result.nodes.length > 0 && <p className="graph-help" role="status">Подготавливаем карту…</p>}
      {error && <p role="alert">Ошибка отображения графа: {error}. Узлы доступны через поиск и таблицу.</p>}
      <div className="graph-stage">
        {result.nodes.length === 0 ? <p className="graph-help">В результате нет узлов.</p> : (
          <div ref={containerRef} className="graph-canvas" role="img" aria-label="Направленный граф переводов. Выбирайте узлы мышью, через поиск gid или таблицу приоритетов." aria-busy={!ready && !error} />
        )}
      </div>
      <p className="graph-hint">{scope.kind === "all" ? "Выберите кластер для обзора или найдите gid, чтобы открыть его прямые связи." : scope.kind === "cluster" ? "Показаны внутренние связи кластера. Выберите узел, чтобы увидеть и его связи с другими кластерами." : "Входящие слева, исходящие справа, двусторонние сверху. Показаны только прямые связи выбранного узла."} Колесо — масштаб, перетаскивание — перемещение.</p>
      <ul className="graph-legend" aria-label="Легенда ролей">
        {Object.entries(ROLES_PRESENTATION).map(([role, presentation]) => (
          <li key={role}><span className={`graph-role-symbol role-${role}`} style={{ color: `var(${presentation.token})` }} aria-hidden="true">{presentation.symbol}</span>{presentation.label}</li>
        ))}
      </ul>
      <p className="graph-direction-legend"><span className="incoming-key">┄→ Входящие</span><span className="outgoing-key">→ Исходящие</span><span>Двойной контур — seed</span></p>
      <p className="graph-help">Пунктирные области — кластеры из API. Форма — роль. Расположение узлов служит навигации и не является аналитической оценкой.</p>
    </div>
  );
}
