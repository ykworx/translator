import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetTauriStore, setTauriStoreValue, getTauriStoreValue, registerInvokeCommand, resetInvokeCommands } from "./helpers/tauriMock";

import { getActiveBackendId, setActiveBackendId, migrateLegacySettings, detectOllama } from "../src/llmProfile";

describe("llmProfile", () => {
  beforeEach(() => {
    resetTauriStore();
    resetInvokeCommands();
  });

  describe("getActiveBackendId", () => {
    it("returns 'gemini-native' by default", async () => {
      const id = await getActiveBackendId();
      expect(id).toBe("gemini-native");
    });

    it("returns stored value when set", async () => {
      setTauriStoreValue("llmBackendId", "ollama");
      const id = await getActiveBackendId();
      expect(id).toBe("ollama");
    });
  });

  describe("setActiveBackendId", () => {
    it("persists the backend id", async () => {
      await setActiveBackendId("ollama");
      expect(getTauriStoreValue("llmBackendId")).toBe("ollama");
    });
  });

  describe("migrateLegacySettings", () => {
    it("sets gemini-native when apiKey exists and llmBackendId is not set", async () => {
      setTauriStoreValue("apiKey", "existing-key");
      // llmBackendId not set

      await migrateLegacySettings();

      expect(getTauriStoreValue("llmBackendId")).toBe("gemini-native");
    });

    it("does nothing when llmBackendId is already set", async () => {
      setTauriStoreValue("apiKey", "existing-key");
      setTauriStoreValue("llmBackendId", "ollama");

      await migrateLegacySettings();

      // Should NOT have changed the existing value
      expect(getTauriStoreValue("llmBackendId")).toBe("ollama");
    });

    it("does nothing when apiKey is empty and llmBackendId not set", async () => {
      setTauriStoreValue("apiKey", "");

      await migrateLegacySettings();

      // No backend id should be set
      expect(getTauriStoreValue("llmBackendId")).toBeUndefined();
    });

    it("does not overwrite a provider selected while legacy credential status is pending", async () => {
      let finish: (value: unknown) => void = () => {};
      const read = vi.fn(() => new Promise(resolve => { finish = resolve; }));
      registerInvokeCommand("get_credential_status", read);
      const migration = migrateLegacySettings();
      await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
      await setActiveBackendId("ollama");
      finish({ configured: true, revision: "legacy-migrated" });
      await migration;
      expect(getTauriStoreValue("llmBackendId")).toBe("ollama");
    });

    it("keeps selection and local settings intact when Keychain access fails", async () => {
      registerInvokeCommand("get_credential_status", () => { throw new Error("Keychain 잠김"); });
      setTauriStoreValue("dictationLocale", "ko-KR");
      await migrateLegacySettings();
      expect(getTauriStoreValue("llmBackendId")).toBeUndefined();
      expect(getTauriStoreValue("dictationLocale")).toBe("ko-KR");
    });
  });
});

describe("detectOllama", () => {
  it("returns available:true and model list on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { name: "gemma3:4b" },
            { name: "llava:7b" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await detectOllama("http://localhost:11434");

    expect(result.available).toBe(true);
    expect(result.models).toEqual(["gemma3:4b", "llava:7b"]);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:11434/api/tags",
      expect.objectContaining({ signal: expect.anything() }),
    );

    vi.unstubAllGlobals();
  });

  it("returns available:false on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("returns available:false on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("strips trailing slash from baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await detectOllama("http://localhost:11434/");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:11434/api/tags");

    vi.unstubAllGlobals();
  });

  it("returns error message on 404 response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("404");

    vi.unstubAllGlobals();
  });

  it("returns 'Failed to fetch' connection error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("ollama serve");

    vi.unstubAllGlobals();
  });

  it("returns format error on invalid JSON structure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ notModels: "bad" }), { status: 200 }),
    ));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("형식");

    vi.unstubAllGlobals();
  });

  it("returns error:null on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: "gemma3:4b" }] }), { status: 200 }),
    ));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(true);
    expect(result.error).toBeNull();

    vi.unstubAllGlobals();
  });

  it("returns user-friendly timeout message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The operation timed out")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("초과");

    vi.unstubAllGlobals();
  });

  it("returns user-friendly message for aborted signal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("The user aborted a request.")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("초과");

    vi.unstubAllGlobals();
  });

  it("returns user-friendly ECONNREFUSED message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:11434")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("거부");

    vi.unstubAllGlobals();
  });

  it("returns user-friendly connection refused message (lowercase)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("거부");

    vi.unstubAllGlobals();
  });

  it("returns Ollama 감지 실패 prefix for unknown errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("some weird unknown error")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("Ollama 감지 실패");

    vi.unstubAllGlobals();
  });
});
