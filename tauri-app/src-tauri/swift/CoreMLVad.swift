import CoreML
import Foundation

/// Lightweight CoreML Silero VAD wrapper — runs on Apple Neural Engine
/// Model: silero-vad-unified-256ms-v6.0.0 (1MB, from FluidInference/silero-vad-coreml)
///
/// Input:  4160 samples (4096 new + 64 context) at 16kHz = 256ms per chunk
/// Output: speech probability [0, 1]
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

    /// Load the CoreML model from a .mlmodelc directory
    func load(path: String) -> Bool {
        let url = URL(fileURLWithPath: path)
        let config = MLModelConfiguration()
        config.computeUnits = .all  // prefer ANE

        do {
            model = try MLModel(contentsOf: url, configuration: config)
            NSLog("[CoreMLVad] Model loaded from %@", path)
            return true
        } catch {
            NSLog("[CoreMLVad] Failed to load model: %@", error.localizedDescription)
            return false
        }
    }

    /// Process one chunk of 4096 new samples. Returns speech probability [0, 1].
    /// Feed audio in 256ms chunks (4096 samples at 16kHz).
    func process(samples: [Float]) -> Float {
        guard let model else { return 0 }

        // Pad or trim to chunkSize
        var chunk: [Float]
        if samples.count >= CoreMLVad.chunkSize {
            chunk = Array(samples.prefix(CoreMLVad.chunkSize))
        } else {
            chunk = samples
            let pad = samples.last ?? 0
            chunk.append(contentsOf: [Float](repeating: pad, count: CoreMLVad.chunkSize - samples.count))
        }

        // Build input: [context (64) | new audio (4096)] = 4160
        var audioInput = context + chunk

        // Save context for next call (last 64 samples of current chunk)
        context = Array(chunk.suffix(CoreMLVad.contextSize))

        do {
            let audioArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.inputSize)], dataType: .float32)
            let hiddenArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.stateSize)], dataType: .float32)
            let cellArray = try MLMultiArray(shape: [1, NSNumber(value: CoreMLVad.stateSize)], dataType: .float32)

            // Copy data
            let audioPtr = audioArray.dataPointer.assumingMemoryBound(to: Float.self)
            audioInput.withUnsafeBufferPointer { buf in
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
                    hiddenState = Array(UnsafeBufferPointer(start: ptr, count: CoreMLVad.stateSize))
                }
                if let newCell = output.featureValue(for: "new_cell_state")?.multiArrayValue {
                    let ptr = newCell.dataPointer.assumingMemoryBound(to: Float.self)
                    cellState = Array(UnsafeBufferPointer(start: ptr, count: CoreMLVad.stateSize))
                }

                return prob
            }
        } catch {
            NSLog("[CoreMLVad] Inference error: %@", error.localizedDescription)
        }

        return 0
    }

    /// Reset LSTM state (call between segments/speakers)
    func resetState() {
        hiddenState = [Float](repeating: 0, count: CoreMLVad.stateSize)
        cellState   = [Float](repeating: 0, count: CoreMLVad.stateSize)
        context     = [Float](repeating: 0, count: CoreMLVad.contextSize)
    }
}
