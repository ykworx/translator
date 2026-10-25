import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getStoreRid, setSetting } from "./store";
import { getProvider } from "./providerRegistry";
import type { BackendId } from "./types";
import { getCredentialStatus, normalizeOllamaBaseUrl } from "./connectionProfiles";

const { invoke } = window.__TAURI__.core;

async function savedBackendId(): Promise<string | null> {
  const rid = await getStoreRid();
  const [value, exists] = await invoke<[unknown, boolean]>("settings_get", { rid, key: SETTINGS_KEYS.llmBackendId });
  if (!exists) return null;
  if (typeof value !== "string") throw new Error("AI 공급자 설정 형식이 올바르지 않습니다.");
  return value;
}

export async function getActiveBackendId(): Promise<BackendId> {
  return getProvider(await savedBackendId() ?? DEFAULTS.llmBackendId).id;
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
  let normalized: string;
  try {
    normalized = normalizeOllamaBaseUrl(baseUrl);
  } catch {
    return { available: false, models: [], error: "Ollama URL은 사용자 정보·쿼리·프래그먼트가 없는 올바른 http 또는 https 주소를 입력해주세요." };
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${normalized}/api/tags`, { signal: controller.signal });
    if (!resp.ok) {
      return { available: false, models: [], error: `Ollama 서버 응답 오류: HTTP ${resp.status}` };
    }
    const data: unknown = await resp.json();
    if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) {
      return { available: false, models: [], error: "Ollama 모델 목록 응답 형식이 올바르지 않습니다." };
    }
    const models = [...new Set((data as { models: unknown[] }).models.flatMap(entry => {
      const name = typeof entry === "string" ? entry
        : entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
          ? (entry as { name: string }).name : "";
      return name.trim() ? [name.trim()] : [];
    }))];
    return { available: true, models, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (controller.signal.aborted || message.includes("timeout") || message.includes("timed out") || message.includes("aborted")) {
      return { available: false, models: [], error: "Ollama 모델 목록 조회 시간이 초과되었습니다. 서버 상태를 확인한 뒤 다시 조회해주세요." };
    }
    if (error instanceof SyntaxError || (error && typeof error === "object" && (error as { name?: string }).name === "SyntaxError")) {
      return { available: false, models: [], error: "Ollama 모델 목록의 JSON 응답 형식이 올바르지 않습니다." };
    }
    if (message.includes("connection refused") || message.includes("econnrefused")) {
      return { available: false, models: [], error: "Ollama 서버 연결이 거부되었습니다. 포트와 URL을 확인하세요." };
    }
    if (message.includes("failed to fetch") || message.includes("networkerror") || message.includes("network error")) {
      return { available: false, models: [], error: "Ollama 서버에 연결할 수 없습니다. ollama serve 실행 상태와 URL을 확인하세요." };
    }
    return { available: false, models: [], error: "Ollama 모델 목록 조회에 실패했습니다. 서버 상태와 주소를 확인해주세요." };
  } finally {
    window.clearTimeout(timeout);
  }
}
