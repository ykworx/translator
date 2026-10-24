# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**Transrator** - A macOS popup translator desktop app built with Tauri 2 + vanilla TypeScript. Uses Google Gemini API for AI-powered translation. Activated via global hotkey (Cmd+Ctrl+T), it copies selected text/table/image from clipboard and translates it.

## Commands

```bash
# Development (starts both Vite dev server and Tauri)
cargo tauri dev

# Build for production
cargo tauri build

# Frontend only (Vite dev server on port 1420)
npm run dev

# Frontend build
npm run build
```

No test suite exists in this project.

## Architecture

```
src/           → Frontend (vanilla TypeScript, no framework)
  main.ts      → All app logic: Gemini API calls, UI rendering, event handling, state
  styles.css   → Glassmorphism UI with dark mode, CSS variables
src-tauri/     → Backend (Rust/Tauri 2)
  src/lib.rs   → Tauri commands, global shortcut, tray icon, clipboard (native)
  src/main.rs  → Entry point (minimal)
```

### Frontend-Backend Communication

- **Commands (invoke)**: `read_clipboard_html`, `read_clipboard_image`, `tray_anim_start`, `tray_anim_stop`
- **Events (emit)**: `global-translate` (triggers translation)
- **Plugins**: clipboard-manager, global-shortcut, store (persistence), opener

### Translation Flow

1. Global hotkey → Rust simulates Cmd+C via CoreGraphics → emits `global-translate`
2. Frontend reads clipboard: HTML table → text → image (priority order)
3. Frontend calls Gemini API directly (no backend proxy)
4. Results rendered in chat-style UI

### Key Patterns

- **Platform-specific code** in lib.rs uses `#[cfg(target_os = "...")]` — macOS uses CoreGraphics, Windows uses PowerShell, Linux uses xdotool
- **Tray icon animation** runs in a separate thread with `Arc<AtomicBool>` control
- **State**: simple global variables in main.ts, persistent config via Tauri Store plugin
- **Table translation**: strips style/class/data-* attributes before sending to API to reduce tokens
- **Window**: starts hidden, hides on close (stays in tray), transparent with backdrop blur

## Conventions

- Git commit messages are written in Korean
- No frontend framework — all DOM manipulation is vanilla JS
- CSS uses variables for theming (--bg, --card-bg, --fg, etc.)
- macOS-first design (SF Pro font, HUD window effects, Keychain storage)
