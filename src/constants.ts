import type { BackendId } from "./types";
import providerDefaults from "./providerDefaults.json";

/** Supported languages for translation */
export const LANGUAGES = [
  { value: "한국어", label: "한국어" },
  { value: "日本語", label: "日本語" },
  { value: "English", label: "English" },
  { value: "中文(简体)", label: "中文(简体)" },
  { value: "中文(繁體)", label: "中文(繁體)" },
  { value: "Español", label: "Español" },
  { value: "Français", label: "Français" },
  { value: "Deutsch", label: "Deutsch" },
];

/** Supported locales for speech input */
export const SPEECH_LOCALES = [
  { value: "system", label: "시스템 기본값" },
  { value: "ko-KR", label: "한국어 (대한민국)" },
  { value: "ja-JP", label: "日本語 (日本)" },
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "zh-CN", label: "中文 (简体)" },
  { value: "zh-TW", label: "中文 (繁體)" },
  { value: "es-ES", label: "Español" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
] as const;

export const CAPTURE_MODES = [
  { value: "window", label: "창 캡처" },
  { value: "app", label: "앱 캡처" },
] as const;

/** Available Gemini models */
export const MODELS = [
  { value: "gemini-3.8-flash", label: "gemini-3.8-flash" },
  { value: "gemini-3.5-flash-lite", label: "gemini-3.5-flash-lite" },
  { value: "gemini-3.6-flash", label: "gemini-3.6-flash" },
];

/** Available OpenAI models (user-selectable in settings) */
export const OPENAI_MODELS = [
  { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  { value: "gpt-4.1", label: "gpt-4.1" },
];

/** Domain hint presets for Whisper speech recognition */
export const DOMAIN_HINTS = [
  { value: "", label: "없음 (기본)" },
  { value: "日本語のドラマ、恋愛、友情、家族、感情表現、日常会話", label: "드라마" },
  { value: "日本語のアニメ、キャラクター名、技名、ファンタジー、学園、冒険", label: "애니메이션" },
  { value: "日本語のドラマ、アニメ、映画の会話。日常会話、感情表現", label: "드라마/애니 (통합)" },
  { value: "일상 대화, 인사, 날씨, 음식, 여행", label: "일상 대화" },
  { value: "뉴스, 정치, 경제, 사회, 국제", label: "뉴스/시사" },
  { value: "비즈니스 회의, 매출, 전략, 프로젝트, 일정", label: "비즈니스 회의" },
  { value: "기술 개발, 소프트웨어, API, 서버, 배포, 버그", label: "기술/개발" },
  { value: "강의, 수업, 교육, 시험, 학습", label: "강의/교육" },
  { value: "의료, 진료, 증상, 처방, 검사", label: "의료" },
  { value: "법률, 계약, 소송, 판결, 규정", label: "법률" },
] as const;

export const WHISPER_MODELS = [
  { value: "medium", label: "Medium (다운로드 약 2.1 GB)" },
  { value: "large-v3-turbo", label: "Large V3 Turbo (다운로드 약 2.8 GB)" },
  { value: "large-v3", label: "Large V3 (다운로드 약 4.3 GB)" },
] as const;

/** Store keys for persisted settings */
export const SETTINGS_KEYS = {
  apiKey: "apiKey",
  myLang: "myLang",
  pairLang: "pairLang",
  model: "model",
  speechLocale: "speechLocale",
  dictationLocale: "dictationLocale",
  dictationHint: "dictationHint",
  dictationMicrophone: "dictationMicrophone",
  dictationIdleSeconds: "dictationIdleSeconds",
  dictationShortcut: "dictationShortcut",
  captureMode: "captureMode",
  captureWindow: "captureWindow",
  targetLanguage: "targetLanguage",
  selectShortcut: "selectShortcut",
  clipboardShortcut: "clipboardShortcut",
  domainHint: "domainHint",
  whisperModel: "whisperModel",
  llmBackendId: "llmBackendId",
  ollamaBaseUrl: "ollamaBaseUrl",
  ollamaModel: "ollamaModel",
  openaiApiKey: "openaiApiKey",
  openaiModel: "openaiModel",
  experimentalCaptions: "experimentalCaptions",
} as const;

/** Default settings values */
export const DEFAULTS = {
  apiKey: "",
  myLang: "한국어",
  pairLang: "日本語",
  model: providerDefaults.geminiModel,
  speechLocale: "ja-JP",
  dictationLocale: "ko-KR",
  dictationHint: "",
  dictationMicrophone: "",
  dictationIdleSeconds: 300,
  dictationShortcut: "Super+Ctrl+KeyD",
  captureMode: "window",
  captureWindow: "",
  targetLanguage: "auto",
  selectShortcut: "Super+Ctrl+KeyT",
  clipboardShortcut: "Super+Ctrl+Shift+KeyT",
  domainHint: "日本語のドラマ、アニメ、映画の会話。日常会話、感情表現、キャラクター名。",
  whisperModel: "large-v3-turbo",
  llmBackendId: "gemini-native" as BackendId,
  ollamaBaseUrl: "http://localhost:11434",
  ollamaModel: "gemma3:4b",
  openaiApiKey: "",
  openaiModel: "gpt-4o-mini",
  experimentalCaptions: false,
} as const;

export const OLLAMA_DEFAULT_MODELS = [
  "gemma3:4b",
  "gemma3:12b",
  "gemma2:9b",
  "llava",
] as const;

/** UI constants */
export const MAX_TEXTAREA_HEIGHT = 195;
export const COPY_FEEDBACK_MS = 1200;
