import AVFoundation
import Foundation

/// Shared Whisper STT engine backed by whisper.cpp + CoreML + Silero VAD.
/// Singleton – the medium model is ~769 MB so we only keep one instance in memory.
final class WhisperEngine {
    static let shared = WhisperEngine()

    // MARK: - Types

    enum Owner: String { case mic, appCaption, none }

    // MARK: - Properties

    private let lock = NSLock()
    private let inferenceQueue = DispatchQueue(label: "transrator.whisper.inference", qos: .userInitiated)

    private var ctx: OpaquePointer? // whisper_context*
    private(set) var isModelLoaded = false
    private var currentOwner: Owner = .none

    /// Path to Silero VAD model (bundled with app)
    private var vadModelPath: String?

    /// Audio buffer – raw audio goes here, Silero VAD inside whisper_full filters silence.
    /// 16 kHz mono float32, up to 30 seconds (480 000 samples).
    private let maxSamples = 480_000 // 30s * 16000
    private var audioBuffer: [Float] = []
    private var newSampleCount = 0

    /// Inference scheduling
    private let inferenceThresholdSamples = 32_000 // 2 seconds of audio
    private let maxBufferBeforeFinalize = 400_000 // ~25 seconds
    private var inferenceTimer: DispatchWorkItem?

    /// Simple silence tracking (to know when to finalize)
    /// Still uses energy for silence detection to trigger finalize,
    /// but actual speech filtering is done by Silero VAD inside whisper_full.
    private let silenceRMSThreshold: Float = 0.005
    private var silentChunkCount = 0
    private let silentChunksToFinalize = 15 // ~1.5s of silence at 100ms chunks

    /// Hallucination filter
    private let hallucinationPatterns: [String] = [
        "시청해 주셔서 감사합니다",
        "시청해주셔서 감사합니다",
        "구독과 좋아요",
        "Thank you for watching",
        "Thanks for watching",
        "ご視聴ありがとうございました",
        "Sous-titres",
        "Amara.org",
        "MBC 뉴스",
        "자막 제공",
    ]

    /// Language code for Whisper (e.g. "ko", "ja", "en").
    private var whisperLang = "auto"

    /// Domain hint / initial prompt for decoder context.
    var initialPrompt: String = ""

    /// Previous final result – fed back as context for continuity.
    private var lastFinalText: String = ""

    /// Callbacks (set by the bridge that owns the engine).
    var onPartialResult: ((String) -> Void)?
    var onFinalResult: ((String) -> Void)?

    // MARK: - Model lifecycle

    func loadModel(path: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }

        if ctx != nil {
            whisper_free(ctx)
            ctx = nil
            isModelLoaded = false
        }

        var params = whisper_context_default_params()
        params.use_gpu = true

        let coremlPath = path
            .replacingOccurrences(of: ".bin", with: "-encoder.mlmodelc")
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

        // Resolve Silero VAD model path (bundled in app resources)
        resolveVADModelPath()

        NSLog("[WhisperEngine] Model loaded from %@", path)
        return true
    }

    private func resolveVADModelPath() {
        // Check in app bundle resources first
        if let bundlePath = Bundle.main.path(forResource: "for-tests-silero-v5.1.2-ggml", ofType: "bin") {
            vadModelPath = bundlePath
            NSLog("[WhisperEngine] Silero VAD model found in bundle: %@", bundlePath)
            return
        }

        // Check in Resources directory (Tauri bundles resources here)
        if let resourceURL = Bundle.main.resourceURL {
            let resourcePath = resourceURL
                .appendingPathComponent("for-tests-silero-v5.1.2-ggml.bin")
                .path
            if FileManager.default.fileExists(atPath: resourcePath) {
                vadModelPath = resourcePath
                NSLog("[WhisperEngine] Silero VAD model found in resources: %@", resourcePath)
                return
            }
        }

        // Fallback: check next to the executable
        let execDir = Bundle.main.bundlePath
        let nearExec = (execDir as NSString).appendingPathComponent("for-tests-silero-v5.1.2-ggml.bin")
        if FileManager.default.fileExists(atPath: nearExec) {
            vadModelPath = nearExec
            NSLog("[WhisperEngine] Silero VAD model found near executable: %@", nearExec)
            return
        }

        vadModelPath = nil
        NSLog("[WhisperEngine] Silero VAD model not found, VAD disabled")
    }

    func unloadModel() {
        lock.lock()
        defer { lock.unlock() }

        if ctx != nil {
            whisper_free(ctx)
            ctx = nil
        }
        isModelLoaded = false
        currentOwner = .none
        audioBuffer.removeAll()
        newSampleCount = 0
        silentChunkCount = 0
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
            audioBuffer.removeAll()
            newSampleCount = 0
            silentChunkCount = 0
            inferenceTimer?.cancel()
            inferenceTimer = nil
            onPartialResult = nil
            onFinalResult = nil
            lastFinalText = ""
        }
    }

    // MARK: - Language

    func setLanguage(from localeIdentifier: String?) {
        guard let id = localeIdentifier, !id.isEmpty else {
            whisperLang = "auto"
            return
        }

        let mapping: [String: String] = [
            "ko-KR": "ko", "ko": "ko",
            "ja-JP": "ja", "ja": "ja",
            "en-US": "en", "en-GB": "en", "en": "en",
            "zh-CN": "zh", "zh-TW": "zh", "zh": "zh",
            "es-ES": "es", "es": "es",
            "fr-FR": "fr", "fr": "fr",
            "de-DE": "de", "de": "de",
        ]

        if let mapped = mapping[id] {
            whisperLang = mapped
        } else {
            let prefix = String(id.prefix(2))
            whisperLang = mapping[prefix] ?? "auto"
        }
        NSLog("[WhisperEngine] Language set to: %@", whisperLang)
    }

    // MARK: - Audio input

    /// Append PCM float32 16kHz mono samples.
    /// Audio goes straight into buffer; Silero VAD inside whisper_full handles filtering.
    func appendSamples(_ samples: [Float]) {
        // Track silence for finalize timing
        let rms = computeRMS(samples)
        if rms < silenceRMSThreshold {
            silentChunkCount += 1
            if silentChunkCount >= silentChunksToFinalize {
                silentChunkCount = 0
                // Prolonged silence → finalize whatever we have
                lock.lock()
                let hasAudio = !audioBuffer.isEmpty
                lock.unlock()
                if hasAudio {
                    forceFinalize()
                }
                return
            }
        } else {
            silentChunkCount = 0
        }

        lock.lock()
        audioBuffer.append(contentsOf: samples)
        newSampleCount += samples.count

        if audioBuffer.count > maxSamples {
            let overflow = audioBuffer.count - maxSamples
            audioBuffer.removeFirst(overflow)
        }

        let shouldInfer = newSampleCount >= inferenceThresholdSamples
        let shouldFinalize = audioBuffer.count >= maxBufferBeforeFinalize
        lock.unlock()

        if shouldFinalize {
            forceFinalize()
        } else if shouldInfer {
            scheduleInference()
        }
    }

    /// Append an AVAudioPCMBuffer (must already be 16kHz mono float32).
    func appendPCMBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return }

        let samples = Array(UnsafeBufferPointer(start: channelData[0], count: frameCount))
        appendSamples(samples)
    }

    private func computeRMS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sumSquares: Float = 0
        for s in samples {
            sumSquares += s * s
        }
        return sqrtf(sumSquares / Float(samples.count))
    }

    // MARK: - Inference

    /// Force finalize: run inference immediately on current buffer, then clear.
    func forceFinalize() {
        inferenceTimer?.cancel()
        inferenceTimer = nil

        lock.lock()
        let samples = audioBuffer
        audioBuffer.removeAll()
        newSampleCount = 0
        lock.unlock()

        guard !samples.isEmpty else { return }

        // Skip very short audio (< 0.3s) – likely noise
        guard samples.count >= 4800 else { return }

        inferenceQueue.async { [weak self] in
            guard let self else { return }
            let text = self.runInference(on: samples)
            if !text.isEmpty {
                self.lock.lock()
                self.lastFinalText = text
                self.lock.unlock()
                DispatchQueue.main.async {
                    self.onFinalResult?(text)
                }
            }
        }
    }

    private func scheduleInference() {
        inferenceTimer?.cancel()

        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }

            self.lock.lock()
            let samples = self.audioBuffer
            self.newSampleCount = 0
            self.lock.unlock()

            guard !samples.isEmpty else { return }
            guard samples.count >= 4800 else { return }

            let text = self.runInference(on: samples)
            if !text.isEmpty {
                DispatchQueue.main.async {
                    self.onPartialResult?(text)
                }
            }
        }

        inferenceTimer = item
        inferenceQueue.async(execute: item)
    }

    private func runInference(on samples: [Float]) -> String {
        lock.lock()
        guard let ctx = self.ctx else {
            lock.unlock()
            return ""
        }
        let vadPath = self.vadModelPath
        let prompt = self.initialPrompt
        let prevText = self.lastFinalText
        lock.unlock()

        // Build initial_prompt: domain hint + previous result for context continuity
        let combinedPrompt: String = {
            var parts: [String] = []
            if !prompt.isEmpty { parts.append(prompt) }
            if !prevText.isEmpty { parts.append(prevText) }
            return parts.joined(separator: ". ")
        }()

        var params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
        params.print_realtime = false
        params.print_progress = false
        params.print_timestamps = false
        params.print_special = false
        params.single_segment = false
        params.no_timestamps = true
        params.n_threads = 4

        // Suppress non-speech tokens to reduce hallucination
        params.suppress_blank = true
        params.suppress_nst = true

        // Enable Silero VAD – whisper_full will filter silence automatically
        if let vadPath {
            params.vad = true
            params.vad_params.threshold = 0.45
            params.vad_params.min_speech_duration_ms = 250
            params.vad_params.min_silence_duration_ms = 100
            params.vad_params.speech_pad_ms = 30
            params.vad_params.samples_overlap = 0.1

            vadPath.withCString { pathPtr in
                params.vad_model_path = pathPtr
                setLanguageAndRun(ctx: ctx, params: &params, samples: samples, prompt: combinedPrompt)
            }
        } else {
            setLanguageAndRun(ctx: ctx, params: &params, samples: samples, prompt: combinedPrompt)
        }

        // Collect segments
        let nSegments = whisper_full_n_segments(ctx)
        var result = ""
        for i in 0..<nSegments {
            if let text = whisper_full_get_segment_text(ctx, i) {
                let segment = String(cString: text).trimmingCharacters(in: .whitespacesAndNewlines)

                if isHallucination(segment) {
                    NSLog("[WhisperEngine] Filtered hallucination: %@", segment)
                    continue
                }

                if segment.count <= 1 { continue }

                if !result.isEmpty { result += " " }
                result += segment
            }
        }

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func setLanguageAndRun(ctx: OpaquePointer, params: inout whisper_full_params, samples: [Float], prompt: String) {
        let langStr = whisperLang
        langStr.withCString { langPtr in
            if langStr == "auto" {
                params.language = nil
                params.detect_language = true
            } else {
                params.language = langPtr
                params.detect_language = false
            }

            // Set initial_prompt for decoder context
            if !prompt.isEmpty {
                prompt.withCString { promptPtr in
                    params.initial_prompt = promptPtr
                    samples.withUnsafeBufferPointer { bufferPtr in
                        let ret = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(samples.count))
                        if ret != 0 {
                            NSLog("[WhisperEngine] whisper_full failed with code %d", ret)
                        }
                    }
                }
            } else {
                samples.withUnsafeBufferPointer { bufferPtr in
                    let ret = whisper_full(ctx, params, bufferPtr.baseAddress, Int32(samples.count))
                    if ret != 0 {
                        NSLog("[WhisperEngine] whisper_full failed with code %d", ret)
                    }
                }
            }
        }
    }

    // MARK: - Hallucination filter

    private func isHallucination(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }

        for pattern in hallucinationPatterns {
            if trimmed.contains(pattern) { return true }
        }

        let words = trimmed.split(separator: " ")
        if words.count >= 4 {
            let unique = Set(words)
            if unique.count == 1 { return true }
        }

        return false
    }
}

// MARK: - C API for Rust FFI

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
    let str = prompt.map { String(cString: $0) } ?? ""
    WhisperEngine.shared.initialPrompt = str
}
