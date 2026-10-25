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
