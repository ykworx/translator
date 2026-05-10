/**
 * Vitest global setup — runs before any test file.
 * Installs window.__TAURI__ stub so store.ts can be imported.
 */
import { installTauriMock } from "./tauriMock";

installTauriMock();
