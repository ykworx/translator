#!/bin/bash
set -euo pipefail
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Native dictation checks require macOS and Xcode Command Line Tools." >&2
  exit 1
fi
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/transrator-dictation.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc \
  "$project_dir/src-tauri/swift/DictationState.swift" \
  "$project_dir/src-tauri/swift/SpeechAudioPolicy.swift" \
  "$project_dir/tests/native/main.swift" \
  -o "$test_dir/dictation-tests"
"$test_dir/dictation-tests"
xcrun swiftc \
  "$project_dir/src-tauri/swift/DictationState.swift" \
  "$project_dir/src-tauri/swift/DictationClipboard.swift" \
  "$project_dir/tests/nativeClipboard/main.swift" \
  -framework AppKit \
  -o "$test_dir/clipboard-tests"
"$test_dir/clipboard-tests"
xcrun swiftc \
  "$project_dir/src-tauri/swift/DictationTranscriptView.swift" \
  "$project_dir/tests/nativePanel/main.swift" \
  -framework AppKit \
  -o "$test_dir/panel-tests"
"$test_dir/panel-tests"
python3 -B -m unittest discover -s "$project_dir/tests/native" -p 'test_*.py'
