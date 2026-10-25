import { createBackendForConnection, readActiveConnection, runtimeConnectionsEqual,
  type RuntimeSnapshot } from "./connectionProfiles";
import type { BackendId } from "./types";

export interface LlmBackend {
  readonly id: BackendId;
  readonly label: string;
  readonly supportsVision: boolean;
  generateText(prompt: string): Promise<string>;
  generateTextStream(prompt: string, onChunk: (accumulated: string) => void): Promise<string>;
  generateImage(prompt: string, base64Png: string): Promise<string>;
}

type CacheEntry = { snapshot: RuntimeSnapshot; backend: Promise<LlmBackend> };
let cached: CacheEntry | null = null;
let pending: CacheEntry[] = [];
let selectionSequence = 0;
let cacheEpoch = 0;

/** @internal Clears instance/in-flight selection caches without persisting settings. */
export function resetBackendCache(): void {
  cached = null;
  pending = [];
  cacheEpoch += 1;
}

/** @internal Preserved for existing callers/tests. */
export function resetOllamaBackendCache(): void {
  if (!cached || cached.snapshot.profile.providerId === "ollama") resetBackendCache();
}

/** @internal Preserved for existing callers/tests. */
export function resetOpenAiBackendCache(): void {
  if (!cached || cached.snapshot.profile.providerId === "openai") resetBackendCache();
}

export async function getActiveBackend(): Promise<LlmBackend> {
  const sequence = ++selectionSequence;
  const epoch = cacheEpoch;
  // One store capture binds provider, endpoint, model, and credential together.
  const snapshot = await readActiveConnection();
  if (epoch === cacheEpoch && cached && runtimeConnectionsEqual(cached.snapshot, snapshot)) {
    return cached.backend;
  }

  let entry = pending.find(candidate => runtimeConnectionsEqual(candidate.snapshot, snapshot));
  if (!entry) {
    entry = { snapshot, backend: createBackendForConnection(snapshot) };
    pending.push(entry);
  }
  // Assign before capabilities complete. Identical reads share that promise;
  // an older completion never writes over a newer selection.
  if (epoch === cacheEpoch && sequence === selectionSequence) cached = entry;
  try {
    return await entry.backend;
  } catch (error) {
    if (cached === entry) cached = null;
    throw error;
  } finally {
    pending = pending.filter(candidate => candidate !== entry);
  }
}
