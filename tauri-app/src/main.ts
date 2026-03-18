// ─── Tauri API ───────────────────────────────────────
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ─── Module imports ──────────────────────────────────
import { getSetting, setSetting } from "./store";
import { readText, writeTextToClipboard } from "./clipboard";
import {
  translate,
  translateTable,
  translateImage,
  suggestReplies,
  summarize,
} from "./api";
import { chatHistory, chat, renderLoading, removeLoading, addEntry, clearChat } from "./ui";
import { LANGUAGES, DEFAULTS, MAX_TEXTAREA_HEIGHT, SETTINGS_KEYS } from "./constants";

// ─── DOM References ──────────────────────────────────
const inputField = document.getElementById("input-field") as HTMLTextAreaElement;
const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
const btnMic = document.getElementById("btn-mic") as HTMLButtonElement;
const btnAppCaptions = document.getElementById("btn-zoom-captions") as HTMLButtonElement;
const btnSuggest = document.getElementById("btn-suggest") as HTMLButtonElement;
const btnSummarize = document.getElementById("btn-summarize") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;
const speechStatus = document.getElementById("speech-status") as HTMLDivElement;
const appCaptionStatus = document.getElementById("zoom-status") as HTMLDivElement;

type SpeechRecognitionState = {
  transcript: string;
  isRunning: boolean;
  isFinal: boolean;
  error?: string;
  authorized?: boolean;
  speechAuthorized?: boolean;
  microphoneAuthorized?: boolean;
  permissionPromptPending?: boolean;
};

type AppCaptionState = {
  transcript: string;
  lastFinalTranscript: string;
  lastFinalSegmentId?: string;
  isRunning: boolean;
  audioSampleCount?: number;
  lastAudioAtMs?: number;
  audioLevel?: number;
  error?: string;
  authorized?: boolean;
  speechAuthorized?: boolean;
  screenAuthorized?: boolean;
  permissionPromptPending?: boolean;
  sourceApp?: string;
  captureMode?: string;
};

type OverlayCaption = {
  id: string;
  original: string;
  translated: string;
};

type CaptionRetryState = {
  attempts: number;
  nextRetryAt: number;
};

let speechPollTimer: number | null = null;
let isSpeechRecording = false;
let isSpeechPolling = false;
let appCaptionPollTimer: number | null = null;
let isAppCaptionsRunning = false;
let isAppCaptionPolling = false;
let overlayCaptions: OverlayCaption[] = [];
let translatedCaptionSegmentIds = new Set<string>();
let pendingCaptionSegmentIds = new Set<string>();
let captionRetryStates = new Map<string, CaptionRetryState>();

// ─── Auto-detect helper ─────────────────────────────
type LangConfig = { targetLang: string; autoLangPair?: { myLang: string; pairLang: string } };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return String(error);
}

async function resolveLangConfig(): Promise<LangConfig> {
  const selected = langSelect.value;
  if (selected !== "auto") return { targetLang: selected };

  const myLang = await getSetting(SETTINGS_KEYS.myLang, DEFAULTS.myLang);
  const pairLang = await getSetting(SETTINGS_KEYS.pairLang, DEFAULTS.pairLang);
  return { targetLang: myLang, autoLangPair: { myLang, pairLang } };
}

async function handleImageTranslateFromClipboard(emptyMessage: string): Promise<void> {
  try {
    const imageBase64 = await invoke<string | null>("read_clipboard_image");
    if (!imageBase64) {
      addEntry({ original: "(이미지 없음)", translated: emptyMessage });
      return;
    }

    chat.appendChild(renderLoading("(이미지 번역 중…)"));
    chat.scrollTop = chat.scrollHeight;

    try {
      const { targetLang, autoLangPair } = await resolveLangConfig();
      const translationResult = await translateImage(imageBase64, targetLang, autoLangPair);

      addEntry({
        original: "(이미지)",
        translated: translationResult.translatedText,
        isImage: true,
        imageBase64,
        imageExtractedText: translationResult.extractedText,
      });
    } catch (e) {
      removeLoading();
      addEntry({ original: "(이미지)", translated: `[오류] ${getErrorMessage(e)}`, isImage: true, imageBase64 });
    }
  } catch (e) {
    console.error("Image clipboard read error:", e);
  }
}

function syncInputHeight(): void {
  inputField.style.height = "auto";
  inputField.style.height = Math.min(inputField.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
}

function updateSpeechUi(statusText: string, recording: boolean): void {
  speechStatus.textContent = statusText;
  speechStatus.classList.toggle("recording", recording);
  btnMic.classList.toggle("recording", recording);
  btnMic.textContent = recording ? "⏹ 음성 중지" : "🎙 음성 입력";
}

function updateAppCaptionUi(statusText: string, streaming: boolean): void {
  appCaptionStatus.textContent = statusText;
  appCaptionStatus.classList.toggle("streaming", streaming);
  btnAppCaptions.classList.toggle("streaming", streaming);
  btnAppCaptions.textContent = streaming ? "⏹ 회의 자막 중지" : "🖥 회의 자막";
}

function formatAppCaptionDebug(state: AppCaptionState): string {
  const samples = state.audioSampleCount ?? 0;
  const level = state.audioLevel ?? 0;
  if (!samples) {
    return "오디오 샘플 없음";
  }
  return `오디오 수신 중 · samples ${samples} · level ${level.toFixed(3)}`;
}

function applySpeechTranscript(state: SpeechRecognitionState): void {
  inputField.value = state.transcript;
  syncInputHeight();
  if (state.transcript) {
    inputField.focus();
  }
}

function stopSpeechPolling(): void {
  if (speechPollTimer !== null) {
    window.clearTimeout(speechPollTimer);
    speechPollTimer = null;
  }
  isSpeechPolling = false;
}

function stopAppCaptionPolling(): void {
  if (appCaptionPollTimer !== null) {
    window.clearTimeout(appCaptionPollTimer);
    appCaptionPollTimer = null;
  }
  isAppCaptionPolling = false;
}

function scheduleSpeechPoll(delayMs = 350): void {
  stopSpeechPolling();
  speechPollTimer = window.setTimeout(() => {
    void pollSpeechState();
  }, delayMs);
}

function scheduleAppCaptionPoll(delayMs = 450): void {
  stopAppCaptionPolling();
  appCaptionPollTimer = window.setTimeout(() => {
    void pollAppCaptionState();
  }, delayMs);
}

function renderCaptionsInChat(): void {
  // Remove existing caption sections
  chat.querySelectorAll(".caption-section").forEach(el => el.remove());

  for (const cap of overlayCaptions) {
    const section = document.createElement("div");
    section.className = "caption-section";
    section.dataset.captionId = cap.id;

    const origDiv = document.createElement("div");
    origDiv.className = "caption-original";
    origDiv.textContent = cap.original;
    section.appendChild(origDiv);

    const transDiv = document.createElement("div");
    transDiv.className = "caption-translation";
    transDiv.textContent = cap.translated;
    if (cap.id === "__partial__") transDiv.classList.add("caption-partial");
    section.appendChild(transDiv);

    chat.appendChild(section);
  }
  chat.scrollTop = chat.scrollHeight;
}

function pushOverlayCaption(original: string, translated: string, id: string): void {
  overlayCaptions = [
    ...overlayCaptions.filter(item => item.id !== id),
    { id, original, translated },
  ].slice(-5);
}

function resetAppCaptionSession(): void {
  overlayCaptions = [];
  translatedCaptionSegmentIds = new Set<string>();
  pendingCaptionSegmentIds = new Set<string>();
  captionRetryStates = new Map<string, CaptionRetryState>();
}

async function stopSpeechInput(): Promise<void> {
  stopSpeechPolling();
  isSpeechRecording = false;

  try {
    const state = await invoke<SpeechRecognitionState>("stop_speech_recognition");
    applySpeechTranscript(state);
    updateSpeechUi(state.error || "", false);
  } catch (e) {
    updateSpeechUi(getErrorMessage(e), false);
  }
}

async function stopAppCaptions(): Promise<void> {
  stopAppCaptionPolling();
  isAppCaptionsRunning = false;

  try {
    const state = await invoke<AppCaptionState>("stop_app_captions");
    updateAppCaptionUi(state.error || "", false);
  } catch (e) {
    updateAppCaptionUi(getErrorMessage(e), false);
  } finally {
    resetAppCaptionSession();
    renderCaptionsInChat();
  }
}

async function pollSpeechState(): Promise<void> {
  if (isSpeechPolling) {
    return;
  }

  isSpeechPolling = true;

  try {
    const state = await invoke<SpeechRecognitionState>("get_speech_recognition_state");
    applySpeechTranscript(state);

    if (state.error) {
      updateSpeechUi(state.error, false);
      isSpeechRecording = false;
      stopSpeechPolling();
      return;
    }

    if (state.isRunning) {
      updateSpeechUi(state.transcript ? `듣는 중: ${state.transcript}` : "듣는 중…", true);
      if (isSpeechRecording) {
        scheduleSpeechPoll();
      }
      return;
    }

    if (isSpeechRecording) {
      isSpeechRecording = false;
      stopSpeechPolling();
      updateSpeechUi("", false);
    }
  } catch (e) {
    isSpeechRecording = false;
    stopSpeechPolling();
    updateSpeechUi(getErrorMessage(e), false);
  } finally {
    isSpeechPolling = false;
  }
}

async function translateAppCaptionFinal(state: AppCaptionState): Promise<void> {
  if (!state.lastFinalTranscript || !state.lastFinalSegmentId) {
    return;
  }

  const segmentId = state.lastFinalSegmentId;
  if (translatedCaptionSegmentIds.has(segmentId) || pendingCaptionSegmentIds.has(segmentId)) {
    return;
  }

  const retryState = captionRetryStates.get(segmentId);
  if (retryState && retryState.nextRetryAt > Date.now()) {
    return;
  }

  pendingCaptionSegmentIds.add(segmentId);

  // Remove partial entry now that we have a final
  overlayCaptions = overlayCaptions.filter(c => c.id !== "__partial__");

  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    const translated = await translate(state.lastFinalTranscript, targetLang, autoLangPair);
    translatedCaptionSegmentIds.add(segmentId);
    captionRetryStates.delete(segmentId);
    pushOverlayCaption(state.lastFinalTranscript, translated, segmentId);
    renderCaptionsInChat();
  } catch (e) {
    const attempts = (retryState?.attempts ?? 0) + 1;
    captionRetryStates.set(segmentId, {
      attempts,
      nextRetryAt: Date.now() + Math.min(1000 * (2 ** Math.min(attempts, 3)), 5000),
    });
    pushOverlayCaption(state.lastFinalTranscript, `[오류] ${getErrorMessage(e)} · 재시도 중`, segmentId);
    renderCaptionsInChat();
  } finally {
    pendingCaptionSegmentIds.delete(segmentId);
  }
}

async function pollAppCaptionState(): Promise<void> {
  if (isAppCaptionPolling) {
    return;
  }

  isAppCaptionPolling = true;

  try {
    const state = await invoke<AppCaptionState>("get_app_caption_state");

    if (state.error && !state.isRunning) {
      updateAppCaptionUi(state.error, false);
      isAppCaptionsRunning = false;
      stopAppCaptionPolling();
      return;
    }

    if (state.isRunning) {
      updateAppCaptionUi(
        state.transcript
          ? `${state.sourceApp || "선택 앱"} 듣는 중: ${state.transcript} · ${formatAppCaptionDebug(state)}`
          : `${state.sourceApp || "선택 앱"} 오디오 상태: ${formatAppCaptionDebug(state)}`,
        true,
      );

      // Show partial transcript in overlay as temporary caption
      if (state.transcript) {
        pushOverlayCaption(state.transcript, "…", "__partial__");
        renderCaptionsInChat();
      }

      await translateAppCaptionFinal(state);

      if (!state.transcript) {
        overlayCaptions = overlayCaptions.filter(c => c.id !== "__partial__");
        renderCaptionsInChat();
      }

      if (isAppCaptionsRunning) {
        scheduleAppCaptionPoll();
      }
      return;
    }

    if (isAppCaptionsRunning) {
      isAppCaptionsRunning = false;
      stopAppCaptionPolling();
      updateAppCaptionUi("", false);
    }
  } catch (e) {
    isAppCaptionsRunning = false;
    stopAppCaptionPolling();
    updateAppCaptionUi(getErrorMessage(e), false);
  } finally {
    isAppCaptionPolling = false;
  }
}

async function startSpeechInput(): Promise<void> {
  const permissions = await invoke<SpeechRecognitionState>("request_speech_permissions");
  if (!permissions.authorized) {
    throw new Error(permissions.error || "음성 입력 권한이 필요합니다.");
  }

  const savedSpeechLocale = await getSetting(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  const localeIdentifier = savedSpeechLocale === "system"
    ? (navigator.language || "ko-KR")
    : savedSpeechLocale;
  const state = await invoke<SpeechRecognitionState>("start_speech_recognition", { localeIdentifier });
  if (state.error) {
    throw new Error(state.error);
  }

  isSpeechRecording = true;
  applySpeechTranscript(state);
  updateSpeechUi("듣는 중…", true);
  scheduleSpeechPoll();
}

async function startAppCaptions(): Promise<void> {
  const savedSpeechLocale = await getSetting(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  const captureMode = await getSetting(SETTINGS_KEYS.captureMode, DEFAULTS.captureMode);
  const selectedCaptureWindow = await getSetting(SETTINGS_KEYS.captureWindow, DEFAULTS.captureWindow);
  const selectedCaptureAudioDevice = await getSetting(SETTINGS_KEYS.captureAudioDevice, DEFAULTS.captureAudioDevice);
  const permissions = await invoke<AppCaptionState>("request_caption_capture_permissions", { captureMode });
  if (!permissions.authorized) {
    throw new Error(permissions.error || "앱 자막 권한이 필요합니다.");
  }
  const localeIdentifier = savedSpeechLocale === "system"
    ? (navigator.language || "ko-KR")
    : savedSpeechLocale;

  resetAppCaptionSession();
  renderCaptionsInChat();

  const state = await invoke<AppCaptionState>("start_app_captions", {
    localeIdentifier,
    captureMode,
    windowIdentifier: selectedCaptureWindow || null,
    audioDeviceIdentifier: selectedCaptureAudioDevice || null,
  });
  if (state.error) {
    throw new Error(state.error);
  }

  isAppCaptionsRunning = true;
  updateAppCaptionUi(`${state.sourceApp || "선택 앱"} 오디오를 기다리는 중…`, true);
  scheduleAppCaptionPoll(200);
}

// ─── Translation submit ─────────────────────────────
async function handleSubmit(): Promise<void> {
  const text = inputField.value.trim();
  if (!text) return;

  inputField.value = "";
  chat.appendChild(renderLoading(text));
  chat.scrollTop = chat.scrollHeight;

  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    const result = await translate(text, targetLang, autoLangPair);
    addEntry({ original: text, translated: result });
  } catch (e) {
    removeLoading();
    addEntry({ original: text, translated: `[오류] ${getErrorMessage(e)}` });
  }
}

// ─── Quick reply ────────────────────────────────────
btnMic.addEventListener("click", async () => {
  btnMic.disabled = true;
  try {
    if (isSpeechRecording) {
      await stopSpeechInput();
    } else {
      await startSpeechInput();
    }
  } catch (e) {
    isSpeechRecording = false;
    stopSpeechPolling();
    updateSpeechUi(getErrorMessage(e), false);
  } finally {
    btnMic.disabled = false;
  }
});

btnAppCaptions.addEventListener("click", async () => {
  btnAppCaptions.disabled = true;
  try {
    if (isAppCaptionsRunning) {
      await stopAppCaptions();
    } else {
      await startAppCaptions();
    }
  } catch (e) {
    isAppCaptionsRunning = false;
    stopAppCaptionPolling();
    updateAppCaptionUi(getErrorMessage(e), false);
  } finally {
    btnAppCaptions.disabled = false;
  }
});

btnSuggest.addEventListener("click", async () => {
  if (chatHistory.length === 0) return;
  const last = chatHistory[chatHistory.length - 1];
  btnSuggest.textContent = "생성 중…";
  btnSuggest.disabled = true;

  try {
    const suggestions = await suggestReplies(last.original, last.translated);
    if (suggestions.length > 0) {
      const section = document.createElement("div");
      section.className = "suggest-section";
      section.innerHTML = `<div class="suggest-label">빠른 답장</div>`;
      for (const s of suggestions) {
        for (const [label, text] of [["KR", s.kr], ["JP", s.jp]] as const) {
          const btn = document.createElement("div");
          btn.className = "suggest-btn";
          btn.textContent = `${label}: ${text}`;
          btn.addEventListener("click", async () => {
            await writeTextToClipboard(text).catch(() => {});
            document.querySelectorAll<HTMLElement>(".suggest-btn").forEach(b => {
              if (b.textContent?.startsWith("\u2713")) {
                b.textContent = b.dataset.orig || "";
              }
            });
            btn.dataset.orig = btn.textContent || "";
            btn.textContent = "\u2713 " + btn.textContent;
          });
          section.appendChild(btn);
        }
      }
      chat.appendChild(section);
      chat.scrollTop = chat.scrollHeight;
    }
  } catch (e) {
    console.error("Suggest error:", e);
  }

  btnSuggest.textContent = "💬 빠른 답장";
  btnSuggest.disabled = false;
});

// ─── Summarize ──────────────────────────────────────
btnSummarize.addEventListener("click", async () => {
  if (chatHistory.length === 0) return;
  const last = chatHistory[chatHistory.length - 1];
  btnSummarize.textContent = "생성 중…";
  btnSummarize.disabled = true;

  try {
    const result = await summarize(last.original, last.translated);
    if (result) {
      const section = document.createElement("div");
      section.className = "suggest-section";
      section.innerHTML = `<div class="suggest-label">내용 요약</div>`;
      const content = document.createElement("div");
      content.className = "summary-content";
      content.textContent = result;
      section.appendChild(content);
      chat.appendChild(section);
      chat.scrollTop = chat.scrollHeight;
    }
  } catch (e) {
    console.error("Summarize error:", e);
  }

  btnSummarize.textContent = "📋 요약";
  btnSummarize.disabled = false;
});

// ─── Clear ──────────────────────────────────────────
btnClear.addEventListener("click", clearChat);

// ─── Input handling ─────────────────────────────────
inputField.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
});

// Auto-resize textarea
inputField.addEventListener("input", () => {
  syncInputHeight();
});


// ─── Event listeners ────────────────────────────────
listen("global-translate", async () => {
  try {
    // 1. Check for HTML table in clipboard
    let tableHtml: string | null = null;
    try {
      tableHtml = await invoke<string | null>("read_clipboard_html");
    } catch (e) {
      console.error("HTML clipboard read error:", e);
    }

    if (tableHtml) {
      let clipText: string | null = null;
      try { clipText = await readText(); } catch {}
      const displayText = clipText?.trim() || "(테이블)";
      chat.appendChild(renderLoading(displayText));
      chat.scrollTop = chat.scrollHeight;
      try {
        const { targetLang, autoLangPair } = await resolveLangConfig();
        const result = await translateTable(tableHtml, targetLang, autoLangPair);
        addEntry({ original: displayText, translated: result, isTable: true, originalHtml: tableHtml });
      } catch (e) {
        removeLoading();
        addEntry({ original: displayText, translated: `[오류] ${getErrorMessage(e)}` });
      }
      return;
    }

    // 2. Check for text
    let clipText: string | null = null;
    try {
      clipText = await readText();
    } catch {}

    if (clipText && clipText.trim()) {
      const text = clipText.trim();
      chat.appendChild(renderLoading(text));
      chat.scrollTop = chat.scrollHeight;
      try {
        const { targetLang, autoLangPair } = await resolveLangConfig();
        const result = await translate(text, targetLang, autoLangPair);
        addEntry({ original: text, translated: result });
      } catch (e) {
        removeLoading();
        addEntry({ original: text, translated: `[오류] ${getErrorMessage(e)}` });
      }
      return;
    }

    // 3. Check for image (이미지는 언어 감지 불가 → 설정 기반)
    await handleImageTranslateFromClipboard("번역할 텍스트, 테이블, 또는 이미지를 복사한 후 다시 시도해주세요.");
  } catch (e) {
    console.error("Clipboard read error:", e);
  }
});

listen("global-translate-image", async () => {
  await handleImageTranslateFromClipboard("영역 캡처가 취소되었거나 이미지가 클립보드에 없습니다.");
});

// ─── Populate select elements ───────────────────────
function populateSelect(select: HTMLSelectElement, items: { value: string; label: string }[]): void {
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }
}

populateSelect(langSelect, LANGUAGES);

// ─── Restore language preference ────────────────────
(async () => {
  const savedLang = await getSetting(SETTINGS_KEYS.targetLanguage, DEFAULTS.targetLanguage);
  langSelect.value = savedLang;
})();

langSelect.addEventListener("change", () => {
  setSetting(SETTINGS_KEYS.targetLanguage, langSelect.value);
});

// ─── Titlebar drag ──────────────────────────────────
const titlebar = document.getElementById("titlebar")!;
titlebar.addEventListener("mousedown", async (e: MouseEvent) => {
  if (e.buttons === 1) {
    await invoke("plugin:window|start_dragging");
  }
});

// ─── Focus input on window show ─────────────────────
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    inputField.focus();
  }
});
