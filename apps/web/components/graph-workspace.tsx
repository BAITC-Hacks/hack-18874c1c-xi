"use client";

import type { AnalysisResult } from "@money-graph/contracts";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import NodeDetails from "./node-details";

const GraphView = dynamic(() => import("./graph-view"), {
  ssr: false,
  loading: () => <div className="graph-placeholder" role="status">Загрузка графа…</div>,
});

export interface GraphWorkspaceProps {
  result: AnalysisResult;
  selectedGid: string | null;
  onSelect: (gid: string) => void;
  onClear: () => void;
  fixture?: boolean;
  selectionVersion?: number;
}

const focusableSelector = "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable='true']";

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(element =>
    element.tabIndex >= 0 && !element.matches(":disabled") &&
    !element.closest("[inert], [aria-hidden='true']") && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden",
  );
}

/** Expand the existing workspace in place so the graph and its viewport survive. */
export default function GraphWorkspace({ result, selectedGid, onSelect, onClear, fixture = false, selectionVersion = 0 }: GraphWorkspaceProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState(selectedGid ?? "");
  const [searchError, setSearchError] = useState<string | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fullscreenRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const scrollBeforeExpand = useRef({ x: 0, y: 0 });
  const previousResult = useRef(result);
  const preserveFailedSearch = useRef(false);
  const nodes = useMemo(() => new Map(result.nodes.map(node => [node.gid, node])), [result]);
  const selectedNode = selectedGid === null ? undefined : nodes.get(selectedGid);

  useEffect(() => {
    const changedResult = previousResult.current !== result;
    previousResult.current = result;
    if (changedResult) {
      setExpanded(false);
      preserveFailedSearch.current = false;
    }
    // Clearing a previous selection after a failed search must keep the entered
    // gid and its error visible; other selection changes update the search box.
    if (!changedResult && selectedGid === null && preserveFailedSearch.current) {
      preserveFailedSearch.current = false;
      return;
    }
    setQuery(changedResult ? "" : selectedGid ?? "");
    setSearchError(null);
  }, [result, selectedGid, selectionVersion]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!expanded || !workspace) return;

    const opener = openerRef.current;
    const previousScroll = scrollBeforeExpand.current;
    const previousOverflow = document.body.style.getPropertyValue("overflow");
    const previousOverflowPriority = document.body.style.getPropertyPriority("overflow");
    document.body.style.setProperty("overflow", "hidden");

    // Only siblings outside the path to this section become inert. Marking the
    // enclosing main/body inert would also disable the graph and its controls.
    const outside = new Map<HTMLElement, boolean>();
    let branch: HTMLElement = workspace;
    while (branch !== document.body && branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          outside.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }

    const focusInside = () => (searchRef.current ?? fullscreenRef.current ?? workspace).focus({ preventScroll: true });
    focusInside();

    function keepFocusInside(event: FocusEvent) {
      if (event.target instanceof Node && !workspace!.contains(event.target)) focusInside();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableElements(workspace!);
      if (items.length === 0) {
        event.preventDefault();
        workspace!.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeElement = document.activeElement;
      const isTabbable = items.some(item => item === activeElement);
      if (event.shiftKey && (activeElement === first || !isTabbable)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !isTabbable)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", keepFocusInside);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", keepFocusInside);
      for (const [element, wasInert] of outside) element.inert = wasInert;
      if (previousOverflow) document.body.style.setProperty("overflow", previousOverflow, previousOverflowPriority);
      else document.body.style.removeProperty("overflow");
      if (opener?.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
      window.scrollTo({ left: previousScroll.x, top: previousScroll.y, behavior: "instant" });
    };
  }, [expanded]);

  const selectNode = useCallback((gid: string) => {
    preserveFailedSearch.current = false;
    setQuery(gid);
    setSearchError(null);
    onSelect(gid);
  }, [onSelect]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const gid = query.trim();
    if (nodes.has(gid)) {
      selectNode(gid);
      return;
    }
    preserveFailedSearch.current = selectedGid !== null;
    onClear();
    setSearchError(gid ? `Узел не найден: ${gid}` : "Введите точный gid узла.");
  }

  function toggleExpanded() {
    if (!expanded) {
      openerRef.current = fullscreenRef.current;
      // Capture before position:fixed removes the section from document flow.
      scrollBeforeExpand.current = { x: window.scrollX, y: window.scrollY };
    }
    setExpanded(value => !value);
  }

  return (
    <section
      id="graph-workspace"
      ref={workspaceRef}
      className={`graph-workspace${expanded ? " is-expanded" : ""}`}
      tabIndex={-1}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-labelledby="workspace-title"
      aria-describedby={expanded ? "workspace-dialog-help" : undefined}
    >
      <header className="workspace-header">
        <div className="workspace-heading">
          <h2 id="workspace-title" className="workspace-title">Граф переводов</h2>
          {fixture && <span className="workspace-fixture">DEV-FIXTURE</span>}
        </div>
        <form className="workspace-search search-form" onSubmit={search} role="search" aria-label="Поиск узла графа">
          <label className="sr-only" htmlFor="gid-search">Поиск по точному gid</label>
          <input
            ref={searchRef}
            id="gid-search"
            type="search"
            placeholder="Введите gid"
            value={query}
            onChange={event => { setQuery(event.target.value); setSearchError(null); }}
            aria-invalid={searchError ? true : undefined}
            aria-describedby={searchError ? "gid-search-error" : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit">Найти</button>
        </form>
        <button
          ref={fullscreenRef}
          type="button"
          className="fullscreen-button"
          aria-label={expanded ? "Свернуть" : "На весь экран"}
          aria-expanded={expanded}
          aria-controls="graph-workspace"
          onClick={toggleExpanded}
        >{expanded ? "Свернуть" : "На весь экран"}</button>
      </header>
      <p id="workspace-dialog-help" className="sr-only">Нажмите Escape или «Свернуть», чтобы выйти из полноэкранного графа.</p>
      {searchError && <p id="gid-search-error" className="notice error" role="alert">{searchError}</p>}
      <div className="analysis-workspace">
        <div className="graph-panel panel">
          <GraphView result={result} selectedGid={selectedGid} selectionVersion={selectionVersion} onSelect={selectNode} onClearSelection={onClear} />
        </div>
        <NodeDetails result={result} node={selectedNode} onSelect={selectNode} />
      </div>
    </section>
  );
}
