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

/** Safe to inspect/serialize. Native runtime handles are kept in a private WeakMap. */
export interface RuntimeSnapshot {
  readonly profile: ConnectionProfile;
}

const runtimeConfigs = new WeakMap<RuntimeSnapshot, ProviderRuntimeConfig>();
const { invoke } = window.__TAURI__.core;

function invalidSetting(): never {
  throw new Error("AI 연결 설정 형식이 올바르지 않습니다. 설정을 확인한 뒤 다시 저장해주세요.");
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

/** Capture provider, endpoint, model and credential revision together in Rust. */
export async function readActiveConnection(): Promise<RuntimeSnapshot> {
  const captured: unknown = await invoke("capture_connection");
  if (!captured || typeof captured !== "object") return invalidSetting();
  const raw = captured as Record<string, unknown>;
  if (!raw.profile || typeof raw.profile !== "object" || typeof raw.runtimeId !== "string" || !raw.runtimeId) return invalidSetting();
  const profileValue = raw.profile as Record<string, unknown>;
  if (typeof profileValue.providerId !== "string") return invalidSetting();
  const provider = getProvider(profileValue.providerId);
  if (typeof profileValue.id !== "string" || !profileValue.id
      || typeof profileValue.baseUrl !== "string" || !profileValue.baseUrl
      || typeof profileValue.model !== "string" || !profileValue.model
      || profileValue.protocol !== provider.protocol
      || !profileValue.auth || typeof profileValue.auth !== "object"
      || (profileValue.auth as Record<string, unknown>).kind !== provider.authKind
      || !(profileValue.credentialRef === null || typeof profileValue.credentialRef === "string")) return invalidSetting();
  const baseUrl = provider.id === "ollama" ? normalizeOllamaBaseUrl(profileValue.baseUrl) : profileValue.baseUrl;
  if (provider.id !== "ollama" && baseUrl !== provider.baseUrl) return invalidSetting();
  const profile: ConnectionProfile = Object.freeze({
    id: profileValue.id, providerId: provider.id, protocol: provider.protocol,
    baseUrl, model: profileValue.model, auth: Object.freeze({ kind: provider.authKind }),
    credentialRef: profileValue.credentialRef,
  });
  const snapshot = Object.freeze({ profile });
  runtimeConfigs.set(snapshot, Object.freeze({ baseUrl, model: profile.model, runtimeId: raw.runtimeId }));
  return snapshot;
}

export async function readRuntimeForProvider(providerId: BackendId): Promise<ProviderRuntimeConfig> {
  const snapshot = await readActiveConnection();
  if (snapshot.profile.providerId !== providerId) {
    throw new Error("선택한 AI 공급자가 변경되었습니다. 설정에서 연결을 확인해주세요.");
  }
  return runtimeConfig(snapshot);
}

export type CredentialStatus = Readonly<{ configured: boolean; revision: string | null; error?: string }>;
export type CloudProviderId = "gemini-native" | "openai";

function credentialStatus(raw: unknown): CredentialStatus {
  if (!raw || typeof raw !== "object") return invalidSetting();
  const value = raw as Record<string, unknown>;
  if (typeof value.configured !== "boolean" || !(value.revision === null || typeof value.revision === "string")) return invalidSetting();
  if (value.error !== undefined && typeof value.error !== "string") return invalidSetting();
  return Object.freeze({ configured: value.configured, revision: value.revision, ...(value.error === undefined ? {} : { error: value.error }) });
}

export async function getCredentialStatus(providerId: CloudProviderId): Promise<CredentialStatus> {
  return credentialStatus(await invoke("get_credential_status", { providerId }));
}

export async function saveProviderCredential(providerId: CloudProviderId, apiKey: string, expectedRevision: string | null): Promise<CredentialStatus> {
  return credentialStatus(await invoke("save_provider_credential", { providerId, apiKey, expectedRevision }));
}

export async function deleteProviderCredential(providerId: CloudProviderId, expectedRevision: string | null): Promise<CredentialStatus> {
  return credentialStatus(await invoke("delete_provider_credential", { providerId, expectedRevision }));
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
    && a.baseUrl === b.baseUrl && a.model === b.model && a.runtimeId === b.runtimeId;
}

export function createBackendForConnection(snapshot: RuntimeSnapshot): Promise<LlmBackend> {
  return getProvider(snapshot.profile.providerId).createBackend(runtimeConfig(snapshot));
}
