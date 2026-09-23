"""Independent batch CLI: validated Parquet to complete CSV/JSON artifacts."""

from __future__ import annotations

import argparse
import importlib
import json
import platform
import sys
from time import perf_counter
from collections.abc import Sequence
from pathlib import Path

from .contracts import INPUT_FILENAMES


def check_environment() -> int:
    """Import actual dependencies; this is not a data acceptance test."""
    versions: dict[str, str] = {}
    for name in ("pandas", "pyarrow", "networkx"):
        try:
            module = importlib.import_module(name)
        except (ImportError, OSError) as exc:
            print(f"DEPENDENCY_IMPORT_FAILED: {name}: {exc}", file=sys.stderr)
            return 4
        versions[name] = module.__version__

    print(json.dumps({
        "status": "environment_ready",
        "pipeline_implemented": True,
        "python": platform.python_version(),
        "dependencies": versions,
    }, sort_keys=True))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m money_graph",
        description=(
            "Money Graph: validate Parquet, calculate explainable roles and clusters, "
            "and write three CSV files plus analysis.json."
        ),
        allow_abbrev=False,
    )
    parser.add_argument("--input-dir", type=Path, help="Directory containing the three input Parquet files")
    parser.add_argument("--output-dir", type=Path, help="New or empty directory for analysis outputs; existing results are never overwritten")
    parser.add_argument(
        "--check-environment", action="store_true",
        help="Import analytics dependencies and print their versions; does not run analysis",
    )
    args = parser.parse_args(argv)

    if args.check_environment:
        if args.input_dir is not None or args.output_dir is not None:
            parser.error("--check-environment cannot be combined with analysis paths")
        return check_environment()

    if args.input_dir is None or args.output_dir is None:
        parser.error("analysis requires both --input-dir and --output-dir")

    missing = [name for name in INPUT_FILENAMES if not (args.input_dir / name).is_file()]
    if missing:
        print(
            "INPUT_FILES_MISSING: required regular files not found: " + ", ".join(missing),
            file=sys.stderr,
        )
        return 2

    try:
        from .analysis import analyze
        from .input_data import InputError, load_inputs
        from .output import OutputError, validate_snapshot, write_outputs
    except (ImportError, OSError) as exc:
        print(f"DEPENDENCY_IMPORT_FAILED: {exc}", file=sys.stderr)
        return 4

    started = perf_counter()
    try:
        data = load_inputs(args.input_dir)
        snapshot = analyze(data)
        if {int(node["gid"]) for node in snapshot["nodes"]} != {node["gid"] for node in data.nodes}:
            raise OutputError("Набор gid результата не совпадает с исходным nodes.parquet")
        for key, expected in (("n_nodes", len(data.nodes)), ("n_edges", len(data.edges)), ("n_transactions", len(data.transactions))):
            if snapshot["metadata"][key] != expected:
                raise OutputError(f"{key} результата не совпадает с исходными файлами")
        validate_snapshot(snapshot)
        snapshot["metadata"]["elapsed_ms"] = round((perf_counter() - started) * 1000, 3)
        write_outputs(snapshot, args.output_dir)
    except InputError as exc:
        print(f"INPUT_INVALID: {exc}", file=sys.stderr)
        return 3
    except (OutputError, OSError) as exc:
        print(f"OUTPUT_FAILED: {exc}", file=sys.stderr)
        return 5
    except Exception as exc:
        # No success marker or published partial result on a computation failure.
        print(f"ANALYSIS_FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 6

    print(json.dumps({
        "status": "completed", "n_nodes": len(snapshot["nodes"]),
        "n_clusters": len(snapshot["clusters"]), "n_top_nodes": len(snapshot["top_nodes"]),
        "total_ms": round((perf_counter() - started) * 1000, 3),
        "files": ["nodes_roles.csv", "clusters.csv", "top_nodes.csv", "analysis.json"],
    }, ensure_ascii=False, allow_nan=False))
    return 0
