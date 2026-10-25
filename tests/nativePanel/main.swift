import AppKit

_ = NSApplication.shared
var checks = 0
func check(_ condition: Bool, _ message: String) {
    guard condition else { fatalError(message) }
    checks += 1
}

let view = DictationTranscriptView(frame: NSRect(x: 0, y: 0, width: 380, height: 58))
func display(_ text: String, active: Bool = true, expanded: Bool = false, screenHeight: CGFloat = 800) -> CGFloat {
    view.setText(text, active: active, placeholder: false)
    let height = DictationPanelSizing.height(textHeight: view.measuredHeight(width: 380), expanded: expanded, visibleHeight: screenHeight)
    view.setFrameSize(NSSize(width: 380, height: max(1, height - DictationPanelSizing.chromeHeight)))
    view.fitDocument(active: active)
    return height
}

let fourLines = (1...4).map { "\($0)번째 인식 문장입니다." }.joined(separator: "\n")
let fourHeight = display(fourLines)
check(fourHeight > 218, "four explicit lines grow beyond the old three-line panel")
check(!view.overflows, "four lines fit without clipping")
check(view.textView.string == fourLines, "newlines and Korean text are preserved")
let manyLines = (1...24).map { "\($0)번째 한국어와 日本語 문장입니다. 👩🏽‍💻" }.joined(separator: "\n")
let manyHeight = display(manyLines)
check(manyHeight == 320, "long active content stops growing at the compact limit")
check(view.overflows && view.hasVerticalScroller, "long content scrolls inside a bounded viewport")
check(view.textView.string == manyLines, "long transcripts keep every character instead of a 160-character suffix")
check(view.documentVisibleRect.maxY >= view.textView.bounds.maxY - 1, "new content follows the final line")
view.contentView.scroll(to: NSPoint(x: 0, y: 40))
view.reflectScrolledClipView(view.contentView)
_ = display(manyLines + "\n새로 도착한 문장")
check(abs(view.contentView.bounds.origin.y - 40) < 1, "reading earlier content is not interrupted by incoming speech")
view.contentView.scroll(to: NSPoint(x: 0, y: view.textView.frame.height - view.contentSize.height))
_ = display(manyLines + "\n새로 도착한 문장\n다음 문장")
check(view.documentVisibleRect.maxY >= view.textView.bounds.maxY - 1, "scrolling back to the end resumes following")
view.reset()
_ = display(manyLines, active: false, expanded: true)
check(view.contentView.bounds.origin.y < 1, "a completed result opens at the beginning")
check(view.frame.height == 320, "expanded results provide a larger bounded viewport")
let smallScreen = display(manyLines, screenHeight: 300)
check(smallScreen <= 276 && view.overflows, "small screens retain a scrollable viewport within screen margins")
let shortHeight = display("네")
check(shortHeight == 218 && !view.overflows, "a shortened hypothesis returns to a compact panel")
check(view.contentView.bounds.origin.y < 1, "a shortened document clamps stale scroll offsets")
_ = display(String(repeating: "long_token_", count: 200))
check(view.textView.frame.width <= view.contentSize.width + 1, "unbroken text cannot widen beyond the panel")
if let container = view.textView.textContainer, let manager = view.textView.layoutManager {
    check(manager.usedRect(for: container).width <= view.contentSize.width + 1, "a long token wraps within the viewport")
}
let paragraph = String(repeating: "한 문단으로 길게 말해도 전체 내용을 보관합니다. ", count: 50)
view.reset()
_ = display(paragraph)
check(view.overflows && view.textView.string == paragraph, "a long flowing paragraph wraps and remains scrollable")
check(!view.textView.isEditable && !view.textView.isSelectable, "dictation display remains read-only")
print("Passed \(checks) AppKit transcript layout and scrolling checks without microphone access.")
