// Fixed-path non-secret settings bridge; credentials use native commands.
const { invoke } = window.__TAURI__.core;

let storeRid: number | null = null;
let storeRidPromise: Promise<number> | null = null;

export async function getStoreRid(): Promise<number> {
  if (storeRid !== null) {
    return storeRid;
  }

  if (!storeRidPromise) {
    storeRidPromise = invoke<number>("settings_load").then((rid) => {
      storeRid = rid;
      return rid;
    }).finally(() => {
      storeRidPromise = null;
    });
  }

  return storeRidPromise;
}

export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const rid = await getStoreRid();
    const [value, exists] = await invoke<[T, boolean]>("settings_get", { rid, key });
    return exists ? value : defaultValue;
  } catch (e) {
    console.error("getSetting error:", e);
    return defaultValue;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const rid = await getStoreRid();
  await invoke("settings_set", { rid, key, value });
}
