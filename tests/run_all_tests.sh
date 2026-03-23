#!/bin/bash
set -euo pipefail

# =============================================================================
# Transrator — Full Test & Benchmark Pipeline
# =============================================================================
# 1. Build the Tauri app
# 2. Download test samples (if missing)
# 3. Run integration benchmark
# 4. Compare with previous results (if available)
# 5. Pass/fail judgment (WER + latency thresholds)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAURI_DIR="$PROJECT_DIR/src-tauri"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/japanese"
RESULTS_DIR="$SCRIPT_DIR/results"
MANIFEST="$FIXTURE_DIR/manifest.json"

# Thresholds (override via env)
WER_THRESHOLD="${WER_THRESHOLD:-0.5}"
RTF_THRESHOLD="${RTF_THRESHOLD:-1.0}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# =============================================================================
# Step 1: Build
# =============================================================================
step_build() {
    info "Step 1: Building Tauri app..."
    cd "$PROJECT_DIR"

    if [ "${SKIP_BUILD:-}" = "1" ]; then
        warn "Build skipped (SKIP_BUILD=1)"
        return 0
    fi

    # Set perf tracking env for the build
    export WHISPER_PERF_TRACK=1

    if command -v cargo &>/dev/null; then
        cargo tauri build 2>&1 | tail -20
        info "Build complete"
    else
        error "cargo not found. Install Rust toolchain first."
        exit 1
    fi
}

# =============================================================================
# Step 2: Download samples (if missing)
# =============================================================================
step_download_samples() {
    info "Step 2: Checking test samples..."

    if [ -f "$MANIFEST" ]; then
        local sample_count
        sample_count=$(python3 -c "import json; print(len(json.load(open('$MANIFEST'))['samples']))" 2>/dev/null || echo "0")
        if [ "$sample_count" -gt 0 ]; then
            info "Found $sample_count samples in manifest, skipping download"
            return 0
        fi
    fi

    info "Downloading test samples..."
    cd "$SCRIPT_DIR"

    if python3 -c "import datasets, soundfile, librosa" 2>/dev/null; then
        python3 download_japanese_samples.py
    else
        warn "Missing Python dependencies. Install with:"
        warn "  pip install datasets soundfile librosa"
        warn "Skipping sample download."
        return 1
    fi
}

# =============================================================================
# Step 3: Run benchmark
# =============================================================================
step_benchmark() {
    info "Step 3: Running benchmark..."

    if [ ! -f "$MANIFEST" ]; then
        error "No manifest found at $MANIFEST"
        error "Run download_japanese_samples.py first."
        exit 1
    fi

    mkdir -p "$RESULTS_DIR"

    # Find the built binary
    local binary=""
    local search_paths=(
        "$TAURI_DIR/target/release/bundle/macos/Transrator.app/Contents/MacOS/Transrator"
        "$TAURI_DIR/target/release/transrator"
        "$TAURI_DIR/target/debug/transrator"
    )

    for p in "${search_paths[@]}"; do
        if [ -x "$p" ]; then
            binary="$p"
            break
        fi
    done

    # Save previous results for comparison
    local compare_flag=""
    if [ -f "$RESULTS_DIR/latest.json" ]; then
        cp "$RESULTS_DIR/latest.json" "$RESULTS_DIR/previous.json"
        compare_flag="--compare $RESULTS_DIR/previous.json"
    fi

    cd "$SCRIPT_DIR"

    local benchmark_args=(
        python3 run_integration_benchmark.py
        --manifest "$MANIFEST"
        --output "$RESULTS_DIR"
        --wer-threshold "$WER_THRESHOLD"
        --rtf-threshold "$RTF_THRESHOLD"
    )

    if [ -n "$binary" ]; then
        benchmark_args+=(--binary "$binary")
        info "Using binary: $binary"
    else
        warn "No built binary found. Running standalone WER benchmark instead."
        # Fall back to the standalone WER benchmark
        benchmark_args=(
            python3 benchmark_wer.py
            --manifest "$MANIFEST"
            --output "$RESULTS_DIR/latest.json"
        )
    fi

    if [ -n "$compare_flag" ]; then
        # shellcheck disable=SC2086
        "${benchmark_args[@]}" $compare_flag
    else
        "${benchmark_args[@]}"
    fi

    local exit_code=$?
    return $exit_code
}

# =============================================================================
# Step 4: Result summary & pass/fail
# =============================================================================
step_verdict() {
    local benchmark_exit=$1

    echo ""
    echo "============================================================"

    if [ "$benchmark_exit" -eq 0 ]; then
        info "VERDICT: ${GREEN}PASS${NC} — All thresholds met"
        echo "  WER threshold:     ${WER_THRESHOLD}"
        echo "  RTF threshold:     ${RTF_THRESHOLD}"
    else
        error "VERDICT: ${RED}FAIL${NC} — Threshold(s) exceeded"
        echo "  WER threshold:     ${WER_THRESHOLD}"
        echo "  RTF threshold:     ${RTF_THRESHOLD}"
    fi

    if [ -f "$RESULTS_DIR/latest.json" ]; then
        echo "  Results:           $RESULTS_DIR/latest.json"
    fi

    echo "============================================================"
    return $benchmark_exit
}

# =============================================================================
# Main
# =============================================================================
main() {
    echo ""
    echo "============================================================"
    echo "  Transrator — Test & Benchmark Pipeline"
    echo "  $(date '+%Y-%m-%d %H:%M:%S')"
    echo "============================================================"
    echo ""

    step_build
    step_download_samples || true  # Don't fail if download deps are missing

    local bench_exit=0
    step_benchmark || bench_exit=$?

    step_verdict $bench_exit
    exit $bench_exit
}

main "$@"
