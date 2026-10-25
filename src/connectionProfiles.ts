import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getStoreRid } from "./store";
import {
  getProvider,
  type ProviderAuthKind,
  type ProviderProtocol,
  type ProviderRuntimeConfig,
} from "./providerRegistry";
import type { LlmBackend } from "./llmBackend";
import type { BackendId } from "./types";

export interface ConnectionProfile {
  readonly id: string;
  readonly providerId: BackendId;
  readonly protocol: ProviderProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly auth: Readonly<{ kind: ProviderAuthKind }>;
  readonly credentialRef: string | null;
}

/** Safe to inspect/serialize: credentials exist only in this module's private WeakMap. */
export interface RuntimeSnapshot {
  readonly profile: ConnectionProfile;
}

const runtimeConfigs = new WeakMap<RuntimeSnapshot, ProviderRuntimeConfig>();
const { invoke } = window.__TAURI__.core;

function invalidSetting(): never {
  throw new Error("AI 연결 설정 형식이 올바르지 않습니다. 설정을 확인한 뒤 다시 저장해주세요.");
}

function setting(entries: Map<string, unknown>, key: string, fallback: string): string {
  if (!entries.has(key)) return fallback;
  const value = entries.get(key);
  if (typeof value !== "string") return invalidSetting();
  return value;
}

export function normalizeOllamaBaseUrl(value: string): string {
  const raw = value.trim();
  const authority = /^https?:\/\/([^/?#]*)/i.exec(raw)?.[1];
  if (!authority || authority.includes("@") || raw.includes("?") || raw.includes("#") || raw.includes("\\")) {
    throw new Error("Ollama URL은 사용자 정보, 쿼리, 프래그먼트가 없는 http 또는 https 주소여야 합니다.");
  }
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error();
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new Error("Ollama 서버 URL이 올바르지 않습니다. http 또는 https 주소를 확인해주세요.");
  }
}

/** Project existing settings without writing a competing persistent profile record. */
export async function readActiveConnection(): Promise<RuntimeSnapshot> {
  let captured: unknown;
  try {
    const rid = await getStoreRid();
    captured = await invoke<unknown>("plugin:store|entries", { rid });
  } catch {
    throw new Error("AI 연결 설정을 읽을 수 없습니다. 설정을 확인한 뒤 다시 시도해주세요.");
  }
  if (!Array.isArray(captured)) return invalidSetting();
  const entries = new Map<string, unknown>();
  for (const entry of captured) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entries.has(entry[0])) {
      return invalidSetting();
    }
    entries.set(entry[0], entry[1]);
  }

  const provider = getProvider(setting(entries, SETTINGS_KEYS.llmBackendId, DEFAULTS.llmBackendId));
  const modelKey = provider.id === "gemini-native" ? SETTINGS_KEYS.model
    : provider.id === "openai" ? SETTINGS_KEYS.openaiModel : SETTINGS_KEYS.ollamaModel;
  const model = setting(entries, modelKey, provider.defaultModel).trim();
  if (!model) return invalidSetting();
  const baseUrl = provider.id === "ollama"
    ? normalizeOllamaBaseUrl(setting(entries, SETTINGS_KEYS.ollamaBaseUrl, provider.baseUrl))
    : provider.baseUrl;
  const credential = provider.id === "gemini-native"
    ? setting(entries, SETTINGS_KEYS.apiKey, DEFAULTS.apiKey)
    : provider.id === "openai" ? setting(entries, SETTINGS_KEYS.openaiApiKey, DEFAULTS.openaiApiKey) : "";

  const profile: ConnectionProfile = Object.freeze({
    id: `legacy:${provider.id}`,
    providerId: provider.id,
    protocol: provider.protocol,
    baseUrl,
    model,
    auth: Object.freeze({ kind: provider.authKind }),
    credentialRef: provider.credentialRef,
  });
  const snapshot = Object.freeze({ profile });
  runtimeConfigs.set(snapshot, Object.freeze({ baseUrl, model, credential }));
  return snapshot;
}

function runtimeConfig(snapshot: RuntimeSnapshot): ProviderRuntimeConfig {
  const config = runtimeConfigs.get(snapshot);
  if (!config) throw new Error("유효하지 않은 AI 연결 스냅샷입니다.");
  return config;
}

export function runtimeConnectionsEqual(left: RuntimeSnapshot, right: RuntimeSnapshot): boolean {
  const a = runtimeConfig(left);
  const b = runtimeConfig(right);
  return left.profile.providerId === right.profile.providerId
    && a.baseUrl === b.baseUrl && a.model === b.model && a.credential === b.credential;
}

export function createBackendForConnection(snapshot: RuntimeSnapshot): Promise<LlmBackend> {
  return getProvider(snapshot.profile.providerId).createBackend(runtimeConfig(snapshot));
}
