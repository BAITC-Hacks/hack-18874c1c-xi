"""Validate one result and publish its four consistent files as a single directory.

This boundary validates the contract, not the role-assignment heuristics. Decimal
money is compared as rational numbers, avoiding both float and Decimal-context
rounding during financial aggregation. Ranking scores remain finite JSON numbers.
"""

import csv
import json
import math
import os
import re
import shutil
import tempfile
from collections import defaultdict
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

from .config import DEFAULT_CONFIG
from .contracts import CSV_COLUMNS, ROLES, SCHEMA_VERSION


class OutputError(ValueError):
    """A result violates the output contract or cannot be published safely."""


_GID = re.compile(r"-?(0|[1-9][0-9]*)", re.ASCII)
_MONEY = re.compile(r"-?[0-9]+(?:\.[0-9]+)?", re.ASCII)
_FIELDS = {
    "snapshot": ("metadata", "nodes", "edges", "clusters", "top_nodes"),
    "metadata": ("schema_version", "n_nodes", "n_edges", "n_transactions", "n_seeds", "elapsed_ms", "warnings"),
    "node": (*CSV_COLUMNS["nodes_roles.csv"], "depth", "is_seed", "metrics", "limitations"),
    "metrics": ("in_degree", "out_degree", "in_sum_kzt", "out_sum_kzt", "n_tx_in", "n_tx_out", "out_in_ratio"),
    "edge": ("src", "dst", "sum_kzt", "n_tx", "depth"),
    "cluster": CSV_COLUMNS["clusters.csv"],
    "top_node": CSV_COLUMNS["top_nodes.csv"],
}
_CSV_SOURCES = {"nodes_roles.csv": "nodes", "clusters.csv": "clusters", "top_nodes.csv": "top_nodes"}


def _fail(path, message):
    raise OutputError(f"{path}: {message}")


def _object(value, kind, path):
    if type(value) is not dict:
        _fail(path, "expected an object")
    required = set(_FIELDS[kind])
    if set(value) != required:
        missing = sorted(required - set(value))
        extra = sorted(str(key) for key in set(value) - required)
        _fail(path, f"unexpected fields (missing={missing}, extra={extra})")


def _array(value, path):
    if type(value) is not list:
        _fail(path, "expected an array")


def _strings(value, path):
    _array(value, path)
    if any(type(item) is not str for item in value):
        _fail(path, "all entries must be strings")


def _integer(value, path, minimum=None):
    if type(value) is not int or (minimum is not None and value < minimum):
        _fail(path, f"expected an integer{' >= ' + str(minimum) if minimum is not None else ''}")


def _number(value, path, minimum=None, maximum=None):
    if type(value) not in (int, float):
        _fail(path, "expected a finite JSON number")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite or (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        _fail(path, "number is nonfinite or outside its allowed range")


def _text(value, path, maximum=None):
    if type(value) is not str or not value.strip() or (maximum is not None and len(value) > maximum):
        _fail(path, "expected nonblank text within its length limit")


def _gid(value, path):
    if type(value) is not str or len(value) > 20 or _GID.fullmatch(value) is None:
        _fail(path, "expected a decimal int64 string")
    integer = int(value)
    if not -(2**63) <= integer < 2**63 or str(integer) != value:
        _fail(path, "gid is outside int64 or is not canonical decimal notation")


def _money(value, path, *, positive=False):
    if type(value) is not str or _MONEY.fullmatch(value) is None:
        _fail(path, "expected an exact decimal monetary string without exponent")
    amount = Fraction(Decimal(value))
    if amount < 0 or (positive and amount == 0):
        _fail(path, "expected a positive transfer" if positive else "expected a nonnegative monetary total")
    if (amount * 100).denominator != 1:
        _fail(path, "sub-tiyn monetary precision is not allowed; rounding is forbidden")
    return amount


def _role(value, path):
    if type(value) is not str or value not in ROLES:
        _fail(path, "unknown role")


def _same(actual, expected, path):
    if actual != expected:
        _fail(path, "does not match the underlying nodes or edges")


def validate_snapshot(snapshot: dict) -> None:
    """Reject malformed shapes, financial inconsistencies and incomplete results.

No classification rules are repeated here. The producer remains responsible for
comparing the node set to the source Parquet; this validator verifies the complete
internal consistency of the supplied snapshot.
    """
    _object(snapshot, "snapshot", "snapshot")
    metadata = snapshot["metadata"]
    _object(metadata, "metadata", "metadata")
    if metadata["schema_version"] != SCHEMA_VERSION:
        _fail("metadata.schema_version", "unsupported schema version")
    for key in ("n_nodes", "n_edges", "n_transactions", "n_seeds"):
        _integer(metadata[key], f"metadata.{key}", 0)
    _number(metadata["elapsed_ms"], "metadata.elapsed_ms", 0)
    _strings(metadata["warnings"], "metadata.warnings")
    for key in ("nodes", "edges", "clusters", "top_nodes"):
        _array(snapshot[key], key)

    nodes = {}
    members = defaultdict(list)
    for index, node in enumerate(snapshot["nodes"]):
        path = f"nodes[{index}]"
        _object(node, "node", path)
        _gid(node["gid"], f"{path}.gid")
        if node["gid"] in nodes:
            _fail(f"{path}.gid", "duplicate node")
        _role(node["role"], f"{path}.role")
        _number(node["role_score"], f"{path}.role_score", 0, 1)
        _number(node["priority_score"], f"{path}.priority_score", 0, 1)
        _integer(node["cluster_id"], f"{path}.cluster_id")
        _integer(node["depth"], f"{path}.depth", 0)
        if node["depth"] > 4:
            _fail(f"{path}.depth", "expected a depth in 0..4")
        if type(node["is_seed"]) is not bool:
            _fail(f"{path}.is_seed", "expected a boolean")
        if node["is_seed"] != (node["depth"] == 0):
            _fail(f"{path}.is_seed", "must correspond to depth == 0")
        _text(node["evidence"], f"{path}.evidence", 200)
        _strings(node["limitations"], f"{path}.limitations")
        metrics = node["metrics"]
        _object(metrics, "metrics", f"{path}.metrics")
        for key in ("in_degree", "out_degree", "n_tx_in", "n_tx_out"):
            _integer(metrics[key], f"{path}.metrics.{key}", 0)
        for key in ("in_sum_kzt", "out_sum_kzt"):
            _money(metrics[key], f"{path}.metrics.{key}")
        if metrics["out_in_ratio"] is not None:
            _number(metrics["out_in_ratio"], f"{path}.metrics.out_in_ratio")
        nodes[node["gid"]] = node
        members[node["cluster_id"]].append(node)

    clusters = {}
    for index, cluster in enumerate(snapshot["clusters"]):
        path = f"clusters[{index}]"
        _object(cluster, "cluster", path)
        cluster_id = cluster["cluster_id"]
        _integer(cluster_id, f"{path}.cluster_id")
        if cluster_id in clusters:
            _fail(path, "duplicate cluster")
        _integer(cluster["n_nodes"], f"{path}.n_nodes", 0)
        _integer(cluster["n_seed"], f"{path}.n_seed", 0)
        _money(cluster["sum_kzt_internal"], f"{path}.sum_kzt_internal")
        _text(cluster["hypothesis"], f"{path}.hypothesis")
        _array(cluster["top_gids"], f"{path}.top_gids")
        top_gids = set()
        for gid in cluster["top_gids"]:
            _gid(gid, f"{path}.top_gids")
            if gid in top_gids or gid not in nodes or nodes[gid]["cluster_id"] != cluster_id:
                _fail(f"{path}.top_gids", "duplicate gid or gid outside this cluster")
            top_gids.add(gid)
        clusters[cluster_id] = cluster
    _same(set(clusters), set(members), "clusters coverage")

    # Each pair is already aggregated. Its amount and transaction count contribute
    # exactly once to each end, and once to its cluster only for an internal edge.
    totals = {gid: {"incoming": set(), "outgoing": set(), "in_sum": Fraction(0),
                    "out_sum": Fraction(0), "n_tx_in": 0, "n_tx_out": 0}
              for gid in nodes}
    internal = defaultdict(Fraction)
    pairs = set()
    n_transactions = 0
    for index, edge in enumerate(snapshot["edges"]):
        path = f"edges[{index}]"
        _object(edge, "edge", path)
        for key in ("src", "dst"):
            _gid(edge[key], f"{path}.{key}")
            if edge[key] not in nodes:
                _fail(f"{path}.{key}", "unknown node")
        pair = (edge["src"], edge["dst"])
        if pair in pairs:
            _fail(path, "duplicate aggregated edge")
        pairs.add(pair)
        _integer(edge["n_tx"], f"{path}.n_tx", 1)
        _integer(edge["depth"], f"{path}.depth", 1)
        if edge["depth"] > 4:
            _fail(f"{path}.depth", "expected a depth in 1..4")
        amount = _money(edge["sum_kzt"], f"{path}.sum_kzt", positive=True)
        source, target = totals[edge["src"]], totals[edge["dst"]]
        source["outgoing"].add(edge["dst"])
        source["out_sum"] += amount
        source["n_tx_out"] += edge["n_tx"]
        target["incoming"].add(edge["src"])
        target["in_sum"] += amount
        target["n_tx_in"] += edge["n_tx"]
        n_transactions += edge["n_tx"]
        cluster_id = nodes[edge["src"]]["cluster_id"]
        if cluster_id == nodes[edge["dst"]]["cluster_id"]:
            internal[cluster_id] += amount

    for gid, node in nodes.items():
        path = f"node[{gid}].metrics"
        metrics, total = node["metrics"], totals[gid]
        _same(metrics["in_degree"], len(total["incoming"]), f"{path}.in_degree")
        _same(metrics["out_degree"], len(total["outgoing"]), f"{path}.out_degree")
        for key in ("n_tx_in", "n_tx_out"):
            _same(metrics[key], total[key], f"{path}.{key}")
        for field, aggregate in (("in_sum_kzt", "in_sum"), ("out_sum_kzt", "out_sum")):
            _same(_money(metrics[field], f"{path}.{field}"), total[aggregate], f"{path}.{field}")
        ratio = metrics["out_in_ratio"]
        if total["in_sum"] == 0:
            if ratio is not None:
                _fail(f"{path}.out_in_ratio", "must be null for zero observed inflow")
        else:
            if ratio is None:
                _fail(f"{path}.out_in_ratio", "must be numeric for nonzero observed inflow")
            try:
                expected = float(total["out_sum"] / total["in_sum"])
            except OverflowError:
                _fail(f"{path}.out_in_ratio", "ratio cannot be represented by a finite JSON number")
            if not math.isfinite(expected) or not math.isclose(ratio, expected, rel_tol=1e-12, abs_tol=1e-12):
                _fail(f"{path}.out_in_ratio", "does not equal observed outflow / inflow")

    for cluster_id, cluster in clusters.items():
        path = f"cluster[{cluster_id}]"
        cluster_nodes = members[cluster_id]
        _same(cluster["n_nodes"], len(cluster_nodes), f"{path}.n_nodes")
        _same(cluster["n_seed"], sum(node["is_seed"] for node in cluster_nodes), f"{path}.n_seed")
        _same(_money(cluster["sum_kzt_internal"], f"{path}.sum_kzt_internal"),
              internal[cluster_id], f"{path}.sum_kzt_internal")
        representatives = cluster["top_gids"]
        if not 1 <= len(representatives) <= min(DEFAULT_CONFIG.cluster_top_count, len(cluster_nodes)):
            _fail(f"{path}.top_gids", f"expected a nonempty prefix of up to {DEFAULT_CONFIG.cluster_top_count} representatives")
        ordered_members = sorted(cluster_nodes, key=lambda node: (-node["priority_score"], int(node["gid"])))
        _same(representatives, [node["gid"] for node in ordered_members[:len(representatives)]],
              f"{path}.top_gids priority order")

    _same(metadata["n_nodes"], len(nodes), "metadata.n_nodes")
    _same(metadata["n_edges"], len(pairs), "metadata.n_edges")
    _same(metadata["n_seeds"], sum(node["is_seed"] for node in nodes.values()), "metadata.n_seeds")
    _same(metadata["n_transactions"], n_transactions, "metadata.n_transactions")

    ranking = snapshot["top_nodes"]
    if not min(20, len(nodes)) <= len(ranking) <= len(nodes):
        _fail("top_nodes", "expected at least min(20, n_nodes) and no more than n_nodes entries")
    expected_top = sorted(nodes.values(), key=lambda node: (-node["priority_score"], int(node["gid"])))
    seen = set()
    for index, row in enumerate(ranking):
        path = f"top_nodes[{index}]"
        _object(row, "top_node", path)
        _integer(row["rank"], f"{path}.rank", 1)
        _same(row["rank"], index + 1, f"{path}.rank")
        _gid(row["gid"], f"{path}.gid")
        if row["gid"] in seen or row["gid"] not in nodes:
            _fail(f"{path}.gid", "duplicate or unknown node")
        seen.add(row["gid"])
        _role(row["role"], f"{path}.role")
        _number(row["priority_score"], f"{path}.priority_score", 0, 1)
        _text(row["why"], f"{path}.why")
        node = nodes[row["gid"]]
        _same(row["role"], node["role"], f"{path}.role")
        _same(row["priority_score"], node["priority_score"], f"{path}.priority_score")
        _same(row["gid"], expected_top[index]["gid"], f"{path}.priority order")


def _csv_rows(snapshot, filename):
    """Project the same validated records to the exact ordered CSV fields."""
    for record in snapshot[_CSV_SOURCES[filename]]:
        yield {key: (json.dumps(record[key], ensure_ascii=False, allow_nan=False)
                     if key == "top_gids" else str(record[key]))
               for key in CSV_COLUMNS[filename]}


def _check_target(target):
    if target.is_symlink():
        _fail("output_dir", "symlinks are not allowed")
    if target.exists() and (not target.is_dir() or any(target.iterdir())):
        _fail("output_dir", "must be absent or an empty directory; existing results are never overwritten")


def _verify_files(snapshot, directory):
    with (directory / "analysis.json").open(encoding="utf-8") as handle:
        restored = json.load(handle)
    validate_snapshot(restored)
    _same(restored, snapshot, "analysis.json readback")
    for filename, columns in CSV_COLUMNS.items():
        with (directory / filename).open(encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            if getattr(reader, "fieldnames", None) != list(columns):
                _fail(filename, "CSV readback header mismatch")
            _same(list(reader), list(_csv_rows(restored, filename)), f"{filename} readback")


def write_outputs(snapshot: dict, output_dir: Path) -> None:
    """Publish checked JSON and three CSV files, never replacing previous output.

Files are first written and read back in a fresh sibling directory on the same
filesystem. A POSIX directory rename publishes all four together; an existing
empty target is supported, but a nonempty directory, file or symlink is refused.
The temporary directory is removed on failure, never the requested destination.
    """
    validate_snapshot(snapshot)
    target = Path(output_dir).absolute()
    temporary = None
    try:
        _check_target(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}-", dir=target.parent))
        with (temporary / "analysis.json").open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(snapshot, handle, ensure_ascii=False, allow_nan=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        for filename, columns in CSV_COLUMNS.items():
            with (temporary / filename).open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=columns)
                writer.writeheader()
                writer.writerows(_csv_rows(snapshot, filename))
                handle.flush()
                os.fsync(handle.fileno())
        _verify_files(snapshot, temporary)
        _check_target(target)
        os.rename(temporary, target)
        temporary = None
    except (OSError, UnicodeError, csv.Error, json.JSONDecodeError) as error:
        raise OutputError(f"Cannot publish output files: {error}") from error
    finally:
        if temporary is not None:
            shutil.rmtree(temporary)
