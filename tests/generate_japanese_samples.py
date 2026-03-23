#!/usr/bin/env python3
"""
Generate Japanese speech test samples using Google TTS.
Saves as 16kHz mono WAV files with a JSON manifest.

Usage:
    pip install gtts pydub
    python generate_japanese_samples.py
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "fixtures" / "japanese"
MANIFEST_PATH = OUTPUT_DIR / "manifest.json"
TARGET_SR = 16000

# Japanese test sentences (varied domains)
SENTENCES = [
    ("ja_sample_000", "本日は天気が良くて、とても気持ちの良い一日になりそうです。"),
    ("ja_sample_001", "東京駅から新幹線で京都まで約二時間十五分かかります。"),
    ("ja_sample_002", "このプロジェクトの進捗状況について報告いたします。現在、開発フェーズの八十パーセントが完了しております。"),
    ("ja_sample_003", "人工知能の技術は急速に発展しており、音声認識の精度も大幅に向上しています。"),
    ("ja_sample_004", "すみません、この商品の在庫はまだありますか。サイズはMサイズが欲しいのですが。"),
    ("ja_sample_005", "来週の月曜日に会議を設定しましたので、ご確認をお願いいたします。"),
    ("ja_sample_006", "日本の四季はとても美しく、特に春の桜と秋の紅葉は世界的に有名です。"),
    ("ja_sample_007", "音声処理の遅延を三百ミリ秒以下に削減することが、今回の最重要課題です。"),
    ("ja_sample_008", "リアルタイム文字起こしシステムでは、正確さと速度のバランスが非常に重要になります。"),
    ("ja_sample_009", "ご視聴いただきありがとうございます。次回の配信もお楽しみに。"),
]


def generate_samples():
    try:
        from gtts import gTTS
    except ImportError:
        print("Error: 'gtts' not installed. Run: pip install gtts")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []

    print(f"Generating {len(SENTENCES)} Japanese speech samples...")

    for filename_base, text in SENTENCES:
        wav_path = OUTPUT_DIR / f"{filename_base}.wav"

        # Generate MP3 with gTTS
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
            tmp_mp3 = tmp.name

        tts = gTTS(text=text, lang="ja", slow=False)
        tts.save(tmp_mp3)

        # Convert to 16kHz mono WAV using ffmpeg
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", tmp_mp3,
                "-ar", str(TARGET_SR),
                "-ac", "1",
                "-sample_fmt", "s16",
                str(wav_path),
            ],
            capture_output=True,
        )
        Path(tmp_mp3).unlink(missing_ok=True)

        # Get duration
        import soundfile as sf
        info = sf.info(str(wav_path))
        duration = info.duration

        entry = {
            "filename": f"{filename_base}.wav",
            "transcript": text,
            "duration_sec": round(duration, 2),
            "sample_rate": TARGET_SR,
        }
        manifest.append(entry)
        print(f"  [{len(manifest)}/{len(SENTENCES)}] {filename_base}.wav ({duration:.1f}s) — {text[:30]}...")

    # Save manifest
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "dataset": "gtts-generated",
                "language": "ja",
                "num_samples": len(manifest),
                "target_sample_rate": TARGET_SR,
                "samples": manifest,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"\nDone! {len(manifest)} samples saved to {OUTPUT_DIR}")
    print(f"Manifest: {MANIFEST_PATH}")


if __name__ == "__main__":
    generate_samples()
