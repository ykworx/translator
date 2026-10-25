#!/usr/bin/env python3
"""Generate reproducible offline probes; no microphone, network or user recordings.

Existing checked-in synthetic speech stands in for a background TV speaker.
It is not a recording of an actual TV room and cannot prove speaker isolation.
Optional Korean probes use an explicitly selected installed macOS TTS voice.
"""
import argparse
from array import array
import json
import math
from pathlib import Path
import random
import subprocess
import sys
import wave

RATE = 16000


def read_pcm(path):
    with wave.open(str(path), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (RATE, 1, 2):
            raise ValueError("Expected 16 kHz mono signed 16-bit PCM")
        samples = array("h", audio.readframes(audio.getnframes()))
    if sys.byteorder != "little":
        samples.byteswap()
    return [value / 32768 for value in samples]


def write_pcm(path, samples):
    pcm = array("h", (round(max(-1, min(32767 / 32768, value)) * 32768) for value in samples))
    if sys.byteorder != "little":
        pcm.byteswap()
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        audio.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New directory for generated WAVs and manifest")
    parser.add_argument("--korean-voice", help="Explicitly use this installed macOS voice, e.g. Yuna")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    fixtures = Path(__file__).parent / "fixtures/japanese"
    manifest = json.loads((fixtures / "manifest.json").read_text())
    foreground = read_pcm(fixtures / "ja_sample_000.wav")
    background = read_pcm(fixtures / "ja_sample_009.wav")
    rng = random.Random(2701)
    noise = [rng.gauss(0, 0.03) for _ in range(RATE * 5)]
    cases = []

    def add(name, samples, reference="", language="ja", category="non_speech"):
        write_pcm(args.output / name, samples)
        cases.append(dict(filename=name, transcript=reference, language=language, category=category))

    add("silence.wav", [0] * RATE * 5)
    add("white_noise.wav", noise)
    add("fan_and_clicks.wav", [0.025 * math.sin(2 * math.pi * 120 * i / RATE) +
        0.005 * noise[i] + (0.12 * math.exp(-(i % 8000) / 30) if i % 8000 < 160 else 0)
        for i in range(len(noise))])
    add("clean_speech.wav", foreground, manifest["samples"][0]["transcript"], category="clean_speech")
    power = sum(x*x for x in foreground) / len(foreground)
    for snr in (10, 0):
        sigma = math.sqrt(power / (10 ** (snr / 10)))
        add(f"speech_noise_{snr}db.wav", [x + rng.gauss(0, sigma) for x in foreground],
            manifest["samples"][0]["transcript"], category="speech_with_noise")
    add("background_voice_only.wav", [x * 0.25 for x in background], category="background_voice_probe")
    mixed = foreground + [0] * max(0, len(background) + RATE - len(foreground))
    for index, value in enumerate(background):
        mixed[index + RATE] += 0.25 * value
    add("overlapping_voices.wav", mixed, manifest["samples"][0]["transcript"], category="overlapping_voice_probe")
    if args.korean_voice:
        for name, text in (("short_ko", "네"), ("sentence_ko", "오늘 회의는 오후 세 시에 시작합니다.")):
            aiff = args.output / f"{name}.aiff"
            wav = args.output / f"{name}.wav"
            subprocess.run(["/usr/bin/say", "-v", args.korean_voice, "-o", str(aiff), text], check=True)
            subprocess.run(["/usr/bin/afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", str(aiff), str(wav)], check=True)
            cases.append(dict(filename=wav.name, transcript=text, language="ko", category="short_speech" if name == "short_ko" else "clean_speech"))
    (args.output / "manifest.json").write_text(json.dumps(dict(dataset="generated-noise-and-synthetic-speech", samples=cases), ensure_ascii=False, indent=2) + "\n")
    print(args.output / "manifest.json")


if __name__ == "__main__":
    main()
