import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

describe("microphone lifecycle", () => {
  let button: HTMLButtonElement;
  let input: HTMLTextAreaElement;
  let status: HTMLDivElement;
  let calls: string[];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    resetInvokeCommands();
    resetTauriStore();
    calls = [];
    document.body.innerHTML = '<textarea id="input"></textarea><div id="status"></div><button id="mic"></button>';
    button = document.querySelector("#mic")!;
    input = document.querySelector("#input")!;
    status = document.querySelector("#status")!;
    for (const [name, result] of [
      ["request_speech_permissions", { authorized: true, modelLoaded: false }],
      ["set_whisper_domain_hint", undefined],
      ["ensure_whisper_loaded", undefined],
      ["start_speech_recognition", { transcript: "", isRunning: true, isFinal: false }],
    ] as const) {
      registerInvokeCommand(name, () => { calls.push(name); return result; });
    }
    const { initSpeechInput } = await import("../src/speechInput");
    initSpeechInput(input, status, button, () => {});
  });

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); resetInvokeCommands(); });

  it("loads a cold model after OS permission checks, before opening the microphone", async () => {
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["request_speech_permissions", "set_whisper_domain_hint", "ensure_whisper_loaded", "start_speech_recognition"]);
    expect(button.textContent).toContain("중지");
  });

  it("sends an empty hint to clear the previous session's hint", async () => {
    setTauriStoreValue("domainHint", "");
    const setHint = vi.fn();
    registerInvokeCommand("set_whisper_domain_hint", setHint);
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(setHint).toHaveBeenCalledWith({ hint: "" });
  });

  it("keeps stop pending until the final transcript is delivered", async () => {
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    let finish: (value: unknown) => void = () => {};
    registerInvokeCommand("stop_speech_recognition", () => new Promise(resolve => { finish = resolve; }));
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(button.disabled).toBe(true);
    finish({ transcript: "첫 문장 마지막 문장", isRunning: false, isFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("첫 문장 마지막 문장");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("음성");
  });

  it("does not load a model or start capture when microphone permission is denied", async () => {
    registerInvokeCommand("request_speech_permissions", () => ({ authorized: false, error: "마이크 권한 필요" }));
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    expect(status.textContent).toBe("마이크 권한 필요");
    expect(button.disabled).toBe(false);
  });

  it("finalizes a disconnected microphone before allowing another start and preserves the original error", async () => {
    const disconnected = "마이크 연결이 변경되었습니다.";
    const stop = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    let finish: (value: unknown) => void = () => {};
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "첫 문장", isRunning: true, error: disconnected }));
    registerInvokeCommand("stop_speech_recognition", stop);
    button.click();
    await vi.advanceTimersByTimeAsync(350);
    expect(stop).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    button.click();
    expect(calls.filter(name => name === "start_speech_recognition")).toHaveLength(1);
    finish({ transcript: "첫 문장 마지막 단어", isRunning: false, isFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("첫 문장 마지막 단어");
    expect(status.textContent).toBe(disconnected);
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("음성");
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter(name => name === "start_speech_recognition")).toHaveLength(2);
  });

  it("cleans up native capture after a polling IPC failure", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => { throw new Error("상태 조회 실패"); });
    const stop = vi.fn(() => ({ transcript: "마지막 확정 결과", isRunning: false, isFinal: true }));
    registerInvokeCommand("stop_speech_recognition", stop);
    button.click();
    await vi.advanceTimersByTimeAsync(350);
    expect(stop).toHaveBeenCalledOnce();
    expect(input.value).toBe("마지막 확정 결과");
    expect(status.textContent).toBe("상태 조회 실패");
    expect(button.textContent).toContain("음성");
    expect(button.disabled).toBe(false);
  });

  it("retries failed error cleanup instead of starting a second capture", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "보존할 발화", isRunning: true, error: "마이크 분리" }));
    const stop = vi.fn().mockRejectedValueOnce(new Error("중지 IPC 실패"))
      .mockResolvedValue({ transcript: "보존할 발화 끝", isRunning: false, isFinal: true });
    registerInvokeCommand("stop_speech_recognition", stop);
    button.click();
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("보존할 발화");
    expect(status.textContent).toContain("마이크 분리");
    expect(status.textContent).toContain("다시 시도");
    expect(button.textContent).toContain("중지");
    expect(button.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stop).toHaveBeenCalledOnce();
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(calls.filter(name => name === "start_speech_recognition")).toHaveLength(1);
    expect(input.value).toBe("보존할 발화 끝");
    expect(status.textContent).toBe("마이크 분리");
    expect(button.textContent).toContain("음성");
  });

  it("keeps stop mode when native capture reports that it is still running", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "내 발화", isRunning: true, error: "마이크 오류" }));
    const stop = vi.fn().mockResolvedValueOnce({ transcript: "다른 세션 결과", isRunning: true, error: "아직 사용 중" })
      .mockResolvedValue({ transcript: "내 발화 확정", isRunning: false, isFinal: true });
    registerInvokeCommand("stop_speech_recognition", stop);
    button.click();
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("내 발화");
    expect(button.textContent).toContain("중지");
    expect(status.textContent).toContain("다시 시도");
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("내 발화 확정");
  });

  it("ignores an in-flight poll error after the user has already requested stop", async () => {
    let finishPoll: (value: unknown) => void = () => {};
    let finishStop: (value: unknown) => void = () => {};
    registerInvokeCommand("get_speech_recognition_state", () => new Promise(resolve => { finishPoll = resolve; }));
    const stop = vi.fn(() => new Promise(resolve => { finishStop = resolve; }));
    registerInvokeCommand("stop_speech_recognition", stop);
    button.click();
    await vi.advanceTimersByTimeAsync(350);
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    finishPoll({ transcript: "늦은 이전 결과", isRunning: true, error: "이전 폴링 오류" });
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(input.value).not.toBe("늦은 이전 결과");
    expect(status.textContent).not.toContain("이전 폴링 오류");
    finishStop({ transcript: "사용자가 확정한 결과", isRunning: false, isFinal: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("사용자가 확정한 결과");
    expect(button.disabled).toBe(false);
  });
  it("appends partial and final speech after the existing draft without duplicating partials", async () => {
    input.value = "기존 초안";
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "인식 중", isRunning: true }));
    registerInvokeCommand("stop_speech_recognition", () => ({ transcript: "인식 완료", isRunning: false, isFinal: true }));
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("기존 초안");
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("기존 초안\n인식 중");
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("기존 초안\n인식 중");
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("기존 초안\n인식 완료");
  });

  it("preserves edits while recording and offers the final transcript for explicit recovery", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "인식 중", isRunning: true }));
    registerInvokeCommand("stop_speech_recognition", () => ({ transcript: "별도로 보관한 최종 결과", isRunning: false }));
    input.value = "처음 초안";
    button.click(); await vi.advanceTimersByTimeAsync(350);
    input.value = "직접 편집한 초안";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("직접 편집한 초안");
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("직접 편집한 초안");
    expect(status.querySelector("pre")!.textContent).toBe("별도로 보관한 최종 결과");
    expect(button.disabled).toBe(true);
    status.querySelector<HTMLButtonElement>(".speech-recovery button")!.click();
    expect(input.value).toBe("직접 편집한 초안\n별도로 보관한 최종 결과");
    expect(button.disabled).toBe(false);
    expect(status.textContent).toBe("");
  });

  it("does not modify an active IME composition and allows recovery after it ends", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "음성", isRunning: true }));
    registerInvokeCommand("stop_speech_recognition", () => ({ transcript: "최종 음성", isRunning: false }));
    button.click(); await vi.advanceTimersByTimeAsync(0);
    input.value = "한글 조합";
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    await vi.advanceTimersByTimeAsync(350);
    button.click(); await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("한글 조합");
    const add = status.querySelector<HTMLButtonElement>(".speech-recovery button")!;
    expect(add.disabled).toBe(true);
    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(add.disabled).toBe(false);
    add.click();
    expect(input.value).toBe("한글 조합\n최종 음성");
  });

  it("detects programmatic draft replacement and discards only the separate speech result", async () => {
    registerInvokeCommand("get_speech_recognition_state", () => ({ transcript: "별도 인식", isRunning: false }));
    button.click(); await vi.advanceTimersByTimeAsync(0);
    input.value = "다른 기능이 작성한 초안";
    await vi.advanceTimersByTimeAsync(350);
    expect(input.value).toBe("다른 기능이 작성한 초안");
    const buttons = status.querySelectorAll<HTMLButtonElement>(".speech-recovery button");
    buttons[1].click();
    expect(input.value).toBe("다른 기능이 작성한 초안");
    expect(button.disabled).toBe(false);
  });

  it("protects edits made while a cold model is loading", async () => {
    let finish!: () => void;
    registerInvokeCommand("ensure_whisper_loaded", () => new Promise<void>(resolve => { finish = resolve; }));
    button.click(); await vi.advanceTimersByTimeAsync(0);
    const { isSpeechInputActive } = await import("../src/speechInput");
    expect(isSpeechInputActive()).toBe(true);
    input.value = "기다리며 쓴 글";
    input.dispatchEvent(new Event("input"));
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("기다리며 쓴 글");
  });

});
