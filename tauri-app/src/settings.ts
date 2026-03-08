const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

// ─── Store helpers ──────────────────────────────────
let storeRid: number | null = null;

async function getStoreRid(): Promise<number> {
  if (storeRid === null) {
    storeRid = await invoke("plugin:store|load", {
      path: "settings.json",
      options: { autoSave: true },
    });
  }
  return storeRid!;
}

async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const rid = await getStoreRid();
    const [value, exists] = await invoke<[T, boolean]>("plugin:store|get", { rid, key });
    return exists ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function setSetting<T>(key: string, value: T): Promise<void> {
  const rid = await getStoreRid();
  await invoke("plugin:store|set", { rid, key, value });
}

// ─── DOM ────────────────────────────────────────────
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const myLangSelect = document.getElementById("my-lang") as HTMLSelectElement;
const pairLangSelect = document.getElementById("pair-lang") as HTMLSelectElement;
const modelSelect = document.getElementById("model") as HTMLSelectElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const btnCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const actions = document.getElementById("actions") as HTMLDivElement;
const shortcutSelectBtn = document.getElementById("shortcut-select") as HTMLButtonElement;
const shortcutClipboardBtn = document.getElementById("shortcut-clipboard") as HTMLButtonElement;

// ─── Tabs ───────────────────────────────────────────
const tabItems = document.querySelectorAll<HTMLButtonElement>(".tab-item");
const tabPanes = document.querySelectorAll<HTMLDivElement>(".tab-pane");

tabItems.forEach(item => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab!;
    tabItems.forEach(t => t.classList.remove("active"));
    tabPanes.forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    document.getElementById(`pane-${tab}`)!.classList.add("active");

    // Show actions on all tabs except about
    actions.style.display = tab !== "about" ? "flex" : "none";
  });
});

// ─── Shortcut recording ─────────────────────────────
const DEFAULT_SELECT = "Super+Ctrl+KeyT";
const DEFAULT_CLIPBOARD = "Super+Ctrl+Shift+KeyT";

// Current shortcut values (machine format)
let selectShortcutStr = DEFAULT_SELECT;
let clipboardShortcutStr = DEFAULT_CLIPBOARD;
let recordingBtn: HTMLButtonElement | null = null;

/** Convert machine format "Super+Ctrl+KeyT" to compact display "⌃⌘T" */
function shortcutDisplay(s: string): string {
  return s.split("+").map(part => {
    switch (part) {
      case "Super": case "Cmd": case "Meta": return "⌘";
      case "Ctrl": case "Control": return "⌃";
      case "Shift": return "⇧";
      case "Alt": case "Option": return "⌥";
      default:
        if (part.startsWith("Key")) return part.slice(3);
        if (part.startsWith("Digit")) return part.slice(5);
        if (part === "Backspace") return "⌫";
        if (part === "Delete") return "⌦";
        if (part === "Enter") return "↩";
        if (part === "Tab") return "⇥";
        if (part === "Space") return "␣";
        if (part === "ArrowUp") return "↑";
        if (part === "ArrowDown") return "↓";
        if (part === "ArrowLeft") return "←";
        if (part === "ArrowRight") return "→";
        if (part === "Escape") return "⎋";
        return part;
    }
  }).join("");
}

/** Build machine format string from a KeyboardEvent */
function eventToShortcutStr(e: KeyboardEvent): string | null {
  // Require at least one modifier
  if (!e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) return null;
  // Ignore modifier-only presses
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push("Super");
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(e.code);
  return parts.join("+");
}

async function startRecording(btn: HTMLButtonElement) {
  // Cancel any existing recording
  if (recordingBtn) stopRecording(recordingBtn, false);
  recordingBtn = btn;
  btn.classList.add("recording");
  btn.textContent = "입력 대기...";
  // Suspend global shortcuts so the OS doesn't intercept our key combo
  try { await invoke("suspend_shortcuts"); } catch {}
}

function stopRecording(btn: HTMLButtonElement, captured: boolean) {
  btn.classList.remove("recording");
  if (!captured) {
    // Restore display from current value
    if (btn === shortcutSelectBtn) {
      btn.textContent = shortcutDisplay(selectShortcutStr);
    } else {
      btn.textContent = shortcutDisplay(clipboardShortcutStr);
    }
  }
  recordingBtn = null;
  // Re-register global shortcuts
  invoke("resume_shortcuts").catch(() => {});
}

shortcutSelectBtn.addEventListener("click", () => startRecording(shortcutSelectBtn));
shortcutClipboardBtn.addEventListener("click", () => startRecording(shortcutClipboardBtn));

// Reset buttons
document.getElementById("reset-select")!.addEventListener("click", () => {
  selectShortcutStr = DEFAULT_SELECT;
  shortcutSelectBtn.textContent = shortcutDisplay(DEFAULT_SELECT);
});
document.getElementById("reset-clipboard")!.addEventListener("click", () => {
  clipboardShortcutStr = DEFAULT_CLIPBOARD;
  shortcutClipboardBtn.textContent = shortcutDisplay(DEFAULT_CLIPBOARD);
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (recordingBtn) {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      stopRecording(recordingBtn, false);
      return;
    }

    const str = eventToShortcutStr(e);
    if (!str) return;

    // Capture the shortcut
    if (recordingBtn === shortcutSelectBtn) {
      selectShortcutStr = str;
    } else {
      clipboardShortcutStr = str;
    }
    recordingBtn.textContent = shortcutDisplay(str);
    stopRecording(recordingBtn, true);
    return;
  }

  if (e.key === "Escape") getCurrentWindow().close();
});

// ─── Load settings ──────────────────────────────────
(async () => {
  apiKeyInput.value = await getSetting("apiKey", "");
  myLangSelect.value = await getSetting("myLang", "한국어");
  pairLangSelect.value = await getSetting("pairLang", "日本語");
  modelSelect.value = await getSetting("model", "gemini-2.0-flash");

  selectShortcutStr = await getSetting("selectShortcut", DEFAULT_SELECT);
  clipboardShortcutStr = await getSetting("clipboardShortcut", DEFAULT_CLIPBOARD);
  shortcutSelectBtn.textContent = shortcutDisplay(selectShortcutStr);
  shortcutClipboardBtn.textContent = shortcutDisplay(clipboardShortcutStr);
})();

// ─── Save ───────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  await setSetting("apiKey", apiKeyInput.value.trim());
  await setSetting("myLang", myLangSelect.value);
  await setSetting("pairLang", pairLangSelect.value);
  await setSetting("model", modelSelect.value);
  await setSetting("selectShortcut", selectShortcutStr);
  await setSetting("clipboardShortcut", clipboardShortcutStr);

  // Re-register shortcuts in the backend
  try {
    await invoke("update_shortcuts", {
      selectShortcut: selectShortcutStr,
      clipboardShortcut: clipboardShortcutStr,
    });
  } catch (err) {
    console.error("Failed to update shortcuts:", err);
  }

  getCurrentWindow().close();
});

// ─── Cancel ─────────────────────────────────────────
btnCancel.addEventListener("click", () => {
  getCurrentWindow().close();
});
