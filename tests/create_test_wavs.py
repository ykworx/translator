#!/usr/bin/env python3
"""Create synthetic test WAV files for benchmarking latency and pipeline timing.
No external dependencies required (uses built-in wave module).

These files contain silence + simple tones to test:
- Pipeline latency (how fast audio is processed)
- Silence detection (VAD should detect silence quickly)
- Buffer management (various durations)
"""

import json
import math
import struct
import wave
from pathlib import Path

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "japanese"
SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit


def generate_sine_wav(filename: str, duration_sec: float, freq_hz: float = 440.0,
                      amplitude: float = 0.3, silence_prefix_sec: float = 0.0,
                      silence_suffix_sec: float = 0.5):
    """Generate a WAV file with optional silence prefix, a sine tone, and silence suffix."""
    filepath = FIXTURE_DIR / filename
    total_samples = int(duration_sec * SAMPLE_RATE)
    prefix_samples = int(silence_prefix_sec * SAMPLE_RATE)
    suffix_samples = int(silence_suffix_sec * SAMPLE_RATE)
    tone_samples = total_samples - prefix_samples - suffix_samples

    with wave.open(str(filepath), 'w') as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)

        # Silence prefix
        for _ in range(prefix_samples):
            wf.writeframes(struct.pack('<h', 0))

        # Sine tone
        for i in range(max(0, tone_samples)):
            t = i / SAMPLE_RATE
            value = amplitude * math.sin(2 * math.pi * freq_hz * t)
            sample = int(value * 32767)
            sample = max(-32768, min(32767, sample))
            wf.writeframes(struct.pack('<h', sample))

        # Silence suffix
        for _ in range(suffix_samples):
            wf.writeframes(struct.pack('<h', 0))

    return filepath


def main():
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    samples = []

    # Test case 1: Short utterance simulation (3s tone + 0.5s silence)
    generate_sine_wav("test_short_3s.wav", duration_sec=3.5, freq_hz=300,
                      silence_suffix_sec=0.5)
    samples.append({
        "filename": "test_short_3s.wav",
        "transcript": "[tone]",  # synthetic, WER not meaningful
        "duration_sec": 3.5,
        "sample_rate": SAMPLE_RATE,
        "type": "latency_test"
    })

    # Test case 2: Medium utterance (5s tone)
    generate_sine_wav("test_medium_5s.wav", duration_sec=5.5, freq_hz=440,
                      silence_suffix_sec=0.5)
    samples.append({
        "filename": "test_medium_5s.wav",
        "transcript": "[tone]",
        "duration_sec": 5.5,
        "sample_rate": SAMPLE_RATE,
        "type": "latency_test"
    })

    # Test case 3: Silence only (should finalize quickly via VAD)
    generate_sine_wav("test_silence_2s.wav", duration_sec=2.0, freq_hz=0,
                      amplitude=0.0, silence_suffix_sec=2.0)
    samples.append({
        "filename": "test_silence_2s.wav",
        "transcript": "",
        "duration_sec": 2.0,
        "sample_rate": SAMPLE_RATE,
        "type": "vad_test"
    })

    # Test case 4: Long utterance (10s)
    generate_sine_wav("test_long_10s.wav", duration_sec=10.5, freq_hz=350,
                      silence_suffix_sec=0.5)
    samples.append({
        "filename": "test_long_10s.wav",
        "transcript": "[tone]",
        "duration_sec": 10.5,
        "sample_rate": SAMPLE_RATE,
        "type": "latency_test"
    })

    # Test case 5: Short burst with silence (test rapid finalize)
    generate_sine_wav("test_burst_1s.wav", duration_sec=2.0, freq_hz=500,
                      silence_prefix_sec=0.2, silence_suffix_sec=0.8)
    samples.append({
        "filename": "test_burst_1s.wav",
        "transcript": "[tone]",
        "duration_sec": 2.0,
        "sample_rate": SAMPLE_RATE,
        "type": "latency_test"
    })

    manifest = {
        "dataset": "synthetic",
        "description": "Synthetic WAV files for pipeline latency testing",
        "num_samples": len(samples),
        "target_sample_rate": SAMPLE_RATE,
        "samples": samples
    }

    manifest_path = FIXTURE_DIR / "manifest.json"
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"Created {len(samples)} test WAV files in {FIXTURE_DIR}")
    print(f"Manifest: {manifest_path}")
    for s in samples:
        filepath = FIXTURE_DIR / s["filename"]
        print(f"  {s['filename']}: {s['duration_sec']}s ({s['type']})")


if __name__ == "__main__":
    main()
