import type { AppCaptionState, OverlayCaption, CaptionRetryState, LangConfig } from "./types";
import { getSetting } from "./store";
import { translate, translateStream } from "./api";
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
let sessionStartTime = 0; // timestamp when caption session started
let elapsedTimerInterval: number | null = null;

function formatElapsed(ts?: number): string {
  if (!ts || !sessionStartTime) return "00:00";
  const elapsed = Math.max(0, Math.floor((ts - sessionStartTime) / 1000));
  const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function formatElapsedNow(): string {
  if (!sessionStartTime) return "00:00";
  const elapsed = Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000));
  const m = Math.floor(elapsed / 60).toString().padStart(2, "0");
  const s = (elapsed % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

let chat: HTMLElement;
let appCaptionStatus: HTMLDivElement;
let btnAppCaptions: HTMLButtonElement;
let resolveLangConfig: () => Promise<LangConfig>;

function updateAppCaptionUi(statusText: string, streaming: boolean): void {
  if (streaming && sessionStartTime) {
    appCaptionStatus.textContent = `${statusText} · ${formatElapsedNow()}`;
  } else {
    appCaptionStatus.textContent = statusText;
  }
  appCaptionStatus.classList.toggle("streaming", streaming);
  btnAppCaptions.classList.toggle("streaming", streaming);
  btnAppCaptions.textContent = streaming ? "⏹ 중지" : "🖥 자막";
}

// ─── Typing effect queue ─────────────────────────
const typingQueues = new Map<string, { target: string; displayed: number; timer: number | null; el: HTMLElement }>();
const TYPING_INTERVAL = 30; // ms per character

function enqueueTyping(key: string, el: HTMLElement, targetText: string): void {
  const existing = typingQueues.get(key);

  // If element changed or text doesn't extend current, reset
  if (!existing || existing.el !== el || !targetText.startsWith(targetText.slice(0, existing.displayed))) {
    if (existing?.timer) clearInterval(existing.timer);
    // Clear element, add cursor
    el.textContent = "";
    const cursor = document.createElement("span");
    cursor.className = "caption-cursor";
    el.appendChild(cursor);

    const state = { target: targetText, displayed: 0, timer: null as number | null, el };
    typingQueues.set(key, state);
    startTyping(key, state);
    return;
  }

  // Extend target — typing continues from where it left off
  existing.target = targetText;
  if (!existing.timer) {
    startTyping(key, existing);
  }
}

function startTyping(key: string, state: { target: string; displayed: number; timer: number | null; el: HTMLElement }): void {
  state.timer = window.setInterval(() => {
    if (state.displayed >= state.target.length) {
      // Done typing
      if (state.timer) { clearInterval(state.timer); state.timer = null; }
      return;
    }

    const char = state.target[state.displayed];
    state.displayed++;

    // Insert character before cursor
    const cursor = state.el.querySelector(".caption-cursor");
    const charSpan = document.createElement("span");
    charSpan.className = "caption-char-new";
    charSpan.textContent = char;
    if (cursor) {
      state.el.insertBefore(charSpan, cursor);
    } else {
      state.el.appendChild(charSpan);
    }

    // Auto-scroll
    chat.scrollTop = chat.scrollHeight;
  }, TYPING_INTERVAL);
}

function clearTypingQueue(key: string): void {
  const existing = typingQueues.get(key);
  if (existing?.timer) clearInterval(existing.timer);
  typingQueues.delete(key);
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

    const timeStr = formatElapsed(cap.timestamp);

    if (el) {
      if (el.dataset.captionId !== cap.id) el.dataset.captionId = cap.id;
      const timeEl = el.querySelector(".caption-time") as HTMLElement;
      const origDiv = el.querySelector(".caption-original") as HTMLElement;
      const transDiv = el.querySelector(".caption-translation") as HTMLElement;
      if (timeEl && timeEl.textContent !== timeStr) timeEl.textContent = timeStr;
      if (origDiv) {
        const origText = origDiv.dataset.rawText || "";
        if (origText !== cap.original) {
          origDiv.dataset.rawText = cap.original;
          // Badge + text for all cards
          let badge = origDiv.querySelector(".caption-badge") as HTMLElement;
          if (!badge) {
            origDiv.innerHTML = "";
            badge = document.createElement("span");
            badge.className = "caption-badge";
            origDiv.appendChild(badge);
            const span = document.createElement("span");
            span.className = "caption-orig-text";
            origDiv.appendChild(span);
          }
          badge.textContent = timeStr;
          const textSpan = origDiv.querySelector(".caption-orig-text");
          if (textSpan) textSpan.textContent = cap.original;
        }
        // Update badge time for partial (live update)
        if (cap.id === "__partial__") {
          const badge = origDiv.querySelector(".caption-badge") as HTMLElement;
          if (badge) badge.textContent = formatElapsedNow();
        }
      }
      if (transDiv) {
        const targetText = cap.translated;
        const queueKey = cap.id;
        if (targetText !== (transDiv.dataset.fullText || "")) {
          transDiv.dataset.fullText = targetText;
          enqueueTyping(queueKey, transDiv, targetText);
        }
      }
      if (cap.id === "__partial__") transDiv?.classList.add("caption-partial");
      else transDiv?.classList.remove("caption-partial");
    } else {
      const section = document.createElement("div");
      section.className = "caption-section";
      section.dataset.captionId = cap.id;

      const origDiv = document.createElement("div");
      origDiv.className = "caption-original";
      origDiv.dataset.rawText = cap.original;
      const badge = document.createElement("span");
      badge.className = "caption-badge";
      badge.textContent = timeStr;
      origDiv.appendChild(badge);
      const origText = document.createElement("span");
      origText.className = "caption-orig-text";
      origText.textContent = cap.original;
      origDiv.appendChild(origText);
      section.appendChild(origDiv);

      const transDiv = document.createElement("div");
      transDiv.className = "caption-translation";
      transDiv.textContent = cap.translated;
      transDiv.dataset.fullText = cap.translated;
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
  const now = Date.now();
  if (id !== "__partial__") {
    const partialIdx = overlayCaptions.findIndex(c => c.id === "__partial__");
    if (partialIdx !== -1) {
      overlayCaptions[partialIdx] = { id, original, translated, timestamp: overlayCaptions[partialIdx].timestamp || now };
      return;
    }
  }
  const existingIdx = overlayCaptions.findIndex(c => c.id === id);
  if (existingIdx !== -1) {
    overlayCaptions[existingIdx] = { id, original, translated, timestamp: overlayCaptions[existingIdx].timestamp };
  } else {
    overlayCaptions.push({ id, original, translated, timestamp: now });
  }
}

function resetAppCaptionSession(): void {
  for (const key of typingQueues.keys()) clearTypingQueue(key);
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
  if (elapsedTimerInterval !== null) {
    window.clearInterval(elapsedTimerInterval);
    elapsedTimerInterval = null;
  }
  sessionStartTime = 0;
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
  // Remove earlier pending segment cards (they'll be merged into the last one)
  const segmentId = segmentIds[segmentIds.length - 1];
  for (let i = 0; i < segmentIds.length - 1; i++) {
    const oldId = segmentIds[i];
    overlayCaptions = overlayCaptions.filter(c => c.id !== oldId);
    translatedCaptionSegmentIds.add(oldId); // mark as handled
    clearTypingQueue(oldId);
  }
  scheduleRenderCaptions();
  doTranslate(text, segmentId);
}

async function doTranslate(text: string, segmentId: string): Promise<void> {
  pendingCaptionSegmentIds.add(segmentId);

  // Show empty translation with cursor (streaming will fill it)
  pushOverlayCaption(text, "", segmentId);
  scheduleRenderCaptions();

  const retryState = captionRetryStates.get(segmentId);
  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    const recentContext = overlayCaptions
      .filter(c => c.id !== "__partial__" && c.id !== segmentId)
      .slice(-2)
      .map(c => c.original)
      .join("\n");
    const translated = await translateStream(
      text,
      targetLang,
      (partial) => {
        pushOverlayCaption(text, partial, segmentId);
        // Mark as streaming in DOM
        const el = chat.querySelector(`[data-caption-id="${segmentId}"] .caption-translation`);
        el?.classList.add("caption-streaming");
        scheduleRenderCaptions();
      },
      autoLangPair,
      recentContext || undefined,
    );
    translatedCaptionSegmentIds.add(segmentId);
    captionRetryStates.delete(segmentId);
    pushOverlayCaption(text, translated, segmentId);
    // Let typing queue finish, then remove streaming style + cursor
    const typingState = typingQueues.get(segmentId);
    const finishUp = () => {
      const el = chat.querySelector(`[data-caption-id="${segmentId}"] .caption-translation`);
      el?.classList.remove("caption-streaming");
      el?.querySelector(".caption-cursor")?.remove();
      clearTypingQueue(segmentId);
    };
    if (typingState && typingState.displayed < typingState.target.length) {
      // Wait for typing to complete (timeout guard: 10s max)
      let elapsed = 0;
      const waitForTyping = setInterval(() => {
        elapsed += 50;
        if (!typingState.timer || typingState.displayed >= typingState.target.length || elapsed >= 10000) {
          clearInterval(waitForTyping);
          finishUp();
        }
      }, 50);
    } else {
      finishUp();
    }
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
  // Don't create a card for pending short segments — wait for merge or flush
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
      console.log("[caption-partial]", state.transcript);
      pushOverlayCaption(state.transcript, "", "__partial__");
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

  // Set domain hint before starting
  const domainHint = await getSetting(SETTINGS_KEYS.domainHint, DEFAULTS.domainHint);
  if (domainHint) {
    await invoke("set_whisper_domain_hint", { hint: domainHint });
  }

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
  sessionStartTime = Date.now();

  // Update elapsed timer every second
  if (elapsedTimerInterval !== null) window.clearInterval(elapsedTimerInterval);
  elapsedTimerInterval = window.setInterval(() => {
    if (isAppCaptionsRunning) {
      updateAppCaptionUi(`${state.sourceApp || "선택 앱"} 듣는 중`, true);
    }
  }, 1000);

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
