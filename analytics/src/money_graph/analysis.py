"""Deterministic, explainable analysis of observed transfers, without an LLM."""

from __future__ import annotations

from collections import Counter
from fractions import Fraction
from math import isfinite, log

import networkx as nx

from .config import DEFAULT_CONFIG, RulesConfig
from .contracts import SCHEMA_VERSION
from .input_data import InputData, InputError, money_text


def cluster_graph(graph: nx.DiGraph, config: RulesConfig = DEFAULT_CONFIG) -> dict[int, int]:
    """Louvain on a weighted undirected projection; retain every isolate."""
    projection = nx.Graph()
    projection.add_nodes_from(sorted(graph))
    for src, dst, attrs in sorted(graph.edges(data=True)):
        if src == dst:
            # A raw self-transfer must not act as a pre-aggregated community.
            continue
        old = projection.get_edge_data(src, dst, {}).get("weight", 0)
        projection.add_edge(src, dst, weight=old + attrs["amount_minor"])
    communities: list[set[int]] = []
    for members in sorted(nx.connected_components(projection), key=min):
        subgraph = projection.subgraph(sorted(members)).copy()
        if subgraph.number_of_edges() == 0:
            communities.extend({gid} for gid in sorted(members))
            continue
        try:
            groups = nx.community.louvain_communities(
                subgraph, weight="weight", seed=config.louvain_seed,
                resolution=config.louvain_resolution, threshold=config.louvain_threshold,
            )
        except (OverflowError, ZeroDivisionError) as exc:
            raise InputError("Суммы выходят за численный диапазон Louvain; расчёт остановлен без округления финансовых данных") from exc
        # Louvain does not guarantee connected communities; split any disconnect.
        for group in groups:
            communities.extend(set(part) for part in nx.connected_components(subgraph.subgraph(group)))
    ordered = sorted(communities, key=lambda group: (-len(group), min(group)))
    return {gid: cluster_id for cluster_id, group in enumerate(ordered) for gid in sorted(group)}


def classify(node: dict, features: dict, config: RulesConfig = DEFAULT_CONFIG) -> tuple[str, float, str]:
    """First matching rule wins; scores measure heuristic strength, not probability."""
    inc, out = features["in_degree"], features["out_degree"]
    incoming, outgoing = features["in_minor"], features["out_minor"]
    external = features["external_clusters"]
    ratio = features["out_in_ratio"]
    seed = node["is_seed"]
    interior = node["depth"] < config.boundary_depth
    if inc >= config.coordinator_in and out >= config.coordinator_out and external >= config.coordinator_external_clusters:
        strength = (min(inc / (2 * config.coordinator_in), 1) + min(out / (2 * config.coordinator_out), 1) + min(external / (2 * config.coordinator_external_clusters), 1)) / 3
        role, score = "coordinator", 0.45 + 0.45 * strength
        evidence = f"Гипотеза связующего узла: вход={inc}, выход={out}, внешних кластеров={external}. Координация не доказана."
    elif inc >= config.consolidator_in and inc >= config.fan_dominance * out:
        strength = (min(inc / (2 * config.consolidator_in), 1) + 1 - out / inc) / 2
        role, score = "consolidator", 0.4 + 0.5 * strength
        evidence = f"Признаки концентрации: вход={inc} ≥ {config.consolidator_in} и ≥{config.fan_dominance}×выход={out}. Удержание средств не установлено."
        if not interior:
            evidence += " Граница depth=4: продолжение не видно."
    elif out >= config.distributor_out and out >= config.fan_dominance * inc:
        strength = (min(out / (2 * config.distributor_out), 1) + 1 - inc / out) / 2
        role, score = "distributor", 0.4 + 0.5 * strength
        evidence = f"Признаки распределения: выход={out} ≥ {config.distributor_out} и ≥{config.fan_dominance}×вход={inc}. Внешние источники средств неизвестны."
    elif (
        not seed and interior and incoming > 0 and outgoing > 0
        # Role membership uses exact tiyn and decimal policy thresholds, not
        # the rounded JSON ratio (which can hide a one-tiyn boundary crossing).
        and Fraction(str(config.transit_ratio_low)) * incoming <= outgoing
        and outgoing <= Fraction(str(config.transit_ratio_high)) * incoming
    ):
        tolerance = 1 - config.transit_ratio_low if ratio <= 1 else config.transit_ratio_high - 1
        closeness = 1 - abs(ratio - 1) / tolerance
        role, score = "transit", 0.35 + 0.30 * max(0, closeness)
        evidence = f"Транзитная гипотеза: выход/вход={ratio:.3f} в [{config.transit_ratio_low};{config.transit_ratio_high}], вход={inc}, выход={out}. Время удержания неизвестно."
    elif not seed and interior and inc > 0 and out == 0:
        role, score = "terminal", 0.35 + 0.25 * min(inc / config.consolidator_in, 1)
        evidence = f"Гипотеза конечного получателя в выборке: вход={inc}, выход=0, depth={node['depth']}<4. Остаток на счёте неизвестен."
    else:
        role, score = "peripheral", 0.1 if inc + out else 0.0
        evidence = f"Недостаточно признаков правил: вход={inc}, выход={out}, depth={node['depth']}."
        if not inc and not out:
            evidence += " Наблюдаемых переводов нет."
        elif seed:
            evidence += " Seed: входящие потоки неполны; ratio не используется для роли."
        elif not interior:
            evidence += " Граница обхода: конечный получатель не установлен."
    return role, round(score, 6), evidence


def analyze(data: InputData, config: RulesConfig = DEFAULT_CONFIG) -> dict:
    """Calculate contract v1 from validated records; keep all monetary sums integral."""
    graph = nx.DiGraph()
    original_nodes = sorted(data.nodes, key=lambda node: node["gid"])
    graph.add_nodes_from(node["gid"] for node in original_nodes)
    features = {node["gid"]: {
        "in_degree": 0, "out_degree": 0, "in_minor": 0, "out_minor": 0,
        "n_tx_in": 0, "n_tx_out": 0,
    } for node in original_nodes}
    edges = sorted(data.edges, key=lambda edge: (edge["src"], edge["dst"]))
    for edge in edges:
        src, dst, amount = edge["src"], edge["dst"], edge["amount_minor"]
        graph.add_edge(src, dst, amount_minor=amount)
        features[src]["out_degree"] += 1
        features[dst]["in_degree"] += 1
        features[src]["out_minor"] += amount
        features[dst]["in_minor"] += amount
        features[src]["n_tx_out"] += edge["n_tx"]
        features[dst]["n_tx_in"] += edge["n_tx"]
    cluster_ids = cluster_graph(graph, config)
    max_volume = max(f["in_minor"] + f["out_minor"] for f in features.values())
    max_in = max(f["in_degree"] for f in features.values())
    max_out = max(f["out_degree"] for f in features.values())
    nodes = []
    priority_reasons: dict[str, str] = {}
    for original in original_nodes:
        gid = original["gid"]
        f = features[gid]
        f["external_clusters"] = len({cluster_ids[other] for other in set(graph.predecessors(gid)) | set(graph.successors(gid)) if cluster_ids[other] != cluster_ids[gid]})
        try:
            ratio = f["out_minor"] / f["in_minor"] if f["in_minor"] else None
        except OverflowError as exc:
            raise InputError("Отношение потоков выходит за диапазон JSON number") from exc
        if ratio is not None and not isfinite(ratio):
            raise InputError("Отношение потоков должно быть конечным")
        f["out_in_ratio"] = ratio
        role, role_score, evidence = classify(original, f, config)
        volume = f["in_minor"] + f["out_minor"]
        degree = f["in_degree"] + f["out_degree"]
        # log(1 + KZT) without first rounding an exact monetary aggregate to float.
        volume_score = (log(100 + volume) - log(100)) / (log(100 + max_volume) - log(100)) if max_volume else 0.0
        in_score = log(1 + f["in_degree"]) / log(1 + max_in) if max_in else 0.0
        out_score = log(1 + f["out_degree"]) / log(1 + max_out) if max_out else 0.0
        priority = round(config.priority_volume_weight * volume_score + config.priority_in_weight * in_score + config.priority_out_weight * out_score + config.priority_role_weight * role_score, 6)
        limitations = ["Внешние входящие потоки не наблюдаются; суммы не являются полным балансом."]
        if original["is_seed"]:
            limitations.append("Seed: входящие особенно неполны; отношение потоков не используется для transit/terminal.")
        if original["depth"] == config.boundary_depth:
            limitations.append("depth=4: исходящий обход завершён; отсутствие переводов дальше не означает удержание денег.")
        if not degree:
            limitations.append("Нет наблюдаемых рёбер; узел сохранён как отдельный кластер.")
        if ratio is None:
            limitations.append("Входящая сумма равна нулю: out_in_ratio не определён.")
        if role in ("terminal", "transit"):
            limitations.append("Роль описывает наблюдаемые потоки за период, не время удержания или остаток на счёте.")
        if role == "coordinator":
            limitations.append("Межкластерные связи — структурный признак, а не доказательство организационного контроля.")
        node = {
            "gid": str(gid), "role": role, "role_score": role_score,
            "cluster_id": cluster_ids[gid], "priority_score": priority, "evidence": evidence,
            "depth": original["depth"], "is_seed": original["is_seed"],
            "metrics": {"in_degree": f["in_degree"], "out_degree": f["out_degree"],
                        "in_sum_kzt": money_text(f["in_minor"]), "out_sum_kzt": money_text(f["out_minor"]),
                        "n_tx_in": f["n_tx_in"], "n_tx_out": f["n_tx_out"], "out_in_ratio": ratio},
            "limitations": limitations,
        }
        nodes.append(node)
        priority_reasons[str(gid)] = (
            f"Приоритет структуры, не риск виновности: {config.priority_volume_weight}×объём({volume_score:.3f}) + "
            f"{config.priority_in_weight}×вход({in_score:.3f}) + {config.priority_out_weight}×выход({out_score:.3f}) + "
            f"{config.priority_role_weight}×признаки({role_score:.3f}); "
            f"наблюдаемый вход+выход={money_text(volume)} KZT, степени={f['in_degree']}+{f['out_degree']}. "
            + ("Граница depth=4 ограничивает наблюдения." if original["depth"] == config.boundary_depth else "Внешние потоки неизвестны.")
        )
    ranked = sorted(nodes, key=lambda node: (-node["priority_score"], int(node["gid"])))
    groups: dict[int, list[dict]] = {}
    for node in ranked:
        groups.setdefault(node["cluster_id"], []).append(node)
    internal = Counter()
    for edge in edges:
        if cluster_ids[edge["src"]] == cluster_ids[edge["dst"]]:
            internal[cluster_ids[edge["src"]]] += edge["amount_minor"]
    clusters = []
    for cluster_id, members in sorted(groups.items()):
        roles = Counter(node["role"] for node in members)
        n_seed = sum(node["is_seed"] for node in members)
        if len(members) == 1 and not graph.degree(int(members[0]["gid"])):
            hypothesis = "Изолированный узел: наблюдаемых связей нет; назначение группы установить нельзя."
        else:
            hypothesis = (
                f"Гипотеза связанной группы: {len(members)} узлов, seeds={n_seed}; "
                f"признаки концентрации={roles['consolidator']}, распределения={roles['distributor']}, "
                f"транзита={roles['transit']}; внутренние переводы={money_text(internal[cluster_id])} KZT. "
                "Общая цель или контроль не доказаны."
            )
        clusters.append({"cluster_id": cluster_id, "n_nodes": len(members), "n_seed": n_seed,
                         "sum_kzt_internal": money_text(internal[cluster_id]),
                         "top_gids": [node["gid"] for node in members[:config.cluster_top_count]],
                         "hypothesis": hypothesis})
    warnings = list(data.warnings) + [
        "Наблюдаются внутрибанковские исходящие обходы до depth=4; переводы ниже порога 5000 KZT не представлены в исходном наборе.",
        "Роли и назначения кластеров — гипотезы; ground truth отсутствует, scores не являются вероятностью нарушения.",
        "Кластеры: Louvain на неориентированной проекции; встречные суммы сложены только для веса, финансовые итоги считаются по исходным направленным рёбрам.",
        f"Слабосвязных компонент со всеми узлами: {nx.number_weakly_connected_components(graph)}; изолятов: {len(list(nx.isolates(graph)))}.",
    ]
    return {
        "metadata": {"schema_version": SCHEMA_VERSION, "n_nodes": len(nodes), "n_edges": len(edges),
                     "n_transactions": len(data.transactions), "n_seeds": sum(n["is_seed"] for n in nodes),
                     "elapsed_ms": 0.0, "warnings": warnings},
        "nodes": nodes,
        "edges": [{"src": str(e["src"]), "dst": str(e["dst"]), "sum_kzt": money_text(e["amount_minor"]), "n_tx": e["n_tx"], "depth": e["depth"]} for e in edges],
        "clusters": clusters,
        "top_nodes": [{"rank": rank, "gid": node["gid"], "role": node["role"], "priority_score": node["priority_score"], "why": priority_reasons[node["gid"]]} for rank, node in enumerate(ranked[:config.top_count], 1)],
    }
