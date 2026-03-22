import Foundation

/// Thread-safe performance tracker for WhisperEngine pipeline stages.
/// Collects per-stage timing statistics (min/max/avg/count) and serializes to JSON.
/// Enabled/disabled via WHISPER_PERF_TRACK environment variable or runtime flag.
final class PerformanceTracker {
    static let shared = PerformanceTracker()

    /// Whether tracking is enabled (check env var WHISPER_PERF_TRACK=1 or set at runtime)
    var isEnabled: Bool

    private let lock = NSLock()

    /// Per-stage accumulated statistics
    private var stages: [String: StageStat] = [:]

    /// Timestamp of when tracking was last reset
    private var resetTimestamp: Date = Date()

    private struct StageStat {
        var count: Int = 0
        var totalMs: Double = 0
        var minMs: Double = .greatestFiniteMagnitude
        var maxMs: Double = 0

        var avgMs: Double { count > 0 ? totalMs / Double(count) : 0 }

        func toDict() -> [String: Any] {
            return [
                "count": count,
                "total_ms": round(totalMs * 100) / 100,
                "min_ms": count > 0 ? round(minMs * 100) / 100 : 0,
                "max_ms": round(maxMs * 100) / 100,
                "avg_ms": round(avgMs * 100) / 100,
            ]
        }
    }

    private init() {
        // Check environment variable
        isEnabled = ProcessInfo.processInfo.environment["WHISPER_PERF_TRACK"] == "1"
    }

    // MARK: - Measurement

    /// Record a timing measurement for a named stage (in milliseconds)
    func record(stage: String, durationMs: Double) {
        guard isEnabled else { return }
        lock.lock()
        var stat = stages[stage, default: StageStat()]
        stat.count += 1
        stat.totalMs += durationMs
        stat.minMs = min(stat.minMs, durationMs)
        stat.maxMs = max(stat.maxMs, durationMs)
        stages[stage] = stat
        lock.unlock()
    }

    /// Convenience: measure a block and record its duration
    @discardableResult
    func measure<T>(stage: String, _ block: () -> T) -> T {
        guard isEnabled else { return block() }
        let start = CFAbsoluteTimeGetCurrent()
        let result = block()
        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
        record(stage: stage, durationMs: elapsed)
        return result
    }

    /// Convenience: measure a throwing block
    @discardableResult
    func measureThrowing<T>(stage: String, _ block: () throws -> T) rethrows -> T {
        guard isEnabled else { return try block() }
        let start = CFAbsoluteTimeGetCurrent()
        let result = try block()
        let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000.0
        record(stage: stage, durationMs: elapsed)
        return result
    }

    // MARK: - Query

    /// Get all stats as a dictionary suitable for JSON serialization
    func snapshot() -> [String: Any] {
        lock.lock()
        let currentStages = stages
        let ts = resetTimestamp
        lock.unlock()

        var stagesDicts: [String: Any] = [:]
        for (name, stat) in currentStages {
            stagesDicts[name] = stat.toDict()
        }

        return [
            "enabled": isEnabled,
            "reset_timestamp": ISO8601DateFormatter().string(from: ts),
            "stages": stagesDicts,
        ]
    }

    /// Get stats as a JSON string
    func toJSON() -> String {
        let dict = snapshot()
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let str = String(data: data, encoding: .utf8) else {
            return "{\"error\":\"serialization_failed\"}"
        }
        return str
    }

    /// Reset all statistics
    func reset() {
        lock.lock()
        stages.removeAll()
        resetTimestamp = Date()
        lock.unlock()
    }
}

// MARK: - C API

@_cdecl("perf_get_stats")
public func perf_get_stats() -> UnsafeMutablePointer<CChar>? {
    let json = PerformanceTracker.shared.toJSON()
    return strdup(json)
}

@_cdecl("perf_reset_stats")
public func perf_reset_stats() {
    PerformanceTracker.shared.reset()
}

@_cdecl("perf_set_enabled")
public func perf_set_enabled(enabled: Bool) {
    PerformanceTracker.shared.isEnabled = enabled
}
