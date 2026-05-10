import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

import { getActiveBackend, resetOllamaBackendCache, type LlmBackend } from "../src/llmBackend";
import { geminiNativeBackend } from "../src/geminiClient";
import { getOllamaBackend } from "../src/ollamaClient";

function assertBackendContract(backend: LlmBackend) {
  expect(typeof backend.id).toBe("string");
  expect(["gemini-native", "ollama"]).toContain(backend.id);
  expect(typeof backend.label).toBe("string");
  expect(backend.label.length).toBeGreaterThan(0);
  expect(typeof backend.supportsVision).toBe("boolean");
  expect(typeof backend.generateText).toBe("function");
  expect(typeof backend.generateTextStream).toBe("function");
  expect(typeof backend.generateImage).toBe("function");
}

describe("LlmBackend contract", () => {
  it("geminiNativeBackend satisfies interface", () => {
    assertBackendContract(geminiNativeBackend);
    expect(geminiNativeBackend.id).toBe("gemini-native");
    expect(geminiNativeBackend.supportsVision).toBe(true);
  });

  it("ollamaBackend satisfies interface", async () => {
    const backend = await getOllamaBackend();
    assertBackendContract(backend);
    expect(backend.id).toBe("ollama");
  });
});

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getActiveBackend", () => {
  beforeEach(() => {
    resetTauriStore();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["completion", "vision"] })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns geminiNativeBackend by default (no stored value)", async () => {
    const backend = await getActiveBackend();
    expect(backend.id).toBe("gemini-native");
  });

  it("returns geminiNativeBackend when store has 'gemini-native'", async () => {
    setTauriStoreValue("llmBackendId", "gemini-native");
    const backend = await getActiveBackend();
    expect(backend.id).toBe("gemini-native");
  });

  it("returns ollamaBackend when store has 'ollama'", async () => {
    setTauriStoreValue("llmBackendId", "ollama");
    const backend = await getActiveBackend();
    expect(backend.id).toBe("ollama");
  });
});

describe("getActiveBackend — cache key behaviour", () => {
  beforeEach(() => {
    resetTauriStore();
    resetOllamaBackendCache();
    setTauriStoreValue("llmBackendId", "ollama");
    setTauriStoreValue("ollamaBaseUrl", "http://localhost:11434");
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOllamaBackendCache();
  });

  it("reuses cached backend on second call with same baseUrl+model", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: ["completion", "vision"] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const b1 = await getActiveBackend();
    const b2 = await getActiveBackend();
    expect(b1).toBe(b2);
    // /api/show called only once despite two getActiveBackend calls
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches new capabilities when model changes", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: ["completion"] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await getActiveBackend();
    setTauriStoreValue("ollamaModel", "gemma2:9b");
    await getActiveBackend();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches new capabilities when baseUrl changes", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: ["completion", "vision"] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await getActiveBackend();
    setTauriStoreValue("ollamaBaseUrl", "http://192.168.1.10:11434");
    await getActiveBackend();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("treats trailing-slash and no-trailing-slash baseUrl as the same cache entry", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: ["completion", "vision"] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    // First call with no trailing slash
    const b1 = await getActiveBackend();
    // Second call with trailing slash — should hit cache, not re-fetch
    setTauriStoreValue("ollamaBaseUrl", "http://localhost:11434/");
    const b2 = await getActiveBackend();

    expect(b1).toBe(b2);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
