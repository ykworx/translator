import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(resolve("settings.html"), "utf8");
const installedModel = { downloaded: true, ggmlDownloaded: true, coremlDownloaded: true, sizeBytes: 1_624_555_275, path: "/models/test.bin" };

describe("dictation settings", () => {
  let store: Map<string, unknown>;
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
      switch (command) {
        case "plugin:store|load": return 1;
        case "plugin:store|get": return [store.get(args.key as string), store.has(args.key as string)];
        case "plugin:store|set": store.set(args.key as string, args.value); return;
        case "plugin:store|delete": store.delete(args.key as string); return;
        case "plugin:store|save": return;
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
    expect(invoke).toHaveBeenCalledWith("plugin:store|save", { rid: 1 });
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
      if (command === "plugin:store|set" && args.key === "dictationHint" && fail) { fail = false; throw new Error("disk full"); }
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
      if (command === "plugin:store|save") return new Promise<void>(resolve => { flush = resolve; });
      return original(command, args);
    });
    button("btn-save").click();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("plugin:store|save", { rid: 1 }));
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
});
