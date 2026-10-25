# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project Overview

**Transrator** is a macOS-first popup translator built with Tauri 2 and vanilla TypeScript. It supports Gemini, OpenAI, and Ollama backends; text/table/image translation; handwriting recognition; microphone input; and experimental app-audio captions. Microphone and app-audio capture are macOS-only.

## Commands

Run from the repository root:

```bash
# Install frontend dependencies and initialize native dependencies
npm ci
git submodule update --init --recursive

# Development: starts Vite and Tauri using the project-local CLI
npm run tauri -- dev

# Production app bundle (includes the frontend build)
npm run tauri -- build

# Frontend only (Vite on port 1420; native IPC requires Tauri)
npm run dev

# Frontend production build; type checking is a separate command
npm run build
npm run typecheck

# Frontend unit tests and watch mode
npm test
npm run test:watch

# Rust unit tests; requires native build dependencies on macOS
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Frontend tests use Vitest, jsdom, and Tauri mocks in `tests/helpers/`. Rust unit tests are in `src-tauri/src/openai.rs`. Speech benchmarks and their optional Python dependencies are documented in `tests/README.md`. Unit tests do not validate live OS permissions, audio capture, or global shortcuts.

## Architecture

```text
src/                       Frontend (vanilla TypeScript, no framework)
  main.ts                  Initialization, manual translation, keyboard handling
  api.ts / prompts.ts      Task-level APIs, response parsing, prompt construction
  llmBackend.ts            LlmBackend interface and backend selection/cache
  geminiClient.ts          Gemini requests and SSE streaming
  ollamaClient.ts          Ollama requests, streaming, capability discovery
  openaiClient.ts          OpenAI requests via Rust commands and IPC channels
  llmProfile.ts            Backend settings migration and Ollama detection
  clipboardTranslate.ts    Clipboard text/table/image translation
  ui.ts / styles.css       Chat rendering, table sanitization, theming
  settings.ts / store.ts   Settings UI and Tauri Store access
  speechInput.ts           Microphone input and transcript polling
  appCaptions.ts           App-audio events, translation queue, caption rendering
  handwriting*.ts          Handwriting panel and full-screen overlay
src-tauri/
  src/lib.rs               App setup, command registration, tray, window lifecycle
  src/shortcut.rs          Global shortcuts and simulated selection copy
  src/clipboard.rs         Native clipboard HTML/image handling
  src/window.rs            Window placement and visibility helpers
  src/openai.rs            OpenAI HTTP requests, retries, streaming
  src/speech.rs            Microphone commands and Swift FFI
  src/caption_capture.rs   App-audio commands and Swift event bridge
  src/model_manager.rs     Whisper download, loading, idle unloading
  src/benchmark.rs         Native speech benchmark commands
  src/main.rs              App entry point and WAV benchmark CLI
  swift/                   Whisper engine, mic/app capture, VAD, performance tracking
  build.rs                 Native Whisper/RNNoise and Swift compilation
  vendor/                  Native dependencies and VAD resources
```

### Frontend-Backend Communication

- **Clipboard commands**: `read_clipboard_html`, `read_clipboard_image`, `write_clipboard_html`
- **Speech commands**: `request_speech_permissions`, `start_speech_recognition`, `stop_speech_recognition`, `get_speech_recognition_state`
- **Caption commands**: `request_caption_capture_permissions`, `start_app_captions`, `stop_app_captions`, window selection and state commands
- **Model commands**: `check_whisper_model`, `download_whisper_model`, `load_whisper_model`, `ensure_whisper_loaded`, `delete_whisper_model`, `set_whisper_domain_hint`
- **OpenAI commands**: `openai_generate_text`, `openai_generate_text_stream`, `openai_generate_image`; streaming uses a Tauri IPC `Channel`
- **UI/shortcut commands**: `open_handwriting_overlay`, `update_shortcuts`, `suspend_shortcuts`, `resume_shortcuts`
- **Events**: `global-translate`, `global-translate-image`, `app-caption-update`, `model-download-progress`, `experimental-captions-changed`, `handwriting-overlay-result`
- **Plugins**: clipboard-manager, global-shortcut, store (persistence), opener

### Translation Flow

1. The selection shortcut simulates copy, then emits `global-translate`. On macOS the capture shortcut runs interactive region capture, then emits `global-translate-image`.
2. Clipboard translation checks HTML tables, text, then images. Manual text input uses streaming translation.
3. Task APIs build prompts and select the configured `LlmBackend`. Gemini and Ollama requests run in the frontend; OpenAI HTTP requests run in Rust.
4. Results render in the chat UI. Successful clipboard text/table translations are copied back to the clipboard.

### Key Patterns and Current Constraints

- Platform-specific Rust code uses `#[cfg(target_os = "...")]`; macOS audio features use Swift FFI. Native macOS builds require the Swift SDK, CMake, and initialized Whisper/RNNoise submodules.
- State is held in module-level variables. Persistent settings, including API keys, use Tauri Store's `settings.json` in the app data directory; Keychain storage is not implemented.
- `constants.ts` defines setting keys, defaults, languages, and model options. The saved Whisper model selection currently does not control the fixed native download/load target.
- Whisper is loaded on demand and scheduled for unloading after 30 seconds of inactivity. The current permission bridge also requires a loaded model, while frontend startup checks permissions before ensuring the model is loaded; do not assume cold starts work.
- Table HTML is stripped of style/class/data attributes before API use and sanitized for rendering in `ui.ts`.
- The main window starts hidden and hides on close, leaving the tray app running. Its transparent HUD appearance and SF Pro styling target macOS.
- The macOS bundle configuration specifies the `Transrator Developer` signing identity; packaging requires a matching local signing setup.

## Conventions

- Git commit messages are written in Korean
- No frontend framework — all DOM manipulation is vanilla JS
- CSS uses variables for theming (--bg, --card-bg, --fg, etc.)
- Keep macOS-native interactions and cross-platform fallback paths explicit.
