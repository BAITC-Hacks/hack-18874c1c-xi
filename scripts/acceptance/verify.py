#!/usr/bin/env python3
"""Independent must-have oracle, not a call back into production validators.

Rules below are transcribed from docs/METHODOLOGY.md (standard policy v1).
Only PyArrow is needed beyond the standard library. No money_graph imports,
hardcoded real gids, inferred criminal labels, or external services are used.
Detailed node cases stay in the explicitly selected local report directory.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
import csv
from decimal import Decimal, InvalidOperation
import json
import math
from pathlib import Path
import random
import re
import sys

import pyarrow.parquet as pq


SCHEMAS = {
    "nodes_roles.csv": ("gid", "role", "role_score", "cluster_id", "priority_score", "evidence"),
    "clusters.csv": ("cluster_id", "n_nodes", "n_seed", "sum_kzt_internal", "top_gids", "hypothesis"),
    "top_nodes.csv": ("rank", "gid", "role", "priority_score", "why"),
}
ROLES = {"coordinator", "consolidator", "distributor", "transit", "terminal", "peripheral"}
OFFICIAL = {"n_nodes": 2248, "n_edges": 3119, "n_transactions": 4840, "n_seeds": 81}


class VerificationError(ValueError):
    """A failed acceptance check; messages intentionally contain no real gids."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def money(value: object, *, json_string: bool = False, positive: bool = False) -> int:
    if json_string:
        require(isinstance(value, str) and bool(re.fullmatch(r"\d+(?:\.\d+)?", value)), "Money must be a plain decimal string")
    require(not isinstance(value, bool), "Money cannot be boolean")
    try:
        number = Decimal(str(value))
        require(number.is_finite(), "Money must be finite")
        numerator, denominator = number.as_integer_ratio()
    except (InvalidOperation, ValueError, TypeError, OverflowError) as exc:
        raise VerificationError("Invalid monetary value") from exc
    numerator *= 100
    require(numerator % denominator == 0, "Money contains sub-tiyn precision")
    minor = numerator // denominator
    require(minor > 0 if positive else minor >= 0, "Money is negative or a non-positive transfer")
    return minor


def gid(value: object, *, raw: bool = False) -> str:
    if raw:
        require(type(value) is int, "Raw gid must be integer")
    else:
        require(isinstance(value, str) and bool(re.fullmatch(r"0|-?[1-9]\d*", value)), "gid must be canonical decimal text")
    result = str(value)
    require(-(2**63) <= int(result) < 2**63, "gid outside int64")
    return result


def integer(value: object, name: str, minimum: int = 0) -> int:
    require(type(value) is int and value >= minimum, f"Invalid {name}")
    return value


def score(value: object) -> float:
    require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1, "Score must be finite in [0,1]")
    return float(value)


def text(value: object, name: str, limit: int | None = None) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"Empty or invalid {name}")
    require(limit is None or len(value) <= limit, f"{name} exceeds Unicode character limit")
    return value


def reject_constant(_: str) -> None:
    raise VerificationError("Non-finite JSON number")


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    result: dict = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON field")
        result[key] = value
    return result


def load_json(path: Path) -> dict:
    try:
        result = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant, object_pairs_hook=unique_object)
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"Cannot read valid JSON: {path.name}") from exc
    require(isinstance(result, dict), "JSON root must be an object")
    return result


def fields(value: object, expected: set[str], context: str) -> None:
    require(isinstance(value, dict) and set(value) == expected, f"Unexpected fields in {context}")


def read_csv(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle, strict=True)
            require(tuple(reader.fieldnames or ()) == SCHEMAS[path.name], f"Wrong CSV header: {path.name}")
            records = list(reader)
    except (OSError, csv.Error, UnicodeError) as exc:
        raise VerificationError(f"Cannot read CSV: {path.name}") from exc
    require(all(None not in row and all(value is not None and value.strip() for value in row.values()) for row in records), f"Empty or malformed CSV field: {path.name}")
    return records


def csv_matches(rows: list[dict[str, str]], objects: list[dict], filename: str) -> None:
    require(len(rows) == len(objects), f"CSV/JSON row count mismatch: {filename}")
    for row, obj in zip(rows, objects, strict=True):
        for name in SCHEMAS[filename]:
            expected = obj[name]
            if name == "top_gids":
                try:
                    actual = json.loads(row[name])
                except json.JSONDecodeError as exc:
                    raise VerificationError("Invalid top_gids JSON in CSV") from exc
                require(actual == expected, "CSV/JSON representative mismatch")
            elif name in {"role_score", "priority_score"}:
                try:
                    actual_number = Decimal(row[name])
                except InvalidOperation as exc:
                    raise VerificationError("Invalid CSV score") from exc
                require(actual_number.is_finite() and actual_number == Decimal(str(expected)), f"CSV/JSON score mismatch: {filename}")
            elif name == "sum_kzt_internal":
                require(money(row[name], json_string=True) == money(expected, json_string=True), "CSV/JSON cluster amount mismatch")
            else:
                require(row[name] == str(expected), f"CSV/JSON field mismatch: {filename}/{name}")


def raw_data(input_dir: Path, mode: str) -> tuple[dict, dict, dict, dict]:
    """Derive graph facts directly from all three original Parquet tables."""
    tables = {}
    expected_columns = {
        "nodes": {"gid", "depth", "is_seed"},
        "edges": {"src", "dst", "sum_kzt", "n_tx", "depth"},
        "transactions": {"src", "dst", "date", "sum_kzt"},
    }
    for name in expected_columns:
        path = input_dir / f"{name}.parquet"
        require(path.is_file(), f"Required input missing: {path.name}; official acceptance cannot be skipped")
        try:
            table = pq.read_table(path)
            require(set(table.column_names) == expected_columns[name], f"Unexpected input columns: {name}")
            require(all(column.null_count == 0 for column in table.columns), f"Null input value: {name}")
            tables[name] = table.to_pylist()
        except (OSError, ValueError) as exc:
            raise VerificationError(f"Invalid Parquet: {name}") from exc
    nodes, edges = {}, {}
    for row in tables["nodes"]:
        key = gid(row["gid"], raw=True)
        require(key not in nodes, "Duplicate raw node")
        require(type(row["is_seed"]) is bool, "Raw is_seed must be boolean")
        integer(row["depth"], "raw depth")
        require(row["depth"] <= 4 and row["is_seed"] == (row["depth"] == 0), "Inconsistent raw seed/depth")
        nodes[key] = row
    require(bool(nodes), "Empty raw node table")
    facts = {key: {"incoming": set(), "outgoing": set(), "in_minor": 0, "out_minor": 0, "n_tx_in": 0, "n_tx_out": 0} for key in nodes}
    for row in tables["edges"]:
        pair = (gid(row["src"], raw=True), gid(row["dst"], raw=True))
        src, dst = pair
        require(pair not in edges and src in nodes and dst in nodes, "Duplicate edge or unknown endpoint")
        amount = money(row["sum_kzt"], positive=True)
        count = integer(row["n_tx"], "raw n_tx", 1)
        depth = integer(row["depth"], "raw edge depth", 1)
        require(depth <= 4 and depth == nodes[src]["depth"] + 1 and nodes[dst]["depth"] <= depth, "Inconsistent raw edge depth")
        edges[pair] = {"amount": amount, "n_tx": count, "depth": depth}
        facts[src]["outgoing"].add(dst)
        facts[dst]["incoming"].add(src)
        facts[src]["out_minor"] += amount
        facts[dst]["in_minor"] += amount
        facts[src]["n_tx_out"] += count
        facts[dst]["n_tx_in"] += count
    transactions: dict = defaultdict(lambda: [0, 0])
    for row in tables["transactions"]:
        pair = (gid(row["src"], raw=True), gid(row["dst"], raw=True))
        require(pair in edges, "Transaction missing its aggregated edge")
        transactions[pair][0] += money(row["sum_kzt"], positive=True)
        transactions[pair][1] += 1
    require(set(transactions) == set(edges), "Transaction/edge pair mismatch")
    require(all(transactions[pair] == [edge["amount"], edge["n_tx"]] for pair, edge in edges.items()), "Raw transaction sums/counts do not equal edges")
    distance = {key: 0 for key, row in nodes.items() if row["is_seed"]}
    queue = deque(distance)
    while queue:
        source = queue.popleft()
        for target in facts[source]["outgoing"]:
            if target not in distance:
                distance[target] = distance[source] + 1
                queue.append(target)
    require(set(distance) == set(nodes) and all(distance[key] == row["depth"] for key, row in nodes.items()), "Raw depth is not shortest directed seed distance")
    counts = {"n_nodes": len(nodes), "n_edges": len(edges), "n_transactions": len(tables["transactions"]), "n_seeds": sum(row["is_seed"] for row in nodes.values())}
    if mode == "official":
        require(counts == OFFICIAL, "Official dataset dimensions differ from must-have baseline")
    return nodes, edges, facts, counts


def expected_role(raw: dict, fact: dict, external: int) -> tuple[str, float]:
    """Independent table of documented first-match rules, using exact thresholds."""
    inc, out = len(fact["incoming"]), len(fact["outgoing"])
    incoming, outgoing = fact["in_minor"], fact["out_minor"]
    interior = not raw["is_seed"] and raw["depth"] < 4
    if inc >= 5 and out >= 5 and external >= 2:
        return "coordinator", round(0.45 + 0.45 * (min(inc / 10, 1) + min(out / 10, 1) + min(external / 4, 1)) / 3, 6)
    if inc >= 3 and inc >= 2 * out:
        return "consolidator", round(0.4 + 0.5 * (min(inc / 6, 1) + 1 - out / inc) / 2, 6)
    if out >= 5 and out >= 2 * inc:
        return "distributor", round(0.4 + 0.5 * (min(out / 10, 1) + 1 - inc / out) / 2, 6)
    if interior and incoming > 0 and outgoing > 0 and 4 * incoming <= 5 * outgoing <= 6 * incoming:
        ratio = outgoing / incoming
        return "transit", round(0.35 + 0.30 * max(0, 1 - abs(ratio - 1) / 0.20), 6)
    if interior and inc > 0 and out == 0:
        return "terminal", round(0.35 + 0.25 * min(inc / 3, 1), 6)
    return "peripheral", 0.1 if inc + out else 0.0


def verify_methodology() -> None:
    path = Path(__file__).resolve().parents[2] / "docs" / "METHODOLOGY.md"
    require(path.is_file(), "METHODOLOGY.md is required for explanation acceptance")
    document = path.read_text(encoding="utf-8")
    # Presence checks only. Human clarity and a one-minute explanation need a rehearsal.
    anchors = [
        "`coordinator`", "`consolidator`", "`distributor`", "`transit`", "`terminal`", "`peripheral`",
        "I ≥ 5", "O ≥ 5", "E ≥ 2", "I ≥ 3", "I ≥ 2 × O", "O ≥ 2 × I", "0.8 ≤ R ≤ 1.2",
        "depth < 4", "0.35 × N(V)", "0.35 × N(I)", "0.10 × N(O)", "0.20 × role_score",
        "сверху вниз", "не вероятность", "миллиона узлов",
    ]
    require(all(anchor in document for anchor in anchors), "Documented role/priority/limitation/scale anchors missing or policy changed; review oracle and methodology together")


def verify(input_dir: Path, output_dir: Path, mode: str = "official") -> tuple[dict, dict]:
    require(mode in {"official", "generic"}, "Unknown verification mode")
    verify_methodology()
    raw_nodes, raw_edges, facts, counts = raw_data(input_dir, mode)
    result = load_json(output_dir / "analysis.json")
    fields(result, {"metadata", "nodes", "edges", "clusters", "top_nodes"}, "snapshot")
    for name in ("nodes", "edges", "clusters", "top_nodes"):
        require(isinstance(result[name], list), f"{name} must be an array")
    metadata = result["metadata"]
    fields(metadata, {"schema_version", "n_nodes", "n_edges", "n_transactions", "n_seeds", "elapsed_ms", "warnings"}, "metadata")
    require(metadata["schema_version"] == "1.0", "Unknown schema_version")
    for name, count in counts.items():
        require(integer(metadata[name], name) == count, "Metadata differs from raw dataset")
    elapsed = metadata["elapsed_ms"]
    require(type(elapsed) in (int, float) and math.isfinite(elapsed) and elapsed >= 0, "Invalid metadata elapsed_ms")
    require(isinstance(metadata["warnings"], list) and bool(metadata["warnings"]), "Missing methodological warnings")
    for warning in metadata["warnings"]:
        text(warning, "warning")
    nodes = {}
    for node in result["nodes"]:
        fields(node, set(SCHEMAS["nodes_roles.csv"]) | {"depth", "is_seed", "metrics", "limitations"}, "node")
        key = gid(node["gid"])
        require(key not in nodes, "Duplicate output node")
        require(node["role"] in ROLES, "Unknown role")
        score(node["role_score"])
        score(node["priority_score"])
        text(node["evidence"], "evidence", 200)
        integer(node["cluster_id"], "cluster_id")
        integer(node["depth"], "depth")
        require(type(node["is_seed"]) is bool, "Output seed must be boolean")
        require(isinstance(node["limitations"], list) and bool(node["limitations"]), "Missing node limitations")
        for limitation in node["limitations"]:
            text(limitation, "limitation")
        nodes[key] = node
    require(set(nodes) == set(raw_nodes), "Output gid set differs from all raw nodes (including isolates)")
    require(list(nodes) == sorted(nodes, key=int), "Node output order must be numeric gid order")
    max_volume = max(f["in_minor"] + f["out_minor"] for f in facts.values())
    max_in = max(len(f["incoming"]) for f in facts.values())
    max_out = max(len(f["outgoing"]) for f in facts.values())
    priority_parts = {}
    for key, node in nodes.items():
        raw, fact = raw_nodes[key], facts[key]
        require(node["depth"] == raw["depth"] and node["is_seed"] == raw["is_seed"], "Output depth/seed differs from input")
        metrics = node["metrics"]
        fields(metrics, {"in_degree", "out_degree", "in_sum_kzt", "out_sum_kzt", "n_tx_in", "n_tx_out", "out_in_ratio"}, "metrics")
        inc, out = len(fact["incoming"]), len(fact["outgoing"])
        for name, expected in {"in_degree": inc, "out_degree": out, "n_tx_in": fact["n_tx_in"], "n_tx_out": fact["n_tx_out"]}.items():
            require(integer(metrics[name], name) == expected, "Node count metric differs from raw edges")
        for field, source in (("in_sum_kzt", "in_minor"), ("out_sum_kzt", "out_minor")):
            require(money(metrics[field], json_string=True) == fact[source], "Node money metric differs from raw edges")
        ratio = metrics["out_in_ratio"]
        if fact["in_minor"] == 0:
            require(ratio is None, "Zero input must have null ratio")
        else:
            require(type(ratio) in (float, int) and math.isfinite(ratio) and ratio == fact["out_minor"] / fact["in_minor"], "Incorrect observed ratio")
        neighbors = fact["incoming"] | fact["outgoing"]
        external = len({nodes[neighbor]["cluster_id"] for neighbor in neighbors} - {node["cluster_id"]})
        role, strength = expected_role(raw, fact, external)
        require(node["role"] == role, "Role contradicts documented first-match rule")
        require(node["role_score"] == strength, "Role score contradicts documented formula")
        require(bool(re.search(rf"вход={inc}(?!\d)", node["evidence"])) and bool(re.search(rf"выход={out}(?!\d)", node["evidence"])), "Evidence does not contain actual directed degree values")
        if role == "coordinator":
            require(bool(re.search(rf"кластеров={external}(?!\d)", node["evidence"])), "Coordinator evidence misses external cluster count")
        if role == "transit":
            require(f"выход/вход={ratio:.3f}" in node["evidence"], "Transit evidence misses observed ratio")
        volume = fact["in_minor"] + fact["out_minor"]
        # log1p in KZT is deliberately independent of the production log-difference form.
        volume_norm = math.log1p(volume / 100) / math.log1p(max_volume / 100) if max_volume else 0
        in_norm = math.log1p(inc) / math.log1p(max_in) if max_in else 0
        out_norm = math.log1p(out) / math.log1p(max_out) if max_out else 0
        expected_priority = round(0.35 * volume_norm + 0.35 * in_norm + 0.10 * out_norm + 0.20 * strength, 6)
        require(node["priority_score"] == expected_priority, "Priority contradicts documented formula")
        priority_parts[key] = (volume_norm, in_norm, out_norm, strength)
        if raw["is_seed"] or raw["depth"] == 4:
            require(node["role"] not in {"terminal", "transit"}, "Seed/depth=4 guard failed")
        if raw["depth"] == 4:
            require(any("depth=4" in value for value in node["limitations"]), "Boundary limitation missing")
        if raw["is_seed"]:
            require(any("seed" in value.lower() for value in node["limitations"]), "Seed limitation missing")
    seen_edges = set()
    for edge in result["edges"]:
        fields(edge, {"src", "dst", "sum_kzt", "n_tx", "depth"}, "edge")
        pair = (gid(edge["src"]), gid(edge["dst"]))
        require(pair in raw_edges and pair not in seen_edges, "Unknown or duplicate output edge")
        expected = raw_edges[pair]
        require(money(edge["sum_kzt"], json_string=True, positive=True) == expected["amount"], "Output edge amount differs from raw")
        require(integer(edge["n_tx"], "edge n_tx", 1) == expected["n_tx"] and integer(edge["depth"], "edge depth", 1) == expected["depth"], "Output edge count/depth differs from raw")
        seen_edges.add(pair)
    require(seen_edges == set(raw_edges), "Output edge coverage incomplete")
    members: dict = defaultdict(list)
    for key, node in nodes.items():
        members[node["cluster_id"]].append(key)
    expected_order = sorted(members.values(), key=lambda group: (-len(group), min(map(int, group))))
    require(all(set(members.get(index, ())) == set(group) for index, group in enumerate(expected_order)), "Cluster numbering violates stable size/gid order")
    internal = Counter()
    for (src, dst), edge in raw_edges.items():
        if nodes[src]["cluster_id"] == nodes[dst]["cluster_id"]:
            internal[nodes[src]["cluster_id"]] += edge["amount"]
    rank_key = lambda key: (-nodes[key]["priority_score"], int(key))
    cluster_ids = []
    for cluster in result["clusters"]:
        fields(cluster, set(SCHEMAS["clusters.csv"]), "cluster")
        cluster_id = integer(cluster["cluster_id"], "cluster_id")
        require(cluster_id in members and cluster_id not in cluster_ids, "Unknown or duplicate cluster")
        group = members[cluster_id]
        require(integer(cluster["n_nodes"], "cluster n_nodes", 1) == len(group), "Cluster size mismatch")
        require(integer(cluster["n_seed"], "cluster n_seed") == sum(raw_nodes[key]["is_seed"] for key in group), "Cluster seed count mismatch")
        require(money(cluster["sum_kzt_internal"], json_string=True) == internal[cluster_id], "Cluster internal amount is not exact directed sum")
        require(cluster["top_gids"] == sorted(group, key=rank_key)[:3], "Cluster representatives differ from top-three policy")
        text(cluster["hypothesis"], "hypothesis")
        # A reported community cannot stitch together disconnected components.
        allowed, visited, queue = set(group), set(), deque([group[0]])
        while queue:
            key = queue.popleft()
            if key not in visited:
                visited.add(key)
                queue.extend(((facts[key]["incoming"] | facts[key]["outgoing"]) & allowed) - visited)
        require(visited == allowed, "Cluster is disconnected")
        cluster_ids.append(cluster_id)
    require(cluster_ids == list(range(len(members))), "Cluster coverage/order incomplete")
    ranked = sorted(nodes, key=rank_key)
    top = result["top_nodes"]
    require(len(top) == min(20, len(nodes)), "Top list must contain documented first 20 nodes")
    for rank, item in enumerate(top, 1):
        fields(item, set(SCHEMAS["top_nodes.csv"]), "top node")
        key = gid(item["gid"])
        require(integer(item["rank"], "rank", 1) == rank and key == ranked[rank - 1], "Top ranking/order is incorrect")
        require(item["role"] == nodes[key]["role"] and score(item["priority_score"]) == nodes[key]["priority_score"], "Top role/score differs from node")
        explanation = text(item["why"], "why")
        terms = tuple(zip(("0.35×объём", "0.35×вход", "0.1×выход", "0.2×признаки"), priority_parts[key], strict=True))
        require(all(f"{name}({value:.3f})" in explanation for name, value in terms), "Priority explanation misses actual normalized terms and weights")
        volume = facts[key]["in_minor"] + facts[key]["out_minor"]
        amount = f"{volume // 100}.{volume % 100:02d}"
        require(f"вход+выход={amount} KZT" in explanation and f"степени={len(facts[key]['incoming'])}+{len(facts[key]['outgoing'])}." in explanation, "Priority explanation misses actual volume/degrees")
    for filename, source in (("nodes_roles.csv", "nodes"), ("clusters.csv", "clusters"), ("top_nodes.csv", "top_nodes")):
        csv_matches(read_csv(output_dir / filename), result[source], filename)
    isolates = [key for key in nodes if not facts[key]["incoming"] and not facts[key]["outgoing"]]
    inbound = [key for key in nodes if raw_nodes[key]["is_seed"] and facts[key]["incoming"] and not facts[key]["outgoing"]]
    boundary = [key for key in nodes if raw_nodes[key]["depth"] == 4]
    if mode == "official":
        require(len(isolates) == 19 and len(inbound) == 12 and len(boundary) == 444, "Official boundary/seed/isolate dimensions differ")
        require({node["role"] for node in nodes.values()} == ROLES, "Official result does not exercise all six roles")
    require(all(len(members[nodes[key]["cluster_id"]]) == 1 and nodes[key]["role_score"] == 0 and nodes[key]["priority_score"] == 0 for key in isolates), "Isolate is not preserved with zero structural scores in its own cluster")
    ordered = sorted(nodes, key=int)
    cases = {
        "schema_version": "1.0", "random_seed": 42, "analysis_path": "cli-1/analysis.json",
        "arbitrary_gids": random.Random(42).sample(ordered, min(3, len(ordered))),
        "isolate_gid": isolates[0] if isolates else None,
        "inbound_only_seed_gid": inbound[0] if inbound else None,
        "depth4_gid": boundary[0] if boundary else None,
        "outside_top_gid": ranked[20] if len(ranked) > 20 else None,
        "roles": {role: next((key for key in ordered if nodes[key]["role"] == role), None) for role in sorted(ROLES)},
    }
    cases["cases"] = [{"name": f"arbitrary-{index}", "gid": key} for index, key in enumerate(cases["arbitrary_gids"], 1)]
    cases["cases"] += [{"name": name, "gid": cases[name]} for name in ("isolate_gid", "inbound_only_seed_gid", "depth4_gid", "outside_top_gid") if cases[name] is not None]
    cases["cases"] += [{"name": f"role-{role}", "gid": key} for role, key in cases["roles"].items() if key is not None]
    summary = {
        "status": "passed", "mode": mode, "counts": counts, "n_clusters": len(members),
        "n_top": len(top), "n_isolates": len(isolates), "n_inbound_only_seeds": len(inbound),
        "n_depth4": len(boundary), "role_counts": dict(sorted(Counter(node["role"] for node in nodes.values()).items())),
        "checks": ["raw-parquet-integrity", "exact-gid-coverage", "all-node-metrics", "documented-role-and-score-formulas", "priority-formula", "evidence-degree-values", "seed-and-boundary-safeguards", "exact-directed-cluster-amounts", "connected-clusters", "stable-cluster-numbering", "top-ranking-and-representatives", "csv-json-equality", "methodology-rule-and-threshold-presence"],
        "not_proven": ["AML detection accuracy without ground truth", "human explanation in one minute or semantic completeness of documentation", "browser visualization (separate suite)", "independent validation of transaction dates (handled by production input tests)", "conformance to specific Louvain configuration or optimality of partition (oracle checks partition invariants, not a second Louvain implementation)"],
    }
    return summary, cases


def write_json_new(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write("\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--mode", choices=("official", "generic"), default="official")
    args = parser.parse_args()
    try:
        summary, cases = verify(args.input_dir, args.output_dir, args.mode)
        cases["analysis_path"] = str((args.output_dir / "analysis.json").resolve())
        write_json_new(args.report, {**summary, "cases": cases})
        print(json.dumps(summary, ensure_ascii=False))
        return 0
    except (VerificationError, OSError, KeyError, TypeError, ValueError) as exc:
        # Do not echo data rows or arbitrary exception messages containing gids.
        message = str(exc) if isinstance(exc, VerificationError) else type(exc).__name__
        print(json.dumps({"status": "failed", "error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
