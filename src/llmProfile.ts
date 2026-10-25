import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getStoreRid, setSetting } from "./store";
import { getProvider } from "./providerRegistry";
import type { BackendId } from "./types";
import { getCredentialStatus } from "./connectionProfiles";

const { invoke } = window.__TAURI__.core;

export class InvalidBackendSettingError extends Error {}

async function savedBackendId(): Promise<string | null> {
  const rid = await getStoreRid();
  const [value, exists] = await invoke<[unknown, boolean]>("settings_get", { rid, key: SETTINGS_KEYS.llmBackendId });
  if (!exists) return null;
  if (typeof value !== "string") throw new InvalidBackendSettingError("AI 공급자 설정 형식이 올바르지 않습니다.");
  return value;
}

export async function getActiveBackendId(): Promise<BackendId> {
  const id = await savedBackendId() ?? DEFAULTS.llmBackendId;
  try { return getProvider(id).id; }
  catch { throw new InvalidBackendSettingError("지원하지 않는 AI 공급자입니다."); }
}

export async function setActiveBackendId(id: BackendId): Promise<void> {
  getProvider(id);
  return setSetting(SETTINGS_KEYS.llmBackendId, id);
}

export async function migrateLegacySettings(): Promise<void> {
  try {
    if (await savedBackendId() !== null) return;
    const status = await getCredentialStatus("gemini-native");
    if (status.configured && await savedBackendId() === null) await setSetting(SETTINGS_KEYS.llmBackendId, "gemini-native");
  } catch {
    // Migration is advisory. Keep selection intact; connection/status commands
    // surface native credential errors without blocking local or voice setup.
  }
}

export interface OllamaDetectResult {
  available: boolean;
  models: string[];
  error: string | null;
}

export async function detectOllama(baseUrl: string): Promise<OllamaDetectResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return { available: false, models: [], error: `Ollama 서버 응답 오류: ${resp.status}` };
    }
    const data = await resp.json();
    if (!data.models || !Array.isArray(data.models)) {
      return { available: false, models: [], error: "Ollama 응답 형식 오류" };
    }
    const models: string[] = data.models
      .map((m: { name?: string } | string) =>
        typeof m === "string" ? m : (m.name ?? ""),
      )
      .filter(Boolean);
    return { available: true, models, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
    if (msg.includes("failed to fetch") || msg.includes("networkerror") || msg.includes("network error")) {
      return {
        available: false,
        models: [],
        error: "Ollama 서버에 연결할 수 없습니다. ollama serve가 실행 중인지 확인하세요.",
      };
    }
    if (msg.includes("timeout") || msg.includes("aborted") || msg.includes("timed out")) {
      return {
        available: false,
        models: [],
        error: "Ollama 서버 응답 시간이 초과되었습니다.",
      };
    }
    if (msg.includes("connection refused") || msg.includes("econnrefused")) {
      return {
        available: false,
        models: [],
        error: "Ollama 서버 연결이 거부되었습니다. 포트와 URL을 확인하세요.",
      };
    }
    return { available: false, models: [], error: `Ollama 감지 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}
