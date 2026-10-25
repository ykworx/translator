import AppKit
import ApplicationServices
import AVFoundation

@_silgen_name("dictation_stopped")
private func rustDictationStopped()

private final class DictationPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Captures identity and editing state, without changing focus or reading other windows.
private struct DictationTarget {
    let pid: pid_t
    let appName: String
    let element: AXUIElement?
    let automaticInsertion: Bool
    let selection: CFRange?
    let value: String?

    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }

    static func focusedElement() -> AXUIElement? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 0.3)
        guard let value = attribute(system, kAXFocusedUIElementAttribute),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let element = value as! AXUIElement
        AXUIElementSetMessagingTimeout(element, 0.3)
        return element
    }

    static func range(_ element: AXUIElement) -> CFRange? {
        guard let value = attribute(element, kAXSelectedTextRangeAttribute),
              CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return range
    }

    static func isSecure(_ element: AXUIElement) -> Bool {
        (attribute(element, kAXSubroleAttribute) as? String) == kAXSecureTextFieldSubrole
    }

    static func capture() throws -> DictationTarget {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else {
            throw DictationError.message("받아쓸 앱의 입력창을 클릭한 뒤 단축키를 눌러주세요.")
        }
        let element = focusedElement()
        if let element, isSecure(element) {
            throw DictationError.message("암호 입력창에서는 받아쓰기를 시작하지 않습니다.")
        }
        let terminalApps = ["com.apple.Terminal", "com.googlecode.iterm2", "com.cmuxterm.app", "com.mitchellh.ghostty", "dev.warp.Warp-Stable"]
        let role = element.flatMap { attribute($0, kAXRoleAttribute) as? String } ?? ""
        let identifier = element.flatMap { attribute($0, kAXIdentifierAttribute) as? String } ?? ""
        let description = element.flatMap { attribute($0, kAXRoleDescriptionAttribute) as? String } ?? ""
        let terminal = terminalApps.contains(app.bundleIdentifier ?? "")
            || (identifier + " " + description).lowercased().contains("terminal")
            || description.contains("터미널")
        let editable = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role)
        var elementPID: pid_t = 0
        if let element { _ = AXUIElementGetPid(element, &elementPID) }
        let eligible = editable && !terminal && elementPID == app.processIdentifier
        if let element { AXUIElementSetMessagingTimeout(element, 0.3) }
        return DictationTarget(pid: app.processIdentifier, appName: app.localizedName ?? "선택 앱", element: element,
            automaticInsertion: eligible,
            selection: element.flatMap { range($0) },
            value: element.flatMap { attribute($0, kAXValueAttribute) as? String })
    }

    func isUnchanged(requireEditingState: Bool = true) -> Bool {
        guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
        if !requireEditingState, element == nil { return true }
        guard let element, let focused = Self.focusedElement() else { return false }
        if requireEditingState && !automaticInsertion { return false }
        let currentRange = Self.range(focused)
        let sameRange = selection.map { old in
            currentRange.map { $0.location == old.location && $0.length == old.length } ?? false
        } ?? !requireEditingState
        return DictationDeliveryPolicy.canInsert(
            sameApp: NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            sameElement: CFEqual(element, focused), sameSelection: sameRange,
            sameValue: value.map { $0 == (Self.attribute(focused, kAXValueAttribute) as? String) } ?? !requireEditingState,
            secure: Self.isSecure(focused))
    }
}

private enum DictationError: Error { case message(String) }

/// Runs on the main queue. No webview needs to be visible or polling for this to work.
final class GlobalDictationController: NSObject {
    static let shared = GlobalDictationController()
    private var session = DictationSession()
    private var target: DictationTarget?
    private var lastResult = ""
    private var resultPending = false
    private let clipboard = DictationClipboard()
    private var timer: Timer?
    private var escapeMonitor: Any?
    private var localEscapeMonitor: Any?
    private var startedAt = Date()
    private var captureError: String?
    private var recordingMode = ""
    private var panel: DictationPanel?
    private let phaseLabel = NSTextField(labelWithString: "")
    private let activityDot = NSView()
    private let heading = NSTextField(labelWithString: "")
    private let transcript = NSTextField(wrappingLabelWithString: "")
    private let instruction = NSTextField(labelWithString: "")
    private var stopButton: NSButton!
    private var cancelButton: NSButton!
    private var copyButton: NSButton!
    private var closeButton: NSButton!

    func preview() -> Bool {
        guard session.phase == .idle else { return false }
        installEscapeMonitor()
        show("받아쓰기 상태창 미리보기 · 녹음하지 않습니다", text: "다른 앱의 입력창에서 단축키를 누르면 이 위치에 인식 결과가 표시됩니다. 같은 단축키로 종료하고, Esc로 취소할 수 있습니다.")
        phaseLabel.stringValue = "미리보기"
        copyButton.isHidden = true
        return true
    }

    func prepare() -> [String: Any] {
        switch session.phase {
        case .recording:
            finishRecording()
            return ["needsModel": false]
        case .preparing:
            cancelRecording()
            return ["needsModel": false]
        case .finalizing:
            return ["needsModel": false]
        default: break
        }
        if resultPending {
            show("이전 결과를 복사하거나 닫은 후 다시 시작해주세요.", text: lastResult)
            return ["needsModel": false]
        }
        guard !WhisperEngine.shared.isInUse else {
            showError("음성 입력 또는 자막을 먼저 중지해주세요.")
            return ["needsModel": false]
        }
        guard AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) else {
            showError("시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 Transrator를 허용한 뒤 다시 시작해주세요.")
            return ["needsModel": false]
        }
        do { target = try DictationTarget.capture() }
        catch DictationError.message(let message) { showError(message); return ["needsModel": false] }
        catch { showError("입력창을 확인할 수 없습니다."); return ["needsModel": false] }
        let permissions = SpeechBridgeState.shared.requestPermissions()
        guard permissions["authorized"] as? Bool == true else {
            showError(permissions["error"] as? String ?? "마이크 권한을 허용해주세요.")
            return ["needsModel": false]
        }
        let id = session.begin()
        lastResult = ""
        captureError = nil
        installEscapeMonitor()
        show("받아쓰기 모델 준비 중…", text: "Esc 또는 취소 버튼으로 취소할 수 있습니다.")
        return ["needsModel": true, "sessionId": id]
    }

    func startPrepared(id: UInt64, locale: String, hint: String, microphone: String) -> Bool {
        guard session.id == id, session.phase == .preparing else { return false }
        guard target?.isUnchanged(requireEditingState: false) == true else {
            fail(id: id, message: "준비 중 입력 대상이 바뀌었습니다. 입력창에서 다시 시작해주세요.")
            return false
        }
        let language = locale == "system" ? (Locale.preferredLanguages.first ?? "ko-KR") : locale
        let result = SpeechBridgeState.shared.start(localeIdentifier: language, dictation: true, hint: hint, microphone: microphone)
        guard result["isRunning"] as? Bool == true, result["error"] == nil else {
            fail(id: id, message: result["error"] as? String ?? "마이크를 시작할 수 없습니다.")
            return false
        }
        _ = session.transition(.preparing, to: .recording, session: id)
        startedAt = Date()
        recordingMode = target?.automaticInsertion == true ? "단축키로 종료·입력" : "종료 후 결과 복사"
        show(recordingHeading(), text: "말씀해주세요…")
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            guard let self, self.session.id == id, self.session.phase == .recording else { return }
            let state = SpeechBridgeState.shared.currentState()
            let heading = self.recordingHeading()
            if self.heading.stringValue != heading { self.heading.stringValue = heading }
            self.updateTranscript(state["transcript"] as? String ?? "")
            if let error = state["error"] as? String {
                self.captureError = error
                self.finishRecording()
                return
            }
            if Date().timeIntervalSince(self.startedAt) >= 180 { self.finishRecording() }
        }
        return true
    }

    func fail(id: UInt64, message: String) {
        guard session.id == id, session.phase == .preparing else { return }
        session.cancel()
        cleanup()
        showError(message)
    }

    @objc private func finishRecording() {
        let id = session.id
        guard session.transition(.recording, to: .finalizing, session: id) else { return }
        timer?.invalidate(); timer = nil
        show("마지막 발화 인식 중…", text: transcript.stringValue)
        SpeechBridgeState.shared.stop(expectedOwner: .dictation) { [weak self] state in
            rustDictationStopped()
            guard let self, self.session.transition(.finalizing, to: .result, session: id) else { return }
            self.cleanup()
            defer { self.target = nil }
            self.lastResult = state["transcript"] as? String ?? ""
            guard !self.lastResult.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                self.showError("인식된 음성이 없습니다. 마이크와 입력 언어를 확인해주세요.")
                return
            }
            self.resultPending = true
            if let error = self.captureError {
                self.show(error + " 인식 결과를 복사할 수 있습니다.", text: self.lastResult)
                return
            }
            guard self.target?.isUnchanged() == true else {
                let message = self.target?.automaticInsertion == true
                    ? "입력 위치를 확인할 수 없어 자동 입력을 보류했습니다. 결과를 복사해주세요."
                    : "이 입력창은 자동 입력을 지원하지 않습니다. 결과를 복사해 붙여넣으세요."
                self.show(message, text: self.lastResult)
                return
            }
            self.insertResult()
        }
    }

    @objc private func cancelRecording() {
        let wasRecording = session.phase == .recording
        session.cancel()
        cleanup()
        if wasRecording {
            SpeechBridgeState.shared.stop(expectedOwner: .dictation, cancel: true) { _ in rustDictationStopped() }
        }
        target = nil
        panel?.orderOut(nil)
    }

    private func cleanup() {
        timer?.invalidate(); timer = nil
        if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
        if let localEscapeMonitor { NSEvent.removeMonitor(localEscapeMonitor) }
        escapeMonitor = nil; localEscapeMonitor = nil
    }

    func shutdown() {
        session.cancel()
        cleanup()
        SpeechBridgeState.shared.shutdown()
        clipboard.restore()
        panel?.orderOut(nil)
    }

    private func installEscapeMonitor() {
        cleanup()
        if AXIsProcessTrusted() {
            escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53 { self?.cancelRecording() }
            }
        }
        localEscapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { self?.cancelRecording(); return nil }
            return event
        }
    }

    private func insertResult() {
        guard let source = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            show("키보드 접근을 확인할 수 없습니다. 결과를 복사해주세요.", text: lastResult)
            return
        }
        let lease: UInt64
        do { lease = try clipboard.stage(lastResult) { self.target?.isUnchanged() == true } }
        catch {
            show("입력 위치 또는 클립보드를 보존할 수 없어 자동 입력을 보류했습니다. 결과를 복사해주세요.", text: lastResult)
            return
        }
        down.flags = .maskCommand; up.flags = .maskCommand
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        // A posted event does not acknowledge delivery: retain a recovery copy.
        show("입력을 요청했습니다. 반영되지 않았다면 복사 버튼을 사용하세요.", text: lastResult)
        resultPending = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.clipboard.restore(lease) }
    }

    @objc private func copyResult() {
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.setString(lastResult, forType: .string) {
            resultPending = false
            heading.stringValue = "결과를 클립보드에 복사했습니다."
        } else { heading.stringValue = "복사하지 못했습니다. 다시 시도해주세요." }
    }

    @objc private func dismiss() {
        session.cancel()
        cleanup()
        resultPending = false
        target = nil
        lastResult = ""
        panel?.orderOut(nil)
    }

    private func showError(_ message: String) {
        session.cancel()
        cleanup()
        show(message, text: lastResult)
    }

    private func show(_ message: String, text: String) {
        if panel == nil { makePanel() }
        heading.stringValue = message
        updateTranscript(text)
        stopButton.isHidden = session.phase != .recording
        stopButton.title = target?.automaticInsertion == true ? "완료하고 입력" : "완료"
        cancelButton.isHidden = ![.preparing, .recording, .finalizing].contains(session.phase)
        copyButton.isHidden = lastResult.isEmpty
        closeButton.isHidden = [.preparing, .recording, .finalizing].contains(session.phase)
        let active = [.preparing, .recording, .finalizing].contains(session.phase)
        instruction.stringValue = active ? "Esc로 취소" : ""
        switch session.phase {
        case .preparing:
            phaseLabel.stringValue = "준비 중"
            activityDot.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        case .recording:
            phaseLabel.stringValue = "녹음 중"
            activityDot.layer?.backgroundColor = NSColor.systemRed.cgColor
        case .finalizing:
            phaseLabel.stringValue = "인식 중"
            activityDot.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        default:
            phaseLabel.stringValue = lastResult.isEmpty ? "안내" : "결과"
            activityDot.layer?.backgroundColor = NSColor.secondaryLabelColor.cgColor
        }
        panel?.orderFrontRegardless()
    }

    private func updateTranscript(_ text: String) {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        transcript.stringValue = empty && session.phase == .recording ? "말씀해주세요…" : Self.preview(text)
        transcript.textColor = empty ? .secondaryLabelColor : .labelColor
    }

    private static func preview(_ text: String) -> String {
        text.count > 160 ? "…" + String(text.suffix(160)) : text
    }

    private func recordingHeading() -> String {
        let seconds = Int(Date().timeIntervalSince(startedAt))
        let elapsed = String(format: "%02d:%02d", seconds / 60, seconds % 60)
        return "\(target?.appName ?? "선택 앱") · \(elapsed) · \(recordingMode)"
    }

    private func makePanel() {
        let rect = NSRect(x: 0, y: 0, width: 420, height: 188)
        let window = DictationPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        // A borderless panel still has an opaque window background by default.
        // Clear both backing surfaces so rounded corners do not expose a square
        // frame; omit the window shadow, which otherwise reads as an outer halo.
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.title = "Transrator 받아쓰기"
        let root = NSView(frame: rect)
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor
        let view = NSVisualEffectView(frame: rect)
        view.material = .popover
        view.blendingMode = .behindWindow
        view.state = .active
        view.wantsLayer = true
        view.layer?.cornerRadius = 18
        view.layer?.cornerCurve = .continuous
        view.layer?.masksToBounds = true
        view.layer?.borderWidth = 0
        root.addSubview(view)

        let title = NSTextField(labelWithString: "받아쓰기")
        title.frame = NSRect(x: 20, y: 151, width: 240, height: 20)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        title.textColor = .labelColor
        activityDot.frame = NSRect(x: 325, y: 158, width: 6, height: 6)
        activityDot.wantsLayer = true
        activityDot.layer?.cornerRadius = 3
        phaseLabel.frame = NSRect(x: 337, y: 153, width: 63, height: 16)
        phaseLabel.font = .systemFont(ofSize: 11, weight: .medium)
        phaseLabel.textColor = .secondaryLabelColor
        heading.frame = NSRect(x: 20, y: 111, width: 380, height: 34)
        heading.font = .systemFont(ofSize: 12)
        heading.textColor = .secondaryLabelColor
        heading.maximumNumberOfLines = 2
        heading.cell?.wraps = true
        heading.cell?.isScrollable = false
        transcript.frame = NSRect(x: 20, y: 49, width: 380, height: 58)
        transcript.font = .systemFont(ofSize: 15, weight: .medium)
        transcript.maximumNumberOfLines = 3
        transcript.cell?.lineBreakMode = .byTruncatingTail
        instruction.frame = NSRect(x: 20, y: 17, width: 150, height: 16)
        instruction.font = .systemFont(ofSize: 11)
        instruction.textColor = .secondaryLabelColor
        for label in [title, phaseLabel, heading, transcript, instruction] { view.addSubview(label) }
        view.addSubview(activityDot)

        stopButton = NSButton(title: "완료하고 입력", target: self, action: #selector(finishRecording))
        cancelButton = NSButton(title: "취소", target: self, action: #selector(cancelRecording))
        copyButton = NSButton(title: "결과 복사", target: self, action: #selector(copyResult))
        closeButton = NSButton(title: "닫기", target: self, action: #selector(dismiss))
        let actions = NSStackView(views: [stopButton!, cancelButton!, copyButton!, closeButton!])
        actions.orientation = .horizontal
        actions.spacing = 8
        actions.detachesHiddenViews = true
        actions.translatesAutoresizingMaskIntoConstraints = false
        for button in [stopButton!, cancelButton!, copyButton!, closeButton!] {
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = .systemFont(ofSize: 12, weight: .medium)
        }
        view.addSubview(actions)
        NSLayoutConstraint.activate([
            actions.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            actions.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -12),
            actions.heightAnchor.constraint(equalToConstant: 26),
        ])
        window.contentView = root
        let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            window.setFrameOrigin(NSPoint(x: visible.midX - rect.width / 2, y: visible.minY + 40))
        }
        panel = window
    }
}

@_cdecl("dictation_prepare")
public func dictation_prepare() -> UnsafeMutablePointer<CChar>? {
    runOnMain { jsonCString(GlobalDictationController.shared.prepare()) }
}

@_cdecl("dictation_start_prepared")
public func dictation_start_prepared(id: UInt64, locale: UnsafePointer<CChar>?, hint: UnsafePointer<CChar>?, microphone: UnsafePointer<CChar>?) -> Bool {
    let locale = locale.map { String(cString: $0) } ?? "ko-KR"
    let hint = hint.map { String(cString: $0) } ?? ""
    let microphone = microphone.map { String(cString: $0) } ?? ""
    return runOnMain { GlobalDictationController.shared.startPrepared(id: id, locale: locale, hint: hint, microphone: microphone) }
}

@_cdecl("dictation_fail")
public func dictation_fail(id: UInt64, message: UnsafePointer<CChar>?) {
    let message = message.map { String(cString: $0) } ?? "받아쓰기를 시작할 수 없습니다."
    runOnMain { GlobalDictationController.shared.fail(id: id, message: message) }
}

@_cdecl("dictation_shutdown")
public func dictation_shutdown() {
    runOnMain {
        GlobalDictationController.shared.shutdown()
        if #available(macOS 13.0, *) { _ = AppCaptionBridgeState.shared.stop(clearTranscript: false) }
    }
}

@_cdecl("dictation_permissions")
public func dictation_permissions(request: Bool) -> UnsafeMutablePointer<CChar>? {
    runOnMain {
        if request {
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            _ = SpeechBridgeState.shared.requestPermissions()
        }
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        let name: String
        switch status {
        case .authorized: name = "authorized"
        case .notDetermined: name = "notDetermined"
        case .denied: name = "denied"
        case .restricted: name = "restricted"
        @unknown default: name = "restricted"
        }
        return jsonCString(["microphone": status == .authorized, "microphoneStatus": name,
                            "accessibility": AXIsProcessTrusted(), "modelLoaded": WhisperEngine.shared.isModelLoaded])
    }
}

@_cdecl("dictation_preview")
public func dictation_preview() -> Bool {
    runOnMain { GlobalDictationController.shared.preview() }
}
