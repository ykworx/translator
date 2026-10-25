import Accelerate
import CoreML
import Foundation

/// Core ML Silero VAD wrapper — the OS chooses CPU, GPU, or Neural Engine.
/// Model: silero-vad-unified-256ms-v6.0.0 (1MB, from FluidInference/silero-vad-coreml)
///
/// Input:  4160 samples (4096 new + 64 context) at 16kHz = 256ms per chunk
/// Output: speech probability [0, 1]
///
/// Trade-off: coarser granularity (256ms vs 32ms) but fewer inferences needed.
///
/// WhisperEngine loads this bundled model before accepting audio.
/// Compute-unit eligibility is not a measurement of Neural Engine execution.
final class CoreMLVad {
    static let chunkSize = 4096       // new samples per call (256ms at 16kHz)
    static let contextSize = 64       // context samples from previous chunk
    static let inputSize = chunkSize + contextSize  // 4160
    static let stateSize = 128        // LSTM hidden/cell state size

    private var model: MLModel?

    // LSTM state (persists across chunks)
    private var hiddenState = [Float](repeating: 0, count: stateSize)
    private var cellState   = [Float](repeating: 0, count: stateSize)
    private var context     = [Float](repeating: 0, count: contextSize)

    // Pre-allocated buffers to avoid per-call allocation (~1-2ms savings per inference)
    private var reusableAudioInput = [Float](repeating: 0, count: inputSize)
    private var reusableAudioArray: MLMultiArray?
    private var reusableHiddenArray: MLMultiArray?
    private var reusableCellArray: MLMultiArray?

    /// Load the CoreML model from a .mlmodelc directory
    func load(path: String) -> Bool {
        let url = URL(fileURLWithPath: path)
        let config = MLModelConfiguration()
        config.computeUnits = .all  // allow OS selection; do not force a slower device

        do {
            model = try MLModel(contentsOf: url, configuration: config)
            // Pre-allocate MLMultiArrays once (avoids ~1-2ms allocation per inference)
            reusableAudioArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.inputSize)], dataType: .float32)
            reusableHiddenArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.stateSize)], dataType: .float32)
            reusableCellArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.stateSize)], dataType: .float32)
            NSLog("[CoreMLVad] Model loaded from %@ (MLMultiArrays pre-allocated)", path)
            return true
        } catch {
            NSLog("[CoreMLVad] Failed to load model: %@", error.localizedDescription)
            return false
        }
    }

    /// Process one chunk of 4096 new samples. Returns speech probability [0, 1].
    /// Feed audio in 256ms chunks (4096 samples at 16kHz).
    /// Uses pre-allocated MLMultiArrays and audioInput buffer to avoid per-call allocation.
    func process(samples: [Float]) -> Float {
        let perfStart = CFAbsoluteTimeGetCurrent()
        guard let model,
              let audioArray = reusableAudioArray,
              let hiddenArray = reusableHiddenArray,
              let cellArray = reusableCellArray else { return 0 }

        // Build input in-place: [context (64) | new audio (4096)] = 4160
        // Reuse reusableAudioInput — no allocation per call
        reusableAudioInput.withUnsafeMutableBufferPointer { dst in
            // Copy context (64 samples)
            context.withUnsafeBufferPointer { src in
                dst.baseAddress!.update(from: src.baseAddress!, count: CoreMLVad.contextSize)
            }
            // Copy new audio (pad/trim to 4096)
            samples.withUnsafeBufferPointer { src in
                let copyCount = min(src.count, CoreMLVad.chunkSize)
                (dst.baseAddress! + CoreMLVad.contextSize).update(from: src.baseAddress!, count: copyCount)
                // Zero-pad a final short frame; repeating a nonzero sample creates artificial DC
                if copyCount < CoreMLVad.chunkSize {
                    let padValue = Float(0)
                    for i in copyCount..<CoreMLVad.chunkSize {
                        (dst.baseAddress! + CoreMLVad.contextSize + i).pointee = padValue
                    }
                }
            }
        }

        // Save context for next call (last 64 samples of new audio)
        let srcOffset = min(samples.count, CoreMLVad.chunkSize) - CoreMLVad.contextSize
        if srcOffset >= 0 {
            samples.withUnsafeBufferPointer { src in
                context.withUnsafeMutableBufferPointer { dst in
                    dst.baseAddress!.update(from: src.baseAddress! + srcOffset, count: CoreMLVad.contextSize)
                }
            }
        }

        do {
            // Copy data into pre-allocated MLMultiArrays (reuse, no allocation)
            let audioPtr = audioArray.dataPointer.assumingMemoryBound(to: Float.self)
            reusableAudioInput.withUnsafeBufferPointer { buf in
                audioPtr.update(from: buf.baseAddress!, count: CoreMLVad.inputSize)
            }

            let hiddenPtr = hiddenArray.dataPointer.assumingMemoryBound(to: Float.self)
            hiddenState.withUnsafeBufferPointer { buf in
                hiddenPtr.update(from: buf.baseAddress!, count: CoreMLVad.stateSize)
            }

            let cellPtr = cellArray.dataPointer.assumingMemoryBound(to: Float.self)
            cellState.withUnsafeBufferPointer { buf in
                cellPtr.update(from: buf.baseAddress!, count: CoreMLVad.stateSize)
            }

            let input = try MLDictionaryFeatureProvider(dictionary: [
                "audio_input": audioArray,
                "hidden_state": hiddenArray,
                "cell_state": cellArray,
            ])

            let output = try model.prediction(from: input)

            // Read outputs
            if let vadOut = output.featureValue(for: "vad_output")?.multiArrayValue {
                let prob = vadOut.dataPointer.assumingMemoryBound(to: Float.self)[0]

                // Update LSTM state
                if let newHidden = output.featureValue(for: "new_hidden_state")?.multiArrayValue {
                    let ptr = newHidden.dataPointer.assumingMemoryBound(to: Float.self)
                    hiddenState.withUnsafeMutableBufferPointer { dst in
                        dst.baseAddress!.update(from: ptr, count: CoreMLVad.stateSize)
                    }
                }
                if let newCell = output.featureValue(for: "new_cell_state")?.multiArrayValue {
                    let ptr = newCell.dataPointer.assumingMemoryBound(to: Float.self)
                    cellState.withUnsafeMutableBufferPointer { dst in
                        dst.baseAddress!.update(from: ptr, count: CoreMLVad.stateSize)
                    }
                }

                let perfElapsed = (CFAbsoluteTimeGetCurrent() - perfStart) * 1000.0
                PerformanceTracker.shared.record(stage: "coreml_vad_process", durationMs: perfElapsed)
                return prob
            }
        } catch {
            NSLog("[CoreMLVad] Inference error: %@", error.localizedDescription)
        }

        return 0
    }

    /// Compute peak amplitude of samples using vDSP (vectorized, SIMD-accelerated)
    func peakAmplitude(samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var peak: Float = 0
        samples.withUnsafeBufferPointer { buf in
            vDSP_maxmgv(buf.baseAddress!, 1, &peak, vDSP_Length(buf.count))
        }
        return peak
    }

    /// Reset LSTM state (call between segments/speakers)
    func resetState() {
        hiddenState.withUnsafeMutableBufferPointer { buf in
            vDSP_vclr(buf.baseAddress!, 1, vDSP_Length(CoreMLVad.stateSize))
        }
        cellState.withUnsafeMutableBufferPointer { buf in
            vDSP_vclr(buf.baseAddress!, 1, vDSP_Length(CoreMLVad.stateSize))
        }
        context.withUnsafeMutableBufferPointer { buf in
            vDSP_vclr(buf.baseAddress!, 1, vDSP_Length(CoreMLVad.contextSize))
        }
    }
}
