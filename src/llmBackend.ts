import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getSetting } from "./store";
import type { BackendId } from "./types";

export interface LlmBackend {
  readonly id: BackendId;
  readonly label: string;
  readonly supportsVision: boolean;
  generateText(prompt: string): Promise<string>;
  generateTextStream(prompt: string, onChunk: (accumulated: string) => void): Promise<string>;
  generateImage(prompt: string, base64Png: string): Promise<string>;
}

// Strips trailing slash for stable cache key comparison (mirrors ollamaClient.normalizeBaseUrl)
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

// Cache keyed by normalized baseUrl+model so either change triggers a new capabilities fetch
let cachedOllamaBackend: { key: string; backend: LlmBackend } | null = null;

/** @internal test-only — production code should not call this */
export function resetOllamaBackendCache(): void {
  cachedOllamaBackend = null;
}

// Cache keyed by openai model string
let cachedOpenAiBackend: { key: string; backend: LlmBackend } | null = null;

/** @internal test-only — production code should not call this */
export function resetOpenAiBackendCache(): void {
  cachedOpenAiBackend = null;
}

export async function getActiveBackend(): Promise<LlmBackend> {
  const backendId = await getSetting<BackendId>(
    SETTINGS_KEYS.llmBackendId,
    DEFAULTS.llmBackendId,
  );

  if (backendId === "ollama") {
    const baseUrl = await getSetting<string>(SETTINGS_KEYS.ollamaBaseUrl, DEFAULTS.ollamaBaseUrl);
    const model = await getSetting<string>(SETTINGS_KEYS.ollamaModel, DEFAULTS.ollamaModel);
    const key = `${normalizeBaseUrl(baseUrl)}|${model}`;
    if (cachedOllamaBackend?.key === key) return cachedOllamaBackend.backend;
    const { getOllamaBackend } = await import("./ollamaClient");
    const backend = await getOllamaBackend();
    cachedOllamaBackend = { key, backend };
    // Clear other backend caches when switching to ollama
    cachedOpenAiBackend = null;
    return backend;
  }

  if (backendId === "openai") {
    const model = await getSetting<string>(SETTINGS_KEYS.openaiModel, DEFAULTS.openaiModel);
    const key = model;
    if (cachedOpenAiBackend?.key === key) return cachedOpenAiBackend.backend;
    const { getOpenAiBackend } = await import("./openaiClient");
    const backend = await getOpenAiBackend();
    cachedOpenAiBackend = { key, backend };
    // Clear other backend caches when switching to openai
    cachedOllamaBackend = null;
    return backend;
  }

  // Gemini fallback — clear both non-gemini caches
  cachedOllamaBackend = null;
  cachedOpenAiBackend = null;
  const { geminiNativeBackend } = await import("./geminiClient");
  return geminiNativeBackend;
}
