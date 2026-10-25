// Optional real-model lifecycle smoke test. The wrapper supplies explicit local
// model/WAV paths; no microphone, UI or general pasteboard is used.
import Foundation
@_silgen_name("whisper_engine_load_model") func loadModel(_ path: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>?
@_silgen_name("whisper_engine_feed_wav") func feedWav(_ path: UnsafePointer<CChar>?, _ language: UnsafePointer<CChar>?, _ dictation: Bool) -> UnsafeMutablePointer<CChar>?
@_silgen_name("whisper_engine_is_model_loaded") func isLoaded() -> Bool
@_silgen_name("whisper_engine_shutdown") func shutdown() -> Bool
@_silgen_name("speech_free_string") func freeString(_ pointer: UnsafeMutablePointer<CChar>?)
@_cdecl("caption_state_changed") public func captionStateChanged(_ pointer: UnsafePointer<CChar>?) {}
@_cdecl("dictation_stopped") public func dictationStopped() {}

func decode(_ pointer: UnsafeMutablePointer<CChar>?) -> [String: Any] {
    guard let pointer else { fatalError("native returned nil") }
    defer { freeString(pointer) }
    let data = Data(String(cString: pointer).utf8)
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
}
let model = CommandLine.arguments[1]
let audio = CommandLine.arguments[2]
func load() -> [String: Any] { model.withCString { decode(loadModel($0)) } }
func feed() -> [String: Any] { audio.withCString { path in "ja".withCString { lang in decode(feedWav(path, lang, true)) } } }
var evidence: [[String: Any]] = []
func check(_ condition: Bool, _ label: String, _ details: [String: Any] = [:]) {
    evidence.append(["check": label, "passed": condition, "details": details])
    guard condition else { print(String(data: try! JSONSerialization.data(withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!); fatalError(label) }
}
check(load()["loaded"] as? Bool == true, "initial load")
check(isLoaded(), "context loaded")
for index in 1...2 {
    let value = feed()
    check(!(value["hypothesis"] as? String ?? "").isEmpty && value["timed_out"] as? Bool == false,
          "sequential session \(index)", ["hypothesis": value["hypothesis"] ?? "", "native_ms": value["total_processing_ms"] ?? -1])
    check(isLoaded(), "context retained after session \(index)")
}
let finished = DispatchSemaphore(value: 0)
let lock = NSLock()
var background: [String: Any] = [:]
DispatchQueue.global(qos: .userInitiated).async {
    let value = feed()
    lock.lock(); background = value; lock.unlock()
    finished.signal()
}
Thread.sleep(forTimeInterval: 0.1)
let rejectedLoad = load()
check(rejectedLoad["loaded"] as? Bool == false, "load rejected during active inference", rejectedLoad)
check(!shutdown(), "shutdown rejected during active inference")
check(isLoaded(), "busy context remains loaded")
check(finished.wait(timeout: .now() + 60) == .success, "background inference completes")
lock.lock(); let result = background; lock.unlock()
check(!(result["hypothesis"] as? String ?? "").isEmpty, "inference survived rejected lifecycle operations", ["hypothesis": result["hypothesis"] ?? ""])
check(shutdown(), "shutdown after release")
check(!isLoaded(), "context unloaded after release")
check(load()["loaded"] as? Bool == true, "reload after shutdown")
let last = feed()
check(!(last["hypothesis"] as? String ?? "").isEmpty && last["timed_out"] as? Bool == false,
      "recognition after reload", ["hypothesis": last["hypothesis"] ?? "", "native_ms": last["total_processing_ms"] ?? -1])
check(shutdown(), "final cleanup")
print(String(data: try! JSONSerialization.data(withJSONObject: ["checks": evidence, "count": evidence.count], options: [.prettyPrinted, .sortedKeys]), encoding: .utf8)!)
