#!/usr/bin/env python3
"""
Download Japanese audio samples from the configured Hugging Face datasets.
Saves 10 samples as 16kHz mono WAV files with a JSON manifest containing transcripts.

Usage:
    pip install datasets soundfile librosa
    python download_japanese_samples.py
"""

import json
import os
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

OUTPUT_DIR = Path(__file__).parent / "fixtures" / "japanese"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
NUM_SAMPLES = 10
TARGET_SR = 16000
MIN_DURATION = 3.0
MAX_DURATION = 20.0


def download_samples():
    """Download Japanese speech samples and save as 16kHz mono WAV."""
    # Import here so missing dependency gives a clear error
    try:
        from datasets import load_dataset
    except ImportError:
        print("Error: 'datasets' package not installed. Run: pip install datasets")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print("Loading Japanese speech dataset (streaming mode)...")
    # Try multiple datasets in order of preference
    dataset_configs = [
        ("ku-nlp/speech-bsd-hf", None, "test"),
        ("mozilla-foundation/common_voice_17_0", "ja", "test"),
    ]
    ds = None
    dataset_name = None
    for name, config, split in dataset_configs:
        try:
            print(f"  Trying {name}...")
            ds = load_dataset(name, config, split=split, streaming=True)
            dataset_name = name
            print(f"  → Loaded {name}")
            break
        except Exception as e:
            print(f"  → Failed: {e}")
            continue
    if ds is None:
        print("Error: No Japanese speech dataset available. Check HuggingFace authentication.")
        sys.exit(1)

    manifest = []
    collected = 0

    print(f"Collecting {NUM_SAMPLES} samples (duration {MIN_DURATION}-{MAX_DURATION}s)...")
    for sample in ds:
        audio = sample["audio"]
        sr = audio["sampling_rate"]
        waveform = np.array(audio["array"], dtype=np.float32)

        duration = len(waveform) / sr

        # Filter by duration
        if duration < MIN_DURATION or duration > MAX_DURATION:
            continue

        # Resample to 16kHz mono
        if sr != TARGET_SR:
            waveform = librosa.resample(waveform, orig_sr=sr, target_sr=TARGET_SR)

        # Ensure mono
        if waveform.ndim > 1:
            waveform = waveform.mean(axis=-1)

        # Normalize
        peak = np.abs(waveform).max()
        if peak > 0:
            waveform = waveform / peak * 0.95

        filename = f"ja_sample_{collected:03d}.wav"
        filepath = OUTPUT_DIR / filename

        sf.write(str(filepath), waveform, TARGET_SR, subtype="PCM_16")

        transcript = sample.get("transcription", sample.get("sentence", sample.get("raw_transcription", "")))
        actual_duration = len(waveform) / TARGET_SR

        entry = {
            "filename": filename,
            "transcript": transcript,
            "duration_sec": round(actual_duration, 2),
            "sample_rate": TARGET_SR,
        }
        manifest.append(entry)

        collected += 1
        print(f"  [{collected}/{NUM_SAMPLES}] {filename} ({actual_duration:.1f}s)")

        if collected >= NUM_SAMPLES:
            break

    if collected < NUM_SAMPLES:
        print(f"Warning: Only collected {collected}/{NUM_SAMPLES} samples matching criteria.")

    # Save manifest
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "dataset": dataset_name,
                "subset": "ja",
                "num_samples": len(manifest),
                "target_sample_rate": TARGET_SR,
                "samples": manifest,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"\nDone! {collected} samples saved to {OUTPUT_DIR}")
    print(f"Manifest written to {MANIFEST_PATH}")


if __name__ == "__main__":
    download_samples()
