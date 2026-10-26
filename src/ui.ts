// ─── UI Rendering ───────────────────────────────────
import { writeTextToClipboard, writeHtmlToClipboard, writeWithTextFallback } from "./clipboard";
import { copyWithFeedback } from "./copyFeedback";
import { koreanPronunciation } from "./api";
import { escapeHtml } from "./utils";
import { getActiveBackendId } from "./llmProfile";
import { getProvider } from "./providerRegistry";
import { getCredentialStatus, saveProviderCredential } from "./connectionProfiles";
import { openSettingsFrom } from "./settingsAccess";

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
let chatRevision = 0;
export function getChatRevision(): number { return chatRevision; }
export function notifyChatChanged(): void {
  chatRevision++;
  // renderLoading returns a row which callers append synchronously.
  queueMicrotask(() => document.dispatchEvent(new Event("chat-changed")));
}

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

    const settingsButton = actions.querySelector<HTMLButtonElement>(".error-settings");
    if (settingsButton) {
      const status = document.createElement("span");
      status.setAttribute("role", "status");
      actions.appendChild(status);
      settingsButton.addEventListener("click", () => void openSettingsFrom(settingsButton, status));
    }

    const retryBtn = actions.querySelector(".error-retry");
    retryBtn?.addEventListener("click", () => {
      const accepted = document.dispatchEvent(new CustomEvent("retry-translation", { detail: { text: entry.original }, cancelable: true }));
      if (!accepted) return;
      div.remove();
      const idx = chatHistory.indexOf(entry);
      if (idx !== -1) chatHistory.splice(idx, 1);
      notifyChatChanged();
    });
  }

  // All explicit copies acknowledge success, including the legacy text fallback.
  const bindCopy = (selector: string, text: string, write: () => Promise<void>) => {
    const button = div.querySelector<HTMLButtonElement>(selector);
    button?.addEventListener("click", () => void copyWithFeedback(() => writeWithTextFallback(write, text), button));
  };
  bindCopy(".copy-orig", entry.original, () => writeTextToClipboard(entry.original));
  bindCopy(".copy-trans", entry.translated, () => entry.isTable
    ? writeHtmlToClipboard(entry.translated) : writeTextToClipboard(entry.translated));
  if (extractedTextRaw) bindCopy(".copy-extracted", extractedTextRaw, () => writeTextToClipboard(extractedTextRaw));

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

function hasActiveCredentialForm(element: Element): boolean {
  return [...element.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    .some(input => !!input.value || input.disabled);
}

export function clearInactiveOnboarding(): void {
  chat.querySelectorAll(".empty-state, .dictation-onboarding").forEach(element => {
    if (!hasActiveCredentialForm(element)) element.remove();
  });
}

export function renderLoading(original: string): HTMLDivElement {
  clearInactiveOnboarding();
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
  notifyChatChanged();
  return div;
}

export function removeLoading(): void {
  const loading = document.getElementById("loading-entry");
  if (loading) { loading.remove(); notifyChatChanged(); }
}

export function addEntry(entry: ChatEntry): void {
  clearInactiveOnboarding();
  if (!entry.timestamp) entry.timestamp = Date.now();
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory.shift();
    chat.querySelector(".entry")?.remove();
  }
  removeLoading();
  chat.appendChild(renderEntry(entry));
  chat.scrollTop = chat.scrollHeight;
  notifyChatChanged();
}

let emptyStateSequence = 0;
let translationSetupRequested = false;
let dictationSupport: boolean | undefined;
let pendingDictationSupport: Promise<boolean> | null = null;

async function readDictationSupport(): Promise<boolean> {
  if (dictationSupport !== undefined) return dictationSupport;
  if (!pendingDictationSupport) {
    pendingDictationSupport = window.__TAURI__.core.invoke<boolean>("supports_global_dictation").then(supported => {
      if (typeof supported !== "boolean") throw new Error("Invalid dictation support status");
      dictationSupport = supported;
      return supported;
    }).finally(() => { pendingDictationSupport = null; });
  }
  return pendingDictationSupport;
}

function ensureDictationOnboarding(): void {
  if (chatHistory.length || chat.querySelector(".entry, .dictation-onboarding")) return;
  const card = document.createElement("section");
  card.className = "dictation-onboarding";
  card.setAttribute("aria-labelledby", "dictation-onboarding-title");
  card.innerHTML = `<h2 id="dictation-onboarding-title">API 키 없이 Mac에서 받아쓰기</h2>
    <p>다른 앱의 입력창에 말한 내용을 입력하세요. 음성 인식은 Mac에서 처리합니다.</p>
    <button type="button" class="dictation-setup-btn" disabled>지원 확인 중…</button>
    <span class="dictation-setup-status" role="status" aria-live="polite"></span>`;
  const button = card.querySelector<HTMLButtonElement>("button")!;
  const status = card.querySelector<HTMLElement>("[role=status]")!;
  let supported: boolean | null = null;
  const checkSupport = async () => {
    button.disabled = true;
    button.textContent = "지원 확인 중…";
    status.textContent = "이 운영체제의 받아쓰기 지원 여부를 확인합니다.";
    try {
      const available = await readDictationSupport();
      if (!card.isConnected) return;
      supported = available;
      button.disabled = !available;
      button.textContent = available ? "받아쓰기 준비" : "macOS 전용";
      status.textContent = available ? "" : "다른 앱에서 받아쓰기는 macOS에서만 지원합니다.";
    } catch {
      if (!card.isConnected) return;
      button.disabled = false;
      button.textContent = "지원 상태 다시 확인";
      status.textContent = "지원 여부를 확인하지 못했습니다. 다시 확인해주세요.";
    }
  };
  button.addEventListener("click", () => {
    if (supported === true) void openSettingsFrom(button, status, "open_dictation_settings");
    else if (supported === null) void checkSupport();
  });
  chat.appendChild(card);
  void checkSupport();
}

export async function showEmptyState({ preserveCredentialDraft = true } = {}): Promise<void> {
  if (chatHistory.length > 0 || chat.querySelector(".entry")) return;
  // Local dictation remains discoverable while a cloud Keychain read waits.
  ensureDictationOnboarding();
  const hasCredentialDraft = () => {
    const input = document.getElementById("inline-api-key") as HTMLInputElement | null;
    return preserveCredentialDraft && !!input && (!!input.value || input.disabled);
  };
  if (hasCredentialDraft()) return;
  const sequence = ++emptyStateSequence;
  const current = () => sequence === emptyStateSequence && chatHistory.length === 0 && !chat.querySelector(".entry") && !hasCredentialDraft();
  if (!translationSetupRequested) {
    chat.innerHTML = `<div class="empty-state">
      <div class="empty-title">텍스트를 선택하거나 아래에 입력해 번역하세요</div>
      <div class="empty-subtitle">번역 연결이 필요하면 공급자와 API 키를 설정할 수 있습니다.</div>
      <button type="button" class="translation-setup-btn empty-save-btn">번역 연결 준비</button>
    </div>`;
    const prepare = chat.querySelector<HTMLButtonElement>(".translation-setup-btn")!;
    prepare.addEventListener("click", () => {
      prepare.disabled = true;
      translationSetupRequested = true;
      void showEmptyState();
    });
    ensureDictationOnboarding();
    return;
  }
  try {
    const providerId = await getActiveBackendId();
    const provider = getProvider(providerId);
    const credential = providerId === "ollama" ? null : await getCredentialStatus(providerId);
    if (credential?.error) throw new Error(credential.error);
    if (!current()) return;
    if (credential && !credential.configured && providerId !== "ollama") {
      chat.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔑</div>
          <div class="empty-title">${escapeHtml(provider.label)} API 키를 설정하세요</div>
          <div class="empty-field">
            <input type="password" id="inline-api-key" autocomplete="off" placeholder="새 API 키" />
            <button type="button" id="inline-api-save" class="empty-save-btn">Keychain에 저장</button>
          </div>
          <div class="empty-hint" id="inline-api-status" role="status">키를 저장한 뒤 번역할 수 있습니다.</div>
        </div>`;
      const keyInput = document.getElementById("inline-api-key") as HTMLInputElement;
      const save = document.getElementById("inline-api-save") as HTMLButtonElement;
      const status = document.getElementById("inline-api-status")!;
      const form = keyInput.closest(".empty-state")!;
      const formCurrent = () => document.getElementById("inline-api-key") === keyInput;
      save.addEventListener("click", async () => {
        if (save.disabled || !keyInput.value.trim()) return;
        save.disabled = true;
        keyInput.disabled = true;
        status.textContent = "API 키 저장 중…";
        try {
          await saveProviderCredential(providerId, keyInput.value.trim(), credential.revision);
          keyInput.value = "";
          if (formCurrent() && !chatHistory.length && !chat.querySelector(".entry")) {
            await showEmptyState({ preserveCredentialDraft: false });
          }
          if (formCurrent() && (chatHistory.length || chat.querySelector(".entry"))) form.remove();
        } catch {
          if (formCurrent()) status.textContent = "API 키 저장 결과를 확인하지 못했습니다. 입력을 유지했습니다. 설정에서 키 상태를 확인해주세요.";
        } finally {
          save.disabled = false;
          keyInput.disabled = false;
        }
      });
      ensureDictationOnboarding();
      return;
    }
    chat.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⌘⌃T</div>
        <div class="empty-title">텍스트를 선택하고 ⌘+Ctrl+T</div>
        <div class="empty-subtitle">또는 아래에 직접 입력하세요</div>
      </div>`;
    ensureDictationOnboarding();
  } catch (error) {
    if (current()) {
      chat.innerHTML = `<div class="empty-state"><div class="empty-title">AI 연결 설정을 확인해주세요</div><div class="empty-hint">${escapeHtml(String(error))}</div><div class="empty-subtitle">설정에서 API 키 상태를 확인해주세요.</div></div>`;
      ensureDictationOnboarding();
    }
  }
}

export function clearChat(): void {
  chatHistory = [];
  const drafts = [...chat.querySelectorAll(".empty-state")].filter(hasActiveCredentialForm);
  chat.replaceChildren(...drafts);
  notifyChatChanged();
  void showEmptyState();
}
