import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTauriMock, registerInvokeCommand, resetInvokeCommands, resetTauriStore } from "./helpers/tauriMock";

const api = vi.hoisted(() => ({ suggestReplies: vi.fn(), summarize: vi.fn(), koreanPronunciation: vi.fn() }));
vi.mock("../src/api", () => api);
const html = readFileSync("index.html", "utf8");

describe("context-bound chat actions", () => {
  let ui: typeof import("../src/ui");
  let dispose: () => void;
  let copy: typeof import("../src/copyFeedback");
  let disposeGuards: () => void;
  const button = (kind: "reply" | "summary") => document.getElementById(kind === "reply" ? "btn-suggest" : "btn-summarize") as HTMLButtonElement;
  const status = () => document.getElementById("chat-action-status")!;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const add = (original = "원문") => ui.addEntry({ original, translated: "翻訳" });
  function pending<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  beforeEach(async () => {
    vi.resetModules();
    resetTauriStore(); resetInvokeCommands(); installTauriMock();
    api.suggestReplies.mockReset().mockResolvedValue([{ kr: "좋습니다", jp: "了解です" }]);
    api.summarize.mockReset().mockResolvedValue("요약 결과");
    document.documentElement.innerHTML = html;
    ui = await import("../src/ui");
    copy = await import("../src/copyFeedback");
    disposeGuards = (await import("../src/clipboard")).initClipboardCopyGuards();
    dispose = (await import("../src/chatActions")).initChatActions();
  });
  afterEach(() => { dispose(); disposeGuards(); copy.disposeCopyFeedback(); vi.restoreAllMocks(); });

  it("explains why actions are unavailable before a successful translation", async () => {
    expect(button("reply").disabled).toBe(true);
    expect(button("summary").disabled).toBe(true);
    expect(status().textContent).toContain("번역 결과가 생기면");
    ui.addEntry({ original: "실패", translated: "[오류] fixture failure" });
    await flush();
    expect(button("reply").disabled).toBe(true);
    expect(button("summary").title).toContain("다시 시도");
    expect(api.summarize).not.toHaveBeenCalled();
  });

  it.each(["reply", "summary"] as const)("shows busy state, blocks duplicate %s requests, and preserves a new draft", async kind => {
    add(); await flush();
    const deferred = pending<any>();
    (kind === "reply" ? api.suggestReplies : api.summarize).mockReturnValueOnce(deferred.promise);
    const input = document.getElementById("input-field") as HTMLTextAreaElement;
    input.value = "보존할 초안";
    button(kind).click(); button(kind).click();
    expect(button(kind).getAttribute("aria-busy")).toBe("true");
    expect(button(kind).disabled).toBe(true);
    expect(kind === "reply" ? api.suggestReplies : api.summarize).toHaveBeenCalledOnce();
    deferred.resolve(kind === "reply" ? [{ kr: "답장", jp: "返信" }] : "요약");
    await vi.waitFor(() => expect(document.querySelector(".suggest-section")).not.toBeNull());
    expect(input.value).toBe("보존할 초안");
    expect(button(kind).disabled).toBe(false);
    if (kind === "reply") expect(document.querySelector(".suggest-btn")!.tagName).toBe("BUTTON");
  });

  it.each(["reply", "summary"] as const)("offers an explicit retry of a failed %s without HTML injection", async kind => {
    add(); await flush();
    const fn = kind === "reply" ? api.suggestReplies : api.summarize;
    fn.mockRejectedValueOnce(new Error("fixture <img src=x onerror=alert(1)>"));
    button(kind).click();
    await vi.waitFor(() => expect(status().querySelector("button")).not.toBeNull());
    expect(status().textContent).toContain("생성 실패");
    expect(status().querySelector("img")).toBeNull();
    status().querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(document.querySelector(".suggest-section")).not.toBeNull());
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]).toEqual(["원문", "翻訳"]);
    expect(status().textContent).not.toContain("실패");
  });

  it.each(["reply", "summary"] as const)("treats an empty %s as a visible retryable failure", async kind => {
    add(); await flush();
    (kind === "reply" ? api.suggestReplies : api.summarize).mockResolvedValueOnce(kind === "reply" ? [] : "  \n");
    button(kind).click();
    await vi.waitFor(() => expect(status().textContent).toContain("비어"));
    expect(status().querySelector("button")).not.toBeNull();
  });

  it.each(["resolve", "reject"] as const)("does not restore cleared chat on a late %s", async outcome => {
    add(); await flush();
    const deferred = pending<string>(); api.summarize.mockReturnValueOnce(deferred.promise);
    button("summary").click();
    ui.clearChat(); await flush();
    if (outcome === "resolve") deferred.resolve("버릴 이전 요약"); else deferred.reject(new Error("버릴 이전 오류"));
    await flush();
    expect(document.querySelector(".suggest-section")).toBeNull();
    expect(status().textContent).not.toContain("버릴 이전");
    expect(button("summary").disabled).toBe(true);
  });

  it("does not let an old completion reset the busy state of a newer context", async () => {
    add(); await flush();
    const old = pending<string>(); const fresh = pending<string>();
    api.summarize.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    button("summary").click();
    ui.clearChat(); add("새 원문"); await flush();
    button("summary").click();
    old.resolve("이전 요약"); await flush();
    expect(button("summary").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector(".summary-content")).toBeNull();
    fresh.resolve("새 요약");
    await vi.waitFor(() => expect(document.querySelector(".summary-content")!.textContent).toBe("새 요약"));
  });

  it.each(["manual", "clipboard"] as const)("invalidates actions as soon as a %s translation starts", async mode => {
    add(); await flush();
    const deferred = pending<string>(); api.summarize.mockReturnValueOnce(deferred.promise);
    button("summary").click();
    if (mode === "clipboard") ui.chat.appendChild(ui.renderLoading("새 원문"));
    else { const row = document.createElement("div"); row.id = "streaming-entry"; ui.chat.appendChild(row); ui.notifyChatChanged(); }
    await flush();
    expect(status().textContent).toContain("번역이 끝나면");
    expect(button("reply").disabled).toBe(true);
    deferred.resolve("버릴 요약"); await flush();
    expect(document.querySelector(".summary-content")).toBeNull();
  });

  it("keeps successful reply and summary requests independent", async () => {
    add(); await flush();
    button("reply").click(); button("summary").click();
    await vi.waitFor(() => expect(document.querySelectorAll(".suggest-section")).toHaveLength(2));
    expect(button("reply").disabled).toBe(false);
    expect(button("summary").disabled).toBe(false);
  });

  it("keeps focus on an existing retry while the other action completes", async () => {
    add(); await flush();
    const replies = pending<any>(); api.suggestReplies.mockReturnValueOnce(replies.promise);
    api.summarize.mockRejectedValueOnce(new Error("summary fixture failure"));
    button("reply").click(); button("summary").click();
    await vi.waitFor(() => expect(status().querySelector("button")).not.toBeNull());
    const retry = status().querySelector<HTMLButtonElement>("button")!;
    retry.focus();
    replies.resolve([{ kr: "답장", jp: "返信" }]);
    await vi.waitFor(() => expect(document.querySelector(".suggest-section")).not.toBeNull());
    expect(document.activeElement).toBe(retry);
  });

  it.each(["resolve", "reject"] as const)("only marks a reply copied after acknowledgement (%s)", async outcome => {
    add(); await flush(); button("reply").click();
    await vi.waitFor(() => expect(document.querySelector(".suggest-btn")).not.toBeNull());
    const target = document.querySelector<HTMLButtonElement>(".suggest-btn")!;
    const operation = pending<void>();
    registerInvokeCommand("plugin:clipboard-manager|write_text", () => operation.promise);
    target.click();
    expect(target.textContent).not.toMatch(/^✓/);
    if (outcome === "resolve") operation.resolve(); else operation.reject(new Error("fixture copy failure"));
    await vi.waitFor(() => expect(target.disabled).toBe(false));
    if (outcome === "resolve") expect(target.textContent).toMatch(/^✓ KR:/);
    else {
      expect(target.textContent).not.toMatch(/^✓/);
      expect(target.textContent).toContain("실패");
      registerInvokeCommand("plugin:clipboard-manager|write_text", () => undefined);
      target.click();
      await vi.waitFor(() => expect(target.textContent).toMatch(/^✓ KR:/));
    }
  });

  it("initializes without Array.prototype.at on older WebViews", async () => {
    const { initChatActions } = await import("../src/chatActions");
    dispose();
    const original = Array.prototype.at;
    let failure: unknown;
    try {
      Object.defineProperty(Array.prototype, "at", { configurable: true, writable: true, value: undefined });
      dispose = initChatActions();
    } catch (error) { failure = error; }
    finally { Object.defineProperty(Array.prototype, "at", { configurable: true, writable: true, value: original }); }
    expect(failure).toBeUndefined();
    expect(button("reply").disabled).toBe(true);
  });
});
