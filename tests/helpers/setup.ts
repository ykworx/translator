/**
 * Vitest global setup — runs before any test file.
 * Installs window.__TAURI__ stub so store.ts can be imported.
 */
import { installTauriMock } from "./tauriMock";
import { afterEach, beforeEach, vi } from "vitest";

installTauriMock();

// A client test must explicitly provide its network fixture. Never let a
// missing stub reach the user's localhost daemon or an external provider.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unit-test network access is disabled; provide a fetch fixture."); }));
});
afterEach(() => vi.unstubAllGlobals());
