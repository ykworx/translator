import AVFoundation
import Foundation
import Speech

final class SpeechBridgeState {
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
        if #available(macOS 13, *) { request.addsPunctuation = true }

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
