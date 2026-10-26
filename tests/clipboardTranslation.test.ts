import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore } from "./helpers/tauriMock";

const api = vi.hoisted(() => ({ translate: vi.fn(), translateTable: vi.fn(), translateImage: vi.fn(), koreanPronunciation: vi.fn() }));
const clipboard = vi.hoisted(() => ({ readText: vi.fn(), writeTextToClipboard: vi.fn(), writeHtmlToClipboard: vi.fn(), writeWithTextFallback: vi.fn() }));
vi.mock("../src/api", () => api);
vi.mock("../src/clipboard", () => clipboard);

describe("clipboard translation context", () => {
  let events: Map<string, () => void>;
  let ui: typeof import("../src/ui");
  let translations: typeof import("../src/clipboardTranslate");
  let lang: ReturnType<typeof vi.fn>;
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  beforeEach(async () => {
    vi.resetModules(); vi.clearAllMocks(); resetInvokeCommands(); resetTauriStore();
    document.body.innerHTML = '<div id="chat"></div><textarea id="draft"></textarea>';
    events = new Map();
    vi.spyOn(window.__TAURI__.event, "listen").mockImplementation(async (event: string, handler: () => void) => { events.set(event, handler); return () => {}; });
    registerInvokeCommand("read_clipboard_html", () => null);
    registerInvokeCommand("read_clipboard_image", () => "fixture-image");
    clipboard.readText.mockResolvedValue("fixture text");
    clipboard.writeTextToClipboard.mockResolvedValue(undefined);
    clipboard.writeHtmlToClipboard.mockResolvedValue(undefined);
    api.translate.mockResolvedValue("text result");
    api.translateTable.mockResolvedValue("<table><tr><td>result</td></tr></table>");
    api.translateImage.mockResolvedValue({ translatedText: "image result", extractedText: "ocr", rawText: "raw" });
    ui = await import("../src/ui");
    translations = await import("../src/clipboardTranslate");
    lang = vi.fn(async () => ({ targetLang: "English" }));
    translations.initClipboardListeners(lang);
  });
  afterEach(() => { vi.restoreAllMocks(); resetInvokeCommands(); });

  it("preserves original image bytes and repeats the image operation after failure", async () => {
    api.translateImage.mockRejectedValueOnce(new Error("fixture failure"));
    events.get("global-translate-image")!(); await flush();
    expect(ui.chatHistory[0]).toMatchObject({ isImage: true, imageBase64: "fixture-image", retrySource: { kind: "image", imageBase64: "fixture-image" } });
    const source = ui.chatHistory[0].retrySource!;
    expect(translations.retryClipboardTranslation(source)).toBe(true); await flush();
    expect(api.translateImage).toHaveBeenCalledTimes(2);
    expect(api.translateImage.mock.calls[1][0]).toBe("fixture-image");
    expect(api.translate).not.toHaveBeenCalled();
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();
  });

  it("preserves HTML structure for a table retry and shows the error as text", async () => {
    const html = '<table><tr><td>元</td></tr></table>';
    registerInvokeCommand("read_clipboard_html", () => html);
    api.translateTable.mockRejectedValueOnce(new Error("fixture table failure"));
    events.get("global-translate")!(); await flush();
    expect(ui.chatHistory[0]).toMatchObject({ isTable: true, originalHtml: html, retrySource: { kind: "table", html } });
    expect(document.querySelector(".card.error")!.textContent).toContain("fixture table failure");
    expect(translations.retryClipboardTranslation(ui.chatHistory[0].retrySource)).toBe(true); await flush();
    expect(api.translateTable.mock.calls[1][0]).toBe(html);
    expect(api.translate).not.toHaveBeenCalled();
    expect(clipboard.writeHtmlToClipboard).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("ignores a cleared clipboard request and keeps the newer loading row (%s)", async outcome => {
    const old = deferred<string>();
    api.translate.mockReturnValueOnce(old.promise);
    events.get("global-translate")!(); await flush();
    ui.clearChat();
    const newer = deferred<string>();
    api.translate.mockReturnValueOnce(newer.promise);
    events.get("global-translate")!(); await flush();
    expect(api.translate).toHaveBeenCalledTimes(2);
    const loading = document.getElementById("loading-entry");
    if (outcome === "resolve") old.resolve("obsolete"); else old.reject(new Error("obsolete"));
    await flush();
    expect(document.getElementById("loading-entry")).toBe(loading);
    expect(ui.chatHistory).toHaveLength(0);
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();
    // An obsolete finally must not unlock the newer operation.
    events.get("global-translate")!(); await flush();
    expect(api.translate).toHaveBeenCalledTimes(2);
    newer.resolve("current result"); await flush();
    expect(ui.chatHistory).toHaveLength(1);
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledOnce();
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledWith("current result");
  });

  it("stops after an asynchronous clipboard read if the conversation was cleared", async () => {
    const read = deferred<string | null>();
    registerInvokeCommand("read_clipboard_html", () => read.promise);
    events.get("global-translate")!();
    ui.clearChat(); read.resolve("<table></table>"); await flush();
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(api.translateTable).not.toHaveBeenCalled();
    expect(ui.chatHistory).toHaveLength(0);
  });

  it("does not invoke a provider after clearing during language resolution", async () => {
    const pending = deferred<{ targetLang: string }>();
    lang.mockReturnValueOnce(pending.promise);
    events.get("global-translate")!(); await flush();
    ui.clearChat(); pending.resolve({ targetLang: "English" }); await flush();
    expect(api.translate).not.toHaveBeenCalled();
    expect(ui.chatHistory).toHaveLength(0);
  });

  it("declines busy and malformed retries without starting another operation", async () => {
    api.translateImage.mockReturnValueOnce(new Promise(() => {}));
    expect(translations.retryClipboardTranslation({ kind: "image", text: "image", imageBase64: "bytes" })).toBe(true);
    await flush();
    expect(translations.retryClipboardTranslation({ kind: "table", text: "table", html: "<table/>" })).toBe(false);
    expect(translations.retryClipboardTranslation({ kind: "image", text: "image" })).toBe(false);
    expect(translations.retryClipboardTranslation({ kind: "unknown", text: "x" })).toBe(false);
    expect(api.translateImage).toHaveBeenCalledOnce();
    expect(api.translateTable).not.toHaveBeenCalled();
  });
});
