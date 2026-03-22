import { generateImage, generateText, generateTextStream } from "./geminiClient";
import {
  type AutoLangPair,
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
  return generateText(prompt);
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
  return generateTextStream(prompt, onChunk);
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
  const raw = await generateImage(buildTranslateImagePrompt(targetLang, autoLangPair), base64Png);
  return parseImageTranslationResult(raw);
}

export async function summarize(original: string, translated: string): Promise<string> {
  return callGemini(buildSummarizePrompt(original, translated));
}

export async function koreanPronunciation(text: string): Promise<string> {
  return callGemini(buildKoreanPronunciationPrompt(text));
}
