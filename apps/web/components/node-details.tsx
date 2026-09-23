import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import { useEffect, useMemo, useRef } from "react";
import { formatKzt, ROLES_PRESENTATION } from "../lib/presentation";

export default function NodeDetails({ result, node, onSelect }: { result: AnalysisResult; node?: GraphNode; onSelect: (gid: string) => void }) {
  const panelRef = useRef<HTMLElement>(null);
  const connectionsRef = useRef<HTMLUListElement>(null);
  const edges = useMemo(() => node ? result.edges.filter(edge => edge.src === node.gid || edge.dst === node.gid) : [], [result, node]);
  useEffect(() => {
    panelRef.current?.scrollTo({ top: 0, behavior: "instant" });
    connectionsRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [result, node?.gid]);
  if (!node) return <aside ref={panelRef} className="node-panel panel node-empty" aria-label="Карточка узла"><h2>Исследуйте связи</h2><p>Найдите точный gid или выберите узел на графе. Здесь появятся его переводы и объяснение роли.</p><ol className="node-empty-steps"><li>Выберите кластер, чтобы приблизить группу.</li><li>Нажмите на узел, чтобы рассмотреть его связи.</li><li>Вернитесь к обзору кнопкой «Весь граф».</li></ol>{!!result.top_nodes.length && <div className="node-section"><h3>Начать с приоритетных узлов</h3><div className="cluster-gids">{result.top_nodes.slice(0, 3).map(row => <button type="button" className="gid-button" key={row.gid} onClick={() => onSelect(row.gid)}>{row.gid}</button>)}</div><p className="muted small">Порядок из результата расчёта.</p></div>}</aside>;
  const cluster = result.clusters.find(item => item.cluster_id === node.cluster_id);
  const metrics = node.metrics;
  return <aside ref={panelRef} className="node-panel panel" aria-label="Карточка узла">
    <p className="eyebrow">Узел</p><h2 className="node-gid" data-testid="selected-gid">{node.gid}</h2>
    <div className="node-tags"><span className="tag role-tag">{ROLES_PRESENTATION[node.role].symbol} {ROLES_PRESENTATION[node.role].label}</span><span className="tag">Кластер {node.cluster_id}</span><span className="tag">Глубина {node.depth}</span>{node.is_seed && <span className="tag">Seed</span>}</div>
    <div className="score-grid"><div><span>Оценка роли</span><strong>{node.role_score.toFixed(3)}</strong></div><div><span>Приоритет проверки</span><strong>{node.priority_score.toFixed(3)}</strong></div></div>
    <p className="muted small">Оценка роли не является калиброванной вероятностью нарушения.</p>
    <dl className="metric-list" aria-label="Наблюдаемые метрики">
      <div><dt>Входящая сумма</dt><dd>{formatKzt(metrics.in_sum_kzt)}</dd></div><div><dt>Исходящая сумма</dt><dd>{formatKzt(metrics.out_sum_kzt)}</dd></div>
      <div><dt>Контрагенты · вход / выход</dt><dd>{metrics.in_degree} / {metrics.out_degree}</dd></div><div><dt>Транзакции · вход / выход</dt><dd>{metrics.n_tx_in} / {metrics.n_tx_out}</dd></div>
      <div><dt>Отношение исходящих к входящим</dt><dd>{metrics.out_in_ratio === null ? "Не определено" : metrics.out_in_ratio.toLocaleString("ru-RU", { maximumFractionDigits: 6 })}</dd></div>
    </dl>
    <details className="node-section" open><summary>Связи узла · {edges.length}</summary>{edges.length ? <ul ref={connectionsRef} className="connections">{edges.map((edge, index) => {
      const self = edge.src === edge.dst;
      const outgoing = edge.src === node.gid;
      const other = outgoing ? edge.dst : edge.src;
      return <li key={index}><span className="connection-direction">{self ? "↻ Перевод себе" : outgoing ? "→ Исходящий" : "← Входящий"}<span>{edge.n_tx} транз.</span></span><button type="button" className="gid-button" onClick={() => onSelect(other)}>{other}</button><span className="connection-amount">{formatKzt(edge.sum_kzt)}</span><small className="muted">Глубина связи: {edge.depth}</small></li>;
    })}</ul> : <p className="muted small">Наблюдаемых связей нет. Узел сохранён на карте.</p>}</details>
    <details className="node-section" open><summary>Основание роли</summary><p className="evidence">{node.evidence}</p></details>
    {!!node.limitations.length && <details className="node-section node-limitations"><summary>Ограничения · {node.limitations.length}</summary><ul>{node.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
    {cluster && <details className="node-section"><summary>Кластер {cluster.cluster_id} · {cluster.n_nodes} узлов</summary><dl className="metric-list"><div><dt>Узлы / seeds</dt><dd>{cluster.n_nodes} / {cluster.n_seed}</dd></div><div><dt>Внутренний оборот</dt><dd>{formatKzt(cluster.sum_kzt_internal)}</dd></div></dl><h3>Гипотеза из расчёта</h3><p>{cluster.hypothesis}</p><h3>Ключевые узлы</h3><div className="cluster-gids">{cluster.top_gids.map(gid => <button type="button" className="gid-button" key={gid} onClick={() => onSelect(gid)}>{gid}</button>)}</div></details>}
  </aside>;
}
