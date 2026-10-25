import AVFoundation
import Foundation

final class SpeechBridgeState {
    static let shared = SpeechBridgeState()

    private let lock = NSLock()
    private let audioEngine = AVAudioEngine()
    private let audioQueue = DispatchQueue(label: "transrator.microphone.audio", qos: .userInitiated)
    private var audioConverter: AVAudioConverter?
    private let whisperFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!

    // A single persistent converter preserves filter history between tap buffers.
    private var reusableOutputBuffer: AVAudioPCMBuffer?

    private var transcript = ""
    private var isRunning = false
    private var isFinal = false
    private var lastError = ""
    private var permissionPromptPending = false
    private var isStopping = false
    private var owner: WhisperEngine.Owner = .mic
    private var accumulated = DictationTranscript()

    func permissionsSnapshot() -> [String: Any] {
        let modelLoaded = WhisperEngine.shared.isModelLoaded
        let micAuthorized = microphoneAuthorizationStatus() == .authorized
        return [
            "authorized": micAuthorized,
            "modelLoaded": modelLoaded,
            "microphoneAuthorized": micAuthorized,
            "permissionPromptPending": permissionPromptPending
        ]
    }

    func requestPermissions() -> [String: Any] {
        let micStatus = microphoneAuthorizationStatus()
        if micStatus == .notDetermined {
            requestMicrophoneAuthorizationIfNeeded()
            return [
                "authorized": false,
                "modelLoaded": WhisperEngine.shared.isModelLoaded,
                "microphoneAuthorized": false,
                "permissionPromptPending": true,
                "error": "마이크 권한 팝업을 확인한 뒤 다시 눌러주세요."
            ]
        }

        guard micStatus == .authorized else {
            return [
                "authorized": false,
                "modelLoaded": WhisperEngine.shared.isModelLoaded,
                "microphoneAuthorized": false,
                "permissionPromptPending": false,
                "error": "마이크 권한이 허용되지 않았습니다."
            ]
        }

        return [
            "authorized": true,
            "modelLoaded": WhisperEngine.shared.isModelLoaded,
            "microphoneAuthorized": true,
            "permissionPromptPending": false
        ]
    }

    func start(localeIdentifier: String?, dictation: Bool = false, hint: String? = nil, microphone: String = "") -> [String: Any] {
        let permissions = requestPermissions()
        guard (permissions["authorized"] as? Bool) == true else {
            return mergeCurrentState(extra: permissions)
        }

        guard !isRunning, !isStopping else {
            return mergeCurrentState(extra: ["error": "마이크가 이미 사용 중입니다."])
        }

        // Acquire WhisperEngine
        let requestedOwner: WhisperEngine.Owner = dictation ? .dictation : .mic
        guard WhisperEngine.shared.acquire(owner: requestedOwner) else {
            return mergeCurrentState(extra: [
                "error": "Whisper 엔진이 다른 기능에서 사용 중입니다."
            ])
        }
        owner = requestedOwner
        guard let generation = WhisperEngine.shared.captureGeneration(owner: requestedOwner) else {
            return mergeCurrentState(extra: ["error": "음성 세션을 준비할 수 없습니다."])
        }
        let cjk = localeIdentifier?.hasPrefix("ja") == true || localeIdentifier?.hasPrefix("zh") == true
        accumulated = DictationTranscript(separator: cjk ? "" : " ")
        if let hint { WhisperEngine.shared.setInitialPrompt(hint, owner: requestedOwner) }

        // Set language
        let preferredLocale = (localeIdentifier?.isEmpty == false ? localeIdentifier! : Locale.preferredLanguages.first)
            ?? Locale.current.identifier
        WhisperEngine.shared.setLanguage(from: preferredLocale)

        // Set up callbacks
        WhisperEngine.shared.onPartialResult = { [weak self] text in
            self?.updateState {
                if let self {
                    self.accumulated.partial = text
                    self.transcript = self.accumulated.text
                }
                self?.isFinal = false
            }
        }
        WhisperEngine.shared.onFinalResult = { [weak self] text in
            self?.updateState {
                if let self {
                    self.accumulated.appendFinal(text)
                    self.transcript = self.accumulated.text
                }
                self?.isFinal = true
            }
        }

        do {
            try MicrophoneDevices.configure(engine: audioEngine, uid: microphone)
            let inputNode = audioEngine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                throw NSError(domain: "Transrator", code: 1, userInfo: [NSLocalizedDescriptionKey: "사용 가능한 마이크가 없습니다."])
            }
            inputNode.removeTap(onBus: 0)

            audioConverter = AVAudioConverter(from: inputFormat, to: whisperFormat)
            guard audioConverter != nil else {
                throw NSError(domain: "Transrator", code: 2, userInfo: [NSLocalizedDescriptionKey: "마이크 오디오 형식을 변환할 수 없습니다."])
            }
            inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
                guard let self else { return }
                // Convert before returning the tap's reusable buffer. Serialize
                // converter access with stop/reconfiguration, and reject old taps.
                self.audioQueue.sync {
                    guard WhisperEngine.shared.captureGeneration(owner: requestedOwner) == generation,
                          let converted = self.convertToWhisperFormat(buffer) else { return }
                    WhisperEngine.shared.appendPCMBuffer(converted, owner: requestedOwner, generation: generation)
                }
            }

            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            audioEngine.stop()
            inputNodeRemoveTap()
            WhisperEngine.shared.release(owner: requestedOwner)
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

    func stop(expectedOwner: WhisperEngine.Owner = .mic, cancel: Bool = false,
              completion: @escaping ([String: Any]) -> Void) {
        guard owner == expectedOwner else {
            completion(mergeCurrentState(extra: ["error": "다른 음성 기능이 마이크를 사용 중입니다."]))
            return
        }
        guard isRunning, !isStopping else { completion(snapshot()); return }
        isStopping = true
        audioEngine.stop()
        inputNodeRemoveTap()
        audioQueue.sync {
            self.audioConverter = nil
            self.reusableOutputBuffer = nil
        }
        let finish = {
            WhisperEngine.shared.release(owner: expectedOwner)
            self.updateState {
                self.isRunning = false
                self.isStopping = false
                self.accumulated.partial = ""
                self.transcript = cancel ? "" : self.accumulated.text
                self.isFinal = true
            }
            completion(self.snapshot())
        }
        if cancel { finish() } else { WhisperEngine.shared.finish(owner: expectedOwner, completion: finish) }
    }

    func currentState() -> [String: Any] {
        if isRunning, !isStopping, !audioEngine.isRunning {
            updateState { lastError = "마이크 연결이 변경되었습니다. 마이크를 확인한 뒤 다시 시작해주세요." }
        }
        return mergeCurrentState(extra: permissionsSnapshot())
    }

    func shutdown() {
        guard isRunning || isStopping else { return }
        audioEngine.stop()
        inputNodeRemoveTap()
        audioQueue.sync {
            self.audioConverter = nil
            self.reusableOutputBuffer = nil
        }
        WhisperEngine.shared.release(owner: owner)
        updateState { isRunning = false; isStopping = false }
    }

    /// Stateful conversion with a reusable output buffer.
    private func convertToWhisperFormat(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let start = CFAbsoluteTimeGetCurrent()
        guard let converter = audioConverter else { return nil }

        let ratio = whisperFormat.sampleRate / buffer.format.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
        guard outputFrameCount > 0 else { return nil }

        // Reuse output buffer if capacity is sufficient, otherwise allocate once
        let outputBuffer: AVAudioPCMBuffer
        if let reusable = reusableOutputBuffer, reusable.frameCapacity >= outputFrameCount {
            reusable.frameLength = 0
            outputBuffer = reusable
        } else {
            let capacity = max(outputFrameCount, 1024)
            guard let newBuf = AVAudioPCMBuffer(pcmFormat: whisperFormat, frameCapacity: capacity) else {
                return nil
            }
            reusableOutputBuffer = newBuf
            outputBuffer = newBuf
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

        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
        PerformanceTracker.shared.record(stage: "convertToWhisperFormat", durationMs: elapsed)

        if error != nil || outputBuffer.frameLength == 0 { return nil }
        return outputBuffer
    }

    private func inputNodeRemoveTap() {
        audioEngine.inputNode.removeTap(onBus: 0)
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
    // Rust invokes this on a blocking worker: the main queue must stay free
    // for final inference callbacks and completion.
    guard !Thread.isMainThread else { return jsonCString(["error": "음성 종료는 작업 스레드에서 호출해야 합니다."]) }
    let done = DispatchSemaphore(value: 0)
    var result: [String: Any] = [:]
    DispatchQueue.main.async {
        SpeechBridgeState.shared.stop { state in
            result = state
            done.signal()
        }
    }
    done.wait()
    return jsonCString(result)
}

@_cdecl("speech_get_state")
public func speech_get_state() -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        jsonCString(SpeechBridgeState.shared.currentState())
    }
}
