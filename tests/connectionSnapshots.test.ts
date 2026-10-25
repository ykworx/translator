import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getActiveBackend, resetOllamaBackendCache, resetOpenAiBackendCache } from "../src/llmBackend";
import { registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue, getTauriStoreValue } from "./helpers/tauriMock";

const json = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json" },
});

function localConnection(model = "gemma3:4b", baseUrl = "http://localhost:11434") {
  setTauriStoreValue("llmBackendId", "ollama");
  setTauriStoreValue("ollamaModel", model);
  setTauriStoreValue("ollamaBaseUrl", baseUrl);
}

beforeEach(() => {
  resetTauriStore();
  resetInvokeCommands();
  resetOllamaBackendCache();
  resetOpenAiBackendCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetInvokeCommands();
  resetOllamaBackendCache();
  resetOpenAiBackendCache();
});

describe("connection snapshot routing", () => {
  it("keeps an acquired local backend local after the active provider changes", async () => {
    localConnection();
    const fetch = vi.fn().mockImplementation(async (url: string) => json(
      url.endsWith("/api/show") ? { capabilities: ["completion"] } : { choices: [{ message: { content: "로컬 번역" } }] },
    ));
    vi.stubGlobal("fetch", fetch);
    const local = await getActiveBackend();
    setTauriStoreValue("llmBackendId", "openai");
    setTauriStoreValue("openaiApiKey", "fake-cloud-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");
    const cloud = vi.fn((_args?: Record<string, unknown>) => "클라우드 번역");
    registerInvokeCommand("openai_generate_text", cloud);
    expect(await local.generateText("문장")).toBe("로컬 번역");
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(cloud).not.toHaveBeenCalled();
    expect(await (await getActiveBackend()).generateText("새 문장")).toBe("클라우드 번역");
  });

  it("preserves an explicitly configured LAN endpoint and reverse-proxy base path", async () => {
    localConnection("local/model:latest", "http://192.168.1.40:11434/ollama/");
    const fetch = vi.fn().mockImplementation(async (url: string) => json(
      url.endsWith("/api/show") ? { capabilities: ["completion", "vision"] } : { choices: [{ message: { content: "결과" } }] },
    ));
    vi.stubGlobal("fetch", fetch);
    const backend = await getActiveBackend();
    expect(backend.supportsVision).toBe(true);
    await backend.generateImage("설명", "fake-png");
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      "http://192.168.1.40:11434/ollama/api/show",
      "http://192.168.1.40:11434/ollama/v1/chat/completions",
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body).model).toBe("local/model:latest");
    expect(getTauriStoreValue("ollamaBaseUrl")).toBe("http://192.168.1.40:11434/ollama/");
  });

  it("invalidates a cloud backend on key rotation while retaining the old request snapshot", async () => {
    setTauriStoreValue("llmBackendId", "openai");
    setTauriStoreValue("openaiApiKey", "fake-original-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");
    const invoke = vi.fn((_args?: Record<string, unknown>) => "결과");
    registerInvokeCommand("openai_generate_text", invoke);
    const old = await getActiveBackend();
    setTauriStoreValue("openaiApiKey", "fake-replacement-key");
    const current = await getActiveBackend();
    expect(current).not.toBe(old);
    await old.generateText("원래 요청");
    await current.generateText("새 요청");
    expect(invoke.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ apiKey: "fake-original-key", model: "gpt-4o-mini" }),
      expect.objectContaining({ apiKey: "fake-replacement-key", model: "gpt-4o-mini" }),
    ]);
    setTauriStoreValue("openaiApiKey", "");
    await expect(getActiveBackend()).rejects.toThrow();
  });

  it("shares one capability probe for simultaneous requests for the same connection", async () => {
    localConnection();
    let finish: (value: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const first = getActiveBackend();
    const second = getActiveBackend();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    finish(json({ capabilities: ["completion"] }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not replace the current cache when an older capability request finishes late", async () => {
    localConnection("older-model");
    let finishOld: (value: Response) => void = () => {};
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).name === "older-model") {
        return new Promise<Response>(resolve => { finishOld = resolve; });
      }
      return Promise.resolve(json({ capabilities: ["completion", "vision"] }));
    });
    vi.stubGlobal("fetch", fetch);
    const oldRequest = getActiveBackend();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    setTauriStoreValue("ollamaModel", "newer-model");
    const current = await getActiveBackend();
    finishOld(json({ capabilities: ["completion"] }));
    const old = await oldRequest;
    expect(old.supportsVision).toBe(false);
    expect(current.supportsVision).toBe(true);
    expect(await getActiveBackend()).toBe(current);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to a cloud backend for an unknown saved provider", async () => {
    setTauriStoreValue("llmBackendId", "unavailable-provider");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(getActiveBackend()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(getTauriStoreValue("llmBackendId")).toBe("unavailable-provider");
  });

  it("does not fall back to defaults when the connection store cannot be read", async () => {
    localConnection();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    registerInvokeCommand("plugin:store|entries", () => { throw new Error("disk unavailable"); });
    await expect(getActiveBackend()).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["file:///tmp/ollama", "https://user:password@example.com", "http://localhost:11434?key=secret", "http://localhost:11434#fragment"])(
    "refuses an invalid local endpoint without sending a request: %s", async url => {
      localConnection("gemma3:4b", url);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(getActiveBackend()).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves unrelated voice, language and inactive provider settings", async () => {
    localConnection();
    const saved = { apiKey: "fake-inactive-key", openaiModel: "inactive-model", whisperModel: "medium", dictationMicrophone: "usb-device", dictationShortcut: "Super+Ctrl+KeyR", targetLanguage: "日本語" };
    Object.entries(saved).forEach(([key, value]) => setTauriStoreValue(key, value));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ capabilities: ["completion"] })));
    await getActiveBackend();
    Object.entries(saved).forEach(([key, value]) => expect(getTauriStoreValue(key)).toBe(value));
    expect(getTauriStoreValue("ollamaModel")).toBe("gemma3:4b");
  });
});
