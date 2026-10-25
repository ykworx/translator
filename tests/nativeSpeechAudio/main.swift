import Foundation

var checks = 0
func check(_ condition: Bool, _ message: String) {
    guard condition else { fatalError(message) }
    checks += 1
}

check(SpeechDenoiser.process([]) == [], "empty audio stays empty")
for count in [1, 159, 160, 161, 4096, 16000] {
    let input = [Float](repeating: 0, count: count)
    guard let output = SpeechDenoiser.process(input) else { fatalError("conversion unavailable") }
    check(output.count == count, "frame boundaries preserve sample positions")
    check(output.allSatisfy { $0.isFinite && abs($0) < 0.00001 }, "silence cannot create nonzero or invalid samples")
}
let probe = (0..<16000).map { Float(sin(Double($0) * 0.04) * 0.2) }
let first = SpeechDenoiser.process(probe)!
let second = SpeechDenoiser.process(probe)!
check(first.count == probe.count && first.allSatisfy { $0.isFinite }, "nonzero audio retains finite samples and duration")
check(zip(first, second).allSatisfy { abs($0 - $1) < 0.000001 }, "separate snapshots do not leak denoiser state")
print("Passed \(checks) native RNNoise/resampling checks without model or microphone access.")
