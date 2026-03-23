#!/usr/bin/env python3
"""
WER (Word Error Rate) and latency benchmark for Japanese speech recognition.

Measures:
  - WER using MeCab tokenization (character-level fallback if MeCab unavailable)
  - Inference latency per sample
  - Real-time factor (RTF)

Usage:
    pip install jiwer
    python benchmark_wer.py [--manifest fixtures/japanese/manifest.json] [--whisper-model base]

The script loads each WAV file listed in the manifest, runs it through the
configured ASR system, and compares the hypothesis against the reference
transcript.

By default it uses whisper (openai-whisper) for transcription. You can also
supply a custom transcriber function.
"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

DEFAULT_MANIFEST = Path(__file__).parent / "fixtures" / "japanese" / "manifest.json"


@dataclass
class BenchmarkResult:
    filename: str
    reference: str
    hypothesis: str
    wer: float
    cer: float
    latency_sec: float
    audio_duration_sec: float
    rtf: float  # real-time factor: latency / duration


@dataclass
class BenchmarkSummary:
    results: list = field(default_factory=list)
    avg_wer: float = 0.0
    avg_cer: float = 0.0
    avg_latency_sec: float = 0.0
    avg_rtf: float = 0.0
    total_audio_sec: float = 0.0
    total_latency_sec: float = 0.0


def normalize_japanese(text: str) -> str:
    """Normalize Japanese text for WER comparison."""
    import re
    import unicodedata

    # NFKC normalize (full-width -> half-width, etc.)
    text = unicodedata.normalize("NFKC", text)
    # Remove punctuation and whitespace
    text = re.sub(r"[、。！？「」『』（）\s\.,!?\[\]()\"']+", "", text)
    # Lowercase romaji
    text = text.lower()
    return text


def tokenize_japanese(text: str) -> list[str]:
    """Tokenize Japanese text. Uses MeCab if available, else character-level."""
    text = normalize_japanese(text)
    try:
        import MeCab

        tagger = MeCab.Tagger("-Owakati")
        tokens = tagger.parse(text).strip().split()
        return tokens
    except ImportError:
        # Fallback: character-level tokenization
        return list(text)


def compute_error_rate(reference: str, hypothesis: str) -> tuple[float, float]:
    """Compute WER and CER for Japanese text."""
    # CER (Character Error Rate)
    ref_chars = list(normalize_japanese(reference))
    hyp_chars = list(normalize_japanese(hypothesis))
    cer = _levenshtein_rate(ref_chars, hyp_chars)

    # WER (Word Error Rate with Japanese tokenization)
    ref_tokens = tokenize_japanese(reference)
    hyp_tokens = tokenize_japanese(hypothesis)
    wer = _levenshtein_rate(ref_tokens, hyp_tokens)

    return wer, cer


def _levenshtein_rate(ref: list[str], hyp: list[str]) -> float:
    """Compute Levenshtein-based error rate."""
    if not ref:
        return 0.0 if not hyp else 1.0

    n = len(ref)
    m = len(hyp)
    dp = list(range(m + 1))

    for i in range(1, n + 1):
        prev = dp[0]
        dp[0] = i
        for j in range(1, m + 1):
            temp = dp[j]
            if ref[i - 1] == hyp[j - 1]:
                dp[j] = prev
            else:
                dp[j] = 1 + min(prev, dp[j], dp[j - 1])
            prev = temp

    return dp[m] / n


def create_whisper_transcriber(model_name: str = "base") -> Callable:
    """Create a transcriber function using openai-whisper."""
    try:
        import whisper
    except ImportError:
        print("Error: 'openai-whisper' not installed. Run: pip install openai-whisper")
        sys.exit(1)

    print(f"Loading Whisper model '{model_name}'...")
    model = whisper.load_model(model_name)

    def transcribe(wav_path: str) -> str:
        result = model.transcribe(wav_path, language="ja")
        return result["text"]

    return transcribe


def run_benchmark(
    manifest_path: Path,
    transcriber: Optional[Callable] = None,
    whisper_model: str = "base",
) -> BenchmarkSummary:
    """Run WER/latency benchmark on all samples in the manifest."""
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    samples = manifest["samples"]
    fixture_dir = manifest_path.parent

    if transcriber is None:
        transcriber = create_whisper_transcriber(whisper_model)

    summary = BenchmarkSummary()

    print(f"\nRunning benchmark on {len(samples)} samples...\n")
    print(f"{'File':<25} {'WER':>8} {'CER':>8} {'Latency':>10} {'RTF':>8}")
    print("-" * 65)

    for sample in samples:
        wav_path = fixture_dir / sample["filename"]
        reference = sample["transcript"]
        duration = sample["duration_sec"]

        if not wav_path.exists():
            print(f"  SKIP: {wav_path} not found")
            continue

        # Measure transcription latency
        t0 = time.perf_counter()
        hypothesis = transcriber(str(wav_path))
        latency = time.perf_counter() - t0

        wer, cer = compute_error_rate(reference, hypothesis)
        rtf = latency / duration if duration > 0 else 0.0

        result = BenchmarkResult(
            filename=sample["filename"],
            reference=reference,
            hypothesis=hypothesis,
            wer=wer,
            cer=cer,
            latency_sec=round(latency, 3),
            audio_duration_sec=duration,
            rtf=round(rtf, 3),
        )
        summary.results.append(result)

        print(
            f"{sample['filename']:<25} {wer:>7.1%} {cer:>7.1%} {latency:>9.3f}s {rtf:>7.2f}x"
        )

    if summary.results:
        n = len(summary.results)
        summary.avg_wer = sum(r.wer for r in summary.results) / n
        summary.avg_cer = sum(r.cer for r in summary.results) / n
        summary.avg_latency_sec = sum(r.latency_sec for r in summary.results) / n
        summary.avg_rtf = sum(r.rtf for r in summary.results) / n
        summary.total_audio_sec = sum(r.audio_duration_sec for r in summary.results)
        summary.total_latency_sec = sum(r.latency_sec for r in summary.results)

    return summary


def print_summary(summary: BenchmarkSummary):
    """Print benchmark summary."""
    print("\n" + "=" * 65)
    print("BENCHMARK SUMMARY")
    print("=" * 65)
    print(f"  Samples:          {len(summary.results)}")
    print(f"  Total audio:      {summary.total_audio_sec:.1f}s")
    print(f"  Total latency:    {summary.total_latency_sec:.1f}s")
    print(f"  Avg WER:          {summary.avg_wer:.1%}")
    print(f"  Avg CER:          {summary.avg_cer:.1%}")
    print(f"  Avg latency:      {summary.avg_latency_sec:.3f}s")
    print(f"  Avg RTF:          {summary.avg_rtf:.2f}x")
    print("=" * 65)


def save_results(summary: BenchmarkSummary, output_path: Path):
    """Save detailed results to JSON."""
    data = {
        "summary": {
            "num_samples": len(summary.results),
            "total_audio_sec": summary.total_audio_sec,
            "total_latency_sec": summary.total_latency_sec,
            "avg_wer": round(summary.avg_wer, 4),
            "avg_cer": round(summary.avg_cer, 4),
            "avg_latency_sec": round(summary.avg_latency_sec, 4),
            "avg_rtf": round(summary.avg_rtf, 4),
        },
        "results": [
            {
                "filename": r.filename,
                "reference": r.reference,
                "hypothesis": r.hypothesis,
                "wer": round(r.wer, 4),
                "cer": round(r.cer, 4),
                "latency_sec": r.latency_sec,
                "audio_duration_sec": r.audio_duration_sec,
                "rtf": r.rtf,
            }
            for r in summary.results
        ],
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nResults saved to {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Japanese ASR WER/Latency Benchmark")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="Path to manifest.json",
    )
    parser.add_argument(
        "--whisper-model",
        type=str,
        default="base",
        help="Whisper model size (tiny, base, small, medium, large)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Output path for detailed results JSON",
    )
    args = parser.parse_args()

    if not args.manifest.exists():
        print(f"Error: Manifest not found: {args.manifest}")
        print("Run download_japanese_samples.py first.")
        sys.exit(1)

    summary = run_benchmark(args.manifest, whisper_model=args.whisper_model)
    print_summary(summary)

    output_path = args.output or args.manifest.parent / "benchmark_results.json"
    save_results(summary, output_path)


if __name__ == "__main__":
    main()
