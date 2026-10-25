import AppKit

enum DictationClipboardError: Error {
    case unavailableRepresentation, targetOrClipboardChanged, writeFailed
}

/// Owns a temporary pasteboard lease. Accepting an injected private pasteboard
/// lets regression tests exercise AppKit without touching the user's clipboard.
final class DictationClipboard {
    private let pasteboard: NSPasteboard
    private var nextID: UInt64 = 0
    private var lease: (id: UInt64, count: Int, items: [NSPasteboardItem])?

    init(pasteboard: NSPasteboard = .general) { self.pasteboard = pasteboard }

    func stage(_ text: String, validateTarget: () -> Bool) throws -> UInt64 {
        let originalCount = pasteboard.changeCount
        let original = lease.flatMap { $0.count == originalCount ? $0.items : nil }
            ?? pasteboard.pasteboardItems ?? []
        var saved: [NSPasteboardItem] = []
        for item in original {
            let copy = NSPasteboardItem()
            for type in item.types {
                guard let data = item.data(forType: type), copy.setData(data, forType: type) else {
                    throw DictationClipboardError.unavailableRepresentation
                }
            }
            saved.append(copy)
        }
        guard validateTarget(), originalCount == pasteboard.changeCount else {
            throw DictationClipboardError.targetOrClipboardChanged
        }
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            pasteboard.clearContents()
            if !saved.isEmpty { pasteboard.writeObjects(saved) }
            throw DictationClipboardError.writeFailed
        }
        nextID &+= 1
        lease = (nextID, pasteboard.changeCount, saved)
        return nextID
    }

    /// An old delivery completion must not restore over a newer pending paste.
    func restore(_ expectedID: UInt64? = nil) {
        guard let pending = lease, expectedID == nil || expectedID == pending.id else { return }
        if DictationDeliveryPolicy.shouldRestoreClipboard(ownedCount: pending.count, currentCount: pasteboard.changeCount) {
            pasteboard.clearContents()
            if !pending.items.isEmpty { pasteboard.writeObjects(pending.items) }
        }
        lease = nil
    }
}
