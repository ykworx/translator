import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import type { LlmBackend } from "./llmBackend";
import type { BackendId } from "./types";

export type ProviderProtocol = "gemini-native" | "openai-compatible";
export type ProviderAuthKind = "api-key" | "none";

/** Ephemeral adapter input. Never persist this object or use it as a string cache key. */
export type ProviderRuntimeConfig = Readonly<{
  baseUrl: string;
  model: string;
  credential: string;
}>;

export interface ProviderDefinition {
  readonly id: BackendId;
  readonly label: string;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly authKind: ProviderAuthKind;
  readonly credentialRef: string | null;
  readonly createBackend: (config: ProviderRuntimeConfig) => Promise<LlmBackend>;
}

/**
 * Provider contract adapted from Hermes Agent's ProviderProfile/ProviderConfig
 * design (NousResearch/hermes-agent b02fa6813, MIT). See THIRD_PARTY_NOTICES.md.
 * Fixed adapters; this registry does not infer providers from model names.
 */
export const PROVIDER_REGISTRY: Readonly<Record<BackendId, ProviderDefinition>> = Object.freeze({
  "gemini-native": Object.freeze({
    id: "gemini-native" as const,
    label: "Gemini API",
    protocol: "gemini-native" as const,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: DEFAULTS.model,
    authKind: "api-key" as const,
    credentialRef: `settings:${SETTINGS_KEYS.apiKey}`,
    createBackend: async (config: ProviderRuntimeConfig) => {
      const { createGeminiBackend } = await import("./geminiClient");
      return createGeminiBackend({ apiKey: config.credential, model: config.model });
    },
  }),
  openai: Object.freeze({
    id: "openai" as const,
    label: "OpenAI (GPT)",
    protocol: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    defaultModel: DEFAULTS.openaiModel,
    authKind: "api-key" as const,
    credentialRef: `settings:${SETTINGS_KEYS.openaiApiKey}`,
    createBackend: async (config: ProviderRuntimeConfig) => {
      const { getOpenAiBackend } = await import("./openaiClient");
      return getOpenAiBackend({ apiKey: config.credential, model: config.model });
    },
  }),
  ollama: Object.freeze({
    id: "ollama" as const,
    label: "Ollama (로컬)",
    protocol: "openai-compatible" as const,
    baseUrl: DEFAULTS.ollamaBaseUrl,
    defaultModel: DEFAULTS.ollamaModel,
    authKind: "none" as const,
    credentialRef: null,
    createBackend: async (config: ProviderRuntimeConfig) => {
      const { getOllamaBackend } = await import("./ollamaClient");
      return getOllamaBackend({ baseUrl: config.baseUrl, model: config.model });
    },
  }),
});

const providers = Object.freeze(Object.values(PROVIDER_REGISTRY));

export function listProviders(): readonly ProviderDefinition[] {
  return providers;
}

export function getProvider(id: string): ProviderDefinition {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, id)) {
    throw new Error("지원하지 않는 AI 공급자입니다. 설정에서 공급자를 다시 선택해주세요.");
  }
  return PROVIDER_REGISTRY[id as BackendId];
}
