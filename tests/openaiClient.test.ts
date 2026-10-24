import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setTauriStoreValue,
  registerInvokeCommand,
  resetInvokeCommands,
  MockChannel,
} from "./helpers/tauriMock";

// Provide store state so openaiClient reads the correct config
setTauriStoreValue("openaiApiKey", "sk-test-key");
setTauriStoreValue("openaiModel", "gpt-4o-mini");

import {
  generateText,
  generateTextStream,
  generateImage,
  isVisionCapableModel,
  getOpenAiBackend,
} from "../src/openaiClient";

// ─── generateText (invoke transport) ─────────────────────────────────────────

describe("openaiClient.generateText", () => {
  beforeEach(() => {
    setTauriStoreValue("openaiApiKey", "sk-test-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");
  });
  afterEach(() => {
    resetInvokeCommands();
  });

  it("invokes openai_generate_text with apiKey/model/prompt and returns result", async () => {
    let received: Record<string, unknown> | undefined;
    registerInvokeCommand("openai_generate_text", (args) => {
      received = args;
      return "hello";
    });

    const result = await generateText("translate this");

    expect(received).toEqual({
      apiKey: "sk-test-key",
      model: "gpt-4o-mini",
      prompt: "translate this",
    });
    expect(result).toBe("hello");
  });

  it("throws when openaiApiKey is empty and does NOT invoke the command", async () => {
    setTauriStoreValue("openaiApiKey", "");
    let invoked = false;
    registerInvokeCommand("openai_generate_text", () => {
      invoked = true;
      return "should not happen";
    });

    await expect(generateText("prompt")).rejects.toThrow(
      "OpenAI API 키가 설정되지 않았습니다.",
    );
    expect(invoked).toBe(false);
  });
});

// ─── generateImage (invoke transport) ────────────────────────────────────────

describe("openaiClient.generateImage", () => {
  beforeEach(() => {
    setTauriStoreValue("openaiApiKey", "sk-test-key");
    setTauriStoreValue("openaiModel", "gpt-4o");
  });
  afterEach(() => {
    resetInvokeCommands();
  });

  it("invokes openai_generate_image with imageBase64 (camelCase) and passes the result through", async () => {
    let received: Record<string, unknown> | undefined;
    registerInvokeCommand("openai_generate_image", (args) => {
      received = args;
      return "description";
    });

    const result = await generateImage("describe this", "abc123==");

    expect(received).toEqual({
      apiKey: "sk-test-key",
      model: "gpt-4o",
      prompt: "describe this",
      imageBase64: "abc123==",
    });
    expect(result).toBe("description");
  });

  it("throws when openaiApiKey is empty", async () => {
    setTauriStoreValue("openaiApiKey", "");
    await expect(generateImage("describe", "data")).rejects.toThrow(
      "OpenAI API 키가 설정되지 않았습니다.",
    );
  });
});

// ─── generateTextStream (invoke transport + Channel) ─────────────────────────

describe("openaiClient.generateTextStream", () => {
  beforeEach(() => {
    setTauriStoreValue("openaiApiKey", "sk-test-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");
  });
  afterEach(() => {
    resetInvokeCommands();
  });

  it("passes a Channel as onChunk and forwards accumulated messages to the callback", async () => {
    registerInvokeCommand("openai_generate_text_stream", (args) => {
      const channel = args?.onChunk as MockChannel<string>;
      // Simulate Rust streaming incremental accumulated text back through the channel.
      channel.onmessage?.("Hello");
      channel.onmessage?.("Hello World");
      return "Hello World";
    });

    const chunks: string[] = [];
    const result = await generateTextStream("prompt", (chunk) => chunks.push(chunk));

    expect(chunks).toEqual(["Hello", "Hello World"]);
    expect(result).toBe("Hello World");
  });

  it("forwards apiKey/model/prompt alongside the channel", async () => {
    let received: Record<string, unknown> | undefined;
    registerInvokeCommand("openai_generate_text_stream", (args) => {
      received = args;
      return "";
    });

    await generateTextStream("hi", () => {});

    expect(received?.apiKey).toBe("sk-test-key");
    expect(received?.model).toBe("gpt-4o-mini");
    expect(received?.prompt).toBe("hi");
    expect(received?.onChunk).toBeInstanceOf(MockChannel);
  });

  it("throws when openaiApiKey is empty and does NOT invoke the command", async () => {
    setTauriStoreValue("openaiApiKey", "");
    let invoked = false;
    registerInvokeCommand("openai_generate_text_stream", () => {
      invoked = true;
      return "";
    });

    await expect(generateTextStream("p", () => {})).rejects.toThrow(
      "OpenAI API 키가 설정되지 않았습니다.",
    );
    expect(invoked).toBe(false);
  });
});

// ─── isVisionCapableModel (pure, unchanged) ──────────────────────────────────

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

// ─── getOpenAiBackend (unchanged) ────────────────────────────────────────────

describe("getOpenAiBackend", () => {
  afterEach(() => {
    resetInvokeCommands();
  });

  it("returns backend with id='openai' and label='OpenAI (GPT)'", async () => {
    setTauriStoreValue("openaiApiKey", "sk-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");

    const backend = await getOpenAiBackend();
    expect(backend.id).toBe("openai");
    expect(backend.label).toBe("OpenAI (GPT)");
  });

  it("sets supportsVision=true for gpt-4o-mini", async () => {
    setTauriStoreValue("openaiApiKey", "sk-key");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");

    const backend = await getOpenAiBackend();
    expect(backend.supportsVision).toBe(true);
  });

  it("sets supportsVision=false for gpt-3.5-turbo", async () => {
    setTauriStoreValue("openaiApiKey", "sk-key");
    setTauriStoreValue("openaiModel", "gpt-3.5-turbo");

    const backend = await getOpenAiBackend();
    expect(backend.supportsVision).toBe(false);
  });

  it("exposes generateText, generateTextStream, generateImage functions", async () => {
    setTauriStoreValue("openaiApiKey", "sk-key");
    setTauriStoreValue("openaiModel", "gpt-4o");

    const backend = await getOpenAiBackend();
    expect(typeof backend.generateText).toBe("function");
    expect(typeof backend.generateTextStream).toBe("function");
    expect(typeof backend.generateImage).toBe("function");
  });

  it("throws when apiKey is empty", async () => {
    setTauriStoreValue("openaiApiKey", "");
    setTauriStoreValue("openaiModel", "gpt-4o-mini");

    await expect(getOpenAiBackend()).rejects.toThrow(
      "OpenAI API 키가 설정되지 않았습니다.",
    );
  });
});
