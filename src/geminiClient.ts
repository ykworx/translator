import type { LlmBackend } from "./llmBackend";
import { readRuntimeForProvider } from "./connectionProfiles";

const { invoke, Channel } = window.__TAURI__.core;
export type GeminiConfig = Readonly<{ runtimeId: string; model: string }>;

async function textWithConfig(config: GeminiConfig, prompt: string): Promise<string> {
  return invoke<string>("gemini_generate_text", { runtimeId: config.runtimeId, prompt });
}

async function streamWithConfig(config: GeminiConfig, prompt: string, onChunk: (text: string) => void): Promise<string> {
  const channel = new Channel<string>();
  channel.onmessage = onChunk;
  return invoke<string>("gemini_generate_text_stream", { runtimeId: config.runtimeId, prompt, onChunk: channel });
}

async function imageWithConfig(config: GeminiConfig, prompt: string, imageBase64: string): Promise<string> {
  return invoke<string>("gemini_generate_image", { runtimeId: config.runtimeId, prompt, imageBase64 });
}

export async function generateText(prompt: string): Promise<string> {
  return textWithConfig(await readRuntimeForProvider("gemini-native"), prompt);
}

export async function generateTextStream(prompt: string, onChunk: (text: string) => void): Promise<string> {
  return streamWithConfig(await readRuntimeForProvider("gemini-native"), prompt, onChunk);
}

export async function generateImage(prompt: string, imageBase64: string): Promise<string> {
  return imageWithConfig(await readRuntimeForProvider("gemini-native"), prompt, imageBase64);
}

export function createGeminiBackend(config: GeminiConfig): LlmBackend {
  const snapshot = Object.freeze({ runtimeId: config.runtimeId, model: config.model });
  return {
    id: "gemini-native", label: "Gemini API", supportsVision: true,
    generateText: prompt => textWithConfig(snapshot, prompt),
    generateTextStream: (prompt, onChunk) => streamWithConfig(snapshot, prompt, onChunk),
    generateImage: (prompt, imageBase64) => imageWithConfig(snapshot, prompt, imageBase64),
  };
}

// Legacy entry point: resolve the selected native connection for each operation.
export const geminiNativeBackend: LlmBackend = {
  id: "gemini-native", label: "Gemini API", supportsVision: true,
  generateText, generateTextStream, generateImage,
};
