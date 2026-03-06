// ─── Tauri API ───────────────────────────────────────
const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ─── Types ──────────────────────────────────────────
interface ChatEntry {
  original: string;
  translated: string;
  isTable?: boolean;
  originalHtml?: string;
  isImage?: boolean;
  imageBase64?: string;
}

interface Suggestion {
  kr: string;
  jp: string;
}

// ─── Clipboard via invoke ───────────────────────────
async function readText(): Promise<string> {
  return await invoke("plugin:clipboard-manager|read_text");
}

async function writeTextToClipboard(text: string): Promise<void> {
  await invoke("plugin:clipboard-manager|write_text", { text });
}

// ─── State ──────────────────────────────────────────
let chatHistory: ChatEntry[] = [];
let storeRid: number | null = null;
const MAX_HISTORY = 50;

// ─── Store (settings persistence via invoke) ────────
async function getStoreRid(): Promise<number> {
  if (storeRid === null) {
    storeRid = await invoke("plugin:store|load", {
      path: "settings.json",
      options: { autoSave: true },
    });
  }
  return storeRid!;
}

async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const rid = await getStoreRid();
    const [value, exists] = await invoke<[T, boolean]>("plugin:store|get", { rid, key });
    return exists ? value : defaultValue;
  } catch (e) {
    console.error("getSetting error:", e);
    return defaultValue;
  }
}

async function setSetting<T>(key: string, value: T): Promise<void> {
  const rid = await getStoreRid();
  await invoke("plugin:store|set", { rid, key, value });
}

// ─── Gemini API ─────────────────────────────────────
async function callGemini(prompt: string): Promise<string> {
  const apiKey = await getSetting("apiKey", "");
  const model = await getSetting("model", "gemini-2.0-flash");
  if (!apiKey) {
    throw new Error("API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function translate(text: string, targetLang: string): Promise<string> {
  const prompt =
    `Translate the following text to ${targetLang}.\n` +
    `Output ONLY the translation, no explanations.\n\n` +
    text;
  return callGemini(prompt);
}

async function translateTable(tableHtml: string, targetLang: string): Promise<string> {
  const prompt =
    `Translate ALL text in the following HTML table to ${targetLang}.\n` +
    `IMPORTANT RULES:\n` +
    `- Translate ALL text to ${targetLang}, including technical terms\n` +
    `- Keep ALL HTML tags and attributes (rowspan, colspan, etc.) EXACTLY as-is\n` +
    `- Do NOT translate: product IDs, version numbers, URLs, English words\n` +
    `- Do NOT add, remove, or modify any HTML tags\n` +
    `- Output ONLY the translated HTML table, nothing else\n\n` +
    tableHtml;
  let result = await callGemini(prompt);
  if (result.startsWith("```")) {
    const lines = result.split("\n");
    if (lines[lines.length - 1].trim() === "```") {
      result = lines.slice(1, -1).join("\n").trim();
    } else {
      result = lines.slice(1).join("\n").trim();
    }
  }
  return result;
}

async function suggestReplies(original: string, translated: string): Promise<Suggestion[]> {
  const prompt =
    "You are a helpful assistant for a Korean professional working in a Japanese company.\n" +
    "Based on the following message, suggest 3 short reply options.\n" +
    "For each reply, provide both Korean and Japanese versions.\n" +
    "Format: KR: ... | JP: ...\n\n" +
    "Japanese reply style: polite business Japanese, concise, Slack-appropriate.\n" +
    "Output ONLY 3 replies, numbered 1. 2. 3.\n\n" +
    `Original: ${original}\nTranslation: ${translated}`;
  const raw = await callGemini(prompt);
  const suggestions: Suggestion[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cleaned = trimmed.replace(/^\d+\.\s*/, "");
    if (cleaned.includes("KR:") && cleaned.includes("JP:")) {
      const parts = cleaned.split("|");
      const kr = (parts[0] || "").replace("KR:", "").trim();
      const jp = (parts[1] || "").replace("JP:", "").trim();
      if (kr && jp) suggestions.push({ kr, jp });
    }
  }
  return suggestions;
}

async function translateImage(base64Png: string, targetLang: string): Promise<string> {
  const apiKey = await getSetting("apiKey", "");
  const model = await getSetting("model", "gemini-2.0-flash");
  if (!apiKey) {
    throw new Error("API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            text:
              `This image contains text. Do the following:\n` +
              `1. Extract ALL text from the image\n` +
              `2. Translate ALL text to ${targetLang}\n\n` +
              `Format your response EXACTLY like this:\n` +
              `[원문]\n(extracted text)\n\n` +
              `[번역]\n(translation)`
          },
          {
            inline_data: {
              mime_type: "image/png",
              data: base64Png,
            },
          },
        ],
      }],
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error: ${resp.status} ${err}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

async function koreanPronunciation(text: string): Promise<string> {
  const prompt =
    "Write the Korean pronunciation (reading) of the following text.\n" +
    "Rules:\n" +
    "- Japanese -> Korean phonetic transcription\n" +
    "- English -> Korean phonetic transcription\n" +
    "- Kanji -> Japanese reading in Korean\n" +
    "- Output ONLY the pronunciation, nothing else.\n\n" +
    `Text: ${text}`;
  return callGemini(prompt);
}

// ─── UI Rendering ───────────────────────────────────
const chat = document.getElementById("chat")!;
const inputField = document.getElementById("input-field") as HTMLTextAreaElement;
const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
const btnSuggest = document.getElementById("btn-suggest") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderEntry(entry: ChatEntry): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "entry";

  const origText = escapeHtml(entry.original.trim()).replace(/\n/g, "<br>");
  const isError = entry.translated.startsWith("[오류]");
  const transText = entry.isTable
    ? `<div class="table-wrap">${entry.translated}</div>`
    : escapeHtml(entry.translated.trim()).replace(/\n/g, "<br>");
  const origLabel = entry.isImage ? "원본 이미지" : "원문";

  let origContent = origText;
  if (entry.isTable && entry.originalHtml) {
    origContent = `<div class="table-wrap">${entry.originalHtml}</div>`;
  } else if (entry.isImage && entry.imageBase64) {
    origContent = `<img class="orig-img" src="data:image/png;base64,${entry.imageBase64}" />`;
    if (entry.original && entry.original !== "(이미지에서 추출)") {
      origContent += `<div style="margin-top:8px">${origText}</div>`;
    }
  }

  div.innerHTML = `
    <div class="section original">
      <div class="label">${origLabel}</div>
      <div class="card orig">
        <div class="card-pills">
          ${entry.isImage ? "" : '<span class="card-pill pron-btn" data-target="orig">Aa 발음</span>'}
          ${entry.isImage ? "" : '<span class="card-pill copy-btn copy-orig">⧉ 복사</span>'}
        </div>
        ${origContent}
      </div>
    </div>
    <div class="section translated">
      <div class="label">번역 결과</div>
      <div class="card trans${isError ? " error" : ""}">
        <div class="card-pills">
          ${isError ? "" : '<span class="card-pill pron-btn" data-target="trans">Aa 발음</span>'}
          ${isError ? "" : '<span class="card-pill copy-btn copy-trans">⧉ 복사</span>'}
        </div>
        ${transText}
      </div>
    </div>
  `;

  // Copy buttons (original + translated)
  const copyOrigBtn = div.querySelector(".copy-orig") as HTMLElement | null;
  if (copyOrigBtn) {
    const textToCopy = entry.original;
    copyOrigBtn.addEventListener("click", async () => {
      try { await writeTextToClipboard(textToCopy); } catch {
        const ta = document.createElement("textarea");
        ta.value = textToCopy;
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      copyOrigBtn.textContent = "✓ 복사됨";
      copyOrigBtn.classList.add("active");
      setTimeout(() => { copyOrigBtn.classList.remove("active"); setTimeout(() => { copyOrigBtn.textContent = "⧉ 복사"; }, 300); }, 1200);
    });
  }

  const copyTransBtn = div.querySelector(".copy-trans") as HTMLElement | null;
  if (copyTransBtn) {
    copyTransBtn.addEventListener("click", async () => {
      try { await writeTextToClipboard(entry.translated); } catch {
        const ta = document.createElement("textarea");
        ta.value = entry.translated;
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      copyTransBtn.textContent = "✓ 복사됨";
      copyTransBtn.classList.add("active");
      setTimeout(() => { copyTransBtn.classList.remove("active"); setTimeout(() => { copyTransBtn.textContent = "⧉ 복사"; }, 300); }, 1200);
    });
  }

  // Pronunciation buttons (original + translated)
  div.querySelectorAll<HTMLElement>(".pron-btn").forEach(pronBtn => {
    pronBtn.addEventListener("click", async () => {
      if (pronBtn.classList.contains("active")) return;
      const isOrig = pronBtn.dataset.target === "orig";
      const section = pronBtn.closest(".section") as HTMLElement;
      const card = section.querySelector(".card") as HTMLElement;
      if (card.querySelector(".pron-area")) return;
      pronBtn.textContent = "생성 중…";
      pronBtn.classList.add("active");
      try {
        const text = isOrig ? entry.original : entry.translated;
        const pron = await koreanPronunciation(text);
        const pronDiv = document.createElement("div");
        pronDiv.className = "pron-area";
        pronDiv.textContent = pron;
        card.appendChild(pronDiv);
      } catch (e) {
        console.error("Pronunciation error:", e);
      }
      pronBtn.classList.remove("active");
      pronBtn.remove();
    });
  });

  return div;
}

function renderLoading(original: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "entry";
  div.id = "loading-entry";
  const origText = escapeHtml(original.trim()).replace(/\n/g, "<br>");
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
  return div;
}

function removeLoading(): void {
  document.getElementById("loading-entry")?.remove();
}

function addEntry(entry: ChatEntry): void {
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.shift();
    chat.firstElementChild?.remove();
  }
  removeLoading();
  chat.appendChild(renderEntry(entry));
  chat.scrollTop = chat.scrollHeight;
}

function clearChat(): void {
  chatHistory = [];
  chat.innerHTML = "";
}

// ─── Tray animation ─────────────────────────────────
function startTrayAnim(): void {
  invoke("tray_anim_start").catch(() => {});
}
function stopTrayAnim(): void {
  invoke("tray_anim_stop").catch(() => {});
}

// ─── Translation submit ─────────────────────────────
async function handleSubmit(): Promise<void> {
  const text = inputField.value.trim();
  if (!text) return;
  const targetLang = langSelect.value;

  inputField.value = "";
  chat.appendChild(renderLoading(text));
  chat.scrollTop = chat.scrollHeight;
  startTrayAnim();

  try {
    const result = await translate(text, targetLang);
    addEntry({ original: text, translated: result });
  } catch (e: any) {
    removeLoading();
    addEntry({ original: text, translated: `[오류] ${e.message}` });
  } finally {
    stopTrayAnim();
  }
}

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

// ─── Clear ──────────────────────────────────────────
btnClear.addEventListener("click", clearChat);

// ─── Input handling ─────────────────────────────────
inputField.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
});

// Auto-resize textarea
inputField.addEventListener("input", () => {
  inputField.style.height = "auto";
  inputField.style.height = Math.min(inputField.scrollHeight, 195) + "px";
});


// ─── Settings modal ─────────────────────────────────
const settingsModal = document.getElementById("settings-modal")!;
const apiKeyInput = document.getElementById("api-key-input") as HTMLInputElement;
const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
const btnSaveSettings = document.getElementById("btn-save-settings")!;
const btnCancelSettings = document.getElementById("btn-cancel-settings")!;

async function openSettings(): Promise<void> {
  apiKeyInput.value = await getSetting("apiKey", "");
  modelSelect.value = await getSetting("model", "gemini-2.0-flash");
  settingsModal.classList.remove("hidden");
}

btnSaveSettings.addEventListener("click", async () => {
  await setSetting("apiKey", apiKeyInput.value.trim());
  await setSetting("model", modelSelect.value);
  settingsModal.classList.add("hidden");
});

btnCancelSettings.addEventListener("click", () => {
  settingsModal.classList.add("hidden");
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    if (!settingsModal.classList.contains("hidden")) settingsModal.classList.add("hidden");
  }
});

// ─── Event listeners ────────────────────────────────
listen("open-settings", () => openSettings());

listen("global-translate", async () => {
  startTrayAnim();
  try {
    const targetLang = langSelect.value;

    // 1. Check for HTML table in clipboard
    let tableHtml: string | null = null;
    try {
      tableHtml = await invoke<string | null>("read_clipboard_html");
    } catch (e) {
      console.error("HTML clipboard read error:", e);
    }

    if (tableHtml) {
      let clipText: string | null = null;
      try { clipText = await readText(); } catch {}
      const displayText = clipText?.trim() || "(테이블)";
      chat.appendChild(renderLoading(displayText));
      chat.scrollTop = chat.scrollHeight;
      try {
        const result = await translateTable(tableHtml, targetLang);
        addEntry({ original: displayText, translated: result, isTable: true, originalHtml: tableHtml });
      } catch (e: any) {
        removeLoading();
        addEntry({ original: displayText, translated: `[오류] ${e.message}` });
      }
      stopTrayAnim();
      return;
    }

    // 2. Check for text
    let clipText: string | null = null;
    try {
      clipText = await readText();
    } catch {}

    if (clipText && clipText.trim()) {
      const text = clipText.trim();
      chat.appendChild(renderLoading(text));
      chat.scrollTop = chat.scrollHeight;
      try {
        const result = await translate(text, targetLang);
        addEntry({ original: text, translated: result });
      } catch (e: any) {
        removeLoading();
        addEntry({ original: text, translated: `[오류] ${e.message}` });
      }
      return;
    }

    // 3. Check for image
    try {
      const imageBase64 = await invoke<string | null>("read_clipboard_image");
      if (imageBase64) {
        chat.appendChild(renderLoading("(이미지 번역 중…)"));
        chat.scrollTop = chat.scrollHeight;
        try {
          const result = await translateImage(imageBase64, targetLang);
          let original = "(이미지에서 추출)";
          let translated = result;
          const origMatch = result.match(/\[원문\]\s*\n([\s\S]*?)\n\n\[번역\]\s*\n([\s\S]*)/);
          if (origMatch) {
            original = origMatch[1].trim();
            translated = origMatch[2].trim();
          }
          addEntry({ original, translated, isImage: true, imageBase64 });
        } catch (e: any) {
          removeLoading();
          addEntry({ original: "(이미지)", translated: `[오류] ${e.message}`, isImage: true, imageBase64 });
        }
      }
      if (!imageBase64) {
        addEntry({ original: "(클립보드 비어있음)", translated: "번역할 텍스트, 테이블, 또는 이미지를 복사한 후 다시 시도해주세요." });
      }
    } catch (e) {
      console.error("Image clipboard read error:", e);
    }
  } catch (e) {
    console.error("Clipboard read error:", e);
  } finally {
    stopTrayAnim();
  }
});

// ─── Restore language preference ────────────────────
(async () => {
  const savedLang = await getSetting("targetLanguage", "한국어");
  langSelect.value = savedLang;
})();

langSelect.addEventListener("change", () => {
  setSetting("targetLanguage", langSelect.value);
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
