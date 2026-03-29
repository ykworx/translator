// ─── Tauri API ───────────────────────────────────────
const { invoke } = window.__TAURI__.core;

// ─── Module imports ──────────────────────────────────
import type { LangConfig } from "./types";
import { getSetting, setSetting } from "./store";
import { writeTextToClipboard } from "./clipboard";
import { suggestReplies, summarize, translateStream } from "./api";
import type { ChatEntry } from "./ui";
import { chatHistory, chat, addEntry, clearChat, showEmptyState } from "./ui";
import { LANGUAGES, DEFAULTS, MAX_TEXTAREA_HEIGHT, SETTINGS_KEYS } from "./constants";
import { populateSelect, getErrorMessage, escapeHtml } from "./utils";
import { initSpeechInput } from "./speechInput";
import { initAppCaptions } from "./appCaptions";
import { initClipboardListeners } from "./clipboardTranslate";
import { initHandwriting } from "./handwriting";

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
  syncInputHeight();

  // Create a streaming entry
  const entry: ChatEntry = { original: text, translated: "", timestamp: Date.now() };
  const div = document.createElement("div");
  div.className = "entry";
  div.id = "streaming-entry";
  const origText = escapeHtml(text).replace(/\n/g, "<br>");
  div.innerHTML = `
    <div class="section original">
      <div class="label">원문</div>
      <div class="card orig">${origText}</div>
    </div>
    <div class="section translated">
      <div class="label">번역 결과</div>
      <div class="card trans">
        <div class="loading-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  const transCard = div.querySelector(".card.trans") as HTMLElement;

  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    const result = await translateStream(
      text,
      targetLang,
      (partial) => {
        transCard.innerHTML = escapeHtml(partial.trim()).replace(/\n/g, "<br>");
        chat.scrollTop = chat.scrollHeight;
      },
      autoLangPair,
    );
    entry.translated = result;
    div.remove();
    addEntry(entry);
  } catch (e) {
    div.remove();
    inputField.value = text;
    syncInputHeight();
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

initHandwriting(
  chat,
  document.getElementById("btn-handwriting") as HTMLButtonElement,
);

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

  btnSuggest.textContent = "💬 답장";
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

// ─── Keyboard shortcuts ────────────────────────────
document.addEventListener("keydown", (e: KeyboardEvent) => {
  const isInInput = document.activeElement === inputField;

  // Escape — clear input or hide window
  if (e.key === "Escape") {
    if (isInInput && inputField.value.trim()) {
      inputField.value = "";
      syncInputHeight();
    } else {
      invoke("plugin:window|hide");
    }
    return;
  }

  // Cmd+K — clear chat
  if (e.metaKey && e.code === "KeyK" && !e.shiftKey) {
    e.preventDefault();
    clearChat();
    return;
  }

  // Cmd+Shift+C — copy last translation
  if (e.metaKey && e.shiftKey && e.code === "KeyC") {
    e.preventDefault();
    if (chatHistory.length > 0) {
      const last = chatHistory[chatHistory.length - 1];
      if (!last.translated.startsWith("[오류]")) {
        writeTextToClipboard(last.translated).catch(() => {});
        showCopyToast();
      }
    }
    return;
  }
});

function showCopyToast(): void {
  let toast = document.getElementById("copy-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "copy-toast";
    toast.textContent = "✓ 클립보드에 복사됨";
    document.body.appendChild(toast);
  }
  toast.classList.add("visible");
  setTimeout(() => toast!.classList.remove("visible"), 1800);
}

// ─── Retry failed translations ────────────────────
document.addEventListener("retry-translation", async (e: Event) => {
  const text = (e as CustomEvent).detail.text;
  inputField.value = text;
  syncInputHeight();
  await handleSubmit();
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

// ─── First-run empty state ──────────────────────────
showEmptyState();
