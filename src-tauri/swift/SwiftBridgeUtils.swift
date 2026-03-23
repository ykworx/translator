import Foundation

func jsonCString(_ payload: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let string = String(data: data, encoding: .utf8) else {
        return strdup("{\"error\":\"json_encoding_failed\"}")
    }
    return strdup(string)
}

func jsonCString(_ payload: [[String: Any]]) -> UnsafeMutablePointer<CChar>? {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
          let string = String(data: data, encoding: .utf8) else {
        return strdup("[]")
    }
    return strdup(string)
}

func runOnMain<T>(_ work: @escaping () -> T) -> T {
    if Thread.isMainThread {
        return autoreleasepool(invoking: work)
    }

    var result: T?
    DispatchQueue.main.sync {
        result = autoreleasepool(invoking: work)
    }
    return result!
}

@_cdecl("speech_free_string")
public func speech_free_string(pointer: UnsafeMutablePointer<CChar>?) {
    guard let pointer else { return }
    free(pointer)
}
