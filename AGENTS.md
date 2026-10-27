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

# macOS native policies, private AppKit pasteboard, and benchmark runner tests
bash tests/run_native_dictation_tests.sh
```

Frontend tests use Vitest, jsdom, and Tauri mocks in `tests/helpers/`. Rust unit tests cover OpenAI, shortcut registration/rollback, model selection, and installation guards. The native script tests state/transcript policies, real AppKit private pasteboards, and a standard-library Python benchmark runner without microphone access. See `docs/GLOBAL_DICTATION.md` for dictation usage, offline WAV tests, and the actual-vs-mocked QA matrix; `tests/README.md` documents the older ASR benchmarks. Automated tests do not establish live microphone quality or insertion compatibility with every external app.

## Architecture

```text
src/                       Frontend (vanilla TypeScript, no framework)
  main.ts                  Initialization, manual translation, keyboard handling
  api.ts / prompts.ts      Task-level APIs, response parsing, prompt construction
  llmBackend.ts            LlmBackend interface and snapshot-bound backend cache
  providerRegistry.ts      Fixed provider protocol/auth/factory contracts
  connectionProfiles.ts    Native profile snapshots, credential status/save/delete IPC
  geminiClient.ts          Gemini native-command adapter and streaming channels
  ollamaClient.ts          Ollama requests, streaming, capability discovery
  openaiClient.ts          OpenAI requests via Rust commands and IPC channels
  llmProfile.ts            Backend settings migration and Ollama detection
  clipboardTranslate.ts    Clipboard text/table/image translation
  ui.ts / styles.css       Chat rendering, table sanitization, theming
  settings.ts / store.ts   Settings UI and Tauri Store access
  speechInput.ts           Microphone input and transcript polling
  screenPen.ts             Screen pen entry; AppKit drawing lives in swift/ScreenPen.swift
  appCaptions.ts           App-audio events, translation queue, caption rendering
  handwriting*.ts          Handwriting panel and full-screen overlay
src-tauri/
  src/lib.rs               App setup, command registration, tray, window lifecycle
  src/shortcut.rs          Global shortcuts and simulated selection copy
  src/clipboard.rs         Native clipboard HTML/image handling
  src/window.rs            Window placement and visibility helpers
  src/openai.rs            OpenAI HTTP requests, retries, streaming
  src/gemini.rs            Gemini HTTP, retry/rate limit, SSE streaming
  src/cloud_http.rs        Fixed-origin transport, redirect rejection, safe errors
  src/connections.rs       Keychain migration, credential metadata, native runtimes
  src/settings_store.rs    Non-secret settings IPC and atomic file persistence
  src/speech.rs            Microphone commands and Swift FFI
  src/caption_capture.rs   App-audio commands and Swift event bridge
  src/model_manager.rs     Whisper download, loading, idle unloading
  src/speech_model.rs      Supported model IDs and matching encoder/download paths
  src/dictation.rs         Native global dictation, permissions, device inventory
  src/benchmark.rs         Native speech benchmark commands
  src/main.rs              App entry point and WAV benchmark CLI
  swift/                   Whisper engine, mic/app capture, VAD, dictation panel/delivery
  build.rs                 Native Whisper/RNNoise and Swift compilation
  vendor/                  Native dependencies and VAD resources
```

### Frontend-Backend Communication

- **Clipboard commands**: `read_clipboard_html`, `read_clipboard_image`, `write_clipboard_html`
- **Speech commands**: `request_speech_permissions`, `start_speech_recognition`, `stop_speech_recognition`, `get_speech_recognition_state`
- **Dictation commands**: `toggle_global_dictation`, `list_dictation_microphones`, `get_dictation_permissions`, `request_dictation_permissions`, `preview_dictation_panel`
- **Shortcut diagnostics**: `get_shortcut_status`; tracks actual registration, conflicts, and suspension
- **Caption commands**: `request_caption_capture_permissions`, `start_app_captions`, `stop_app_captions`, window selection and state commands
- **Model commands**: `check_whisper_model`, `download_whisper_model`, `load_whisper_model`, `ensure_whisper_loaded`, `delete_whisper_model`, `set_whisper_domain_hint`
- **Credential commands**: `capture_connection`, `get_credential_status`, `save_provider_credential`, `delete_provider_credential`; settings use `settings_load/get/set/delete/save` without generic Store permissions
- **Gemini commands**: `gemini_generate_text`, `gemini_generate_text_stream`, `gemini_generate_image`; cloud generation accepts a native `runtimeId`, never a stored key
- **OpenAI commands**: `openai_generate_text`, `openai_generate_text_stream`, `openai_generate_image`; streaming uses a Tauri IPC `Channel`
- **Screen pen command**: `open_screen_pen`; temporary native macOS drawing panel with clear and close, no capture or AI requests
- **UI/shortcut commands**: `open_handwriting_overlay`, `update_shortcuts`, `suspend_shortcuts`, `resume_shortcuts`
- **Events**: `global-translate`, `global-translate-image`, `app-caption-update`, `model-download-progress`, `experimental-captions-changed`, `handwriting-overlay-result`
- **Plugins**: clipboard-manager, global-shortcut, store (persistence), opener

### Translation Flow

1. The selection shortcut simulates copy, then emits `global-translate`. On macOS the capture shortcut runs interactive region capture, then emits `global-translate-image`.
2. Clipboard translation checks HTML tables, text, then images. Manual text input uses streaming translation.
3. Task APIs build prompts and select the configured `LlmBackend`. Ollama requests run in the frontend; Gemini and OpenAI HTTP requests run in Rust using opaque runtime IDs.
4. Results render in the chat UI. Successful clipboard text/table translations are copied back to the clipboard.

### Key Patterns and Current Constraints

- Platform-specific Rust code uses `#[cfg(target_os = "...")]`; macOS audio features use Swift FFI. Native macOS builds require the Swift SDK, CMake, and initialized Whisper/RNNoise submodules.
- General settings use `settings.json` through a fixed-path native non-secret allowlist. Never restore generic Store IPC permissions or put API keys in general settings, logs, fingerprints, or responses. macOS credentials use Keychain; native-only `auth-profiles.json` holds references/revisions. Secure cloud auth is currently macOS-only; other platforms must fail closed rather than save plaintext. See `docs/CONNECTIONS.md`.
- `capture_connection` binds native runtime model/endpoint/credential snapshots. Only opaque IDs and non-secret metadata cross IPC; typed replacement keys are sent once to native save commands. Cloud requests resolve the expected provider before HTTP, use fixed origins, and reject redirects. Unknown providers, corrupt settings, or credential failures must not fall back to another backend.
- Migrate only the requested cloud provider: verify Keychain write/read, atomically commit/read back metadata, then remove the legacy key and atomically flush settings. Preserve recovery data on failure and never rebroadcast a legacy secret through Store events. Credential save/delete use expected revisions; missing Keychain items expose an error plus revision for explicit repair. General multi-key settings saves are not transactional; multiple saved connection profiles remain future work.
- Runtime IDs are stable for identical config, limited to 128 sessions, and never persisted. Rotation keeps immutable in-flight snapshots; explicit delete invalidates the provider's handles. Verified recovery/orphan Keychain items can remain after rotation or failed commits; automatic garbage collection is not implemented. Do not claim physical removal of every historical key. Tests use fake vaults; real Keychain signing/ACL behavior requires an isolated signed-app check.
- Ollama is the only supported local LLM runtime; do not add other local LLM runtimes or presets unless the user changes this decision. Preserve saved LAN/proxy endpoints. Loopback alone does not prove local inference because Ollama also supports cloud models. See `docs/LOCAL_MODELS.md`; do not automatically change the user's server or model reference.
- `constants.ts` defines setting keys, defaults, languages, and model options. `whisperModel` selects Medium, Large V3 Turbo, or Large V3 for all speech features. Model status/download/delete commands accept an optional model ID for unsaved UI selections.
- OS permissions are independent of model loading. Models load on blocking workers; context initialization, inference, warm-up, and destruction are mutually exclusive. An active capture prevents model replacement/deletion.
- Global dictation runs natively while the webview is hidden. `Cmd+Ctrl+D` toggles recording; the nonactivating AppKit panel previews partial text and submits one final paste. Captures, callbacks, and producers carry session generations. Do not drive this lifecycle from frontend polling.
- Model retention after global dictation defaults to 300 seconds (`dictationIdleSeconds`, 0 means until exit); other speech features retain the 30-second unload schedule. Global recordings stop after 3 minutes.
- Input delivery revalidates the target app/element/selection/value and preserves pasteboard representations through a lease. Unsupported or changed targets use copy recovery. Do not automatically retry a posted paste event, which has no delivery acknowledgement. Password fields are excluded and terminals use copy-only mode.
- Table HTML is stripped of style/class/data attributes before API use and sanitized for rendering in `ui.ts`.
- The main window starts hidden and hides on close, leaving the tray app running. Its transparent HUD appearance and SF Pro styling target macOS.
- The macOS bundle configuration specifies the `Transrator Developer` signing identity; packaging requires a matching local signing setup.

## Conventions

- Git commit messages are written in Korean
- No frontend framework — all DOM manipulation is vanilla JS
- CSS uses variables for theming (--bg, --card-bg, --fg, etc.)
- Keep macOS-native interactions and cross-platform fallback paths explicit.
