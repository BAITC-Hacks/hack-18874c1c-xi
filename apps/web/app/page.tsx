"use client";

import { CSV_FILES, type CsvFile } from "@money-graph/contracts";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { getExport, type InputFiles } from "../lib/api";
import { useAnalysis } from "../lib/use-analysis";
import { ROLES_PRESENTATION } from "../lib/presentation";
import NodeDetails from "../components/node-details";

const GraphView = dynamic(() => import("../components/graph-view"), { ssr: false, loading: () => <div className="graph-placeholder" role="status">Загрузка карты…</div> });
const fields = [
  { key: "nodes", label: "Узлы", hint: "nodes.parquet" },
  { key: "edges", label: "Связи", hint: "edges.parquet" },
  { key: "transactions", label: "Транзакции", hint: "transactions.parquet" },
] as const;
const phaseLabel = { idle: "Готов к загрузке", uploading: "Отправляем файлы", running: "Выполняется расчёт", loading: "Получаем результат", completed: "Результат получен", error: "Ошибка запуска" };

export default function HomePage() {
  const { state, execute, reset } = useAnalysis();
  const [files, setFiles] = useState<Partial<InputFiles>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [fixture, setFixture] = useState(false);
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [download, setDownload] = useState<CsvFile | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const busy = ["uploading", "running", "loading"].includes(state.phase);
  const result = state.result;
  const nodes = useMemo(() => new Map(result?.nodes.map(node => [node.gid, node]) ?? []), [result]);
  const selectedNode = selectedGid ? nodes.get(selectedGid) : undefined;

  useEffect(() => {
    setFixture(process.env.NODE_ENV === "development" && new URLSearchParams(window.location.search).get("fixture") === "1");
  }, []);
  useEffect(() => {
    setSelectedGid(null); setQuery(""); setSearchError(null); setDownloadError(null); setDownload(null);
    downloadController.current?.abort();
    return () => downloadController.current?.abort();
  }, [state.runId, result]);

  const selectNode = useCallback((gid: string) => { setSelectedGid(gid); setQuery(gid); setSearchError(null); }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    setFileError(null);
    if (!fixture) {
      const missing = fields.filter(({ key }) => !files[key]);
      if (missing.length) { setFileError(`Выберите файлы: ${missing.map(item => item.hint).join(", ")}.`); return; }
      const invalid = fields.find(({ key }) => !files[key]!.name.toLowerCase().endsWith(".parquet") || !files[key]!.size);
      if (invalid) { setFileError(`«${invalid.label}»: нужен непустой файл с расширением .parquet. Содержимое проверит сервер.`); return; }
    }
    downloadController.current?.abort();
    void execute(fixture ? null : files as InputFiles, fixture);
  }

  function search(event: FormEvent) {
    event.preventDefault();
    const gid = query.trim();
    if (nodes.has(gid)) selectNode(gid);
    else { setSelectedGid(null); setSearchError(gid ? `Узел не найден: ${gid}` : "Введите точный gid узла."); }
  }

  async function saveCsv(filename: CsvFile) {
    if (!state.runId || fixture) return;
    downloadController.current?.abort();
    const controller = new AbortController();
    downloadController.current = controller;
    setDownload(filename); setDownloadError(null);
    try {
      const blob = await getExport(state.runId, filename, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError(`${filename}: ${error instanceof Error ? error.message : "Не удалось скачать файл."}`);
    } finally { if (!controller.signal.aborted) setDownload(null); }
  }

  return (
    <main className="page">
      <header className="masthead">
        <a className="brand" href="/" aria-label="Money Graph — главная"><img src="/xi-mark-ink-on-volt.svg" width="40" height="40" alt="XI" /><span>Money Graph<small>Исследование переводов</small></span></a>
        <div className="header-meta"><span className="local-indicator" aria-hidden="true" />Локальный анализ<span className="version">XI / 01</span></div>
      </header>
      {fixture && <aside className="fixture-banner"><strong>DEV-FIXTURE · Синтетические данные</strong><span>Файлы не читаются. Расчёт Python и экспорт CSV здесь не выполняются.</span><a href="/">Вернуться к API ↗</a></aside>}
      <section className="intro">
        <div><p className="eyebrow">Данные → связи → объяснения</p><h1>Следуйте за потоком.</h1><p className="description">Исследуйте наблюдаемую сеть переводов и приоритеты проверки.</p></div>
        <span className="intro-index" aria-hidden="true">[ XI ]</span>
      </section>
      <section className="upload-panel panel" aria-labelledby="upload-title">
        <div className="section-heading"><div><p className="eyebrow">01 / Исходные данные</p><h2 id="upload-title">Новый расчёт</h2></div><span className="muted small">3 файла · Parquet</span></div>
        <form onSubmit={submit} noValidate>
          <div className="file-grid">{fields.map(({ key, label, hint }, index) => <label className={`file-field ${files[key] ? "has-file" : ""}`} key={key}>
            <span className="file-label"><span className="file-number">0{index + 1}</span>{label}<span aria-hidden="true">↗</span></span>
            <span className="file-name" title={files[key]?.name}>{files[key]?.name ?? hint}</span>
            <input type="file" accept=".parquet" aria-label={`${label} — ${hint}`} disabled={busy || fixture} onChange={event => { const file = event.target.files?.[0]; setFiles(previous => ({ ...previous, [key]: file })); setFileError(null); }} />
          </label>)}</div>
          {fileError && <p className="notice error" role="alert">{fileError}</p>}
          <div className="upload-footer"><p className="muted small">Все узлы сохраняются, включая узлы без связей.</p><button className="button-primary" type="submit" disabled={busy}>{busy ? "Выполняется…" : fixture ? "Запустить dev-fixture" : "Запустить расчёт"}<span aria-hidden="true">→</span></button></div>
        </form>
      </section>
      <section className={`run-status ${state.phase === "error" ? "status-error" : ""}`} aria-label="Состояние запуска">
        <div role="status" aria-live="polite"><span className={`status-mark ${busy ? "busy" : ""}`} aria-hidden="true">{state.phase === "error" ? "!" : state.phase === "completed" ? "✓" : "○"}</span><strong>{phaseLabel[state.phase]}</strong>{state.runId && <code className="run-id">{state.runId}</code>}</div>
        {state.phase !== "idle" && <span className="small muted">По данным {fixture ? "fixture" : "API"}: {(state.elapsedMs / 1000).toFixed(1)} с</span>}
        {state.error && <div className="run-error"><p role="alert">{state.error}</p>{state.canResume && <button type="button" onClick={() => void execute(null, false, state.runId!)}>Повторить получение</button>}</div>}
        {busy && <button type="button" className="text-button" onClick={() => { downloadController.current?.abort(); reset(); }}>Прекратить ожидание</button>}
        {busy && <p className="status-note muted small">Закрытие ожидания не останавливает расчёт на сервере.</p>}
      </section>
      {result ? <>
        <div className="metrics-strip" aria-label="Сводка результата">{[["Узлы", result.metadata.n_nodes], ["Направленные связи", result.metadata.n_edges], ["Транзакции", result.metadata.n_transactions], ["Seeds", result.metadata.n_seeds], ["Кластеры", result.clusters.length]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{typeof value === "number" ? value.toLocaleString("ru-RU") : value}</strong></div>)}</div>
        {!!result.metadata.warnings.length && <details className="notice warnings" open><summary>Ограничения результата · {result.metadata.warnings.length}</summary><ul>{result.metadata.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        {result.nodes.length ? <>
          <section className="analysis-workspace" aria-label="Исследование графа">
            <div className="graph-panel panel">
              <div className="section-heading"><div><p className="eyebrow">02 / Карта переводов</p><h2>Наблюдаемая сеть</h2></div><span className="tag">Направленный граф</span></div>
              <form className="search-form" onSubmit={search}><label className="sr-only" htmlFor="gid-search">Поиск по точному gid</label><input id="gid-search" type="search" placeholder="Поиск по точному gid" value={query} onChange={event => { setQuery(event.target.value); setSearchError(null); }} spellCheck={false} autoComplete="off" /><button type="submit">Найти узел ↗</button></form>
              {searchError && <p className="notice error" role="alert">{searchError}</p>}
              <GraphView result={result} selectedGid={selectedGid} onSelect={selectNode} />
            </div>
            <NodeDetails result={result} node={selectedNode} onSelect={selectNode} />
          </section>
          <section className="priority-panel panel" aria-labelledby="top-title"><div className="section-heading"><div><p className="eyebrow">03 / Очерёдность проверки</p><h2 id="top-title">Приоритетные узлы <span className="count">{result.top_nodes.length}</span></h2></div><span className="muted small">Порядок и объяснения из {fixture ? "fixture" : "API"}</span></div>
            <div className="table-scroll"><table><caption className="sr-only">Приоритеты проверки и их основания</caption><thead><tr><th scope="col">№</th><th scope="col">Идентификатор / gid</th><th scope="col">Роль</th><th scope="col">Приоритет</th><th scope="col">Почему проверять</th></tr></thead><tbody>{result.top_nodes.map(row => <tr key={row.gid} className={row.gid === selectedGid ? "selected-row" : ""}><td className="muted">{String(row.rank).padStart(2, "0")}</td><th scope="row"><button type="button" className="gid-button" aria-label={`Открыть узел ${row.gid}`} onClick={() => selectNode(row.gid)}>{row.gid}<span aria-hidden="true">↗</span></button></th><td>{ROLES_PRESENTATION[row.role].label}</td><td><span className="score">{row.priority_score.toFixed(3)}</span></td><td className="why-cell">{row.why}</td></tr>)}</tbody></table></div>
          </section>
        </> : <section className="empty-state panel"><h2>Пустой результат</h2><p>API вернул 0 узлов. Проверьте входные данные и предупреждения расчёта.</p></section>}
        <section className="exports-panel panel" aria-labelledby="exports-title"><div><p className="eyebrow">04 / Результаты</p><h2 id="exports-title">Скачать CSV</h2><p className="muted small">{fixture ? "Экспорт недоступен: dev-fixture не создаёт файлы Python." : "Готовые файлы текущего расчёта из API."}</p></div><div className="export-buttons">{CSV_FILES.map(filename => <button key={filename} type="button" disabled={fixture || !!download} onClick={() => void saveCsv(filename)}>{download === filename ? "Скачиваем…" : filename}<span aria-hidden="true">↓</span></button>)}</div>{downloadError && <p className="notice error" role="alert">{downloadError}</p>}</section>
      </> : <section className="empty-state panel"><img src="/xi-mark-volt-on-ink.svg" width="64" height="64" alt="" /><h2>{busy ? "Готовим карту переводов" : "Карта начинается с данных"}</h2><p>{busy ? "После завершения расчёта здесь появятся граф, приоритеты и объяснения." : "Выберите три Parquet и запустите расчёт. Результаты появятся здесь."}</p></section>}
      <footer><span>XI · Money Graph</span><p>Роли и кластеры — гипотезы для проверки. Наблюдаемые потоки не являются полным балансом; отсутствие исходящих переводов не доказывает удержание средств.</p></footer>
    </main>
  );
}
