import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setTauriStoreValue } from "./helpers/tauriMock";

setTauriStoreValue("apiKey", "test-api-key");
setTauriStoreValue("model", "gemini-2.0-flash");

import { createGeminiBackend, generateText, generateImage, generateTextStream } from "../src/geminiClient";

// geminiClient uses setTimeout for rate-limit spacing and retries.
// We must use fake timers + runAllTimersAsync in every test that touches it.

beforeEach(() => {
  setTauriStoreValue("apiKey", "test-api-key");
  setTauriStoreValue("model", "gemini-2.0-flash");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function makeGeminiResponse(text: string, status = 200): Response {
  const body = {
    candidates: [{ content: { parts: [{ text }] } }],
  };
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

describe("geminiClient.generateText", () => {
  it("calls Gemini generateContent endpoint with text part", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(makeGeminiResponse("translated"));
    vi.stubGlobal("fetch", mockFetch);

    const promise = generateText("hello");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("translated");
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("test-api-key");

    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts[0]).toEqual({ text: "hello" });
  });

  it("includes Bearer header is not sent — uses query key", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(makeGeminiResponse("hi"));
    vi.stubGlobal("fetch", mockFetch);

    const promise = generateText("prompt");
    await vi.runAllTimersAsync();
    await promise;

    const [url] = mockFetch.mock.calls[0] as [string];
    // Gemini uses key in URL, not Bearer header
    expect(url).toContain("key=test-api-key");
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(makeGeminiResponse("ok"));
    vi.stubGlobal("fetch", mockFetch);

    const promise = generateText("retry test");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });

  it("throws after exhausting retries on 503", async () => {
    vi.useFakeTimers();
    // Return a fresh Response each call (bodies can only be read once)
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("service unavailable", { status: 503 })),
    );
    vi.stubGlobal("fetch", mockFetch);

    // Attach rejection handler immediately to avoid unhandled rejection warning
    const promise = generateText("fail");
    promise.catch(() => {}); // suppress unhandled rejection

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow("Gemini API error: 503");
  });

  it("respects Retry-After header", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response("too many requests", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(makeGeminiResponse("after retry"));
    vi.stubGlobal("fetch", mockFetch);

    const promise = generateText("prompt");
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("after retry");
  });
});

describe("geminiClient.generateTextStream", () => {
  it("parses Gemini SSE format and accumulates text", async () => {
    vi.useFakeTimers();
    const sseEvents = [
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "こんにちは" }] } }] })}\n\n`,
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "世界" }] } }] })}\n\n`,
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(makeSseStream(sseEvents), { status: 200 }),
      ),
    );

    const chunks: string[] = [];
    const promise = generateTextStream("translate", chunk => chunks.push(chunk));
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(chunks).toEqual(["こんにちは", "こんにちは世界"]);
    expect(result).toBe("こんにちは世界");
  });
});

describe("geminiClient.generateImage", () => {
  it("sends inline_data with base64 image", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(makeGeminiResponse("description"));
    vi.stubGlobal("fetch", mockFetch);

    const promise = generateImage("describe", "base64data==");
    await vi.runAllTimersAsync();
    await promise;

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const parts = body.contents[0].parts;

    expect(parts[0]).toEqual({ text: "describe" });
    expect(parts[1]).toEqual({
      inline_data: { mime_type: "image/png", data: "base64data==" },
    });
  });
});

describe("createGeminiBackend — immutable connection", () => {
  it("uses the original model and key for text, stream and image after settings change", async () => {
    vi.useFakeTimers();
    const backend = createGeminiBackend({ apiKey: "old-key", model: "gemini-original" });
    setTauriStoreValue("apiKey", "new-key");
    setTauriStoreValue("model", "gemini-replacement");
    const mockFetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
      url.includes(":streamGenerateContent")
        ? new Response(makeSseStream(['data: {"candidates":[{"content":{"parts":[{"text":"streamed"}]}}]}\n\n']), { status: 200 })
        : makeGeminiResponse("result"),
    ));
    vi.stubGlobal("fetch", mockFetch);

    const text = backend.generateText("text");
    await vi.runAllTimersAsync();
    expect(await text).toBe("result");
    const onChunk = vi.fn();
    const stream = backend.generateTextStream("stream", onChunk);
    await vi.runAllTimersAsync();
    expect(await stream).toBe("streamed");
    expect(onChunk).toHaveBeenCalledWith("streamed");
    const image = backend.generateImage("image", "png");
    await vi.runAllTimersAsync();
    expect(await image).toBe("result");
    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [url] of mockFetch.mock.calls) {
      expect(url).toContain("/models/gemini-original:");
      expect(url).toContain("key=old-key");
    }

    // The legacy direct exports still resolve current settings per operation.
    const direct = generateText("current settings");
    await vi.runAllTimersAsync();
    await direct;
    expect(mockFetch.mock.calls[3][0]).toContain("/models/gemini-replacement:");
    expect(mockFetch.mock.calls[3][0]).toContain("key=new-key");
  });

  it("copies the supplied config before the caller mutates it", async () => {
    vi.useFakeTimers();
    const config = { apiKey: "original-key", model: "original-model" };
    const backend = createGeminiBackend(config);
    config.apiKey = "changed-key";
    config.model = "changed-model";
    const mockFetch = vi.fn().mockResolvedValue(makeGeminiResponse("ok"));
    vi.stubGlobal("fetch", mockFetch);
    const result = backend.generateText("hello");
    await vi.runAllTimersAsync();
    await result;
    expect(mockFetch.mock.calls[0][0]).toContain("/models/original-model:generateContent?key=original-key");
  });

  it("creates an unconfigured backend but rejects generation with the existing missing-key error", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const backend = createGeminiBackend({ apiKey: "", model: "gemini-original" });
    expect(backend.id).toBe("gemini-native");
    await expect(backend.generateText("text")).rejects.toThrow("API 키가 설정되지 않았습니다.");
    await expect(backend.generateTextStream("stream", () => {})).rejects.toThrow("API 키가 설정되지 않았습니다.");
    await expect(backend.generateImage("image", "png")).rejects.toThrow("API 키가 설정되지 않았습니다.");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("keeps a retry on the original connection when config and settings change during backoff", async () => {
    vi.useFakeTimers();
    const config = { apiKey: "original-key", model: "original-model" };
    const backend = createGeminiBackend(config);
    const mockFetch = vi.fn().mockImplementationOnce(() => {
      config.apiKey = "changed-key";
      config.model = "changed-model";
      setTauriStoreValue("apiKey", "replacement-key");
      setTauriStoreValue("model", "replacement-model");
      return Promise.resolve(new Response("retry", { status: 429 }));
    }).mockResolvedValueOnce(makeGeminiResponse("retried"));
    vi.stubGlobal("fetch", mockFetch);
    const result = backend.generateText("retry");
    await vi.runAllTimersAsync();
    expect(await result).toBe("retried");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe(mockFetch.mock.calls[1][0]);
    expect(mockFetch.mock.calls[1][0]).toContain("/models/original-model:generateContent?key=original-key");
  });
});
