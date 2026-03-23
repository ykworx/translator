# Japanese ASR Test Data & Benchmarks

## Overview

Test fixtures and benchmark tools for evaluating Japanese speech recognition quality. Uses audio samples from [ReazonSpeech](https://huggingface.co/datasets/reazon-research/reazonspeech) dataset.

## Setup

```bash
pip install datasets soundfile librosa jiwer
# Optional: for Whisper-based benchmarking
pip install openai-whisper
# Optional: for proper Japanese word tokenization
pip install mecab-python3 unidic-lite
```

## 1. Download Test Samples

```bash
python download_japanese_samples.py
```

Downloads 10 Japanese audio samples (5-15s each) from ReazonSpeech, converts to 16kHz mono WAV, and creates `fixtures/japanese/manifest.json` with transcripts.

**Output structure:**
```
fixtures/japanese/
├── manifest.json          # Sample metadata + reference transcripts
├── ja_sample_000.wav
├── ja_sample_001.wav
└── ...
```

### manifest.json format

```json
{
  "dataset": "reazon-research/reazonspeech",
  "num_samples": 10,
  "target_sample_rate": 16000,
  "samples": [
    {
      "filename": "ja_sample_000.wav",
      "transcript": "日本語の転写テキスト",
      "duration_sec": 8.5,
      "sample_rate": 16000
    }
  ]
}
```

## 2. Run WER Benchmark

```bash
# Default: uses Whisper base model
python benchmark_wer.py

# Use a different Whisper model
python benchmark_wer.py --whisper-model small

# Custom manifest path
python benchmark_wer.py --manifest path/to/manifest.json

# Custom output path
python benchmark_wer.py --output results.json
```

### Metrics

| Metric | Description |
|--------|-------------|
| **WER** | Word Error Rate (MeCab tokenization, character-level fallback) |
| **CER** | Character Error Rate |
| **Latency** | Wall-clock transcription time per sample |
| **RTF** | Real-Time Factor (latency / audio duration, lower = faster) |

### Using a Custom Transcriber

```python
from benchmark_wer import run_benchmark, print_summary
from pathlib import Path

def my_transcriber(wav_path: str) -> str:
    # Your ASR system here
    return transcribed_text

summary = run_benchmark(
    Path("fixtures/japanese/manifest.json"),
    transcriber=my_transcriber,
)
print_summary(summary)
```

## Notes

- Japanese WER uses MeCab for word segmentation. If MeCab is not installed, falls back to character-level tokenization (effectively CER).
- Text normalization includes NFKC normalization and punctuation removal.
- All audio is stored as 16kHz 16-bit mono WAV for consistency.
