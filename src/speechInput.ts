import type { SpeechRecognitionState } from "./types";
import { getSetting } from "./store";
import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getErrorMessage } from "./utils";

const { invoke } = window.__TAURI__.core;

let speechPollTimer: number | null = null;
let isSpeechRecording = false;
let isSpeechPolling = false;
let speechSessionId = 0;
let speechStopOperation: Promise<void> | null = null;
let speechFailureReason = "";
let speechStarting = false;
let inputIsComposing = false;
let speechInputDetached = false;
let speechDraft = "";
let lastAppliedInput = "";
let recoveryTranscript = "";
export function isSpeechInputActive(): boolean {
  return speechStarting || isSpeechRecording || speechStopOperation !== null;
}
function notifySpeechActive(): void { document.dispatchEvent(new Event("speech-active-changed")); }
function appendTranscript(draft: string, transcript: string): string {
  return draft + (draft && transcript && !/\s$/.test(draft) ? "\n" : "") + transcript;
}

let inputField: HTMLTextAreaElement;
let speechStatus: HTMLDivElement;
let btnMic: HTMLButtonElement;
let syncInputHeight: () => void;

function updateSpeechUi(statusText: string, recording: boolean): void {
  speechStatus.classList.remove("has-recovery");
  speechStatus.textContent = statusText + (recording && speechInputDetached
    ? " · 편집한 글은 유지합니다. 중지 후 인식 결과를 확인하세요." : "");
  speechStatus.classList.toggle("recording", recording);
  btnMic.classList.toggle("recording", recording);
  btnMic.textContent = recording ? "⏹ 중지" : "🎙 음성";
  btnMic.setAttribute("aria-label", recording ? "이 창의 음성 입력 중지" : "이 창에 음성 입력");
  btnMic.setAttribute("aria-pressed", String(recording));
}

function applySpeechTranscript(state: SpeechRecognitionState): void {
  if (inputIsComposing || inputField.value !== lastAppliedInput) speechInputDetached = true;
  if (speechInputDetached) return;
  const value = appendTranscript(speechDraft, state.transcript);
  if (value === lastAppliedInput) return;
  inputField.value = value;
  lastAppliedInput = value;
  syncInputHeight();
}

function showSpeechRecovery(transcript: string): void {
  if (!speechInputDetached || !transcript) return;
  recoveryTranscript = transcript;
  speechStatus.classList.add("has-recovery");
  btnMic.disabled = true;
  const message = document.createElement("span");
  message.textContent = "편집한 글을 유지했습니다. 인식 결과 전체를 확인한 뒤 추가하거나 버리면 새 녹음을 시작할 수 있습니다.";
  const details = document.createElement("details");
  details.className = "speech-recovery";
  const summary = document.createElement("summary");
  summary.textContent = "인식 결과 확인";
  const preview = document.createElement("pre");
  preview.textContent = transcript;
  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "입력칸 끝에 추가";
  add.disabled = inputIsComposing;
  const discard = document.createElement("button");
  discard.type = "button";
  discard.textContent = "이 인식 결과 버리기";
  const finish = () => {
    recoveryTranscript = "";
    speechStatus.replaceChildren();
    speechStatus.classList.remove("has-recovery");
    btnMic.disabled = false;
    inputField.focus();
    syncInputHeight();
  };
  add.addEventListener("click", () => {
    if (inputIsComposing || isSpeechInputActive()) return;
    inputField.value = appendTranscript(inputField.value, recoveryTranscript);
    finish();
  });
  discard.addEventListener("click", finish);
  details.append(summary, preview, add, discard);
  speechStatus.append(message, details);
}

function stopSpeechPolling(): void {
  if (speechPollTimer !== null) {
    window.clearTimeout(speechPollTimer);
    speechPollTimer = null;
  }
  isSpeechPolling = false;
}

function scheduleSpeechPoll(delayMs = 350): void {
  stopSpeechPolling();
  const sessionId = speechSessionId;
  speechPollTimer = window.setTimeout(() => {
    void pollSpeechState(sessionId);
  }, delayMs);
}

async function pollSpeechState(sessionId: number): Promise<void> {
  if (isSpeechPolling) return;
  if (sessionId !== speechSessionId) return;
  isSpeechPolling = true;

  try {
    const state = await invoke<SpeechRecognitionState>("get_speech_recognition_state");
    if (sessionId !== speechSessionId) return;
    applySpeechTranscript(state);

    if (state.error) {
      await stopSpeechInput(state.error);
      return;
    }

    if (state.isRunning) {
      if (state.transcript) {
        console.log("[speech-partial]", state.transcript);
      }
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
      notifySpeechActive();
      showSpeechRecovery(state.transcript);
    }
  } catch (e) {
    if (sessionId !== speechSessionId) return;
    await stopSpeechInput(getErrorMessage(e));
  } finally {
    if (sessionId === speechSessionId) isSpeechPolling = false;
  }
}

async function startSpeechInput(): Promise<void> {
  speechSessionId += 1;
  speechFailureReason = "";
  const permissions = await invoke<SpeechRecognitionState>("request_speech_permissions");
  if (!permissions.authorized) {
    throw new Error(permissions.error || "음성 입력 권한이 필요합니다.");
  }

  const savedSpeechLocale = await getSetting<string>(SETTINGS_KEYS.speechLocale, DEFAULTS.speechLocale);
  const localeIdentifier = savedSpeechLocale === "system"
    ? (navigator.language || "ko-KR")
    : savedSpeechLocale;

  // Set domain hint
  const domainHint = await getSetting(SETTINGS_KEYS.domainHint, DEFAULTS.domainHint);
  await invoke("set_whisper_domain_hint", { hint: domainHint });

  updateSpeechUi("음성 인식 모델 로드 중…", true);
  try {
    await invoke("ensure_whisper_loaded");
  } catch (e) {
    updateSpeechUi(getErrorMessage(e), false);
    throw e;
  }

  const state = await invoke<SpeechRecognitionState>("start_speech_recognition", { localeIdentifier });
  if (state.error) {
    throw new Error(state.error);
  }

  isSpeechRecording = true;
  applySpeechTranscript(state);
  updateSpeechUi("듣는 중…", true);
  scheduleSpeechPoll();
}

async function stopSpeechInput(reason?: string): Promise<void> {
  if (reason) speechFailureReason = reason;
  if (speechStopOperation) return speechStopOperation;
  const sessionId = ++speechSessionId;
  stopSpeechPolling();
  btnMic.disabled = true;
  updateSpeechUi(speechFailureReason || "마지막 발화 인식 중…", true);
  btnMic.textContent = "마무리 중…";
  speechStopOperation = (async () => {
    try {
      const state = await invoke<SpeechRecognitionState>("stop_speech_recognition");
      if (sessionId !== speechSessionId) return;
      if (state.isRunning) {
        throw new Error(state.error || "녹음이 아직 종료되지 않았습니다.");
      }
      isSpeechRecording = false;
      applySpeechTranscript(state);
      updateSpeechUi(speechFailureReason || state.error || "", false);
      showSpeechRecovery(state.transcript);
    } catch (e) {
      if (sessionId !== speechSessionId) return;
      // The native owner may still be held after a failed IPC/stop. Keep the
      // button in stop mode so the next click retries cleanup, not recording.
      isSpeechRecording = true;
      const retry = `음성 입력을 중지하지 못했습니다. 중지 버튼으로 다시 시도해주세요: ${getErrorMessage(e)}`;
      updateSpeechUi(speechFailureReason ? `${speechFailureReason} ${retry}` : retry, true);
    }
  })();
  try {
    await speechStopOperation;
  } finally {
    speechStopOperation = null;
    btnMic.disabled = !!recoveryTranscript;
    notifySpeechActive();
  }
}

export function initSpeechInput(
  _inputField: HTMLTextAreaElement,
  _speechStatus: HTMLDivElement,
  _btnMic: HTMLButtonElement,
  _syncInputHeight: () => void,
): void {
  inputField = _inputField;
  speechStatus = _speechStatus;
  btnMic = _btnMic;
  syncInputHeight = _syncInputHeight;
  inputField.addEventListener("input", () => {
    if (isSpeechInputActive()) speechInputDetached = true;
  });
  inputField.addEventListener("compositionstart", () => {
    inputIsComposing = true;
    if (isSpeechInputActive()) speechInputDetached = true;
    speechStatus.querySelector<HTMLButtonElement>(".speech-recovery button")?.setAttribute("disabled", "");
  });
  inputField.addEventListener("compositionend", () => {
    inputIsComposing = false;
    speechStatus.querySelector<HTMLButtonElement>(".speech-recovery button")?.removeAttribute("disabled");
  });

  btnMic.addEventListener("click", async () => {
    if (btnMic.disabled || speechStopOperation) return;
    btnMic.disabled = true;
    try {
      if (isSpeechRecording) {
        await stopSpeechInput();
      } else {
        speechDraft = inputField.value;
        lastAppliedInput = speechDraft;
        speechInputDetached = false;
        speechStarting = true;
        notifySpeechActive();
        await startSpeechInput();
      }
    } catch (e) {
      isSpeechRecording = false;
      stopSpeechPolling();
      updateSpeechUi(getErrorMessage(e), false);
    } finally {
      speechStarting = false;
      btnMic.disabled = !!recoveryTranscript;
      notifySpeechActive();
    }
  });
}
