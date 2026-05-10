const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

import { CAPTURE_MODES, DOMAIN_HINTS, LANGUAGES, MODELS, DEFAULTS, OLLAMA_DEFAULT_MODELS, SETTINGS_KEYS, SPEECH_LOCALES, WHISPER_MODELS } from "./constants";
import { getSetting, setSetting } from "./store";
import { getActiveBackendId, detectOllama } from "./llmProfile";
import { populateSelect } from "./utils";

// ─── DOM ────────────────────────────────────────────
const backendRadios = document.querySelectorAll<HTMLInputElement>('input[name="llm-backend"]');
const ollamaSection = document.getElementById("ollama-section") as HTMLDivElement;
const geminiSection = document.getElementById("gemini-section") as HTMLDivElement;
const ollamaBaseurlInput = document.getElementById("ollama-baseurl") as HTMLInputElement;
const ollamaModelSelect = document.getElementById("ollama-model") as HTMLSelectElement;
const ollamaDetectBtn = document.getElementById("ollama-detect-btn") as HTMLButtonElement;
const ollamaStatus = document.getElementById("ollama-status") as HTMLDivElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const myLangSelect = document.getElementById("my-lang") as HTMLSelectElement;
const pairLangSelect = document.getElementById("pair-lang") as HTMLSelectElement;
const speechLocaleSelect = document.getElementById("speech-locale") as HTMLSelectElement;
const domainHintSelect = document.getElementById("domain-hint") as HTMLSelectElement;
const whisperModelSelect = document.getElementById("whisper-model") as HTMLSelectElement;
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

// ─── Backend toggle ─────────────────────────────────
function showBackendSection(id: "gemini-native" | "ollama") {
  if (id === "ollama") {
    ollamaSection.classList.remove("hidden");
    geminiSection.classList.add("hidden");
  } else {
    ollamaSection.classList.add("hidden");
    geminiSection.classList.remove("hidden");
  }
}

function populateOllamaModels(models: string[], selected?: string) {
  const items = models.length > 0 ? models : [...OLLAMA_DEFAULT_MODELS];
  replaceOptions(ollamaModelSelect, items.map(v => ({ value: v, label: v })));
  if (selected && items.includes(selected)) {
    ollamaModelSelect.value = selected;
  } else if (items.length > 0) {
    ollamaModelSelect.value = items[0];
  }
}

backendRadios.forEach(radio => {
  radio.addEventListener("change", () => {
    showBackendSection(radio.value as "gemini-native" | "ollama");
  });
});

ollamaDetectBtn.addEventListener("click", async () => {
  const baseUrl = ollamaBaseurlInput.value.trim() || DEFAULTS.ollamaBaseUrl;
  ollamaDetectBtn.disabled = true;
  ollamaStatus.textContent = "감지 중...";
  try {
    const result = await detectOllama(baseUrl);
    if (result.available) {
      const currentModel = ollamaModelSelect.value || DEFAULTS.ollamaModel;
      populateOllamaModels(result.models, currentModel);
      ollamaStatus.textContent = `연결됨 — ${result.models.length}개 모델 발견`;
    } else {
      ollamaStatus.textContent = result.error ?? "Ollama 서버에 연결할 수 없습니다.";
    }
  } finally {
    ollamaDetectBtn.disabled = false;
  }
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
  invoke("resume_shortcuts").catch((e) => {
    console.warn("Failed to resume shortcuts:", e);
  });
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
populateSelect(domainHintSelect, [...DOMAIN_HINTS]);
populateSelect(whisperModelSelect, [...WHISPER_MODELS]);
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
  domainHintSelect.value = await getSetting(SETTINGS_KEYS.domainHint, DEFAULTS.domainHint);
  whisperModelSelect.value = await getSetting(SETTINGS_KEYS.whisperModel, DEFAULTS.whisperModel);
  captureModeSelect.value = savedCaptureMode;
  modelSelect.value = await getSetting(SETTINGS_KEYS.model, DEFAULTS.model);

  selectShortcutStr = await getSetting(SETTINGS_KEYS.selectShortcut, DEFAULTS.selectShortcut);
  clipboardShortcutStr = await getSetting(SETTINGS_KEYS.clipboardShortcut, DEFAULTS.clipboardShortcut);
  shortcutSelectBtn.textContent = shortcutDisplay(selectShortcutStr);
  shortcutClipboardBtn.textContent = shortcutDisplay(clipboardShortcutStr);

  // Load backend settings
  const savedBackendId = await getActiveBackendId();
  backendRadios.forEach(r => { r.checked = r.value === savedBackendId; });
  showBackendSection(savedBackendId);

  const savedOllamaUrl = await getSetting(SETTINGS_KEYS.ollamaBaseUrl, DEFAULTS.ollamaBaseUrl);
  const savedOllamaModel = await getSetting(SETTINGS_KEYS.ollamaModel, DEFAULTS.ollamaModel);
  ollamaBaseurlInput.value = savedOllamaUrl;
  populateOllamaModels([...OLLAMA_DEFAULT_MODELS], savedOllamaModel);
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
  // 1. Read all inputs
  const apiKey = apiKeyInput.value.trim();
  const myLang = myLangSelect.value;
  const pairLang = pairLangSelect.value;
  const speechLocale = speechLocaleSelect.value;
  const domainHint = domainHintSelect.value;
  const whisperModel = whisperModelSelect.value;
  const captureMode = captureModeSelect.value;
  const captureWindow = captureWindowSelect.value;
  const model = modelSelect.value;
  const selectedBackend = ([...backendRadios].find(r => r.checked)?.value ?? DEFAULTS.llmBackendId) as "gemini-native" | "ollama";
  const rawBaseUrl = ollamaBaseurlInput.value.trim();
  const ollamaModel = ollamaModelSelect.value || DEFAULTS.ollamaModel;

  // 2. Validate FIRST — no store writes until all checks pass
  if (selectedBackend === "ollama") {
    const effectiveUrl = rawBaseUrl || DEFAULTS.ollamaBaseUrl;
    if (!effectiveUrl.startsWith("http://") && !effectiveUrl.startsWith("https://")) {
      alert("Ollama URL은 http:// 또는 https://로 시작해야 합니다.");
      return;
    }
    if (!ollamaModel) {
      alert("Ollama 모델을 선택하세요.");
      return;
    }
  }

  // 3. Register shortcuts first — if this fails, abort before any store writes
  try {
    await invoke("update_shortcuts", {
      selectShortcut: selectShortcutStr,
      clipboardShortcut: clipboardShortcutStr,
    });
  } catch (err) {
    alert(`단축키 등록 실패: ${err}\n이전 단축키가 유지됩니다.`);
    return;
  }

  // 4. Persist — shortcuts registered successfully, now write all settings atomically
  await setSetting(SETTINGS_KEYS.apiKey, apiKey);
  await setSetting(SETTINGS_KEYS.myLang, myLang);
  await setSetting(SETTINGS_KEYS.pairLang, pairLang);
  await setSetting(SETTINGS_KEYS.speechLocale, speechLocale);
  await setSetting(SETTINGS_KEYS.domainHint, domainHint);
  await setSetting(SETTINGS_KEYS.whisperModel, whisperModel);
  await setSetting(SETTINGS_KEYS.captureMode, captureMode);
  await setSetting(SETTINGS_KEYS.captureWindow, captureWindow);
  await setSetting(SETTINGS_KEYS.model, model);
  await setSetting(SETTINGS_KEYS.llmBackendId, selectedBackend);
  await setSetting(SETTINGS_KEYS.ollamaBaseUrl, rawBaseUrl || DEFAULTS.ollamaBaseUrl);
  await setSetting(SETTINGS_KEYS.ollamaModel, ollamaModel);
  await setSetting(SETTINGS_KEYS.selectShortcut, selectShortcutStr);
  await setSetting(SETTINGS_KEYS.clipboardShortcut, clipboardShortcutStr);

  getCurrentWindow().close();
});

// ─── Cancel ─────────────────────────────────────────
btnCancel.addEventListener("click", () => {
  getCurrentWindow().close();
});

// ─── Whisper Model Management ──────────────────────
type ModelStatus = {
  downloaded: boolean;
  ggmlDownloaded: boolean;
  coremlDownloaded: boolean;
  sizeBytes: number;
  path: string;
  error?: string;
};

type ModelDownloadProgress = {
  file: string;
  downloaded: number;
  total: number;
  percent: number;
};

const modelStatusText = document.getElementById("model-status-text") as HTMLSpanElement;
const modelProgress = document.getElementById("model-progress") as HTMLDivElement;
const modelProgressFill = document.getElementById("model-progress-fill") as HTMLDivElement;
const modelProgressText = document.getElementById("model-progress-text") as HTMLSpanElement;
const modelDownloadBtn = document.getElementById("model-download-btn") as HTMLButtonElement;
const modelDeleteBtn = document.getElementById("model-delete-btn") as HTMLButtonElement;
let deleteConfirmTimer: number | null = null;
let unlistenModelDownloadProgress: (() => void) | null = null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function updateModelUI(status: ModelStatus) {
  if (status.downloaded) {
    modelStatusText.textContent = `다운로드 완료 (${formatBytes(status.sizeBytes)})`;
    modelDownloadBtn.style.display = "none";
    modelDeleteBtn.style.display = "";
  } else {
    const parts: string[] = [];
    if (!status.ggmlDownloaded) parts.push("ggml 모델");
    if (!status.coremlDownloaded) parts.push("CoreML 인코더");
    modelStatusText.textContent = `미설치 (${parts.join(", ")} 필요)`;
    modelDownloadBtn.style.display = "";
    modelDeleteBtn.style.display = status.ggmlDownloaded || status.coremlDownloaded ? "" : "none";
  }
}

async function checkModelStatus() {
  try {
    const status = await invoke<ModelStatus>("check_whisper_model");
    updateModelUI(status);
  } catch (err) {
    modelStatusText.textContent = `상태 확인 실패: ${err}`;
  }
}

modelDownloadBtn.addEventListener("click", async () => {
  modelDownloadBtn.disabled = true;
  modelDownloadBtn.textContent = "다운로드 중…";
  modelProgress.style.display = "flex";
  modelProgressFill.style.width = "0%";
  modelProgressText.textContent = "0%";

  try {
    const status = await invoke<ModelStatus>("download_whisper_model");
    updateModelUI(status);
    modelProgress.style.display = "none";

    // Auto-load model after download
    if (status.downloaded) {
      try {
        await invoke("load_whisper_model");
      } catch {}
    }
  } catch (err) {
    modelStatusText.textContent = `다운로드 실패: ${err}`;
    modelDownloadBtn.textContent = "모델 다운로드 (~540MB)";
    modelDownloadBtn.disabled = false;
    modelProgress.style.display = "none";
  }
});

let deleteConfirmPending = false;

modelDeleteBtn.addEventListener("click", async () => {
  // Two-click confirm: first click changes text, second click deletes
  if (!deleteConfirmPending) {
    deleteConfirmPending = true;
    modelDeleteBtn.textContent = "정말 삭제하시겠습니까?";
    modelDeleteBtn.classList.add("model-btn-confirm");
    if (deleteConfirmTimer !== null) {
      window.clearTimeout(deleteConfirmTimer);
    }
    deleteConfirmTimer = window.setTimeout(() => {
      if (deleteConfirmPending) {
        deleteConfirmPending = false;
        modelDeleteBtn.textContent = "모델 삭제";
        modelDeleteBtn.classList.remove("model-btn-confirm");
      }
      deleteConfirmTimer = null;
    }, 3000);
    return;
  }

  deleteConfirmPending = false;
  if (deleteConfirmTimer !== null) {
    window.clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  modelDeleteBtn.disabled = true;
  modelDeleteBtn.textContent = "삭제 중…";
  modelDeleteBtn.classList.remove("model-btn-confirm");
  try {
    const status = await invoke<ModelStatus>("delete_whisper_model");
    updateModelUI(status);
  } catch (err) {
    modelStatusText.textContent = `삭제 실패: ${err}`;
    modelDeleteBtn.textContent = "모델 삭제";
  } finally {
    modelDeleteBtn.disabled = false;
  }
});

// Listen for download progress events
window.__TAURI__.event.listen("model-download-progress", (event: { payload: ModelDownloadProgress }) => {
  const { file, downloaded, total, percent } = event.payload;
  if (
    typeof file !== "string"
    || typeof downloaded !== "number"
    || typeof total !== "number"
    || typeof percent !== "number"
  ) {
    return;
  }
  modelProgressFill.style.width = `${percent}%`;
  modelProgressText.textContent = `${Math.round(percent)}%`;
  modelDownloadBtn.textContent = `${file}: ${formatBytes(downloaded)} / ${formatBytes(total)}`;
}).then((unlisten) => {
  unlistenModelDownloadProgress = unlisten;
}).catch((e) => {
  console.warn("Failed to listen for model-download-progress:", e);
});

window.addEventListener("beforeunload", () => {
  if (deleteConfirmTimer !== null) {
    window.clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  unlistenModelDownloadProgress?.();
  unlistenModelDownloadProgress = null;
});

// Check model status on load
checkModelStatus();
