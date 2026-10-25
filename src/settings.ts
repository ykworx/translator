const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { emit } = window.__TAURI__.event;

import { CAPTURE_MODES, DOMAIN_HINTS, LANGUAGES, MODELS, OPENAI_MODELS, DEFAULTS, SETTINGS_KEYS, SPEECH_LOCALES, WHISPER_MODELS } from "./constants";
import { getSetting, getStoreRid, setSetting } from "./store";
import { getActiveBackendId, detectOllama, InvalidBackendSettingError } from "./llmProfile";
import type { BackendId } from "./types";
import { populateSelect } from "./utils";
import { getCredentialStatus, saveProviderCredential, deleteProviderCredential, normalizeOllamaBaseUrl, type CloudProviderId, type CredentialStatus } from "./connectionProfiles";

// ─── DOM ────────────────────────────────────────────
const backendRadios = document.querySelectorAll<HTMLInputElement>('input[name="llm-backend"]');
const ollamaSection = document.getElementById("ollama-section") as HTMLDivElement;
const geminiSection = document.getElementById("gemini-section") as HTMLDivElement;
const openaiSection = document.getElementById("openai-section") as HTMLDivElement;
const openaiApiKeyInput = document.getElementById("openai-api-key") as HTMLInputElement;
const openaiModelSelect = document.getElementById("openai-model") as HTMLSelectElement;
const ollamaBaseurlInput = document.getElementById("ollama-baseurl") as HTMLInputElement;
const ollamaModelInput = document.getElementById("ollama-model") as HTMLInputElement;
const ollamaModelList = document.getElementById("ollama-model-list") as HTMLDataListElement;
const ollamaDetectBtn = document.getElementById("ollama-detect-btn") as HTMLButtonElement;
const ollamaStatus = document.getElementById("ollama-status") as HTMLDivElement;
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const myLangSelect = document.getElementById("my-lang") as HTMLSelectElement;
const pairLangSelect = document.getElementById("pair-lang") as HTMLSelectElement;
const speechLocaleSelect = document.getElementById("speech-locale") as HTMLSelectElement;
const dictationLocaleSelect = document.getElementById("dictation-locale") as HTMLSelectElement;
const dictationHintInput = document.getElementById("dictation-hint") as HTMLInputElement;
const dictationIdleSelect = document.getElementById("dictation-idle-seconds") as HTMLSelectElement;
const dictationMicrophoneSelect = document.getElementById("dictation-microphone") as HTMLSelectElement;
const dictationMicrophoneRefreshBtn = document.getElementById("dictation-microphone-refresh") as HTMLButtonElement;
const dictationMicrophoneStatus = document.getElementById("dictation-microphone-status") as HTMLParagraphElement;
const dictationShortcutSummary = document.getElementById("dictation-shortcut-summary") as HTMLElement;
const dictationShortcutStatus = document.getElementById("dictation-shortcut-status") as HTMLElement;
const dictationPermissionStatus = document.getElementById("dictation-permission-status") as HTMLElement;
const dictationPermissionBtn = document.getElementById("dictation-permission-request") as HTMLButtonElement;
const dictationPreviewBtn = document.getElementById("preview-dictation-panel") as HTMLButtonElement;
const settingsStatus = document.getElementById("settings-status") as HTMLElement;
const settingsWindow = getCurrentWindow() as import("@tauri-apps/api/window").Window;
const domainHintSelect = document.getElementById("domain-hint") as HTMLSelectElement;
const whisperModelSelect = document.getElementById("whisper-model") as HTMLSelectElement;
const captureModeSelect = document.getElementById("capture-mode") as HTMLSelectElement;
const captureWindowField = document.getElementById("capture-window-field") as HTMLDivElement;
const captureWindowSelect = document.getElementById("capture-window") as HTMLSelectElement;
const captureWindowRefreshBtn = document.getElementById("capture-window-refresh") as HTMLButtonElement;
const modelSelect = document.getElementById("model") as HTMLSelectElement;
const geminiModelStatus = document.getElementById("gemini-model-status") as HTMLElement;
const btnSave = document.getElementById("btn-save") as HTMLButtonElement;
const btnCancel = document.getElementById("btn-cancel") as HTMLButtonElement;
const actions = document.getElementById("actions") as HTMLDivElement;
const shortcutSelectBtn = document.getElementById("shortcut-select") as HTMLButtonElement;
const shortcutClipboardBtn = document.getElementById("shortcut-clipboard") as HTMLButtonElement;
const shortcutDictationBtn = document.getElementById("shortcut-dictation") as HTMLButtonElement;
const experimentalCaptionsToggle = document.getElementById("experimental-captions-toggle") as HTMLInputElement;

// Official Developer API lifecycle checked 2026-10-25. Preserve saved choices;
// notices inform an explicit model change rather than silently routing it.
function updateGeminiModelStatus(): void {
  const model = modelSelect.value.replace(/^models\//, "");
  geminiModelStatus.textContent = ["gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite", "gemini-2.0-flash-lite-001"].includes(model)
    ? "이 Gemini 모델은 지원이 종료되었습니다. 사용할 모델을 직접 선택해주세요. 저장된 선택은 자동 변경하지 않습니다."
    : ["gemini-2.5-flash", "gemini-2.5-pro"].includes(model)
      ? "이 모델은 기존 사용 프로젝트로 접근이 제한됩니다. 현재 프로젝트의 사용 가능 여부를 확인하거나 다른 모델을 선택해주세요."
      : "";
}
modelSelect.addEventListener("change", updateGeminiModelStatus);

// ─── Tabs ───────────────────────────────────────────
const tabItems = document.querySelectorAll<HTMLButtonElement>(".tab-item");
const tabPanes = document.querySelectorAll<HTMLDivElement>(".tab-pane");

function activateTab(tab: string): void {
  tabItems.forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  tabPanes.forEach(pane => pane.classList.toggle("active", pane.id === `pane-${tab}`));
  actions.style.display = tab !== "about" ? "flex" : "none";
  if (tab === "dictation" && settingsReady) void refreshDictationPermissions();
}

tabItems.forEach(item => item.addEventListener("click", () => activateTab(item.dataset.tab!)));
document.getElementById("show-dictation-shortcut")!.addEventListener("click", () => {
  activateTab("shortcuts");
  document.getElementById("dictation-shortcut-row")?.scrollIntoView?.({ block: "center" });
  shortcutDictationBtn.focus();
});

// ─── Backend toggle ─────────────────────────────────
function showBackendSection(id: BackendId | null) {
  ollamaSection.classList.add("hidden");
  geminiSection.classList.add("hidden");
  openaiSection.classList.add("hidden");

  if (id === "ollama") {
    ollamaSection.classList.remove("hidden");
  } else if (id === "openai") {
    openaiSection.classList.remove("hidden");
  } else if (id === "gemini-native") {
    geminiSection.classList.remove("hidden");
  }
  if (settingsReady && (id === "gemini-native" || id === "openai")) void refreshCredential(id);
}

function populateOllamaModels(models: readonly string[]): void {
  const options = models.map(model => {
    const option = document.createElement("option");
    option.value = model;
    return option;
  });
  ollamaModelList.replaceChildren(...options);
}

backendRadios.forEach(radio => {
  radio.addEventListener("change", () => {
    showBackendSection(radio.value as BackendId);
    updateSaveButton();
  });
});

let ollamaQueryGeneration = 0;
function currentOllamaUrl(): string {
  return ollamaBaseurlInput.value.trim() || DEFAULTS.ollamaBaseUrl;
}

ollamaBaseurlInput.addEventListener("input", () => {
  ollamaQueryGeneration += 1;
  ollamaDetectBtn.disabled = false;
  populateOllamaModels([]);
  ollamaStatus.textContent = "주소가 변경되었습니다. 모델 목록을 다시 조회해주세요. 입력한 모델은 유지됩니다.";
});

ollamaDetectBtn.addEventListener("click", async () => {
  if (!settingsReady || isSaving || closing || ollamaDetectBtn.disabled) return;
  const generation = ++ollamaQueryGeneration;
  const baseUrl = currentOllamaUrl();
  beginSettingsOperation();
  ollamaDetectBtn.disabled = true;
  ollamaStatus.textContent = "모델 목록 조회 중…";
  try {
    const result = await detectOllama(baseUrl);
    if (closing || generation !== ollamaQueryGeneration || currentOllamaUrl() !== baseUrl) return;
    if (result.available) {
      populateOllamaModels(result.models);
      ollamaStatus.textContent = result.models.length
        ? `모델 ${result.models.length}개를 찾았습니다. 목록에서 선택하거나 모델 이름을 직접 입력하세요. 입력한 모델은 유지됩니다.`
        : "서버에 연결했지만 모델 목록이 비어 있습니다. 모델을 준비한 뒤 다시 조회하거나 사용할 모델 이름을 직접 입력하세요.";
    } else {
      ollamaStatus.textContent = result.error ?? "Ollama 서버에 연결할 수 없습니다.";
    }
  } finally {
    if (generation === ollamaQueryGeneration) ollamaDetectBtn.disabled = false;
    endSettingsOperation();
  }
});

// ─── Shortcut recording ─────────────────────────────
// Current shortcut values (machine format)
let selectShortcutStr: string = DEFAULTS.selectShortcut;
let clipboardShortcutStr: string = DEFAULTS.clipboardShortcut;
let dictationShortcutStr: string = DEFAULTS.dictationShortcut;
let recordingBtn: HTMLButtonElement | null = null;
let shortcutOperation: Promise<void> | null = null;
let shortcutsSuspended = false;
let settingsReady = false;
let isSaving = false;
let pendingSettingsOperations = 0;
let savedFingerprint = "";
let closing = false;
let pendingCredentialWrites = 0;
btnSave.disabled = true;
const initiallyLoadingControls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".tab-content input, .tab-content select")];
initiallyLoadingControls.forEach(control => { control.disabled = true; });
setStatus("설정을 불러오는 중…");

function setStatus(message: string, error = false): void {
  settingsStatus.textContent = message;
  settingsStatus.classList.toggle("error", error);
}

function updateSaveButton(): void {
  btnSave.disabled = !settingsReady || isSaving || pendingSettingsOperations > 0 || !!recordingBtn || !!shortcutOperation
    || ![...backendRadios].some(radio => radio.checked);
  btnCancel.disabled = isSaving || pendingCredentialWrites > 0;
}

function beginSettingsOperation(): void {
  pendingSettingsOperations += 1;
  updateSaveButton();
}

function endSettingsOperation(): void {
  pendingSettingsOperations -= 1;
  updateSaveButton();
}

const credentialFields = {
  "gemini-native": { input: apiKeyInput, prefix: "gemini" },
  openai: { input: openaiApiKeyInput, prefix: "openai" },
};
const credentialStates: Record<CloudProviderId, { status: CredentialStatus | null; busy: boolean; confirmingDelete: boolean }> = {
  "gemini-native": { status: null, busy: false, confirmingDelete: false },
  openai: { status: null, busy: false, confirmingDelete: false },
};

function credentialControls(providerId: CloudProviderId) {
  const field = credentialFields[providerId];
  return { input: field.input,
    save: document.getElementById(`${field.prefix}-key-save`) as HTMLButtonElement,
    remove: document.getElementById(`${field.prefix}-key-delete`) as HTMLButtonElement,
    refresh: document.getElementById(`${field.prefix}-key-refresh`) as HTMLButtonElement,
    status: document.getElementById(`${field.prefix}-key-status`) as HTMLElement };
}

function updateCredentialControls(providerId: CloudProviderId): void {
  const state = credentialStates[providerId];
  const controls = credentialControls(providerId);
  controls.save.disabled = !settingsReady || isSaving || state.busy || !state.status || !controls.input.value.trim();
  controls.remove.disabled = !settingsReady || isSaving || state.busy || !state.status?.configured;
  controls.refresh.disabled = !settingsReady || isSaving || state.busy;
  controls.input.disabled = !settingsReady || isSaving || state.busy;
  controls.remove.textContent = state.confirmingDelete ? "다시 눌러 키 삭제" : "저장된 키 삭제";
}

async function refreshCredential(providerId: CloudProviderId): Promise<void> {
  const state = credentialStates[providerId];
  if (!settingsReady || isSaving || closing || state.busy) return;
  const controls = credentialControls(providerId);
  state.busy = true;
  state.confirmingDelete = false;
  controls.status.textContent = "Keychain의 키 상태를 확인하는 중…";
  updateCredentialControls(providerId);
  try {
    state.status = await getCredentialStatus(providerId);
    controls.status.textContent = state.status.error || (state.status.configured ? "Keychain에 API 키가 저장되어 있습니다. 새 키를 입력하면 교체할 수 있습니다." : "저장된 API 키가 없습니다.");
  } catch (error) {
    state.status = null;
    controls.status.textContent = `키 상태를 확인하지 못했습니다. 키 상태 확인 버튼으로 다시 시도해주세요: ${error}`;
  } finally {
    state.busy = false;
    updateCredentialControls(providerId);
  }
}

async function changeCredential(providerId: CloudProviderId, remove: boolean): Promise<void> {
  const state = credentialStates[providerId];
  const controls = credentialControls(providerId);
  if (!settingsReady || isSaving || closing || state.busy || !state.status) return;
  const value = controls.input.value.trim();
  if (remove && !state.confirmingDelete) {
    state.confirmingDelete = true;
    controls.status.textContent = "저장된 API 키를 삭제하려면 삭제 버튼을 한 번 더 누르세요.";
    updateCredentialControls(providerId);
    return;
  }
  if (!remove && !value) return;
  state.busy = true;
  state.confirmingDelete = false;
  pendingCredentialWrites += 1;
  beginSettingsOperation();
  updateCredentialControls(providerId);
  controls.status.textContent = remove ? "API 키 삭제 중…" : "API 키 저장 중…";
  try {
    state.status = remove ? await deleteProviderCredential(providerId, state.status.revision)
      : await saveProviderCredential(providerId, value, state.status.revision);
    if (!remove && controls.input.value.trim() === value) controls.input.value = "";
    controls.status.textContent = remove ? "Keychain에서 API 키를 삭제했습니다." : "Keychain에 API 키를 저장했습니다. 일반 설정과 별도로 적용됐습니다.";
    markChanged();
  } catch (error) {
    controls.status.textContent = `API 키 변경 결과를 확인하지 못했습니다. 입력을 유지했습니다. 키 상태를 다시 확인한 뒤 시도해주세요: ${error}`;
  } finally {
    state.busy = false;
    pendingCredentialWrites -= 1;
    endSettingsOperation();
    updateCredentialControls(providerId);
  }
}

for (const providerId of ["gemini-native", "openai"] as const) {
  const controls = credentialControls(providerId);
  controls.refresh.addEventListener("click", () => void refreshCredential(providerId));
  controls.save.addEventListener("click", () => void changeCredential(providerId, false));
  controls.remove.addEventListener("click", () => void changeCredential(providerId, true));
  controls.input.addEventListener("input", () => {
    credentialStates[providerId].confirmingDelete = false;
    controls.status.textContent = controls.input.value.trim() ? "새 API 키를 입력했습니다. API 키 저장 버튼을 눌러 적용하세요." : "입력칸을 비워도 저장된 키는 유지됩니다.";
    updateCredentialControls(providerId);
  });
}

async function loadShortcutStatus(): Promise<void> {
  try {
    const status = await invoke<{ dictationRegistered: boolean; suspended: boolean }>("get_shortcut_status");
    const unavailable = status.dictationRegistered === false && !status.suspended;
    dictationShortcutStatus.classList.toggle("hidden", !unavailable);
    dictationShortcutStatus.textContent = unavailable
      ? "받아쓰기 단축키를 등록하지 못했습니다. 다른 앱의 단축키와 겹칠 수 있으니 ‘단축키 변경’에서 새 조합을 지정하고 저장해주세요."
      : "";
  } catch (error) {
    // Status discovery is advisory; settings must remain usable if it fails.
    console.warn("Could not check dictation shortcut registration:", error);
  }
}

type DictationPermissions = {
  microphone: boolean;
  microphoneStatus: "authorized" | "notDetermined" | "denied" | "restricted";
  accessibility: boolean;
  modelLoaded: boolean;
};
let checkingPermissions = false;

async function refreshDictationPermissions(request = false): Promise<void> {
  if (isSaving || closing || checkingPermissions) return;
  checkingPermissions = true;
  beginSettingsOperation();
  dictationPermissionBtn.disabled = true;
  try {
    const permissions = await invoke<DictationPermissions>(request ? "request_dictation_permissions" : "get_dictation_permissions");
    const missing: string[] = [];
    if (!permissions.microphone) missing.push("마이크");
    if (!permissions.accessibility) missing.push("손쉬운 사용");
    dictationPermissionStatus.textContent = missing.length
      ? `필요한 권한: ${missing.join(" · ")}`
      : "마이크 · 손쉬운 사용 허용됨";
    dictationPermissionStatus.title = ["denied", "restricted"].includes(permissions.microphoneStatus)
      ? "시스템 설정 → 개인정보 보호 및 보안에서 마이크 권한을 확인해주세요."
      : missing.length ? "버튼을 눌러 권한을 요청한 뒤 macOS 안내에 따라 허용해주세요." : "";
    dictationPermissionBtn.textContent = missing.length ? "권한 확인/요청" : "다시 확인";
  } catch {
    dictationPermissionStatus.textContent = "권한을 확인하지 못했습니다. 다시 확인해주세요.";
  } finally {
    checkingPermissions = false;
    dictationPermissionBtn.disabled = false;
    endSettingsOperation();
  }
}

dictationPermissionBtn.addEventListener("click", () => void refreshDictationPermissions(true));
dictationPreviewBtn.addEventListener("click", async () => {
  if (isSaving || closing || dictationPreviewBtn.disabled) return;
  dictationPreviewBtn.disabled = true;
  beginSettingsOperation();
  try {
    const shown = await invoke<boolean>("preview_dictation_panel");
    setStatus(shown ? "상태창 미리보기 · 녹음하지 않습니다." : "진행 중인 받아쓰기를 먼저 종료해주세요.");
  } catch (error) {
    setStatus(`미리보기를 표시하지 못했습니다: ${error}`, true);
  } finally {
    dictationPreviewBtn.disabled = false;
    endSettingsOperation();
  }
});

function formFingerprint(): string {
  const values = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")]
    .filter(el => !(el instanceof HTMLInputElement && el.type === "password"))
    .map(el => [el.id || `${el.name}:${el.value}`, el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el.checked : el.value]);
  return JSON.stringify([values, selectShortcutStr, clipboardShortcutStr, dictationShortcutStr]);
}

function markChanged(): void {
  if (!settingsReady || isSaving) return;
  dictationShortcutSummary.textContent = shortcutDisplay(dictationShortcutStr);
  setStatus(formFingerprint() === savedFingerprint ? "" : "저장하지 않은 변경사항이 있습니다.");
}

document.addEventListener("input", markChanged);
document.addEventListener("change", markChanged);

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

function shortcutValue(btn: HTMLButtonElement): string {
  return btn === shortcutSelectBtn ? selectShortcutStr
    : btn === shortcutDictationBtn ? dictationShortcutStr : clipboardShortcutStr;
}

function startRecording(btn: HTMLButtonElement): void {
  if (shortcutOperation || isSaving || !settingsReady) return;
  shortcutOperation = (async () => {
    const alreadySuspended = shortcutsSuspended;
    if (recordingBtn) {
      recordingBtn.classList.remove("recording");
      recordingBtn.textContent = shortcutDisplay(shortcutValue(recordingBtn));
      recordingBtn = null;
    }
    try {
      if (!alreadySuspended) await invoke("suspend_shortcuts");
      shortcutsSuspended = true;
      recordingBtn = btn;
      btn.classList.add("recording");
      btn.textContent = "단축키 입력… (Esc 취소)";
      setStatus("사용할 단축키를 누르세요. 변경은 저장 후 적용됩니다.");
    } catch (error) {
      setStatus(`단축키 입력을 시작하지 못했습니다: ${error}`, true);
    }
  })().finally(() => { shortcutOperation = null; updateSaveButton(); });
  updateSaveButton();
}

async function stopRecording(btn: HTMLButtonElement): Promise<void> {
  btn.classList.remove("recording");
  btn.textContent = shortcutDisplay(shortcutValue(btn));
  recordingBtn = null;
  try {
    await invoke("resume_shortcuts");
    shortcutsSuspended = false;
    markChanged();
  } catch (error) {
    setStatus(`단축키를 복구하지 못했습니다. 다시 저장해주세요: ${error}`, true);
    throw error;
  } finally { updateSaveButton(); }
}

function finishShortcutRecording(btn: HTMLButtonElement): void {
  shortcutOperation = stopRecording(btn).catch(() => {}).finally(() => {
    shortcutOperation = null;
    updateSaveButton();
  });
  updateSaveButton();
}

async function closeSettings(): Promise<void> {
  if (isSaving || closing || pendingCredentialWrites > 0) return;
  closing = true;
  try {
    if (shortcutOperation) await shortcutOperation;
    if (recordingBtn) await stopRecording(recordingBtn);
    else if (shortcutsSuspended) {
      await invoke("resume_shortcuts");
      shortcutsSuspended = false;
    }
    // onCloseRequested itself uses destroy() after its callback. Keep the
    // final close here so permission/native errors are visible and retryable.
    await settingsWindow.destroy();
  } catch (error) {
    closing = false;
    setStatus(`설정 창을 닫지 못했습니다: ${error}`, true);
  }
}

if (typeof settingsWindow.onCloseRequested === "function") {
  settingsWindow.onCloseRequested(async event => {
    event.preventDefault();
    await closeSettings();
  }).catch(error => console.warn("Could not attach settings close handler:", error));
}

shortcutSelectBtn.addEventListener("click", () => startRecording(shortcutSelectBtn));
shortcutClipboardBtn.addEventListener("click", () => startRecording(shortcutClipboardBtn));
shortcutDictationBtn.addEventListener("click", () => startRecording(shortcutDictationBtn));
for (const [id, button, reset] of [
  ["reset-select", shortcutSelectBtn, () => { selectShortcutStr = DEFAULTS.selectShortcut; }],
  ["reset-clipboard", shortcutClipboardBtn, () => { clipboardShortcutStr = DEFAULTS.clipboardShortcut; }],
  ["reset-dictation", shortcutDictationBtn, () => { dictationShortcutStr = DEFAULTS.dictationShortcut; }],
] as const) {
  document.getElementById(id)!.addEventListener("click", () => {
    if (recordingBtn || shortcutOperation || isSaving) return;
    reset();
    button.textContent = shortcutDisplay(shortcutValue(button));
    markChanged();
  });
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (recordingBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") { finishShortcutRecording(recordingBtn); return; }
    const str = eventToShortcutStr(e);
    if (!str || e.isComposing || e.repeat) return;
    if (recordingBtn === shortcutSelectBtn) selectShortcutStr = str;
    else if (recordingBtn === shortcutDictationBtn) dictationShortcutStr = str;
    else clipboardShortcutStr = str;
    finishShortcutRecording(recordingBtn);
    return;
  }
  if (e.key === "Escape") { e.preventDefault(); void closeSettings(); }
});

// ─── Populate select elements ───────────────────────

function replaceOptions(select: HTMLSelectElement, items: { value: string; label: string }[]): void {
  select.innerHTML = "";
  populateSelect(select, items);
}

function restoreSelectedValue(select: HTMLSelectElement, value: string, customLabel: string): void {
  if (![...select.options].some(option => option.value === value)) {
    populateSelect(select, [{ value, label: customLabel }]);
  }
  select.value = value;
}

type DictationMicrophone = { id: string; name: string; isDefault: boolean };
let microphoneRequestId = 0;

async function loadDictationMicrophones(selectedValue = dictationMicrophoneSelect.value): Promise<void> {
  if (isSaving || closing) return;
  beginSettingsOperation();
  const request = ++microphoneRequestId;
  dictationMicrophoneRefreshBtn.disabled = true;
  dictationMicrophoneSelect.disabled = true;
  dictationMicrophoneStatus.textContent = "마이크를 확인하는 중…";
  try {
    const devices = await invoke<DictationMicrophone[]>("list_dictation_microphones");
    if (request !== microphoneRequestId) return;
    const valid = devices.filter(device => typeof device.id === "string" && typeof device.name === "string");
    const defaultName = valid.find(device => device.isDefault)?.name;
    const options = [{ value: "", label: defaultName ? `시스템 기본값 — ${defaultName}` : "시스템 기본 마이크" },
      ...valid.map(device => ({ value: device.id, label: device.name }))];
    const missing = !!selectedValue && !valid.some(device => device.id === selectedValue);
    if (missing) options.push({ value: selectedValue, label: "이전에 선택한 마이크 (연결 안 됨)" });
    replaceOptions(dictationMicrophoneSelect, options);
    dictationMicrophoneSelect.value = selectedValue;
    dictationMicrophoneStatus.textContent = missing
      ? "선택한 마이크를 연결하거나 시스템 기본값을 선택해주세요."
      : "Mac에 연결된 마이크를 선택합니다. 시스템 기본값은 장치 변경을 자동으로 따릅니다.";
  } catch {
    if (request !== microphoneRequestId) return;
    const options = [{ value: "", label: "시스템 기본 마이크" }];
    if (selectedValue) options.push({ value: selectedValue, label: "저장된 마이크 (목록 확인 실패)" });
    replaceOptions(dictationMicrophoneSelect, options);
    dictationMicrophoneSelect.value = selectedValue;
    dictationMicrophoneStatus.textContent = "마이크 목록을 가져오지 못했습니다. 연결을 확인한 뒤 새로고침해주세요.";
  } finally {
    if (request === microphoneRequestId) {
      dictationMicrophoneRefreshBtn.disabled = false;
      dictationMicrophoneSelect.disabled = false;
    }
    endSettingsOperation();
  }
}

dictationMicrophoneRefreshBtn.addEventListener("click", () => {
  if (settingsReady) void loadDictationMicrophones();
});
dictationMicrophoneSelect.addEventListener("change", () => {
  dictationMicrophoneStatus.textContent = dictationMicrophoneSelect.value
    ? "선택한 마이크를 다음 받아쓰기부터 사용합니다. 변경사항을 저장해주세요."
    : "시스템 기본 마이크를 다음 받아쓰기부터 사용합니다.";
});

async function loadCaptureWindows(selectedValue = ""): Promise<void> {
  if (isSaving || closing) return;
  beginSettingsOperation();
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
  } finally {
    endSettingsOperation();
  }
}


populateSelect(myLangSelect, LANGUAGES);
populateSelect(pairLangSelect, LANGUAGES);
populateSelect(speechLocaleSelect, [...SPEECH_LOCALES]);
populateSelect(dictationLocaleSelect, [{ value: "auto", label: "자동 감지" }, ...SPEECH_LOCALES]);
populateSelect(domainHintSelect, [...DOMAIN_HINTS]);
populateSelect(whisperModelSelect, [...WHISPER_MODELS]);
populateSelect(captureModeSelect, [...CAPTURE_MODES]);
populateSelect(modelSelect, MODELS);
populateSelect(openaiModelSelect, OPENAI_MODELS);

// ─── Load settings ──────────────────────────────────
(async () => {
  const savedCaptureMode = await getSetting(SETTINGS_KEYS.captureMode, DEFAULTS.captureMode);
  const savedCaptureWindow = await getSetting(SETTINGS_KEYS.captureWindow, DEFAULTS.captureWindow);
  await loadCaptureWindows(savedCaptureWindow);

  myLangSelect.value = await getSetting(SETTINGS_KEYS.myLang, DEFAULTS.myLang);
  pairLangSelect.value = await getSetting(SETTINGS_KEYS.pairLang, DEFAULTS.pairLang);
  speechLocaleSelect.value = await getSetting(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  dictationLocaleSelect.value = await getSetting(SETTINGS_KEYS.dictationLocale, DEFAULTS.dictationLocale);
  dictationHintInput.value = await getSetting(SETTINGS_KEYS.dictationHint, DEFAULTS.dictationHint);
  const savedIdleSeconds = String(await getSetting(SETTINGS_KEYS.dictationIdleSeconds, DEFAULTS.dictationIdleSeconds));
  dictationIdleSelect.value = ["0", "30", "300", "900"].includes(savedIdleSeconds) ? savedIdleSeconds : String(DEFAULTS.dictationIdleSeconds);
  await loadDictationMicrophones(await getSetting(SETTINGS_KEYS.dictationMicrophone, DEFAULTS.dictationMicrophone));
  restoreSelectedValue(domainHintSelect, await getSetting(SETTINGS_KEYS.domainHint, DEFAULTS.domainHint), "저장된 사용자 힌트");
  whisperModelSelect.value = await getSetting(SETTINGS_KEYS.whisperModel, DEFAULTS.whisperModel);
  captureModeSelect.value = savedCaptureMode;
  const savedGeminiModel = await getSetting(SETTINGS_KEYS.model, DEFAULTS.model);
  restoreSelectedValue(modelSelect, savedGeminiModel, `${savedGeminiModel} (저장된 모델)`);
  updateGeminiModelStatus();

  selectShortcutStr = await getSetting(SETTINGS_KEYS.selectShortcut, DEFAULTS.selectShortcut);
  clipboardShortcutStr = await getSetting(SETTINGS_KEYS.clipboardShortcut, DEFAULTS.clipboardShortcut);
  shortcutSelectBtn.textContent = shortcutDisplay(selectShortcutStr);
  shortcutClipboardBtn.textContent = shortcutDisplay(clipboardShortcutStr);
  dictationShortcutStr = await getSetting(SETTINGS_KEYS.dictationShortcut, DEFAULTS.dictationShortcut);
  shortcutDictationBtn.textContent = shortcutDisplay(dictationShortcutStr);

  // Load backend settings
  let savedBackendId: BackendId | null = null;
  let providerError = "";
  try { savedBackendId = await getActiveBackendId(); }
  catch (error) {
    if (!(error instanceof InvalidBackendSettingError)) throw error;
    providerError = "저장된 AI 공급자가 올바르지 않습니다. API 탭에서 사용할 공급자를 직접 선택한 뒤 저장해주세요.";
  }
  backendRadios.forEach(r => { r.checked = r.value === savedBackendId; });
  showBackendSection(savedBackendId);

  experimentalCaptionsToggle.checked = await getSetting(SETTINGS_KEYS.experimentalCaptions, DEFAULTS.experimentalCaptions);

  const savedOllamaUrl = await getSetting(SETTINGS_KEYS.ollamaBaseUrl, DEFAULTS.ollamaBaseUrl);
  const savedOllamaModel = await getSetting(SETTINGS_KEYS.ollamaModel, DEFAULTS.ollamaModel);
  ollamaBaseurlInput.value = savedOllamaUrl;
  ollamaModelInput.value = savedOllamaModel;

  const savedOpenAiModel = await getSetting(SETTINGS_KEYS.openaiModel, DEFAULTS.openaiModel);
  restoreSelectedValue(openaiModelSelect, savedOpenAiModel, `${savedOpenAiModel} (저장된 모델)`);
  dictationShortcutSummary.textContent = shortcutDisplay(dictationShortcutStr);
  settingsReady = true;
  initiallyLoadingControls.forEach(control => { control.disabled = false; });
  savedFingerprint = formFingerprint();
  setStatus(providerError, !!providerError);
  updateSaveButton();
  for (const providerId of ["gemini-native", "openai"] as const) updateCredentialControls(providerId);
  if (savedBackendId === "gemini-native" || savedBackendId === "openai") void refreshCredential(savedBackendId);
  void loadShortcutStatus();
  void refreshDictationPermissions();
  await checkModelStatus();
})().catch(error => setStatus(`설정을 불러오지 못했습니다. 창을 다시 열어주세요: ${error}`, true));

captureWindowRefreshBtn.addEventListener("click", async () => {
  if (!settingsReady) return;
  captureWindowRefreshBtn.disabled = true;
  try {
    await loadCaptureWindows(captureWindowSelect.value);
  } finally {
    captureWindowRefreshBtn.disabled = false;
  }
});

// ─── Save ───────────────────────────────────────────
btnSave.addEventListener("click", async () => {
  if (btnSave.disabled || isSaving) return;
  const selectedBackend = ([...backendRadios].find(r => r.checked)?.value ?? DEFAULTS.llmBackendId) as BackendId;
  const rawBaseUrl = ollamaBaseurlInput.value.trim();
  let effectiveUrl = rawBaseUrl || DEFAULTS.ollamaBaseUrl;
  if (selectedBackend === "ollama") {
    try {
      effectiveUrl = normalizeOllamaBaseUrl(effectiveUrl);
    } catch { setStatus("Ollama URL은 사용자 정보·쿼리·프래그먼트가 없는 올바른 http 또는 https 주소를 입력해주세요.", true); return; }
    if (!ollamaModelInput.value.trim()) {
      setStatus("사용할 Ollama 모델 이름을 입력해주세요.", true);
      activateTab("api");
      ollamaModelInput.focus();
      return;
    }
  }
  if (apiKeyInput.value.trim() || openaiApiKeyInput.value.trim()) {
    setStatus("입력한 API 키는 해당 API 키 저장 버튼으로 먼저 저장하거나 입력칸을 비워주세요.", true);
    activateTab("api");
    return;
  }
  const values: Array<[string, unknown]> = [
    [SETTINGS_KEYS.myLang, myLangSelect.value],
    [SETTINGS_KEYS.pairLang, pairLangSelect.value],
    [SETTINGS_KEYS.speechLocale, speechLocaleSelect.value],
    [SETTINGS_KEYS.dictationLocale, dictationLocaleSelect.value],
    [SETTINGS_KEYS.dictationHint, dictationHintInput.value.trim()],
    [SETTINGS_KEYS.dictationIdleSeconds, Number(dictationIdleSelect.value)],
    [SETTINGS_KEYS.dictationMicrophone, dictationMicrophoneSelect.value],
    [SETTINGS_KEYS.dictationShortcut, dictationShortcutStr],
    [SETTINGS_KEYS.domainHint, domainHintSelect.value],
    [SETTINGS_KEYS.whisperModel, whisperModelSelect.value],
    [SETTINGS_KEYS.captureMode, captureModeSelect.value],
    [SETTINGS_KEYS.captureWindow, captureWindowSelect.value],
    [SETTINGS_KEYS.model, modelSelect.value],
    [SETTINGS_KEYS.llmBackendId, selectedBackend],
    [SETTINGS_KEYS.ollamaBaseUrl, effectiveUrl],
    [SETTINGS_KEYS.ollamaModel, ollamaModelInput.value.trim()],
    [SETTINGS_KEYS.openaiModel, openaiModelSelect.value || DEFAULTS.openaiModel],
    [SETTINGS_KEYS.selectShortcut, selectShortcutStr],
    [SETTINGS_KEYS.clipboardShortcut, clipboardShortcutStr],
    [SETTINGS_KEYS.experimentalCaptions, experimentalCaptionsToggle.checked],
  ];
  isSaving = true;
  updateSaveButton();
  const controlState = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(".tab-content input, .tab-content select, .tab-content button, .tab-bar button")]
    .map(control => [control, control.disabled] as const);
  controlState.forEach(([control]) => { control.disabled = true; });
  setStatus("저장 중입니다…");
  const previous = new Map<string, [unknown, boolean]>();
  let shortcutsChanged = false;
  let rid: number | null = null;
  try {
    rid = await getStoreRid();
    for (const [key] of values) {
      previous.set(key, await invoke<[unknown, boolean]>("settings_get", { rid, key }));
    }
    await invoke("update_shortcuts", {
      selectShortcut: selectShortcutStr,
      clipboardShortcut: clipboardShortcutStr,
      dictationShortcut: dictationShortcutStr,
    });
    shortcutsChanged = true;
    shortcutsSuspended = false;
    // Save sequentially, then explicitly flush before closing the window.
    for (const [key, value] of values) await setSetting(key, value);
    await invoke("settings_save", { rid });
    await emit("experimental-captions-changed", { enabled: experimentalCaptionsToggle.checked });
  } catch (error) {
    let restored = true;
    if (shortcutsChanged && rid !== null) {
      for (const [key, [value, exists]] of previous) {
        try {
          if (exists) await invoke("settings_set", { rid, key, value });
          else await invoke("settings_delete", { rid, key });
        } catch { restored = false; }
      }
      try { await invoke("settings_save", { rid }); } catch { restored = false; }
      const old = (key: string, fallback: string) => {
        const [value, exists] = previous.get(key) ?? [null, false];
        return exists && typeof value === "string" ? value : fallback;
      };
      try {
        await invoke("update_shortcuts", {
          selectShortcut: old(SETTINGS_KEYS.selectShortcut, DEFAULTS.selectShortcut),
          clipboardShortcut: old(SETTINGS_KEYS.clipboardShortcut, DEFAULTS.clipboardShortcut),
          dictationShortcut: old(SETTINGS_KEYS.dictationShortcut, DEFAULTS.dictationShortcut),
        });
      } catch { restored = false; }
    }
    setStatus(restored ? `저장하지 못했습니다. 입력 내용을 유지했습니다: ${error}`
      : `일부 설정을 복구하지 못했습니다. 내용을 확인하고 다시 저장해주세요: ${error}`, true);
    isSaving = false;
    controlState.forEach(([control, disabled]) => { control.disabled = disabled; });
    for (const providerId of ["gemini-native", "openai"] as const) updateCredentialControls(providerId);
    updateSaveButton();
    return;
  }
  savedFingerprint = formFingerprint();
  setStatus("설정을 저장했습니다.");
  isSaving = false;
  controlState.forEach(([control, disabled]) => { control.disabled = disabled; });
  for (const providerId of ["gemini-native", "openai"] as const) updateCredentialControls(providerId);
  updateSaveButton();
  await closeSettings();
});

btnCancel.addEventListener("click", () => void closeSettings());

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

function modelDownloadLabel(): string {
  const model = whisperModelSelect.value || DEFAULTS.whisperModel;
  const totals: Record<string, string> = { medium: "약 2.1 GB", "large-v3-turbo": "약 2.8 GB", "large-v3": "약 4.3 GB" };
  return `선택 모델 다운로드 (${totals[model] || model})`;
}

function updateModelUI(status: ModelStatus) {
  modelDownloadBtn.textContent = modelDownloadLabel();
  modelDownloadBtn.disabled = false;
  modelDeleteBtn.textContent = "선택 모델 삭제";
  if (status.downloaded) {
    modelStatusText.textContent = `다운로드 완료 · 음성 모델 파일 ${formatBytes(status.sizeBytes)}`;
    modelDownloadBtn.style.display = "none";
    modelDeleteBtn.style.display = "";
  } else {
    const parts: string[] = [];
    if (!status.ggmlDownloaded) parts.push("음성 모델");
    if (!status.coremlDownloaded) parts.push("인식 가속 파일");
    modelStatusText.textContent = `미설치 (${parts.join(", ")} 필요)`;
    modelDownloadBtn.style.display = "";
    modelDeleteBtn.style.display = status.ggmlDownloaded || status.coremlDownloaded ? "" : "none";
  }
}

let modelStatusRequestId = 0;
async function checkModelStatus() {
  if (isSaving || closing) return;
  beginSettingsOperation();
  const request = ++modelStatusRequestId;
  const model = whisperModelSelect.value || DEFAULTS.whisperModel;
  modelStatusText.textContent = "선택한 모델 확인 중…";
  modelDownloadBtn.style.display = "none";
  modelDeleteBtn.style.display = "none";
  try {
    const status = await invoke<ModelStatus>("check_whisper_model", { model });
    if (request === modelStatusRequestId) updateModelUI(status);
  } catch (err) {
    if (request === modelStatusRequestId) modelStatusText.textContent = `상태 확인 실패: ${err}`;
  } finally {
    endSettingsOperation();
  }
}

whisperModelSelect.addEventListener("change", () => {
  deleteConfirmPending = false;
  modelDeleteBtn.classList.remove("model-btn-confirm");
  if (deleteConfirmTimer !== null) { window.clearTimeout(deleteConfirmTimer); deleteConfirmTimer = null; }
  void checkModelStatus();
});

modelDownloadBtn.addEventListener("click", async () => {
  if (isSaving || closing || modelDownloadBtn.disabled) return;
  beginSettingsOperation();
  const selectedModel = whisperModelSelect.value;
  whisperModelSelect.disabled = true;
  modelDeleteBtn.disabled = true;
  modelDownloadBtn.disabled = true;
  modelDownloadBtn.textContent = "다운로드 중…";
  modelProgress.style.display = "flex";
  modelProgressFill.style.width = "0%";
  modelProgressText.textContent = "0%";

  try {
    const status = await invoke<ModelStatus>("download_whisper_model", { model: selectedModel });
    updateModelUI(status);
    modelProgress.style.display = "none";

  } catch (err) {
    modelStatusText.textContent = `다운로드 실패: ${err}`;
    modelDownloadBtn.textContent = modelDownloadLabel();
    modelDownloadBtn.disabled = false;
    modelProgress.style.display = "none";
  } finally {
    whisperModelSelect.disabled = false;
    modelDeleteBtn.disabled = false;
    endSettingsOperation();
  }
});

let deleteConfirmPending = false;

modelDeleteBtn.addEventListener("click", async () => {
  if (isSaving || closing || modelDeleteBtn.disabled) return;
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
        modelDeleteBtn.textContent = "선택 모델 삭제";
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
  beginSettingsOperation();
  modelDownloadBtn.disabled = true;
  whisperModelSelect.disabled = true;
  modelDeleteBtn.textContent = "삭제 중…";
  modelDeleteBtn.classList.remove("model-btn-confirm");
  try {
    const status = await invoke<ModelStatus>("delete_whisper_model", { model: whisperModelSelect.value });
    updateModelUI(status);
  } catch (err) {
    modelStatusText.textContent = `삭제 실패: ${err}`;
    modelDeleteBtn.textContent = "선택 모델 삭제";
  } finally {
    modelDeleteBtn.disabled = false;
    modelDownloadBtn.disabled = false;
    whisperModelSelect.disabled = false;
    endSettingsOperation();
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
  if (shortcutsSuspended) {
    void invoke("resume_shortcuts").catch(error => console.warn("Could not resume shortcuts during settings unload:", error));
  }
  if (deleteConfirmTimer !== null) {
    window.clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
  unlistenModelDownloadProgress?.();
  unlistenModelDownloadProgress = null;
});

// Model status is checked after saved selections are restored.
