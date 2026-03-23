// ─── Store (settings persistence via invoke) ────────
const { invoke } = window.__TAURI__.core;

let storeRid: number | null = null;

export async function getStoreRid(): Promise<number> {
  if (storeRid === null) {
    storeRid = await invoke("plugin:store|load", {
      path: "settings.json",
      options: { autoSave: true },
    });
  }
  return storeRid!;
}

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const rid = await getStoreRid();
    const [value, exists] = await invoke<[T, boolean]>("plugin:store|get", { rid, key });
    return exists ? value : defaultValue;
  } catch (e) {
    console.error("getSetting error:", e);
    return defaultValue;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const rid = await getStoreRid();
  await invoke("plugin:store|set", { rid, key, value });
}
