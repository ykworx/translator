import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText, generateTextStream, generateImage, getOpenAiBackend, isVisionCapableModel } from "../src/openaiClient";
import { MockChannel, registerInvokeCommand, resetInvokeCommands, resetTauriStore, setTauriStoreValue } from "./helpers/tauriMock";

beforeEach(() => { resetInvokeCommands(); resetTauriStore(); setTauriStoreValue("llmBackendId", "openai"); setTauriStoreValue("openaiApiKey", "fake-private-key"); setTauriStoreValue("openaiModel", "gpt-4o-mini"); });
afterEach(() => { resetInvokeCommands(); vi.unstubAllGlobals(); });

describe("isVisionCapableModel", () => {
  it("returns true for gpt-4o", () => {
    expect(isVisionCapableModel("gpt-4o")).toBe(true);
  });

  it("returns true for gpt-4o-mini", () => {
    expect(isVisionCapableModel("gpt-4o-mini")).toBe(true);
  });

  it("returns true for gpt-4.1", () => {
    expect(isVisionCapableModel("gpt-4.1")).toBe(true);
  });

  it("returns true for gpt-4.1-mini", () => {
    expect(isVisionCapableModel("gpt-4.1-mini")).toBe(true);
  });

  it("returns true for o1 family", () => {
    expect(isVisionCapableModel("o1")).toBe(true);
    expect(isVisionCapableModel("o1-mini")).toBe(true);
    expect(isVisionCapableModel("o1-preview")).toBe(true);
  });

  it("returns true for o3 family", () => {
    expect(isVisionCapableModel("o3")).toBe(true);
    expect(isVisionCapableModel("o3-mini")).toBe(true);
  });

  it("returns true for o4 family", () => {
    expect(isVisionCapableModel("o4-mini")).toBe(true);
  });

  it("returns true for gpt-4-turbo", () => {
    expect(isVisionCapableModel("gpt-4-turbo")).toBe(true);
    expect(isVisionCapableModel("gpt-4-turbo-preview")).toBe(true);
  });

  it("returns true for chatgpt-4o family", () => {
    expect(isVisionCapableModel("chatgpt-4o-latest")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isVisionCapableModel("")).toBe(false);
  });

  it("returns false for gpt-3.5-turbo (no vision)", () => {
    expect(isVisionCapableModel("gpt-3.5-turbo")).toBe(false);
  });

  it("returns false for base gpt-4 (non-turbo)", () => {
    expect(isVisionCapableModel("gpt-4")).toBe(false);
    expect(isVisionCapableModel("gpt-4-0314")).toBe(false);
  });
});


describe("OpenAI native runtime transport", () => {
  it("sends runtimeId and prompt without API key, model or frontend HTTP", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const received = vi.fn(() => "translated"); registerInvokeCommand("openai_generate_text", received);
    expect(await generateText("text")).toBe("translated");
    expect(received).toHaveBeenCalledWith({ runtimeId: expect.any(String), prompt: "text" });
    expect(JSON.stringify(received.mock.calls)).not.toContain("fake-private-key");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards native stream channels and image bytes", async () => {
    registerInvokeCommand("openai_generate_text_stream", args => {
      expect(args).toEqual({ runtimeId: expect.any(String), prompt: "stream", onChunk: expect.any(MockChannel) });
      const channel = args?.onChunk as MockChannel<string>;
      channel.onmessage?.("Hello"); channel.onmessage?.("Hello World"); return "Hello World";
    });
    const received = vi.fn(() => "image result"); registerInvokeCommand("openai_generate_image", received);
    const chunks: string[] = [];
    expect(await generateTextStream("stream", chunk => chunks.push(chunk))).toBe("Hello World");
    expect(chunks).toEqual(["Hello", "Hello World"]);
    expect(await generateImage("image", "png")).toBe("image result");
    expect(received).toHaveBeenCalledWith({ runtimeId: expect.any(String), prompt: "image", imageBase64: "png" });
  });

  it("uses the same captured runtime for capabilities and all generation after key rotation", async () => {
    const backend = await getOpenAiBackend();
    setTauriStoreValue("openaiApiKey", "replacement-key"); setTauriStoreValue("openaiModel", "gpt-3.5-turbo");
    const calls: Record<string, unknown>[] = [];
    for (const command of ["openai_generate_text", "openai_generate_text_stream", "openai_generate_image"]) registerInvokeCommand(command, args => { calls.push(args!); return "result"; });
    await backend.generateText("text"); await backend.generateTextStream("stream", () => {}); await backend.generateImage("image", "png");
    expect(backend.supportsVision).toBe(true); expect(calls).toHaveLength(3);
    expect(new Set(calls.map(args => args.runtimeId)).size).toBe(1);
    for (const args of calls) { expect(args).not.toHaveProperty("apiKey"); expect(args).not.toHaveProperty("model"); }
    await generateText("current"); expect(calls[3].runtimeId).not.toBe(calls[0].runtimeId);
  });

  it("copies an explicit runtime before caller mutation", async () => {
    const config = { runtimeId: "original-runtime", model: "gpt-4o-mini" };
    const pending = getOpenAiBackend(config); config.runtimeId = "changed"; config.model = "gpt-3.5-turbo";
    const backend = await pending;
    const received = vi.fn(() => "ok"); registerInvokeCommand("openai_generate_text", received);
    await backend.generateText("text");
    expect(backend.supportsVision).toBe(true); expect(received).toHaveBeenCalledWith({ runtimeId: "original-runtime", prompt: "text" });
  });

  it("does not borrow another provider or silently recover from locked credentials", async () => {
    registerInvokeCommand("capture_connection", () => { throw new Error("Keychain 잠김"); });
    await expect(getOpenAiBackend()).rejects.toThrow("Keychain 잠김");
    const received = vi.fn(); registerInvokeCommand("openai_generate_text", received);
    await expect(generateText("text")).rejects.toThrow("Keychain 잠김"); expect(received).not.toHaveBeenCalled();
  });

  it("rejects a missing native runtime and retains non-vision model behavior", async () => {
    await expect(getOpenAiBackend({ runtimeId: "", model: "gpt-4o-mini" })).rejects.toThrow("유효하지");
    expect((await getOpenAiBackend({ runtimeId: "known-runtime", model: "gpt-3.5-turbo" })).supportsVision).toBe(false);
  });
});
