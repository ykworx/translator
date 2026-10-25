import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getSetting } from "./store";
import type { LlmBackend } from "./llmBackend";

export type OllamaConfig = Readonly<{ baseUrl: string; model: string }>;

// Fallback heuristic for offline / failed /api/show responses.
// Primary detection uses Ollama capabilities API.
export function isVisionCapableModel(modelName: string): boolean {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();

  // Exact prefix matches for compound model families
  if (lower === "gemma3" || lower.startsWith("gemma3:") || lower.startsWith("gemma3-")) return true;
  if (lower.startsWith("qwen2-vl") || lower.startsWith("qwen2.5-vl")) return true;
  if (lower.startsWith("minicpm-v")) return true;

  // Head-token matching: only match llava/bakllava/moondream at the start of the model
  // name (or after a namespace "/"). This prevents false positives like "not-llava-related".
  const VISION_HEAD_TOKENS = ["llava", "bakllava", "moondream"];
  const afterNamespace = lower.includes("/") ? lower.split("/").pop()! : lower;
  const firstToken = afterNamespace.split(/[:\-\s_.]/)[0];
  if (VISION_HEAD_TOKENS.includes(firstToken)) return true;

  return false;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

async function getOllamaConfig(): Promise<{ baseUrl: string; model: string }> {
  const baseUrl = await getSetting(SETTINGS_KEYS.ollamaBaseUrl, DEFAULTS.ollamaBaseUrl);
  const model = await getSetting(SETTINGS_KEYS.ollamaModel, DEFAULTS.ollamaModel);
  return { baseUrl: normalizeBaseUrl(baseUrl), model };
}

export async function fetchOllamaCapabilities(
  baseUrl: string,
  model: string,
): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/api/show`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama show failed: ${resp.status}`);
  }
  const data = await resp.json();
  if (!Array.isArray(data?.capabilities)) {
    return [];
  }
  return data.capabilities.filter((c: unknown): c is string => typeof c === "string");
}

async function fetchOllama(url: string, init: RequestInit): Promise<Response> {
  try {
    const resp = await fetch(url, init);
    return resp;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("ECONNREFUSED") ||
      msg.includes("Failed to fetch") ||
      msg.includes("NetworkError") ||
      msg.includes("connection refused")
    ) {
      throw new Error("Ollama 서버가 실행 중인지 확인하세요 (http://localhost:11434)");
    }
    throw err;
  }
}

async function fetchOllamaWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchOllama(url, init);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Ollama 서버가 실행 중인지")) throw err;
    // One retry for transient network errors only
    return fetchOllama(url, init);
  }
}

export async function generateText(prompt: string): Promise<string> {
  return generateTextWithConfig(await getOllamaConfig(), prompt);
}

async function generateTextWithConfig({ baseUrl, model }: OllamaConfig, prompt: string): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;

  const resp = await fetchOllamaWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer ollama",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ollama API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function generateTextStream(
  prompt: string,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  return generateTextStreamWithConfig(await getOllamaConfig(), prompt, onChunk);
}

async function generateTextStreamWithConfig(
  { baseUrl, model }: OllamaConfig,
  prompt: string,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  const url = `${baseUrl}/v1/chat/completions`;

  const resp = await fetchOllamaWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer ollama",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ollama API error: ${resp.status} ${errText}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      try {
        const data = JSON.parse(jsonStr);
        const delta = data.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          accumulated += delta;
          onChunk(accumulated);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return accumulated.trim();
}

export async function generateImage(prompt: string, base64Png: string): Promise<string> {
  return generateImageWithConfig(await getOllamaConfig(), prompt, base64Png);
}

async function generateImageWithConfig({ baseUrl, model }: OllamaConfig, prompt: string, base64Png: string): Promise<string> {
  // Vision capability guard is handled by api.ts (backend.supportsVision check).
  // No redundant /api/show probe here — backend instance is the single source of truth.

  const url = `${baseUrl}/v1/chat/completions`;

  const resp = await fetchOllamaWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer ollama",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: `data:image/png;base64,${base64Png}` },
          ],
        },
      ],
      stream: false,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ollama API error: ${resp.status} ${errText}`);
  }

  const data = await resp.json();
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

export async function getOllamaBackend(config?: OllamaConfig): Promise<LlmBackend> {
  const resolved = config
    ? { baseUrl: normalizeBaseUrl(config.baseUrl), model: config.model }
    : await getOllamaConfig();
  const snapshot = Object.freeze({ baseUrl: resolved.baseUrl, model: resolved.model });
  const { baseUrl, model } = snapshot;

  let supportsVision = false;
  try {
    const caps = await fetchOllamaCapabilities(baseUrl, model);
    if (caps.length > 0) {
      supportsVision = caps.includes("vision");
    } else {
      supportsVision = isVisionCapableModel(model);
    }
  } catch {
    supportsVision = isVisionCapableModel(model);
  }

  return {
    id: "ollama",
    label: "Ollama (로컬)",
    supportsVision,
    generateText: prompt => generateTextWithConfig(snapshot, prompt),
    generateTextStream: (prompt, onChunk) => generateTextStreamWithConfig(snapshot, prompt, onChunk),
    generateImage: (prompt, base64Png) => generateImageWithConfig(snapshot, prompt, base64Png),
  };
}
