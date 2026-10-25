import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve("settings.html"), "utf8");
const installedModel = { downloaded: true, ggmlDownloaded: true, coremlDownloaded: true, sizeBytes: 1_624_555_275, path: "/models/test.bin" };

describe("dictation settings", () => {
  let store: Map<string, unknown>;
  let credentials: Map<string, { configured: boolean; revision: string | null; error?: string }>;
  let invoke: ReturnType<typeof vi.fn>;
  let close: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let microphoneList: Array<{ id: string; name: string; isDefault: boolean }>;
  let listeners: Array<[Document | Window, string, EventListenerOrEventListenerObject]>;
  let closeRequested: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;

  const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const status = () => document.getElementById("settings-status")!.textContent;

  beforeEach(() => {
    vi.resetModules();
    document.documentElement.innerHTML = html;
    store = new Map();
    credentials = new Map();
    let credentialSequence = 0;
    close = vi.fn().mockResolvedValue(undefined);
    emit = vi.fn().mockResolvedValue(undefined);
    microphoneList = [{ id: "built-in", name: "MacBook Pro 마이크", isDefault: true }, { id: "usb-mic", name: "USB 마이크", isDefault: false }];
    listeners = [];
    for (const target of [document, window]) {
      const original = target.addEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (listener) listeners.push([target, type, listener]);
        original(type, listener, options);
      });
    }
    invoke = vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
      if (["settings_get", "settings_set", "settings_delete"].includes(command) && ["apiKey", "openaiApiKey"].includes(args.key as string)) throw new Error("Secret settings access is forbidden");
      switch (command) {
        case "get_credential_status": return credentials.get(args.providerId as string) ?? { configured: false, revision: null };
        case "save_provider_credential": case "delete_provider_credential": {
          const previous = credentials.get(args.providerId as string) ?? { configured: false, revision: null };
          if (previous.revision !== args.expectedRevision) throw new Error("다른 창에서 키가 변경되었습니다.");
          const status = { configured: command === "save_provider_credential", revision: command === "save_provider_credential" ? `new-${++credentialSequence}` : null };
          credentials.set(args.providerId as string, status);
          return status;
        }
        case "settings_load": return 1;
        case "settings_get": return [store.get(args.key as string), store.has(args.key as string)];
        case "settings_set": store.set(args.key as string, args.value); return;
        case "settings_delete": store.delete(args.key as string); return;
        case "settings_save": return;
        case "list_caption_capture_windows": return [];
        case "list_dictation_microphones": return microphoneList;
        case "check_whisper_model": return installedModel;
        case "get_shortcut_status": return { selectRegistered: true, clipboardRegistered: true, dictationRegistered: true, suspended: false, error: null };
        case "get_dictation_permissions": case "request_dictation_permissions": return { microphone: true, microphoneStatus: "authorized", accessibility: true, modelLoaded: false };
        case "preview_dictation_panel": return true;
        case "update_shortcuts": case "suspend_shortcuts": case "resume_shortcuts": return;
        default: throw new Error(`Unexpected command: ${command}`);
      }
    });
    window.__TAURI__ = {
      core: { invoke, Channel: class { onmessage = null; id = 1; } },
      event: { emit, listen: vi.fn().mockResolvedValue(() => {}) },
      window: { getCurrentWindow: () => ({ close, onCloseRequested: async handler => { closeRequested = handler; return () => {}; } }) },
    } as unknown as Window["__TAURI__"];
  });

  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["removed-provider", 42])("allows explicit repair of an invalid saved provider (%s)", async invalid => {
    store.set("llmBackendId", invalid);
    store.set("dictationLocale", "en-US");
    await import("../src/settings");
    const ollama = document.querySelector<HTMLInputElement>('input[name="llm-backend"][value="ollama"]')!;
    await vi.waitFor(() => expect(ollama.disabled).toBe(false));
    expect(status()).toContain("공급자를 직접 선택");
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="llm-backend"]')].some(radio => radio.checked)).toBe(false);
    expect(button("btn-save").disabled).toBe(true);
    expect(invoke.mock.calls.some(([command]) => command === "get_credential_status")).toBe(false);
    ollama.click();
    expect(button("btn-save").disabled).toBe(false);
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("llmBackendId")).toBe("ollama");
    expect(store.get("dictationLocale")).toBe("en-US");
  });

  it("does not enable settings writes after a provider read transport failure", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "settings_get" && args.key === "llmBackendId") throw new Error("IPC unavailable");
      return original(command, args);
    });
    await import("../src/settings");
    await vi.waitFor(() => expect(status()).toContain("설정을 불러오지 못했습니다"));
    expect(button("btn-save").disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLInputElement>('input[name="llm-backend"]')].every(radio => radio.disabled)).toBe(true);
    expect(invoke.mock.calls.some(([command]) => command === "settings_set")).toBe(false);
  });

  it("preserves saved custom cloud models when saving Ollama or voice preferences", async () => {
    store.set("llmBackendId", "ollama");
    store.set("model", "gemini-custom-saved");
    store.set("openaiModel", "gpt-custom-saved");
    store.set("ollamaModel", "custom-local:latest");
    await boot();
    expect(select("model").value).toBe("gemini-custom-saved");
    expect(select("openai-model").value).toBe("gpt-custom-saved");
    expect(select("openai-model").selectedOptions[0].textContent).toContain("gpt-custom-saved");
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("model")).toBe("gemini-custom-saved");
    expect(store.get("openaiModel")).toBe("gpt-custom-saved");
    expect(store.get("ollamaModel")).toBe("custom-local:latest");
  });

  it("uses a current shared Gemini default for a new installation", async () => {
    await boot();
    expect(select("model").value).toBe("gemini-3.8-flash");
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("model")).toBe("gemini-3.8-flash");
  });

  it.each(["gemini-2.0-flash", "models/gemini-2.0-flash-001", "gemini-2.5-pro"])("preserves and explains an existing limited Gemini selection (%s)", async model => {
    store.set("model", model);
    await boot();
    expect(select("model").value).toBe(model);
    expect(select("model").selectedOptions[0].textContent).toContain(model);
    expect(document.getElementById("gemini-model-status")!.textContent).toContain(model.includes("2.0") ? "지원이 종료" : "접근이 제한");
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("model")).toBe(model);
  });

  it("clears the lifecycle notice only after the user explicitly chooses a current model", async () => {
    store.set("model", "gemini-2.0-flash");
    await boot();
    select("model").value = "gemini-3.8-flash";
    select("model").dispatchEvent(new Event("change", { bubbles: true }));
    expect(document.getElementById("gemini-model-status")!.textContent).toBe("");
    expect(store.get("model")).toBe("gemini-2.0-flash");
  });

  async function boot() {
    await import("../src/settings");
    await vi.waitFor(() => expect(button("btn-save").disabled).toBe(false));
  }

  it("presents dictation in a dedicated tab with the saved language, microphone and shortcut", async () => {
    store.set("dictationLocale", "ja-JP");
    store.set("dictationMicrophone", "usb-mic");
    store.set("dictationShortcut", "Super+Ctrl+KeyR");
    await boot();
    document.querySelector<HTMLButtonElement>('[data-tab="dictation"]')!.click();
    expect(document.getElementById("pane-dictation")!.classList.contains("active")).toBe(true);
    expect(select("dictation-locale").value).toBe("ja-JP");
    expect(select("dictation-microphone").value).toBe("usb-mic");
    expect(document.getElementById("dictation-shortcut-summary")!.textContent).toBe("⌘⌃R");
    expect(select("dictation-microphone").options[0].textContent).toContain("MacBook Pro 마이크");
  });

  it("preserves a disconnected microphone instead of silently switching the saved choice", async () => {
    store.set("dictationMicrophone", "missing-device");
    await boot();
    expect(select("dictation-microphone").value).toBe("missing-device");
    expect(select("dictation-microphone").selectedOptions[0].textContent).toContain("연결 안 됨");
    expect(document.getElementById("dictation-microphone-status")!.textContent).toContain("연결하거나");
  });

  it("keeps a custom existing speech hint when saving dictation preferences", async () => {
    store.set("domainHint", "프로젝트 전용 사용자 힌트");
    await boot();
    select("dictation-locale").value = "en-US";
    select("dictation-microphone").value = "usb-mic";
    (document.getElementById("dictation-hint") as HTMLInputElement).value = "  Transrator, Osolar  ";
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("domainHint")).toBe("프로젝트 전용 사용자 힌트");
    expect(store.get("dictationLocale")).toBe("en-US");
    expect(store.get("dictationMicrophone")).toBe("usb-mic");
    expect(store.get("dictationHint")).toBe("Transrator, Osolar");
    expect(store.get("dictationIdleSeconds")).toBe(300);
    expect(invoke).toHaveBeenCalledWith("settings_save", { rid: 1 });
  });

  it("keeps the window open and writes no settings if shortcut registration fails", async () => {
    await boot();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "update_shortcuts") throw new Error("이미 사용 중인 단축키");
      return original(command, args);
    });
    button("btn-save").click();
    await vi.waitFor(() => expect(status()).toContain("저장하지 못했습니다"));
    expect(close).not.toHaveBeenCalled();
    expect([...store]).toEqual([]);
    expect(button("btn-save").disabled).toBe(false);
  });

  it("rolls back partial persistence and restores previous shortcuts after a disk failure", async () => {
    store.set("dictationHint", "기존 단어");
    store.set("dictationMicrophone", "usb-mic");
    store.set("dictationShortcut", "Super+Ctrl+KeyR");
    const before = new Map(store);
    await boot();
    const original = invoke.getMockImplementation()!;
    let fail = true;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "settings_set" && args.key === "dictationHint" && fail) { fail = false; throw new Error("disk full"); }
      return original(command, args);
    });
    (document.getElementById("dictation-hint") as HTMLInputElement).value = "새 단어";
    button("btn-save").click();
    await vi.waitFor(() => expect(status()).toContain("저장하지 못했습니다"));
    expect(store).toEqual(before);
    expect(close).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenLastCalledWith("update_shortcuts", expect.objectContaining({ dictationShortcut: "Super+Ctrl+KeyR" }));
    expect((document.getElementById("dictation-hint") as HTMLInputElement).value).toBe("새 단어");
  });

  it("resumes native shortcuts before the cancel button closes shortcut recording", async () => {
    await boot();
    button("shortcut-dictation").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("suspend_shortcuts"));
    await vi.waitFor(() => expect(button("shortcut-dictation").classList.contains("recording")).toBe(true));
    button("btn-cancel").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("resume_shortcuts");
    expect(invoke.mock.invocationCallOrder[invoke.mock.calls.findIndex(call => call[0] === "resume_shortcuts")]).toBeLessThan(close.mock.invocationCallOrder[0]);
  });

  it("cancels shortcut capture with Escape without closing settings", async () => {
    await boot();
    button("shortcut-dictation").click();
    await vi.waitFor(() => expect(button("shortcut-dictation").classList.contains("recording")).toBe(true));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("resume_shortcuts"));
    expect(close).not.toHaveBeenCalled();
    expect(button("shortcut-dictation").textContent).toBe("⌘⌃D");
  });

  it("restores shortcuts before the native window close action finishes", async () => {
    await boot();
    button("shortcut-dictation").click();
    await vi.waitFor(() => expect(button("shortcut-dictation").classList.contains("recording")).toBe(true));
    const preventDefault = vi.fn();
    await closeRequested!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("resume_shortcuts");
    expect(close).toHaveBeenCalledOnce();
  });

  it("checks the visible model choice instead of the previously saved model", async () => {
    await boot();
    select("whisper-model").value = "medium";
    select("whisper-model").dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("check_whisper_model", { model: "medium" }));
    expect(store.has("whisperModel")).toBe(false);
  });

  it("guides users to change a conflicting dictation shortcut without blocking settings", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_shortcut_status") return { dictationRegistered: false, suspended: false, error: "already registered" };
      return original(command, args);
    });
    await boot();
    const warning = document.getElementById("dictation-shortcut-status")!;
    expect(warning.classList.contains("hidden")).toBe(false);
    expect(warning.textContent).toContain("새 조합");
    expect(button("btn-save").disabled).toBe(false);
    button("show-dictation-shortcut").click();
    expect(document.getElementById("pane-shortcuts")!.classList.contains("active")).toBe(true);
  });

  it("checks permission status without prompting or loading a model when settings opens", async () => {
    await boot();
    expect(invoke).toHaveBeenCalledWith("get_dictation_permissions");
    expect(invoke.mock.calls.some(call => call[0] === "request_dictation_permissions")).toBe(false);
    expect(invoke.mock.calls.some(call => ["ensure_whisper_loaded", "load_whisper_model", "toggle_global_dictation"].includes(call[0]))).toBe(false);
    expect(document.getElementById("dictation-permission-status")!.textContent).toContain("허용됨");
  });

  it("refreshes permissions on tab entry without requesting OS access", async () => {
    await boot();
    const before = invoke.mock.calls.filter(call => call[0] === "get_dictation_permissions").length;
    document.querySelector<HTMLButtonElement>('[data-tab="dictation"]')!.click();
    await vi.waitFor(() => expect(invoke.mock.calls.filter(call => call[0] === "get_dictation_permissions").length).toBe(before + 1));
    expect(invoke.mock.calls.some(call => call[0] === "request_dictation_permissions")).toBe(false);
  });

  it("requests missing permissions only after the user presses the request button", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_dictation_permissions") return { microphone: false, microphoneStatus: "notDetermined", accessibility: false, modelLoaded: true };
      return original(command, args);
    });
    await boot();
    expect(document.getElementById("dictation-permission-status")!.textContent).toBe("필요한 권한: 마이크 · 손쉬운 사용");
    button("dictation-permission-request").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("request_dictation_permissions"));
    expect(invoke.mock.calls.some(call => ["ensure_whisper_loaded", "load_whisper_model", "toggle_global_dictation", "update_shortcuts"].includes(call[0]))).toBe(false);
  });

  it("keeps settings usable if permission discovery fails", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_dictation_permissions") throw new Error("permissions unavailable");
      return original(command, args);
    });
    await boot();
    expect(button("btn-save").disabled).toBe(false);
    expect(button("dictation-permission-request").disabled).toBe(false);
    expect(document.getElementById("dictation-permission-status")!.textContent).toContain("확인하지 못했습니다");
  });

  it("previews the native status panel without requesting permissions or starting audio", async () => {
    await boot();
    const callsBefore = invoke.mock.calls.length;
    button("preview-dictation-panel").click();
    await vi.waitFor(() => expect(status()).toContain("녹음하지 않습니다"));
    expect(invoke.mock.calls.slice(callsBefore).map(call => call[0])).toEqual(["preview_dictation_panel"]);
    expect(button("btn-save").disabled).toBe(false);
  });

  it("asks users to finish active dictation when the native preview is unavailable", async () => {
    await boot();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "preview_dictation_panel") return false;
      return original(command, args);
    });
    button("preview-dictation-panel").click();
    await vi.waitFor(() => expect(status()).toContain("받아쓰기를 먼저 종료"));
    expect(button("preview-dictation-panel").disabled).toBe(false);
  });

  it("does not treat intentionally suspended shortcuts as a conflict", async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_shortcut_status") return { dictationRegistered: false, suspended: true };
      return original(command, args);
    });
    await boot();
    expect(document.getElementById("dictation-shortcut-status")!.classList.contains("hidden")).toBe(true);
    expect(button("btn-save").disabled).toBe(false);
  });

  it("leaves settings usable when shortcut status discovery fails", async () => {
    const original = invoke.getMockImplementation()!;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_shortcut_status") throw new Error("status unavailable");
      return original(command, args);
    });
    await boot();
    expect(button("btn-save").disabled).toBe(false);
    expect(document.getElementById("dictation-shortcut-status")!.classList.contains("hidden")).toBe(true);
  });

  it("blocks saving while microphone refresh is pending and re-enables it only after completion", async () => {
    await boot();
    let finish: (value: unknown) => void = () => {};
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_dictation_microphones") return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    button("dictation-microphone-refresh").click();
    expect(button("btn-save").disabled).toBe(true);
    expect(select("dictation-microphone").disabled).toBe(true);
    button("btn-save").click();
    expect(store.size).toBe(0);
    finish(microphoneList);
    await vi.waitFor(() => expect(button("btn-save").disabled).toBe(false));
    expect(select("dictation-microphone").disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("blocks saving and model changes until a download finishes", async () => {
    await boot();
    let finish: (value: unknown) => void = () => {};
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "check_whisper_model") return { ...installedModel, downloaded: false, ggmlDownloaded: false, coremlDownloaded: false };
      if (command === "download_whisper_model") return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    select("whisper-model").value = "medium";
    select("whisper-model").dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(button("model-download-btn").style.display).toBe(""));
    button("model-download-btn").click();
    expect(button("btn-save").disabled).toBe(true);
    expect(select("whisper-model").disabled).toBe(true);
    button("btn-save").click();
    expect(store.size).toBe(0);
    finish(installedModel);
    await vi.waitFor(() => expect(button("btn-save").disabled).toBe(false));
    expect(select("whisper-model").disabled).toBe(false);
  });

  it("retains the saved microphone and allows settings to load if device discovery fails", async () => {
    store.set("dictationMicrophone", "saved-mic");
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "list_dictation_microphones") throw new Error("device service unavailable");
      return original(command, args);
    });
    await boot();
    expect(select("dictation-microphone").value).toBe("saved-mic");
    expect(document.getElementById("dictation-microphone-status")!.textContent).toContain("가져오지 못했습니다");
    expect(button("btn-save").disabled).toBe(false);
  });

  it("restores unlimited model retention and persists the selected interval as seconds", async () => {
    store.set("dictationIdleSeconds", 0);
    await boot();
    expect(select("dictation-idle-seconds").value).toBe("0");
    select("dictation-idle-seconds").value = "900";
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("dictationIdleSeconds")).toBe(900);
  });

  it("uses five-minute model retention when stored settings contain an unsupported interval", async () => {
    store.set("dictationIdleSeconds", -10);
    await boot();
    expect(select("dictation-idle-seconds").value).toBe("300");
  });

  it("waits for an in-flight shortcut suspension before closing and resuming shortcuts", async () => {
    await boot();
    let suspended: () => void = () => {};
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "suspend_shortcuts") return new Promise<void>(resolve => { suspended = resolve; });
      return original(command, args);
    });
    button("shortcut-dictation").click();
    button("btn-cancel").click();
    expect(close).not.toHaveBeenCalled();
    suspended();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invoke).toHaveBeenCalledWith("resume_shortcuts");
  });

  it("retries restoring suspended shortcuts before allowing a later close", async () => {
    await boot();
    const original = invoke.getMockImplementation()!;
    let attempts = 0;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "resume_shortcuts" && attempts++ === 0) throw new Error("temporary resume failure");
      return original(command, args);
    });
    button("shortcut-dictation").click();
    await vi.waitFor(() => expect(button("shortcut-dictation").classList.contains("recording")).toBe(true));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(status()).toContain("복구하지 못했습니다"));
    button("btn-cancel").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
  });

  it("uses the visible model for downloads and leaves loading to the next voice session", async () => {
    await boot();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "check_whisper_model") return { ...installedModel, downloaded: false, ggmlDownloaded: false, coremlDownloaded: false };
      if (command === "download_whisper_model") return installedModel;
      return original(command, args);
    });
    select("whisper-model").value = "medium";
    select("whisper-model").dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(button("model-download-btn").style.display).toBe(""));
    expect(button("model-download-btn").textContent).toContain("2.1 GB");
    button("model-download-btn").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("download_whisper_model", { model: "medium" }));
    expect(invoke.mock.calls.some(call => call[0] === "load_whisper_model")).toBe(false);
  });

  it("blocks duplicate saves and editing until the saved values are flushed", async () => {
    await boot();
    let flush: () => void = () => {};
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "settings_save") return new Promise<void>(resolve => { flush = resolve; });
      return original(command, args);
    });
    button("btn-save").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_save", { rid: 1 }));
    expect(button("btn-save").disabled).toBe(true);
    expect(select("dictation-locale").disabled).toBe(true);
    const preventDefault = vi.fn();
    await closeRequested!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    button("btn-save").click();
    expect(invoke.mock.calls.filter(call => call[0] === "update_shortcuts")).toHaveLength(1);
    flush();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });
  function typeKey(id: string, value: string) {
    const input = document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  }

  it("never reads, prefills, writes or rolls back plaintext keys through ordinary settings", async () => {
    store.set("apiKey", "private-legacy-key");
    store.set("openaiApiKey", "private-other-key");
    credentials.set("gemini-native", { configured: true, revision: "original" });
    await boot();
    expect((document.getElementById("api-key") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("openai-api-key") as HTMLInputElement).value).toBe("");
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invoke.mock.calls.filter(([command, args]) => command.startsWith("settings_") && ["apiKey", "openaiApiKey"].includes(args?.key))).toEqual([]);
    expect(invoke.mock.calls.some(([command]) => command === "save_provider_credential" || command === "delete_provider_credential")).toBe(false);
  });

  it("stores a newly typed key only with its separate explicit button and clears it on success", async () => {
    credentials.set("gemini-native", { configured: true, revision: "original" });
    await boot();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    const input = typeKey("api-key", "  fake-new-key  ");
    expect(invoke.mock.calls.some(([command]) => command === "save_provider_credential")).toBe(false);
    button("btn-save").click();
    expect(close).not.toHaveBeenCalled();
    expect(status()).toContain("API 키 저장 버튼");
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(invoke).toHaveBeenCalledWith("save_provider_credential", { providerId: "gemini-native", apiKey: "fake-new-key", expectedRevision: "original" });
    expect(document.getElementById("gemini-key-status")!.textContent).toContain("Keychain에 API 키를 저장");
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invoke.mock.calls.filter(([command]) => command === "save_provider_credential")).toHaveLength(1);
  });

  it("uses the newly committed revision and removes a saved key only after explicit delete confirmation", async () => {
    credentials.set("gemini-native", { configured: true, revision: "original" });
    await boot();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    const input = typeKey("api-key", "replacement");
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    const revision = credentials.get("gemini-native")!.revision;
    button("gemini-key-delete").click();
    expect(invoke.mock.calls.some(([command]) => command === "delete_provider_credential")).toBe(false);
    button("gemini-key-delete").click();
    await vi.waitFor(() => expect(document.getElementById("gemini-key-status")!.textContent).toContain("삭제했습니다"));
    expect(invoke).toHaveBeenCalledWith("delete_provider_credential", { providerId: "gemini-native", expectedRevision: revision });
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(invoke.mock.calls.filter(([command]) => command === "delete_provider_credential")).toHaveLength(1);
  });

  it("keeps the input on stale credential failure and requires a refreshed revision for retry", async () => {
    credentials.set("gemini-native", { configured: true, revision: "first" });
    await boot();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    credentials.set("gemini-native", { configured: true, revision: "changed-elsewhere" });
    const input = typeKey("api-key", "replacement");
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(document.getElementById("gemini-key-status")!.textContent).toContain("입력을 유지"));
    expect(input.value).toBe("replacement");
    expect(close).not.toHaveBeenCalled();
    button("gemini-key-refresh").click();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(invoke).toHaveBeenLastCalledWith("save_provider_credential", { providerId: "gemini-native", apiKey: "replacement", expectedRevision: "changed-elsewhere" });
  });

  it("excludes typed passwords from the form fingerprint", async () => {
    await boot();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    const stringify = vi.spyOn(JSON, "stringify");
    typeKey("api-key", "private-input-must-not-be-fingerprinted");
    const values = stringify.mock.calls.map(call => call[0]);
    stringify.mockRestore();
    expect(JSON.stringify(values)).not.toContain("private-input-must-not-be-fingerprinted");
  });

  it("does not access Keychain while loading or saving an Ollama connection", async () => {
    store.set("llmBackendId", "ollama");
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_credential_status") throw new Error("Keychain 잠김");
      return original(command, args);
    });
    await boot();
    select("dictation-locale").value = "en-US";
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("dictationLocale")).toBe("en-US");
    expect(invoke.mock.calls.some(([command]) => command === "get_credential_status")).toBe(false);
  });

  it("keeps ordinary and voice settings usable while a cloud credential status read is pending", async () => {
    const original = invoke.getMockImplementation()!;
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_credential_status") return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    await boot();
    expect(button("gemini-key-refresh").disabled).toBe(true);
    select("dictation-locale").value = "en-US";
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("dictationLocale")).toBe("en-US");
    finish({ configured: false, revision: null });
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
  });

  it("allows explicit repair when metadata exists but the referenced Keychain item is missing", async () => {
    credentials.set("gemini-native", { configured: true, revision: "missing-item", error: "저장된 Keychain 항목을 찾을 수 없습니다." });
    await boot();
    await vi.waitFor(() => expect(document.getElementById("gemini-key-status")!.textContent).toContain("찾을 수 없습니다"));
    const input = typeKey("api-key", "repair-key");
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(invoke).toHaveBeenCalledWith("save_provider_credential", { providerId: "gemini-native", apiKey: "repair-key", expectedRevision: "missing-item" });
  });

  it("waits for a credential mutation before allowing cancellation or native close", async () => {
    await boot();
    await vi.waitFor(() => expect(button("gemini-key-refresh").disabled).toBe(false));
    const original = invoke.getMockImplementation()!;
    let finish: (value: unknown) => void = () => {};
    invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "save_provider_credential") return new Promise(resolve => { finish = resolve; });
      return original(command, args);
    });
    typeKey("api-key", "pending-key");
    button("gemini-key-save").click();
    await vi.waitFor(() => expect(button("btn-cancel").disabled).toBe(true));
    button("btn-cancel").click();
    const preventDefault = vi.fn(); await closeRequested!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(close).not.toHaveBeenCalled();
    finish({ configured: true, revision: "committed" });
    await vi.waitFor(() => expect(button("btn-cancel").disabled).toBe(false));
    button("btn-cancel").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  const modelInput = () => document.getElementById("ollama-model") as HTMLInputElement;
  const urlInput = () => document.getElementById("ollama-baseurl") as HTMLInputElement;
  const modelOptions = () => [...document.querySelectorAll<HTMLOptionElement>("#ollama-model-list option")].map(option => option.value);
  const lookupStatus = () => document.getElementById("ollama-status")!.textContent;
  const tags = (models: string[]) => new Response(JSON.stringify({ models: models.map(name => ({ name })) }));
  function localSettings() {
    store.set("llmBackendId", "ollama");
    store.set("ollamaModel", "my/custom-model:latest");
    store.set("ollamaBaseUrl", "http://192.168.1.40:11434/ollama/");
  }

  it("keeps a saved custom Ollama model in a directly editable field on unrelated settings save", async () => {
    localSettings(); await boot();
    expect(modelInput().tagName).toBe("INPUT");
    expect(modelInput().getAttribute("list")).toBe("ollama-model-list");
    expect(modelInput().value).toBe("my/custom-model:latest");
    expect(modelOptions()).toEqual([]);
    select("dictation-locale").value = "en-US";
    button("btn-save").click();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(store.get("ollamaModel")).toBe("my/custom-model:latest");
    expect(store.get("ollamaBaseUrl")).toBe("http://192.168.1.40:11434/ollama");
    expect(invoke.mock.calls.some(([command]) => command === "get_credential_status")).toBe(false);
  });

  it("updates suggestions only when the explicit lookup succeeds and never substitutes the selected custom model", async () => {
    localSettings();
    const fetch = vi.fn().mockResolvedValue(tags(["installed:one", "installed:two"]));
    vi.stubGlobal("fetch", fetch);
    await boot();
    expect(fetch).not.toHaveBeenCalled();
    button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(modelOptions()).toEqual(["installed:one", "installed:two"]));
    expect(modelInput().value).toBe("my/custom-model:latest");
    expect(urlInput().value).toBe("http://192.168.1.40:11434/ollama/");
    expect(store.get("ollamaModel")).toBe("my/custom-model:latest");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("http://192.168.1.40:11434/ollama/api/tags");
    expect(lookupStatus()).toContain("입력한 모델은 유지");
  });

  it("preserves a model typed while model discovery is pending", async () => {
    localSettings();
    let finish: (value: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    await boot(); button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    modelInput().value = "new/typed-model:custom";
    modelInput().dispatchEvent(new Event("input", { bubbles: true }));
    finish(tags(["installed:one"]));
    await vi.waitFor(() => expect(button("ollama-detect-btn").disabled).toBe(false));
    expect(modelOptions()).toEqual(["installed:one"]);
    expect(modelInput().value).toBe("new/typed-model:custom");
  });

  it("does not let a late lookup for an old server replace the current suggestions or status", async () => {
    localSettings();
    let finishOld: (value: Response) => void = () => {};
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(tags(["new-server:one"]));
    vi.stubGlobal("fetch", fetch);
    await boot(); button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    urlInput().value = "http://localhost:11500/proxy/";
    urlInput().dispatchEvent(new Event("input", { bubbles: true }));
    expect(button("ollama-detect-btn").disabled).toBe(false);
    button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(modelOptions()).toEqual(["new-server:one"]));
    const currentStatus = lookupStatus();
    finishOld(tags(["old-server:one", "old-server:two"]));
    await vi.waitFor(() => expect(button("btn-save").disabled).toBe(false));
    expect(modelOptions()).toEqual(["new-server:one"]);
    expect(lookupStatus()).toBe(currentStatus);
    expect(modelInput().value).toBe("my/custom-model:latest");
  });

  it("ignores an old failed response after the URL has changed", async () => {
    localSettings();
    let failOld: (error: Error) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => { failOld = reject; })));
    await boot(); button("ollama-detect-btn").click();
    urlInput().value = "http://localhost:11500";
    urlInput().dispatchEvent(new Event("input", { bubbles: true }));
    const changedStatus = lookupStatus();
    failOld(new Error("connection refused"));
    await vi.waitFor(() => expect(button("btn-save").disabled).toBe(false));
    expect(lookupStatus()).toBe(changedStatus);
    expect(modelInput().value).toBe("my/custom-model:latest");
    expect(modelOptions()).toEqual([]);
  });

  it("keeps the address and model intact on discovery failure", async () => {
    localSettings();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await boot(); button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(lookupStatus()).toContain("연결할 수 없습니다"));
    expect(modelInput().value).toBe("my/custom-model:latest");
    expect(urlInput().value).toBe("http://192.168.1.40:11434/ollama/");
    expect(modelOptions()).toEqual([]);
  });

  it("explains an empty model list without filling or changing the model", async () => {
    localSettings(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tags([])));
    await boot(); button("ollama-detect-btn").click();
    await vi.waitFor(() => expect(lookupStatus()).toContain("모델 목록이 비어 있습니다"));
    expect(modelInput().value).toBe("my/custom-model:latest");
    expect(modelOptions()).toEqual([]);
  });

  it.each(["http://user:password@localhost:11434", "http://localhost:11434?token=value", "http://localhost:11434\\proxy"])(
    "uses the same URL validation before saving as discovery: %s", async url => {
      localSettings(); await boot();
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      urlInput().value = url;
      button("btn-save").click();
      await vi.waitFor(() => expect(status()).toContain("Ollama URL"));
      expect(close).not.toHaveBeenCalled();
      expect(invoke.mock.calls.some(([command]) => command === "update_shortcuts" || command === "settings_set")).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
      expect(store.get("ollamaModel")).toBe("my/custom-model:latest");
    },
  );

  it("does not silently substitute a default when the Ollama model field is empty", async () => {
    localSettings(); await boot();
    modelInput().value = "";
    button("btn-save").click();
    await vi.waitFor(() => expect(status()).toContain("모델 이름을 입력"));
    expect(close).not.toHaveBeenCalled();
    expect(store.get("ollamaModel")).toBe("my/custom-model:latest");
  });

});
