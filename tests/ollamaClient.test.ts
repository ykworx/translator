import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";
import { getActiveBackend, resetBackendCache } from "../src/llmBackend";

// Provide store state so ollamaClient reads correct config
setTauriStoreValue("ollamaBaseUrl", "http://localhost:11434");
setTauriStoreValue("ollamaModel", "gemma3:4b");

import {
  generateText,
  generateTextStream,
  generateImage,
  isVisionCapableModel,
  fetchOllamaCapabilities,
  getOllamaBackend,
} from "../src/ollamaClient";

const BASE_URL = "http://localhost:11434";

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

describe("ollamaClient.generateText", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends OpenAI-format POST body with stream:false", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({
        choices: [{ message: { content: "hello" } }],
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await generateText("test prompt");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/chat/completions`);

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gemma3:4b");
    expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);
    expect(body.stream).toBe(false);
  });

  it("includes Bearer ollama header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: "hi" } }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await generateText("prompt");

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ollama");
  });

  it("throws 'Ollama 서버' error on connection refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await expect(generateText("test")).rejects.toThrow("Ollama 서버가 실행 중인지 확인하세요");
  });

  it("throws on non-ok HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("model not found", { status: 404 })),
    );

    await expect(generateText("test")).rejects.toThrow("Ollama API error: 404");
  });
});

describe("ollamaClient.generateTextStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses SSE chunks and passes accumulated string to onChunk", async () => {
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: " World" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(makeSseStream(sseLines), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const chunks: string[] = [];
    const result = await generateTextStream("prompt", chunk => chunks.push(chunk));

    expect(chunks).toEqual(["Hello", "Hello World"]);
    expect(result).toBe("Hello World");
  });

  it("sends stream:true in request body", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.close(); },
    });
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200 }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await generateTextStream("prompt", () => {});

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
  });

  it("handles [DONE] marker without throwing", async () => {
    const sseLines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(makeSseStream(sseLines), { status: 200 }),
      ),
    );

    const result = await generateTextStream("p", () => {});
    expect(result).toBe("ok");
  });
});

describe("ollamaClient.generateImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });

  it("sends image_url as data URL string in content array", async () => {
    // generateImage no longer probes /api/show — only one fetch call (chat/completions)
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: "result" } }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await generateImage("describe this", "abc123==");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/v1/chat/completions`);

    const body = JSON.parse(init.body as string);
    const content = body.messages[0].content as Array<{ type: string; text?: string; image_url?: string }>;

    expect(content[0]).toEqual({ type: "text", text: "describe this" });
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url).toBe("data:image/png;base64,abc123==");
  });

  it("does NOT call /api/show — capability guard is handled by api.ts", async () => {
    // Ensure generateImage makes no /api/show probe regardless of model
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await generateImage("describe", "base64data");

    const showCalls = mockFetch.mock.calls.filter(([url]: [string]) => url.endsWith("/api/show"));
    expect(showCalls).toHaveLength(0);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("isVisionCapableModel", () => {
  it("returns true for gemma3 prefix", () => {
    expect(isVisionCapableModel("gemma3:4b")).toBe(true);
    expect(isVisionCapableModel("gemma3:12b")).toBe(true);
  });

  it("returns false for gemma2 (no vision)", () => {
    expect(isVisionCapableModel("gemma2:9b")).toBe(false);
  });

  it("returns true for llava variants", () => {
    expect(isVisionCapableModel("llava:7b")).toBe(true);
    expect(isVisionCapableModel("bakllava")).toBe(true);
  });

  it("returns true for qwen2-vl and qwen2.5-vl", () => {
    expect(isVisionCapableModel("qwen2-vl:7b")).toBe(true);
    expect(isVisionCapableModel("qwen2.5-vl:7b")).toBe(true);
  });

  it("returns true for minicpm-v and moondream", () => {
    expect(isVisionCapableModel("minicpm-v:8b")).toBe(true);
    expect(isVisionCapableModel("moondream")).toBe(true);
    expect(isVisionCapableModel("moondream:latest")).toBe(true);
  });

  it("returns true for gemma3 with hyphen suffix variants", () => {
    expect(isVisionCapableModel("gemma3-finetune")).toBe(true);
    expect(isVisionCapableModel("gemma3-instruct:4b")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isVisionCapableModel("")).toBe(false);
  });

  it("is case-insensitive for known patterns", () => {
    expect(isVisionCapableModel("LLaVA:13b")).toBe(true);
    expect(isVisionCapableModel("Gemma3:4b")).toBe(true);
  });

  it("does not false-positive on names where llava is embedded within a token", () => {
    expect(isVisionCapableModel("pallava")).toBe(false);
    expect(isVisionCapableModel("syllava2")).toBe(false);
  });

  it("returns false when llava appears as a non-head token (conservative matching)", () => {
    // "not-llava-related" splits to firstToken="not" → no match
    expect(isVisionCapableModel("not-llava-related")).toBe(false);
    // "my-llava-finetune" splits to firstToken="my" → no match
    expect(isVisionCapableModel("my-llava-finetune")).toBe(false);
  });

  it("returns true for llava with namespace prefix", () => {
    expect(isVisionCapableModel("my/llava:latest")).toBe(true);
    expect(isVisionCapableModel("library/llava-phi3")).toBe(true);
  });

  it("returns true for llava-llama3 compound (llava is head token)", () => {
    expect(isVisionCapableModel("llava-llama3:8b")).toBe(true);
  });

  it("returns true for llava:7b", () => {
    expect(isVisionCapableModel("llava:7b")).toBe(true);
  });

  it("returns false for gemma2:9b (not gemma3)", () => {
    expect(isVisionCapableModel("gemma2:9b")).toBe(false);
  });

  it("returns true for gemma3 bare name", () => {
    expect(isVisionCapableModel("gemma3")).toBe(true);
  });

  it("returns true for gemma3:4b", () => {
    expect(isVisionCapableModel("gemma3:4b")).toBe(true);
  });

  it("returns false for gemma31 (not a gemma3 prefix token)", () => {
    expect(isVisionCapableModel("gemma31")).toBe(false);
  });
});

describe("fetchOllamaCapabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends POST to /api/show with { name: model }", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: ["completion", "vision"] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchOllamaCapabilities("http://localhost:11434", "gemma4:latest");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/show");
    expect(JSON.parse(init.body as string)).toEqual({ name: "gemma4:latest" });
  });

  it("returns capabilities array from response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["completion", "vision", "tools"] })),
    );

    const caps = await fetchOllamaCapabilities("http://localhost:11434", "gemma4:latest");
    expect(caps).toEqual(["completion", "vision", "tools"]);
  });

  it("returns empty array when response has no capabilities field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ modelfile: "...", parameters: "" })),
    );

    const caps = await fetchOllamaCapabilities("http://localhost:11434", "somemodel");
    expect(caps).toEqual([]);
  });

  it("filters out non-string items in capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["vision", 42, "audio", null, true] })),
    );

    const caps = await fetchOllamaCapabilities("http://localhost:11434", "m");
    expect(caps).toEqual(["vision", "audio"]);
  });

  it("throws on 404 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    await expect(fetchOllamaCapabilities("http://localhost:11434", "x")).rejects.toThrow(
      "Ollama show failed: 404",
    );
  });

  it("throws on 500 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("server error", { status: 500 })),
    );

    await expect(fetchOllamaCapabilities("http://localhost:11434", "x")).rejects.toThrow(
      "Ollama show failed: 500",
    );
  });

  it("strips trailing slash from baseUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      makeJsonResponse({ capabilities: [] }),
    );
    vi.stubGlobal("fetch", mockFetch);

    await fetchOllamaCapabilities("http://localhost:11434/", "m");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:11434/api/show");
  });
});

describe("getOllamaBackend — capabilities integration", () => {
  beforeEach(() => {
    setTauriStoreValue("ollamaBaseUrl", "http://localhost:11434");
    setTauriStoreValue("ollamaModel", "gemma4:latest");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });

  it("sets supportsVision=true when /api/show returns vision capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["completion", "vision"] })),
    );

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    expect(backend.supportsVision).toBe(true);
  });

  it("sets supportsVision=false when /api/show returns no vision capability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["completion", "tools"] })),
    );

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    expect(backend.supportsVision).toBe(false);
  });

  it("falls back to heuristic when fetch throws", async () => {
    setTauriStoreValue("ollamaModel", "gemma3:4b");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    // gemma3:4b is vision-capable per heuristic
    expect(backend.supportsVision).toBe(true);
  });

  it("falls back to heuristic when /api/show returns empty capabilities", async () => {
    setTauriStoreValue("ollamaModel", "gemma3:4b");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: [] })),
    );

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    expect(backend.supportsVision).toBe(true);
  });

  it("heuristic fallback returns false for non-vision model when fetch fails", async () => {
    setTauriStoreValue("ollamaModel", "gemma2:9b");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    expect(backend.supportsVision).toBe(false);
  });
});

describe("generateImage — no redundant /api/show after backend is initialised", () => {
  beforeEach(() => {
    setTauriStoreValue("ollamaBaseUrl", "http://localhost:11434");
    setTauriStoreValue("ollamaModel", "gemma4:latest");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });

  it("getOllamaBackend triggers exactly 1 /api/show call; generateImage adds 0 more", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/show")) {
        return Promise.resolve(makeJsonResponse({ capabilities: ["completion", "vision"] }));
      }
      return Promise.resolve(makeJsonResponse({ choices: [{ message: { content: "translated" } }] }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();

    // After backend init, supportsVision must be true (gemma4 has vision capability)
    expect(backend.supportsVision).toBe(true);

    const showCallsAfterInit = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.endsWith("/api/show"),
    );
    expect(showCallsAfterInit).toHaveLength(1);

    // generateImage must not make any additional /api/show probe
    await backend.generateImage("describe", "base64data");

    const showCallsAfterImage = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.endsWith("/api/show"),
    );
    expect(showCallsAfterImage).toHaveLength(1); // still only the initial one

    // The image call must have gone to chat/completions
    const completionsCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
      url.endsWith("/v1/chat/completions"),
    );
    expect(completionsCalls).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 api/show + 1 chat/completions
  });

  it("supportsVision=true is preserved even if /api/show would transiently fail on a second probe", async () => {
    let showCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/show")) {
        showCallCount++;
        if (showCallCount === 1) {
          return Promise.resolve(makeJsonResponse({ capabilities: ["completion", "vision"] }));
        }
        // Any hypothetical second probe would fail — but generateImage must not call it
        return Promise.reject(new Error("transient network failure"));
      }
      return Promise.resolve(makeJsonResponse({ choices: [{ message: { content: "ok" } }] }));
    });
    vi.stubGlobal("fetch", mockFetch);

    const { getOllamaBackend } = await import("../src/ollamaClient");
    const backend = await getOllamaBackend();
    expect(backend.supportsVision).toBe(true);

    // Should succeed — no second /api/show probe attempted
    const result = await backend.generateImage("prompt", "imgdata");
    expect(result).toBe("ok");
    expect(showCallCount).toBe(1);
  });
});

describe("getOllamaBackend — immutable connection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTauriStoreValue("ollamaBaseUrl", BASE_URL);
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });

  function connectionFetch() {
    return vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (url.endsWith("/api/show")) {
        return Promise.resolve(makeJsonResponse({ capabilities: ["completion", "vision"] }));
      }
      if (JSON.parse(init.body as string).stream) {
        return Promise.resolve(new Response(makeSseStream(['data: {"choices":[{"delta":{"content":"streamed"}}]}\n\n']), { status: 200 }));
      }
      return Promise.resolve(makeJsonResponse({ choices: [{ message: { content: "result" } }] }));
    });
  }

  it("uses one model and endpoint for capability discovery and all generation after settings change", async () => {
    setTauriStoreValue("ollamaBaseUrl", "http://original.invalid:11434/");
    setTauriStoreValue("ollamaModel", "original-vision-model");
    const mockFetch = connectionFetch();
    vi.stubGlobal("fetch", mockFetch);
    const backend = await getOllamaBackend();
    setTauriStoreValue("ollamaBaseUrl", "http://replacement.invalid:11434");
    setTauriStoreValue("ollamaModel", "gemma2:9b");
    expect(backend.supportsVision).toBe(true);
    expect(await backend.generateText("text")).toBe("result");
    const onChunk = vi.fn();
    expect(await backend.generateTextStream("stream", onChunk)).toBe("streamed");
    expect(onChunk).toHaveBeenCalledWith("streamed");
    expect(await backend.generateImage("image", "png")).toBe("result");
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][0]).toBe("http://original.invalid:11434/api/show");
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string)).toEqual({ name: "original-vision-model" });
    for (const [url, init] of mockFetch.mock.calls.slice(1)) {
      expect(url).toBe("http://original.invalid:11434/v1/chat/completions");
      expect(JSON.parse(init.body as string).model).toBe("original-vision-model");
    }

    await generateText("current settings");
    expect(mockFetch.mock.calls[4][0]).toBe("http://replacement.invalid:11434/v1/chat/completions");
    expect(JSON.parse(mockFetch.mock.calls[4][1].body as string).model).toBe("gemma2:9b");
  });

  it("copies caller config before an asynchronous capability response completes", async () => {
    const config = { baseUrl: "http://original.invalid:11434/", model: "original-model" };
    let finishShow: (response: Response) => void = () => {};
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith("/api/show")) return new Promise<Response>(resolve => { finishShow = resolve; });
      return Promise.resolve(makeJsonResponse({ choices: [{ message: { content: "result" } }] }));
    });
    vi.stubGlobal("fetch", mockFetch);
    const pending = getOllamaBackend(config);
    config.baseUrl = "http://mutated.invalid:11434";
    config.model = "mutated-model";
    finishShow(makeJsonResponse({ capabilities: ["completion", "vision"] }));
    const backend = await pending;
    await backend.generateImage("image", "png");
    expect(backend.supportsVision).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toBe("http://original.invalid:11434/api/show");
    expect(mockFetch.mock.calls[1][0]).toBe("http://original.invalid:11434/v1/chat/completions");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body as string).model).toBe("original-model");
  });

  it("retries generation on the same connection after the caller and settings change", async () => {
    const config = { baseUrl: "http://original.invalid:11434", model: "original-model" };
    const mockFetch = vi.fn().mockResolvedValueOnce(makeJsonResponse({ capabilities: ["vision"] }))
      .mockImplementationOnce(() => {
        config.baseUrl = "http://mutated.invalid:11434";
        config.model = "mutated-model";
        setTauriStoreValue("ollamaBaseUrl", "http://replacement.invalid:11434");
        setTauriStoreValue("ollamaModel", "replacement-model");
        return Promise.reject(new Error("temporary transport reset"));
      }).mockResolvedValueOnce(makeJsonResponse({ choices: [{ message: { content: "retried" } }] }));
    vi.stubGlobal("fetch", mockFetch);
    const backend = await getOllamaBackend(config);
    expect(await backend.generateText("retry")).toBe("retried");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of mockFetch.mock.calls.slice(1)) {
      expect(url).toBe("http://original.invalid:11434/v1/chat/completions");
      expect(JSON.parse(init.body as string).model).toBe("original-model");
    }
  });
});

describe("Ollama capability deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTauriStore();
    resetBackendCache();
    setTauriStoreValue("llmBackendId", "ollama");
    setTauriStoreValue("ollamaBaseUrl", BASE_URL);
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });
  afterEach(() => {
    resetBackendCache();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setTauriStoreValue("ollamaBaseUrl", BASE_URL);
    setTauriStoreValue("ollamaModel", "gemma3:4b");
  });

  it("releases simultaneous callers from a stalled shared probe and allows the next connection to recover", async () => {
    const mockFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", mockFetch);
    const first = getActiveBackend();
    const second = getActiveBackend();
    let completed = false;
    const results = Promise.all([first, second]).then(backends => { completed = true; return backends; });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const [a, b] = await results;
    expect(a).toBe(b);
    expect(a.supportsVision).toBe(true); // existing gemma3 heuristic fallback
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    setTauriStoreValue("ollamaModel", "recovered-vision-model");
    setTauriStoreValue("ollamaBaseUrl", "http://localhost:11500");
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ capabilities: ["completion", "vision"] }));
    const recovered = await getActiveBackend();
    expect(recovered).not.toBe(a);
    expect(recovered.supportsVision).toBe(true); // returned capabilities, not name heuristic
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe("http://localhost:11500/api/show");
    expect(JSON.parse(mockFetch.mock.calls[1][1].body as string)).toEqual({ name: "recovered-vision-model" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active after headers until the response body finishes", async () => {
    let signal: AbortSignal | undefined;
    const json = vi.fn(() => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new DOMException("Body aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return Promise.resolve({ ok: true, json } as unknown as Response);
    }));
    const pending = fetchOllamaCapabilities(BASE_URL, "gemma3:4b");
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(json).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline once capabilities are decoded successfully", async () => {
    const mockFetch = vi.fn().mockResolvedValue(makeJsonResponse({ capabilities: ["vision"] }));
    vi.stubGlobal("fetch", mockFetch);
    expect(await fetchOllamaCapabilities(BASE_URL, "model")).toEqual(["vision"]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect((mockFetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(false);
  });
});
