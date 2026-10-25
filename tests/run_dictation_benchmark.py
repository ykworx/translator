#!/usr/bin/env python3
"""Offline WAV checks for the native Whisper dictation path (Python stdlib only).

This launches a fresh CLI process per sample. Wall time includes model loading;
native processing time does not. It does not capture the microphone, contact a
service, or exercise Accessibility/clipboard insertion into other applications.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
import unicodedata
import wave

PROJECT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = PROJECT_DIR / "tests/fixtures/japanese/manifest.json"
DEFAULT_BINARY = PROJECT_DIR / "src-tauri/target/debug/tauri-app"


def normalize(text: str) -> str:
    """Ignore Unicode width, case, spaces and punctuation, retaining letters/digits."""
    return "".join(
        char for char in unicodedata.normalize("NFKC", text).casefold()
        if not char.isspace() and not unicodedata.category(char).startswith("P")
    )


def edit_distance(reference: str, hypothesis: str) -> int:
    previous = list(range(len(hypothesis) + 1))
    for row, expected in enumerate(reference, 1):
        current = [row]
        for column, actual in enumerate(hypothesis, 1):
            current.append(min(
                current[-1] + 1, previous[column] + 1,
                previous[column - 1] + (expected != actual),
            ))
        previous = current
    return previous[-1]


def parse_payload(stdout: str) -> dict:
    """Accept the benchmark object, even when native startup logs precede it."""
    decoder = json.JSONDecoder()
    for offset, char in enumerate(stdout):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(stdout[offset:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and ("hypothesis" in value or "error" in value):
            return value
    raise ValueError("CLI output did not contain a benchmark JSON object")


def positive_number(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return number


def finite_metric(payload: dict, name: str) -> float:
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"invalid or missing {name}")
    return float(value)


def repeat_wav(source: Path, destination: Path, repetitions: int) -> None:
    """Repeat local PCM audio with a 400ms silent gap; no synthesis/network needed."""
    with wave.open(str(source), "rb") as audio:
        params = audio.getparams()
        frames = audio.readframes(audio.getnframes())
    # Unsigned 8-bit PCM uses 128 for silence; all other PCM widths use zero.
    silence_byte = b"\x80" if params.sampwidth == 1 else b"\x00"
    gap = silence_byte * (int(params.framerate * 0.4) * params.nchannels * params.sampwidth)
    with wave.open(str(destination), "wb") as audio:
        audio.setparams(params)
        for index in range(repetitions):
            if index:
                audio.writeframesraw(gap)
            audio.writeframesraw(frames)


def save_diagnostics(directory: Path | None, stem: str, stdout: str | bytes,
                     stderr: str | bytes) -> dict:
    if directory is None:
        return {}
    directory.mkdir(parents=True, exist_ok=True)
    paths = {}
    for label, content in (("stdout", stdout), ("stderr", stderr)):
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                         prefix=f"{stem}-", suffix=f".{label}", delete=False) as output:
            output.write(content or "")
            paths[f"{label}_path"] = output.name
    return paths


def run_case(binary: Path, audio: Path, reference: str, language: str,
             timeout: float, model: Path | None = None, repetitions: int = 1,
             diagnostics_dir: Path | None = None) -> dict:
    expected = normalize(reference) * repetitions
    result = {
        "filename": audio.name, "language": language, "reference": reference,
        "audio_repetitions": repetitions, "hypothesis": "", "status": "pending",
        "reference_characters": len(expected), "character_errors": None, "cer": None,
        "wall_ms": None, "native_processing_ms": None, "audio_duration_ms": None,
        "native_rtf": None, "empty_result": None, "timed_out": False,
    }
    if not audio.is_file():
        result.update(status="missing_audio", wall_ms=0.0, error="audio file not found")
        return result
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="transrator-dictation-audio-") as temp:
            input_audio = audio
            if repetitions > 1:
                input_audio = Path(temp) / "repeated.wav"
                repeat_wav(audio, input_audio, repetitions)
            command = [str(binary), "--benchmark-wav", str(input_audio), "--language", language, "--dictation"]
            if model:
                command.extend(["--model", str(model)])
            process = subprocess.run(command, capture_output=True, text=True,
                                     errors="replace", timeout=timeout, check=False)
        result.update(save_diagnostics(diagnostics_dir, audio.stem, process.stdout, process.stderr))
        result["wall_ms"] = round((time.monotonic() - started) * 1000, 2)
        if process.returncode:
            result.update(status="process_error", exit_code=process.returncode,
                          error=process.stderr[-2000:].strip() or "benchmark process failed")
            return result
        payload = parse_payload(process.stdout)
        if "error" in payload:
            result.update(status="process_error", error=str(payload["error"]))
            return result
        hypothesis = payload.get("hypothesis")
        if not isinstance(hypothesis, str):
            raise ValueError("hypothesis must be a string")
        if finite_metric(payload, "audio_duration_ms") <= 0:
            raise ValueError("audio_duration_ms must be positive")
        actual = normalize(hypothesis)
        errors = edit_distance(expected, actual)
        result.update(
            hypothesis=hypothesis, empty_result=not actual,
            character_errors=errors, cer=errors / len(expected) if expected else None,
            native_processing_ms=finite_metric(payload, "total_processing_ms"),
            audio_duration_ms=finite_metric(payload, "audio_duration_ms"),
            native_rtf=finite_metric(payload, "rtf"), timed_out=payload.get("timed_out") is True,
            status="ok",
        )
        if result["timed_out"]:
            result["status"] = "timeout"
        elif expected and not actual:
            result["status"] = "empty_result"
        elif not expected and actual:
            result["status"] = "unexpected_text"
        if repetitions > 1:
            phrase = normalize(reference)
            result["repetition_observation"] = {
                "expected_phrase_count": repetitions,
                "exact_phrase_count": actual.count(phrase) if phrase else 0,
                "note": "Exact matches only; recognition substitutions can reduce this count.",
            }
    except subprocess.TimeoutExpired as error:
        result.update(save_diagnostics(diagnostics_dir, audio.stem, error.stdout or "", error.stderr or ""))
        result.update(status="timeout", timed_out=True, error=f"process exceeded {timeout:g}s")
    except (OSError, ValueError, wave.Error) as error:
        result.update(status="invalid_result", error=str(error))
    finally:
        if result["wall_ms"] is None:
            result["wall_ms"] = round((time.monotonic() - started) * 1000, 2)
    return result


def summarize(results: list[dict]) -> dict:
    measured = [row for row in results if row["character_errors"] is not None]
    speech = [row for row in measured if row["reference_characters"]]
    reference_characters = sum(row["reference_characters"] for row in speech)
    errors = sum(row["character_errors"] for row in speech)
    processing = [row["native_processing_ms"] for row in measured]
    return {
        "requested_samples": len(results), "measured_samples": len(measured),
        "failed_samples": sum(row["status"] != "ok" for row in results),
        "empty_speech_results": sum(row["status"] == "empty_result" for row in results),
        "unexpected_silence_text": sum(row["status"] == "unexpected_text" for row in results),
        "timeouts": sum(row["timed_out"] for row in results),
        "micro_cer": errors / reference_characters if reference_characters else None,
        "median_native_processing_ms": statistics.median(processing) if processing else None,
        "median_wall_ms": statistics.median(row["wall_ms"] for row in results) if results else None,
        "max_native_rtf": max((row["native_rtf"] for row in measured), default=None),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--binary", type=Path, default=DEFAULT_BINARY)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--model", type=Path, help="Local model file; otherwise the native CLI default is used")
    parser.add_argument("--language", help="Override sample/manifest language; e.g. ko, ja, en or auto")
    parser.add_argument("--sample", action="append", help="Run only this filename (repeatable)")
    parser.add_argument("--limit", type=int, default=3, help="Maximum samples; 0 runs all (default: 3)")
    parser.add_argument("--repeat-audio", type=int, default=1, help="Repeat each WAV inside one session (default: 1)")
    parser.add_argument("--timeout", type=positive_number, default=90.0, help="Per-process timeout, including model load")
    parser.add_argument("--max-cer", type=float, help="Optional maximum aggregate CER (no quality threshold by default)")
    parser.add_argument("--max-rtf", type=positive_number, help="Optional maximum native real-time factor")
    parser.add_argument("--output", type=Path, default=Path(tempfile.gettempdir()) / "transrator-dictation-benchmark.json")
    parser.add_argument("--diagnostics-dir", type=Path, help="Optionally retain stdout/stderr for every native process")
    args = parser.parse_args()
    if args.limit < 0 or args.repeat_audio < 1:
        parser.error("--limit must be >= 0 and --repeat-audio must be >= 1")
    if args.max_cer is not None and (not math.isfinite(args.max_cer) or args.max_cer < 0):
        parser.error("--max-cer must be a finite non-negative number")
    try:
        binary = args.binary.expanduser().resolve(strict=True)
        manifest_path = args.manifest.expanduser().resolve(strict=True)
        model = args.model.expanduser().resolve(strict=True) if args.model else None
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        samples = manifest["samples"]
        if not isinstance(samples, list) or not all(
            isinstance(row, dict) and isinstance(row.get("filename"), str)
            and isinstance(row.get("transcript"), str) for row in samples
        ):
            raise ValueError("manifest.samples must contain filename and transcript strings")
        if args.sample:
            selected = set(args.sample)
            samples = [row for row in samples if row["filename"] in selected]
            missing = selected - {row["filename"] for row in samples}
            if missing:
                raise ValueError(f"unknown sample(s): {', '.join(sorted(missing))}")
        if args.limit:
            samples = samples[:args.limit]
        if not samples:
            raise ValueError("no samples selected")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    results = []
    for sample in samples:
        language = args.language or sample.get("language") or manifest.get("language") or "auto"
        if not isinstance(language, str):
            parser.error("sample language must be a string")
        result = run_case(binary, manifest_path.parent / sample["filename"], sample["transcript"],
                          language, args.timeout, model, args.repeat_audio, args.diagnostics_dir)
        results.append(result)
        cer = f"{result['cer']:.1%}" if result["cer"] is not None else "n/a"
        print(f"{sample['filename']}: {result['status']}, CER={cer}, wall={result['wall_ms']:.0f}ms", flush=True)
    summary = summarize(results)
    threshold_failures = []
    if args.max_cer is not None and (summary["micro_cer"] is None or summary["micro_cer"] > args.max_cer):
        threshold_failures.append("CER threshold exceeded or no measured speech")
    if args.max_rtf is not None and (summary["max_native_rtf"] is None or summary["max_native_rtf"] > args.max_rtf):
        threshold_failures.append("RTF threshold exceeded or no measured audio")
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(), "binary": str(binary),
        "manifest": str(manifest_path), "dataset": manifest.get("dataset"),
        "mode": "offline-native-dictation", "model": str(model) if model else "native-cli-default",
        "normalization": "NFKC + casefold, whitespace/punctuation removed",
        "limitations": "Fresh process per sample; wall time includes loading. No microphone, app insertion or macOS Dictation comparison.",
        "summary": summary, "threshold_failures": threshold_failures, "results": results,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Report: {args.output}")
    return 1 if summary["failed_samples"] or threshold_failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
