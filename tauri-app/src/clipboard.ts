// ─── Clipboard via invoke ───────────────────────────
const { invoke } = window.__TAURI__.core;

export async function readText(): Promise<string> {
  return await invoke("plugin:clipboard-manager|read_text");
}

export async function writeTextToClipboard(text: string): Promise<void> {
  await invoke("plugin:clipboard-manager|write_text", { text });
}

export async function writeHtmlToClipboard(html: string): Promise<void> {
  await invoke("write_clipboard_html", { html });
}
