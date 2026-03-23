// ─── UI Rendering ───────────────────────────────────
import { writeTextToClipboard, writeHtmlToClipboard } from "./clipboard";
import { koreanPronunciation } from "./api";
import { COPY_FEEDBACK_MS, SETTINGS_KEYS, DEFAULTS } from "./constants";
import { escapeHtml } from "./utils";
import { getSetting, setSetting } from "./store";

export { escapeHtml };

export interface ChatEntry {
  original: string;
  translated: string;
  isTable?: boolean;
  originalHtml?: string;
  isImage?: boolean;
  imageBase64?: string;
  imageExtractedText?: string;
  timestamp?: number;
}

export let chatHistory: ChatEntry[] = [];
export const MAX_HISTORY = 50;
export const chat = document.getElementById("chat")!;

/** Sanitize HTML table: keep only safe tags/attributes, strip scripts and event handlers */
function sanitizeTableHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const SAFE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION", "COL", "COLGROUP", "BR", "SPAN", "STRONG", "EM", "B", "I", "U", "A", "DIV", "P"]);
  const SAFE_ATTRS = new Set(["rowspan", "colspan", "scope", "headers", "href"]);

  function clean(node: Element): void {
    // Remove dangerous elements
    node.querySelectorAll("script, style, iframe, object, embed, form, input, link, meta").forEach(el => el.remove());
    // Walk all elements
    const all = node.querySelectorAll("*");
    for (const el of all) {
      if (!SAFE_TAGS.has(el.tagName)) {
        el.replaceWith(...el.childNodes);
        continue;
      }
      // Remove all attributes except safe ones; strip all event handlers (on*)
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith("on") || !SAFE_ATTRS.has(attr.name)) {
          el.removeAttribute(attr.name);
        }
      }
      // Sanitize href to prevent javascript: URIs
      if (el.hasAttribute("href")) {
        const href = el.getAttribute("href") || "";
        if (!/^https?:\/\//i.test(href)) {
          el.removeAttribute("href");
        }
      }
    }
  }

  clean(doc.body);
  return doc.body.innerHTML;
}

function formatTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

export function renderEntry(entry: ChatEntry): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "entry";

  const timeStr = formatTime(entry.timestamp);
  const origText = escapeHtml(entry.original.trim()).replace(/\n/g, "<br>");
  const extractedTextRaw = (entry.imageExtractedText || "").trim();
  const extractedText = escapeHtml(extractedTextRaw).replace(/\n/g, "<br>");
  const isError = entry.translated.startsWith("[오류]");
  const transText = entry.isTable
    ? `<div class="table-wrap">${sanitizeTableHtml(entry.translated)}</div>`
    : escapeHtml(entry.translated.trim()).replace(/\n/g, "<br>");
  const origLabel = entry.isImage ? "원본 이미지" : "원문";

  let origContent = origText;
  if (entry.isTable && entry.originalHtml) {
    origContent = `<div class="table-wrap">${sanitizeTableHtml(entry.originalHtml)}</div>`;
  } else if (entry.isImage && entry.imageBase64) {
    origContent = `<img class="orig-img" src="data:image/png;base64,${entry.imageBase64}" alt="번역할 클립보드 이미지" />`;
  }

  const imageExtractedSection = entry.isImage && entry.imageExtractedText
    ? `
      <div class="section extracted hidden">
        <div class="label">OCR 추출 원문</div>
        <div class="card orig image-detail-panel">
          <div class="card-pills">
            <button type="button" class="card-pill copy-btn copy-extracted" aria-label="OCR 텍스트 복사">⧉ 복사</button>
          </div>
          ${extractedText}
        </div>
      </div>
    `
    : "";

  div.innerHTML = `
    <div class="section original">
      <div class="label">${origLabel}</div>
      <div class="card orig">
        <div class="card-pills">
          ${entry.isImage
            ? (entry.imageExtractedText ? '<button type="button" class="card-pill image-detail-toggle" data-expanded="false" aria-label="OCR 텍스트 토글">OCR 보기</button>' : "")
            : '<button type="button" class="card-pill pron-btn" data-target="orig" aria-label="원문 발음">Aa 발음</button><button type="button" class="card-pill copy-btn copy-orig" aria-label="원문 복사">⧉ 복사</button>'}
        </div>
        ${origContent}
      </div>
    </div>
    ${imageExtractedSection}
    <div class="section translated">
      <div class="label">번역 결과</div>
      <div class="card trans${isError ? ' error" role="alert"' : '"'}>
        <div class="card-pills">
          ${isError ? "" : '<button type="button" class="card-pill pron-btn" data-target="trans" aria-label="번역 발음">Aa 발음</button>'}
          ${isError ? "" : '<button type="button" class="card-pill copy-btn copy-trans" aria-label="번역 복사">⧉ 복사</button>'}
        </div>
        ${transText}
      </div>
    </div>
  `;

  // Error actions (retry or settings)
  if (isError) {
    const transCard = div.querySelector(".card.trans") as HTMLElement;
    const actions = document.createElement("div");
    actions.className = "error-actions";

    if (entry.translated.includes("API 키")) {
      actions.innerHTML = '<button type="button" class="error-action-btn error-settings">설정 열기</button>';
    } else {
      actions.innerHTML = '<button type="button" class="error-action-btn error-retry">다시 시도</button>';
    }
    transCard.appendChild(actions);

    const retryBtn = actions.querySelector(".error-retry");
    retryBtn?.addEventListener("click", () => {
      document.dispatchEvent(new CustomEvent("retry-translation", { detail: { text: entry.original } }));
      div.remove();
      const idx = chatHistory.indexOf(entry);
      if (idx !== -1) chatHistory.splice(idx, 1);
    });
  }

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
      setTimeout(() => { copyOrigBtn.classList.remove("active"); setTimeout(() => { copyOrigBtn.textContent = "⧉ 복사"; }, 300); }, COPY_FEEDBACK_MS);
    });
  }

  const copyTransBtn = div.querySelector(".copy-trans") as HTMLElement | null;
  if (copyTransBtn) {
    copyTransBtn.addEventListener("click", async () => {
      try {
        if (entry.isTable) {
          await writeHtmlToClipboard(entry.translated);
        } else {
          await writeTextToClipboard(entry.translated);
        }
      } catch {
        const ta = document.createElement("textarea");
        ta.value = entry.translated;
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      copyTransBtn.textContent = "✓ 복사됨";
      copyTransBtn.classList.add("active");
      setTimeout(() => { copyTransBtn.classList.remove("active"); setTimeout(() => { copyTransBtn.textContent = "⧉ 복사"; }, 300); }, COPY_FEEDBACK_MS);
    });
  }

  const copyExtractedBtn = div.querySelector(".copy-extracted") as HTMLElement | null;
  if (copyExtractedBtn && extractedTextRaw) {
    copyExtractedBtn.addEventListener("click", async () => {
      try { await writeTextToClipboard(extractedTextRaw); } catch {
        const ta = document.createElement("textarea");
        ta.value = extractedTextRaw;
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      }
      copyExtractedBtn.textContent = "✓ 복사됨";
      copyExtractedBtn.classList.add("active");
      setTimeout(() => { copyExtractedBtn.classList.remove("active"); setTimeout(() => { copyExtractedBtn.textContent = "⧉ 복사"; }, 300); }, COPY_FEEDBACK_MS);
    });
  }

  const imageDetailToggle = div.querySelector(".image-detail-toggle") as HTMLButtonElement | null;
  const imageDetailSection = div.querySelector(".section.extracted") as HTMLElement | null;
  if (imageDetailToggle && imageDetailSection) {
    imageDetailToggle.addEventListener("click", () => {
      const expanded = imageDetailToggle.dataset.expanded === "true";
      imageDetailToggle.dataset.expanded = String(!expanded);
      imageDetailToggle.textContent = expanded ? "OCR 보기" : "OCR 숨기기";
      imageDetailSection.classList.toggle("hidden", expanded);
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

export function renderLoading(original: string): HTMLDivElement {
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
      <div class="card trans" role="status" aria-label="번역 중">
        <div class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></div>
        <span class="sr-only">번역 중…</span>
      </div>
    </div>
  `;
  return div;
}

export function removeLoading(): void {
  document.getElementById("loading-entry")?.remove();
}

export function addEntry(entry: ChatEntry): void {
  if (!entry.timestamp) entry.timestamp = Date.now();
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.shift();
    chat.firstElementChild?.remove();
  }
  removeLoading();
  chat.appendChild(renderEntry(entry));
  chat.scrollTop = chat.scrollHeight;
}

export async function showEmptyState(): Promise<void> {
  if (chatHistory.length > 0) return;
  const apiKey = await getSetting(SETTINGS_KEYS.apiKey, DEFAULTS.apiKey);

  if (!apiKey) {
    chat.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔑</div>
        <div class="empty-title">시작하려면 API 키가 필요합니다</div>
        <div class="empty-field">
          <input type="password" id="inline-api-key" placeholder="Gemini API 키를 붙여넣으세요" />
          <button type="button" id="inline-api-save" class="empty-save-btn">저장</button>
        </div>
        <div class="empty-hint">Google AI Studio에서 무료 키를 발급받을 수 있습니다</div>
      </div>`;

    document.getElementById("inline-api-save")?.addEventListener("click", async () => {
      const keyInput = document.getElementById("inline-api-key") as HTMLInputElement;
      const key = keyInput?.value.trim();
      if (!key) return;
      await setSetting(SETTINGS_KEYS.apiKey, key);
      await showEmptyState();
    });
  } else {
    chat.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⌘⌃T</div>
        <div class="empty-title">텍스트를 선택하고 ⌘+Ctrl+T</div>
        <div class="empty-subtitle">또는 아래에 직접 입력하세요</div>
      </div>`;
  }
}

export function clearChat(): void {
  chatHistory = [];
  chat.innerHTML = "";
  showEmptyState();
}
