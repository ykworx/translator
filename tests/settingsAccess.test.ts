import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore } from "./helpers/tauriMock";

beforeEach(() => {
  vi.resetModules(); resetInvokeCommands(); resetTauriStore();
  document.body.innerHTML = '<div id="chat"></div><button id="btn-settings">설정</button><span id="settings-access-status"></span>';
});
afterEach(() => { window.dispatchEvent(new Event("beforeunload")); vi.restoreAllMocks(); resetInvokeCommands(); });

describe("settings entry and recovery", () => {
  it.each(["typed", "saving"])("preserves an inline credential form that is %s during settings refresh", async state => {
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    const input = document.getElementById("inline-api-key") as HTMLInputElement;
    if (state === "typed") input.value = "fake-unsaved-draft";
    else input.disabled = true;
    const read = vi.fn(() => ({ configured: true, revision: "new" }));
    registerInvokeCommand("get_credential_status", read);
    await showEmptyState();
    expect(document.getElementById("inline-api-key")).toBe(input);
    expect(read).not.toHaveBeenCalled();
    expect(input.value).toBe(state === "typed" ? "fake-unsaved-draft" : "");
  });

  it("preserves a credential draft entered during a pending settings refresh", async () => {
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    const input = document.getElementById("inline-api-key") as HTMLInputElement;
    let finish!: (value: unknown) => void;
    const read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("get_credential_status", read);
    const refresh = showEmptyState();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    input.value = "fake-newly-typed-draft";
    finish({ configured: true, revision: "changed" });
    await refresh;
    expect(document.getElementById("inline-api-key")).toBe(input);
    expect(input.value).toBe("fake-newly-typed-draft");
  });
  it("coalesces repeated opening and restores the button after completion", async () => {
    let finish!: () => void;
    const invoke = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    registerInvokeCommand("open_settings", invoke);
    const { initSettingsAccess } = await import("../src/settingsAccess");
    initSettingsAccess();
    const button = document.querySelector<HTMLButtonElement>("#btn-settings")!;
    button.click(); button.click();
    expect(invoke).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    finish();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });

  it("provides a working API-error settings button and visible retryable failure", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
    registerInvokeCommand("open_settings", invoke);
    const { addEntry } = await import("../src/ui");
    addEntry({ original: "예제", translated: "[오류] API 키를 확인해주세요" });
    const button = document.querySelector<HTMLButtonElement>(".error-settings")!;
    button.click();
    await vi.waitFor(() => expect(document.querySelector(".error-actions")!.textContent).toContain("설정 창을 열지 못했습니다"));
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".error-actions [role=status]")!.textContent).toBe("");
  });

  it("refreshes onboarding after a connection change and detaches on unload", async () => {
    let handler!: () => void;
    const stop = vi.fn();
    vi.spyOn(window.__TAURI__.event, "listen").mockImplementation(async (_event, callback) => { handler = callback as () => void; return stop; });
    const refresh = vi.fn();
    const { initSettingsAccess } = await import("../src/settingsAccess");
    initSettingsAccess(refresh);
    await Promise.resolve();
    handler(); expect(refresh).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event("beforeunload"));
    expect(stop).toHaveBeenCalledOnce();
    handler(); expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight translation visible when an earlier onboarding read completes", async () => {
    let finish!: (value: unknown) => void;
    const read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("get_credential_status", read);
    const { showEmptyState, renderLoading } = await import("../src/ui");
    const pending = showEmptyState();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    document.getElementById("chat")!.appendChild(renderLoading("작성 중인 번역"));
    finish({ configured: false, revision: null });
    await pending;
    expect(document.getElementById("loading-entry")).not.toBeNull();
    expect(document.getElementById("inline-api-key")).toBeNull();
  });

  it("retains the original error when a busy submission declines a retry", async () => {
    const { addEntry, chatHistory } = await import("../src/ui");
    addEntry({ original: "실패 원문", translated: "[오류] 네트워크 오류" });
    document.addEventListener("retry-translation", event => event.preventDefault(), { once: true });
    document.querySelector<HTMLButtonElement>(".error-retry")!.click();
    expect(document.querySelector(".entry")).not.toBeNull();
    expect(chatHistory).toHaveLength(1);
  });
});
