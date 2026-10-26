import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMock, registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

const api = vi.hoisted(() => ({ translateStream: vi.fn(), suggestReplies: vi.fn(), summarize: vi.fn(), koreanPronunciation: vi.fn() }));
vi.mock("../src/api", () => api);
vi.mock("../src/speechInput", () => ({ initSpeechInput: vi.fn(), isSpeechInputActive: vi.fn(() => false) }));
vi.mock("../src/appCaptions", () => ({ initAppCaptions: vi.fn(), forceStopCaptions: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/clipboardTranslate", () => ({ initClipboardListeners: vi.fn(), retryClipboardTranslation: vi.fn(() => false) }));
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

  it.each(["resolve", "reject"] as const)("waits for shortcut clipboard acknowledgement (%s)", async outcome => {
    const ui = await import("../src/ui");
    ui.addEntry({ original: "원문", translated: "복사할 번역" });
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => { finish = yes; fail = no; });
    const write = vi.fn(() => pending);
    registerInvokeCommand("plugin:clipboard-manager|write_text", write);
    document.dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, code: "KeyC", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(document.getElementById("copy-toast")).toBeNull();
    if (outcome === "resolve") finish(); else fail(new Error("fixture clipboard failure"));
    await vi.waitFor(() => expect(document.getElementById("copy-toast")).not.toBeNull());
    const toast = document.getElementById("copy-toast")!;
    expect(toast.dataset.kind).toBe(outcome === "resolve" ? "success" : "error");
    if (outcome === "reject") expect(toast.textContent).not.toContain("복사됨");
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
  it.each(["resolve", "reject"] as const)("ignores an old translation after clearing and does not unlock a new request (%s)", async outcome => {
    const old = deferred();
    draft("old source"); submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    document.getElementById("btn-clear")!.click();
    const newer = deferred();
    draft("new source"); submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledTimes(2));
    if (outcome === "resolve") old.resolve("obsolete result"); else old.reject(new Error("obsolete error"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(submit().getAttribute("aria-busy")).toBe("true");
    expect(document.getElementById("chat")!.textContent).not.toContain("obsolete");
    expect(input().value).toBe("");
    newer.resolve("new result");
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
    expect(entries()).toHaveLength(1);
    expect(entries()[0].textContent).toContain("new result");
  });

  it("keeps the reader's scroll position through streaming and final replacement", async () => {
    let chunk!: (text: string) => void;
    let finish!: (text: string) => void;
    api.translateStream.mockImplementationOnce((_text, _lang, onChunk) => {
      chunk = onChunk;
      return new Promise<string>(resolve => { finish = resolve; });
    });
    draft("long source"); submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    const chat = document.getElementById("chat")!;
    Object.defineProperties(chat, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 300 } });
    chat.scrollTop = 250;
    chunk("partial result");
    expect(chat.scrollTop).toBe(250);
    finish("final result");
    await vi.waitFor(() => expect(submit().getAttribute("aria-busy")).toBe("false"));
    expect(chat.scrollTop).toBe(250);
  });

  it("continues following a stream while the reader stays at the bottom", async () => {
    let chunk!: (text: string) => void;
    api.translateStream.mockImplementationOnce((_text, _lang, onChunk) => { chunk = onChunk; return new Promise(() => {}); });
    draft("source"); submit().click();
    await vi.waitFor(() => expect(api.translateStream).toHaveBeenCalledOnce());
    const chat = document.getElementById("chat")!;
    Object.defineProperties(chat, { scrollHeight: { configurable: true, value: 1500 }, clientHeight: { configurable: true, value: 300 } });
    chat.scrollTop = 1200;
    chunk("partial");
    expect(chat.scrollTop).toBe(1500);
  });

  it("blocks translation and retry while app voice input is active", async () => {
    const speech = await import("../src/speechInput");
    vi.mocked(speech.isSpeechInputActive).mockReturnValue(true);
    draft("preserved voice draft");
    expect(submit().disabled).toBe(true);
    enter();
    const event = new CustomEvent("retry-translation", { detail: { text: "retry" }, cancelable: true });
    expect(document.dispatchEvent(event)).toBe(false);
    expect(api.translateStream).not.toHaveBeenCalled();
    expect(input().value).toBe("preserved voice draft");
    vi.mocked(speech.isSpeechInputActive).mockReturnValue(false);
  });

  it("routes an image retry with its original image and keeps the newer draft", async () => {
    const { addEntry } = await import("../src/ui");
    const { retryClipboardTranslation } = await import("../src/clipboardTranslate");
    vi.mocked(retryClipboardTranslation).mockReturnValueOnce(true);
    addEntry({ original: "(이미지)", translated: "[오류] failed", isImage: true, imageBase64: "fixture-image" });
    draft("newer draft");
    document.querySelector<HTMLButtonElement>(".error-retry")!.click();
    expect(retryClipboardTranslation).toHaveBeenCalledWith({ kind: "image", text: "(이미지)", imageBase64: "fixture-image" });
    expect(api.translateStream).not.toHaveBeenCalled();
    expect(input().value).toBe("newer draft");
  });

});
