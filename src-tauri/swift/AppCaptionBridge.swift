import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 13.0, *)
private final class ZoomAudioOutput: NSObject, SCStreamOutput {
    weak var owner: AppCaptionBridgeState?
    private let captureGeneration: UInt64
    private let engineGeneration: UInt64

    init(owner: AppCaptionBridgeState, captureGeneration: UInt64, engineGeneration: UInt64) {
        self.owner = owner
        self.captureGeneration = captureGeneration
        self.engineGeneration = engineGeneration
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        owner?.appendAudioSampleBuffer(sampleBuffer, captureGeneration: captureGeneration,
                                       engineGeneration: engineGeneration)
    }
}

@available(macOS 13.0, *)
private struct CaptureWindowInfo {
    let id: String
    let name: String
    let window: SCWindow
}

// Rust callback for push-based state updates
@_silgen_name("caption_state_changed")
func rustCaptionStateChanged(_ jsonPtr: UnsafePointer<CChar>?)

@available(macOS 13.0, *)
final class AppCaptionBridgeState {
    static let shared = AppCaptionBridgeState()

    private let lock = NSLock()
    private let audioQueue = DispatchQueue(label: "transrator.zoom.audio")
    private var captureGeneration: UInt64 = 0
    private var acceptingAudio = false

    private var stream: SCStream?
    private var output: ZoomAudioOutput?
    private var monoConverter: AVAudioConverter?     // 48kHz 2ch → 48kHz mono
    private var downsampleConverter: AVAudioConverter? // 48kHz mono → 16kHz mono
    private let monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
    private let speechFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    // RNNoise
    private var rnnoiseState: OpaquePointer?  // DenoiseState *
    private var rnnoiseBuffer: [Float] = []   // accumulate samples for 480-frame chunks
    private let rnnoiseFrameSize = 480        // 10ms @ 48kHz
    private var vadProbHistory: [Float] = []   // ring buffer of recent vadProb values
    private let vadProbWindowSize = 80        // 800ms @ 10ms per frame
    private let vadProbThreshold: Float = 0.3 // average below this = no speech

    private var transcript = ""
    private var lastFinalTranscript = ""
    private var lastFinalSegmentId = ""
    private var isRunning = false
    private var lastError = ""
    private var permissionPromptPending = false
    private var sourceApp = "회의 창"
    private var captureMode = "window"
    private var savedLocale = "ko-KR"
    private var finalCounter = 0
    private var audioSampleCount: UInt64 = 0
    private var silenceStartMs: UInt64 = 0
    private let silenceThreshold: Float = 0.01
    private let silenceDurationMs: UInt64 = 700
    private let silenceResetMs: UInt64 = 3000
    private var lastAudioAtMs: UInt64 = 0
    private var audioLevel: Float = 0

    // MARK: - Public API

    func listWindows() -> [[String: Any]] {
        let semaphore = DispatchSemaphore(value: 0)
        var items: [[String: Any]] = []

        Task {
            do {
                let shareableContent = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                items = Self.captureWindows(from: shareableContent).map { window in
                    ["id": window.id, "name": window.name]
                }
            } catch {
                items = []
            }
            semaphore.signal()
        }

        semaphore.wait()
        return items
    }

    func permissionsSnapshot() -> [String: Any] {
        let modelLoaded = WhisperEngine.shared.isModelLoaded
        let screenAuthorized = CGPreflightScreenCaptureAccess()
        return [
            "authorized": screenAuthorized,
            "modelLoaded": modelLoaded,
            "screenAuthorized": screenAuthorized,
            "permissionPromptPending": permissionPromptPending,
            "sourceApp": sourceApp,
            "captureMode": captureMode
        ]
    }

    func requestPermissions() -> [String: Any] {
        let screenAuthorized = CGPreflightScreenCaptureAccess()
        if !screenAuthorized {
            updateState { permissionPromptPending = true }
            let granted = CGRequestScreenCaptureAccess()
            updateState {
                self.permissionPromptPending = false
                if !granted && self.lastError.isEmpty {
                    self.lastError = "화면 및 시스템 오디오 캡처 권한이 필요합니다."
                }
            }
            if !granted {
                return mergeCurrentState(extra: [
                    "authorized": false,
                    "modelLoaded": true,
                    "screenAuthorized": false,
                    "permissionPromptPending": false,
                    "error": "화면 및 시스템 오디오 캡처 권한이 필요합니다."
                ])
            }
        }

        return mergeCurrentState(extra: [
            "authorized": true,
            "modelLoaded": true,
            "screenAuthorized": true,
            "permissionPromptPending": false
        ])
    }

    func start(
        localeIdentifier: String?,
        captureMode: String?,
        windowIdentifier: String?
    ) -> [String: Any] {
        let normalizedCaptureMode = captureMode ?? "window"
        let permissions = requestPermissions()
        guard (permissions["authorized"] as? Bool) == true else {
            return permissions
        }

        _ = stop(clearTranscript: true)

        // Acquire WhisperEngine
        guard WhisperEngine.shared.acquire(owner: .appCaption) else {
            return mergeCurrentState(extra: [
                "error": "Whisper 엔진이 다른 기능에서 사용 중입니다."
            ])
        }
        guard let engineGeneration = WhisperEngine.shared.captureGeneration(owner: .appCaption) else {
            WhisperEngine.shared.release(owner: .appCaption)
            return mergeCurrentState(extra: ["error": "자막 오디오 세션을 준비할 수 없습니다."])
        }
        lock.lock()
        captureGeneration &+= 1
        let generation = captureGeneration
        acceptingAudio = true
        lock.unlock()

        let preferredLocale = (localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.preferredLanguages.first)
            ?? Locale.current.identifier
        self.savedLocale = preferredLocale
        WhisperEngine.shared.setLanguage(from: preferredLocale)

        // Set up WhisperEngine callbacks
        WhisperEngine.shared.onPartialResult = { [weak self] text in
            guard let self else { return }
            self.updateState({
                self.transcript = text
            }, notify: true)
        }
        WhisperEngine.shared.onFinalResult = { [weak self] text in
            guard let self else { return }
            self.updateState({
                self.promoteToFinal(text)
            }, notify: true)
        }

        // RNNoise vadProb check before finalize (800ms window average)
        WhisperEngine.shared.shouldFinalize = { [weak self] in
            guard let self else { return true }
            let history = self.vadProbHistory
            guard !history.isEmpty else { return true }
            let avg = history.reduce(0, +) / Float(history.count)
            return avg < self.vadProbThreshold
        }

        let semaphore = DispatchSemaphore(value: 0)
        var startError = ""
        Task {
            do {
                let shareableContent = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                let captureWindows = Self.captureWindows(from: shareableContent)
                guard !captureWindows.isEmpty else {
                    startError = "열려 있는 캡처 가능 창을 찾을 수 없습니다."
                    semaphore.signal()
                    return
                }

                guard let selectedWindow = Self.selectCaptureWindow(from: captureWindows, windowIdentifier: windowIdentifier) else {
                    startError = "선택한 창을 찾을 수 없습니다. 설정에서 캡처 창을 다시 선택해주세요."
                    semaphore.signal()
                    return
                }

                let configuration = SCStreamConfiguration()
                configuration.capturesAudio = true
                configuration.excludesCurrentProcessAudio = true
                configuration.width = 2
                configuration.height = 2
                configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
                configuration.queueDepth = 3

                let output = ZoomAudioOutput(owner: self, captureGeneration: generation,
                                             engineGeneration: engineGeneration)
                let filter: SCContentFilter
                if normalizedCaptureMode == "app", let app = selectedWindow.window.owningApplication {
                    filter = SCContentFilter(display: shareableContent.displays.first!, including: [app], exceptingWindows: [])
                } else {
                    filter = SCContentFilter(desktopIndependentWindow: selectedWindow.window)
                }
                let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
                try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: self.audioQueue)
                try await stream.startCapture()

                self.updateState({
                    self.stream = stream
                    self.output = output
                    self.isRunning = true
                    self.lastError = ""
                    self.sourceApp = selectedWindow.name
                    self.captureMode = normalizedCaptureMode
                    self.transcript = ""
                    self.lastFinalTranscript = ""
                    self.lastFinalSegmentId = ""
                    self.audioSampleCount = 0
                    self.lastAudioAtMs = 0
                    self.audioLevel = 0
                }, notify: true)
            } catch {
                startError = "앱 오디오 캡처를 시작할 수 없습니다: \(error.localizedDescription)"
            }

            semaphore.signal()
        }
        semaphore.wait()

        if !startError.isEmpty {
            updateState({
                self.lastError = startError
                self.isRunning = false
            }, notify: true)
            _ = stop(clearTranscript: false)
        }

        return currentState()
    }

    func stop(clearTranscript: Bool) -> [String: Any] {
        // Reject queued/late stream callbacks before draining the processing queue.
        // The main queue must not wait for Whisper result callbacks here.
        updateState {
            self.captureGeneration &+= 1
            self.acceptingAudio = false
            self.isRunning = false
        }
        if let stream {
            Task {
                try? await stream.stopCapture()
            }
        }
        self.stream = nil
        self.output = nil
        audioQueue.sync {
            self.monoConverter = nil
            self.downsampleConverter = nil
            self.biquadInitialized = false
            self.hpX1 = 0; self.hpX2 = 0; self.hpY1 = 0; self.hpY2 = 0
            self.lpX1 = 0; self.lpX2 = 0; self.lpY1 = 0; self.lpY2 = 0
            if let state = self.rnnoiseState {
                rnnoise_destroy(state)
                self.rnnoiseState = nil
            }
            self.rnnoiseBuffer.removeAll()
            self.vadProbHistory.removeAll()
            self.silenceStartMs = 0
        }
        if WhisperEngine.shared.isOwned(by: .appCaption) {
            WhisperEngine.shared.shouldFinalize = nil
            WhisperEngine.shared.release(owner: .appCaption)
        }

        updateState({
            self.isRunning = false
            if clearTranscript {
                self.transcript = ""
                self.lastFinalTranscript = ""
                self.lastFinalSegmentId = ""
                self.lastError = ""
                self.finalCounter = 0
            }
            self.audioSampleCount = 0
            self.lastAudioAtMs = 0
            self.audioLevel = 0
        }, notify: true)

        return currentState()
    }

    func currentState() -> [String: Any] {
        mergeCurrentState(extra: currentStateBase())
    }

    // MARK: - Audio processing
    //
    // Pipeline: 48kHz 2ch → 48kHz mono → bandpass (300Hz~3.4kHz) → RNNoise (480 frame) → 16kHz mono → Whisper

    // Biquad bandpass filter state (high-pass 200Hz + low-pass 4kHz)
    private var hpX1: Float = 0, hpX2: Float = 0, hpY1: Float = 0, hpY2: Float = 0
    private var lpX1: Float = 0, lpX2: Float = 0, lpY1: Float = 0, lpY2: Float = 0
    private var biquadInitialized = false
    // High-pass 200Hz @ 48kHz coefficients
    private var hpB0: Float = 0, hpB1: Float = 0, hpB2: Float = 0, hpA1: Float = 0, hpA2: Float = 0
    // Low-pass 4kHz @ 48kHz coefficients
    private var lpB0: Float = 0, lpB1: Float = 0, lpB2: Float = 0, lpA1: Float = 0, lpA2: Float = 0

    private func initBiquad(sampleRate: Double) {
        guard !biquadInitialized else { return }
        biquadInitialized = true

        // High-pass 300Hz
        let hpFreq = 300.0
        let hpW0 = 2.0 * Double.pi * hpFreq / sampleRate
        let hpAlpha = sin(hpW0) / (2.0 * 0.707)
        let hpCosW0 = cos(hpW0)
        let hpA0 = 1.0 + hpAlpha
        hpB0 = Float((1.0 + hpCosW0) / 2.0 / hpA0)
        hpB1 = Float(-(1.0 + hpCosW0) / hpA0)
        hpB2 = hpB0
        hpA1 = Float(-2.0 * hpCosW0 / hpA0)
        hpA2 = Float((1.0 - hpAlpha) / hpA0)

        // Low-pass 3.4kHz
        let lpFreq = 3400.0
        let lpW0 = 2.0 * Double.pi * lpFreq / sampleRate
        let lpAlpha = sin(lpW0) / (2.0 * 0.707)
        let lpCosW0 = cos(lpW0)
        let lpA0 = 1.0 + lpAlpha
        lpB0 = Float((1.0 - lpCosW0) / 2.0 / lpA0)
        lpB1 = Float((1.0 - lpCosW0) / lpA0)
        lpB2 = lpB0
        lpA1 = Float(-2.0 * lpCosW0 / lpA0)
        lpA2 = Float((1.0 - lpAlpha) / lpA0)
    }

    private func applyBandpass(_ samples: UnsafeMutablePointer<Float>, count: Int) {
        for i in 0..<count {
            let x = samples[i]
            // High-pass
            let hpY = hpB0 * x + hpB1 * hpX1 + hpB2 * hpX2 - hpA1 * hpY1 - hpA2 * hpY2
            hpX2 = hpX1; hpX1 = x; hpY2 = hpY1; hpY1 = hpY
            // Low-pass
            let lpY = lpB0 * hpY + lpB1 * lpX1 + lpB2 * lpX2 - lpA1 * lpY1 - lpA2 * lpY2
            lpX2 = lpX1; lpX1 = hpY; lpY2 = lpY1; lpY1 = lpY
            samples[i] = lpY
        }
    }

    private func isCurrentCapture(_ generation: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return acceptingAudio && captureGeneration == generation
    }

    func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer, captureGeneration: UInt64,
                                 engineGeneration: UInt64) {
        guard isCurrentCapture(captureGeneration) else { return }
        guard let pcmBuffer = makePCMBuffer(from: sampleBuffer) else { return }
        updateAudioDebug(with: pcmBuffer, captureGeneration: captureGeneration)

        // Step 1: Convert to 48kHz mono
        let monoBuffer = convertToMono(pcmBuffer)
        guard let monoBuffer else { return }

        // Step 2: Bandpass filter (300Hz~3.4kHz) — disabled
        // if let channelData = monoBuffer.floatChannelData {
        //     initBiquad(sampleRate: 48000)
        //     applyBandpass(channelData[0], count: Int(monoBuffer.frameLength))
        // }

        // Step 3: RNNoise denoise (480-sample frames)
        let denoisedSamples = applyRNNoise(monoBuffer)
        guard !denoisedSamples.isEmpty else { return }

        // Step 3: Downsample 48kHz → 16kHz mono and send to Whisper
        downsampleAndSend(denoisedSamples, engineGeneration: engineGeneration)
    }

    /// Convert any input format to 48kHz mono
    private func convertToMono(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let sourceFormat = buffer.format

        // Already 48kHz mono
        if sourceFormat.sampleRate == 48000 && sourceFormat.channelCount == 1 {
            return buffer
        }

        if monoConverter == nil || monoConverter!.inputFormat != sourceFormat {
            monoConverter = AVAudioConverter(from: sourceFormat, to: monoFormat)
        }
        guard let converter = monoConverter else { return nil }

        let ratio = monoFormat.sampleRate / sourceFormat.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
        guard outputFrameCount > 0,
              let outputBuffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: outputFrameCount) else {
            return nil
        }

        var error: NSError?
        var consumed = false
        converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if error != nil { return nil }
        return outputBuffer.frameLength > 0 ? outputBuffer : nil
    }

    /// Apply RNNoise denoising in 480-sample (10ms) frames
    private func applyRNNoise(_ monoBuffer: AVAudioPCMBuffer) -> [Float] {
        guard let channelData = monoBuffer.floatChannelData else { return [] }
        let frameLength = Int(monoBuffer.frameLength)
        guard frameLength > 0 else { return [] }

        // Lazy init RNNoise
        if rnnoiseState == nil {
            rnnoiseState = rnnoise_create(nil)
            if rnnoiseState == nil {
                // RNNoise failed, pass through raw audio
                return Array(UnsafeBufferPointer(start: channelData[0], count: frameLength))
            }
        }

        // Accumulate samples
        rnnoiseBuffer.append(contentsOf: UnsafeBufferPointer(start: channelData[0], count: frameLength))

        var output: [Float] = []
        output.reserveCapacity(rnnoiseBuffer.count)

        // Process complete 480-sample frames
        while rnnoiseBuffer.count >= rnnoiseFrameSize {
            var frame = Array(rnnoiseBuffer.prefix(rnnoiseFrameSize))
            rnnoiseBuffer.removeFirst(rnnoiseFrameSize)

            // RNNoise expects Float (not Int16), scale to [-32768, 32767] range
            for i in 0..<rnnoiseFrameSize {
                frame[i] *= 32768.0
            }

            let prob = rnnoise_process_frame(rnnoiseState, &frame, frame)
            self.vadProbHistory.append(prob)
            if self.vadProbHistory.count > self.vadProbWindowSize {
                self.vadProbHistory.removeFirst(self.vadProbHistory.count - self.vadProbWindowSize)
            }

            // Scale back to [-1, 1]
            for i in 0..<rnnoiseFrameSize {
                frame[i] /= 32768.0
            }

            output.append(contentsOf: frame)
        }

        return output
    }

    /// Downsample denoised 48kHz mono samples to 16kHz and send to Whisper
    private func downsampleAndSend(_ samples: [Float], engineGeneration: UInt64) {
        guard !samples.isEmpty else { return }

        // Create a 48kHz mono buffer from denoised samples
        let frameCount = AVAudioFrameCount(samples.count)
        guard let inputBuffer = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: frameCount) else { return }
        inputBuffer.frameLength = frameCount
        if let channelData = inputBuffer.floatChannelData {
            samples.withUnsafeBufferPointer { ptr in
                channelData[0].update(from: ptr.baseAddress!, count: samples.count)
            }
        }

        // Convert 48kHz → 16kHz
        if downsampleConverter == nil {
            downsampleConverter = AVAudioConverter(from: monoFormat, to: speechFormat)
        }
        guard let converter = downsampleConverter else {
            // 48kHz input must never be interpreted as Whisper's 16kHz audio.
            return
        }

        let ratio = speechFormat.sampleRate / monoFormat.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(frameCount) * ratio)
        guard outputFrameCount > 0,
              let outputBuffer = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: outputFrameCount) else {
            return
        }

        var error: NSError?
        var consumed = false
        converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return inputBuffer
        }

        if error != nil { return }

        if outputBuffer.frameLength > 0 {
            WhisperEngine.shared.appendPCMBuffer(outputBuffer, owner: .appCaption, generation: engineGeneration)
        }
    }

    // MARK: - Commit judgment

    private func promoteToFinal(_ text: String) {
        let delta = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !delta.isEmpty else { return }

        lastFinalTranscript = delta
        finalCounter += 1
        lastFinalSegmentId = "app-\(finalCounter)"
        transcript = ""
        NSLog("[Transrator] Promoted to final #%d: %@", finalCounter, delta)
    }

    // MARK: - State management

    private func currentStateBase() -> [String: Any] {
        lock.lock()
        let transcript = self.transcript
        let lastFinalTranscript = self.lastFinalTranscript
        let lastFinalSegmentId = self.lastFinalSegmentId
        let isRunning = self.isRunning
        let lastError = self.lastError
        let sourceApp = self.sourceApp
        let captureMode = self.captureMode
        let audioSampleCount = self.audioSampleCount
        let lastAudioAtMs = self.lastAudioAtMs
        let audioLevel = self.audioLevel
        lock.unlock()

        var payload: [String: Any] = [
            "transcript": transcript,
            "lastFinalTranscript": lastFinalTranscript,
            "isRunning": isRunning,
            "sourceApp": sourceApp,
            "captureMode": captureMode,
            "audioSampleCount": audioSampleCount,
            "lastAudioAtMs": lastAudioAtMs,
            "audioLevel": audioLevel
        ]
        if !lastFinalSegmentId.isEmpty {
            payload["lastFinalSegmentId"] = lastFinalSegmentId
        }
        if !lastError.isEmpty {
            payload["error"] = lastError
        }
        return payload
    }

    private func mergeCurrentState(extra: [String: Any]) -> [String: Any] {
        var merged = permissionsSnapshot()
        for (key, value) in currentStateBase() {
            merged[key] = value
        }
        for (key, value) in extra {
            merged[key] = value
        }
        return merged
    }

    private func updateState(_ update: () -> Void, notify: Bool = false) {
        lock.lock()
        update()
        lock.unlock()
        if notify { notifyRust() }
    }

    private func notifyRust() {
        let payload = currentStateBase()
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        json.withCString { ptr in
            rustCaptionStateChanged(ptr)
        }
    }

    // MARK: - Audio utilities

    private func updateAudioDebug(with buffer: AVAudioPCMBuffer, captureGeneration: UInt64) {
        let level = calculateAudioLevel(buffer)
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        updateState {
            self.audioSampleCount += 1
            self.lastAudioAtMs = now
            self.audioLevel = level
        }

        // Silence detection: 700ms → force finalize, 3s → force finalize + fresh start
        if level < silenceThreshold {
            if silenceStartMs == 0 { silenceStartMs = now }
            let silentFor = now - silenceStartMs
            if silentFor >= silenceResetMs {
                silenceStartMs = 0
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.isCurrentCapture(captureGeneration) else { return }
                    WhisperEngine.shared.forceFinalize()
                    NSLog("[Transrator] Silence reset: force finalized for speaker change")
                }
            } else if silentFor >= silenceDurationMs {
                silenceStartMs = now - silenceDurationMs
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.isCurrentCapture(captureGeneration) else { return }
                    WhisperEngine.shared.forceFinalize()
                }
            }
        } else {
            silenceStartMs = 0
        }
    }

    private static func captureWindows(from shareableContent: SCShareableContent) -> [CaptureWindowInfo] {
        shareableContent.windows
            .compactMap { window in
                let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let appName = window.owningApplication?.applicationName ?? "알 수 없는 앱"
                if title.isEmpty { return nil }
                return CaptureWindowInfo(id: String(window.windowID), name: "\(appName) - \(title)", window: window)
            }
            .filter { item in
                let lowerName = item.name.lowercased()
                let appBundleId = item.window.owningApplication?.bundleIdentifier.lowercased() ?? ""

                // Apps that never produce meaningful audio
                let excludedNames = [
                    "transrator", "control center", "finder", "dock",
                    "system preferences", "system settings", "시스템 설정",
                    "activity monitor", "활성 상태 보기",
                    "terminal", "iterm", "warp", "alacritty", "kitty",
                    "textedit", "메모", "notes", "calculator", "계산기",
                    "preview", "미리보기", "font book", "keychain access",
                    "disk utility", "디스크 유틸리티", "console", "콘솔",
                    "xcode", "visual studio code", "cursor",
                    "archive utility", "installer", "migration assistant",
                    "screenshot", "스크린샷", "automator", "script editor",
                    "bluetooth file exchange", "directory utility",
                ]
                let excludedBundleIds = [
                    "com.apple.finder", "com.apple.dock",
                    "com.apple.controlcenter", "com.apple.systempreferences",
                    "com.apple.systemsettings", "com.apple.ActivityMonitor",
                    "com.apple.Terminal", "com.googlecode.iterm2",
                    "com.apple.TextEdit", "com.apple.Notes",
                    "com.apple.Preview", "com.apple.calculator",
                    "com.apple.dt.Xcode", "com.microsoft.VSCode",
                    "com.apple.ScriptEditor2", "com.apple.Automator",
                    "com.apple.DiskUtility", "com.apple.KeychainAccess",
                    "com.apple.Console", "com.apple.FontBook",
                ]

                if excludedNames.contains(where: { lowerName.contains($0) }) { return false }
                if excludedBundleIds.contains(where: { appBundleId.contains($0) }) { return false }
                if bundleIdLikeInternal(lowerName) { return false }
                return true
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private static func selectCaptureWindow(from windows: [CaptureWindowInfo], windowIdentifier: String?) -> CaptureWindowInfo? {
        guard let windowIdentifier, !windowIdentifier.isEmpty else {
            return windows.first
        }
        return windows.first(where: { $0.id == windowIdentifier || $0.name == windowIdentifier })
    }

    private static func bundleIdLikeInternal(_ lowerName: String) -> Bool {
        lowerName.contains("window server")
    }

    private func calculateAudioLevel(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else { return 0 }
        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        if channelCount == 0 || frameLength == 0 { return 0 }
        var maxValue: Float = 0
        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for frame in 0..<frameLength {
                maxValue = max(maxValue, abs(samples[frame]))
            }
        }
        return maxValue
    }

    private func makePCMBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }

        var asbd = asbdPointer.pointee
        guard let format = AVAudioFormat(streamDescription: &asbd) else { return nil }

        let frameCount = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frameCount > 0,
              let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return nil
        }
        pcmBuffer.frameLength = frameCount

        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frameCount),
            into: pcmBuffer.mutableAudioBufferList
        )
        guard status == noErr else { return nil }

        return pcmBuffer
    }
}

// MARK: - C API

@_cdecl("caption_capture_list_windows")
public func caption_capture_list_windows() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.listWindows())
        }
        return jsonCString([])
    }
}

@_cdecl("app_caption_request_permissions")
public func app_caption_request_permissions() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.requestPermissions())
        }
        return jsonCString([
            "authorized": false,
            "modelLoaded": false,
            "screenAuthorized": false,
            "permissionPromptPending": false,
            "error": "앱 실시간 자막은 macOS 13 이상에서 지원됩니다.",
            "transcript": "",
            "lastFinalTranscript": "",
            "isRunning": false,
            "sourceApp": "회의 앱"
        ])
    }
}

@_cdecl("app_caption_start")
public func app_caption_start(
    localeIdentifier: UnsafePointer<CChar>?,
    captureMode: UnsafePointer<CChar>?,
    windowIdentifier: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            let locale = localeIdentifier.map { String(cString: $0) }
            let captureMode = captureMode.map { String(cString: $0) }
            let windowIdentifier = windowIdentifier.map { String(cString: $0) }
            return jsonCString(AppCaptionBridgeState.shared.start(
                localeIdentifier: locale,
                captureMode: captureMode,
                windowIdentifier: windowIdentifier
            ))
        }
        return jsonCString([
            "authorized": false,
            "error": "앱 실시간 자막은 macOS 13 이상에서 지원됩니다.",
            "transcript": "",
            "lastFinalTranscript": "",
            "isRunning": false,
            "sourceApp": "회의 앱"
        ])
    }
}

@_cdecl("app_caption_stop")
public func app_caption_stop() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.stop(clearTranscript: true))
        }
        return jsonCString([
            "transcript": "",
            "lastFinalTranscript": "",
            "isRunning": false,
            "sourceApp": "회의 앱"
        ])
    }
}

@_cdecl("app_caption_get_state")
public func app_caption_get_state() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.currentState())
        }
        return jsonCString([
            "authorized": false,
            "error": "앱 실시간 자막은 macOS 13 이상에서 지원됩니다.",
            "transcript": "",
            "lastFinalTranscript": "",
            "isRunning": false,
            "sourceApp": "회의 앱"
        ])
    }
}

// ─── Interactive Window Picker ───

import AppKit

/// Picks a window by listening for the next global mouse click, then finding the window at that position.
@_cdecl("caption_capture_pick_window_interactive")
public func caption_capture_pick_window_interactive() -> UnsafeMutablePointer<CChar>? {
    var resultPtr: UnsafeMutablePointer<CChar>? = nil
    let semaphore = DispatchSemaphore(value: 0)
    let currentPID = ProcessInfo.processInfo.processIdentifier

    DispatchQueue.main.async {
        var clickMonitor: Any?
        var keyMonitor: Any?

        func cleanup() {
            NSCursor.pop()
            if let m = clickMonitor { NSEvent.removeMonitor(m) }
            if let m = keyMonitor { NSEvent.removeMonitor(m) }
        }

        func findWindowAtPoint(_ nsPoint: NSPoint) -> [String: Any]? {
            // Convert NS coords (bottom-left) to CG coords (top-left)
            let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
            let cgPoint = CGPoint(x: nsPoint.x, y: primaryHeight - nsPoint.y)

            guard let windowList = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
            ) as? [[String: Any]] else { return nil }

            for window in windowList {
                guard let boundsDict = window[kCGWindowBounds as String] as? [String: Any],
                      let ownerName = window[kCGWindowOwnerName as String] as? String,
                      let ownerPID = window[kCGWindowOwnerPID as String] as? Int32,
                      let layer = window[kCGWindowLayer as String] as? Int32,
                      layer == 0,
                      ownerPID != currentPID
                else { continue }

                let wx = (boundsDict["X"] as? NSNumber)?.doubleValue ?? 0
                let wy = (boundsDict["Y"] as? NSNumber)?.doubleValue ?? 0
                let ww = (boundsDict["Width"] as? NSNumber)?.doubleValue ?? 0
                let wh = (boundsDict["Height"] as? NSNumber)?.doubleValue ?? 0

                if cgPoint.x >= wx && cgPoint.x <= wx + ww && cgPoint.y >= wy && cgPoint.y <= wy + wh {
                    let title = window[kCGWindowName as String] as? String ?? ""
                    let displayName = title.isEmpty ? ownerName : "\(ownerName) - \(title)"
                    let windowNumber = window[kCGWindowNumber as String] as? Int ?? 0
                    return ["id": String(windowNumber), "name": displayName]
                }
            }
            return nil
        }

        // Push crosshair cursor
        NSCursor.crosshair.push()

        // Listen for global click (works on any window, not just ours)
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { event in
            cleanup()
            let clickPos = NSEvent.mouseLocation
            if let info = findWindowAtPoint(clickPos),
               let data = try? JSONSerialization.data(withJSONObject: info),
               let str = String(data: data, encoding: .utf8) {
                resultPtr = strdup(str)
            } else {
                resultPtr = strdup("{\"error\":\"마우스 위치에 캡처 가능한 창을 찾을 수 없습니다.\"}")
            }
            semaphore.signal()
        }

        // Listen for Escape to cancel
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            if event.keyCode == 53 {
                cleanup()
                resultPtr = strdup("{\"error\":\"cancelled\"}")
                semaphore.signal()
            }
        }
    }

    semaphore.wait()
    return resultPtr
}

