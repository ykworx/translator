import { DEFAULTS } from "../../src/constants";

/**
 * Minimal window.__TAURI__ stub for unit tests.
 * Only mocks the parts used by store.ts and llmProfile.ts.
 */

const store: Map<string, unknown> = new Map();

export function resetTauriStore() {
  store.clear();
  nativeCredentials.clear();
  runtimeIds.clear();
  credentialIds.clear();
}

export function setTauriStoreValue(key: string, value: unknown) {
  store.set(key, value);
}

export function getTauriStoreValue(key: string): unknown {
  return store.get(key);
}

// Native connection/Keychain emulator. Secret fixtures stay inside this test
// helper; production frontend code never reads legacy key fields.
let nativeSequence = 0;
const nativeCredentials = new Map<string, { value: string | null; revision: string | null }>();
const credentialIds = new Map<string, string>();
const runtimeIds = new Map<string, string>();

export function setNativeCredential(providerId: string, value: string | null): void {
  nativeCredentials.set(providerId, { value, revision: value ? `credential-${++nativeSequence}` : null });
}

function credentialFor(providerId: string) {
  const managed = nativeCredentials.get(providerId);
  if (managed) return managed;
  const raw = store.get(providerId === "openai" ? "openaiApiKey" : "apiKey");
  if (raw !== undefined && typeof raw !== "string") throw new Error("AI 연결 설정 형식 오류");
  if (!raw) return { value: null, revision: null };
  const identity = providerId + "\0" + raw;
  if (!credentialIds.has(identity)) credentialIds.set(identity, `credential-${++nativeSequence}`);
  return { value: raw, revision: credentialIds.get(identity)! };
}

function captureConnection() {
  const providerId = store.has("llmBackendId") ? store.get("llmBackendId") : DEFAULTS.llmBackendId;
  if (!["gemini-native", "openai", "ollama"].includes(providerId as string)) throw new Error("지원하지 않는 AI 공급자");
  const provider = providerId as "gemini-native" | "openai" | "ollama";
  const modelKey = provider === "ollama" ? "ollamaModel" : provider === "openai" ? "openaiModel" : "model";
  const model = store.has(modelKey) ? store.get(modelKey)
    : provider === "ollama" ? DEFAULTS.ollamaModel : provider === "openai" ? DEFAULTS.openaiModel : DEFAULTS.model;
  if (typeof model !== "string" || !model.trim()) throw new Error("AI 연결 설정 형식 오류");
  let baseUrl = provider === "ollama" ? (store.has("ollamaBaseUrl") ? store.get("ollamaBaseUrl") : DEFAULTS.ollamaBaseUrl)
    : provider === "openai" ? "https://api.openai.com/v1" : "https://generativelanguage.googleapis.com/v1beta";
  if (typeof baseUrl !== "string") throw new Error("AI 연결 설정 형식 오류");
  if (provider === "ollama") {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("잘못된 Ollama URL");
    baseUrl = url.toString().replace(/\/+$/, "");
  }
  const credential = provider === "ollama" ? { value: null, revision: null } : credentialFor(provider);
  if (provider !== "ollama" && !credential.value) throw new Error(`${provider === "openai" ? "OpenAI " : ""}API 키가 설정되지 않았습니다.`);
  const identity = JSON.stringify([provider, baseUrl, model.trim(), credential.revision]);
  if (!runtimeIds.has(identity)) runtimeIds.set(identity, `runtime-${++nativeSequence}`);
  return { profile: {
    id: `native:${provider}`, providerId: provider,
    protocol: provider === "gemini-native" ? "gemini-native" : "openai-compatible",
    baseUrl, model: model.trim(), auth: { kind: provider === "ollama" ? "none" : "api-key" },
    credentialRef: provider === "ollama" ? null : `keychain:${provider}`,
  }, runtimeId: runtimeIds.get(identity)! };
}

/** Minimal stand-in for Tauri's `Channel` (used by streaming commands). */
export class MockChannel<T = unknown> {
  onmessage: ((message: T) => void) | null = null;
  id = 0;
}

// Registry for custom (non-store) invoke command handlers used in tests.
const commandHandlers = new Map<string, (args?: Record<string, unknown>) => unknown>();

export function registerInvokeCommand(
  cmd: string,
  fn: (args?: Record<string, unknown>) => unknown,
) {
  commandHandlers.set(cmd, fn);
}

export function resetInvokeCommands() {
  commandHandlers.clear();
}

const mockInvoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (["settings_get", "settings_set", "settings_delete"].includes(cmd) && ["apiKey", "openaiApiKey"].includes(args?.key as string)) throw new Error("인증값은 보안 인증 명령으로만 관리할 수 있습니다.");
  if (cmd === "settings_entries") {
    if (commandHandlers.has(cmd)) return commandHandlers.get(cmd)!(args);
    throw new Error("Settings enumeration is not exposed to the frontend");
  }
  if (cmd === "settings_load") {
    return 1; // fake rid
  }
  if (cmd === "settings_get") {
    const key = args?.key as string;
    const value = store.get(key);
    return value !== undefined ? [value, true] : [null, false];
  }
  if (cmd === "settings_set") {
    const key = args?.key as string;
    const value = args?.value;
    store.set(key, value);
    return undefined;
  }
  if (commandHandlers.has(cmd)) {
    return commandHandlers.get(cmd)!(args);
  }
  if (cmd === "capture_connection") return captureConnection();
  if (cmd === "supports_global_dictation") return true;
  if (cmd === "get_credential_status") {
    const value = credentialFor(args?.providerId as string);
    return { configured: !!value.value, revision: value.revision };
  }
  if (cmd === "save_provider_credential" || cmd === "delete_provider_credential") {
    const providerId = args?.providerId as string;
    if (credentialFor(providerId).revision !== args?.expectedRevision) throw new Error("다른 창에서 API 키가 변경되었습니다. 키 상태를 다시 확인해주세요.");
    setNativeCredential(providerId, cmd === "delete_provider_credential" ? null : args?.apiKey as string);
    store.delete(providerId === "openai" ? "openaiApiKey" : "apiKey");
    const value = credentialFor(providerId);
    return { configured: !!value.value, revision: value.revision };
  }
  throw new Error(`Unknown invoke command: ${cmd}`);
};

export function installTauriMock() {
  // In jsdom, `window` === `globalThis`. We need to set __TAURI__ before
  // any source module that does `const { invoke } = window.__TAURI__.core` is imported.
  const tauri = {
    core: { invoke: mockInvoke, Channel: MockChannel },
    window: { getCurrentWindow: () => ({ close: () => {} }) },
    event: { listen: () => Promise.resolve(() => {}) },
  };
  // Both `window` and `globalThis` point to the same object in jsdom
  (globalThis as unknown as Record<string, unknown>).__TAURI__ = tauri;
  // Also set on `window` explicitly for code that uses `window.__TAURI__`
  if (typeof window !== "undefined") {
    (window as unknown as Record<string, unknown>).__TAURI__ = tauri;
  }
}
