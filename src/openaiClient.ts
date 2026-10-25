import { readRuntimeForProvider } from "./connectionProfiles";
import type { LlmBackend } from "./llmBackend";

// OpenAI's API does not send permissive CORS headers, so the browser/webview
// cannot call it directly. All HTTP is routed through Rust (see src-tauri/src/openai.rs).
const { invoke, Channel } = window.__TAURI__.core;

export type OpenAiConfig = Readonly<{ runtimeId: string; model: string }>;

export async function generateText(prompt: string): Promise<string> {
  return generateTextWithConfig(await readRuntimeForProvider("openai"), prompt);
}

async function generateTextWithConfig({ runtimeId }: OpenAiConfig, prompt: string): Promise<string> {
  return invoke<string>("openai_generate_text", { runtimeId, prompt });
}

export async function generateTextStream(
  prompt: string,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  return generateTextStreamWithConfig(await readRuntimeForProvider("openai"), prompt, onChunk);
}

async function generateTextStreamWithConfig(
  { runtimeId }: OpenAiConfig,
  prompt: string,
  onChunk: (accumulated: string) => void,
): Promise<string> {

  const channel = new Channel<string>();
  channel.onmessage = (accumulated) => onChunk(accumulated);

  return invoke<string>("openai_generate_text_stream", { runtimeId, prompt, onChunk: channel });
}

export async function generateImage(prompt: string, base64Png: string): Promise<string> {
  return generateImageWithConfig(await readRuntimeForProvider("openai"), prompt, base64Png);
}

async function generateImageWithConfig({ runtimeId }: OpenAiConfig, prompt: string, base64Png: string): Promise<string> {
  // JS `imageBase64` → Rust `image_base64` (Tauri auto camel↔snake conversion).
  return invoke<string>("openai_generate_image", { runtimeId, prompt, imageBase64: base64Png });
}

/**
 * Heuristic to determine if an OpenAI model supports vision (image) input.
 *
 * Returns true for:
 *  - gpt-4o family (gpt-4o, gpt-4o-mini, chatgpt-4o-*)
 *  - gpt-4.1 family (gpt-4.1, gpt-4.1-mini, etc.)
 *  - gpt-4-turbo (NOT the base gpt-4 without "turbo")
 *  - o1, o3, o4 reasoning model families
 *
 * Returns false for:
 *  - empty string
 *  - gpt-3.5-turbo (GPT-3.5 family has no vision)
 *  - base gpt-4 (non-turbo) — "gpt-4" exactly or "gpt-4-0314" etc.
 */
export function isVisionCapableModel(model: string): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();

  if (lower.startsWith("gpt-4o")) return true;
  if (lower.startsWith("chatgpt-4o")) return true;
  if (lower.startsWith("gpt-4.1")) return true;
  if (lower.startsWith("gpt-4-turbo")) return true;
  if (lower.startsWith("o1")) return true;
  if (lower.startsWith("o3")) return true;
  if (lower.startsWith("o4")) return true;

  return false;
}

export async function getOpenAiBackend(config?: OpenAiConfig): Promise<LlmBackend> {
  const resolved = config ?? await readRuntimeForProvider("openai");
  const snapshot = Object.freeze({ runtimeId: resolved.runtimeId, model: resolved.model });
  if (!snapshot.runtimeId) {
    throw new Error("OpenAI 연결이 유효하지 않습니다. 설정에서 연결을 확인해주세요.");
  }

  return {
    id: "openai",
    label: "OpenAI (GPT)",
    supportsVision: isVisionCapableModel(snapshot.model),
    generateText: prompt => generateTextWithConfig(snapshot, prompt),
    generateTextStream: (prompt, onChunk) => generateTextStreamWithConfig(snapshot, prompt, onChunk),
    generateImage: (prompt, base64Png) => generateImageWithConfig(snapshot, prompt, base64Png),
  };
}
