import Foundation

/// Keep only detected speech plus boundary context. Padding never restores
/// discarded background audio, even for a one-word utterance.
enum SpeechAudioPolicy {
    static func ranges(sampleCount: Int, speechChunks: [Range<Int>], padding: Int = 1600) -> [Range<Int>] {
        var result: [Range<Int>] = []
        for chunk in speechChunks {
            let start = max(0, chunk.lowerBound - padding)
            let end = min(sampleCount, chunk.upperBound + padding)
            guard start < end else { continue }
            if let previous = result.last, start <= previous.upperBound {
                result[result.count - 1] = previous.lowerBound..<max(previous.upperBound, end)
            } else { result.append(start..<end) }
        }
        return result
    }

    static func speechSamples(_ samples: [Float], chunks: [Range<Int>], minimumSamples: Int = 25_600) -> [Float] {
        let selected = ranges(sampleCount: samples.count, speechChunks: chunks)
        guard !selected.isEmpty else { return [] }
        var result = selected.flatMap { Array(samples[$0]) }
        if result.count < minimumSamples {
            result += [Float](repeating: 0, count: minimumSamples - result.count)
        }
        return result
    }
}
