import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getSetting } from "./store";

interface GeminiTextPart {
  text: string;
}

interface GeminiInlineDataPart {
  inline_data: {
    mime_type: string;
    data: string;
  };
}

type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

function buildGeminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

async function getGeminiConfig(): Promise<{ apiKey: string; model: string }> {
  const apiKey = await getSetting(SETTINGS_KEYS.apiKey, DEFAULTS.apiKey);
  const model = await getSetting(SETTINGS_KEYS.model, DEFAULTS.model);

  if (!apiKey) {
    throw new Error("API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.");
  }

  return { apiKey, model };
}

async function extractResponseText(resp: Response): Promise<string> {
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function generateContent(parts: GeminiPart[]): Promise<string> {
  const { apiKey, model } = await getGeminiConfig();
  const resp = await fetch(buildGeminiUrl(model, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
    }),
  });

  return extractResponseText(resp);
}

export async function generateText(prompt: string): Promise<string> {
  return generateContent([{ text: prompt }]);
}

export async function generateImage(prompt: string, imageBase64: string): Promise<string> {
  return generateContent([
    { text: prompt },
    {
      inline_data: {
        mime_type: "image/png",
        data: imageBase64,
      },
    },
  ]);
}
