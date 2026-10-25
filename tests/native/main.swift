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

var recovery = DictationResultPolicy()
check(recovery.shortcutAction(phase: .idle) == .begin, "without a result the shortcut starts preparation")
check(recovery.canPreview(phase: .idle), "idle without a recovery result permits preview")
for phase in [DictationSession.Phase.preparing, .recording, .finalizing, .result] {
    check(!recovery.canPreview(phase: phase), "preview never replaces a non-idle session (\(phase))")
}
recovery.receiveResult()
check(recovery.pending, "a completed result must be explicitly handled")
for phase in [DictationSession.Phase.idle, .result] {
    check(recovery.shortcutAction(phase: phase) == .copyResult, "the registered shortcut copies pending recovery instead of starting recording")
    check(!recovery.canPreview(phase: phase), "preview cannot replace an unhandled result")
}
check(recovery.pending, "choosing copy without a successful write keeps the result pending")
check(recovery.shortcutAction(phase: .recording) == .finish, "recording shortcut still finishes rather than copying")
check(recovery.shortcutAction(phase: .preparing) == .cancelPreparation, "preparation shortcut still cancels")
check(recovery.shortcutAction(phase: .finalizing) == .wait, "finalization cannot be interrupted by another start or copy")
check(!recovery.requestClose(now: 10), "one close cannot silently discard an unhandled result")
check(recovery.pending, "a discard confirmation never clears the result itself")
check(!recovery.requestClose(now: 15.1), "an expired confirmation requires another explicit close")
check(recovery.requestClose(now: 16), "a second close inside the new interval confirms disposal")
check(recovery.pending, "even confirmed disposal leaves ownership with the controller until it closes")
recovery.cancelDiscard()
check(!recovery.requestClose(now: 17), "another action cancels armed discard confirmation")
recovery.allowNextSession()
check(!recovery.pending, "only successful copy or existing insertion policy releases the next start")
check(recovery.shortcutAction(phase: .result) == .begin, "after copy the next shortcut may begin a fresh session")
check(recovery.requestClose(now: 18), "a handled result closes without confirmation")
recovery.completeCopy(succeeded: false)
check(recovery.pending, "a failed recovery copy re-protects a result even after automatic insertion was posted")
check(recovery.shortcutAction(phase: .result) == .copyResult, "after a failed recovery copy the shortcut retries copy rather than discarding into a new recording")
check(!recovery.requestClose(now: 18.1), "a failed recovery copy restores discard confirmation")
recovery.completeCopy(succeeded: true)
check(!recovery.pending, "a successful retry releases the next recording")
recovery.receiveResult()
check(!recovery.requestClose(now: 19), "new results never inherit an older discard confirmation")

check(DictationRecordingClock.display(0) == "00:00 / 03:00", "clock exposes the maximum duration from the start")
check(DictationRecordingClock.display(59.9) == "00:59 / 03:00", "clock does not round into the next minute early")
check(DictationRecordingClock.display(60) == "01:00 / 03:00", "clock crosses minute boundaries")
check(DictationRecordingClock.display(-1) == "00:00 / 03:00", "clock changes cannot show a negative recording duration")
check(DictationRecordingClock.warning(164.9) == nil, "automatic completion warning is reserved for the final fifteen seconds")
check(DictationRecordingClock.warning(165) == "15초 후 자동 완료 · Esc로 취소", "warning starts at exactly fifteen seconds remaining")
check(!DictationRecordingClock.reachedLimit(179.99), "recording must not auto-finish before three minutes")
check(DictationRecordingClock.reachedLimit(180), "recording auto-finishes at the three-minute boundary")
check(DictationRecordingClock.reachedLimit(181), "a delayed timer still auto-finishes")
check(DictationRecordingClock.display(181) == "03:00 / 03:00", "a delayed timer never displays beyond the maximum")
check(DictationRecordingClock.warning(181) == "0초 후 자동 완료 · Esc로 취소", "late timer warnings never count below zero")

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

// A short speech detection must never restore rejected background samples.
let noisyContext = [Float](repeating: 9, count: 16000) + [Float](repeating: 1, count: 4096) + [Float](repeating: 9, count: 16000)
let selectedSpeech = SpeechAudioPolicy.speechSamples(noisyContext, chunks: [16000..<20096])
check(selectedSpeech.count == 25600, "short speech receives silence padding for decoder context")
check(selectedSpeech.filter { $0 == 9 }.count == 3200, "only 100ms speech boundaries retain nearby background")
check(selectedSpeech.filter { $0 == 1 }.count == 4096, "short utterance samples are kept intact")
check(SpeechAudioPolicy.speechSamples(noisyContext, chunks: []).isEmpty, "no speech never reaches the decoder")
check(SpeechAudioPolicy.ranges(sampleCount: 10000, speechChunks: [1000..<3000, 3000..<5000]) == [0..<6600], "adjacent speech padding is merged without duplicating audio")
check(SpeechAudioPolicy.ranges(sampleCount: 10000, speechChunks: [0..<1000, 9000..<10000]) == [0..<2600, 7400..<10000], "distant speech regions retain bounded edges")



var rejectedPartial = DictationTranscript()
rejectedPartial.appendFinal("보존할 발화")
rejectedPartial.partial = "잡음 초안"
rejectedPartial.appendFinal("")
check(rejectedPartial.text == "보존할 발화", "a rejected final clears only its provisional text")
print("Passed \(checks) native dictation state, transcript, focus, and clipboard checks.")
