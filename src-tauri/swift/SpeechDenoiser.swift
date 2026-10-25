import AVFoundation
import Foundation

/// Snapshot processing runs on the inference queue, never on the microphone
/// tap. RNNoise expects 48 kHz PCM; AVAudioConverter supplies both resamplers.
enum SpeechDenoiser {
    static func process(_ samples: [Float]) -> [Float]? {
        guard !samples.isEmpty else { return [] }
        guard let input = convert(samples, from: 16000, to: 48000),
              let state = rnnoise_create(nil) else { return nil }
        defer { rnnoise_destroy(state) }
        let frameSize = Int(rnnoise_get_frame_size())
        guard frameSize > 0 else { return nil }
        var output: [Float] = []
        // RNNoise has one frame of algorithmic delay. Drain it at the end and
        // remove the initial delayed frame, preserving short utterance endings.
        let frameCount = (input.count + frameSize - 1) / frameSize + 1
        for index in 0..<frameCount {
            var frame = [Float](repeating: 0, count: frameSize)
            let start = index * frameSize
            if start < input.count {
                for j in 0..<min(frameSize, input.count - start) { frame[j] = input[start + j] * 32768 }
            }
            frame.withUnsafeMutableBufferPointer { buffer in
                _ = rnnoise_process_frame(state, buffer.baseAddress!, buffer.baseAddress!)
            }
            if index > 0 { output.append(contentsOf: frame.map { $0 / 32768 }) }
        }
        output = Array(output.prefix(input.count))
        guard var converted = convert(output, from: 48000, to: 16000) else { return nil }
        if converted.count < samples.count { converted += [Float](repeating: 0, count: samples.count - converted.count) }
        return Array(converted.prefix(samples.count))
    }

    private static func convert(_ samples: [Float], from sourceRate: Double, to targetRate: Double) -> [Float]? {
        guard let source = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sourceRate, channels: 1, interleaved: false),
              let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: targetRate, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: source, to: target),
              let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(samples.count)),
              let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(ceil(Double(samples.count) * targetRate / sourceRate)) + 1024),
              let channel = input.floatChannelData?[0] else { return nil }
        input.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        converter.primeMethod = .none
        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if consumed { state.pointee = .endOfStream; return nil }
            consumed = true
            state.pointee = .haveData
            return input
        }
        guard error == nil, status != .error, output.frameLength > 0,
              let data = output.floatChannelData?[0] else { return nil }
        return Array(UnsafeBufferPointer(start: data, count: Int(output.frameLength)))
    }
}
