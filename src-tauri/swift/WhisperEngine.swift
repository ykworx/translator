import AVFoundation
import Foundation
import Accelerate

// MARK: - New segment callback context & C function

/// Context passed through whisper's new_segment_callback user_data pointer.
/// Holds an unretained reference to WhisperEngine so the C callback can
/// call back into Swift.
private final class WhisperSegmentCallbackContext {
    weak var engine: WhisperEngine?
    let generation: UInt64
    init(engine: WhisperEngine, generation: UInt64) {
        self.engine = engine
        self.generation = generation
    }
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

    let startIdx = totalSegments - nNew
    guard startIdx >= 0 else { return }

    let cbStart = CFAbsoluteTimeGetCurrent()

    var partialText = ""
    for i in startIdx..<totalSegments {
        let nTok = whisper_full_n_tokens_from_state(state, i)
        var segText = ""
        for j in 0..<nTok {
            if let cStr = whisper_full_get_token_text_from_state(ctx, state, i, j) {
                let tok = String(cString: cStr)
                // Skip special tokens like [_EOT_], [_SOT_], [_BEG_], etc.
                if tok.hasPrefix("[_") && tok.hasSuffix("_]") { continue }
                if tok.hasPrefix("<|") && tok.hasSuffix("|>") { continue }
                segText += tok
            }
        }
        // Replace broken unicode (replacement char U+FFFD) with empty
        let cleaned = segText.replacingOccurrences(of: "\u{FFFD}", with: "")
        let segment = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        if engine.isHallucination(segment) { continue }
        if segment.isEmpty { continue }

        // Speaker turn detection (tinydiarize)
        let speakerTurn = whisper_full_get_segment_speaker_turn_next_from_state(state, i)
        if speakerTurn && !engine.isDictating && !partialText.isEmpty {
            partialText += "\n[화자 전환]\n"
        } else if !partialText.isEmpty {
            partialText += " "
        }
        partialText += segment
    }

    let cbElapsed = (CFAbsoluteTimeGetCurrent() - cbStart) * 1000.0
    PerformanceTracker.shared.record(stage: "newSegmentCallback", durationMs: cbElapsed)

    if !partialText.isEmpty {
        // Cross-segment repetition check
        if engine.isRepeatOfLastSegment(partialText) {
            NSLog("[WhisperEngine] Partial (repeat, skipped): %@", partialText)
            return
        }
        engine.deliverPartial(partialText, generation: callbackCtx.generation)
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

    enum Owner: String { case mic, dictation, appCaption, none }

    /// Optional check before finalize — returns true if finalize should proceed
    /// Used by AppCaptionBridge to inject RNNoise vadProb check
    var shouldFinalize: (() -> Bool)?

    private let lock = NSLock()
    // All C-context access, including warm-up and destruction, is exclusive.
    private let executionLock = NSLock()
    private let inferenceQueue = DispatchQueue(label: "transrator.whisper.inference", qos: .userInitiated)

    private var ctx: OpaquePointer?
    private var modelLoaded = false
    var isModelLoaded: Bool {
        lock.lock(); defer { lock.unlock() }
        return modelLoaded
    }
    private var currentOwner: Owner = .none
    private var sessionGeneration: UInt64 = 0
    private var acceptingSamples = false

    var isDictating: Bool {
        lock.lock(); defer { lock.unlock() }
        return currentOwner == .dictation || currentOwner == .mic
    }

    var isInUse: Bool {
        lock.lock(); defer { lock.unlock() }
        return currentOwner != .none
    }

    func isOwned(by owner: Owner) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return currentOwner == owner
    }

    func captureGeneration(owner: Owner) -> UInt64? {
        lock.lock(); defer { lock.unlock() }
        return currentOwner == owner && acceptingSamples ? sessionGeneration : nil
    }

    func setInitialPrompt(_ hint: String, owner: Owner = .none) {
        lock.lock(); defer { lock.unlock() }
        if currentOwner == .none || currentOwner == owner { initialPrompt = hint }
    }
    // vadModelPath removed — using CoreML VAD instead of ggml

    /// When true, callbacks fire directly on inference thread (no DispatchQueue.main.async)
    /// Used by feedWavFile to avoid deadlock when main thread is blocked on semaphore
    fileprivate var isBenchmarkMode = false

    /// Core ML Silero VAD with OS-selected compute units.
    private var coremlVad: CoreMLVad?
    private var coremlVadLoaded = false
    private var encoderAssetPresent = false

    // MARK: - Accumulate + Finalize Parameters

    private let stepInterval   = 32_000  // 2s — partial inference trigger
    private let maxDuration    = 160_000 // 10s — force finalize (longer for better context)
    private let minInferSize   = 16_000  // 1.0s minimum for finalize
    private let minPartialSize = 32_000  // 2.0s minimum for partial (avoid hallucination)

    /// Audio buffer — grows until finalize, then clears
    private var audioBuffer: [Float] = []
    private var newSampleCount = 0
    private var isInferenceRunning = false

    /// Prompt tokens from last finalized segment — context for next segment
    private var promptTokens: [Int32] = []

    /// Silence detection (fast, RMS-based)
    private let silenceThreshold: Float = 0.005
    private var silence = SilenceTracker() // 1.2s at 16kHz, independent of tap buffer size
    private var shortSegmentDeferred = false  // defer finalize once for short segments

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
        // Common short-word hallucinations from music/silence
        "meme", "Meme", "MEME", "me", "you", "the", "a",
        "bye", "Bye", "oh", "Oh", "hmm", "Hmm",
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

    /// Recent finalized texts for cross-segment repetition detection (ring buffer, last 5)
    private var recentFinalizedTexts: [String] = []

    /// Check if text is a repetition of any recent finalized segment
    fileprivate func isRepeatOfLastSegment(_ text: String) -> Bool {
        if isDictating { return false }
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
            // Long common substring check: any 8-char window match catches near-match repeats
            // (e.g., "あがえても" vs "あがいても" sharing most characters)
            if norm.count >= 8 && prevNorm.count >= 8 {
                let chars = Array(norm)
                for start in 0...(chars.count - 8) {
                    let window = String(chars[start..<start+8])
                    if prevNorm.contains(window) { return true }
                }
            }
        }
        return false
    }

    /// Record finalized text for repetition tracking
    fileprivate func recordFinalizedText(_ text: String) {
        recentFinalizedTexts.append(text)
        if recentFinalizedTexts.count > 15 {
            recentFinalizedTexts.removeFirst()
        }
    }

    private var whisperLang = "auto"
    var initialPrompt: String = ""
    private var lastFinalText: String = ""

    var onPartialResult: ((String) -> Void)?
    var onFinalResult: ((String) -> Void)?

    // MARK: - Model lifecycle

    fileprivate static let warmupGroup = DispatchGroup()

    func loadModel(path: String) -> Bool {
        guard !isInUse else { return false }
        executionLock.lock()
        defer { executionLock.unlock() }
        lock.lock()
        guard currentOwner == .none else { lock.unlock(); return false }
        let previous = ctx
        ctx = nil
        modelLoaded = false
        lock.unlock()
        if let previous { whisper_free(previous) }

        var params = whisper_context_default_params()
        params.use_gpu = true

        let coremlPath = path.replacingOccurrences(of: ".bin", with: "-encoder.mlmodelc")
        encoderAssetPresent = FileManager.default.fileExists(atPath: coremlPath)
        if encoderAssetPresent {
            NSLog("[WhisperEngine] CoreML encoder found at %@", coremlPath)
        } else {
            NSLog("[WhisperEngine] CoreML encoder not found, using GPU/CPU only")
        }

        guard let newCtx = whisper_init_from_file_with_params(path, params) else {
            NSLog("[WhisperEngine] Failed to load model from %@", path)
            return false
        }

        loadCoreMLVad()
        lock.lock()
        ctx = newCtx
        modelLoaded = true
        lock.unlock()
        NSLog("[WhisperEngine] Model loaded from %@", path)

        // Warm-up encode: use enough samples to exceed Whisper's 100ms minimum.
        // CoreML compilation cache + Metal shader cache (~60ms first-encode penalty absorbed here)
        let warmupCtx = newCtx
        WhisperEngine.warmupGroup.enter()
        DispatchQueue.global(qos: .utility).async {
            defer { WhisperEngine.warmupGroup.leave() }
            self.executionLock.lock()
            defer { self.executionLock.unlock() }
            // A reload or unload may have overtaken this queued warm-up.
            guard self.ctx == warmupCtx else { return }
            let silenceSamples = [Float](repeating: 0.0, count: 3200) // 0.2s at 16kHz
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

    private func loadCoreMLVad() {
        let modelName = "silero-vad-coreml.mlmodelc"

        // Try bundle resource
        if let u = Bundle.main.resourceURL {
            let p = u.appendingPathComponent(modelName).path
            if FileManager.default.fileExists(atPath: p) {
                let vad = CoreMLVad()
                if vad.load(path: p) { coremlVad = vad; coremlVadLoaded = true; return }
            }
        }
        // Dev mode: vendor directory
        let execPath = ProcessInfo.processInfo.arguments.first ?? ""
        let execDir = (execPath as NSString).deletingLastPathComponent
        for rel in ["vendor/\(modelName)", "../../vendor/\(modelName)", "../../../vendor/\(modelName)",
                     "../../../../src-tauri/vendor/\(modelName)"] {
            let p = ((execDir as NSString).appendingPathComponent(rel) as NSString).standardizingPath
            if FileManager.default.fileExists(atPath: p) {
                let vad = CoreMLVad()
                if vad.load(path: p) { coremlVad = vad; coremlVadLoaded = true; return }
            }
        }
        NSLog("[WhisperEngine] CoreML VAD not found, finalize will run without VAD")
    }

    @discardableResult
    func unloadModel() -> Bool {
        guard !isInUse else { return false }
        executionLock.lock()
        defer { executionLock.unlock() }
        lock.lock()
        guard currentOwner == .none else { lock.unlock(); return false }
        let previous = ctx
        ctx = nil
        modelLoaded = false
        resetState()
        // Do not hold the state lock during slow Metal/CoreML destruction.
        lock.unlock()
        coremlVad = nil; coremlVadLoaded = false
        if let previous { whisper_free(previous) }
        NSLog("[WhisperEngine] Model unloaded")
        return true
    }

    // MARK: - Owner management

    func acquire(owner: Owner) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard modelLoaded else { return false }
        guard currentOwner == .none else { return false }
        currentOwner = owner
        sessionGeneration &+= 1
        acceptingSamples = true
        return true
    }

    func release(owner: Owner) {
        lock.lock()
        defer { lock.unlock() }
        if currentOwner == owner {
            currentOwner = .none
            sessionGeneration &+= 1
            acceptingSamples = false
            resetState()
            onPartialResult = nil
            onFinalResult = nil
        }
    }

    /// Stop accepting audio, drain the last inference, then deliver completion
    /// after all result callbacks already enqueued on the main queue.
    func finish(owner: Owner, completion: @escaping () -> Void) {
        lock.lock()
        let ownsEngine = currentOwner == owner
        if ownsEngine { acceptingSamples = false }
        lock.unlock()
        guard ownsEngine else { DispatchQueue.main.async(execute: completion); return }
        forceFinalize()
        inferenceQueue.async { DispatchQueue.main.async(execute: completion) }
    }

    fileprivate func deliverPartial(_ text: String, generation: UInt64) {
        let deliver = {
            self.lock.lock()
            let callback = self.sessionGeneration == generation ? self.onPartialResult : nil
            self.lock.unlock()
            callback?(text)
        }
        if isBenchmarkMode { deliver() } else { DispatchQueue.main.async(execute: deliver) }
    }

    private func resetState() {
        audioBuffer.removeAll()
        newSampleCount = 0
        silence.reset()
        promptTokens.removeAll()
        lastFinalText = ""
        isInferenceRunning = false
        lastFinalizedText = ""
        segmentCount = 0
    }

    // MARK: - Language

    func setLanguage(from localeIdentifier: String?) {
        lock.lock()
        defer { lock.unlock() }
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

    /// Monotonically increasing segment counter for structured logging
    private var segmentCount = 0

    /// Last finalized segment text — used to detect cross-segment repetition
    private var lastFinalizedText: String = ""

    func appendSamples(_ samples: [Float], owner: Owner? = nil, generation: UInt64? = nil) {
        // Fast silence detection (RMS)
        let rms = computeRMS(samples)
        // Always append samples to buffer first
        lock.lock()
        guard acceptingSamples, currentOwner != .none else { lock.unlock(); return }
        if let owner, owner != currentOwner { lock.unlock(); return }
        if let generation, generation != sessionGeneration { lock.unlock(); return }
        audioBuffer.append(contentsOf: samples)

        let vadResult = shouldFinalize?() ?? true  // true = vadProb low (no speech)

        if rms < silenceThreshold {
            if silence.append(sampleCount: samples.count, isSilent: true) {
                NSLog("[WhisperEngine] Silence 1.2s: rms=%.4f vadSilent=%d buf=%d", rms, vadResult ? 1 : 0, audioBuffer.count)
                let audioLen = audioBuffer.count
                let hasAudio = audioLen >= minInferSize
                lock.unlock()

                if hasAudio {
                    let minFinalizeSize = 32_000  // 2 seconds
                    if audioLen < minFinalizeSize && !shortSegmentDeferred && !isDictating {
                        shortSegmentDeferred = true
                        silence.reset()
                        return
                    }
                    shortSegmentDeferred = false
                    silence.reset()
                    if self.shouldFinalize?() ?? true {
                        finalizeAndClear()
                    }
                } else {
                    // Buffer too small to process — clear to prevent loop
                    lock.lock()
                    audioBuffer.removeAll()
                    newSampleCount = 0
                    silence.reset()
                    shortSegmentDeferred = false
                    lock.unlock()
                }
                return
            }
            lock.unlock()
        } else {
            silence.reset()
            shortSegmentDeferred = false
            lock.unlock()
        }

        lock.lock()
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

    // MARK: - VAD

    /// Extract speech-only segments using CoreML VAD
    /// Processes audio in 256ms (4096 sample) chunks, concatenates speech segments
    private func extractSpeechSegments(from samples: [Float], detectionSamples: [Float]? = nil, vad: CoreMLVad, threshold: Float = 0.3) -> [Float] {
        vad.resetState()
        let vadStart = CFAbsoluteTimeGetCurrent()
        let chunkSize = CoreMLVad.chunkSize  // 4096 samples = 256ms
        let detectionAudio = detectionSamples.flatMap { $0.count == samples.count ? $0 : nil } ?? samples
        var chunks: [Range<Int>] = []
        var offset = 0
        while offset < samples.count {
            let end = min(offset + chunkSize, samples.count)
            let prob = vad.process(samples: Array(detectionAudio[offset..<end]))
            if prob >= threshold { chunks.append(offset..<end) }
            offset = end
        }
        let speechSamples = SpeechAudioPolicy.speechSamples(samples, chunks: chunks)
        PerformanceTracker.shared.record(stage: "speech_selection", durationMs: (CFAbsoluteTimeGetCurrent() - vadStart) * 1000)
        return speechSamples
    }

    func appendPCMBuffer(_ buffer: AVAudioPCMBuffer, owner: Owner? = nil, generation: UInt64? = nil) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return }
        appendSamples(Array(UnsafeBufferPointer(start: channelData[0], count: frameCount)), owner: owner, generation: generation)
    }

    private func computeRMS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var rms: Float = 0
        vDSP_rmsqv(samples, 1, &rms, vDSP_Length(samples.count))
        return rms
    }

    // MARK: - Inference

    /// Run inference on all accumulated audio → emit partial result
    /// Microphone partials use the same speech gate as finalized results.
    private func runPartialInference() {
        lock.lock()
        guard acceptingSamples else { lock.unlock(); return }
        let samples = audioBuffer
        newSampleCount = 0
        isInferenceRunning = true
        let currentPromptTokens = promptTokens
        let generation = sessionGeneration
        lock.unlock()

        guard samples.count >= minPartialSize else {
            lock.lock(); isInferenceRunning = false; lock.unlock()
            return
        }

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            let (text, _) = self.runWhisper(on: samples, promptTokens: currentPromptTokens, useVAD: false, generation: generation)
            self.lock.lock()
            guard self.sessionGeneration == generation else { self.lock.unlock(); return }
            self.isInferenceRunning = false
            self.lock.unlock()
            if !text.isEmpty {
                self.deliverPartial(text, generation: generation)
            }
        }
    }

    /// Finalize: run inference on all accumulated audio → emit final + clear buffer
    func forceFinalize(endOfInput: Bool = false) {
        if endOfInput {
            lock.lock(); acceptingSamples = false; lock.unlock()
        }
        finalizeAndClear()
    }

    private func finalizeAndClear() {
        lock.lock()
        var samples = audioBuffer
        if currentOwner != .appCaption, currentOwner != .none, !acceptingSamples, !samples.isEmpty, samples.count < minInferSize {
            samples += [Float](repeating: 0, count: minInferSize - samples.count)
        }
        audioBuffer.removeAll()
        newSampleCount = 0
        silence.reset()
        shortSegmentDeferred = false
        isInferenceRunning = true
        let currentPromptTokens = promptTokens
        let generation = sessionGeneration
        lock.unlock()

        guard samples.count >= minInferSize else {
            lock.lock(); isInferenceRunning = false; lock.unlock()
            return
        }

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            // Finalize uses VAD to filter out music/noise → clean result
            let (text, newTokens) = self.runWhisper(on: samples, promptTokens: currentPromptTokens, useVAD: true, generation: generation)

            self.lock.lock()
            guard self.sessionGeneration == generation else { self.lock.unlock(); return }
            if !newTokens.isEmpty {
                // Limit prompt tokens to last 32 to prevent context pollution
                self.promptTokens = newTokens.count > 32 ? Array(newTokens.suffix(32)) : newTokens
            }
            self.isInferenceRunning = false
            let isDuplicate = self.currentOwner == .appCaption && !text.isEmpty && text == self.lastFinalText
            if !text.isEmpty {
                self.lastFinalText = text
            } else {
                // No speech detected — reset prompt to prevent context pollution
                self.promptTokens.removeAll()
            }
            // Check if audio accumulated during finalize inference
            let pendingCount = self.audioBuffer.count
            let shouldPartialNow = pendingCount >= self.minPartialSize
            self.lock.unlock()

            if (!text.isEmpty && !isDuplicate) || (text.isEmpty && self.isDictating) {
                let deliver = {
                    self.lock.lock()
                    let callback = self.sessionGeneration == generation ? self.onFinalResult : nil
                    self.lock.unlock()
                    callback?(text)
                }
                if self.isBenchmarkMode { deliver() } else { DispatchQueue.main.async(execute: deliver) }
            }

            // Immediately trigger partial if audio accumulated during finalize
            if shouldPartialNow {
                self.runPartialInference()
            }
        }
    }

    // MARK: - Whisper execution

    private func runWhisper(on samples: [Float], promptTokens: [Int32], useVAD: Bool, generation: UInt64) -> (text: String, tokens: [Int32]) {
        executionLock.lock()
        defer { executionLock.unlock() }
        lock.lock()
        guard self.sessionGeneration == generation, let ctx = self.ctx else { lock.unlock(); return ("", []) }
        let domainHint = self.initialPrompt
        let dictating = currentOwner == .dictation || currentOwner == .mic
        let language = whisperLang
        lock.unlock()

        // RNNoise is a speech detector input only. Whisper retains the
        // original speech samples: denoising the decoder input degraded our
        // synthetic noisy-speech baseline. Captions have their own denoiser.
        let denoise = dictating && coremlVad != nil &&
            !(isBenchmarkMode && ProcessInfo.processInfo.arguments.contains("--benchmark-no-denoise"))
        var prepared = samples
        if denoise {
            if let cleaned = PerformanceTracker.shared.measure(stage: "rnnoise", { SpeechDenoiser.process(samples) }) {
                prepared = cleaned
            } else {
                // Preserve speech if preprocessing is unavailable; benchmark
                // diagnostics distinguish this fallback from successful gating.
                PerformanceTracker.shared.record(stage: "rnnoise_fallback", durationMs: 0)
            }
        }
        var filteredSamples = samples
        if useVAD || dictating, let vad = coremlVad {
            filteredSamples = extractSpeechSegments(from: samples, detectionSamples: prepared, vad: vad)
            if filteredSamples.isEmpty { return ("", []) }
        }

        var params = whisper_full_default_params(WHISPER_SAMPLING_BEAM_SEARCH)
        params.beam_search.beam_size = 3
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.single_segment = false
        params.no_timestamps = true
        params.n_threads = 2  // 2 threads: beam search decoder doesn't benefit from more on Apple Silicon
        params.suppress_blank = true
        params.suppress_nst = true
        params.tdrz_enable = !dictating

        // Hallucination 3-filter: tighter thresholds than defaults
        params.entropy_thold = 1.8       // compression_ratio: 2.4 → 1.8
        params.logprob_thold = -0.8      // logprob: -1.0 → -0.8
        params.no_speech_thold = 0.5     // no_speech: 0.6 → 0.5

        // CoreML VAD pre-filtering is already done above (filteredSamples)
        // No additional VAD flag needed for whisper_full params

        // Set up new_segment_callback for partial results during inference
        let callbackCtx = WhisperSegmentCallbackContext(engine: self, generation: generation)
        let unmanagedCtx = Unmanaged.passRetained(callbackCtx)
        params.new_segment_callback = whisperNewSegmentCallback
        params.new_segment_callback_user_data = unmanagedCtx.toOpaque()

        let mutablePromptTokens = promptTokens
        var inferenceStatus: Int32 = -1

        // Helper: run whisper_full with all nested withCString scopes kept alive
        func executeWhisperFull() {
            let langStr = language
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
                            filteredSamples.withUnsafeBufferPointer { bufferPtr in
                                inferenceStatus = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(filteredSamples.count))
                            }
                        }
                    } else if !domainHint.isEmpty {
                        domainHint.withCString { promptPtr in
                            params.initial_prompt = promptPtr
                            filteredSamples.withUnsafeBufferPointer { bufferPtr in
                                inferenceStatus = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(filteredSamples.count))
                            }
                        }
                    } else {
                        filteredSamples.withUnsafeBufferPointer { bufferPtr in
                            inferenceStatus = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(filteredSamples.count))
                        }
                    }
                }

                params.vad = false
                runInference()
            }
        }

        executeWhisperFull()
        unmanagedCtx.release()
        guard inferenceStatus == 0 else { return ("", []) }

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
    func feedWavFile(path: String, language: String? = "ja", dictationMode: Bool = false) -> [String: Any] {
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

        let owner: Owner = dictationMode ? .dictation : .appCaption
        guard acquire(owner: owner) else { return ["error": "Engine busy"] }

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
        var collected = DictationTranscript(separator: language?.hasPrefix("ja") == true ? "" : " ")
        var partials: [String] = []

        let benchmarkStart = CFAbsoluteTimeGetCurrent()

        // Set language for recognition
        setLanguage(from: language)

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
            if dictationMode {
                collected.appendFinal(text)
                finalResult = collected.text
            } else { finalResult = text }
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
        forceFinalize(endOfInput: dictationMode)

        // Drain inference queue to ensure finalize completes
        inferenceQueue.sync {}

        // Wait for result (max 30s) — may already be signaled from inferenceQueue
        let waitResult: DispatchTimeoutResult = dictationMode ? .success : semaphore.wait(timeout: .now() + 30)

        let benchmarkEnd = CFAbsoluteTimeGetCurrent()
        let totalMs = (benchmarkEnd - benchmarkStart) * 1000.0
        let audioDurationMs = Double(totalSamples) / 16.0  // ms (16 samples/ms at 16kHz)
        let rtf = totalMs / audioDurationMs  // Real-Time Factor

        release(owner: owner)
        isBenchmarkMode = false

        let perfStats = PerformanceTracker.shared.snapshot()
        PerformanceTracker.shared.isEnabled = wasEnabled

        let result: [String: Any] = [
            "hypothesis": finalResult,
            "partials": partials,
            "audio_duration_ms": round(audioDurationMs * 100) / 100,
            "total_processing_ms": round(totalMs * 100) / 100,
            "rtf": round(rtf * 1000) / 1000,
            "num_samples": totalSamples,
            "timed_out": waitResult == .timedOut,
            "audio_processing": ["vad_loaded": coremlVadLoaded,
                                 "vad_compute_policy": "all (OS-selected CPU/GPU/Neural Engine)",
                                 "metal_requested": true,
                                 "encoder_asset_present": encoderAssetPresent,
                                 "whisper_build_features": String(cString: whisper_print_system_info()),
                                 "rnnoise_gate_requested": dictationMode && coremlVadLoaded && !ProcessInfo.processInfo.arguments.contains("--benchmark-no-denoise")],
            "performance": perfStats,
        ]

        return result
    }

    // MARK: - Hallucination filter

    fileprivate func isHallucination(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        // Caption-specific short-phrase/repetition filters discard legitimate dictation.
        if isDictating { return false }

        // Single-character segments are usually fragments/hallucinations
        if trimmed.count == 1 { return true }

        // Katakana onomatopoeia pattern: katakana-only + contains small kana (ッ, ャ, ュ, ョ etc.) + short
        // e.g., "ハーキッ", "ギャッ" — but NOT "スド", "リレイ", "キス"
        let katakanaOnly = trimmed.allSatisfy { $0 >= "\u{30A0}" && $0 <= "\u{30FF}" || $0 == "ー" }
        let smallKana: Set<Character> = ["ッ", "ャ", "ュ", "ョ", "ァ", "ィ", "ゥ", "ェ", "ォ"]
        let hasSmallKana = trimmed.contains(where: { smallKana.contains($0) })
        if katakanaOnly && hasSmallKana && trimmed.count <= 4 { return true }

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
        let stripped = trimmed.filter { $0 != "ー" && $0 != "〜" && $0 != "～" }
        if stripped.count >= 4 && Set(stripped).count == 1 { return true }

        // Repeated 2-char pattern (e.g., "ヒッヒッヒッ", "ハハハハ")
        if stripped.count >= 4 && Set(stripped).count <= 2 {
            // Check if it's a repeating pattern
            let chars = Array(stripped)
            var isRepeat = true
            let patLen = Set(stripped).count
            for i in patLen..<chars.count {
                if chars[i] != chars[i % patLen] { isRepeat = false; break }
            }
            if isRepeat { return true }
        }

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
    guard !WhisperEngine.shared.isInUse else {
        return jsonCString(["loaded": false, "error": "음성 입력 또는 자막을 중지한 뒤 모델을 변경해주세요."])
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
    WhisperEngine.shared.setInitialPrompt(prompt.map { String(cString: $0) } ?? "")
}

@_cdecl("whisper_engine_feed_wav")
public func whisper_engine_feed_wav(wavPath: UnsafePointer<CChar>?, language: UnsafePointer<CChar>?, dictation: Bool) -> UnsafeMutablePointer<CChar>? {
    guard let wavPath else {
        return jsonCString(["error": "WAV 경로가 제공되지 않았습니다."])
    }
    let path = String(cString: wavPath)
    let lang = language.map { String(cString: $0) }
    let result = WhisperEngine.shared.feedWavFile(path: path, language: lang, dictationMode: dictation)
    return jsonCString(result)
}

@_cdecl("whisper_engine_shutdown")
public func whisper_engine_shutdown() -> Bool {
    WhisperEngine.shared.unloadModel()
}
