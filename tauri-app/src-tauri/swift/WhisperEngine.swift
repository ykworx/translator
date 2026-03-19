import AVFoundation
import Foundation

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

    // Read the newly decoded segments using _from_state variants
    let totalSegments = whisper_full_n_segments_from_state(state)
    let startIdx = totalSegments - nNew
    guard startIdx >= 0 else { return }

    var partialText = ""
    for i in startIdx..<totalSegments {
        if let cStr = whisper_full_get_segment_text_from_state(state, i) {
            let segment = String(cString: cStr).trimmingCharacters(in: .whitespacesAndNewlines)
            if engine.isHallucination(segment) { continue }
            if segment.count <= 1 { continue }
            if !partialText.isEmpty { partialText += " " }
            partialText += segment
        }
    }

    if !partialText.isEmpty {
        let callback = engine.onPartialResult
        DispatchQueue.main.async { callback?(partialText) }
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

    // MARK: - Inference Mode

    var inferenceMode: InferenceMode = .streaming

    // MARK: - Streaming AlignAtt State

    /// Dedicated whisper_state for streaming (created lazily with DTW enabled)
    private var streamState: OpaquePointer?
    private var streamInitialized = false
    /// Buffered PCM samples waiting to be sent to the streaming decoder
    private var streamPendingSamples: [Float] = []
    /// Minimum samples before first streaming decode (~0.5s)
    private let streamMinSamples = 8_000
    /// Maximum accumulated samples before force-finalize (6s)
    private let streamMaxSamples = 96_000
    /// Total PCM samples sent to C-side so far in this segment
    private var streamTotalSent = 0
    /// Guard against re-entrant finalize calls
    private var isFinalizePending = false
    /// AlignAtt frame threshold (12 frames = ~0.24s from audio end)
    private let alignAttFrameThreshold: Int32 = 12
    /// Prompt tokens carried from last finalized streaming segment
    private var streamPromptTokens: [Int32] = []

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

    /// Hallucination filter
    private let hallucinationPatterns: [String] = [
        "시청해 주셔서 감사합니다", "시청해주셔서 감사합니다",
        "구독과 좋아요", "Thank you for watching", "Thanks for watching",
        "ご視聴ありがとうございました", "Sous-titres", "Amara.org",
        "MBC 뉴스", "자막 제공", "【大将】", "【字幕】", "字幕",
    ]

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
        recentFinals.removeAll()
        // Streaming state
        streamInitialized = false
        streamPendingSamples.removeAll()
        streamTotalSent = 0
        isFinalizePending = false
        streamPromptTokens.removeAll()
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

    func appendSamples(_ samples: [Float]) {
        if inferenceMode == .streaming {
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

    /// Streaming path: buffer audio → when ready, encode + AlignAtt decode → emit partial
    private func appendSamplesStreaming(_ samples: [Float]) {
        // Silence detection
        let rms = computeRMS(samples)
        if rms < silenceThreshold {
            silentChunkCount += 1
            if silentChunkCount >= silentChunksForFinalize {
                silentChunkCount = 0
                lock.lock()
                let hasAudio = streamTotalSent > 0 || !streamPendingSamples.isEmpty
                lock.unlock()
                if hasAudio { finalizeStreaming() }
                return
            }
        } else {
            silentChunkCount = 0
        }

        // Always buffer audio — never drop samples
        lock.lock()
        streamPendingSamples.append(contentsOf: samples)
        let totalAccumulated = streamTotalSent + streamPendingSamples.count
        let running = isInferenceRunning
        lock.unlock()

        // Force finalize if too long (but don't spam if already pending)
        lock.lock()
        let finalizing = isFinalizePending
        lock.unlock()

        if !finalizing && totalAccumulated >= streamMaxSamples {
            finalizeStreaming()
            return
        }

        // Don't start new decode if already running/finalizing or not enough audio
        guard !running && !finalizing && totalAccumulated >= streamMinSamples else { return }

        // Take all pending samples and dispatch decode
        lock.lock()
        isInferenceRunning = true
        let samplesToSend = streamPendingSamples
        streamPendingSamples.removeAll(keepingCapacity: true)
        lock.unlock()

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            self.runStreamingDecode(samples: samplesToSend, finalize: false)
            self.lock.lock()
            self.isInferenceRunning = false
            // Check if more samples arrived while we were decoding
            let morePending = self.streamPendingSamples.count >= 1600 // ~100ms
            self.lock.unlock()
            if morePending {
                // Trigger another decode cycle — but avoid silence counter pollution
                self.lock.lock()
                let pending = self.streamPendingSamples
                self.streamPendingSamples.removeAll(keepingCapacity: true)
                self.isInferenceRunning = true
                self.lock.unlock()
                self.runStreamingDecode(samples: pending, finalize: false)
                self.lock.lock()
                self.isInferenceRunning = false
                self.lock.unlock()
            }
        }
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
            lock.unlock()
        }

        // 2. Encode
        if whisper_stream_encode(ctx, ss, 4) != 0 {
            NSLog("[WhisperEngine] stream encode FAILED")
            return
        }

        // 3. Set up callback context
        let callbackCtx = WhisperSegmentCallbackContext(engine: self)
        let unmanagedCtx = Unmanaged.passRetained(callbackCtx)

        // 4. Decode (AlignAtt or finalize)
        var result: Int32 = 0
        if finalize {
            result = whisper_stream_finalize(ctx, ss, 4,
                whisperNewSegmentCallback, unmanagedCtx.toOpaque())
        } else {
            result = whisper_stream_decode_alignatt(ctx, ss,
                alignAttFrameThreshold, 4,
                whisperNewSegmentCallback, unmanagedCtx.toOpaque())
        }

        unmanagedCtx.release()
        NSLog("[WhisperEngine] runStreamingDecode: done (result=%d, finalize=%d)", result, finalize)
    }

    /// Force-finalize streaming: emit all remaining tokens, reset for next segment
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
        // Reset counters NOW so new audio chunks start fresh
        streamTotalSent = 0
        isInferenceRunning = true
        lock.unlock()

        guard hasAudio else {
            lock.lock(); isInferenceRunning = false; isFinalizePending = false; lock.unlock()
            return
        }

        NSLog("[WhisperEngine] finalizeStreaming: remaining=%d", remainingSamples.count)

        inferenceQueue.async { [weak self] in
            guard let self, let ctx = self.ctx, let ss = self.streamState else {
                self?.lock.lock(); self?.isInferenceRunning = false; self?.lock.unlock()
                return
            }

            // Send any remaining buffered audio first
            if !remainingSamples.isEmpty {
                self.runStreamingDecode(samples: remainingSamples, finalize: false)
            }

            // Run finalize (emit all tokens without AlignAtt check)
            self.runStreamingDecode(samples: [], finalize: true)

            // Collect final text from result_all
            let nSeg = whisper_full_n_segments_from_state(ss)
            var finalText = ""
            for i in 0..<nSeg {
                if let cStr = whisper_full_get_segment_text_from_state(ss, i) {
                    let seg = String(cString: cStr).trimmingCharacters(in: .whitespacesAndNewlines)
                    if self.isHallucination(seg) { continue }
                    if seg.count <= 1 { continue }
                    if !finalText.isEmpty { finalText += " " }
                    finalText += seg
                }
            }

            // Extract prompt tokens for context carry-over
            var newPrompt: [Int32] = []
            if nSeg > 0 {
                let lastSeg = nSeg - 1
                let nTok = whisper_full_n_tokens_from_state(ss, lastSeg)
                for j in 0..<nTok {
                    newPrompt.append(whisper_full_get_token_id_from_state(ss, lastSeg, j))
                }
            }

            // Reset streaming for next segment
            whisper_stream_reset(ctx, ss)

            self.lock.lock()
            self.streamTotalSent = 0
            self.streamInitialized = false  // need re-init after reset
            self.streamPromptTokens = newPrompt
            self.isInferenceRunning = false
            self.isFinalizePending = false
            self.lock.unlock()

            if !finalText.isEmpty && !self.isDuplicateFinal(finalText) {
                self.recordFinal(finalText)
                DispatchQueue.main.async { self.onFinalResult?(finalText) }
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
        var sum: Float = 0
        for s in samples { sum += s * s }
        return sqrtf(sum / Float(samples.count))
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
                DispatchQueue.main.async { self.onPartialResult?(text) }
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

            if !text.isEmpty && !self.isDuplicateFinal(text) {
                self.recordFinal(text)
                DispatchQueue.main.async { self.onFinalResult?(text) }
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
                if segment.count <= 1 { continue }
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

    // MARK: - Hallucination filter

    /// Track recently finalized texts to detect cross-session hallucination repeats
    private var recentFinals: [String] = []
    private let maxRecentFinals = 5

    fileprivate func isHallucination(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }

        // Pattern list
        for pattern in hallucinationPatterns {
            if trimmed.contains(pattern) { return true }
        }

        // Bracket-only text: 【...】, [...]  — almost always hallucination
        let bracketStripped = trimmed
            .replacingOccurrences(of: "【[^】]*】", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[[^\\]]*\\]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if bracketStripped.isEmpty && !trimmed.isEmpty { return true }

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

    /// Check if this final text was already emitted recently (cross-finalize hallucination)
    fileprivate func isDuplicateFinal(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let count = recentFinals.filter { $0 == trimmed }.count
        if count >= 1 { return true } // same text already finalized recently
        return false
    }

    fileprivate func recordFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        recentFinals.append(trimmed)
        if recentFinals.count > maxRecentFinals {
            recentFinals.removeFirst()
        }
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
