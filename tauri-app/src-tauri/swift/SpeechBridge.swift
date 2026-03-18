import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import Speech

private final class SpeechBridgeState {
    static let shared = SpeechBridgeState()

    private let lock = NSLock()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    private var transcript = ""
    private var isRunning = false
    private var isFinal = false
    private var lastError = ""
    private var permissionPromptPending = false
    private var isStopping = false

    func permissionsSnapshot() -> [String: Any] {
        let speechAuthorized = speechAuthorizationStatus() == .authorized
        let micAuthorized = microphoneAuthorizationStatus() == .authorized
        return [
            "authorized": speechAuthorized && micAuthorized,
            "speechAuthorized": speechAuthorized,
            "microphoneAuthorized": micAuthorized,
            "permissionPromptPending": permissionPromptPending
        ]
    }

    func requestPermissions() -> [String: Any] {
        let currentSpeechStatus = speechAuthorizationStatus()
        if currentSpeechStatus == .notDetermined {
            requestSpeechAuthorizationIfNeeded()
            return [
                "authorized": false,
                "speechAuthorized": false,
                "microphoneAuthorized": microphoneAuthorizationStatus() == .authorized,
                "permissionPromptPending": true,
                "error": "음성 인식 권한 팝업을 확인한 뒤 다시 눌러주세요."
            ]
        }
        guard currentSpeechStatus == .authorized else {
            return [
                "authorized": false,
                "speechAuthorized": false,
                "microphoneAuthorized": microphoneAuthorizationStatus() == .authorized,
                "permissionPromptPending": false,
                "error": "음성 인식 권한이 허용되지 않았습니다."
            ]
        }

        let micStatus = microphoneAuthorizationStatus()
        if micStatus == .notDetermined {
            requestMicrophoneAuthorizationIfNeeded()
            return [
                "authorized": false,
                "speechAuthorized": true,
                "microphoneAuthorized": false,
                "permissionPromptPending": true,
                "error": "마이크 권한 팝업을 확인한 뒤 다시 눌러주세요."
            ]
        }

        guard micStatus == .authorized else {
            return [
                "authorized": false,
                "speechAuthorized": true,
                "microphoneAuthorized": false,
                "permissionPromptPending": false,
                "error": "마이크 권한이 허용되지 않았습니다."
            ]
        }

        return [
            "authorized": true,
            "speechAuthorized": true,
            "microphoneAuthorized": true,
            "permissionPromptPending": false
        ]
    }

    func start(localeIdentifier: String?) -> [String: Any] {
        let permissions = requestPermissions()
        guard (permissions["authorized"] as? Bool) == true else {
            return mergeCurrentState(extra: permissions)
        }

        stopRecognition(clearTranscript: false)

        let preferredLocale = (localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.preferredLanguages.first)
            ?? Locale.current.identifier
        let locale = Locale(identifier: preferredLocale)
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            return mergeCurrentState(extra: [
                "error": "선택한 언어의 Apple Speech 인식을 사용할 수 없습니다."
            ])
        }

        self.recognizer = recognizer
        self.request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else {
            return mergeCurrentState(extra: ["error": "음성 인식 요청을 만들 수 없습니다."])
        }

        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false

        do {
            let inputNode = audioEngine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            inputNode.removeTap(onBus: 0)
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                self?.request?.append(buffer)
            }

            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            stopRecognition(clearTranscript: false)
            return mergeCurrentState(extra: [
                "error": "마이크를 시작할 수 없습니다: \(error.localizedDescription)"
            ])
        }

        updateState {
            transcript = ""
            isRunning = true
            isFinal = false
            lastError = ""
            permissionPromptPending = false
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                self.updateState {
                    self.transcript = result.bestTranscription.formattedString
                    self.isFinal = result.isFinal
                }
            }

            if let error {
                self.updateState {
                    self.lastError = error.localizedDescription
                    self.isRunning = false
                }
                self.stopRecognition(clearTranscript: false)
                return
            }

            if let result, result.isFinal {
                self.updateState { self.isRunning = false }
                self.stopRecognition(clearTranscript: false)
            }
        }

        return snapshot()
    }

    func stop() -> [String: Any] {
        stopRecognition(clearTranscript: false)
        return snapshot()
    }

    func currentState() -> [String: Any] {
        mergeCurrentState(extra: permissionsSnapshot())
    }

    private func stopRecognition(clearTranscript: Bool) {
        let taskToCancel: SFSpeechRecognitionTask?

        lock.lock()
        if isStopping {
            lock.unlock()
            return
        }
        isStopping = true
        taskToCancel = task
        task = nil
        let shouldClearTranscript = clearTranscript
        lock.unlock()

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        taskToCancel?.cancel()
        request = nil
        recognizer = nil

        updateState {
            isRunning = false
            if shouldClearTranscript {
                transcript = ""
                isFinal = false
                lastError = ""
                permissionPromptPending = false
            }
            isStopping = false
        }
    }

    private func snapshot() -> [String: Any] {
        lock.lock()
        let transcript = self.transcript
        let isRunning = self.isRunning
        let isFinal = self.isFinal
        let lastError = self.lastError
        lock.unlock()

        var state: [String: Any] = [
            "transcript": transcript,
            "isRunning": isRunning,
            "isFinal": isFinal
        ]
        if !lastError.isEmpty {
            state["error"] = lastError
        }
        return mergeCurrentState(extra: state)
    }

    private func mergeCurrentState(extra: [String: Any]) -> [String: Any] {
        var merged = currentStateBase()
        for (key, value) in extra {
            merged[key] = value
        }
        return merged
    }

    private func currentStateBase() -> [String: Any] {
        lock.lock()
        let transcript = self.transcript
        let isRunning = self.isRunning
        let isFinal = self.isFinal
        let lastError = self.lastError
        lock.unlock()

        var state: [String: Any] = [
            "transcript": transcript,
            "isRunning": isRunning,
            "isFinal": isFinal
        ]
        if !lastError.isEmpty {
            state["error"] = lastError
        }
        return state
    }

    private func updateState(_ update: () -> Void) {
        lock.lock()
        update()
        lock.unlock()
    }

    private func speechAuthorizationStatus() -> SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    private func requestSpeechAuthorizationIfNeeded() {
        updateState { permissionPromptPending = true }
        SFSpeechRecognizer.requestAuthorization { status in
            self.updateState {
                self.permissionPromptPending = false
                if status != .authorized && self.lastError.isEmpty {
                    self.lastError = "음성 인식 권한이 허용되지 않았습니다."
                }
            }
        }
    }

    private func microphoneAuthorizationStatus() -> AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    private func requestMicrophoneAuthorizationIfNeeded() {
        updateState { permissionPromptPending = true }
        AVCaptureDevice.requestAccess(for: .audio) { value in
            self.updateState {
                self.permissionPromptPending = false
                if !value && self.lastError.isEmpty {
                    self.lastError = "마이크 권한이 허용되지 않았습니다."
                }
            }
        }
    }

}

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
private final class AudioDeviceCaptureOutput: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    weak var owner: AppCaptionBridgeState?

    init(owner: AppCaptionBridgeState) {
        self.owner = owner
    }

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        owner?.appendAudioSampleBuffer(sampleBuffer)
    }
}

@available(macOS 13.0, *)
private struct CaptureWindowInfo {
    let id: String
    let name: String
    let window: SCWindow
}

@available(macOS 13.0, *)
private final class AppCaptionBridgeState {
    static let shared = AppCaptionBridgeState()

    private let lock = NSLock()
    private let audioQueue = DispatchQueue(label: "transrator.zoom.audio")

    private var stream: SCStream?
    private var output: ZoomAudioOutput?
    private var captureSession: AVCaptureSession?
    private var deviceOutput: AudioDeviceCaptureOutput?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
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
    private var finalCounter = 0
    private var audioSampleCount: UInt64 = 0
    private var lastPartialText = ""
    private var lastPartialTime: Date = .distantPast
    private var stableTimer: DispatchWorkItem?
    private var lastAudioAtMs: UInt64 = 0
    private var audioLevel: Float = 0

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

    func listAudioDevices() -> [[String: Any]] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInMicrophone, .externalUnknown],
            mediaType: .audio,
            position: .unspecified
        ).devices.map { device in
            [
                "id": device.uniqueID,
                "name": device.localizedName
            ]
        }
    }

    func permissionsSnapshot() -> [String: Any] {
        let speechAuthorized = SFSpeechRecognizer.authorizationStatus() == .authorized
        let audioAuthorized = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let screenAuthorized = CGPreflightScreenCaptureAccess()
        let requiresScreenCapture = captureMode != "audio-device"
        return [
            "authorized": speechAuthorized && audioAuthorized && (!requiresScreenCapture || screenAuthorized),
            "speechAuthorized": speechAuthorized,
            "screenAuthorized": screenAuthorized,
            "permissionPromptPending": permissionPromptPending,
            "sourceApp": sourceApp,
            "captureMode": captureMode
        ]
    }

    func requestPermissions(captureMode: String?) -> [String: Any] {
        let currentSpeechStatus = SFSpeechRecognizer.authorizationStatus()
        if currentSpeechStatus == .notDetermined {
            updateState { permissionPromptPending = true }
            let semaphore = DispatchSemaphore(value: 0)
            SFSpeechRecognizer.requestAuthorization { status in
                self.updateState {
                    self.permissionPromptPending = false
                    if status != .authorized && self.lastError.isEmpty {
                        self.lastError = "음성 인식 권한이 허용되지 않았습니다."
                    }
                }
                semaphore.signal()
            }
            semaphore.wait()
        }

        let speechAuthorized = SFSpeechRecognizer.authorizationStatus() == .authorized
        if !speechAuthorized {
            return mergeCurrentState(extra: [
                "authorized": false,
                "speechAuthorized": false,
                "screenAuthorized": CGPreflightScreenCaptureAccess(),
                "permissionPromptPending": false,
                "error": "음성 인식 권한이 허용되지 않았습니다."
            ])
        }

        let audioAuthorized = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if !audioAuthorized {
            updateState { permissionPromptPending = true }
            let semaphore = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                self.updateState {
                    self.permissionPromptPending = false
                    if !granted && self.lastError.isEmpty {
                        self.lastError = "오디오 입력 권한이 필요합니다."
                    }
                }
                semaphore.signal()
            }
            semaphore.wait()
        }

        let requiresScreenCapture = captureMode != "audio-device"
        let screenAuthorized = CGPreflightScreenCaptureAccess()
        if requiresScreenCapture && !screenAuthorized {
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
                    "speechAuthorized": true,
                    "screenAuthorized": false,
                    "permissionPromptPending": false,
                    "error": "화면 및 시스템 오디오 캡처 권한이 필요합니다."
                ])
            }
        }

        let hasAudioAuthorization = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if !hasAudioAuthorization {
            return mergeCurrentState(extra: [
                "authorized": false,
                "speechAuthorized": true,
                "screenAuthorized": requiresScreenCapture ? screenAuthorized : true,
                "permissionPromptPending": false,
                "error": "오디오 입력 권한이 필요합니다."
            ])
        }

        return mergeCurrentState(extra: [
            "authorized": true,
            "speechAuthorized": true,
            "screenAuthorized": requiresScreenCapture ? screenAuthorized : true,
            "permissionPromptPending": false
        ])
    }

    func start(
        localeIdentifier: String?,
        captureMode: String?,
        windowIdentifier: String?,
        audioDeviceIdentifier: String?
    ) -> [String: Any] {
        let normalizedCaptureMode = captureMode ?? "window"
        let permissions = requestPermissions(captureMode: normalizedCaptureMode)
        guard (permissions["authorized"] as? Bool) == true else {
            return permissions
        }

        _ = stop(clearTranscript: true)

        let preferredLocale = (localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.preferredLanguages.first)
            ?? Locale.current.identifier
        let locale = Locale(identifier: preferredLocale)
        guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
            return mergeCurrentState(extra: [
                "error": "선택한 언어의 Apple Speech 인식을 사용할 수 없습니다."
            ])
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = false
        if #available(macOS 13.0, *) {
            request.addsPunctuation = true
        }

        self.recognizer = recognizer
        self.request = request
        NSLog("[Transrator] Starting recognition task, locale=%@, recognizer.isAvailable=%d", preferredLocale, recognizer.isAvailable ? 1 : 0)
        self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let result {
                let fullText = result.bestTranscription.formattedString
                let delta: String
                if fullText.count > self.committedLength {
                    delta = String(fullText.suffix(fullText.count - self.committedLength)).trimmingCharacters(in: .whitespaces)
                } else {
                    delta = ""
                }

                self.updateState {
                    self.transcript = delta
                    if result.isFinal {
                        self.promoteToFinal(fullText)
                    }
                }

                if !result.isFinal {
                    self.scheduleStableCheck(text: fullText)
                }
            }

            if let error {
                NSLog("[Transrator] Recognition error: %@", error.localizedDescription)
                self.flushPartialAsFinal()
                self.updateState {
                    self.lastError = error.localizedDescription
                    self.isRunning = false
                }
            }
        }

        if normalizedCaptureMode == "audio-device" {
            do {
                try startAudioDeviceCapture(audioDeviceIdentifier: audioDeviceIdentifier)
            } catch {
                updateState {
                    self.lastError = "오디오 입력 장치 캡처를 시작할 수 없습니다: \(error.localizedDescription)"
                    self.isRunning = false
                }
                _ = stop(clearTranscript: false)
            }
            return currentState()
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

                self.updateState {
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
                }
            } catch {
                startError = "앱 오디오 캡처를 시작할 수 없습니다: \(error.localizedDescription)"
            }

            semaphore.signal()
        }
        semaphore.wait()

        if !startError.isEmpty {
            updateState {
                self.lastError = startError
                self.isRunning = false
            }
            _ = stop(clearTranscript: false)
        }

        return currentState()
    }

    func stop(clearTranscript: Bool) -> [String: Any] {
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil

        if let stream {
            Task {
                try? await stream.stopCapture()
            }
        }
        self.stream = nil
        self.output = nil
        self.captureSession?.stopRunning()
        self.captureSession = nil
        self.deviceOutput = nil
        self.audioConverter = nil
        self.stableTimer?.cancel()
        self.stableTimer = nil
        self.committedLength = 0

        updateState {
            self.isRunning = false
            if clearTranscript {
                self.transcript = ""
                self.lastFinalTranscript = ""
                self.lastFinalSegmentId = ""
                self.lastError = ""
                self.lastPartialText = ""
                self.finalCounter = 0
            }
            self.audioSampleCount = 0
            self.lastAudioAtMs = 0
            self.audioLevel = 0
        }

        return currentState()
    }

    func currentState() -> [String: Any] {
        mergeCurrentState(extra: currentStateBase())
    }

    func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let request else { return }
        guard let pcmBuffer = makePCMBuffer(from: sampleBuffer) else { return }
        updateAudioDebug(with: pcmBuffer)

        // Convert to 16kHz mono for SFSpeechRecognizer
        let sourceFormat = pcmBuffer.format
        if audioConverter == nil || audioConverter!.inputFormat != sourceFormat {
            audioConverter = AVAudioConverter(from: sourceFormat, to: speechFormat)
            if audioConverter == nil {
                NSLog("[Transrator] Failed to create audio converter from %@ to %@", sourceFormat.description, speechFormat.description)
            }
        }

        guard let converter = audioConverter else {
            request.append(pcmBuffer)
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

        if let error {
            if audioSampleCount % 500 == 0 {
                NSLog("[Transrator] Audio conversion error: %@", error.localizedDescription)
            }
            return
        }

        if outputBuffer.frameLength > 0 {
            request.append(outputBuffer)
        }
    }

    /// Character count already committed — used to extract delta from cumulative transcript
    private var committedLength = 0

    private func promoteToFinal(_ fullText: String) {
        stableTimer?.cancel()
        stableTimer = nil

        // Use the current transcript (already computed delta) instead of re-extracting
        let delta = transcript.trimmingCharacters(in: .whitespaces)

        // Always update committed length to track position
        committedLength = fullText.count

        guard !delta.isEmpty else { return }

        lastFinalTranscript = delta
        finalCounter += 1
        lastFinalSegmentId = "app-\(finalCounter)"
        lastPartialText = ""
        transcript = ""
        NSLog("[Transrator] Promoted to final #%d: %@", finalCounter, delta)
    }

    private func scheduleStableCheck(text: String) {
        stableTimer?.cancel()
        lastPartialText = text
        lastPartialTime = Date()
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let current = self.lastPartialText
            let shouldPromote = !current.isEmpty && current == text
            self.lock.unlock()
            if shouldPromote {
                self.updateState {
                    self.promoteToFinal(current)
                }
            }
        }
        stableTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: item)
    }

    private func flushPartialAsFinal() {
        stableTimer?.cancel()
        stableTimer = nil
        lock.lock()
        let text = lastPartialText
        lock.unlock()
        if !text.isEmpty {
            updateState {
                self.promoteToFinal(text)
            }
        }
    }

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

    private func updateState(_ update: () -> Void) {
        lock.lock()
        update()
        lock.unlock()
    }

    private func updateAudioDebug(with buffer: AVAudioPCMBuffer) {
        let level = calculateAudioLevel(buffer)
        let now = UInt64(Date().timeIntervalSince1970 * 1000)
        updateState {
            self.audioSampleCount += 1
            self.lastAudioAtMs = now
            self.audioLevel = level
        }
    }

    private static func captureWindows(from shareableContent: SCShareableContent) -> [CaptureWindowInfo] {
        shareableContent.windows
            .compactMap { window in
                let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let appName = window.owningApplication?.applicationName ?? "알 수 없는 앱"
                if title.isEmpty {
                    return nil
                }
                return CaptureWindowInfo(
                    id: String(window.windowID),
                    name: "\(appName) - \(title)",
                    window: window
                )
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

    private func startAudioDeviceCapture(audioDeviceIdentifier: String?) throws {
        let session = AVCaptureSession()
        session.beginConfiguration()

        let device = audioDeviceIdentifier
            .flatMap { AVCaptureDevice(uniqueID: $0) } ?? AVCaptureDevice.default(for: .audio)
        guard let device else {
            throw NSError(domain: "transrator", code: -1001, userInfo: [NSLocalizedDescriptionKey: "오디오 입력 장치를 찾을 수 없습니다."])
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw NSError(domain: "transrator", code: -1002, userInfo: [NSLocalizedDescriptionKey: "오디오 입력 장치를 세션에 추가할 수 없습니다."])
        }
        session.addInput(input)

        let audioOutput = AVCaptureAudioDataOutput()
        let delegate = AudioDeviceCaptureOutput(owner: self)
        audioOutput.setSampleBufferDelegate(delegate, queue: audioQueue)
        guard session.canAddOutput(audioOutput) else {
            throw NSError(domain: "transrator", code: -1003, userInfo: [NSLocalizedDescriptionKey: "오디오 출력 스트림을 세션에 추가할 수 없습니다."])
        }
        session.addOutput(audioOutput)

        session.commitConfiguration()
        session.startRunning()

        updateState {
            self.captureSession = session
            self.deviceOutput = delegate
            self.isRunning = true
            self.lastError = ""
            self.sourceApp = device.localizedName
            self.captureMode = "audio-device"
            self.transcript = ""
            self.lastFinalTranscript = ""
            self.lastFinalSegmentId = ""
            self.audioSampleCount = 0
            self.lastAudioAtMs = 0
            self.audioLevel = 0
        }
    }

    private func calculateAudioLevel(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channelData = buffer.floatChannelData else {
            return 0
        }

        let channelCount = Int(buffer.format.channelCount)
        let frameLength = Int(buffer.frameLength)
        if channelCount == 0 || frameLength == 0 {
            return 0
        }

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
        guard let format = AVAudioFormat(streamDescription: &asbd) else {
            return nil
        }

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
        guard status == noErr else {
            return nil
        }

        return pcmBuffer
    }
}

private func jsonCString(_ payload: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let string = String(data: data, encoding: .utf8) else {
        return strdup("{\"error\":\"json_encoding_failed\"}")
    }
    return strdup(string)
}

private func jsonCString(_ payload: [[String: Any]]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let string = String(data: data, encoding: .utf8) else {
        return strdup("[]")
    }
    return strdup(string)
}

private func runOnMain<T>(_ work: @escaping () -> T) -> T {
    if Thread.isMainThread {
        return autoreleasepool(invoking: work)
    }

    var result: T?
    DispatchQueue.main.sync {
        result = autoreleasepool(invoking: work)
    }
    return result!
}

@_cdecl("speech_request_permissions")
public func speech_request_permissions() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        jsonCString(SpeechBridgeState.shared.currentState().merging(SpeechBridgeState.shared.requestPermissions()) { _, new in new })
    }
}

@_cdecl("speech_start_recognition")
public func speech_start_recognition(localeIdentifier: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        let locale = localeIdentifier.map { String(cString: $0) }
        return jsonCString(SpeechBridgeState.shared.start(localeIdentifier: locale))
    }
}

@_cdecl("speech_stop_recognition")
public func speech_stop_recognition() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        jsonCString(SpeechBridgeState.shared.stop())
    }
}

@_cdecl("speech_get_state")
public func speech_get_state() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        jsonCString(SpeechBridgeState.shared.currentState())
    }
}

@_cdecl("caption_capture_list_windows")
public func caption_capture_list_windows() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.listWindows())
        }
        return jsonCString([])
    }
}

@_cdecl("caption_capture_list_audio_devices")
public func caption_capture_list_audio_devices() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            return jsonCString(AppCaptionBridgeState.shared.listAudioDevices())
        }
        return jsonCString([])
    }
}

@_cdecl("app_caption_request_permissions")
public func app_caption_request_permissions(captureMode: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            let captureMode = captureMode.map { String(cString: $0) }
            return jsonCString(AppCaptionBridgeState.shared.requestPermissions(captureMode: captureMode))
        }
        return jsonCString([
            "authorized": false,
            "speechAuthorized": false,
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
    windowIdentifier: UnsafePointer<CChar>?,
    audioDeviceIdentifier: UnsafePointer<CChar>?
) -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if #available(macOS 13.0, *) {
            let locale = localeIdentifier.map { String(cString: $0) }
            let captureMode = captureMode.map { String(cString: $0) }
            let windowIdentifier = windowIdentifier.map { String(cString: $0) }
            let audioDeviceIdentifier = audioDeviceIdentifier.map { String(cString: $0) }
            return jsonCString(AppCaptionBridgeState.shared.start(
                localeIdentifier: locale,
                captureMode: captureMode,
                windowIdentifier: windowIdentifier,
                audioDeviceIdentifier: audioDeviceIdentifier
            ))
        }
        return jsonCString([
            "authorized": false,
            "speechAuthorized": false,
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
            "speechAuthorized": false,
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

@_cdecl("speech_free_string")
public func speech_free_string(pointer: UnsafeMutablePointer<CChar>?) {
    guard let pointer else { return }
    free(pointer)
}
