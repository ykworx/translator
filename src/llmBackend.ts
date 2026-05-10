import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getSetting } from "./store";

export interface LlmBackend {
  readonly id: "gemini-native" | "ollama";
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

export async function getActiveBackend(): Promise<LlmBackend> {
  const backendId = await getSetting<"gemini-native" | "ollama">(
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
    return backend;
  }

  cachedOllamaBackend = null;
  const { geminiNativeBackend } = await import("./geminiClient");
  return geminiNativeBackend;
}
