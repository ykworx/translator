import { getActiveBackend } from "./llmBackend";
import {
  type AutoLangPair,
  type HandwritingMode,
  buildHandwritingRecognitionPrompt,
  buildKoreanPronunciationPrompt,
  buildSuggestRepliesPrompt,
  buildSummarizePrompt,
  buildTranslateImagePrompt,
  buildTranslatePrompt,
  buildTranslateTablePrompt,
} from "./prompts";

export interface Suggestion {
  kr: string;
  jp: string;
}

export interface ImageTranslationResult {
  extractedText: string;
  translatedText: string;
  rawText: string;
}

export async function callGemini(prompt: string): Promise<string> {
  const backend = await getActiveBackend();
  return backend.generateText(prompt);
}

function unwrapCodeFence(text: string): string {
  if (!text.startsWith("```")) {
    return text;
  }

  const lines = text.split("\n");
  if (lines[lines.length - 1].trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }

  return lines.slice(1).join("\n").trim();
}

function parseSuggestions(raw: string): Suggestion[] {
  const suggestions: Suggestion[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const cleaned = trimmed.replace(/^\d+\.\s*/, "");
    if (!cleaned.includes("KR:") || !cleaned.includes("JP:")) continue;

    const parts = cleaned.split("|");
    const kr = (parts[0] || "").replace("KR:", "").trim();
    const jp = (parts[1] || "").replace("JP:", "").trim();
    if (kr && jp) suggestions.push({ kr, jp });
  }

  return suggestions;
}

function parseImageTranslationResult(raw: string): ImageTranslationResult {
  const match = raw.match(/\[원문\]\s*\n([\s\S]*?)\n\n\[번역\]\s*\n([\s\S]*)/);
  if (!match) {
    return {
      extractedText: "",
      translatedText: raw.trim(),
      rawText: raw,
    };
  }

  return {
    extractedText: match[1].trim(),
    translatedText: match[2].trim(),
    rawText: raw,
  };
}

export async function translate(text: string, targetLang: string, autoLangPair?: AutoLangPair, context?: string): Promise<string> {
  if (context) {
    return callGemini(buildTranslatePrompt(text, targetLang, autoLangPair, context));
  }
  return callGemini(buildTranslatePrompt(text, targetLang, autoLangPair));
}

/**
 * Streaming translation — calls onChunk with partial translation as it arrives.
 */
export async function translateStream(
  text: string,
  targetLang: string,
  onChunk: (partialTranslation: string) => void,
  autoLangPair?: AutoLangPair,
  context?: string,
): Promise<string> {
  const prompt = context
    ? buildTranslatePrompt(text, targetLang, autoLangPair, context)
    : buildTranslatePrompt(text, targetLang, autoLangPair);
  const backend = await getActiveBackend();
  return backend.generateTextStream(prompt, onChunk);
}

export async function translateTable(tableHtml: string, targetLang: string, autoLangPair?: AutoLangPair): Promise<string> {
  const result = await callGemini(buildTranslateTablePrompt(tableHtml, targetLang, autoLangPair));
  return unwrapCodeFence(result);
}

export async function suggestReplies(original: string, translated: string): Promise<Suggestion[]> {
  const raw = await callGemini(buildSuggestRepliesPrompt(original, translated));
  return parseSuggestions(raw);
}

export async function translateImage(base64Png: string, targetLang: string, autoLangPair?: AutoLangPair): Promise<ImageTranslationResult> {
  const backend = await getActiveBackend();
  if (!backend.supportsVision) {
    throw new Error(
      "현재 백엔드가 이미지 인식을 지원하지 않습니다. Gemini API로 전환하거나 비전 모델(gemma3 등)을 선택하세요.",
    );
  }
  const raw = await backend.generateImage(buildTranslateImagePrompt(targetLang, autoLangPair), base64Png);
  return parseImageTranslationResult(raw);
}

export async function summarize(original: string, translated: string): Promise<string> {
  return callGemini(buildSummarizePrompt(original, translated));
}

export async function koreanPronunciation(text: string): Promise<string> {
  return callGemini(buildKoreanPronunciationPrompt(text));
}

export interface HandwritingResult {
  character: string;
  onyomi: string;
  onyomiKr: string;
  kunyomi: string;
  kunyomiKr: string;
  meaning: string;
  examples: string[];
}

function normalizeHandwritingResult(raw: unknown, fallbackMeaning: string): HandwritingResult {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid handwriting response");
  }

  const data = raw as Record<string, unknown>;
  return {
    character: typeof data.character === "string" && data.character.trim() ? data.character : "?",
    onyomi: typeof data.onyomi === "string" && data.onyomi.trim() ? data.onyomi : "—",
    onyomiKr: typeof data.onyomiKr === "string" && data.onyomiKr.trim() ? data.onyomiKr : "—",
    kunyomi: typeof data.kunyomi === "string" && data.kunyomi.trim() ? data.kunyomi : "—",
    kunyomiKr: typeof data.kunyomiKr === "string" && data.kunyomiKr.trim() ? data.kunyomiKr : "—",
    meaning: typeof data.meaning === "string" && data.meaning.trim() ? data.meaning : fallbackMeaning,
    examples: Array.isArray(data.examples) ? data.examples.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
  };
}

export async function recognizeHandwriting(base64Png: string, mode: HandwritingMode = "kanji"): Promise<HandwritingResult> {
  const backend = await getActiveBackend();
  if (!backend.supportsVision) {
    throw new Error(
      "현재 백엔드가 이미지 인식을 지원하지 않습니다. Gemini API로 전환하거나 비전 모델(gemma3 등)을 선택하세요.",
    );
  }
  const raw = await backend.generateImage(buildHandwritingRecognitionPrompt(mode), base64Png);
  const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return normalizeHandwritingResult(JSON.parse(cleaned), raw);
  } catch {
    return {
      character: "?",
      onyomi: "—",
      onyomiKr: "—",
      kunyomi: "—",
      kunyomiKr: "—",
      meaning: raw,
      examples: [],
    };
  }
}
