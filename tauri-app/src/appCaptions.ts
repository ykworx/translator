import type { AppCaptionState, OverlayCaption, CaptionRetryState, LangConfig } from "./types";
import { getSetting } from "./store";
import { translate } from "./api";
import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getErrorMessage } from "./utils";

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

const MIN_TRANSLATION_LENGTH = 4;
const TRANSLATION_FLUSH_DELAY = 3000;

let isAppCaptionsRunning = false;
let appCaptionUnlisten: (() => void) | null = null;
let overlayCaptions: OverlayCaption[] = [];
let translatedCaptionSegmentIds = new Set<string>();
let pendingCaptionSegmentIds = new Set<string>();
let captionRetryStates = new Map<string, CaptionRetryState>();
let pendingTranslationBuffer = "";
let pendingTranslationSegmentIds: string[] = [];
let pendingTranslationTimer: number | null = null;
let renderRafId = 0;

let chat: HTMLElement;
let appCaptionStatus: HTMLDivElement;
let btnAppCaptions: HTMLButtonElement;
let resolveLangConfig: () => Promise<LangConfig>;

function updateAppCaptionUi(statusText: string, streaming: boolean): void {
  appCaptionStatus.textContent = statusText;
  appCaptionStatus.classList.toggle("streaming", streaming);
  btnAppCaptions.classList.toggle("streaming", streaming);
  btnAppCaptions.textContent = streaming ? "⏹ 실시간 번역 중지" : "🖥 실시간 번역";
}

function scheduleRenderCaptions(): void {
  if (renderRafId) return;
  renderRafId = requestAnimationFrame(() => {
    renderRafId = 0;
    renderCaptionsInChat();
  });
}

function renderCaptionsInChat(): void {
  const existingEls = Array.from(chat.querySelectorAll<HTMLElement>(".caption-section"));

  for (let i = 0; i < overlayCaptions.length; i++) {
    const cap = overlayCaptions[i];
    const el = existingEls[i];

    if (el) {
      if (el.dataset.captionId !== cap.id) el.dataset.captionId = cap.id;
      const origDiv = el.querySelector(".caption-original") as HTMLElement;
      const transDiv = el.querySelector(".caption-translation") as HTMLElement;
      if (origDiv && origDiv.textContent !== cap.original) origDiv.textContent = cap.original;
      if (transDiv && transDiv.textContent !== cap.translated) transDiv.textContent = cap.translated;
      if (cap.id === "__partial__") transDiv?.classList.add("caption-partial");
      else transDiv?.classList.remove("caption-partial");
    } else {
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
  }

  for (let i = overlayCaptions.length; i < existingEls.length; i++) {
    existingEls[i].remove();
  }

  chat.scrollTop = chat.scrollHeight;
}

function pushOverlayCaption(original: string, translated: string, id: string): void {
  if (id !== "__partial__") {
    const partialIdx = overlayCaptions.findIndex(c => c.id === "__partial__");
    if (partialIdx !== -1) {
      overlayCaptions[partialIdx] = { id, original, translated };
      return;
    }
  }
  const existingIdx = overlayCaptions.findIndex(c => c.id === id);
  if (existingIdx !== -1) {
    overlayCaptions[existingIdx] = { id, original, translated };
  } else {
    overlayCaptions.push({ id, original, translated });
  }
}

function resetAppCaptionSession(): void {
  overlayCaptions = [];
  translatedCaptionSegmentIds = new Set<string>();
  pendingCaptionSegmentIds = new Set<string>();
  captionRetryStates = new Map<string, CaptionRetryState>();
  pendingTranslationBuffer = "";
  pendingTranslationSegmentIds = [];
  if (pendingTranslationTimer !== null) {
    window.clearTimeout(pendingTranslationTimer);
    pendingTranslationTimer = null;
  }
}

function stopAppCaptionListening(): void {
  if (appCaptionUnlisten) {
    appCaptionUnlisten();
    appCaptionUnlisten = null;
  }
}

function flushPendingTranslation(): void {
  if (!pendingTranslationBuffer || pendingTranslationSegmentIds.length === 0) return;
  const text = pendingTranslationBuffer;
  const segmentIds = [...pendingTranslationSegmentIds];
  pendingTranslationBuffer = "";
  pendingTranslationSegmentIds = [];
  if (pendingTranslationTimer !== null) {
    window.clearTimeout(pendingTranslationTimer);
    pendingTranslationTimer = null;
  }
  const segmentId = segmentIds[segmentIds.length - 1];
  doTranslate(text, segmentId);
}

async function doTranslate(text: string, segmentId: string): Promise<void> {
  pendingCaptionSegmentIds.add(segmentId);

  const retryState = captionRetryStates.get(segmentId);
  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    const recentContext = overlayCaptions
      .filter(c => c.id !== "__partial__" && c.id !== segmentId)
      .slice(-2)
      .map(c => c.original)
      .join("\n");
    const translated = await translate(text, targetLang, autoLangPair, recentContext || undefined);
    translatedCaptionSegmentIds.add(segmentId);
    captionRetryStates.delete(segmentId);
    pushOverlayCaption(text, translated, segmentId);
    scheduleRenderCaptions();
  } catch (e) {
    const attempts = (retryState?.attempts ?? 0) + 1;
    captionRetryStates.set(segmentId, {
      attempts,
      nextRetryAt: Date.now() + Math.min(1000 * (2 ** Math.min(attempts, 3)), 5000),
    });
    pushOverlayCaption(text, `[오류] ${getErrorMessage(e)} · 재시도 중`, segmentId);
    scheduleRenderCaptions();
  } finally {
    pendingCaptionSegmentIds.delete(segmentId);
  }
}

async function translateAppCaptionFinal(state: AppCaptionState): Promise<void> {
  if (!state.lastFinalTranscript || !state.lastFinalSegmentId) return;

  const segmentId = state.lastFinalSegmentId;
  if (translatedCaptionSegmentIds.has(segmentId) || pendingCaptionSegmentIds.has(segmentId)) return;

  const retryState = captionRetryStates.get(segmentId);
  if (retryState && retryState.nextRetryAt > Date.now()) return;

  pendingTranslationBuffer = pendingTranslationBuffer
    ? pendingTranslationBuffer + state.lastFinalTranscript
    : state.lastFinalTranscript;
  pendingTranslationSegmentIds.push(segmentId);

  if (pendingTranslationTimer !== null) {
    window.clearTimeout(pendingTranslationTimer);
  }
  pendingTranslationTimer = window.setTimeout(flushPendingTranslation, TRANSLATION_FLUSH_DELAY);

  if (pendingTranslationBuffer.length >= MIN_TRANSLATION_LENGTH) {
    flushPendingTranslation();
  }
}

async function handleAppCaptionUpdate(state: AppCaptionState): Promise<void> {
  if (!isAppCaptionsRunning) return;

  if (state.error && !state.isRunning) {
    updateAppCaptionUi(state.error, false);
    isAppCaptionsRunning = false;
    stopAppCaptionListening();
    return;
  }

  if (state.isRunning) {
    updateAppCaptionUi(
      `${state.sourceApp || "선택 앱"} 듣는 중`,
      true,
    );

    if (state.transcript) {
      pushOverlayCaption(state.transcript, "…", "__partial__");
      scheduleRenderCaptions();
    }

    await translateAppCaptionFinal(state);
    return;
  }

  if (isAppCaptionsRunning) {
    isAppCaptionsRunning = false;
    stopAppCaptionListening();
    updateAppCaptionUi("", false);
  }
}

async function startAppCaptionListener(): Promise<void> {
  stopAppCaptionListening();
  appCaptionUnlisten = await listen("app-caption-update", (event: any) => {
    void handleAppCaptionUpdate(event.payload as AppCaptionState);
  });
}

async function startAppCaptions(): Promise<void> {
  const savedSpeechLocale = await getSetting(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  const captureMode = await getSetting(SETTINGS_KEYS.captureMode, DEFAULTS.captureMode);
  const selectedCaptureWindow = await getSetting(SETTINGS_KEYS.captureWindow, DEFAULTS.captureWindow);
  const permissions = await invoke<AppCaptionState>("request_caption_capture_permissions");
  if (!permissions.authorized) {
    throw new Error(permissions.error || "앱 자막 권한이 필요합니다.");
  }
  const localeIdentifier = savedSpeechLocale === "system"
    ? (navigator.language || "ko-KR")
    : savedSpeechLocale;

  resetAppCaptionSession();
  scheduleRenderCaptions();

  const state = await invoke<AppCaptionState>("start_app_captions", {
    localeIdentifier,
    captureMode,
    windowIdentifier: selectedCaptureWindow || null,
  });
  if (state.error) {
    throw new Error(state.error);
  }

  isAppCaptionsRunning = true;
  updateAppCaptionUi(`${state.sourceApp || "선택 앱"} 오디오를 기다리는 중…`, true);
  await startAppCaptionListener();
}

async function stopAppCaptions(): Promise<void> {
  stopAppCaptionListening();
  isAppCaptionsRunning = false;

  try {
    const state = await invoke<AppCaptionState>("stop_app_captions");
    updateAppCaptionUi(state.error || "", false);
  } catch (e) {
    updateAppCaptionUi(getErrorMessage(e), false);
  } finally {
    resetAppCaptionSession();
    scheduleRenderCaptions();
  }
}

export function initAppCaptions(
  _chat: HTMLElement,
  _appCaptionStatus: HTMLDivElement,
  _btnAppCaptions: HTMLButtonElement,
  _resolveLangConfig: () => Promise<LangConfig>,
): void {
  chat = _chat;
  appCaptionStatus = _appCaptionStatus;
  btnAppCaptions = _btnAppCaptions;
  resolveLangConfig = _resolveLangConfig;

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
      stopAppCaptionListening();
      updateAppCaptionUi(getErrorMessage(e), false);
    } finally {
      btnAppCaptions.disabled = false;
    }
  });
}
