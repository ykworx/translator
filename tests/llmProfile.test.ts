import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("returns a safe model lookup message for unknown errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("some weird unknown error")));

    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false);
    expect(result.error).toContain("모델 목록 조회에 실패");

    vi.unstubAllGlobals();
  });
});


describe("Ollama model discovery validation", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([
    "file:///tmp/models", "ftp://localhost/models", "http://user:password@localhost:11434",
    "http://localhost:11434?key=secret", "http://localhost:11434#models", "http://localhost:11434\\models", "not a URL", "",
  ])("rejects an unsafe or malformed URL without fetching: %s", async url => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await detectOllama(url);
    expect(result.available).toBe(false);
    expect(result.error).toContain("URL");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves a configured LAN server and reverse proxy path while normalizing the URL", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"models":[]}'));
    vi.stubGlobal("fetch", fetch);
    await detectOllama("  HTTP://192.168.1.40:11434/ollama/  ");
    expect(fetch).toHaveBeenCalledWith("http://192.168.1.40:11434/ollama/api/tags", expect.objectContaining({ signal: expect.anything() }));
  });

  it("ignores null and malformed model entries, retains custom names and removes duplicates", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [null, 42, {}, { name: null }, { name: 7 }, { name: " custom/model:latest " }, "gemma3:4b", { name: "custom/model:latest" }, ""] }))));
    expect(await detectOllama("http://localhost:11434")).toEqual({ available: true, models: ["custom/model:latest", "gemma3:4b"], error: null });
  });

  it.each([null, [], { models: null }])("reports malformed top-level responses safely: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false); expect(result.error).toContain("형식");
  });

  it("distinguishes invalid JSON from a connection failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json")));
    const result = await detectOllama("http://localhost:11434");
    expect(result.available).toBe(false); expect(result.error).toContain("JSON 응답 형식");
  });

  it("treats an empty model list as a successful server response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"models":[]}')));
    expect(await detectOllama("http://localhost:11434")).toEqual({ available: true, models: [], error: null });
  });
});

describe("Ollama discovery total deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("aborts a stalled request after five seconds and removes the timer", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    let completed = false;
    const pending = detectOllama("http://localhost:11434").then(result => { completed = true; return result; });
    await vi.advanceTimersByTimeAsync(4999); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).error).toContain("초과");
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes reading the JSON response body in the same five-second deadline", async () => {
    let signal: AbortSignal;
    const json = vi.fn(() => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Body aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.resolve({ ok: true, json } as unknown as Response);
    }));
    const pending = detectOllama("http://localhost:11434");
    await vi.advanceTimersByTimeAsync(0); expect(json).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).error).toContain("초과"); expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline after a complete successful response", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"models":[]}'));
    vi.stubGlobal("fetch", fetch);
    await detectOllama("http://localhost:11434");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });
});
