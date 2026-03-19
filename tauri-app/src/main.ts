// ─── Tauri API ───────────────────────────────────────
const { invoke } = window.__TAURI__.core;

// ─── Module imports ──────────────────────────────────
import type { LangConfig } from "./types";
import { getSetting, setSetting } from "./store";
import { writeTextToClipboard } from "./clipboard";
import { suggestReplies, summarize, translate } from "./api";
import { chatHistory, chat, renderLoading, removeLoading, addEntry, clearChat } from "./ui";
import { LANGUAGES, DEFAULTS, MAX_TEXTAREA_HEIGHT, SETTINGS_KEYS } from "./constants";
import { populateSelect, getErrorMessage } from "./utils";
import { initSpeechInput } from "./speechInput";
import { initAppCaptions } from "./appCaptions";
import { initClipboardListeners } from "./clipboardTranslate";

// ─── DOM References ──────────────────────────────────
const inputField = document.getElementById("input-field") as HTMLTextAreaElement;
const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
const btnSuggest = document.getElementById("btn-suggest") as HTMLButtonElement;
const btnSummarize = document.getElementById("btn-summarize") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

// ─── Helpers ─────────────────────────────────────────
function syncInputHeight(): void {
  inputField.style.height = "auto";
  inputField.style.height = Math.min(inputField.scrollHeight, MAX_TEXTAREA_HEIGHT) + "px";
}

async function resolveLangConfig(): Promise<LangConfig> {
  const selected = langSelect.value;
  if (selected !== "auto") return { targetLang: selected };

  const myLang = await getSetting(SETTINGS_KEYS.myLang, DEFAULTS.myLang);
  const pairLang = await getSetting(SETTINGS_KEYS.pairLang, DEFAULTS.pairLang);
  return { targetLang: myLang, autoLangPair: { myLang, pairLang } };
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

// ─── Initialize modules ─────────────────────────────
initSpeechInput(
  inputField,
  document.getElementById("speech-status") as HTMLDivElement,
  document.getElementById("btn-mic") as HTMLButtonElement,
  syncInputHeight,
);

initAppCaptions(
  chat,
  document.getElementById("zoom-status") as HTMLDivElement,
  document.getElementById("btn-zoom-captions") as HTMLButtonElement,
  resolveLangConfig,
);

initClipboardListeners(resolveLangConfig);

// ─── Quick reply ────────────────────────────────────
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

inputField.addEventListener("input", () => {
  syncInputHeight();
});

// ─── Populate select elements ───────────────────────
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
