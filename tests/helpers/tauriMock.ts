/**
 * Minimal window.__TAURI__ stub for unit tests.
 * Only mocks the parts used by store.ts and llmProfile.ts.
 */

const store: Map<string, unknown> = new Map();

export function resetTauriStore() {
  store.clear();
}

export function setTauriStoreValue(key: string, value: unknown) {
  store.set(key, value);
}

export function getTauriStoreValue(key: string): unknown {
  return store.get(key);
}

const mockInvoke = async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "plugin:store|load") {
    return 1; // fake rid
  }
  if (cmd === "plugin:store|get") {
    const key = args?.key as string;
    const value = store.get(key);
    return value !== undefined ? [value, true] : [null, false];
  }
  if (cmd === "plugin:store|set") {
    const key = args?.key as string;
    const value = args?.value;
    store.set(key, value);
    return undefined;
  }
  throw new Error(`Unknown invoke command: ${cmd}`);
};

export function installTauriMock() {
  // In jsdom, `window` === `globalThis`. We need to set __TAURI__ before
  // any source module that does `const { invoke } = window.__TAURI__.core` is imported.
  const tauri = {
    core: { invoke: mockInvoke },
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
