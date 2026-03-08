// ─── Gemini API ─────────────────────────────────────
import { getSetting } from "./store";

export interface Suggestion {
  kr: string;
  jp: string;
}

export async function callGemini(prompt: string): Promise<string> {
  const apiKey = await getSetting("apiKey", "");
  const model = await getSetting("model", "gemini-2.0-flash");
  if (!apiKey) {
    throw new Error("API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

export async function translate(text: string, targetLang: string): Promise<string> {
  const prompt =
    `Translate the following text to ${targetLang}.\n` +
    `Output ONLY the translation, no explanations.\n\n` +
    text;
  return callGemini(prompt);
}

export async function translateTable(tableHtml: string, targetLang: string): Promise<string> {
  const prompt =
    `Translate ALL text in the following HTML table to ${targetLang}.\n` +
    `IMPORTANT RULES:\n` +
    `- Translate ALL text to ${targetLang}, including technical terms\n` +
    `- Keep ALL HTML tags and attributes (rowspan, colspan, etc.) EXACTLY as-is\n` +
    `- Do NOT translate: product IDs, version numbers, URLs, English words\n` +
    `- Do NOT add, remove, or modify any HTML tags\n` +
    `- Output ONLY the translated HTML table, nothing else\n\n` +
    tableHtml;
  let result = await callGemini(prompt);
  if (result.startsWith("```")) {
    const lines = result.split("\n");
    if (lines[lines.length - 1].trim() === "```") {
      result = lines.slice(1, -1).join("\n").trim();
    } else {
      result = lines.slice(1).join("\n").trim();
    }
  }
  return result;
}

export async function suggestReplies(original: string, translated: string): Promise<Suggestion[]> {
  const prompt =
    "You are a helpful assistant for a Korean professional working in a Japanese company.\n" +
    "Based on the following message, suggest 3 short reply options.\n" +
    "For each reply, provide both Korean and Japanese versions.\n" +
    "Format: KR: ... | JP: ...\n\n" +
    "Japanese reply style: polite business Japanese, concise, Slack-appropriate.\n" +
    "Output ONLY 3 replies, numbered 1. 2. 3.\n\n" +
    `Original: ${original}\nTranslation: ${translated}`;
  const raw = await callGemini(prompt);
  const suggestions: Suggestion[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(/^\d+\.\s*/, "");
    if (cleaned.includes("KR:") && cleaned.includes("JP:")) {
      const parts = cleaned.split("|");
      const kr = (parts[0] || "").replace("KR:", "").trim();
      const jp = (parts[1] || "").replace("JP:", "").trim();
      if (kr && jp) suggestions.push({ kr, jp });
    }
  }
  return suggestions;
}

export async function translateImage(base64Png: string, targetLang: string): Promise<string> {
  const apiKey = await getSetting("apiKey", "");
  const model = await getSetting("model", "gemini-2.0-flash");
  if (!apiKey) {
    throw new Error("API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text:
              `This image contains text. Do the following:\n` +
              `1. Extract ALL text from the image\n` +
              `2. Translate ALL text to ${targetLang}\n\n` +
              `Format your response EXACTLY like this:\n` +
              `[원문]\n(extracted text)\n\n` +
              `[번역]\n(translation)`
          },
          {
            inline_data: {
              mime_type: "image/png",
              data: base64Png,
            },
          },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

export async function koreanPronunciation(text: string): Promise<string> {
  const prompt =
    "Write the Korean pronunciation (reading) of the following text.\n" +
    "Rules:\n" +
    "- Japanese -> Korean phonetic transcription\n" +
    "- English -> Korean phonetic transcription\n" +
    "- Kanji -> Japanese reading in Korean\n" +
    "- Output ONLY the pronunciation, nothing else.\n\n" +
    `Text: ${text}`;
  return callGemini(prompt);
}
