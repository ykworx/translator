import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMock, registerInvokeCommand, resetInvokeCommands, resetTauriStore } from "./helpers/tauriMock";

describe("acknowledged clipboard feedback", () => {
  let feedback: typeof import("../src/copyFeedback");
  let clipboard: typeof import("../src/clipboard");
  let disposeGuards: () => void;
  beforeEach(async () => {
    vi.resetModules(); resetTauriStore(); resetInvokeCommands(); installTauriMock();
    document.body.innerHTML = '<div id="chat"></div><textarea id="draft">keep my draft</textarea>';
    feedback = await import("../src/copyFeedback");
    clipboard = await import("../src/clipboard");
    disposeGuards = clipboard.initClipboardCopyGuards();
  });
  afterEach(() => { disposeGuards(); feedback.disposeCopyFeedback(); vi.restoreAllMocks(); });
  function button(label = "⧉ 복사") {
    const element = document.createElement("button"); element.textContent = label; document.body.appendChild(element); return element;
  }
  function deferred() {
    let resolve!: () => void; let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  it("does not acknowledge a pending write and blocks double clicking the same button", async () => {
    const pending = deferred(); const write = vi.fn(() => pending.promise); const target = button();
    const first = feedback.copyWithFeedback(write, target);
    expect(target.disabled).toBe(true);
    expect(target.textContent).not.toContain("복사됨");
    expect(await feedback.copyWithFeedback(write, target)).toBe(false);
    await Promise.resolve(); expect(write).toHaveBeenCalledOnce();
    expect(document.getElementById("copy-toast")).toBeNull();
    pending.resolve(); expect(await first).toBe(true);
    expect(target.textContent).toBe("✓ 복사됨");
    expect(target.disabled).toBe(false);
    expect(document.getElementById("copy-toast")!.dataset.kind).toBe("success");
  });

  it("reports a rejected write as failure and allows a successful retry", async () => {
    const target = button();
    const write = vi.fn().mockRejectedValueOnce(new Error("fixture error")).mockResolvedValue(undefined);
    expect(await feedback.copyWithFeedback(write, target)).toBe(false);
    expect(target.textContent).toContain("실패");
    expect(target.classList.contains("active")).toBe(false);
    expect(document.getElementById("copy-toast")!.textContent).not.toContain("복사됨");
    expect(await feedback.copyWithFeedback(write, target)).toBe(true);
    expect(target.textContent).toBe("✓ 복사됨");
  });

  it("serializes writes in click order and suppresses earlier toast acknowledgements", async () => {
    const pending = deferred(); const order: string[] = [];
    const first = feedback.copyWithFeedback(async () => { order.push("first"); await pending.promise; }, button());
    const second = feedback.copyWithFeedback(async () => { order.push("second"); }, button());
    await Promise.resolve(); expect(order).toEqual(["first"]);
    pending.resolve(); await first;
    expect(document.getElementById("copy-toast")).toBeNull();
    await second; expect(order).toEqual(["first", "second"]);
    expect(document.getElementById("copy-toast")!.dataset.kind).toBe("success");
  });

  it("does not start queued writes or display stale feedback after disposal", async () => {
    const pending = deferred(); const later = vi.fn().mockResolvedValue(undefined);
    const first = feedback.copyWithFeedback(() => pending.promise, button());
    await Promise.resolve();
    const second = feedback.copyWithFeedback(later, button());
    feedback.disposeCopyFeedback(); pending.resolve();
    await first; await second;
    expect(later).not.toHaveBeenCalled();
    expect(document.getElementById("copy-toast")).toBeNull();
  });

  it.each([false, true])("requires the text fallback to return true (%s) and restores draft selection", async succeeds => {
    const draft = document.getElementById("draft") as HTMLTextAreaElement;
    draft.focus(); draft.setSelectionRange(2, 6, "backward");
    const original = document.execCommand;
    document.execCommand = vi.fn(() => succeeds);
    try {
      const operation = clipboard.writeWithTextFallback(async () => { throw new Error("native failure"); }, "copied text");
      if (succeeds) await expect(operation).resolves.toBeUndefined(); else await expect(operation).rejects.toThrow("native failure");
      expect(document.activeElement).toBe(draft);
      expect(draft.value).toBe("keep my draft");
      expect([draft.selectionStart, draft.selectionEnd, draft.selectionDirection]).toEqual([2, 6, "backward"]);
      expect(document.querySelectorAll("textarea")).toHaveLength(1);
    } finally { document.execCommand = original; }
  });

  it.each(["original", "translated", "ocr", "table"] as const)("connects %s card feedback to actual native/fallback failure", async kind => {
    registerInvokeCommand("plugin:clipboard-manager|write_text", () => Promise.reject(new Error("fixture native failure")));
    registerInvokeCommand("write_clipboard_html", () => Promise.reject(new Error("fixture native failure")));
    const { addEntry } = await import("../src/ui");
    addEntry({ original: "원문", translated: kind === "table" ? "<table><tr><td>表</td></tr></table>" : "翻訳", isTable: kind === "table", isImage: kind === "ocr", imageBase64: kind === "ocr" ? "fixture" : undefined, imageExtractedText: kind === "ocr" ? "OCR text" : undefined });
    const selector = kind === "original" ? ".copy-orig" : kind === "ocr" ? ".copy-extracted" : ".copy-trans";
    const target = document.querySelector<HTMLButtonElement>(selector)!;
    target.click();
    await vi.waitFor(() => expect(target.textContent).toContain("실패"));
    expect(target.textContent).not.toContain("복사됨");
    expect(target.disabled).toBe(false);
  });

  it.each(["composition", "disposed"] as const)("does not invoke a late browser fallback while %s", async state => {
    const pending = deferred();
    const original = document.execCommand;
    document.execCommand = vi.fn(() => true);
    const draft = document.getElementById("draft") as HTMLTextAreaElement;
    try {
      const operation = clipboard.writeWithTextFallback(() => pending.promise, "copy text");
      draft.focus();
      const blur = vi.fn(); draft.addEventListener("blur", blur);
      if (state === "composition") draft.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      else disposeGuards();
      pending.reject(new Error("late native failure"));
      await expect(operation).rejects.toThrow("late native failure");
      expect(document.execCommand).not.toHaveBeenCalled();
      expect(blur).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(draft);
      if (state === "composition") {
        draft.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        await expect(clipboard.writeWithTextFallback(async () => { throw new Error("retry"); }, "copy text")).resolves.toBeUndefined();
        expect(document.execCommand).toHaveBeenCalledOnce();
      }
    } finally { document.execCommand = original; }
  });
});
