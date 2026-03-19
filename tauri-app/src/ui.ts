// ─── UI Rendering ───────────────────────────────────
import { writeTextToClipboard } from "./clipboard";
import { koreanPronunciation } from "./api";
import { COPY_FEEDBACK_MS } from "./constants";
import { escapeHtml } from "./utils";

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
    origContent = `<img class="orig-img" src="data:image/png;base64,${entry.imageBase64}" />`;
  }

  const imageExtractedSection = entry.isImage && entry.imageExtractedText
    ? `
      <div class="section extracted hidden">
        <div class="label">OCR 추출 원문</div>
        <div class="card orig image-detail-panel">
          <div class="card-pills">
            <span class="card-pill copy-btn copy-extracted">⧉ 복사</span>
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
            ? (entry.imageExtractedText ? '<span class="card-pill image-detail-toggle" data-expanded="false">OCR 보기</span>' : "")
            : '<span class="card-pill pron-btn" data-target="orig">Aa 발음</span><span class="card-pill copy-btn copy-orig">⧉ 복사</span>'}
        </div>
        ${origContent}
      </div>
    </div>
    ${imageExtractedSection}
    <div class="section translated">
      <div class="label">번역 결과</div>
      <div class="card trans${isError ? " error" : ""}">
        <div class="card-pills">
          ${isError ? "" : '<span class="card-pill pron-btn" data-target="trans">Aa 발음</span>'}
          ${isError ? "" : '<span class="card-pill copy-btn copy-trans">⧉ 복사</span>'}
        </div>
        ${transText}
        <span class="card-time">${timeStr}</span>
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
      setTimeout(() => { copyOrigBtn.classList.remove("active"); setTimeout(() => { copyOrigBtn.textContent = "⧉ 복사"; }, 300); }, COPY_FEEDBACK_MS);
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
      <div class="card trans">
        <div class="loading-dots"><span></span><span></span><span></span></div>
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

export function clearChat(): void {
  chatHistory = [];
  chat.innerHTML = "";
}
