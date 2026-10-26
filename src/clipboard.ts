// ─── Clipboard via invoke ───────────────────────────
const { invoke } = window.__TAURI__.core;
let composing = false;
let guardsActive = false;
let guardGeneration = 0;

export function initClipboardCopyGuards(): () => void {
  const generation = ++guardGeneration;
  guardsActive = true;
  composing = false;
  const start = () => { composing = true; };
  const end = () => { composing = false; };
  document.addEventListener("compositionstart", start, true);
  document.addEventListener("compositionend", end, true);
  return () => {
    document.removeEventListener("compositionstart", start, true);
    document.removeEventListener("compositionend", end, true);
    if (generation === guardGeneration) { guardsActive = false; composing = false; }
  };
}

export async function readText(): Promise<string> {
  return await invoke("plugin:clipboard-manager|read_text");
}

export async function writeTextToClipboard(text: string): Promise<void> {
  await invoke("plugin:clipboard-manager|write_text", { text });
}

export async function writeHtmlToClipboard(html: string): Promise<void> {
  await invoke("write_clipboard_html", { html });
}

/** Explicit UI-copy fallback; only execCommand's true result counts as success. */
export async function writeWithTextFallback(write: () => Promise<void>, text: string): Promise<void> {
  const generation = guardGeneration;
  try { await write(); return; } catch (error) {
    // A later native failure must never blur a newly started IME composition,
    // or run a second clipboard write after this page has been disposed.
    if (!guardsActive || composing || generation !== guardGeneration) throw error;
    const focused = document.activeElement;
    const input = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
    const start = input?.selectionStart;
    const end = input?.selectionEnd;
    const direction = input?.selectionDirection;
    const selection = window.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.style.cssText = "position:fixed;left:-10000px;top:0";
    document.body.appendChild(temporary);
    try {
      temporary.focus({ preventScroll: true });
      temporary.select();
      if (typeof document.execCommand !== "function" || !document.execCommand("copy")) throw error;
    } finally {
      const restoreFocus = document.activeElement === temporary;
      temporary.remove();
      if (restoreFocus && focused instanceof HTMLElement && focused.isConnected) {
        try {
          focused.focus({ preventScroll: true });
          if (input && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined);
          else if (selection) {
            selection.removeAllRanges();
            for (const range of ranges) if (range.commonAncestorContainer.isConnected) selection.addRange(range);
          }
        } catch { /* clipboard success is independent of focus restoration */ }
      }
    }
  }
}
