import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiBackend, geminiNativeBackend, generateImage, generateText, generateTextStream } from "../src/geminiClient";
import { MockChannel, registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

beforeEach(() => {
  resetTauriStore(); resetInvokeCommands();
  setTauriStoreValue("llmBackendId", "gemini-native");
  setTauriStoreValue("apiKey", "fake-private-gemini-key");
  setTauriStoreValue("model", "gemini-original");
});
afterEach(() => { resetInvokeCommands(); vi.unstubAllGlobals(); });

describe("Gemini native transport", () => {
  it("sends only an opaque runtime and prompt, with no cloud fetch, key or model in IPC", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const received = vi.fn(() => "translated");
    registerInvokeCommand("gemini_generate_text", received);
    expect(await generateText("hello")).toBe("translated");
    expect(received).toHaveBeenCalledWith({ runtimeId: expect.any(String), prompt: "hello" });
    expect(JSON.stringify(received.mock.calls)).not.toContain("fake-private-gemini-key");
    expect(received.mock.calls[0][0]).not.toHaveProperty("model");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards native accumulated text through a Channel", async () => {
    registerInvokeCommand("gemini_generate_text_stream", args => {
      expect(args).toEqual({ runtimeId: expect.any(String), prompt: "stream", onChunk: expect.any(MockChannel) });
      const channel = args?.onChunk as MockChannel<string>;
      channel.onmessage?.("こんにちは"); channel.onmessage?.("こんにちは世界");
      return "こんにちは世界";
    });
    const chunks: string[] = [];
    expect(await generateTextStream("stream", text => chunks.push(text))).toBe("こんにちは世界");
    expect(chunks).toEqual(["こんにちは", "こんにちは世界"]);
  });

  it("sends image bytes with the native runtime instead of HTTP credentials", async () => {
    const received = vi.fn(() => "image result");
    registerInvokeCommand("gemini_generate_image", received);
    expect(await generateImage("describe", "png-data")).toBe("image result");
    expect(received).toHaveBeenCalledWith({ runtimeId: expect.any(String), prompt: "describe", imageBase64: "png-data" });
  });

  it("copies one runtime for every method even after settings and caller config change", async () => {
    const config = { runtimeId: "original-runtime", model: "gemini-original" };
    const backend = createGeminiBackend(config);
    config.runtimeId = "mutated-runtime"; config.model = "mutated-model";
    setTauriStoreValue("apiKey", "replacement-private-key");
    const calls: Record<string, unknown>[] = [];
    for (const command of ["gemini_generate_text", "gemini_generate_text_stream", "gemini_generate_image"]) {
      registerInvokeCommand(command, args => { calls.push(args!); return "result"; });
    }
    await backend.generateText("text"); await backend.generateTextStream("stream", () => {}); await backend.generateImage("image", "png");
    expect(calls).toHaveLength(3);
    for (const args of calls) { expect(args.runtimeId).toBe("original-runtime"); expect(args).not.toHaveProperty("apiKey"); expect(args).not.toHaveProperty("model"); }
    expect(backend.supportsVision).toBe(true);
  });

  it("keeps legacy exports and the default backend on current native captures", async () => {
    const received = vi.fn(() => "result"); registerInvokeCommand("gemini_generate_text", received);
    await geminiNativeBackend.generateText("before");
    setTauriStoreValue("apiKey", "rotated-private-key");
    await generateText("after");
    expect(received.mock.calls[0][0].runtimeId).not.toBe(received.mock.calls[1][0].runtimeId);
  });

  it("does not invoke generation when native credential access fails", async () => {
    registerInvokeCommand("capture_connection", () => { throw new Error("Keychain 잠김"); });
    const received = vi.fn(); registerInvokeCommand("gemini_generate_text", received);
    await expect(generateText("text")).rejects.toThrow("Keychain 잠김");
    expect(received).not.toHaveBeenCalled();
  });

  it("does not use another provider's native runtime for a legacy Gemini call", async () => {
    setTauriStoreValue("llmBackendId", "ollama");
    await expect(generateText("text")).rejects.toThrow("공급자가 변경");
  });
});
