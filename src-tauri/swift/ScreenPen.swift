import AppKit

// All state is local to this temporary drawing surface. No screen capture,
// recognition, global keyboard hooks, or persisted drawings are involved.
final class ScreenPenDrawing {
    private(set) var strokes: [NSBezierPath] = []
    private var current: NSBezierPath?
    func begin(at point: NSPoint) {
        let path = NSBezierPath()
        path.move(to: point)
        strokes.append(path)
        current = path
    }
    func move(to point: NSPoint) { current?.line(to: point) }
    func end() { current = nil }
    func clear() { current = nil; strokes.removeAll() }
}

private final class ScreenPenPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class ScreenPenCanvas: NSView {
    let drawing = ScreenPenDrawing()
    var onClose: (() -> Void)?
    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
    override func mouseDown(with event: NSEvent) {
        drawing.begin(at: convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }
    override func mouseDragged(with event: NSEvent) {
        drawing.move(to: convert(event.locationInWindow, from: nil))
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        drawing.move(to: convert(event.locationInWindow, from: nil))
        drawing.end()
        needsDisplay = true
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onClose?(); return }
        super.keyDown(with: event)
    }
    override func cancelOperation(_ sender: Any?) { onClose?() }
    @objc func clearDrawing(_ sender: Any?) { drawing.clear(); needsDisplay = true }
    @objc func closePen(_ sender: Any?) { onClose?() }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        for path in drawing.strokes {
            guard path.bounds.insetBy(dx: -5, dy: -5).intersects(dirtyRect) else { continue }
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            if path.bounds.width == 0 && path.bounds.height == 0 {
                let point = path.currentPoint
                NSColor.white.setFill()
                NSBezierPath(ovalIn: NSRect(x: point.x - 3, y: point.y - 3, width: 6, height: 6)).fill()
                NSColor.systemRed.setFill()
                NSBezierPath(ovalIn: NSRect(x: point.x - 2, y: point.y - 2, width: 4, height: 4)).fill()
            } else {
                NSColor.white.setStroke(); path.lineWidth = 6; path.stroke()
                NSColor.systemRed.setStroke(); path.lineWidth = 4; path.stroke()
            }
        }
    }
}

private final class ScreenPenController: NSObject, NSWindowDelegate {
    private var panel: ScreenPenPanel?
    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged(_:)),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }
    @objc private func screensChanged(_ notification: Notification) { close() }
    func show() -> Bool {
        if let panel = panel { panel.makeKeyAndOrderFront(nil); return true }
        // NSScreen uses points in one consistent coordinate space, including
        // displays with different scale factors or negative origins.
        let point = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(point, $0.frame, false) }) ?? NSScreen.main else { return false }
        let window = ScreenPenPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.title = "화면 펜"
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        // A fully clear native window can be excluded by WindowServer hit
        // testing. Keep an almost transparent surface before any stroke exists.
        window.backgroundColor = NSColor(calibratedWhite: 0, alpha: 0.01)
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.delegate = self
        let canvas = ScreenPenCanvas(frame: NSRect(origin: .zero, size: screen.frame.size))
        canvas.setAccessibilityRole(.group)
        canvas.setAccessibilityLabel("화면 펜")
        canvas.onClose = { [weak self] in self?.close() }
        window.contentView = canvas
        let bar = NSView(frame: NSRect(x: max(8, (screen.frame.width - 246) / 2),
            y: max(12, screen.frame.maxY - screen.visibleFrame.maxY + 12), width: 246, height: 44))
        bar.appearance = NSAppearance(named: .darkAqua)
        bar.wantsLayer = true
        bar.layer?.backgroundColor = NSColor(calibratedWhite: 0.10, alpha: 0.94).cgColor
        bar.layer?.cornerRadius = 12
        bar.layer?.masksToBounds = true
        let label = NSTextField(labelWithString: "펜")
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.textColor = .white
        let clear = NSButton(title: "모두 지우기", target: canvas, action: #selector(ScreenPenCanvas.clearDrawing(_:)))
        let close = NSButton(title: "닫기", target: canvas, action: #selector(ScreenPenCanvas.closePen(_:)))
        close.toolTip = "그림을 지우고 펜을 닫습니다 (Esc)"
        clear.bezelStyle = .rounded
        close.bezelStyle = .rounded
        let stack = NSStackView(views: [label, clear, close])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: bar.centerYAnchor)])
        canvas.addSubview(bar)
        panel = window
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(canvas)
        return true
    }
    func close() {
        guard let window = panel else { return }
        (window.contentView as? ScreenPenCanvas)?.drawing.clear()
        window.orderOut(nil)
        window.close()
        panel = nil
    }
    func windowWillClose(_ notification: Notification) {
        (panel?.contentView as? ScreenPenCanvas)?.drawing.clear()
        panel = nil
    }
}

private var screenPenController: ScreenPenController?
@_cdecl("transrator_show_screen_pen")
public func transratorShowScreenPen() -> Bool {
    guard Thread.isMainThread else { return false }
    if screenPenController == nil { screenPenController = ScreenPenController() }
    return screenPenController?.show() ?? false
}
