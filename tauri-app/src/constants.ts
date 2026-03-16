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

/** Available Gemini models */
export const MODELS = [
  { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
  { value: "gemini-2.0-flash-lite", label: "gemini-2.0-flash-lite" },
  { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
];

/** Store keys for persisted settings */
export const SETTINGS_KEYS = {
  apiKey: "apiKey",
  myLang: "myLang",
  pairLang: "pairLang",
  model: "model",
  speechLocale: "speechLocale",
  targetLanguage: "targetLanguage",
  selectShortcut: "selectShortcut",
  clipboardShortcut: "clipboardShortcut",
} as const;

/** Default settings values */
export const DEFAULTS = {
  apiKey: "",
  myLang: "한국어",
  pairLang: "日本語",
  model: "gemini-2.0-flash",
  speechLocale: "system",
  targetLanguage: "auto",
  selectShortcut: "Super+Ctrl+KeyT",
  clipboardShortcut: "Super+Ctrl+Shift+KeyT",
} as const;

/** UI constants */
export const MAX_TEXTAREA_HEIGHT = 195;
export const COPY_FEEDBACK_MS = 1200;
