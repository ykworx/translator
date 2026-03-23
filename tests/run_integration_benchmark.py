#!/usr/bin/env python3
"""
Integration benchmark: feeds WAV files through the Tauri app's benchmark command
and collects WER/CER + per-stage timing results.

Usage:
    # Requires the Tauri app to be running with benchmark commands registered
    python run_integration_benchmark.py [--manifest fixtures/japanese/manifest.json]
                                         [--app-url http://localhost:1420]
                                         [--output results/]
                                         [--compare results/previous.json]

The script communicates with the running Tauri app via its IPC mechanism.
For CLI usage without a running app, it falls back to invoking the built binary directly.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

DEFAULT_MANIFEST = Path(__file__).parent / "fixtures" / "japanese" / "manifest.json"
DEFAULT_OUTPUT_DIR = Path(__file__).parent / "results"

# Reuse WER/CER computation from benchmark_wer.py
sys.path.insert(0, str(Path(__file__).parent))
from benchmark_wer import compute_error_rate, normalize_japanese


@dataclass
class IntegrationResult:
    filename: str
    reference: str
    hypothesis: str
    wer: float
    cer: float
    audio_duration_ms: float
    total_processing_ms: float
    rtf: float
    performance_stages: dict = field(default_factory=dict)
    timed_out: bool = False


@dataclass
class IntegrationSummary:
    timestamp: str = ""
    results: list = field(default_factory=list)
    avg_wer: float = 0.0
    avg_cer: float = 0.0
    avg_rtf: float = 0.0
    total_audio_ms: float = 0.0
    total_processing_ms: float = 0.0
    aggregated_stages: dict = field(default_factory=dict)


def run_benchmark_via_binary(binary_path: str, wav_path: str) -> dict:
    """
    Invoke the Tauri app binary with a special benchmark flag.
    Falls back to using the Tauri command via tauri-cli if available.
    """
    # Try direct binary invocation with env var
    env = os.environ.copy()
    env["WHISPER_PERF_TRACK"] = "1"
    env["TRANSRATOR_BENCHMARK_WAV"] = str(wav_path)

    try:
        result = subprocess.run(
            [binary_path, "--benchmark-wav", str(wav_path)],
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        pass

    return {"error": f"Failed to invoke benchmark for {wav_path}"}


def aggregate_stages(results: list[IntegrationResult]) -> dict:
    """Aggregate per-stage timing stats across all benchmark runs."""
    stage_data: dict[str, list[float]] = {}

    for result in results:
        stages = result.performance_stages.get("stages", {})
        for stage_name, stats in stages.items():
            if stage_name not in stage_data:
                stage_data[stage_name] = []
            if isinstance(stats, dict) and "avg_ms" in stats:
                stage_data[stage_name].append(stats["avg_ms"])

    aggregated = {}
    for stage_name, values in stage_data.items():
        if values:
            aggregated[stage_name] = {
                "avg_ms": round(sum(values) / len(values), 2),
                "min_ms": round(min(values), 2),
                "max_ms": round(max(values), 2),
                "num_runs": len(values),
            }

    return aggregated


def compare_results(current: dict, previous: dict) -> dict:
    """Compare current benchmark results with previous run."""
    comparison = {
        "timestamp_current": current.get("timestamp", ""),
        "timestamp_previous": previous.get("timestamp", ""),
        "changes": {},
    }

    curr_summary = current.get("summary", {})
    prev_summary = previous.get("summary", {})

    for metric in ["avg_wer", "avg_cer", "avg_rtf"]:
        curr_val = curr_summary.get(metric, 0)
        prev_val = prev_summary.get(metric, 0)
        if prev_val > 0:
            pct_change = ((curr_val - prev_val) / prev_val) * 100
        else:
            pct_change = 0

        comparison["changes"][metric] = {
            "current": round(curr_val, 4),
            "previous": round(prev_val, 4),
            "change_pct": round(pct_change, 1),
            "improved": curr_val < prev_val,
        }

    # Compare per-stage timing
    curr_stages = current.get("aggregated_stages", {})
    prev_stages = previous.get("aggregated_stages", {})
    stage_changes = {}

    for stage in set(list(curr_stages.keys()) + list(prev_stages.keys())):
        curr_avg = curr_stages.get(stage, {}).get("avg_ms", 0)
        prev_avg = prev_stages.get(stage, {}).get("avg_ms", 0)
        if prev_avg > 0:
            pct = ((curr_avg - prev_avg) / prev_avg) * 100
        else:
            pct = 0

        stage_changes[stage] = {
            "current_avg_ms": curr_avg,
            "previous_avg_ms": prev_avg,
            "change_pct": round(pct, 1),
            "improved": curr_avg < prev_avg,
        }

    comparison["stage_changes"] = stage_changes
    return comparison


def run_integration_benchmark(
    manifest_path: Path,
    binary_path: str | None = None,
) -> IntegrationSummary:
    """Run the integration benchmark on all samples in the manifest."""

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    samples = manifest["samples"]
    fixture_dir = manifest_path.parent

    summary = IntegrationSummary(timestamp=datetime.now().isoformat())

    print(f"\n{'='*70}")
    print(f"Integration Benchmark — {len(samples)} samples")
    print(f"{'='*70}\n")
    print(f"{'File':<25} {'WER':>8} {'CER':>8} {'Process':>10} {'RTF':>8}")
    print("-" * 65)

    for sample in samples:
        wav_path = fixture_dir / sample["filename"]
        reference = sample["transcript"]

        if not wav_path.exists():
            print(f"  SKIP: {wav_path} not found")
            continue

        # Run benchmark via binary
        if binary_path:
            bench_result = run_benchmark_via_binary(binary_path, str(wav_path))
        else:
            # If no binary specified, just record the file info
            bench_result = {"error": "No binary path provided. Use --binary flag."}

        if "error" in bench_result:
            print(f"  ERROR: {sample['filename']} — {bench_result['error']}")
            continue

        hypothesis = bench_result.get("hypothesis", "")
        audio_ms = bench_result.get("audio_duration_ms", sample["duration_sec"] * 1000)
        proc_ms = bench_result.get("total_processing_ms", 0)
        rtf = bench_result.get("rtf", 0)
        timed_out = bench_result.get("timed_out", False)

        wer, cer = compute_error_rate(reference, hypothesis)

        result = IntegrationResult(
            filename=sample["filename"],
            reference=reference,
            hypothesis=hypothesis,
            wer=wer,
            cer=cer,
            audio_duration_ms=audio_ms,
            total_processing_ms=proc_ms,
            rtf=rtf,
            performance_stages=bench_result.get("performance", {}),
            timed_out=timed_out,
        )
        summary.results.append(result)

        timeout_marker = " [TIMEOUT]" if timed_out else ""
        print(
            f"{sample['filename']:<25} {wer:>7.1%} {cer:>7.1%} "
            f"{proc_ms:>8.0f}ms {rtf:>7.2f}x{timeout_marker}"
        )

    # Compute summary
    if summary.results:
        n = len(summary.results)
        summary.avg_wer = sum(r.wer for r in summary.results) / n
        summary.avg_cer = sum(r.cer for r in summary.results) / n
        summary.avg_rtf = sum(r.rtf for r in summary.results) / n
        summary.total_audio_ms = sum(r.audio_duration_ms for r in summary.results)
        summary.total_processing_ms = sum(r.total_processing_ms for r in summary.results)
        summary.aggregated_stages = aggregate_stages(summary.results)

    return summary


def print_integration_summary(summary: IntegrationSummary):
    """Print formatted integration benchmark summary."""
    print(f"\n{'='*70}")
    print("INTEGRATION BENCHMARK SUMMARY")
    print(f"{'='*70}")
    print(f"  Timestamp:         {summary.timestamp}")
    print(f"  Samples:           {len(summary.results)}")
    print(f"  Total audio:       {summary.total_audio_ms/1000:.1f}s")
    print(f"  Total processing:  {summary.total_processing_ms/1000:.1f}s")
    print(f"  Avg WER:           {summary.avg_wer:.1%}")
    print(f"  Avg CER:           {summary.avg_cer:.1%}")
    print(f"  Avg RTF:           {summary.avg_rtf:.3f}x")

    if summary.aggregated_stages:
        print(f"\n  Per-Stage Timing (avg across runs):")
        print(f"  {'Stage':<35} {'Avg ms':>10} {'Min ms':>10} {'Max ms':>10}")
        print(f"  {'-'*65}")
        for stage, stats in sorted(summary.aggregated_stages.items()):
            print(
                f"  {stage:<35} {stats['avg_ms']:>10.2f} "
                f"{stats['min_ms']:>10.2f} {stats['max_ms']:>10.2f}"
            )

    print(f"{'='*70}")


def save_integration_results(summary: IntegrationSummary, output_dir: Path):
    """Save integration benchmark results to JSON."""
    output_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = output_dir / f"benchmark_{timestamp}.json"
    latest_path = output_dir / "latest.json"

    data = {
        "timestamp": summary.timestamp,
        "summary": {
            "num_samples": len(summary.results),
            "total_audio_ms": round(summary.total_audio_ms, 2),
            "total_processing_ms": round(summary.total_processing_ms, 2),
            "avg_wer": round(summary.avg_wer, 4),
            "avg_cer": round(summary.avg_cer, 4),
            "avg_rtf": round(summary.avg_rtf, 4),
        },
        "aggregated_stages": summary.aggregated_stages,
        "results": [
            {
                "filename": r.filename,
                "reference": r.reference,
                "hypothesis": r.hypothesis,
                "wer": round(r.wer, 4),
                "cer": round(r.cer, 4),
                "audio_duration_ms": r.audio_duration_ms,
                "total_processing_ms": round(r.total_processing_ms, 2),
                "rtf": round(r.rtf, 4),
                "timed_out": r.timed_out,
                "performance_stages": r.performance_stages,
            }
            for r in summary.results
        ],
    }

    for path in [output_path, latest_path]:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nResults saved to {output_path}")
    print(f"Latest symlink: {latest_path}")
    return data


def main():
    parser = argparse.ArgumentParser(
        description="Integration benchmark for Transrator Whisper engine"
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="Path to manifest.json",
    )
    parser.add_argument(
        "--binary",
        type=str,
        default=None,
        help="Path to the built Tauri app binary",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Output directory for results",
    )
    parser.add_argument(
        "--compare",
        type=Path,
        default=None,
        help="Path to previous results JSON for comparison",
    )
    parser.add_argument(
        "--wer-threshold",
        type=float,
        default=0.5,
        help="Maximum acceptable WER (default: 0.5 = 50%%)",
    )
    parser.add_argument(
        "--rtf-threshold",
        type=float,
        default=1.0,
        help="Maximum acceptable RTF (default: 1.0 = real-time)",
    )
    args = parser.parse_args()

    if not args.manifest.exists():
        print(f"Error: Manifest not found: {args.manifest}")
        print("Run download_japanese_samples.py first.")
        sys.exit(1)

    summary = run_integration_benchmark(args.manifest, binary_path=args.binary)
    print_integration_summary(summary)

    current_data = save_integration_results(summary, args.output)

    # Compare with previous results
    if args.compare and args.compare.exists():
        with open(args.compare, "r", encoding="utf-8") as f:
            previous_data = json.load(f)
        comparison = compare_results(current_data, previous_data)

        print(f"\n{'='*70}")
        print("COMPARISON WITH PREVIOUS RUN")
        print(f"{'='*70}")
        for metric, change in comparison["changes"].items():
            direction = "improved" if change["improved"] else "REGRESSED"
            print(
                f"  {metric:<15} {change['previous']:.4f} → {change['current']:.4f} "
                f"({change['change_pct']:+.1f}%) [{direction}]"
            )

        if comparison.get("stage_changes"):
            print(f"\n  Stage timing changes:")
            for stage, change in sorted(comparison["stage_changes"].items()):
                direction = "faster" if change["improved"] else "SLOWER"
                print(
                    f"  {stage:<35} {change['previous_avg_ms']:.2f}ms → "
                    f"{change['current_avg_ms']:.2f}ms ({change['change_pct']:+.1f}%) [{direction}]"
                )
        print(f"{'='*70}")

    # Pass/fail judgment
    passed = True
    if summary.avg_wer > args.wer_threshold:
        print(f"\nFAIL: WER {summary.avg_wer:.1%} exceeds threshold {args.wer_threshold:.1%}")
        passed = False
    if summary.avg_rtf > args.rtf_threshold:
        print(
            f"\nFAIL: RTF {summary.avg_rtf:.3f}x exceeds threshold {args.rtf_threshold:.1f}x"
        )
        passed = False

    if not summary.results:
        print("\nFAIL: No benchmark results collected")
        passed = False

    if passed:
        print("\nPASS: All thresholds met")

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
