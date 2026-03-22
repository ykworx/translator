import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 13.0, *)
private final class ZoomAudioOutput: NSObject, SCStreamOutput {
    weak var owner: AppCaptionBridgeState?

    init(owner: AppCaptionBridgeState) {
        self.owner = owner
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio else { return }
        owner?.appendAudioSampleBuffer(sampleBuffer)
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

    private var stream: SCStream?
    private var output: ZoomAudioOutput?
    private var audioConverter: AVAudioConverter?
    private let speechFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

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
            "authorized": modelLoaded && screenAuthorized,
            "modelLoaded": modelLoaded,
            "screenAuthorized": screenAuthorized,
            "permissionPromptPending": permissionPromptPending,
            "sourceApp": sourceApp,
            "captureMode": captureMode
        ]
    }

    func requestPermissions() -> [String: Any] {
        // Check Whisper model loaded
        guard WhisperEngine.shared.isModelLoaded else {
            return mergeCurrentState(extra: [
                "authorized": false,
                "modelLoaded": false,
                "screenAuthorized": CGPreflightScreenCaptureAccess(),
                "permissionPromptPending": false,
                "error": "Whisper 모델이 로드되지 않았습니다. 설정에서 모델을 먼저 다운로드해주세요."
            ])
        }

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

                let output = ZoomAudioOutput(owner: self)
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
        // Finalize remaining audio
        WhisperEngine.shared.forceFinalize()
        WhisperEngine.shared.release(owner: .appCaption)

        if let stream {
            Task {
                try? await stream.stopCapture()
            }
        }
        self.stream = nil
        self.output = nil
        self.audioConverter = nil
        self.silenceStartMs = 0

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

    func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let pcmBuffer = makePCMBuffer(from: sampleBuffer) else { return }
        updateAudioDebug(with: pcmBuffer)

        let sourceFormat = pcmBuffer.format
        if audioConverter == nil || audioConverter!.inputFormat != sourceFormat {
            audioConverter = AVAudioConverter(from: sourceFormat, to: speechFormat)
        }

        guard let converter = audioConverter else {
            // If formats match, send directly
            if sourceFormat.sampleRate == speechFormat.sampleRate && sourceFormat.channelCount == speechFormat.channelCount {
                WhisperEngine.shared.appendPCMBuffer(pcmBuffer)
            }
            return
        }

        let ratio = speechFormat.sampleRate / sourceFormat.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(pcmBuffer.frameLength) * ratio)
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
            return pcmBuffer
        }

        if error != nil { return }

        if outputBuffer.frameLength > 0 {
            WhisperEngine.shared.appendPCMBuffer(outputBuffer)
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

    private func updateAudioDebug(with buffer: AVAudioPCMBuffer) {
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
                    guard let self, self.isRunning else { return }
                    WhisperEngine.shared.forceFinalize()
                    NSLog("[Transrator] Silence reset: force finalized for speaker change")
                }
            } else if silentFor >= silenceDurationMs {
                silenceStartMs = now - silenceDurationMs
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.isRunning else { return }
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
                let excluded = ["transrator", "control center", "finder", "dock"]
                return !excluded.contains(where: { lowerName.contains($0) }) && !bundleIdLikeInternal(lowerName)
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
