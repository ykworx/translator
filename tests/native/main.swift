import Foundation

var checks = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    checks += 1
    guard condition() else { fatalError("FAIL: \(message)") }
}

var session = DictationSession()
let first = session.begin()
check(session.phase == .preparing, "begin prepares without claiming to record")
check(session.transition(.preparing, to: .recording, session: first), "matching prepare may record")
check(!session.transition(.preparing, to: .recording, session: first), "duplicate start is rejected")
check(session.transition(.recording, to: .finalizing, session: first), "stop waits for final inference")
session.cancel()
check(!session.transition(.finalizing, to: .result, session: first), "cancelled completion cannot insert")
let second = session.begin()
check(second != first, "new recording has a new identity")
check(!session.transition(.preparing, to: .recording, session: first), "old model-load completion cannot start new session")
check(session.phase == .preparing, "stale callback leaves new recording intact")
check(session.transition(.preparing, to: .recording, session: second), "new session can start")
check(session.transition(.recording, to: .finalizing, session: second), "new session can stop")
check(session.transition(.finalizing, to: .result, session: second), "successful completion reaches result once")
check(!session.transition(.finalizing, to: .result, session: second), "duplicate completion cannot insert twice")
session.cancel()
check(session.phase == .idle, "dismissing a result returns to idle")
let loading = session.begin()
session.cancel()
check(!session.transition(.preparing, to: .recording, session: loading), "cancelling model preparation prevents late recording")
check(session.phase == .idle, "cancelled model preparation stays idle")
let restarted = session.begin()
check(restarted != loading, "cancel and restart never reuse a session identity")
check(!session.transition(.recording, to: .result, session: restarted), "unexpected completion cannot skip preparation")

var words = DictationTranscript()
words.partial = "첫 번째 초안"
words.partial = "첫 번째 문장"
check(words.text == "첫 번째 문장", "partial hypotheses replace each other")
words.appendFinal("첫 번째 문장")
words.partial = "次の文"
check(words.text == "첫 번째 문장 次の文", "later partial does not overwrite earlier speech")
words.appendFinal("次の文")
words.appendFinal("次の文")
words.appendFinal("  \n")
check(words.text == "첫 번째 문장 次の文 次の文", "intentional repeated speech and Unicode survive")
words.partial = "unfinished"
words.partial = ""
check(words.text == "첫 번째 문장 次の文 次の文", "discarding partial retains every final segment")
var japanese = DictationTranscript(separator: "")
japanese.appendFinal("  最初の文です。 \n")
japanese.partial = "次の文"
check(japanese.text == "最初の文です。次の文", "Japanese partial joins without artificial spaces")
japanese.appendFinal("次の文です。")
check(japanese.text == "最初の文です。次の文です。", "Japanese final segments preserve sentence boundaries")
japanese.appendFinal("次の文です。")
check(japanese.text == "最初の文です。次の文です。次の文です。", "Japanese intentional repetition survives finalization")
var empty = DictationTranscript()
empty.appendFinal("\t \n")
check(empty.text.isEmpty, "silence cannot create a finalized empty segment")
empty.partial = "한글 👩🏽‍💻 café"
empty.appendFinal("한글 👩🏽‍💻 café")
check(empty.text == "한글 👩🏽‍💻 café", "Unicode graphemes survive partial-to-final replacement")

check(DictationDeliveryPolicy.canInsert(sameApp: true, sameElement: true, sameSelection: true, sameValue: true, secure: false), "unchanged editable target accepts text")
for changed in 0..<5 {
    check(!DictationDeliveryPolicy.canInsert(sameApp: changed != 0, sameElement: changed != 1,
        sameSelection: changed != 2, sameValue: changed != 3, secure: changed == 4),
        "app/field/caret/text/security change must prevent insertion (\(changed))")
}
check(DictationDeliveryPolicy.shouldRestoreClipboard(ownedCount: 42, currentCount: 42), "owned clipboard is restored")
check(!DictationDeliveryPolicy.shouldRestoreClipboard(ownedCount: 42, currentCount: 43), "new user copy must survive")
check(!DictationDeliveryPolicy.shouldRestoreClipboard(ownedCount: 42, currentCount: 44), "an older restore cannot overwrite a newer dictation lease")
var silence = SilenceTracker()
for _ in 0..<56 {
    check(!silence.append(sampleCount: 342, isSilent: true), "48kHz tap chunks must not finalize before 1.2 seconds")
}
check(silence.consecutiveSamples == 19_152, "silence tracks sample duration instead of callback count")
check(silence.append(sampleCount: 342, isSilent: true), "57 converted chunks pass the silence boundary")
check(!silence.append(sampleCount: 160, isSilent: false), "speech breaks consecutive silence")
check(silence.consecutiveSamples == 0, "speech resets elapsed silence")
check(!silence.append(sampleCount: 19_199, isSilent: true), "silence just below the threshold does not finalize")
check(silence.append(sampleCount: 1, isSilent: true), "silence finalizes exactly at the threshold")
silence.reset()
check(silence.consecutiveSamples == 0, "session reset clears silence duration")
var shortBoundary = SilenceTracker(requiredSamples: 10)
check(!shortBoundary.append(sampleCount: 4, isSilent: true), "custom silence threshold accepts partial duration")
check(!shortBoundary.append(sampleCount: 5, isSilent: true), "irregular buffers accumulate actual samples")
check(shortBoundary.append(sampleCount: 1, isSilent: true), "irregular buffers cross the configured threshold")
print("Passed \(checks) native dictation state, transcript, focus, and clipboard checks.")
