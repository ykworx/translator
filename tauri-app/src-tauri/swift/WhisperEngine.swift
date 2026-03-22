import AVFoundation
import Foundation
import Accelerate

// MARK: - New segment callback context & C function

/// Context passed through whisper's new_segment_callback user_data pointer.
/// Holds an unretained reference to WhisperEngine so the C callback can
/// call back into Swift.
private final class WhisperSegmentCallbackContext {
    weak var engine: WhisperEngine?
    init(engine: WhisperEngine) { self.engine = engine }
}

/// C-compatible callback invoked by whisper.cpp each time new segment(s) are decoded.
/// Signature matches `whisper_new_segment_callback`:
///   (ctx, state, n_new, user_data) -> Void
private let whisperNewSegmentCallback: @convention(c) (
    OpaquePointer?,   // whisper_context *
    OpaquePointer?,   // whisper_state *
    Int32,            // n_new
    UnsafeMutableRawPointer?  // user_data
) -> Void = { ctx, state, nNew, userData in
    guard let userData, let state else { return }

    // Recover the callback context (unretained — caller manages lifetime)
    let callbackCtx = Unmanaged<WhisperSegmentCallbackContext>
        .fromOpaque(userData)
        .takeUnretainedValue()
    guard let engine = callbackCtx.engine else { return }

    let totalSegments = whisper_full_n_segments_from_state(state)
    guard totalSegments > 0 else { return }

    // In streaming mode: result_all contains the FULL confirmed text as a single segment.
    // Read ALL segments to get cumulative text (not just the new ones).
    // In legacy mode: read only new segments (incremental).
    let startIdx: Int32
    if engine.inferenceMode == .streaming {
        startIdx = 0  // read all — C side puts full confirmed text in result_all
    } else {
        startIdx = totalSegments - nNew
        guard startIdx >= 0 else { return }
    }

    // Build partial text from tokens, dropping the last token (may be incomplete).
    let cbStart = CFAbsoluteTimeGetCurrent()

    var partialText = ""
    for i in startIdx..<totalSegments {
        let nTok = whisper_full_n_tokens_from_state(state, i)
        let keepTok = engine.inferenceMode == .streaming ? max(0, nTok - 1) : nTok
        var segText = ""
        for j in 0..<keepTok {
            if let cStr = whisper_full_get_token_text_from_state(ctx, state, i, j) {
                segText += String(cString: cStr)
            }
        }
        let segment = segText.trimmingCharacters(in: .whitespacesAndNewlines)
        if engine.isHallucination(segment) { continue }
        if segment.isEmpty { continue }
        if !partialText.isEmpty { partialText += " " }
        partialText += segment
    }

    let cbElapsed = (CFAbsoluteTimeGetCurrent() - cbStart) * 1000.0
    PerformanceTracker.shared.record(stage: "newSegmentCallback", durationMs: cbElapsed)

    if !partialText.isEmpty {
        // Rewind detection: check if partial diverged from previous
        if engine.inferenceMode == .streaming {
            engine.checkRewind(partialText)
        }
        // Cross-segment repetition check
        if engine.isRepeatOfLastSegment(partialText) {
            return
        }
        let callback = engine.onPartialResult
        if engine.isBenchmarkMode {
            callback?(partialText)
        } else {
            DispatchQueue.main.async { callback?(partialText) }
        }
    }
}

/// Shared Whisper STT engine backed by whisper.cpp + CoreML.
/// Uses accumulate-and-finalize strategy:
///   - Audio accumulates up to maxDuration (10s)
///   - Every stepInterval (2s), inference runs on ALL accumulated audio → partial
///   - Silence (700ms) → finalize, clear buffer
///   - Max duration → force finalize, carry context via prompt_tokens
///   - No sliding window — partials get progressively better, no text loss
final class WhisperEngine {
    static let shared = WhisperEngine()

    enum Owner: String { case mic, appCaption, none }

    /// Inference mode: accumulate (legacy) or streaming (AlignAtt)
    enum InferenceMode {
        case accumulate  // Legacy: accumulate audio, then whisper_full()
        case streaming   // AlignAtt: emit safe tokens as audio arrives
    }

    private let lock = NSLock()
    private let inferenceQueue = DispatchQueue(label: "transrator.whisper.inference", qos: .userInitiated)

    private var ctx: OpaquePointer?
    private(set) var isModelLoaded = false
    private var currentOwner: Owner = .none
    private var vadModelPath: String?

    /// When true, callbacks fire directly on inference thread (no DispatchQueue.main.async)
    /// Used by feedWavFile to avoid deadlock when main thread is blocked on semaphore
    fileprivate var isBenchmarkMode = false

    // MARK: - Inference Mode

    var inferenceMode: InferenceMode = .streaming

    // MARK: - Streaming AlignAtt State

    /// Dedicated whisper_state for streaming (created lazily with DTW enabled)
    private var streamState: OpaquePointer?
    private var streamInitialized = false
    /// Buffered PCM samples waiting to be sent to the streaming decoder
    private var streamPendingSamples: [Float] = []
    /// All PCM samples sent to C-side in this segment (for carry-over on force-finalize)
    private var streamAllSentSamples: [Float] = []
    /// Minimum samples before first streaming decode (~0.6s)
    /// Reduced from 19200 (1.2s) for faster first-token emission.
    /// CPU tradeoff: more frequent encode calls (~0.6s vs 1.2s) but each call is shorter.
    private let streamMinSamples = 12_800  // 0.8s — enough context for first decode (was 0.6s)
    /// Maximum accumulated samples before force-finalize (15s — prevents stale audio buildup during backoff)
    private let streamMaxSamples = 240_000
    /// Sliding window size for streamAllSentSamples (2s — only last 1s needed for carry-over)
    private let streamSlidingWindowSize = 32_000
    /// Total PCM samples sent to C-side so far in this segment
    private var streamTotalSent = 0
    /// Guard against re-entrant finalize calls
    private var isFinalizePending = false
    /// Adaptive AlignAtt frame threshold based on accumulated audio duration:
    ///  - Short utterance (<2s / 32000 samples): threshold 4 → aggressive decode
    ///  - Normal utterance (2-5s): threshold 15 → balanced
    ///  - Long utterance (>5s): threshold 20 → conservative
    ///  - Finalize always uses 4
    private var adaptiveAlignAttThreshold: Int32 {
        let sent = streamTotalSent
        if sent < 32_000 { return 4 }    // < 2s: aggressive
        if sent > 80_000 { return 8 }    // > 5s: moderate (was 20, too high → no new tokens)
        return 6                           // 2-5s: was 15, lowered for better token confirmation
    }
    /// Prompt tokens carried from last finalized segment (Swift controls policy)
    private var streamPromptTokens: [Int32] = []

    // MARK: - Decode backoff (skip cycles when decoder produces nothing)

    /// Consecutive decode cycles that produced no new text — used for CPU-saving backoff
    private var consecutiveEmptyDecodes = 0

    // MARK: - Rewind detection (prefix divergence → hallucination propagation cut)

    /// Previous partial result text for rewind detection
    private var lastPartialText: String = ""

    // MARK: - Silero VAD for streaming (ggml, 512 samples = 32ms)

    /// ggml Silero VAD context (lazy, reused across segments, LSTM state maintained)
    private var vadCtx: OpaquePointer?  // whisper_vad_context *
    /// Buffer to accumulate samples for VAD chunk processing (512 = 32ms at 16kHz)
    /// Uses offset tracking to avoid O(n) removeFirst() — compact only when offset exceeds threshold
    private var vadBuffer: [Float] = {
        var buf = [Float]()
        buf.reserveCapacity(8192)  // Pre-allocate ~16 VAD chunks
        return buf
    }()
    private var vadBufferOffset = 0
    private let vadChunkSize = 512  // Silero native window size (32ms at 16kHz)
    /// Consecutive non-speech VAD chunks before finalize
    private var vadSilentCount = 0
    /// Adaptive silence threshold based on accumulated speech duration:
    ///  - Short utterance (<2s): finalize quickly (256ms)
    ///  - Normal (2-5s): default (480ms)
    ///  - Long utterance (>5s): require longer pause (640ms)
    private var adaptiveVadSilentForFinalize: Int {
        let sent = streamTotalSent
        if sent < 32_000 { return 28 }   // < 2s: 896ms silence needed (was 640ms — cut mid-word in Japanese)
        if sent > 80_000 { return 30 }   // > 5s: 960ms pause needed
        return 28                         // 2-5s: 896ms
    }
    /// Minimum segment length before allowing finalize (2.0s — prevent tiny fragments)
    private let minSegmentSamples = 32_000
    /// Speech probability thresholds (Silero VAD recommended defaults)
    /// Hysteresis: speech starts at >= threshold, ends at < negThreshold
    private let vadSpeechThreshold: Float = 0.5
    private let vadNegThreshold: Float = 0.35  // threshold - 0.15
    private var vadInSpeech = false

    // MARK: - Accumulate + Finalize Parameters (legacy mode)

    private let stepInterval   = 32_000  // 2s — partial inference trigger
    private let maxDuration    = 96_000  // 6s — force finalize (VAD ~1s for 6s audio)
    private let minInferSize   = 8_000   // 0.5s minimum for inference

    /// Audio buffer — grows until finalize, then clears
    private var audioBuffer: [Float] = []
    private var newSampleCount = 0
    private var isInferenceRunning = false

    /// Prompt tokens from last finalized segment — context for next segment
    private var promptTokens: [Int32] = []

    /// Silence detection (fast, RMS-based)
    private let silenceThreshold: Float = 0.005
    private var silentChunkCount = 0
    private let silentChunksForFinalize = 7 // 700ms at ~100ms chunks

    // MARK: - Hallucination filter (O(1) exact + substring fallback + cached regex)

    /// Exact-match set — catches the most common full-segment hallucinations in O(1)
    private static let hallucinationSet: Set<String> = [
        // Korean
        "시청해 주셔서 감사합니다", "시청해주셔서 감사합니다",
        "구독과 좋아요", "MBC 뉴스", "자막 제공",
        // English
        "Thank you for watching", "Thanks for watching",
        // Japanese
        "ご視聴ありがとうございました", "ご視聴ありがとうございます",
        "チャンネル登録お願いします", "高評価お願いします",
        "お願いします", "ご視聴いただきありがとうございます",
        "最後までご視聴いただきありがとうございました",
        "ご覧いただきありがとうございます",
        "チャンネル登録", "よろしくお願いします",
        // Onomatopoeia hallucinations (noise/silence → repeated sounds)
        "ブーブー", "ブー", "ブブ", "ブーブーブー",
        "ザーザー", "ザー", "ピーピー", "ピー",
        "シーシー", "シー", "ガーガー", "ガー",
        // Chinese / Other
        "Sous-titres", "Amara.org",
        "【大将】", "【字幕】", "字幕", "字幕提供", "字幕翻訳",
    ]

    /// Substring patterns — for hallucinations embedded in longer text
    private static let hallucinationSubstrings: [String] = [
        "시청해주셔서 감사합니다", "구독과 좋아요",
        "Thank you for watching", "Thanks for watching",
        "ご視聴ありがとう", "チャンネル登録", "お願いします",
        "Amara.org", "자막 제공", "字幕",
        "ブーブー", "ブー", "ザーザー", "ピーピー", "ガーガー",
    ]

    /// Pre-compiled bracket regex — avoids re-compilation per segment (~0.5-2ms savings)
    private static let bracketRegex: NSRegularExpression = {
        try! NSRegularExpression(pattern: "【[^】]*】|\\[[^\\]]*\\]")
    }()

    /// Detect rewind: if the new partial diverges too early from the previous partial,
    /// the decoder may be hallucinating. Reset streamPromptTokens to cut propagation.
    /// Simple prefix comparison — no Levenshtein needed.
    fileprivate func checkRewind(_ newPartial: String) {
        guard !lastPartialText.isEmpty else {
            lastPartialText = newPartial
            return
        }
        let prev = lastPartialText
        let prefixLen = min(prev.count, newPartial.count)
        // Find how many characters match from the start
        var matchLen = 0
        let prevChars = Array(prev)
        let newChars = Array(newPartial)
        for i in 0..<prefixLen {
            if prevChars[i] == newChars[i] { matchLen += 1 } else { break }
        }
        // If less than 50% of the shorter string matches, it's a rewind
        let threshold = max(4, prefixLen / 2)
        if matchLen < threshold && prev.count > 8 {
            NSLog("[WhisperEngine] Rewind detected: prefix match %d/%d — resetting prompt tokens", matchLen, prefixLen)
            streamPromptTokens.removeAll()
        }
        lastPartialText = newPartial
    }

    /// Recent finalized texts for cross-segment repetition detection (ring buffer, last 5)
    private var recentFinalizedTexts: [String] = []

    /// Check if text is a repetition of any recent finalized segment
    fileprivate func isRepeatOfLastSegment(_ text: String) -> Bool {
        guard text.count >= 3 else { return false }
        // Normalize: remove whitespace, punctuation for comparison
        let norm = text.replacingOccurrences(of: "[。、.!?\\s]", with: "", options: .regularExpression)
        for prev in recentFinalizedTexts {
            let prevNorm = prev.replacingOccurrences(of: "[。、.!?\\s]", with: "", options: .regularExpression)
            guard !prevNorm.isEmpty else { continue }
            // Exact match after normalization
            if norm == prevNorm { return true }
            // New text is a substring of previous
            if prevNorm.contains(norm) { return true }
            // Previous is a substring of new (hallucination expanding on previous)
            if norm.contains(prevNorm) && prevNorm.count > 8 { return true }
            // Suffix-prefix overlap: last N chars of previous match start of new
            let overlapLen = min(norm.count, prevNorm.count, 15)
            if overlapLen >= 10 {
                let prevSuffix = String(prevNorm.suffix(overlapLen))
                if norm.hasPrefix(prevSuffix) { return true }
                // Both segments end with the same suffix
                let normSuffix = String(norm.suffix(overlapLen))
                if normSuffix == prevSuffix { return true }
            }
            // Long common substring check: any 12-char window match catches near-match repeats
            // (e.g., "あがえても" vs "あがいても" sharing most characters)
            if norm.count >= 12 && prevNorm.count >= 12 {
                let chars = Array(norm)
                for start in 0...(chars.count - 12) {
                    let window = String(chars[start..<start+12])
                    if prevNorm.contains(window) { return true }
                }
            }
        }
        return false
    }

    /// Record finalized text for repetition tracking
    fileprivate func recordFinalizedText(_ text: String) {
        recentFinalizedTexts.append(text)
        if recentFinalizedTexts.count > 5 {
            recentFinalizedTexts.removeFirst()
        }
    }

    private var whisperLang = "auto"
    var initialPrompt: String = ""
    private var lastFinalText: String = ""

    var onPartialResult: ((String) -> Void)?
    var onFinalResult: ((String) -> Void)?

    // MARK: - Model lifecycle

    func loadModel(path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if ctx != nil { whisper_free(ctx); ctx = nil; isModelLoaded = false }

        var params = whisper_context_default_params()
        params.use_gpu = true

        let coremlPath = path.replacingOccurrences(of: ".bin", with: "-encoder.mlmodelc")
        if FileManager.default.fileExists(atPath: coremlPath) {
            NSLog("[WhisperEngine] CoreML encoder found at %@", coremlPath)
        } else {
            NSLog("[WhisperEngine] CoreML encoder not found, using GPU/CPU only")
        }

        guard let newCtx = whisper_init_from_file_with_params(path, params) else {
            NSLog("[WhisperEngine] Failed to load model from %@", path)
            return false
        }

        ctx = newCtx
        isModelLoaded = true
        // streamState is created lazily in ensureStreamInit (needs DTW enabled first)
        resolveVADModelPath()
        NSLog("[WhisperEngine] Model loaded from %@", path)

        // Warm-up encode: run a dummy encode with 0.1s silence to prime
        // CoreML compilation cache + Metal shader cache (~60ms first-encode penalty absorbed here)
        let warmupCtx = newCtx
        DispatchQueue.global(qos: .utility).async {
            let silenceSamples = [Float](repeating: 0.0, count: 1600) // 0.1s at 16kHz
            var warmParams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
            warmParams.print_realtime = false
            warmParams.print_progress = false
            warmParams.no_timestamps = true
            warmParams.n_threads = 2
            warmParams.single_segment = true
            silenceSamples.withUnsafeBufferPointer { buf in
                let _ = whisper_full(warmupCtx, warmParams, buf.baseAddress, Int32(buf.count))
            }
            NSLog("[WhisperEngine] Warm-up encode completed")
        }

        return true
    }

    private func resolveVADModelPath() {
        let filename = "for-tests-silero-v5.1.2-ggml.bin"

        // Bundle resource
        if let p = Bundle.main.path(forResource: "for-tests-silero-v5.1.2-ggml", ofType: "bin") {
            vadModelPath = p; return
        }
        // Tauri resources
        if let u = Bundle.main.resourceURL {
            let p = u.appendingPathComponent(filename).path
            if FileManager.default.fileExists(atPath: p) { vadModelPath = p; return }
        }
        // Near executable
        let nearExec = (Bundle.main.bundlePath as NSString).appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: nearExec) { vadModelPath = nearExec; return }
        // Dev mode: relative to binary
        let execPath = ProcessInfo.processInfo.arguments.first ?? ""
        let execDir = (execPath as NSString).deletingLastPathComponent
        for rel in ["../../../vendor/whisper.cpp/models/\(filename)",
                     "../../../../src-tauri/vendor/whisper.cpp/models/\(filename)"] {
            let p = ((execDir as NSString).appendingPathComponent(rel) as NSString).standardizingPath
            if FileManager.default.fileExists(atPath: p) { vadModelPath = p; NSLog("[WhisperEngine] Silero VAD found: %@", p); return }
        }
        // Source tree
        let srcTree = NSHomeDirectory() + "/transrator/tauri-app/src-tauri/vendor/whisper.cpp/models/\(filename)"
        if FileManager.default.fileExists(atPath: srcTree) { vadModelPath = srcTree; NSLog("[WhisperEngine] Silero VAD found: %@", srcTree); return }

        vadModelPath = nil
        NSLog("[WhisperEngine] Silero VAD not found, finalize will run without VAD")
    }

    func unloadModel() {
        lock.lock()
        defer { lock.unlock() }
        if vadCtx != nil { whisper_vad_free(vadCtx); vadCtx = nil }
        if streamState != nil { whisper_free_state(streamState); streamState = nil }
        streamInitialized = false
        if ctx != nil { whisper_free(ctx); ctx = nil }
        isModelLoaded = false
        currentOwner = .none
        resetState()
        NSLog("[WhisperEngine] Model unloaded")
    }

    // MARK: - Owner management

    func acquire(owner: Owner) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard isModelLoaded else { return false }
        if currentOwner != .none && currentOwner != owner { return false }
        currentOwner = owner
        return true
    }

    func release(owner: Owner) {
        // Wait for any pending finalize to complete before clearing callbacks
        if inferenceMode == .streaming {
            lock.lock()
            let pending = isFinalizePending || isInferenceRunning
            lock.unlock()
            if pending {
                // Block until inference queue drains
                inferenceQueue.sync {}
            }
        }

        lock.lock()
        defer { lock.unlock() }
        if currentOwner == owner {
            currentOwner = .none
            resetState()
            onPartialResult = nil
            onFinalResult = nil
        }
    }

    private func resetState() {
        audioBuffer.removeAll()
        newSampleCount = 0
        silentChunkCount = 0
        promptTokens.removeAll()
        lastFinalText = ""
        isInferenceRunning = false
        // Streaming state
        streamInitialized = false
        streamPendingSamples.removeAll()
        streamTotalSent = 0
        streamAllSentSamples.removeAll()
        isFinalizePending = false
        streamPromptTokens.removeAll()
        vadBuffer.removeAll(keepingCapacity: true)
        vadBufferOffset = 0
        vadSilentCount = 0
        vadInSpeech = false
        consecutiveEmptyDecodes = 0
        lastPartialText = ""
        lastFinalizedText = ""
        segmentCount = 0
        if let vctx = vadCtx { whisper_vad_reset_state(vctx) }
        if let ctx, let ss = streamState {
            whisper_stream_reset(ctx, ss)
        }
    }

    // MARK: - Language

    func setLanguage(from localeIdentifier: String?) {
        guard let id = localeIdentifier, !id.isEmpty else { whisperLang = "auto"; return }
        let mapping: [String: String] = [
            "ko-KR": "ko", "ko": "ko", "ja-JP": "ja", "ja": "ja",
            "en-US": "en", "en-GB": "en", "en": "en",
            "zh-CN": "zh", "zh-TW": "zh", "zh": "zh",
            "es-ES": "es", "es": "es", "fr-FR": "fr", "fr": "fr",
            "de-DE": "de", "de": "de",
        ]
        whisperLang = mapping[id] ?? mapping[String(id.prefix(2))] ?? "auto"
    }

    // MARK: - Audio input

    /// Recent audio RMS for silence-based decode gating
    private var recentRMS: Float = 0

    /// Monotonically increasing segment counter for structured logging
    private var segmentCount = 0

    /// Last finalized segment text — used to detect cross-segment repetition
    private var lastFinalizedText: String = ""

    func appendSamples(_ samples: [Float]) {
        if inferenceMode == .streaming {
            // Track recent RMS for silence-based decode gating
            var rms: Float = 0
            samples.withUnsafeBufferPointer { buf in
                vDSP_rmsqv(buf.baseAddress!, 1, &rms, vDSP_Length(buf.count))
            }
            recentRMS = rms
            appendSamplesStreaming(samples)
            return
        }

        // Fast silence detection (RMS)
        let rms = computeRMS(samples)
        if rms < silenceThreshold {
            silentChunkCount += 1
            if silentChunkCount >= silentChunksForFinalize {
                silentChunkCount = 0
                lock.lock()
                let hasAudio = audioBuffer.count >= minInferSize
                lock.unlock()
                if hasAudio { finalizeAndClear() }
                return
            }
        } else {
            silentChunkCount = 0
        }

        lock.lock()
        audioBuffer.append(contentsOf: samples)
        newSampleCount += samples.count

        let bufferLen = audioBuffer.count
        let shouldPartial = newSampleCount >= stepInterval && !isInferenceRunning
        let shouldFinalize = bufferLen >= maxDuration
        lock.unlock()

        if shouldFinalize {
            finalizeAndClear()
        } else if shouldPartial {
            runPartialInference()
        }
    }

    // MARK: - Streaming AlignAtt Mode

    /// Create ggml Silero VAD context lazily
    private func ensureVadCtx() -> Bool {
        if vadCtx != nil { return true }
        guard let path = vadModelPath else { return false }
        var params = whisper_vad_default_context_params()
        params.n_threads = 1
        params.use_gpu = false  // VAD is tiny, CPU is fine
        vadCtx = path.withCString { cPath in
            whisper_vad_init_from_file_with_params(cPath, params)
        }
        if vadCtx != nil {
            NSLog("[WhisperEngine] ggml Silero VAD context created (512 samples / 32ms)")
            return true
        }
        NSLog("[WhisperEngine] ggml Silero VAD failed to load, falling back to RMS")
        return false
    }

    /// Create streaming state lazily — MUST be called after DTW is enabled on ctx
    private func ensureStreamState() -> Bool {
        guard let ctx else {
            NSLog("[WhisperEngine] ensureStreamState: ctx is nil")
            return false
        }
        if streamState != nil { return true }
        streamState = whisper_init_state(ctx)
        if streamState == nil {
            NSLog("[WhisperEngine] ensureStreamState: whisper_init_state FAILED")
            return false
        }
        return true
    }

    /// Initialize streaming session if not already done
    private func ensureStreamInit() -> Bool {
        guard let ctx else { return false }
        guard ensureStreamState(), let ss = streamState else { return false }
        if streamInitialized { return true }

        let langStr = whisperLang
        let ret = langStr.withCString { langPtr -> Int32 in
            let lang: UnsafePointer<CChar>? = (langStr == "auto") ? nil : langPtr
            if streamPromptTokens.isEmpty {
                return whisper_stream_init(ctx, ss, lang, false, nil, 0, 4)
            } else {
                return streamPromptTokens.withUnsafeBufferPointer { tokBuf in
                    whisper_stream_init(ctx, ss, lang, false, tokBuf.baseAddress, Int32(tokBuf.count), 4)
                }
            }
        }
        if ret != 0 {
            NSLog("[WhisperEngine] stream init failed: %d", ret)
            return false
        }
        streamInitialized = true
        return true
    }

    /// Check silence using ggml Silero VAD (512 samples = 32ms) with hysteresis.
    /// Speech starts at >= vadSpeechThreshold (0.5), ends at < vadNegThreshold (0.35).
    /// Matches Lightning-SimulWhisper VAD configuration.
    /// Returns true if non-speech detected long enough to finalize.
    ///
    /// Optimization: uses offset tracking instead of Array.removeFirst() to avoid
    /// O(n) memory copies per chunk. Buffer is compacted only when offset exceeds threshold.
    private func checkVadSilence(_ samples: [Float]) -> Bool {
        vadBuffer.append(contentsOf: samples)
        let silentThreshold = adaptiveVadSilentForFinalize

        // Process in 512-sample chunks (32ms) — Silero native window size
        // Use offset tracking: advance vadBufferOffset instead of removeFirst (O(1) vs O(n))
        while vadBuffer.count - vadBufferOffset >= vadChunkSize {
            let chunkOffset = vadBufferOffset
            vadBufferOffset += vadChunkSize

            if ensureVadCtx(), let vctx = vadCtx {
                // Pass pointer directly at offset — zero-copy chunk access
                let prob = vadBuffer.withUnsafeBufferPointer { buf in
                    whisper_vad_process_chunk(vctx, buf.baseAddress! + chunkOffset, Int32(vadChunkSize))
                }

                // Hysteresis: use different thresholds for speech→silence vs silence→speech
                if vadInSpeech {
                    if prob < vadNegThreshold {
                        vadInSpeech = false
                        vadSilentCount += 1
                    } else {
                        vadSilentCount = 0
                    }
                } else {
                    if prob >= vadSpeechThreshold {
                        vadInSpeech = true
                        vadSilentCount = 0
                    } else {
                        vadSilentCount += 1
                    }
                }

                if vadSilentCount >= silentThreshold {
                    vadSilentCount = 0
                    compactVadBuffer()
                    return true
                }
            } else {
                // Fallback: no VAD model → use vDSP RMS (Accelerate, vectorized)
                var rms: Float = 0
                vadBuffer.withUnsafeBufferPointer { buf in
                    vDSP_rmsqv(buf.baseAddress! + chunkOffset, 1, &rms, vDSP_Length(vadChunkSize))
                }
                if rms < silenceThreshold {
                    vadSilentCount += 1
                    if vadSilentCount >= silentThreshold {
                        vadSilentCount = 0
                        compactVadBuffer()
                        return true
                    }
                } else {
                    vadSilentCount = 0
                }
            }
        }

        // Compact buffer when offset exceeds threshold (amortized O(1))
        compactVadBuffer()
        return false
    }

    /// Compact vadBuffer by removing processed samples (called when offset is large enough)
    private func compactVadBuffer() {
        guard vadBufferOffset >= vadChunkSize * 8 else { return }
        vadBuffer.removeFirst(vadBufferOffset)
        vadBufferOffset = 0
    }

    /// Streaming path: buffer audio → when ready, encode + AlignAtt decode → emit partial
    /// Lock consolidated: 3 acquisitions → 1 (append + state read + conditional take)
    private func appendSamplesStreaming(_ samples: [Float]) {
        let perfStart = CFAbsoluteTimeGetCurrent()

        // VAD runs on audio-callback thread only — no lock needed
        let isSilence = PerformanceTracker.shared.measure(stage: "checkVadSilence") {
            checkVadSilence(samples)
        }

        // Single lock: append samples, read state, conditionally take pending for decode
        lock.lock()
        streamPendingSamples.append(contentsOf: samples)
        let totalAccumulated = streamTotalSent + streamPendingSamples.count
        let running = isInferenceRunning
        let finalizing = isFinalizePending

        // Silence → finalize if minimum segment met
        if isSilence && !finalizing && totalAccumulated >= minSegmentSamples {
            lock.unlock()
            finalizeStreaming()
            return
        }

        // Force finalize if too long
        if !finalizing && totalAccumulated >= streamMaxSamples {
            lock.unlock()
            finalizeStreaming()
            return
        }

        // Trigger decode if enough audio accumulated (silence or not)
        guard !running && !finalizing && totalAccumulated >= streamMinSamples else {
            lock.unlock()
            return
        }

        // Skip decode if audio is too quiet (avoid hallucination on silence)
        // Skip both first decode AND continuation if recent audio is silent
        if recentRMS < 0.005 {
            lock.unlock()
            return
        }

        // Backoff: skip every other decode after 6+ empty decodes, every 3rd after 12+
        if consecutiveEmptyDecodes >= 6 {
            let skipRate = consecutiveEmptyDecodes >= 12 ? 3 : 2
            if (streamTotalSent / streamMinSamples) % skipRate != 0 {
                lock.unlock()
                return
            }
        }

        // Take pending samples for decode (still inside same lock)
        isInferenceRunning = true
        let samplesToSend = streamPendingSamples
        streamPendingSamples.removeAll(keepingCapacity: true)
        lock.unlock()

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            let textBefore = self.lastPartialText
            self.runStreamingDecode(samples: samplesToSend, finalize: false)
            self.lock.lock()
            if self.lastPartialText == textBefore {
                self.consecutiveEmptyDecodes += 1
            } else {
                self.consecutiveEmptyDecodes = 0
            }
            self.isInferenceRunning = false
            self.lock.unlock()
        }

        let perfElapsed = (CFAbsoluteTimeGetCurrent() - perfStart) * 1000.0
        PerformanceTracker.shared.record(stage: "appendSamplesStreaming", durationMs: perfElapsed)
    }

    /// Run one streaming cycle: append audio → encode → AlignAtt decode
    private func runStreamingDecode(samples: [Float], finalize: Bool) {
        guard let ctx else {
            NSLog("[WhisperEngine] runStreamingDecode: ctx nil")
            return
        }
        guard ensureStreamInit() else {
            NSLog("[WhisperEngine] runStreamingDecode: ensureStreamInit failed")
            return
        }
        guard let ss = streamState else {
            NSLog("[WhisperEngine] runStreamingDecode: streamState nil after init")
            return
        }

        // 1. Append audio (only if there are new samples)
        if !samples.isEmpty {
            samples.withUnsafeBufferPointer { buf in
                let _ = whisper_stream_append_audio(ctx, ss, buf.baseAddress, Int32(buf.count))
            }
            lock.lock()
            streamTotalSent += samples.count
            streamAllSentSamples.append(contentsOf: samples)
            // Sliding window: cap memory at ~2s, only last 1s needed for carry-over
            // Use suffix + reassign instead of removeFirst to avoid O(n) memmove
            if streamAllSentSamples.count > streamSlidingWindowSize {
                streamAllSentSamples = Array(streamAllSentSamples.suffix(streamSlidingWindowSize))
            }
            lock.unlock()
        }

        // 2. Encode
        let encodeResult = PerformanceTracker.shared.measure(stage: "whisper_stream_encode") {
            whisper_stream_encode(ctx, ss, 4)
        }
        if encodeResult != 0 {
            NSLog("[WhisperEngine] stream encode FAILED")
            return
        }

        // 3. Set up callback context
        let callbackCtx = WhisperSegmentCallbackContext(engine: self)
        let unmanagedCtx = Unmanaged.passRetained(callbackCtx)

        // 4. Decode with AlignAtt (adaptive threshold)
        // finalize: thr=4 (aggressive, emit all remaining)
        // streaming: adaptive based on audio duration (4/15/20)
        let threshold = finalize ? Int32(4) : adaptiveAlignAttThreshold
        let result = PerformanceTracker.shared.measure(stage: "whisper_stream_decode_alignatt") {
            whisper_stream_decode_alignatt(ctx, ss,
                threshold, 4,
                whisperNewSegmentCallback, unmanagedCtx.toOpaque())
        }

        unmanagedCtx.release()
        NSLog("[WhisperEngine] runStreamingDecode: done (result=%d, finalize=%d)", result, finalize)
    }

    /// Force-finalize streaming: emit all remaining tokens, reset for next segment.
    /// Always carries last 1s of audio for continuity.
    private func finalizeStreaming() {
        lock.lock()
        // Prevent re-entrant finalize spam
        if isFinalizePending {
            lock.unlock()
            return
        }
        isFinalizePending = true
        let remainingSamples = streamPendingSamples
        streamPendingSamples.removeAll(keepingCapacity: true)
        let hasAudio = streamTotalSent > 0 || !remainingSamples.isEmpty
        let segDuration = Float(streamTotalSent + remainingSamples.count) / 16000.0
        let finRMS = recentRMS
        // Reset counters NOW so new audio chunks start fresh
        streamTotalSent = 0
        isInferenceRunning = true
        lock.unlock()

        guard hasAudio else {
            lock.lock(); isInferenceRunning = false; isFinalizePending = false; lock.unlock()
            return
        }

        NSLog("[STT] finalize: dur=%.1fs pending=%d rms=%.4f", segDuration, remainingSamples.count, finRMS)

        inferenceQueue.async { [weak self] in
            guard let self, let ctx = self.ctx, let ss = self.streamState else {
                self?.lock.lock(); self?.isInferenceRunning = false; self?.lock.unlock()
                return
            }

            // Send remaining audio + finalize with thr=4 (AlignAtt, slightly relaxed)
            self.runStreamingDecode(samples: remainingSamples, finalize: true)

            // Collect final text from result_all
            // Note: no_speech probability check is handled inside the C decode_impl
            // via the suppress_nst parameter (already enabled in whisper params).
            // Lightning-SimulWhisper checks no_speech_probs[0] > cfg.nonspeech_prob
            // but their default threshold is 1.0 which effectively disables it.
            let nSeg = whisper_full_n_segments_from_state(ss)
            var finalText = ""
            for i in 0..<nSeg {
                if let cStr = whisper_full_get_segment_text_from_state(ss, i) {
                    let seg = String(cString: cStr).trimmingCharacters(in: .whitespacesAndNewlines)
                    if self.isHallucination(seg) {
                        NSLog("[STT] filtered(hallucination): \"%@\"", seg)
                        continue
                    }
                    if self.isRepeatOfLastSegment(seg) {
                        NSLog("[STT] filtered(repeat): \"%@\"", seg)
                        continue
                    }
                    if seg.isEmpty { continue }
                    if !finalText.isEmpty { finalText += " " }
                    finalText += seg
                }
            }

            // Extract prompt tokens for next segment (Swift controls carry-over policy)
            let maxPromptCarry = 15
            var newPrompt: [Int32] = []
            if nSeg > 0 {
                let lastSeg = nSeg - 1
                let nTok = whisper_full_n_tokens_from_state(ss, lastSeg)
                for j in 0..<nTok {
                    newPrompt.append(whisper_full_get_token_id_from_state(ss, lastSeg, j))
                }
                if newPrompt.count > maxPromptCarry {
                    newPrompt = Array(newPrompt.suffix(maxPromptCarry))
                }
            }

            // Audio carry-over eliminated — prompt tokens alone provide context.
            // Previous carry (0.3s/4800) caused re-decoding repetition.
            let carryOverSamples: [Float] = []

            // Reset streaming state (C only clears, doesn't set policy)
            whisper_stream_reset(ctx, ss)

            self.lock.lock()
            self.streamTotalSent = 0
            self.streamAllSentSamples.removeAll(keepingCapacity: true)
            self.streamInitialized = false
            self.streamPromptTokens = newPrompt
            // Seed next segment with carry-over audio
            // Prepend carry-over by building new array (avoids O(n) insert(at:0))
            if !carryOverSamples.isEmpty {
                var merged = carryOverSamples
                merged.append(contentsOf: self.streamPendingSamples)
                self.streamPendingSamples = merged
            }
            self.isInferenceRunning = false
            self.isFinalizePending = false
            self.lock.unlock()

            // Emit final result, skipping if it's a repeat of a recent segment
            if !finalText.isEmpty && !self.isRepeatOfLastSegment(finalText) {
                self.segmentCount += 1
                NSLog("[STT] segment=%d dur=%.1fs text=\"%@\"", self.segmentCount, segDuration, finalText)
                self.lastFinalizedText = finalText
                self.recordFinalizedText(finalText)
                if self.isBenchmarkMode {
                    self.onFinalResult?(finalText)
                } else {
                    DispatchQueue.main.async { self.onFinalResult?(finalText) }
                }
            } else if !finalText.isEmpty {
                NSLog("[STT] filtered(repeat-final): \"%@\"", finalText)
            }
        }
    }

    func appendPCMBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return }
        appendSamples(Array(UnsafeBufferPointer(start: channelData[0], count: frameCount)))
    }

    private func computeRMS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(samples.count))
        return rms
    }

    // MARK: - Inference

    /// Run inference on all accumulated audio → emit partial result
    /// Partial: no VAD (fast), relies on new_segment_callback for streaming
    private func runPartialInference() {
        lock.lock()
        let samples = audioBuffer
        newSampleCount = 0
        isInferenceRunning = true
        let currentPromptTokens = promptTokens
        lock.unlock()

        guard samples.count >= minInferSize else {
            lock.lock(); isInferenceRunning = false; lock.unlock()
            return
        }

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            let (text, _) = self.runWhisper(on: samples, promptTokens: currentPromptTokens, useVAD: false)
            self.lock.lock()
            self.isInferenceRunning = false
            self.lock.unlock()
            if !text.isEmpty {
                if self.isBenchmarkMode {
                    self.onPartialResult?(text)
                } else {
                    DispatchQueue.main.async { self.onPartialResult?(text) }
                }
            }
        }
    }

    /// Finalize: run inference on all accumulated audio → emit final + clear buffer
    func forceFinalize() {
        if inferenceMode == .streaming {
            finalizeStreaming()
        } else {
            finalizeAndClear()
        }
    }

    private func finalizeAndClear() {
        lock.lock()
        let samples = audioBuffer
        audioBuffer.removeAll()
        newSampleCount = 0
        silentChunkCount = 0
        isInferenceRunning = true
        let currentPromptTokens = promptTokens
        lock.unlock()

        guard samples.count >= minInferSize else {
            lock.lock(); isInferenceRunning = false; lock.unlock()
            return
        }

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            // Finalize uses VAD to filter out music/noise → clean result
            let (text, newTokens) = self.runWhisper(on: samples, promptTokens: currentPromptTokens, useVAD: true)

            self.lock.lock()
            if !newTokens.isEmpty {
                self.promptTokens = newTokens
            }
            self.isInferenceRunning = false
            if !text.isEmpty {
                self.lastFinalText = text
            }
            self.lock.unlock()

            if !text.isEmpty {
                if self.isBenchmarkMode {
                    self.onFinalResult?(text)
                } else {
                    DispatchQueue.main.async { self.onFinalResult?(text) }
                }
            }
        }
    }

    // MARK: - Whisper execution

    private func runWhisper(on samples: [Float], promptTokens: [Int32], useVAD: Bool) -> (text: String, tokens: [Int32]) {
        lock.lock()
        guard let ctx = self.ctx else { lock.unlock(); return ("", []) }
        let domainHint = self.initialPrompt
        let vadPath = self.vadModelPath
        lock.unlock()

        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.single_segment = false
        params.no_timestamps = true
        params.n_threads = 4
        params.suppress_blank = true
        params.suppress_nst = true

        // Hallucination 3-filter: tighter thresholds than defaults
        params.entropy_thold = 1.8       // compression_ratio: 2.4 → 1.8
        params.logprob_thold = -0.8      // logprob: -1.0 → -0.8
        params.no_speech_thold = 0.5     // no_speech: 0.6 → 0.5

        // Silero VAD: only for finalize (clean result), not for partial (too slow ~800ms)
        let enableVAD = useVAD && vadPath != nil

        // Set up new_segment_callback for streaming partial results during inference
        let callbackCtx = WhisperSegmentCallbackContext(engine: self)
        let unmanagedCtx = Unmanaged.passRetained(callbackCtx)
        params.new_segment_callback = whisperNewSegmentCallback
        params.new_segment_callback_user_data = unmanagedCtx.toOpaque()

        var mutablePromptTokens = promptTokens

        // Helper: run whisper_full with all nested withCString scopes kept alive
        func executeWhisperFull() {
            let langStr = whisperLang
            langStr.withCString { langPtr in
                if langStr == "auto" {
                    params.language = nil
                    params.detect_language = true
                } else {
                    params.language = langPtr
                    params.detect_language = false
                }

                let runInference = { () -> Void in
                    if !mutablePromptTokens.isEmpty {
                        mutablePromptTokens.withUnsafeBufferPointer { tokensPtr in
                            params.prompt_tokens = tokensPtr.baseAddress
                            params.prompt_n_tokens = Int32(mutablePromptTokens.count)
                            samples.withUnsafeBufferPointer { bufferPtr in
                                let _ = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(samples.count))
                            }
                        }
                    } else if !domainHint.isEmpty {
                        domainHint.withCString { promptPtr in
                            params.initial_prompt = promptPtr
                            samples.withUnsafeBufferPointer { bufferPtr in
                                let _ = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(samples.count))
                            }
                        }
                    } else {
                        samples.withUnsafeBufferPointer { bufferPtr in
                            let _ = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(samples.count))
                        }
                    }
                }

                if enableVAD, let vadPath {
                    params.vad = true
                    params.vad_params.threshold = 0.45
                    params.vad_params.min_speech_duration_ms = 250
                    params.vad_params.min_silence_duration_ms = 100
                    params.vad_params.speech_pad_ms = 30
                    params.vad_params.samples_overlap = 0.1
                    vadPath.withCString { vadPtr in
                        params.vad_model_path = vadPtr
                        runInference()
                    }
                } else {
                    params.vad = false
                    runInference()
                }
            }
        }

        executeWhisperFull()
        unmanagedCtx.release()

        // Collect text
        let nSegments = whisper_full_n_segments(ctx)
        var result = ""
        for i in 0..<nSegments {
            if let text = whisper_full_get_segment_text(ctx, i) {
                let segment = String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)
                if isHallucination(segment) { continue }
                if segment.isEmpty { continue }
                if !result.isEmpty { result += " " }
                result += segment
            }
        }

        // Extract prompt tokens from last segment
        var newTokens: [Int32] = []
        if nSegments > 0 {
            let lastSeg = nSegments - 1
            let nTokens = whisper_full_n_tokens(ctx, lastSeg)
            for j in 0..<nTokens {
                newTokens.append(whisper_full_get_token_id(ctx, lastSeg, j))
            }
        }

        return (result.trimmingCharacters(in: .whitespacesAndNewlines), newTokens)
    }

    // MARK: - WAV Benchmark Feed

    /// Feed a WAV file directly into the engine for benchmarking.
    /// Reads the file, converts to 16kHz float32, feeds in chunks simulating real-time,
    /// and returns the transcription result with timing info.
    func feedWavFile(path: String, language: String? = "ja") -> [String: Any] {
        guard isModelLoaded, ctx != nil else {
            return ["error": "Model not loaded"]
        }

        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            return ["error": "WAV file not found: \(path)"]
        }

        // Read WAV file
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: url)
        } catch {
            return ["error": "Failed to read WAV: \(error.localizedDescription)"]
        }

        let fileFormat = file.processingFormat
        let frameCount = AVAudioFrameCount(file.length)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: frameCount) else {
            return ["error": "Failed to create buffer"]
        }

        do {
            try file.read(into: buffer)
        } catch {
            return ["error": "Failed to read audio data: \(error.localizedDescription)"]
        }

        // Convert to 16kHz mono float32
        let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        let samples: [Float]

        if fileFormat.sampleRate == 16000 && fileFormat.channelCount == 1 && fileFormat.commonFormat == .pcmFormatFloat32 {
            // Already correct format
            guard let channelData = buffer.floatChannelData else {
                return ["error": "No float channel data"]
            }
            samples = Array(UnsafeBufferPointer(start: channelData[0], count: Int(buffer.frameLength)))
        } else {
            // Need conversion
            guard let converter = AVAudioConverter(from: fileFormat, to: targetFormat) else {
                return ["error": "Failed to create audio converter"]
            }
            let ratio = 16000.0 / fileFormat.sampleRate
            let outputFrameCount = AVAudioFrameCount(Double(frameCount) * ratio)
            guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else {
                return ["error": "Failed to create output buffer"]
            }

            var convError: NSError?
            var consumed = false
            converter.convert(to: outputBuffer, error: &convError) { _, outStatus in
                if consumed {
                    outStatus.pointee = .endOfStream
                    return nil
                }
                consumed = true
                outStatus.pointee = .haveData
                return buffer
            }

            if let convError {
                return ["error": "Conversion error: \(convError.localizedDescription)"]
            }

            guard let channelData = outputBuffer.floatChannelData else {
                return ["error": "No output channel data"]
            }
            samples = Array(UnsafeBufferPointer(start: channelData[0], count: Int(outputBuffer.frameLength)))
        }

        // Enable perf tracking and benchmark mode (bypass DispatchQueue.main deadlock)
        let wasEnabled = PerformanceTracker.shared.isEnabled
        PerformanceTracker.shared.isEnabled = true
        PerformanceTracker.shared.reset()
        isBenchmarkMode = true

        // Feed chunks simulating real-time (1600 samples = 100ms at 16kHz)
        let chunkSize = 1600
        let totalSamples = samples.count

        // Set up result collection
        var finalResult = ""
        var partials: [String] = []

        let benchmarkStart = CFAbsoluteTimeGetCurrent()

        // Set language for recognition
        setLanguage(from: language)

        // Acquire engine
        guard acquire(owner: .mic) else {
            return ["error": "Engine busy"]
        }

        // Set callbacks — capture results directly (no main queue dispatch needed)
        let semaphore = DispatchSemaphore(value: 0)
        let resultLock = NSLock()
        onPartialResult = { text in
            resultLock.lock()
            partials.append(text)
            resultLock.unlock()
        }
        onFinalResult = { text in
            resultLock.lock()
            finalResult = text
            resultLock.unlock()
            semaphore.signal()
        }

        // Feed audio in chunks
        var offset = 0
        while offset < totalSamples {
            let end = min(offset + chunkSize, totalSamples)
            let chunk = Array(samples[offset..<end])
            appendSamples(chunk)
            offset = end
        }

        // Force finalize remaining audio
        forceFinalize()

        // Drain inference queue to ensure finalize completes
        inferenceQueue.sync {}

        // Wait for result (max 30s) — may already be signaled from inferenceQueue
        let waitResult = semaphore.wait(timeout: .now() + 30)

        let benchmarkEnd = CFAbsoluteTimeGetCurrent()
        let totalMs = (benchmarkEnd - benchmarkStart) * 1000.0
        let audioDurationMs = Double(totalSamples) / 16.0  // ms (16 samples/ms at 16kHz)
        let rtf = totalMs / audioDurationMs  // Real-Time Factor

        release(owner: .mic)
        isBenchmarkMode = false

        let perfStats = PerformanceTracker.shared.snapshot()
        PerformanceTracker.shared.isEnabled = wasEnabled

        var result: [String: Any] = [
            "hypothesis": finalResult,
            "partials": partials,
            "audio_duration_ms": round(audioDurationMs * 100) / 100,
            "total_processing_ms": round(totalMs * 100) / 100,
            "rtf": round(rtf * 1000) / 1000,
            "num_samples": totalSamples,
            "timed_out": waitResult == .timedOut,
            "performance": perfStats,
        ]

        return result
    }

    // MARK: - Hallucination filter

    fileprivate func isHallucination(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }

        // Single-character segments are usually fragments/hallucinations
        if trimmed.count == 1 { return true }

        // O(1) exact match — catches ~90% of hallucinations (full-segment matches)
        if Self.hallucinationSet.contains(trimmed) { return true }

        // Substring fallback — for hallucinations embedded in longer text
        for pattern in Self.hallucinationSubstrings {
            if trimmed.contains(pattern) { return true }
        }

        // Bracket-only text: 【...】, [...]  — almost always hallucination
        // Uses pre-compiled NSRegularExpression (avoids re-compilation per call)
        let nsRange = NSRange(trimmed.startIndex..., in: trimmed)
        let bracketStripped = Self.bracketRegex
            .stringByReplacingMatches(in: trimmed, range: nsRange, withTemplate: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if bracketStripped.isEmpty && !trimmed.isEmpty { return true }

        // Repeated single character (e.g., "ああああ", "ブブブブ")
        // Strip prolonged sound marks, flag only if ONE unique char repeated 4+ times
        let stripped = trimmed.filter { $0 != "ー" && $0 != "〜" && $0 != "～" }
        if stripped.count >= 4 && Set(stripped).count == 1 { return true }

        // Repeated words
        let words = trimmed.split(separator: " ")
        if words.count >= 4 && Set(words).count == 1 { return true }

        // Repeated sentences
        let sentences = trimmed.split(whereSeparator: { "。.!?".contains($0) })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if sentences.count >= 3 && Set(sentences).count == 1 { return true }

        return false
    }

}

// MARK: - C API

@_cdecl("whisper_engine_load_model")
public func whisper_engine_load_model(modelPath: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let modelPath else {
        return jsonCString(["loaded": false, "error": "모델 경로가 제공되지 않았습니다."])
    }
    let path = String(cString: modelPath)
    let success = WhisperEngine.shared.loadModel(path: path)
    return jsonCString(["loaded": success, "error": success ? "" : "모델 로드에 실패했습니다."])
}

@_cdecl("whisper_engine_is_model_loaded")
public func whisper_engine_is_model_loaded() -> Bool {
    return WhisperEngine.shared.isModelLoaded
}

@_cdecl("whisper_engine_unload_model")
public func whisper_engine_unload_model() {
    WhisperEngine.shared.unloadModel()
}

@_cdecl("whisper_engine_set_initial_prompt")
public func whisper_engine_set_initial_prompt(prompt: UnsafePointer<CChar>?) {
    WhisperEngine.shared.initialPrompt = prompt.map { String(cString: $0) } ?? ""
}

@_cdecl("whisper_engine_feed_wav")
public func whisper_engine_feed_wav(wavPath: UnsafePointer<CChar>?, language: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let wavPath else {
        return jsonCString(["error": "WAV 경로가 제공되지 않았습니다."])
    }
    let path = String(cString: wavPath)
    let lang = language.map { String(cString: $0) }
    let result = WhisperEngine.shared.feedWavFile(path: path, language: lang)
    return jsonCString(result)
}
