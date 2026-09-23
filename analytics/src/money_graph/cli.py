"""CLI boundary for future analysis, with explicit scaffold status."""

from __future__ import annotations

import argparse
import importlib
import json
import platform
import sys
from collections.abc import Sequence
from pathlib import Path

from .contracts import INPUT_FILENAMES


def check_environment() -> int:
    """Import actual dependencies without pretending to perform an analysis."""
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
        "pipeline_implemented": False,
        "python": platform.python_version(),
        "dependencies": versions,
    }, sort_keys=True))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m money_graph",
        description=(
            "Money Graph CLI scaffold. The analytical pipeline is not implemented; "
            "analysis requests fail explicitly and create no output files."
        ),
        allow_abbrev=False,
    )
    parser.add_argument("--input-dir", type=Path, help="Directory containing the three input Parquet files")
    parser.add_argument("--output-dir", type=Path, help="Destination directory for the future analysis outputs")
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

    print(
        "PIPELINE_NOT_IMPLEMENTED: only the CLI scaffold is available. "
        "Parquet contents, metrics, role rules and exports are not implemented. "
        "No output files were created or modified.",
        file=sys.stderr,
    )
    return 3
