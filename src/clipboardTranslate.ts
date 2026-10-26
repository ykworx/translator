import type { LangConfig } from "./types";
import { readText, writeTextToClipboard, writeHtmlToClipboard } from "./clipboard";
import { translate, translateTable, translateImage } from "./api";
import { chat, renderLoading, addEntry, getChatEpoch } from "./ui";
import type { ChatEntry, TranslationSource } from "./ui";
import { getErrorMessage } from "./utils";

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;
let resolveLangConfig: () => Promise<LangConfig>;
let activeOperation: { epoch: number } | null = null;

type Operation = { epoch: number };
const isCurrent = (operation: Operation) => operation.epoch === getChatEpoch();

// A new conversation may start before the old request returns. Its completion
// must neither add a row nor write the old result to the clipboard.
function runClipboardTranslation(task: (operation: Operation) => Promise<void>): boolean {
  if (activeOperation && isCurrent(activeOperation)) return false;
  const operation = { epoch: getChatEpoch() };
  activeOperation = operation;
  void task(operation).catch(error => console.error("Clipboard translation error:", error)).finally(() => {
    if (activeOperation === operation) activeOperation = null;
  });
  return true;
}

async function translateSource(source: TranslationSource, operation: Operation, autoCopy: boolean): Promise<void> {
  if (!isCurrent(operation)) return;
  const loading = renderLoading(source.text);
  chat.appendChild(loading);
  chat.scrollTop = chat.scrollHeight;
  const entry: ChatEntry = { original: source.text, translated: "", retrySource: source,
    ...(source.kind === "image" ? { isImage: true, imageBase64: source.imageBase64 } : {}),
    ...(source.kind === "table" ? { isTable: true, originalHtml: source.html } : {}),
  };
  try {
    const { targetLang, autoLangPair } = await resolveLangConfig();
    if (!isCurrent(operation)) return;
    if (source.kind === "image") {
      const result = await translateImage(source.imageBase64, targetLang, autoLangPair);
      entry.translated = result.translatedText;
      entry.imageExtractedText = result.extractedText;
    } else if (source.kind === "table") {
      entry.translated = await translateTable(source.html, targetLang, autoLangPair);
    } else {
      entry.translated = await translate(source.text, targetLang, autoLangPair);
    }
    if (!isCurrent(operation)) return;
    addEntry(entry, { loading });
    if (autoCopy && source.kind !== "image" && isCurrent(operation)) {
      try {
        if (source.kind === "table") await writeHtmlToClipboard(entry.translated);
        else await writeTextToClipboard(entry.translated);
      } catch { /* A translation remains usable when automatic copying fails. */ }
    }
  } catch (error) {
    if (!isCurrent(operation)) return;
    entry.translated = `[오류] ${getErrorMessage(error)}`;
    addEntry(entry, { loading });
  }
}

export function retryClipboardTranslation(source: unknown): boolean {
  if (!source || typeof source !== "object" || !resolveLangConfig) return false;
  const value = source as Record<string, unknown>;
  if (typeof value.text !== "string" || !value.text.trim()) return false;
  if (value.kind === "image" && typeof value.imageBase64 === "string" && value.imageBase64) {
    const snapshot: TranslationSource = { kind: "image", text: value.text, imageBase64: value.imageBase64 };
    return runClipboardTranslation(operation => translateSource(snapshot, operation, false));
  }
  if (value.kind === "table" && typeof value.html === "string" && value.html.trim()) {
    const snapshot: TranslationSource = { kind: "table", text: value.text, html: value.html };
    return runClipboardTranslation(operation => translateSource(snapshot, operation, false));
  }
  return false;
}

async function imageFromClipboard(operation: Operation, emptyMessage: string): Promise<void> {
  const imageBase64 = await invoke<string | null>("read_clipboard_image");
  if (!isCurrent(operation)) return;
  if (!imageBase64) {
    addEntry({ original: "(이미지 없음)", translated: emptyMessage });
    return;
  }
  await translateSource({ kind: "image", text: "(이미지)", imageBase64 }, operation, false);
}

export function initClipboardListeners(resolve: () => Promise<LangConfig>): void {
  resolveLangConfig = resolve;
  listen("global-translate", () => {
    runClipboardTranslation(async operation => {
      let html: string | null = null;
      try { html = await invoke<string | null>("read_clipboard_html"); } catch { /* Try plain text. */ }
      if (!isCurrent(operation)) return;
      let text: string | null = null;
      try { text = await readText(); } catch { /* Try an image. */ }
      if (!isCurrent(operation)) return;
      if (html) {
        await translateSource({ kind: "table", text: text?.trim() || "(테이블)", html }, operation, true);
      } else if (text?.trim()) {
        await translateSource({ kind: "text", text: text.trim() }, operation, true);
      } else {
        await imageFromClipboard(operation, "번역할 텍스트, 테이블, 또는 이미지를 복사한 후 다시 시도해주세요.");
      }
    });
  });
  listen("global-translate-image", () => {
    runClipboardTranslation(operation => imageFromClipboard(operation, "영역 캡처가 취소되었거나 이미지가 클립보드에 없습니다."));
  });
}
