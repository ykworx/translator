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

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1500;
const MIN_REQUEST_INTERVAL_MS = 1200;

let nextRequestStart: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function scheduleRequestStart<T>(task: () => Promise<T>): Promise<T> {
  const startSlot = nextRequestStart.then(async () => {
    const waitMs = Math.max(0, lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastRequestStartedAt = Date.now();
  });

  nextRequestStart = startSlot.catch(() => {});

  return startSlot.then(task);
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const targetTime = Date.parse(headerValue);
  if (Number.isNaN(targetTime)) return null;

  return Math.max(0, targetTime - Date.now());
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let attempt = 0;

  while (true) {
    const resp = await scheduleRequestStart(() => fetch(url, init));
    if (resp.ok) return resp;

    const errText = await resp.text();
    const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
    const shouldRetry = RETRYABLE_STATUS_CODES.has(resp.status) && attempt < MAX_RETRY_ATTEMPTS;

    if (!shouldRetry) {
      throw new Error(`Gemini API error: ${resp.status} ${errText}`);
    }

    const backoffMs = retryAfterMs ?? (BASE_RETRY_DELAY_MS * (2 ** attempt));
    await sleep(Math.min(backoffMs, 15000));
    attempt += 1;
  }
}

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
  const resp = await fetchWithRetry(buildGeminiUrl(model, apiKey), {
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

/**
 * Stream text generation — calls onChunk with each partial text as it arrives.
 * Returns the full completed text.
 */
export async function generateTextStream(
  prompt: string,
  onChunk: (partialText: string) => void,
): Promise<string> {
  const { apiKey, model } = await getGeminiConfig();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";  // keep incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const data = JSON.parse(jsonStr);
        const chunk = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (chunk) {
          fullText += chunk;
          onChunk(fullText);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return fullText.trim();
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
