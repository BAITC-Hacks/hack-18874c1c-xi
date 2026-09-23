"use client";

import { CSV_FILES, type CsvFile } from "@money-graph/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { getExport, type InputFiles } from "../lib/api";
import { useAnalysis } from "../lib/use-analysis";
import { ROLES_PRESENTATION } from "../lib/presentation";
import GraphWorkspace from "../components/graph-workspace";

const fields = [
  { key: "nodes", label: "Узлы", hint: "nodes.parquet" },
  { key: "edges", label: "Связи", hint: "edges.parquet" },
  { key: "transactions", label: "Транзакции", hint: "transactions.parquet" },
] as const;
const phaseLabel = { idle: "Готов к загрузке", restoring: "Восстанавливаем анализ", uploading: "Отправляем файлы", running: "Выполняется расчёт", loading: "Получаем результат", completed: "Результат получен", error: "Ошибка запуска" };

function rememberNode(runId: string | null, gid: string | null) {
  const url = new URL(window.location.href);
  if (!runId || url.searchParams.get("run") !== runId) return;
  if (gid === null) url.searchParams.delete("gid");
  else url.searchParams.set("gid", gid);
  try { window.history.replaceState(window.history.state, "", url); } catch { /* Node selection still works if history is unavailable. */ }
}

export default function HomePage() {
  const { state, execute, reset } = useAnalysis();
  const [files, setFiles] = useState<Partial<InputFiles>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(true);
  const [fixture, setFixture] = useState(false);
  const [selectedGid, setSelectedGid] = useState<string | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [download, setDownload] = useState<CsvFile | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const uploadForm = useRef<HTMLFormElement | null>(null);
  const busy = ["restoring", "uploading", "running", "loading"].includes(state.phase);
  const result = state.result;
  const selectedFiles = fields.filter(({ key }) => files[key]).length;

  useEffect(() => {
    setFixture(process.env.NODE_ENV === "development" && new URLSearchParams(window.location.search).get("fixture") === "1");
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const savedGid = result && params.get("run") === state.runId ? params.get("gid") : null;
    setSelectedGid(savedGid && result?.nodes.some(node => node.gid === savedGid) ? savedGid : null);
    setDownloadError(null); setDownload(null);
    downloadController.current?.abort();
    return () => downloadController.current?.abort();
  }, [state.runId, result]);
  useEffect(() => {
    if (state.phase === "completed") setUploadOpen(false);
    if (state.phase === "error" || state.phase === "idle") setUploadOpen(true);
  }, [state.phase]);

  const selectNode = useCallback((gid: string) => {
    setSelectedGid(gid);
    setSelectionVersion(version => version + 1);
    if (!fixture) rememberNode(state.runId, gid);
  }, [fixture, state.runId]);
  const clearSelection = useCallback(() => {
    setSelectedGid(null);
    if (!fixture) rememberNode(state.runId, null);
  }, [fixture, state.runId]);
  const selectFromTable = (gid: string) => {
    selectNode(gid);
    const workspace = document.getElementById("graph-workspace");
    workspace?.scrollIntoView({ block: "start", behavior: "instant" });
    workspace?.focus({ preventScroll: true });
  };

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

  function newAnalysis() {
    downloadController.current?.abort();
    reset();
    setFiles({});
    setFileError(null);
    uploadForm.current?.reset();
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

  return <main className={`page ${result ? "has-result" : ""}`}>
    <header className="masthead">
      <a className="brand" href="/" aria-label="Money Graph — главная"><img src="/xi-mark-ink-on-volt.svg" width="28" height="28" alt="XI" /><span>Money Graph</span></a>
      <span className="header-description">Анализ переводов</span>
      {result && <nav className="page-nav" aria-label="Результаты"><a href="#graph-workspace">Граф</a><a href="#top-title">Приоритеты</a><a href="#exports-title">Экспорт</a></nav>}
    </header>
    {fixture && <aside className="fixture-banner"><strong>DEV-FIXTURE · Синтетические данные</strong><span>Файлы не читаются. Расчёт Python и экспорт CSV здесь не выполняются.</span><a href="/">Вернуться к API</a></aside>}
    {!result && <div className="page-heading"><h1>{state.restored && busy ? "Открываем анализ" : "Новый анализ"}</h1><p>{state.restored && busy ? "Получаем сохранённый запуск. Повторно загружать файлы не нужно." : "Загрузите три файла одного набора, чтобы исследовать переводы и связи между узлами."}</p></div>}

    <details className="upload-panel panel" open={uploadOpen} onToggle={event => setUploadOpen(event.currentTarget.open)}>
      <summary className="upload-summary"><span className="disclosure-arrow" aria-hidden="true">›</span><strong>Исходные файлы</strong><span className="muted">{fixture ? "Режим демонстрации" : state.restored && result && !selectedFiles ? "Файлы текущего запуска загружены" : `${selectedFiles} из 3 выбрано`}</span><span className="upload-summary-action">{uploadOpen ? "Свернуть" : "Изменить файлы"}</span></summary>
      <form ref={uploadForm} onSubmit={submit} noValidate>
        <div className="file-grid">{fields.map(({ key, label, hint }, index) => <label className={`file-field ${files[key] ? "has-file" : ""}`} key={key}>
          <span className="file-label"><span className="file-number">{index + 1}</span>{label}<span className="file-action">{files[key] ? "Заменить" : "Выбрать файл"}</span></span>
          <span className="file-name" title={files[key]?.name}>{files[key]?.name ?? hint}</span>
          <input type="file" accept=".parquet" aria-label={`${label} — ${hint}`} disabled={busy || fixture} onChange={event => { const file = event.target.files?.[0]; setFiles(previous => ({ ...previous, [key]: file })); setFileError(null); }} />
        </label>)}</div>
        {fileError && <p className="notice error" role="alert">{fileError}</p>}
        <div className="upload-footer"><p className="muted small">{state.restored && result ? "Для нового расчёта выберите другой комплект файлов." : "Parquet · узлы, связи и транзакции одного набора"}</p><button className="button-primary" type="submit" disabled={busy}>{busy ? "Выполняется…" : fixture ? "Запустить dev-fixture" : "Запустить расчёт"}</button></div>
      </form>
    </details>

    <section className={`run-status ${state.phase === "error" ? "status-error" : ""}`} aria-label="Состояние запуска">
      <div role="status" aria-live="polite"><span className="status-mark" aria-hidden="true">{state.phase === "error" ? "!" : state.phase === "completed" ? "✓" : "○"}</span><strong>{phaseLabel[state.phase]}</strong></div>
      {state.phase !== "idle" && state.phase !== "restoring" && <span className="small muted">{(state.elapsedMs / 1000).toFixed(1)} с · {fixture ? "fixture" : "по данным API"}</span>}
      {state.runId && <details className="run-reference"><summary>Номер запуска</summary><code className="run-id">{state.runId}</code></details>}
      {state.error && <div className="run-error"><p role="alert">{state.error}</p>{state.canResume && <button type="button" onClick={() => void execute(null, false, state.runId!)}>Повторить получение</button>}</div>}
      {!busy && (state.runId || state.error) && <button type="button" className="text-button" onClick={newAnalysis}>Новый анализ</button>}
      {busy && <button type="button" className="text-button" onClick={() => { downloadController.current?.abort(); reset(); }}>Прекратить ожидание</button>}
      {busy && <p className="status-note muted small">Закрытие ожидания не останавливает расчёт на сервере.</p>}
    </section>

    {result ? <>
      <div className="result-overview">
        <dl className="metrics-strip" aria-label="Сводка результата">{[["Узлы", result.metadata.n_nodes], ["Связи", result.metadata.n_edges], ["Транзакции", result.metadata.n_transactions], ["Seeds", result.metadata.n_seeds], ["Кластеры", result.clusters.length]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString("ru-RU") : value}</dd></div>)}</dl>
        {!!result.metadata.warnings.length && <details className="warnings"><summary>Ограничения результата <span className="count">{result.metadata.warnings.length}</span></summary><ul>{result.metadata.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      </div>
      {result.nodes.length ? <>
        <GraphWorkspace result={result} selectedGid={selectedGid} selectionVersion={selectionVersion} onSelect={selectNode} onClear={clearSelection} fixture={fixture} />
        <section className="priority-panel panel" aria-labelledby="top-title">
          <div className="section-heading"><div><h2 id="top-title">Приоритетные узлы <span className="count">{result.top_nodes.length}</span></h2><p className="muted small">Выберите идентификатор, чтобы открыть узел на графе.</p></div><span className="source-note">Порядок и объяснения из {fixture ? "fixture" : "API"}</span></div>
          <div className="table-scroll"><table><caption className="sr-only">Приоритеты проверки и их основания</caption><thead><tr><th scope="col">№</th><th scope="col">Узел / gid</th><th scope="col">Роль</th><th scope="col">Приоритет</th><th scope="col">Основание проверки</th></tr></thead><tbody>{result.top_nodes.map(row => <tr key={row.gid} className={row.gid === selectedGid ? "selected-row" : ""}>
            <td className="muted">{row.rank}</td><th scope="row"><button type="button" className="gid-button" aria-label={`Открыть узел ${row.gid}`} onClick={() => selectFromTable(row.gid)}>{row.gid}</button></th><td><span className="table-role"><span aria-hidden="true">{ROLES_PRESENTATION[row.role].symbol}</span>{ROLES_PRESENTATION[row.role].label}</span></td><td><span className="score">{row.priority_score.toFixed(3)}</span></td><td className="why-cell"><details className="why-details"><summary><span className="why-preview">{row.why}</span><span className="why-collapse">Свернуть объяснение</span></summary><p>{row.why}</p></details></td>
          </tr>)}</tbody></table></div>
        </section>
      </> : <section className="empty-state panel"><h2>Пустой результат</h2><p>API вернул 0 узлов. Проверьте входные данные и предупреждения расчёта.</p></section>}
      <section className="exports-panel panel" aria-labelledby="exports-title"><div><h2 id="exports-title">Скачать CSV</h2><p className="muted small">{fixture ? "Экспорт недоступен: dev-fixture не создаёт файлы Python." : "Результаты текущего расчёта."}</p></div><div className="export-buttons">{CSV_FILES.map(filename => <button key={filename} type="button" disabled={fixture || !!download} onClick={() => void saveCsv(filename)}>{download === filename ? "Скачиваем…" : filename}<span aria-hidden="true">↓</span></button>)}</div>{downloadError && <p className="notice error" role="alert">{downloadError}</p>}</section>
    </> : <section className="empty-state panel"><img src="/xi-mark-volt-on-ink.svg" width="36" height="36" alt="" /><div><h2>{busy ? "Готовим граф" : "Здесь появится граф переводов"}</h2><p>{busy ? "После завершения расчёта будут доступны граф, карточки узлов, приоритеты и CSV." : "Выберите три файла выше. После расчёта можно найти любой gid, посмотреть его связи и скачать результаты."}</p></div></section>}
    <footer><span>Money Graph</span><p>Роли и кластеры — гипотезы для проверки. Наблюдаемые переводы не отражают полный баланс клиента.</p></footer>
  </main>;
}
