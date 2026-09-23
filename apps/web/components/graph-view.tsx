"use client";

import { useEffect, useRef, useState } from "react";
import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { ROLES_PRESENTATION } from "../lib/presentation";

interface GraphViewProps {
  result: AnalysisResult;
  selectedGid: string | null;
  onSelect: (gid: string) => void;
}

/** Positions only: membership is supplied by the API, never calculated here. */
export function createGraphElements(result: AnalysisResult): ElementDefinition[] {
  const elements: ElementDefinition[] = [];
  const groups = new Map<number, GraphNode[]>();
  for (const node of result.nodes) {
    const group = groups.get(node.cluster_id);
    if (group) group.push(node);
    else groups.set(node.cluster_id, [node]);
  }

  const gap = 74;
  const padding = 80;
  const targetWidth = Math.max(700, Math.sqrt(result.nodes.length + groups.size * 12) * gap * 1.4);
  let originX = 0;
  let originY = 0;
  let rowHeight = 0;

  for (const [clusterId, nodes] of groups) {
    const columns = Math.ceil(Math.sqrt(nodes.length));
    const rows = Math.ceil(nodes.length / columns);
    const width = columns * gap + padding;
    const height = rows * gap + padding;
    if (originX > 0 && originX + width > targetWidth) {
      originX = 0;
      originY += rowHeight;
      rowHeight = 0;
    }
    const parentId = `cluster:${clusterId}`;
    elements.push({ data: { id: parentId, label: `Кластер ${clusterId}` }, classes: "cluster", selectable: false, grabbable: false });
    nodes.forEach((node, index) => {
      elements.push({
        data: {
          id: node.gid,
          gid: node.gid,
          parent: parentId,
          role: node.role,
          label: `${node.gid}\n${ROLES_PRESENTATION[node.role].label} · К${clusterId}`,
        },
        position: { x: originX + (index % columns) * gap, y: originY + Math.floor(index / columns) * gap },
        classes: node.is_seed ? "client seed" : "client",
        grabbable: false,
      });
    });
    originX += width;
    rowHeight = Math.max(rowHeight, height);
  }

  result.edges.forEach((edge, index) => {
    elements.push({ data: { id: `edge:${index}`, source: edge.src, target: edge.dst } });
  });
  return elements;
}

function graphStyles(container: HTMLElement): StylesheetJson {
  const styles = getComputedStyle(container);
  const color = (token: string) => styles.getPropertyValue(token).trim();
  const ink = color("--xi-ink");
  const paper = color("--xi-paper");
  const volt = color("--xi-volt");
  const slate = color("--xi-slate");

  return [
    { selector: "node.client", style: {
      width: 25, height: 25, "background-color": paper,
      "border-color": paper, "border-width": 1.5,
      label: "", color: paper, "font-family": "Arial, sans-serif", "font-size": 12,
      "text-wrap": "wrap", "text-valign": "bottom", "text-margin-y": 9,
      "text-background-color": ink, "text-background-opacity": 0.95, "text-background-padding": "4px",
      "overlay-opacity": 0,
    } },
    ...Object.entries(ROLES_PRESENTATION).map(([role, presentation]) => ({
      selector: `node.client[role = "${role}"]`,
      style: { shape: presentation.shape, "background-color": color(presentation.token) },
    })),
    { selector: "node.seed", style: { "border-style": "double", "border-width": 5 } },
    { selector: "node.cluster", style: {
      shape: "round-rectangle", label: "data(label)", padding: "30px",
      "background-color": color("--xi-ink-800"), "background-opacity": 0.35,
      "border-color": slate, "border-width": 1, "border-style": "dashed",
      color: color("--xi-slate-300"), "font-size": 15, "font-family": "Arial, sans-serif",
      "text-valign": "top", "text-halign": "center", "text-margin-y": -8,
      "min-zoomed-font-size": 10, "overlay-opacity": 0,
    } },
    { selector: "edge", style: {
      "curve-style": "bezier", width: 1.4, "line-color": slate,
      "target-arrow-color": slate, "target-arrow-shape": "triangle", "arrow-scale": 1,
      opacity: 0.6, "overlay-opacity": 0,
    } },
    { selector: ".muted", style: { opacity: 0.15 } },
    { selector: "node.neighbor", style: { opacity: 1, "border-width": 3 } },
    { selector: "edge.incoming", style: {
      opacity: 1, width: 3, "line-style": "dashed", "line-color": paper, "target-arrow-color": paper,
      "arrow-scale": 1.5, "z-index": 5,
    } },
    { selector: "edge.outgoing", style: {
      opacity: 1, width: 3, "line-style": "solid", "line-color": volt, "target-arrow-color": volt,
      "arrow-scale": 1.5, "z-index": 6,
    } },
    { selector: "node.focused", style: {
      opacity: 1, width: 34, height: 34, "border-color": volt, "border-width": 5,
      label: "data(label)", "z-index": 10,
    } },
  ];
}

function highlightSelection(cy: Core, gid: string | null, moveCamera = true) {
  const selected = gid === null ? cy.collection() : cy.getElementById(gid);
  cy.batch(() => {
    cy.elements().removeClass("muted focused neighbor incoming outgoing");
    if (selected.empty()) return;
    cy.elements().addClass("muted");
    const context = selected.closedNeighborhood();
    context.removeClass("muted");
    context.nodes().parents().removeClass("muted");
    context.nodes().addClass("neighbor");
    selected.removeClass("neighbor").addClass("focused");
    selected.connectedEdges().forEach((edge) => {
      edge.addClass(edge.target().id() === gid ? "incoming" : "outgoing");
      if (edge.source().id() === gid) edge.addClass("outgoing");
    });
  });
  if (moveCamera && !selected.empty()) {
    cy.zoom(1.2);
    cy.center(selected);
  }
}

export default function GraphView({ result, selectedGid, onSelect }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Core | null>(null);
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selectedGid);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    selectedRef.current = selectedGid;
    if (graphRef.current) highlightSelection(graphRef.current, selectedGid);
  }, [selectedGid]);

  useEffect(() => {
    const container = containerRef.current;
    setReady(false);
    setError(null);
    if (!container || result.nodes.length === 0) return;
    let disposed = false;
    let cy: Core | null = null;
    let observer: ResizeObserver | null = null;
    let resizeFrame = 0;

    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed) return;
      cy = cytoscape({
        container,
        elements: createGraphElements(result),
        style: graphStyles(container),
        layout: { name: "preset", fit: true, padding: 45 },
        minZoom: 0.015, maxZoom: 4,
        boxSelectionEnabled: false,
        autoungrabify: true,
        autounselectify: true,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      });
      graphRef.current = cy;
      cy.on("tap", "node.client", (event) => selectRef.current(event.target.id()));
      highlightSelection(cy, selectedRef.current);
      observer = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => cy?.resize());
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
      observer?.disconnect();
      cy?.destroy();
      if (graphRef.current === cy) graphRef.current = null;
    };
    // A new result creates a new graph; typing, selection and other renders do not run layout.
  }, [result]);

  function zoomBy(multiplier: number) {
    const cy = graphRef.current;
    if (!cy) return;
    cy.zoom({ level: cy.zoom() * multiplier, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  }

  function fitSelection() {
    const cy = graphRef.current;
    if (!cy || selectedGid === null) return;
    const node = cy.getElementById(selectedGid);
    if (node.empty()) return;
    cy.fit(node.closedNeighborhood(), 50);
    if (cy.zoom() > 1.5) { cy.zoom(1.5); cy.center(node); }
  }

  return (
    <div className="graph-view">
      <div className="graph-toolbar">
        <span className="graph-summary">{result.nodes.length.toLocaleString("ru-RU")} узлов · {result.edges.length.toLocaleString("ru-RU")} связей</span>
        <div className="graph-actions" aria-label="Управление картой">
          <button type="button" disabled={!ready} onClick={() => graphRef.current?.fit(undefined, 45)}>Весь граф</button>
          <button type="button" disabled={!ready || selectedGid === null} onClick={fitSelection}>Связи узла</button>
          <button type="button" disabled={!ready} aria-label="Увеличить граф" onClick={() => zoomBy(1.35)}>+</button>
          <button type="button" disabled={!ready} aria-label="Уменьшить граф" onClick={() => zoomBy(1 / 1.35)}>−</button>
        </div>
      </div>
      {!ready && !error && result.nodes.length > 0 && <p className="graph-help" role="status">Подготавливаем карту…</p>}
      {error && <p role="alert">Ошибка отображения графа: {error}. Узлы доступны через поиск и таблицу.</p>}
      {result.nodes.length === 0 ? <p className="graph-help">В результате нет узлов.</p> : (
        <div ref={containerRef} className="graph-canvas" role="img" aria-label="Направленный граф переводов. Выбирайте узлы мышью, через поиск gid или таблицу приоритетов." aria-busy={!ready && !error} />
      )}
      <ul className="graph-legend" aria-label="Легенда ролей">
        {Object.entries(ROLES_PRESENTATION).map(([role, presentation]) => (
          <li key={role}><span className={`graph-role-symbol role-${role}`} style={{ color: `var(${presentation.token})` }} aria-hidden="true">{presentation.symbol}</span>{presentation.label}</li>
        ))}
      </ul>
      <p className="graph-direction-legend"><span className="incoming-key">┄→ Входящие</span><span className="outgoing-key">→ Исходящие</span><span>Двойной контур — seed</span></p>
      <p className="graph-help">Пунктирные области — кластеры из API. Форма обозначает роль. Расположение узлов не является аналитической оценкой. Для выбора с клавиатуры используйте поиск gid или таблицу.</p>
    </div>
  );
}
