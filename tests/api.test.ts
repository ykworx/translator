import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetTauriStore } from "./helpers/tauriMock";

// vi.mock is hoisted — factory must not reference external variables
vi.mock("../src/llmBackend", () => ({
  getActiveBackend: vi.fn(),
}));

import { getActiveBackend } from "../src/llmBackend";
import type { LlmBackend } from "../src/llmBackend";
import { callGemini, translate, translateStream, translateImage, recognizeHandwriting, translateTable, suggestReplies, summarize, koreanPronunciation } from "../src/api";

function makeMockBackend(supportsVision = true): LlmBackend {
  return {
    id: "gemini-native",
    label: "Mock",
    supportsVision,
    generateText: vi.fn().mockResolvedValue("mock text result"),
    generateTextStream: vi.fn().mockImplementation(async (_prompt: string, onChunk: (s: string) => void) => {
      onChunk("mock stream");
      return "mock stream";
    }),
    generateImage: vi.fn().mockResolvedValue("mock image result"),
  };
}

describe("api.ts dispatch", () => {
  let mockBackend: LlmBackend;

  beforeEach(() => {
    resetTauriStore();
    mockBackend = makeMockBackend();
    vi.mocked(getActiveBackend).mockResolvedValue(mockBackend);
  });

  it("callGemini calls backend.generateText", async () => {
    const result = await callGemini("test prompt");
    expect(mockBackend.generateText).toHaveBeenCalledWith("test prompt");
    expect(result).toBe("mock text result");
  });

  it("translate calls backend.generateText via callGemini", async () => {
    await translate("hello", "日本語");
    expect(mockBackend.generateText).toHaveBeenCalledOnce();
    const [prompt] = vi.mocked(mockBackend.generateText).mock.calls[0];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("translateStream calls backend.generateTextStream", async () => {
    const chunks: string[] = [];
    await translateStream("hello", "日本語", c => chunks.push(c));
    expect(mockBackend.generateTextStream).toHaveBeenCalledOnce();
    expect(chunks).toEqual(["mock stream"]);
  });

  it("translateImage calls backend.generateImage when supportsVision is true", async () => {
    await translateImage("base64data", "日本語");
    expect(mockBackend.generateImage).toHaveBeenCalledOnce();
    const [prompt, image] = vi.mocked(mockBackend.generateImage).mock.calls[0];
    expect(typeof prompt).toBe("string");
    expect(image).toBe("base64data");
  });

  it("translateImage throws when supportsVision is false", async () => {
    vi.mocked(getActiveBackend).mockResolvedValue(makeMockBackend(false));
    await expect(translateImage("base64data", "日本語")).rejects.toThrow(
      "현재 백엔드가 이미지 인식을 지원하지 않습니다",
    );
  });

  it("recognizeHandwriting calls backend.generateImage", async () => {
    await recognizeHandwriting("base64data");
    expect(mockBackend.generateImage).toHaveBeenCalledOnce();
  });

  it("recognizeHandwriting throws when supportsVision is false", async () => {
    vi.mocked(getActiveBackend).mockResolvedValue(makeMockBackend(false));
    await expect(recognizeHandwriting("base64data")).rejects.toThrow(
      "현재 백엔드가 이미지 인식을 지원하지 않습니다",
    );
  });

  it("translateTable calls backend.generateText via callGemini", async () => {
    await translateTable("<table><tr><td>text</td></tr></table>", "한국어");
    expect(mockBackend.generateText).toHaveBeenCalledOnce();
    const [prompt] = vi.mocked(mockBackend.generateText).mock.calls[0];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("suggestReplies calls backend.generateText via callGemini", async () => {
    await suggestReplies("original", "translated");
    expect(mockBackend.generateText).toHaveBeenCalledOnce();
  });

  it("summarize calls backend.generateText via callGemini", async () => {
    await summarize("original", "translated");
    expect(mockBackend.generateText).toHaveBeenCalledOnce();
  });

  it("koreanPronunciation calls backend.generateText via callGemini", async () => {
    await koreanPronunciation("안녕하세요");
    expect(mockBackend.generateText).toHaveBeenCalledOnce();
    const [prompt] = vi.mocked(mockBackend.generateText).mock.calls[0];
    expect(typeof prompt).toBe("string");
  });
});
