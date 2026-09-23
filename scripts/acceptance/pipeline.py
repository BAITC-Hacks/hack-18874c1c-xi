#!/usr/bin/env python3
"""Run the documented CLI twice from raw Parquet, then independently verify it."""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

from verify import SCHEMAS, VerificationError, load_json, raw_data, require, verify, write_json_new


def run_pipeline(input_dir: Path, report_dir: Path, mode: str) -> dict:
    # Fail before launching anything if an official input is absent/wrong-sized.
    raw_data(input_dir, mode)
    report_dir.mkdir(parents=True, exist_ok=True)
    reserved = [report_dir / name for name in ("cli-1", "cli-2", "pipeline.json", "cases.json", "verify-1.json", "verify-2.json")]
    require(not any(path.exists() or path.is_symlink() for path in reserved), "Use a fresh report directory; previous evidence is never overwritten")
    runs = []
    for index in (1, 2):
        output = report_dir / f"cli-{index}"
        command = [sys.executable, "-m", "money_graph", "--input-dir", str(input_dir.resolve()), "--output-dir", str(output.resolve())]
        started = time.perf_counter()
        try:
            process = subprocess.run(command, capture_output=True, text=True, timeout=300, check=False)
        except subprocess.TimeoutExpired as exc:
            raise VerificationError("Full CLI process exceeded the strict 300 second limit") from exc
        elapsed = time.perf_counter() - started
        require(process.returncode == 0, f"Full CLI failed with exit code {process.returncode}; no acceptance pass")
        require(elapsed < 300, "Full CLI process did not finish in less than 300 seconds")
        # stdout/stderr may carry input-derived text: do not publish them in reports/logs.
        summary, cases = verify(input_dir, output, mode)
        write_json_new(report_dir / f"verify-{index}.json", summary)
        runs.append({"run": index, "full_process_seconds": round(elapsed, 6), "output_directory": output.name, "verification": summary})
        if index == 1:
            write_json_new(report_dir / "cases.json", cases)
    for filename in SCHEMAS:
        require((report_dir / "cli-1" / filename).read_bytes() == (report_dir / "cli-2" / filename).read_bytes(), f"Non-deterministic CSV bytes: {filename}")
    snapshots = [copy.deepcopy(load_json(report_dir / f"cli-{index}" / "analysis.json")) for index in (1, 2)]
    for snapshot in snapshots:
        snapshot["metadata"].pop("elapsed_ms")
    require(snapshots[0] == snapshots[1], "Non-deterministic analysis.json beyond elapsed_ms")
    report = {
        "status": "passed", "mode": mode,
        "runtime": {"python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine()},
        "timing_boundary": "External wall clock around each Python CLI subprocess, including imports, all three raw Parquet reads, computation and all output writes; excludes image build/start and independent verification.",
        "runs": runs, "deterministic_csv_bytes": True, "deterministic_json_except_elapsed": True,
        "claim": "Automated data/CLI portion of M1-M5; not a substitute for browser tests, independent human README reproduction or timed human explanation.",
    }
    write_json_new(report_dir / "pipeline.json", report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--report-dir", required=True, type=Path)
    parser.add_argument("--mode", choices=("official", "generic"), default="official")
    args = parser.parse_args()
    try:
        report = run_pipeline(args.input_dir, args.report_dir, args.mode)
        print(json.dumps({"status": "passed", "mode": args.mode, "full_process_seconds": [run["full_process_seconds"] for run in report["runs"]], "counts": report["runs"][0]["verification"]["counts"], "deterministic": True}))
        return 0
    except (VerificationError, OSError, ValueError, KeyError, TypeError) as exc:
        message = str(exc) if isinstance(exc, VerificationError) else type(exc).__name__
        failure = {"status": "failed", "mode": args.mode, "error": message}
        try:
            write_json_new(args.report_dir / "pipeline.json", failure)
        except OSError:
            # Existing reports are immutable; stderr still makes failure explicit.
            pass
        print(json.dumps(failure), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
