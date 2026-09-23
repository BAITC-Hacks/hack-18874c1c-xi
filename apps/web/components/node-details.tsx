import type { AnalysisResult, GraphNode } from "@money-graph/contracts";
import { useMemo } from "react";
import { formatKzt, ROLES_PRESENTATION } from "../lib/presentation";

export default function NodeDetails({ result, node, onSelect }: { result: AnalysisResult; node?: GraphNode; onSelect: (gid: string) => void }) {
  const edges = useMemo(() => node ? result.edges.filter(edge => edge.src === node.gid || edge.dst === node.gid) : [], [result, node]);
  if (!node) return <aside className="node-panel panel node-empty" aria-label="Карточка узла"><p className="eyebrow">Детали узла</p><span className="node-empty-mark" aria-hidden="true">↖</span><h2>Выберите узел</h2><p className="muted">Нажмите на граф, найдите точный gid или выберите узел в таблице приоритетов.</p><p className="muted small">Здесь появятся метрики, объяснения и наблюдаемые связи.</p></aside>;
  const cluster = result.clusters.find(item => item.cluster_id === node.cluster_id);
  const metrics = node.metrics;
  return <aside className="node-panel panel" aria-label="Карточка узла">
    <p className="eyebrow">Детали узла</p><h2 className="node-gid" data-testid="selected-gid">{node.gid}</h2>
    <div className="node-tags"><span className="tag role-tag">{ROLES_PRESENTATION[node.role].symbol} {ROLES_PRESENTATION[node.role].label}</span><span className="tag">Кластер {node.cluster_id}</span><span className="tag">Глубина {node.depth}</span>{node.is_seed && <span className="tag">Seed</span>}</div>
    <div className="score-grid"><div><span>Оценка роли</span><strong>{node.role_score.toFixed(3)}</strong><small>role_score · эвристика</small></div><div><span>Приоритет проверки</span><strong>{node.priority_score.toFixed(3)}</strong><small>priority_score</small></div></div>
    <p className="muted small">Оценка роли не является калиброванной вероятностью нарушения.</p>
    <h3>Основание роли</h3><p className="evidence">{node.evidence}</p>
    <h3>Наблюдаемые метрики</h3><dl className="metric-list">
      <div><dt>Входящая сумма</dt><dd>{formatKzt(metrics.in_sum_kzt)}</dd></div><div><dt>Исходящая сумма</dt><dd>{formatKzt(metrics.out_sum_kzt)}</dd></div>
      <div><dt>Контрагенты · вход / выход</dt><dd>{metrics.in_degree} / {metrics.out_degree}</dd></div><div><dt>Транзакции · вход / выход</dt><dd>{metrics.n_tx_in} / {metrics.n_tx_out}</dd></div>
      <div><dt>Отношение исходящих к входящим</dt><dd>{metrics.out_in_ratio === null ? "Не определено" : metrics.out_in_ratio.toLocaleString("ru-RU", { maximumFractionDigits: 6 })}</dd></div>
    </dl>
    {!!node.limitations.length && <div className="node-limitations"><h3>Ограничения</h3><ul>{node.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
    <details className="node-section" open><summary>Связи узла · {edges.length}</summary>{edges.length ? <ul className="connections">{edges.map((edge, index) => {
      const self = edge.src === edge.dst;
      const outgoing = edge.src === node.gid;
      const other = outgoing ? edge.dst : edge.src;
      return <li key={index}><span className="muted small">{self ? "↻ Перевод себе" : outgoing ? "→ Исходящий" : "← Входящий"}</span><button type="button" className="gid-button" onClick={() => onSelect(other)}>{other}</button><span>{formatKzt(edge.sum_kzt)}</span><small className="muted">Транзакций: {edge.n_tx} · глубина {edge.depth}</small></li>;
    })}</ul> : <p className="muted small">Наблюдаемых связей нет. Узел сохранён на карте.</p>}</details>
    {cluster && <details className="node-section" open><summary>Кластер {cluster.cluster_id} · гипотеза</summary><dl className="metric-list"><div><dt>Узлы / seeds</dt><dd>{cluster.n_nodes} / {cluster.n_seed}</dd></div><div><dt>Внутренний оборот</dt><dd>{formatKzt(cluster.sum_kzt_internal)}</dd></div></dl><p>{cluster.hypothesis}</p><h3>Ключевые узлы</h3><div className="cluster-gids">{cluster.top_gids.map(gid => <button type="button" className="gid-button" key={gid} onClick={() => onSelect(gid)}>{gid} ↗</button>)}</div></details>}
  </aside>;
}
