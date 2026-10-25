#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/transrator-speech-audio.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
rnnoise_dir="$project_dir/src-tauri/vendor/rnnoise"
for source in denoise rnn rnn_data pitch kiss_fft celt_lpc; do
  xcrun clang -O2 -DCOMPILE_OPUS -I"$rnnoise_dir/include" -I"$rnnoise_dir/src" \
    -c "$rnnoise_dir/src/$source.c" -o "$test_dir/$source.o"
done
xcrun swiftc "$project_dir/src-tauri/swift/SpeechDenoiser.swift" \
  "$project_dir/tests/nativeSpeechAudio/main.swift" \
  -import-objc-header "$rnnoise_dir/include/rnnoise.h" \
  "$test_dir/"*.o -framework AVFoundation -o "$test_dir/speech-audio-tests"
"$test_dir/speech-audio-tests"
