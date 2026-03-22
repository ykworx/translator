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

    let startIdx = totalSegments - nNew
    guard startIdx >= 0 else { return }

    let cbStart = CFAbsoluteTimeGetCurrent()

    var partialText = ""
    for i in startIdx..<totalSegments {
        let nTok = whisper_full_n_tokens_from_state(state, i)
        var segText = ""
        for j in 0..<nTok {
            if let cStr = whisper_full_get_token_text_from_state(ctx, state, i, j) {
                segText += String(cString: cStr)
            }
        }
        let segment = segText.trimmingCharacters(in: .whitespacesAndNewlines)
        if engine.isHallucination(segment) { continue }
        if segment.isEmpty { continue }

        // Speaker turn detection (tinydiarize)
        let speakerTurn = whisper_full_get_segment_speaker_turn_next_from_state(state, i)
        if speakerTurn && !partialText.isEmpty {
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

    private let lock = NSLock()
    private let inferenceQueue = DispatchQueue(label: "transrator.whisper.inference", qos: .userInitiated)

    private var ctx: OpaquePointer?
    private(set) var isModelLoaded = false
    private var currentOwner: Owner = .none
    private var vadModelPath: String?

    /// When true, callbacks fire directly on inference thread (no DispatchQueue.main.async)
    /// Used by feedWavFile to avoid deadlock when main thread is blocked on semaphore
    fileprivate var isBenchmarkMode = false

    /// ggml Silero VAD context (lazy, reused across segments)
    private var vadCtx: OpaquePointer?  // whisper_vad_context *

    // MARK: - Accumulate + Finalize Parameters

    private let stepInterval   = 16_000  // 1s — partial inference trigger (large-v3-turbo decoder is fast enough)
    private let maxDuration    = 160_000 // 10s — force finalize (longer for better context)
    private let minInferSize   = 16_000  // 1.0s minimum for inference

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
        lastFinalizedText = ""
        segmentCount = 0
        if let vctx = vadCtx { whisper_vad_reset_state(vctx) }
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

    /// Monotonically increasing segment counter for structured logging
    private var segmentCount = 0

    /// Last finalized segment text — used to detect cross-segment repetition
    private var lastFinalizedText: String = ""

    func appendSamples(_ samples: [Float]) {
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

    // MARK: - VAD

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
    /// Partial: no VAD (fast), relies on new_segment_callback for incremental results
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
        finalizeAndClear()
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
        params.n_threads = 2  // 2 threads: halves peak CPU with minor latency tradeoff
        params.suppress_blank = true
        params.suppress_nst = true
        params.tdrz_enable = true  // tinydiarize: speaker turn detection

        // Hallucination 3-filter: tighter thresholds than defaults
        params.entropy_thold = 1.8       // compression_ratio: 2.4 → 1.8
        params.logprob_thold = -0.8      // logprob: -1.0 → -0.8
        params.no_speech_thold = 0.5     // no_speech: 0.6 → 0.5

        // Silero VAD: only for finalize (clean result), not for partial (too slow ~800ms)
        let enableVAD = useVAD && vadPath != nil

        // Set up new_segment_callback for partial results during inference
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
