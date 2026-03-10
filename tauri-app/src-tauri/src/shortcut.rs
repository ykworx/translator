use log::error;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::window::show_window_centered;

// ─── Dynamic shortcut support ────────────────────────
#[cfg(target_os = "macos")]
pub const DEFAULT_SELECT_SHORTCUT: &str = "Super+Ctrl+KeyT";
#[cfg(target_os = "macos")]
pub const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Super+Ctrl+Shift+KeyT";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_SELECT_SHORTCUT: &str = "Ctrl+Alt+KeyT";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+Shift+KeyT";

pub struct CurrentShortcuts {
    pub select: Shortcut,
    pub clipboard: Shortcut,
}

pub fn str_to_code(s: &str) -> Result<Code, String> {
    Ok(match s {
        "KeyA" => Code::KeyA, "KeyB" => Code::KeyB, "KeyC" => Code::KeyC,
        "KeyD" => Code::KeyD, "KeyE" => Code::KeyE, "KeyF" => Code::KeyF,
        "KeyG" => Code::KeyG, "KeyH" => Code::KeyH, "KeyI" => Code::KeyI,
        "KeyJ" => Code::KeyJ, "KeyK" => Code::KeyK, "KeyL" => Code::KeyL,
        "KeyM" => Code::KeyM, "KeyN" => Code::KeyN, "KeyO" => Code::KeyO,
        "KeyP" => Code::KeyP, "KeyQ" => Code::KeyQ, "KeyR" => Code::KeyR,
        "KeyS" => Code::KeyS, "KeyT" => Code::KeyT, "KeyU" => Code::KeyU,
        "KeyV" => Code::KeyV, "KeyW" => Code::KeyW, "KeyX" => Code::KeyX,
        "KeyY" => Code::KeyY, "KeyZ" => Code::KeyZ,
        "Digit0" => Code::Digit0, "Digit1" => Code::Digit1,
        "Digit2" => Code::Digit2, "Digit3" => Code::Digit3,
        "Digit4" => Code::Digit4, "Digit5" => Code::Digit5,
        "Digit6" => Code::Digit6, "Digit7" => Code::Digit7,
        "Digit8" => Code::Digit8, "Digit9" => Code::Digit9,
        "F1" => Code::F1, "F2" => Code::F2, "F3" => Code::F3,
        "F4" => Code::F4, "F5" => Code::F5, "F6" => Code::F6,
        "F7" => Code::F7, "F8" => Code::F8, "F9" => Code::F9,
        "F10" => Code::F10, "F11" => Code::F11, "F12" => Code::F12,
        "Space" => Code::Space, "Enter" => Code::Enter,
        "Escape" => Code::Escape, "Tab" => Code::Tab,
        "Backspace" => Code::Backspace, "Delete" => Code::Delete,
        "Minus" => Code::Minus, "Equal" => Code::Equal,
        "BracketLeft" => Code::BracketLeft, "BracketRight" => Code::BracketRight,
        "Backslash" => Code::Backslash, "Semicolon" => Code::Semicolon,
        "Quote" => Code::Quote, "Backquote" => Code::Backquote,
        "Comma" => Code::Comma, "Period" => Code::Period, "Slash" => Code::Slash,
        _ => return Err(format!("Unknown key: {s}")),
    })
}

pub fn parse_shortcut_str(s: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = s.split('+').collect();
    let mut mods = Modifiers::empty();
    let mut key_code = None;
    for part in parts {
        match part.trim() {
            "Super" | "Cmd" | "Command" | "Meta" => mods |= Modifiers::SUPER,
            "Ctrl" | "Control" => mods |= Modifiers::CONTROL,
            "Shift" => mods |= Modifiers::SHIFT,
            "Alt" | "Option" => mods |= Modifiers::ALT,
            k => key_code = Some(str_to_code(k)?),
        }
    }
    let code = key_code.ok_or_else(|| "No key specified".to_string())?;
    Ok(Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, code))
}

/// Handle select-translate shortcut: simulate Cmd+C then translate clipboard.
fn handle_select_shortcut(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            use core_graphics::event::{CGEvent, CGEventFlags, CGKeyCode};
            use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
            const KEY_C: CGKeyCode = 8;
            match CGEventSource::new(CGEventSourceStateID::HIDSystemState) {
                Ok(source) => {
                    if let Err(()) = CGEvent::new_keyboard_event(source.clone(), KEY_C, true).map(|ev| {
                        ev.set_flags(CGEventFlags::CGEventFlagCommand);
                        ev.post(core_graphics::event::CGEventTapLocation::HID);
                    }) {
                        error!("Failed to create Cmd+C key-down event");
                    }
                    if let Err(()) = CGEvent::new_keyboard_event(source, KEY_C, false).map(|ev| {
                        ev.set_flags(CGEventFlags::CGEventFlagCommand);
                        ev.post(core_graphics::event::CGEventTapLocation::HID);
                    }) {
                        error!("Failed to create Cmd+C key-up event");
                    }
                }
                Err(()) => error!("Failed to create CGEventSource for simulated copy"),
            }
        }
        #[cfg(target_os = "windows")]
        {
            if let Err(e) = std::process::Command::new("powershell")
                .arg("-Command")
                .arg("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')")
                .output()
            {
                error!("Failed to simulate Ctrl+C via powershell: {e}");
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Err(e) = std::process::Command::new("xdotool")
                .args(["key", "ctrl+c"])
                .output()
            {
                error!("Failed to simulate Ctrl+C via xdotool: {e}");
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        // Window/AppKit operations must run on the main thread
        let app_main = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            if let Some(window) = app_main.get_webview_window("main") {
                show_window_centered(&window);
                if let Err(e) = window.emit("global-translate", ()) {
                    error!("Failed to emit global-translate event: {e}");
                }
            }
        }) {
            error!("Failed to dispatch to main thread: {e}");
        }
    });
}

/// Handle clipboard-translate shortcut: translate clipboard as-is.
fn handle_clipboard_shortcut(app: tauri::AppHandle) {
    // Window/AppKit operations must run on the main thread
    let app_main = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Some(window) = app_main.get_webview_window("main") {
            show_window_centered(&window);
            if let Err(e) = window.emit("global-translate", ()) {
                error!("Failed to emit global-translate event: {e}");
            }
        }
    }) {
        error!("Failed to dispatch to main thread: {e}");
    }
}

/// Register both shortcut handlers.
pub fn register_shortcut_handlers(
    app: &tauri::AppHandle,
    select: Shortcut,
    clipboard: Shortcut,
) -> Result<(), Box<dyn std::error::Error>> {
    let gs = app.global_shortcut();
    gs.on_shortcut(select, {
        let app = app.clone();
        move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                handle_select_shortcut(app.clone());
            }
        }
    })?;
    gs.on_shortcut(clipboard, {
        let app = app.clone();
        move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                handle_clipboard_shortcut(app.clone());
            }
        }
    })?;
    Ok(())
}

#[tauri::command]
pub fn suspend_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
) -> Result<(), String> {
    let current = state.lock().map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    gs.unregister(current.select.clone()).map_err(|e| e.to_string())?;
    gs.unregister(current.clipboard.clone()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn resume_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
) -> Result<(), String> {
    let current = state.lock().map_err(|e| e.to_string())?;
    let gs = app.global_shortcut();
    // Unregister first to avoid "already registered" errors
    gs.unregister(current.select.clone()).ok();
    gs.unregister(current.clipboard.clone()).ok();
    register_shortcut_handlers(&app, current.select.clone(), current.clipboard.clone())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn update_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
    select_shortcut: String,
    clipboard_shortcut: String,
) -> Result<(), String> {
    let new_select = parse_shortcut_str(&select_shortcut)?;
    let new_clipboard = parse_shortcut_str(&clipboard_shortcut)?;

    let mut current = state.lock().map_err(|e| e.to_string())?;

    let gs = app.global_shortcut();
    // Ignore unregister errors — shortcuts may already be suspended
    gs.unregister(current.select.clone()).ok();
    gs.unregister(current.clipboard.clone()).ok();

    register_shortcut_handlers(&app, new_select.clone(), new_clipboard.clone())
        .map_err(|e| e.to_string())?;

    current.select = new_select;
    current.clipboard = new_clipboard;
    Ok(())
}
