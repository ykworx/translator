import AppKit

var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    guard condition() else { fatalError("FAIL: \(message)") }
}

typealias Snapshot = [[String: Data]]

func snapshot(_ board: NSPasteboard) -> Snapshot {
    (board.pasteboardItems ?? []).map { item in
        var representations: [String: Data] = [:]
        for type in item.types { representations[type.rawValue] = item.data(forType: type) }
        return representations
    }
}

func privateBoard(_ test: (NSPasteboard) throws -> Void) rethrows {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    check(board.name != NSPasteboard.Name.general, "tests must use a unique private pasteboard")
    try test(board)
}

func put(_ text: String, on board: NSPasteboard) {
    board.clearContents()
    check(board.setString(text, forType: .string), "private board accepts string data")
}

func expectChanged(_ action: () throws -> Void, _ message: String) {
    do {
        try action()
        fatalError("FAIL: \(message) did not reject insertion")
    } catch DictationClipboardError.targetOrClipboardChanged {
        check(true, message)
    } catch {
        fatalError("FAIL: \(message) returned wrong error: \(error)")
    }
}

do {
    try privateBoard { board in
        let first = NSPasteboardItem()
        check(first.setString("원문 日本語", forType: .string), "original text is prepared")
        check(first.setString("<table><tr><td>원문</td></tr></table>", forType: .html), "original HTML is prepared")
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")!
        check(first.setData(png, forType: .png), "original PNG bytes are prepared")
        let second = NSPasteboardItem()
        check(second.setString("두 번째 항목", forType: .string), "second clipboard item is prepared")
        check(second.setData(Data([0, 1, 2, 255]), forType: NSPasteboard.PasteboardType("com.transrator.test.binary")), "custom binary representation is prepared")
        board.clearContents()
        check(board.writeObjects([first, second]), "multiple original items are written")
        let original = snapshot(board)
        check(original.count == 2, "private pasteboard contains both items")
        let lease = DictationClipboard(pasteboard: board)
        let id = try lease.stage("인식 결과", validateTarget: { true })
        check(board.string(forType: .string) == "인식 결과", "staged text is available for the target paste")
        lease.restore(id)
        check(snapshot(board) == original, "text, HTML, PNG, binary data and item order are restored byte-for-byte")
        let restoredCount = board.changeCount
        lease.restore(id)
        check(board.changeCount == restoredCount, "restoring an already restored lease is a no-op")
    }

    try privateBoard { board in
        board.clearContents()
        check(snapshot(board).isEmpty, "empty original board has no items")
        let lease = DictationClipboard(pasteboard: board)
        let id = try lease.stage("temporary", validateTarget: { true })
        lease.restore(id)
        check(snapshot(board).isEmpty, "an originally empty board is restored to empty")
    }

    try privateBoard { board in
        put("original", on: board)
        let lease = DictationClipboard(pasteboard: board)
        let id = try lease.stage("temporary", validateTarget: { true })
        put("new user copy", on: board)
        let changed = snapshot(board)
        let count = board.changeCount
        lease.restore(id)
        check(snapshot(board) == changed, "a user's newer copy survives restoration")
        check(board.changeCount == count, "skipping restoration does not claim pasteboard ownership")
    }

    try privateBoard { board in
        put("original", on: board)
        let original = snapshot(board)
        let lease = DictationClipboard(pasteboard: board)
        let older = try lease.stage("first dictation", validateTarget: { true })
        let newer = try lease.stage("second dictation", validateTarget: { true })
        check(older != newer, "consecutive deliveries receive distinct lease IDs")
        let count = board.changeCount
        lease.restore(older)
        check(board.changeCount == count, "an old completion cannot touch a newer pending paste")
        check(board.string(forType: .string) == "second dictation", "newer staged text remains available")
        lease.restore(newer)
        check(snapshot(board) == original, "latest restoration recovers the original, not the previous dictation")
    }

    privateBoard { board in
        put("original", on: board)
        let original = snapshot(board)
        let count = board.changeCount
        let lease = DictationClipboard(pasteboard: board)
        expectChanged({ _ = try lease.stage("must not be written", validateTarget: { false }) }, "invalid target")
        check(snapshot(board) == original, "target rejection preserves every original representation")
        check(board.changeCount == count, "target rejection does not clear or write the pasteboard")
    }

    try privateBoard { board in
        put("original", on: board)
        let lease = DictationClipboard(pasteboard: board)
        let id = try lease.stage("pending dictation", validateTarget: { true })
        expectChanged({ _ = try lease.stage("rejected dictation", validateTarget: { false }) }, "invalid second target")
        check(board.string(forType: .string) == "pending dictation", "rejected second stage does not discard a pending paste")
        lease.restore(id)
        check(board.string(forType: .string) == "original", "rejected stage keeps the previous lease restorable")
    }

    try privateBoard { board in
        put("original", on: board)
        let lease = DictationClipboard(pasteboard: board)
        _ = try lease.stage("temporary", validateTarget: { true })
        lease.restore()
        check(board.string(forType: .string) == "original", "restore(nil) immediately restores before application exit")
        let restoredCount = board.changeCount
        lease.restore()
        check(board.changeCount == restoredCount, "repeated exit cleanup is harmless")
    }

    try privateBoard { board in
        put("first original", on: board)
        let lease = DictationClipboard(pasteboard: board)
        _ = try lease.stage("first dictation", validateTarget: { true })
        put("new user copy", on: board)
        let newer = try lease.stage("second dictation", validateTarget: { true })
        lease.restore(newer)
        check(board.string(forType: .string) == "new user copy", "a new stage snapshots a newer user copy instead of stale original data")
    }

    privateBoard { board in
        put("original", on: board)
        let lease = DictationClipboard(pasteboard: board)
        expectChanged({
            _ = try lease.stage("must not replace user copy", validateTarget: {
                // AX validation can yield while another app copies new data.
                put("copy made during target validation", on: board)
                return true
            })
        }, "clipboard change during target validation")
        check(board.string(forType: .string) == "copy made during target validation", "a copy made during AX validation is not overwritten")
    }
    print("Passed \(checks) AppKit clipboard integration checks using private pasteboards only.")
} catch {
    fatalError("Unexpected clipboard integration error: \(error)")
}
