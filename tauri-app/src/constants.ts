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

/** Available Gemini models */
export const MODELS = [
  { value: "gemini-2.0-flash", label: "gemini-2.0-flash" },
  { value: "gemini-2.0-flash-lite", label: "gemini-2.0-flash-lite" },
  { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
];

/** Default settings values */
export const DEFAULTS = {
  myLang: "한국어",
  pairLang: "日本語",
  model: "gemini-2.0-flash",
  selectShortcut: "Super+Ctrl+KeyT",
  clipboardShortcut: "Super+Ctrl+Shift+KeyT",
} as const;

/** UI constants */
export const MAX_TEXTAREA_HEIGHT = 195;
export const COPY_FEEDBACK_MS = 1200;
