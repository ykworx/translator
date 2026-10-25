#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
python3 -B - "$project_dir" "$@" <<'PY'
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

project = Path(sys.argv[1])
parser = argparse.ArgumentParser(description="Optional real-model native lifecycle smoke; no microphone or app UI.")
parser.add_argument("--model", type=Path, required=True, help="Existing local Whisper model file (never downloaded)")
parser.add_argument("--wav", type=Path, required=True, help="Existing short public/local WAV fixture")
parser.add_argument("--timeout", type=float, default=120, help="Native test process timeout in seconds")
args = parser.parse_args(sys.argv[2:])
if platform.system() != "Darwin":
    parser.error("macOS and Xcode Command Line Tools are required")
if not 0 < args.timeout <= 600:
    parser.error("--timeout must be between 0 and 600 seconds")
try:
    model = args.model.expanduser().resolve(strict=True)
    audio = args.wav.expanduser().resolve(strict=True)
    if not model.is_file() or not audio.is_file():
        parser.error("--model and --wav must both point to files")
    manifest = project / "src-tauri/Cargo.toml"
    metadata = subprocess.run(["cargo", "metadata", "--format-version", "1", "--no-deps",
                               "--manifest-path", str(manifest)],
                              capture_output=True, text=True, check=True, timeout=60)
    packages = json.loads(metadata.stdout)["packages"]
    package_id = next(package["id"] for package in packages
                      if Path(package["manifest_path"]).resolve() == manifest.resolve())
    build = subprocess.run(["cargo", "build", "--manifest-path", str(manifest), "--message-format=json"],
                           capture_output=True, text=True, timeout=180)
    sys.stderr.write(build.stderr)
    if build.returncode:
        raise RuntimeError("cargo build failed")
    out_dirs = []
    for line in build.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("reason") == "build-script-executed" and message.get("package_id") == package_id:
            out_dirs.append(Path(message["out_dir"]))
    if len(out_dirs) != 1:
        raise RuntimeError("could not uniquely identify this package's build-script output from Cargo JSON")
    out = out_dirs[0]
    ggml = out / "whisper-build/ggml/src"
    libraries = [out / "libspeech_bridge.a", out / "whisper-build/src/libwhisper.a",
                 out / "whisper-build/src/libwhisper.coreml.a", ggml / "libggml.a",
                 ggml / "libggml-base.a", ggml / "libggml-cpu.a",
                 ggml / "ggml-metal/libggml-metal.a", out / "librnnoise.a"]
    if not libraries[5].is_file():
        libraries[5] = ggml / "ggml-cpu/libggml-cpu.a"
    missing = [path.name for path in libraries if not path.is_file()]
    if missing:
        raise RuntimeError(f"missing native archives: {', '.join(missing)}")
    with tempfile.TemporaryDirectory(prefix="transrator-native-lifecycle-") as temporary:
        folder = Path(temporary)
        vad = project / "src-tauri/vendor/silero-vad-coreml.mlmodelc"
        if vad.is_dir():
            (folder / vad.name).symlink_to(vad)
        binary = folder / "lifecycle-smoke"
        command = ["xcrun", "swiftc", str(project / "tests/nativeLifecycle/main.swift"),
                   *map(str, libraries), "-lc++", "-o", str(binary)]
        for framework in ["AVFoundation", "Foundation", "AppKit", "ApplicationServices", "ScreenCaptureKit",
                          "CoreGraphics", "CoreMedia", "CoreAudio", "AudioToolbox", "Metal", "MetalKit", "Accelerate", "CoreML"]:
            command.extend(["-framework", framework])
        link = subprocess.run(command, capture_output=True, text=True, timeout=120)
        sys.stderr.write(link.stderr)
        if link.returncode:
            raise RuntimeError("standalone Swift test linking failed")
        result = subprocess.run([str(binary), str(model), str(audio)], capture_output=True,
                                text=True, timeout=args.timeout)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        if result.returncode:
            raise RuntimeError(f"native lifecycle smoke failed (exit {result.returncode})")
        report = json.loads(result.stdout)
        if report.get("count") != 16 or not all(row.get("passed") is True for row in report.get("checks", [])):
            raise RuntimeError("native test did not report all 16 lifecycle checks")
except (OSError, subprocess.SubprocessError, ValueError, KeyError, StopIteration, RuntimeError) as error:
    print(f"Lifecycle smoke: {error}", file=sys.stderr)
    raise SystemExit(1)
PY
