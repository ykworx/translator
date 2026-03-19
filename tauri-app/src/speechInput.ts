import type { SpeechRecognitionState } from "./types";
import { getSetting } from "./store";
import { DEFAULTS, SETTINGS_KEYS } from "./constants";
import { getErrorMessage } from "./utils";

const { invoke } = window.__TAURI__.core;

let speechPollTimer: number | null = null;
let isSpeechRecording = false;
let isSpeechPolling = false;

let inputField: HTMLTextAreaElement;
let speechStatus: HTMLDivElement;
let btnMic: HTMLButtonElement;
let syncInputHeight: () => void;

function updateSpeechUi(statusText: string, recording: boolean): void {
  speechStatus.textContent = statusText;
  speechStatus.classList.toggle("recording", recording);
  btnMic.classList.toggle("recording", recording);
  btnMic.textContent = recording ? "⏹ 음성 중지" : "🎙 음성 입력";
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

function scheduleSpeechPoll(delayMs = 350): void {
  stopSpeechPolling();
  speechPollTimer = window.setTimeout(() => {
    void pollSpeechState();
  }, delayMs);
}

async function pollSpeechState(): Promise<void> {
  if (isSpeechPolling) return;
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
}
