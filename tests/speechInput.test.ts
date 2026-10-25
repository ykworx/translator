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
});
