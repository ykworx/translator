import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore, setNativeCredential, setTauriStoreValue } from "./helpers/tauriMock";

beforeEach(() => {
  vi.resetModules(); resetInvokeCommands(); resetTauriStore();
  document.body.innerHTML = '<div id="chat"></div>';
});
afterEach(() => { resetInvokeCommands(); });

describe("provider-aware credential onboarding", () => {
  it("finishes an inline save after a connection refresh arrives during the save", async () => {
    let finish!: () => void;
    registerInvokeCommand("save_provider_credential", () => new Promise(resolve => { finish = () => {
      setNativeCredential("gemini-native", "fake-saved-key");
      resolve({ configured: true, revision: "new" });
    }; }));
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
    const input = document.getElementById("inline-api-key") as HTMLInputElement;
    input.value = "fake-save-draft";
    document.querySelector<HTMLButtonElement>("#inline-api-save")!.click();
    await vi.waitFor(() => expect(input.disabled).toBe(true));
    await showEmptyState();
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
    await showEmptyState();
    expect(document.querySelector("#inline-api-key")).toBeNull();
    expect(document.querySelector("#chat")!.textContent).toContain("텍스트를 선택");
    expect(status).not.toHaveBeenCalled();
  });

  it("shows the selected OpenAI provider and sends a newly typed key once through its native save command", async () => {
    setTauriStoreValue("llmBackendId", "openai");
    const save = vi.fn(() => { setNativeCredential("openai", "fake-saved-key"); return { configured: true, revision: "new" }; });
    registerInvokeCommand("save_provider_credential", save);
    const { showEmptyState } = await import("../src/ui");
    await showEmptyState();
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
    await showEmptyState();
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
    await showEmptyState();
    expect(document.querySelector("#chat")!.textContent).toContain("AI 연결 설정을 확인");
    expect(document.querySelector("#inline-api-key")).toBeNull();
    expect(document.querySelector("#chat")!.textContent).not.toContain("텍스트를 선택");
  });

  it("does not overwrite an incoming chat entry with a late credential status result", async () => {
    let finish: (value: unknown) => void = () => {};
    const readStatus = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    registerInvokeCommand("get_credential_status", readStatus);
    const { showEmptyState, addEntry } = await import("../src/ui");
    const pending = showEmptyState();
    await vi.waitFor(() => expect(readStatus).toHaveBeenCalledOnce());
    addEntry({ original: "원문", translated: "번역문" });
    finish({ configured: false, revision: null });
    await pending;
    expect(document.querySelector("#chat")!.textContent).toContain("번역문");
    expect(document.querySelector("#inline-api-key")).toBeNull();
  });
});
