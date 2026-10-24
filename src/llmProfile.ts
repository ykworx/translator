import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getSetting, setSetting } from "./store";
import type { BackendId } from "./types";

export async function getActiveBackendId(): Promise<BackendId> {
  return getSetting<BackendId>(
    SETTINGS_KEYS.llmBackendId,
    DEFAULTS.llmBackendId,
  );
}

export async function setActiveBackendId(id: BackendId): Promise<void> {
  return setSetting(SETTINGS_KEYS.llmBackendId, id);
}

export async function migrateLegacySettings(): Promise<void> {
  const existingBackendId = await getSetting<string | null>(SETTINGS_KEYS.llmBackendId, null);
  if (existingBackendId !== null) return;

  const apiKey = await getSetting<string>(SETTINGS_KEYS.apiKey, "");
  if (apiKey) {
    await setSetting(SETTINGS_KEYS.llmBackendId, "gemini-native");
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
