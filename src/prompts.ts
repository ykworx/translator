export interface AutoLangPair {
  myLang: string;
  pairLang: string;
}

export function buildTranslatePrompt(text: string, targetLang: string, autoLangPair?: AutoLangPair, context?: string): string {
  const langInstruction = autoLangPair
    ? `You are a translator. Detect the language of the text and translate it.\n` +
      `- If the text is written in ${autoLangPair.myLang} → translate to ${autoLangPair.pairLang}\n` +
      `- If the text is written in ${autoLangPair.pairLang} → translate to ${autoLangPair.myLang}\n` +
      `- If the text is in any other language → translate to ${autoLangPair.myLang}\n` +
      `IMPORTANT: You MUST translate. Never return the original text as-is.\n`
    : `Translate the following text to ${targetLang}.\n`;

  const contextBlock = context
    ? `Previous context (for reference only, do NOT translate this):\n${context}\n\nText to translate:\n`
    : "";

  return langInstruction +
    `Output ONLY the translation, no explanations.\n\n` +
    contextBlock +
    text;
}

export function buildTranslateTablePrompt(tableHtml: string, targetLang: string, autoLangPair?: AutoLangPair): string {
  const langInstruction = autoLangPair
    ? `Detect the language of the table text and translate it.\n` +
      `- If the text is written in ${autoLangPair.myLang} → translate to ${autoLangPair.pairLang}\n` +
      `- If the text is written in ${autoLangPair.pairLang} → translate to ${autoLangPair.myLang}\n` +
      `- If the text is in any other language → translate to ${autoLangPair.myLang}\n`
    : `Translate ALL text in the following HTML table to ${targetLang}.\n`;

  return langInstruction +
    `IMPORTANT RULES:\n` +
    `- Translate ALL text, including technical terms\n` +
    `- Keep ALL HTML tags and attributes (rowspan, colspan, etc.) EXACTLY as-is\n` +
    `- Do NOT translate: product IDs, version numbers, URLs, English words\n` +
    `- Do NOT add, remove, or modify any HTML tags\n` +
    `- Output ONLY the translated HTML table, nothing else\n\n` +
    tableHtml;
}

export function buildSuggestRepliesPrompt(original: string, translated: string): string {
  return "You are a helpful assistant for a Korean professional working in a Japanese company.\n" +
    "Based on the following message, suggest 3 short reply options.\n" +
    "For each reply, provide both Korean and Japanese versions.\n" +
    "Format: KR: ... | JP: ...\n\n" +
    "Japanese reply style: polite business Japanese, concise, Slack-appropriate.\n" +
    "Output ONLY 3 replies, numbered 1. 2. 3.\n\n" +
    `Original: ${original}\nTranslation: ${translated}`;
}

export function buildTranslateImagePrompt(targetLang: string, autoLangPair?: AutoLangPair): string {
  const langInstruction = autoLangPair
    ? `2. Detect the language: if in ${autoLangPair.myLang}, translate to ${autoLangPair.pairLang}. If in ${autoLangPair.pairLang}, translate to ${autoLangPair.myLang}. For any other language, translate to ${autoLangPair.myLang}. You MUST translate, never return original text.\n\n`
    : `2. Translate ALL text to ${targetLang}\n\n`;

  return `This image contains text. Do the following:\n` +
    `1. Extract ALL text from the image\n` +
    langInstruction +
    `Format your response EXACTLY like this:\n` +
    `[원문]\n(extracted text)\n\n` +
    `[번역]\n(translation)`;
}

export function buildSummarizePrompt(original: string, translated: string): string {
  return "You are a helpful assistant. Summarize the following text in 2-3 concise bullet points in Korean.\n" +
    "Rules:\n" +
    "- Write in Korean\n" +
    "- Keep each bullet point short (1 sentence)\n" +
    "- Capture the key points only\n" +
    "- Use bullet format: • point\n" +
    "- Output ONLY the summary, nothing else.\n\n" +
    `Original: ${original}\nTranslation: ${translated}`;
}

export function buildKoreanPronunciationPrompt(text: string): string {
  return "Write the Korean pronunciation (reading) of the following text.\n" +
    "Rules:\n" +
    "- Japanese -> Korean phonetic transcription\n" +
    "- English -> Korean phonetic transcription\n" +
    "- Kanji -> Japanese reading in Korean\n" +
    "- Output ONLY the pronunciation, nothing else.\n\n" +
    `Text: ${text}`;
}
