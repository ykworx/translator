import type { LangConfig } from "./types";
import { readText } from "./clipboard";
import { translate, translateTable, translateImage } from "./api";
import { chat, renderLoading, removeLoading, addEntry } from "./ui";
import { getErrorMessage } from "./utils";

const { listen } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

let resolveLangConfig: () => Promise<LangConfig>;

async function handleImageTranslateFromClipboard(emptyMessage: string): Promise<void> {
  try {
    const imageBase64 = await invoke<string | null>("read_clipboard_image");
    if (!imageBase64) {
      addEntry({ original: "(이미지 없음)", translated: emptyMessage });
      return;
    }

    chat.appendChild(renderLoading("(이미지 번역 중…)"));
    chat.scrollTop = chat.scrollHeight;

    try {
      const { targetLang, autoLangPair } = await resolveLangConfig();
      const translationResult = await translateImage(imageBase64, targetLang, autoLangPair);

      addEntry({
        original: "(이미지)",
        translated: translationResult.translatedText,
        isImage: true,
        imageBase64,
        imageExtractedText: translationResult.extractedText,
      });
    } catch (e) {
      removeLoading();
      addEntry({ original: "(이미지)", translated: `[오류] ${getErrorMessage(e)}`, isImage: true, imageBase64 });
    }
  } catch (e) {
    console.error("Image clipboard read error:", e);
  }
}

export function initClipboardListeners(_resolveLangConfig: () => Promise<LangConfig>): void {
  resolveLangConfig = _resolveLangConfig;

  listen("global-translate", async () => {
    try {
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
          const { targetLang, autoLangPair } = await resolveLangConfig();
          const result = await translateTable(tableHtml, targetLang, autoLangPair);
          addEntry({ original: displayText, translated: result, isTable: true, originalHtml: tableHtml });
        } catch (e) {
          removeLoading();
          addEntry({ original: displayText, translated: `[오류] ${getErrorMessage(e)}` });
        }
        return;
      }

      let clipText: string | null = null;
      try {
        clipText = await readText();
      } catch {}

      if (clipText && clipText.trim()) {
        const text = clipText.trim();
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
        return;
      }

      await handleImageTranslateFromClipboard("번역할 텍스트, 테이블, 또는 이미지를 복사한 후 다시 시도해주세요.");
    } catch (e) {
      console.error("Clipboard read error:", e);
    }
  });

  listen("global-translate-image", async () => {
    await handleImageTranslateFromClipboard("영역 캡처가 취소되었거나 이미지가 클립보드에 없습니다.");
  });
}
