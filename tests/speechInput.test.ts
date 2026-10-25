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
});
