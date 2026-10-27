import AppKit

var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    precondition(condition(), message)
    checks += 1
}
let drawing = ScreenPenDrawing()
check(drawing.strokes.isEmpty, "starts empty")
drawing.begin(at: NSPoint(x: 20, y: 20))
check(drawing.strokes.count == 1, "a click creates a visible dot")
drawing.move(to: NSPoint(x: 80, y: 40))
drawing.end()
check(drawing.strokes[0].elementCount == 2, "keeps a completed stroke")
drawing.move(to: NSPoint(x: 200, y: 100))
check(drawing.strokes[0].elementCount == 2, "hover does not draw")
drawing.begin(at: NSPoint(x: 25, y: 70))
check(drawing.strokes.count == 2, "separate strokes stay separate")
drawing.clear()
drawing.move(to: NSPoint(x: 200, y: 100))
check(drawing.strokes.isEmpty, "clear during a drag cannot bring back the old line")
drawing.begin(at: NSPoint(x: 35, y: 35))
check(drawing.strokes.count == 1, "can draw again after clearing")

let canvas = ScreenPenCanvas(frame: NSRect(x: 0, y: 0, width: 160, height: 120))
check(!canvas.isOpaque, "canvas keeps the desktop visible")
var closed = false
canvas.onClose = { closed = true }
canvas.cancelOperation(nil)
check(closed, "Escape cancellation calls close")
canvas.drawing.begin(at: NSPoint(x: 50, y: 50))
canvas.drawing.move(to: NSPoint(x: 100, y: 50))
canvas.drawing.end()
func image() -> NSBitmapImageRep {
    let rep = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds)!
    canvas.cacheDisplay(in: canvas.bounds, to: rep)
    return rep
}
func alpha(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> CGFloat {
    // Cached AppKit images use backing pixels, which differ on Retina displays.
    rep.colorAt(x: x * rep.pixelsWide / 160, y: y * rep.pixelsHigh / 120)!.alphaComponent
}
let painted = image()
check(alpha(painted, 75, 50) > 0.5, "stroke is rendered")
check(alpha(painted, 10, 10) == 0, "empty canvas is transparent")
canvas.clearDrawing(nil)
let cleared = image()
check(alpha(cleared, 75, 50) == 0, "clear removes rendered pixels")
canvas.drawing.begin(at: NSPoint(x: 70, y: 70))
canvas.drawing.move(to: NSPoint(x: 70, y: 70))
canvas.drawing.end()
check(alpha(image(), 70, 70) > 0.5, "a click without dragging stays visible after mouse up")
print("Passed \(checks) screen pen checks without showing windows or accessing the screen.")
