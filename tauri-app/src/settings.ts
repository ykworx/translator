const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

import { CAPTURE_MODES, LANGUAGES, MODELS, DEFAULTS, SETTINGS_KEYS, SPEECH_LOCALES } from "./constants";
import { getSetting, setSetting } from "./store";
import { populateSelect } from "./utils";

// ─── DOM ────────────────────────────────────────────
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const myLangSelect = document.getElementById("my-lang") as HTMLSelectElement;
const pairLangSelect = document.getElementById("pair-lang") as HTMLSelectElement;
const speechLocaleSelect = document.getElementById("speech-locale") as HTMLSelectElement;
const captureModeSelect = document.getElementById("capture-mode") as HTMLSelectElement;
const captureWindowField = document.getElementById("capture-window-field") as HTMLDivElement;
const captureWindowSelect = document.getElementById("capture-window") as HTMLSelectElement;
const captureWindowRefreshBtn = document.getElementById("capture-window-refresh") as HTMLButtonElement;
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
// Current shortcut values (machine format)
let selectShortcutStr: string = DEFAULTS.selectShortcut;
let clipboardShortcutStr: string = DEFAULTS.clipboardShortcut;
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
  selectShortcutStr = DEFAULTS.selectShortcut;
  shortcutSelectBtn.textContent = shortcutDisplay(DEFAULTS.selectShortcut);
});
document.getElementById("reset-clipboard")!.addEventListener("click", () => {
  clipboardShortcutStr = DEFAULTS.clipboardShortcut;
  shortcutClipboardBtn.textContent = shortcutDisplay(DEFAULTS.clipboardShortcut);
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

// ─── Populate select elements ───────────────────────

function replaceOptions(select: HTMLSelectElement, items: { value: string; label: string }[]): void {
  select.innerHTML = "";
  populateSelect(select, items);
}

async function loadCaptureWindows(selectedValue = ""): Promise<void> {
  try {
    const windows = await invoke<Array<{ id: string; name: string }>>("list_caption_capture_windows");
    replaceOptions(captureWindowSelect, [
      { value: "", label: "자동 선택 (현재 첫 번째 창)" },
      ...windows.map(window => ({ value: window.id, label: window.name })),
    ]);
    captureWindowSelect.value = windows.some(window => window.id === selectedValue) ? selectedValue : "";
  } catch {
    replaceOptions(captureWindowSelect, [{ value: "", label: "자동 선택 (현재 첫 번째 창)" }]);
    captureWindowSelect.value = "";
  }
}


populateSelect(myLangSelect, LANGUAGES);
populateSelect(pairLangSelect, LANGUAGES);
populateSelect(speechLocaleSelect, [...SPEECH_LOCALES]);
populateSelect(captureModeSelect, [...CAPTURE_MODES]);
populateSelect(modelSelect, MODELS);

// ─── Load settings ──────────────────────────────────
(async () => {
  const savedCaptureMode = await getSetting(SETTINGS_KEYS.captureMode, DEFAULTS.captureMode);
  const savedCaptureWindow = await getSetting(SETTINGS_KEYS.captureWindow, DEFAULTS.captureWindow);
  await loadCaptureWindows(savedCaptureWindow);

  apiKeyInput.value = await getSetting(SETTINGS_KEYS.apiKey, DEFAULTS.apiKey);
  myLangSelect.value = await getSetting(SETTINGS_KEYS.myLang, DEFAULTS.myLang);
  pairLangSelect.value = await getSetting(SETTINGS_KEYS.pairLang, DEFAULTS.pairLang);
  speechLocaleSelect.value = await getSetting(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  captureModeSelect.value = savedCaptureMode;
  modelSelect.value = await getSetting(SETTINGS_KEYS.model, DEFAULTS.model);

  selectShortcutStr = await getSetting(SETTINGS_KEYS.selectShortcut, DEFAULTS.selectShortcut);
  clipboardShortcutStr = await getSetting(SETTINGS_KEYS.clipboardShortcut, DEFAULTS.clipboardShortcut);
  shortcutSelectBtn.textContent = shortcutDisplay(selectShortcutStr);
  shortcutClipboardBtn.textContent = shortcutDisplay(clipboardShortcutStr);
})();

captureWindowRefreshBtn.addEventListener("click", async () => {
  captureWindowRefreshBtn.disabled = true;
  try {
    await loadCaptureWindows(captureWindowSelect.value);
  } finally {
    captureWindowRefreshBtn.disabled = false;
  }
});

// ─── Save ───────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  try {
    await setSetting(SETTINGS_KEYS.apiKey, apiKeyInput.value.trim());
    await setSetting(SETTINGS_KEYS.myLang, myLangSelect.value);
    await setSetting(SETTINGS_KEYS.pairLang, pairLangSelect.value);
    await setSetting(SETTINGS_KEYS.speechLocale, speechLocaleSelect.value);
    await setSetting(SETTINGS_KEYS.captureMode, captureModeSelect.value);
    await setSetting(SETTINGS_KEYS.captureWindow, captureWindowSelect.value);
    await setSetting(SETTINGS_KEYS.model, modelSelect.value);

    // Validate shortcuts by registering them first; only persist on success
    await invoke("update_shortcuts", {
      selectShortcut: selectShortcutStr,
      clipboardShortcut: clipboardShortcutStr,
    });
    await setSetting(SETTINGS_KEYS.selectShortcut, selectShortcutStr);
    await setSetting(SETTINGS_KEYS.clipboardShortcut, clipboardShortcutStr);

    getCurrentWindow().close();
  } catch (err) {
    alert(`단축키 등록 실패: ${err}\n이전 단축키가 유지됩니다.`);
  }
});

// ─── Cancel ─────────────────────────────────────────
btnCancel.addEventListener("click", () => {
  getCurrentWindow().close();
});
