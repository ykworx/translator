import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMock, registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

const api = vi.hoisted(() => ({ translateStream: vi.fn(), suggestReplies: vi.fn(), summarize: vi.fn(), koreanPronunciation: vi.fn() }));
vi.mock("../src/api", () => api);
vi.mock("../src/speechInput", () => ({ initSpeechInput: vi.fn() }));
vi.mock("../src/appCaptions", () => ({ initAppCaptions: vi.fn(), forceStopCaptions: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/clipboardTranslate", () => ({ initClipboardListeners: vi.fn() }));
vi.mock("../src/handwriting", () => ({ initHandwriting: vi.fn() }));

const html = readFileSync(resolve("index.html"), "utf8");

describe("manual translation input", () => {
  let listeners: Array<[Document | Window, string, EventListenerOrEventListenerObject]>;
  const input = () => document.getElementById("input-field") as HTMLTextAreaElement;
  const submit = () => document.getElementById("btn-translate") as HTMLButtonElement;
  const entries = () => [...document.querySelectorAll<HTMLElement>("#chat .entry")];

  beforeEach(async () => {
    vi.resetModules();
    resetTauriStore();
    resetInvokeCommands();
    installTauriMock();
    setTauriStoreValue("llmBackendId", "ollama");
    setTauriStoreValue("targetLanguage", "English");
    api.translateStream.mockReset().mockResolvedValue("translated");
    document.documentElement.innerHTML = html;
    listeners = [];
    for (const target of [document, window]) {
      const original = target.addEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (listener) listeners.push([target, type, listener]);
        original(type, listener, options);
      });
    }
    await import("../src/main");
    await vi.waitFor(() => expect((document.getElementById("lang-select") as HTMLSelectElement).value).toBe("English"));
    await vi.waitFor(() => expect(document.querySelector(".empty-state")).not.toBeNull());
  });

  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    vi.restoreAllMocks();
    resetInvokeCommands();
  });

  function draft(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  }
  function enter(options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options });
    input().dispatchEvent(event);
    return event;
  }
  function deferred() {
    let resolve!: (text: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((success, failure) => { resolve = success; reject = failure; });
    api.translateStream.mockReturnValueOnce(promise);
    return { resolve, reject };
  }

  it.each([
    { isComposing: true },
    { keyCode: 229 },
  ])("does not send or suppress an IME confirmation Enter (%j)", options => {
    draft("日本語を変換中");
    expect(enter(options).defaultPrevented).toBe(false);
    expect(api.translateStream).not.toHaveBeenCalled();
    expect(input().value).toBe("日本語を変換中");
  });

  it("keeps composition Enter local until composition ends, then permits a normal submission", async () => {
    draft("한글 조합");
    input().dispatchEvent(new CompositionEvent("compositionstart"));
    expect(submit().disabled).toBe(true);
    expect(enter().defaultPrevented).toBe(false);
    input().dispatchEvent(new CompositionEvent("compositionend"));
    expect(submit().disabled).toBe(false);
    expect(enter().defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    expect(api.translateStream.mock.calls[0][0]).toBe("한글 조합");
  });

  it("leaves Shift+Enter available for a newline and explains both shortcuts", () => {
    draft("first line");
    expect(enter({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(api.translateStream).not.toHaveBeenCalled();
    expect(input().getAttribute("aria-describedby")).toBe("input-hint");
    expect(document.getElementById("input-hint")!.textContent).toContain("Shift+Enter");
  });

  it("has an explicit submit button and disables only submission while another draft remains editable", async () => {
    const pending = deferred();
    expect(submit().disabled).toBe(true);
    draft("first request");
    submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    expect(submit().disabled).toBe(true);
    expect(submit().getAttribute("aria-busy")).toBe("true");
    expect(input().disabled).toBe(false);
    draft("next draft");
    enter();
    submit().click();
    expect(api.translateStream).toHaveBeenCalledOnce();
    pending.resolve("done");
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
    expect(submit().disabled).toBe(false);
    expect(input().value).toBe("next draft");
  });

  it("preserves the new draft on failure and keeps the failed source in chat history", async () => {
    const pending = deferred();
    draft("failed source");
    submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    draft("new draft while waiting");
    pending.reject(new Error("fixture provider error"));
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
    expect(input().value).toBe("new draft while waiting");
    expect(entries().some(entry => entry.textContent?.includes("failed source") && entry.textContent?.includes("fixture provider error"))).toBe(true);
  });

  it("restores the failed source when the textarea is still empty", async () => {
    api.translateStream.mockRejectedValueOnce(new Error("fixture failure"));
    draft("restore this source");
    submit().click();
    await vi.waitFor(() => expect(input().value).toBe("restore this source"));
    expect(submit().disabled).toBe(false);
  });

  it("does not overwrite an empty but active new composition when the previous request fails", async () => {
    const pending = deferred();
    draft("failed source");
    submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    input().dispatchEvent(new CompositionEvent("compositionstart"));
    pending.reject(new Error("fixture failure"));
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
    expect(input().value).toBe("");
    expect(submit().disabled).toBe(true);
    expect(entries().some(entry => entry.textContent?.includes("failed source"))).toBe(true);
  });

  it("vetoes busy retry events without replacing a newer draft", async () => {
    const pending = deferred();
    draft("current request");
    submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    draft("current draft");
    const event = new CustomEvent("retry-translation", { detail: { text: "older failed source" }, cancelable: true });
    expect(document.dispatchEvent(event)).toBe(false);
    expect(input().value).toBe("current draft");
    expect(api.translateStream).toHaveBeenCalledOnce();
    pending.resolve("done");
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
  });

  it("keeps an actual failed history row when its retry button is clicked during another request", async () => {
    api.translateStream.mockRejectedValueOnce(new Error("fixture failure"));
    draft("older failed source");
    submit().click();
    await vi.waitFor(() => expect(document.querySelector(".error-retry")).not.toBeNull());
    const retry = document.querySelector<HTMLButtonElement>(".error-retry")!;
    const failed = retry.closest(".entry")!;
    const pending = deferred();
    draft("current request");
    submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledTimes(2));
    draft("newer draft");
    retry.click();
    expect(failed.isConnected).toBe(true);
    expect(failed.textContent).toContain("older failed source");
    expect(input().value).toBe("newer draft");
    expect(api.translateStream).toHaveBeenCalledTimes(2);
    pending.resolve("done");
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
  });

  it("submits an accepted retry directly while preserving an existing draft", async () => {
    draft("keep this draft");
    const event = new CustomEvent("retry-translation", { detail: { text: "retry source" }, cancelable: true });
    expect(document.dispatchEvent(event)).toBe(true);
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    expect(api.translateStream.mock.calls[0][0]).toBe("retry source");
    expect(input().value).toBe("keep this draft");
  });

  it("does not begin native dragging from the settings button or its child", async () => {
    const drag = vi.fn();
    registerInvokeCommand("plugin:window|start_dragging", drag);
    const settings = document.getElementById("btn-settings")!;
    settings.innerHTML = "<span>⚙ 설정</span>";
    settings.firstElementChild!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    await Promise.resolve();
    expect(drag).not.toHaveBeenCalled();
    document.getElementById("titlebar")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, buttons: 1 }));
    expect(drag).toHaveBeenCalledOnce();
  });
});
