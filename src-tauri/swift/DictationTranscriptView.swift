import AppKit

/// The document may grow, but NSClipView always contains it within the panel.
/// This view cannot edit/select text or take focus from the dictation target.
final class DictationTranscriptView: NSScrollView {
    let textView = NSTextView()
    private var followTail = true
    private var pendingOrigin: NSPoint?
    private var resetOnNextText = true

    override init(frame: NSRect) {
        super.init(frame: frame)
        hasVerticalScroller = true
        autohidesScrollers = true
        scrollerStyle = .overlay
        drawsBackground = false
        borderType = .noBorder
        textView.isEditable = false
        textView.isSelectable = false
        textView.isRichText = false
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.font = .systemFont(ofSize: 15, weight: .medium)
        textView.textColor = .labelColor
        textView.textContainerInset = NSSize(width: 0, height: 4)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.setAccessibilityLabel("받아쓰기 내용. 긴 내용은 위아래로 스크롤할 수 있습니다.")
        documentView = textView
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    var overflows: Bool { textView.frame.height > contentSize.height + 1 }
    private var isNearBottom: Bool {
        documentVisibleRect.maxY >= textView.bounds.maxY - 12
    }

    func reset() { followTail = true; resetOnNextText = true; pendingOrigin = .zero; contentView.scroll(to: .zero) }

    func setText(_ text: String, active: Bool, placeholder: Bool) {
        // Capture the reader's position before a different document height is
        // laid out. Returning to the bottom opts back in to following new text.
        pendingOrigin = resetOnNextText ? .zero : contentView.bounds.origin
        followTail = resetOnNextText || !active || !overflows || isNearBottom
        resetOnNextText = false
        if textView.string != text { textView.string = text }
        textView.textColor = placeholder ? .secondaryLabelColor : .labelColor
    }

    func measuredHeight(width: CGFloat) -> CGFloat {
        textView.setFrameSize(NSSize(width: width, height: max(1, textView.frame.height)))
        guard let container = textView.textContainer, let manager = textView.layoutManager else { return 58 }
        container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
        manager.ensureLayout(for: container)
        return ceil(manager.usedRect(for: container).height + textView.textContainerInset.height * 2)
    }

    func fitDocument(active: Bool) {
        tile()
        let oldOrigin = pendingOrigin ?? contentView.bounds.origin
        pendingOrigin = nil
        let height = measuredHeight(width: contentSize.width)
        textView.setFrameSize(NSSize(width: contentSize.width, height: max(contentSize.height, height)))
        if active && followTail {
            contentView.scroll(to: NSPoint(x: 0, y: max(0, textView.frame.height - contentSize.height)))
        } else {
            contentView.scroll(to: NSPoint(x: 0, y: min(oldOrigin.y, max(0, textView.frame.height - contentSize.height))))
        }
        reflectScrolledClipView(contentView)
    }
}

enum DictationPanelSizing {
    static let chromeHeight: CGFloat = 160
    static func height(textHeight: CGFloat, expanded: Bool, visibleHeight: CGFloat) -> CGFloat {
        let minimum: CGFloat = expanded ? 208 : 58
        let maximum: CGFloat = expanded ? 320 : 160
        return min(chromeHeight + min(maximum, max(minimum, textHeight)), max(1, visibleHeight - 24))
    }
}
