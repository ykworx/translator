import AVFoundation
import Foundation

final class SpeechBridgeState {
    static let shared = SpeechBridgeState()

    private let lock = NSLock()
    private let audioEngine = AVAudioEngine()
    private var audioConverter: AVAudioConverter?
    private let whisperFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    private var transcript = ""
    private var isRunning = false
    private var isFinal = false
    private var lastError = ""
    private var permissionPromptPending = false
    private var isStopping = false

    func permissionsSnapshot() -> [String: Any] {
        let modelLoaded = WhisperEngine.shared.isModelLoaded
        let micAuthorized = microphoneAuthorizationStatus() == .authorized
        return [
            "authorized": modelLoaded && micAuthorized,
            "modelLoaded": modelLoaded,
            "microphoneAuthorized": micAuthorized,
            "permissionPromptPending": permissionPromptPending
        ]
    }

    func requestPermissions() -> [String: Any] {
        // Check Whisper model loaded
        guard WhisperEngine.shared.isModelLoaded else {
            return [
                "authorized": false,
                "modelLoaded": false,
                "microphoneAuthorized": microphoneAuthorizationStatus() == .authorized,
                "permissionPromptPending": false,
                "error": "Whisper 모델이 로드되지 않았습니다. 설정에서 모델을 먼저 다운로드해주세요."
            ]
        }

        let micStatus = microphoneAuthorizationStatus()
        if micStatus == .notDetermined {
            requestMicrophoneAuthorizationIfNeeded()
            return [
                "authorized": false,
                "modelLoaded": true,
                "microphoneAuthorized": false,
                "permissionPromptPending": true,
                "error": "마이크 권한 팝업을 확인한 뒤 다시 눌러주세요."
            ]
        }

        guard micStatus == .authorized else {
            return [
                "authorized": false,
                "modelLoaded": true,
                "microphoneAuthorized": false,
                "permissionPromptPending": false,
                "error": "마이크 권한이 허용되지 않았습니다."
            ]
        }

        return [
            "authorized": true,
            "modelLoaded": true,
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

        // Acquire WhisperEngine
        guard WhisperEngine.shared.acquire(owner: .mic) else {
            return mergeCurrentState(extra: [
                "error": "Whisper 엔진이 다른 기능에서 사용 중입니다."
            ])
        }

        // Set language
        let preferredLocale = (localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.preferredLanguages.first)
            ?? Locale.current.identifier
        WhisperEngine.shared.setLanguage(from: preferredLocale)

        // Set up callbacks
        WhisperEngine.shared.onPartialResult = { [weak self] text in
            self?.updateState {
                self?.transcript = text
                self?.isFinal = false
            }
        }
        WhisperEngine.shared.onFinalResult = { [weak self] text in
            self?.updateState {
                self?.transcript = text
                self?.isFinal = true
            }
        }

        do {
            let inputNode = audioEngine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            inputNode.removeTap(onBus: 0)

            // Set up audio converter from mic format to 16kHz mono float32
            audioConverter = AVAudioConverter(from: inputFormat, to: whisperFormat)

            inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
                guard let self else { return }
                if let converted = self.convertToWhisperFormat(buffer) {
                    WhisperEngine.shared.appendPCMBuffer(converted)
                }
            }

            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            WhisperEngine.shared.release(owner: .mic)
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

        return snapshot()
    }

    func stop() -> [String: Any] {
        stopRecognition(clearTranscript: false)
        return snapshot()
    }

    func currentState() -> [String: Any] {
        mergeCurrentState(extra: permissionsSnapshot())
    }

    private func convertToWhisperFormat(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let converter = audioConverter else { return nil }

        let ratio = whisperFormat.sampleRate / buffer.format.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
        guard outputFrameCount > 0,
              let outputBuffer = AVAudioPCMBuffer(pcmFormat: whisperFormat, frameCapacity: outputFrameCount) else {
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

        if error != nil || outputBuffer.frameLength == 0 { return nil }
        return outputBuffer
    }

    private func stopRecognition(clearTranscript: Bool) {
        lock.lock()
        if isStopping {
            lock.unlock()
            return
        }
        isStopping = true
        let shouldClearTranscript = clearTranscript
        lock.unlock()

        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioConverter = nil

        // Finalize any remaining audio in Whisper
        WhisperEngine.shared.forceFinalize()
        WhisperEngine.shared.release(owner: .mic)

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

// MARK: - C API

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
