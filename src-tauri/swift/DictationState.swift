import Foundation

/// Pure state used by the native controller and its standalone regression tests.
struct DictationSession {
    enum Phase: String { case idle, preparing, recording, finalizing, result }
    private(set) var id: UInt64 = 0
    private(set) var phase: Phase = .idle

    mutating func begin() -> UInt64 {
        id &+= 1
        phase = .preparing
        return id
    }

    mutating func transition(_ expected: Phase, to next: Phase, session: UInt64) -> Bool {
        guard session == id, phase == expected else { return false }
        phase = next
        return true
    }

    mutating func cancel() {
        id &+= 1
        phase = .idle
    }
}

/// Recovery actions use the already registered dictation shortcut, never a new
/// global key combination that would also reach the user's foreground app.
struct DictationResultPolicy {
    enum ShortcutAction { case begin, finish, cancelPreparation, wait, copyResult }
    private(set) var pending = false
    private var discardDeadline: TimeInterval?
    static let discardConfirmationSeconds: TimeInterval = 5

    func shortcutAction(phase: DictationSession.Phase) -> ShortcutAction {
        switch phase {
        case .recording: return .finish
        case .preparing: return .cancelPreparation
        case .finalizing: return .wait
        default: return pending ? .copyResult : .begin
        }
    }

    func canPreview(phase: DictationSession.Phase) -> Bool { phase == .idle && !pending }
    mutating func receiveResult() { pending = true; cancelDiscard() }
    mutating func allowNextSession() { pending = false; cancelDiscard() }
    mutating func completeCopy(succeeded: Bool) {
        if succeeded { allowNextSession() } else { receiveResult() }
    }
    mutating func cancelDiscard() { discardDeadline = nil }

    /// Only an explicit second close within the confirmation interval discards
    /// an unhandled result. Merely waiting, previewing, or pressing Esc cannot.
    mutating func requestClose(now: TimeInterval) -> Bool {
        guard pending else { return true }
        if let deadline = discardDeadline, now <= deadline {
            discardDeadline = nil
            return true
        }
        discardDeadline = now + Self.discardConfirmationSeconds
        return false
    }
}

enum DictationRecordingClock {
    static let limitSeconds = 180
    static func elapsedSeconds(_ elapsed: TimeInterval) -> Int {
        guard elapsed.isFinite else { return 0 }
        return Int(max(0, min(elapsed, Double(limitSeconds))))
    }
    static func reachedLimit(_ elapsed: TimeInterval) -> Bool { elapsed >= Double(limitSeconds) }
    static func display(_ elapsed: TimeInterval) -> String {
        let seconds = elapsedSeconds(elapsed)
        return String(format: "%02d:%02d / 03:00", seconds / 60, seconds % 60)
    }
    static func warning(_ elapsed: TimeInterval) -> String? {
        let remaining = limitSeconds - elapsedSeconds(elapsed)
        return remaining <= 15 ? "\(remaining)초 후 자동 완료 · Esc로 취소" : nil
    }
}

struct DictationTranscript {
    private(set) var finalized: [String] = []
    var partial = ""
    let separator: String

    init(separator: String = " ") { self.separator = separator }

    mutating func appendFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { finalized.append(trimmed) }
        partial = ""
    }

    var text: String {
        (finalized + (partial.isEmpty ? [] : [partial])).joined(separator: separator)
    }
}

enum DictationDeliveryPolicy {
    static func canInsert(sameApp: Bool, sameElement: Bool, sameSelection: Bool,
                          sameValue: Bool, secure: Bool) -> Bool {
        sameApp && sameElement && sameSelection && sameValue && !secure
    }

    static func shouldRestoreClipboard(ownedCount: Int, currentCount: Int) -> Bool {
        ownedCount == currentCount
    }
}

struct SilenceTracker {
    let requiredSamples: Int
    private(set) var consecutiveSamples = 0

    init(requiredSamples: Int = 19_200) { self.requiredSamples = requiredSamples }

    mutating func append(sampleCount: Int, isSilent: Bool) -> Bool {
        consecutiveSamples = isSilent ? consecutiveSamples + max(0, sampleCount) : 0
        return consecutiveSamples >= requiredSamples
    }

    mutating func reset() { consecutiveSamples = 0 }
}
