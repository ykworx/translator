import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore, setNativeCredential, setTauriStoreValue } from "./helpers/tauriMock";

async function prepareTranslation(showEmptyState: () => Promise<void>): Promise<void> {
  await showEmptyState();
  const button = document.querySelector<HTMLButtonElement>(".translation-setup-btn");
  if (button) {
    button.click();
    await vi.waitFor(() => expect(document.querySelector(".translation-setup-btn")).toBeNull());
  }
}

async function clickDictationSetup(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(".dictation-setup-btn")!;
  await vi.waitFor(() => expect(button.disabled).toBe(false));
  button.click();
}

beforeEach(() => {
  vi.resetModules(); resetInvokeCommands(); resetTauriStore();
  document.body.innerHTML = '<div id="chat"></div>';
});
afterEach(() => { resetInvokeCommands(); vi.restoreAllMocks(); });

describe("provider-aware credential onboarding", () => {
  it("marks an unsupported OS as macOS-only without opening settings or touching voice or cloud state", async () => {
    registerInvokeCommand("supports_global_dictation", () => false);
    const invoke = vi.spyOn(window.__TAURI__.core, "invoke");
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    const button = document.querySelector<HTMLButtonElement>(".dictation-setup-btn")!;
    await vi.waitFor(() => expect(button.textContent).toBe("macOS 전용"));
    expect(button.disabled).toBe(true);
    button.click();
    expect(document.querySelector(".dictation-setup-status")!.textContent).toContain("macOS에서만 지원");
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["supports_global_dictation"]);
  });

  it("does not cache support failures and offers a safe support retry before opening settings", async () => {
    const support = vi.fn().mockRejectedValueOnce(new Error("IPC unavailable")).mockResolvedValue(true);
    const open = vi.fn();
    registerInvokeCommand("supports_global_dictation", support);
    registerInvokeCommand("open_dictation_settings", open);
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    const button = document.querySelector<HTMLButtonElement>(".dictation-setup-btn")!;
    await vi.waitFor(() => expect(button.textContent).toBe("지원 상태 다시 확인"));
    expect(button.disabled).toBe(false);
    expect(document.querySelector(".dictation-setup-status")!.textContent).toContain("확인하지 못했습니다");
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("받아쓰기 준비"));
    expect(support).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
    button.click();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  });

  it("keeps support pending disabled and ignores its detached card after a conversation starts", async () => {
    let finish!: (supported: boolean) => void;
    registerInvokeCommand("supports_global_dictation", () => new Promise(resolve => { finish = resolve; }));
    const open = vi.fn();
    registerInvokeCommand("open_dictation_settings", open);
    const { showEmptyState, addEntry } = await import("../src/ui");
    await showEmptyState();
    const button = document.querySelector<HTMLButtonElement>(".dictation-setup-btn")!;
    expect(button.disabled).toBe(true);
    button.click();
    expect(open).not.toHaveBeenCalled();
    addEntry({ original: "원문", translated: "새 대화" });
    finish(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector(".dictation-onboarding")).toBeNull();
    expect(document.querySelector(".entry")!.textContent).toContain("새 대화");
    expect(button.disabled).toBe(true);
  });

  it.each(["typed", "saving"])("preserves a %s credential form during translation and clearing chat", async state => {
    const ui = await import("../src/ui");
    const { showEmptyState, renderLoading, addEntry, clearChat } = ui;
    await prepareTranslation(showEmptyState);
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    if (state === "typed") input.value = "fake-preserved-draft";
    else input.disabled = true;
    document.getElementById("chat")!.appendChild(renderLoading("새 번역"));
    expect(document.getElementById("inline-api-key")).toBe(input);
    addEntry({ original: "새 번역", translated: "유지할 결과" });
    expect(document.getElementById("inline-api-key")).toBe(input);
    clearChat();
    expect(ui.chatHistory).toHaveLength(0);
    expect(document.getElementById("inline-api-key")).toBe(input);
    expect(input.value).toBe(state === "typed" ? "fake-preserved-draft" : "");
    expect(document.querySelector(".entry")).toBeNull();
  });

  it.each(["success", "failure"])("preserves a conversation when an inline credential save finishes with %s", async result => {
    let finish!: () => void;
    registerInvokeCommand("save_provider_credential", () => new Promise((resolve, reject) => {
      finish = () => {
        if (result === "failure") reject(new Error("Keychain unavailable"));
        else {
          setNativeCredential("gemini-native", "fake-committed-key");
          resolve({ configured: true, revision: "new" });
        }
      };
    }));
    const { showEmptyState, renderLoading, addEntry } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    input.value = "fake-saving-key";
    document.querySelector<HTMLButtonElement>("#inline-api-save")!.click();
    await vi.waitFor(() => expect(input.disabled).toBe(true));
    document.getElementById("chat")!.appendChild(renderLoading("번역 원문"));
    addEntry({ original: "번역 원문", translated: "보존할 대화" });
    expect(document.getElementById("inline-api-key")).toBe(input);
    finish();
    if (result === "success") {
      await vi.waitFor(() => expect(document.getElementById("inline-api-key")).toBeNull());
      expect(input.value).toBe("");
    } else {
      await vi.waitFor(() => expect(document.getElementById("inline-api-status")!.textContent).toContain("입력을 유지"));
      expect(document.getElementById("inline-api-key")).toBe(input);
      expect(input.value).toBe("fake-saving-key");
      expect(input.disabled).toBe(false);
    }
    expect(document.querySelector(".entry")!.textContent).toContain("보존할 대화");
  });

  it("removes only its completed credential form when translation starts during the post-save refresh", async () => {
    let finish!: (value: unknown) => void;
    let reads = 0;
    registerInvokeCommand("get_credential_status", () => ++reads === 1
      ? { configured: false, revision: null } : new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("save_provider_credential", () => ({ configured: true, revision: "saved" }));
    const { showEmptyState, addEntry } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    input.value = "fake-saving-key";
    document.querySelector<HTMLButtonElement>("#inline-api-save")!.click();
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(input.value).toBe("");
    expect(input.disabled).toBe(true);
    addEntry({ original: "새 번역", translated: "새 대화 유지" });
    expect(document.getElementById("inline-api-key")).toBe(input);
    finish({ configured: true, revision: "saved" });
    await vi.waitFor(() => expect(document.getElementById("inline-api-key")).toBeNull());
    expect(document.querySelector(".entry")!.textContent).toContain("새 대화 유지");
  });

  it("offers local dictation before any cloud credential read and opens only dictation settings", async () => {
    const read = vi.fn(() => { throw new Error("Keychain 잠김"); });
    const open = vi.fn();
    registerInvokeCommand("get_credential_status", read);
    registerInvokeCommand("open_dictation_settings", open);
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    expect(read).not.toHaveBeenCalled();
    expect(document.querySelector("#chat")!.textContent).toContain("API 키 없이 Mac에서 받아쓰기");
    expect(document.querySelector("#inline-api-key")).toBeNull();
    await clickDictationSetup();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledWith(undefined);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["missing-key", "locked-key", "translation-ready", "invalid-provider"])("retains dictation setup after explicit translation setup: %s", async state => {
    if (state === "locked-key") registerInvokeCommand("get_credential_status", () => { throw new Error("Keychain 잠김"); });
    if (state === "translation-ready") setNativeCredential("gemini-native", "fake-ready-key");
    if (state === "invalid-provider") setTauriStoreValue("llmBackendId", "unknown-provider");
    const open = vi.fn();
    registerInvokeCommand("open_dictation_settings", open);
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    expect(document.querySelectorAll(".dictation-onboarding")).toHaveLength(1);
    await clickDictationSetup();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  });

  it("keeps local dictation usable while explicit cloud setup waits on Keychain", async () => {
    let finish!: (value: unknown) => void;
    const read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("get_credential_status", read);
    const open = vi.fn();
    registerInvokeCommand("open_dictation_settings", open);
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    document.querySelector<HTMLButtonElement>(".translation-setup-btn")!.click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await clickDictationSetup();
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    finish({ configured: false, revision: null });
    await vi.waitFor(() => expect(document.querySelector("#inline-api-key")).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    input.value = "fake-unsaved-key";
    await clickDictationSetup();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(document.querySelector("#inline-api-key")).toBe(input);
    expect(input.value).toBe("fake-unsaved-key");
  });

  it("finishes an inline save after a connection refresh arrives during the save", async () => {
    let finish!: () => void;
    registerInvokeCommand("save_provider_credential", () => new Promise(resolve => { finish = () => {
      setNativeCredential("gemini-native", "fake-saved-key");
      resolve({ configured: true, revision: "new" });
    }; }));
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    const input = document.getElementById("inline-api-key") as HTMLInputElement;
    input.value = "fake-save-draft";
    document.querySelector<HTMLButtonElement>("#inline-api-save")!.click();
    await vi.waitFor(() => expect(input.disabled).toBe(true));
    await prepareTranslation(showEmptyState);
    expect(document.getElementById("inline-api-key")).toBe(input);
    finish();
    await vi.waitFor(() => expect(document.getElementById("inline-api-key")).toBeNull());
    expect(document.getElementById("chat")!.textContent).toContain("텍스트를 선택");
  });
  it("does not prompt for a Gemini key or read Keychain when Ollama is selected", async () => {
    setTauriStoreValue("llmBackendId", "ollama");
    const status = vi.fn(() => { throw new Error("Keychain 잠김"); });
    registerInvokeCommand("get_credential_status", status);
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    expect(document.querySelector("#inline-api-key")).toBeNull();
    expect(document.querySelector("#chat")!.textContent).toContain("텍스트를 선택");
    expect(status).not.toHaveBeenCalled();
  });

  it("shows the selected OpenAI provider and sends a newly typed key once through its native save command", async () => {
    setTauriStoreValue("llmBackendId", "openai");
    const save = vi.fn(() => { setNativeCredential("openai", "fake-saved-key"); return { configured: true, revision: "new" }; });
    registerInvokeCommand("save_provider_credential", save);
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    expect(document.querySelector("#chat")!.textContent).toContain("OpenAI");
    expect(document.querySelector("#chat")!.textContent).not.toContain("Gemini");
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    input.value = "  fake-new-key  ";
    document.querySelector<HTMLButtonElement>("#inline-api-save")!.click();
    await vi.waitFor(() => expect(document.querySelector("#inline-api-key")).toBeNull());
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ providerId: "openai", apiKey: "fake-new-key", expectedRevision: null });
    expect(input.value).toBe("");
  });

  it("retains a typed key and re-enables the form when native saving fails", async () => {
    const save = vi.fn(() => { throw new Error("Keychain 잠김"); });
    registerInvokeCommand("save_provider_credential", save);
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    const input = document.querySelector<HTMLInputElement>("#inline-api-key")!;
    const button = document.querySelector<HTMLButtonElement>("#inline-api-save")!;
    input.value = "fake-preserved-key"; button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(input.value).toBe("fake-preserved-key");
    expect(document.querySelector("#inline-api-status")!.textContent).toContain("입력을 유지");
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    () => { throw new Error("Keychain 잠김"); },
    () => ({ configured: true, revision: "missing-item", error: "Keychain 항목을 찾을 수 없습니다." }),
  ])("does not present broken or locked credentials as a ready connection", async nativeStatus => {
    registerInvokeCommand("get_credential_status", nativeStatus);
    const { showEmptyState } = await import("../src/ui");
    await prepareTranslation(showEmptyState);
    expect(document.querySelector("#chat")!.textContent).toContain("AI 연결 설정을 확인");
    expect(document.querySelector("#inline-api-key")).toBeNull();
    expect(document.querySelector("#chat")!.textContent).not.toContain("텍스트를 선택");
  });

  it("does not overwrite an incoming chat entry with a late credential status result", async () => {
    let finish: (value: unknown) => void = () => {};
    const readStatus = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("get_credential_status", readStatus);
    const { showEmptyState, addEntry } = await import("../src/ui");
    await showEmptyState();
    document.querySelector<HTMLButtonElement>(".translation-setup-btn")!.click();
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledOnce());
    addEntry({ original: "원문", translated: "번역문" });
    finish({ configured: false, revision: null });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("#chat")!.textContent).toContain("번역문");
    expect(document.querySelector("#inline-api-key")).toBeNull();
  });
});
