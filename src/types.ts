export type BackendId = "gemini-native" | "ollama" | "openai";

export type SpeechRecognitionState = {
  transcript: string;
  isRunning: boolean;
  isFinal: boolean;
  error?: string;
  authorized?: boolean;
  modelLoaded?: boolean;
  microphoneAuthorized?: boolean;
  permissionPromptPending?: boolean;
};

export type AppCaptionState = {
  transcript: string;
  lastFinalTranscript: string;
  lastFinalSegmentId?: string;
  isRunning: boolean;
  audioSampleCount?: number;
  lastAudioAtMs?: number;
  audioLevel?: number;
  error?: string;
  authorized?: boolean;
  modelLoaded?: boolean;
  screenAuthorized?: boolean;
  permissionPromptPending?: boolean;
  sourceApp?: string;
  captureMode?: string;
};

export type OverlayCaption = {
  id: string;
  original: string;
  translated: string;
  timestamp?: number;
};

export type CaptionRetryState = {
  attempts: number;
  nextRetryAt: number;
};

export type LangConfig = {
  targetLang: string;
  autoLangPair?: { myLang: string; pairLang: string };
};
