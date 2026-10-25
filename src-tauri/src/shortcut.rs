use log::error;
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShortcutAction { Select, Clipboard, Dictation }

#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding { shortcut: Shortcut, action: ShortcutAction }

pub struct CurrentShortcuts {
    pub select: Shortcut,
    pub clipboard: Shortcut,
    pub dictation: Shortcut,
    registered: Vec<Binding>,
    resume_bindings: Vec<Binding>,
    suspended: bool,
    last_error: Option<String>,
}

impl CurrentShortcuts {
    fn is_registered(&self, action: ShortcutAction, shortcut: &Shortcut) -> bool {
        self.registered.iter().any(|binding| binding.action == action && &binding.shortcut == shortcut)
    }
    pub fn new(select: Shortcut, clipboard: Shortcut, dictation: Shortcut) -> Self {
        Self { select, clipboard, dictation, registered: Vec::new(), resume_bindings: Vec::new(),
            suspended: false, last_error: None }
    }

    fn bindings(&self) -> Vec<Binding> {
        let mut bindings = vec![Binding { shortcut: self.select.clone(), action: ShortcutAction::Select },
            Binding { shortcut: self.clipboard.clone(), action: ShortcutAction::Clipboard }];
        if cfg!(target_os = "macos") {
            bindings.push(Binding { shortcut: self.dictation.clone(), action: ShortcutAction::Dictation });
        }
        bindings
    }
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
    #[cfg(target_os = "macos")]
    {
        std::thread::spawn(move || {
            let capture = std::process::Command::new("screencapture")
                .args(["-i", "-c", "-x"])
                .status();

            match capture {
                Ok(status) if status.success() => {
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    let app_main = app.clone();
                    if let Err(e) = app.run_on_main_thread(move || {
                        if let Some(window) = app_main.get_webview_window("main") {
                            show_window_centered(&window);
                            if let Err(e) = window.emit("global-translate-image", ()) {
                                error!("Failed to emit global-translate-image event: {e}");
                            }
                        }
                    }) {
                        error!("Failed to dispatch image translate to main thread: {e}");
                    }
                }
                Ok(_) => {}
                Err(e) => error!("Failed to run screencapture for area capture translate: {e}"),
            }
        });
        return;
    }

    #[cfg(not(target_os = "macos"))]
    // Window/AppKit operations must run on the main thread
    {
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
}

/// Validate before removing working shortcuts, including equivalent spellings.
fn validate_shortcuts(select: &Shortcut, clipboard: &Shortcut, dictation: Option<&Shortcut>) -> Result<(), String> {
    if select == clipboard || dictation.is_some_and(|dictation| select == dictation || clipboard == dictation) {
        return Err("기능별 단축키는 서로 달라야 합니다.".into());
    }
    Ok(())
}

// Keep the actual registered set: startup may legitimately omit a conflicting binding.
fn register_missing_with(
    registered: &mut Vec<Binding>, desired: &[Binding],
    register: &mut impl FnMut(&Binding) -> Result<(), String>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for binding in desired {
        if registered.contains(binding) { continue; }
        let result = if registered.iter().any(|old| old.shortcut == binding.shortcut) {
            Err("다른 기능과 단축키가 같습니다.".into())
        } else { register(binding) };
        match result {
            Ok(()) => registered.push(binding.clone()),
            Err(error) => errors.push(format!("{:?} ({}): {error}", binding.action, binding.shortcut)),
        }
    }
    errors
}

fn remove_registered_with(
    registered: &mut Vec<Binding>, unregister: &mut impl FnMut(&Binding) -> Result<(), String>,
) -> Vec<String> {
    let mut errors = Vec::new();
    for index in (0..registered.len()).rev() {
        match unregister(&registered[index]) {
            Ok(()) => { registered.remove(index); }
            Err(error) => errors.push(format!("{} 해제 실패: {error}", registered[index].shortcut)),
        }
    }
    errors
}

fn replace_bindings_with(
    registered: &mut Vec<Binding>, desired: &[Binding],
    register: &mut impl FnMut(&Binding) -> Result<(), String>,
    unregister: &mut impl FnMut(&Binding) -> Result<(), String>,
) -> Result<(), String> {
    let previous = registered.clone();
    let mut errors = remove_registered_with(registered, unregister);
    if errors.is_empty() {
        errors = register_missing_with(registered, desired, register);
        if errors.is_empty() { return Ok(()); }
        errors.extend(remove_registered_with(registered, unregister));
    }
    let restore_errors = register_missing_with(registered, &previous, register);
    let restored = restore_errors.is_empty();
    errors.extend(restore_errors);
    Err(format!("{} ({})", errors.join("; "),
        if restored { "기존 단축키 복원 완료" } else { "기존 단축키 복원 실패" }))
}

fn register_binding(app: &tauri::AppHandle, binding: &Binding) -> Result<(), String> {
    let handle = app.clone();
    let action = binding.action;
    let dictation_pressed = AtomicBool::new(false);
    app.global_shortcut().on_shortcut(binding.shortcut.clone(), move |_app, _shortcut, event| {
        if action == ShortcutAction::Dictation {
            if !accept_dictation_press(&dictation_pressed, event.state) { return; }
        } else if event.state != ShortcutState::Pressed { return; }
        match action {
            ShortcutAction::Select => handle_select_shortcut(handle.clone()),
            ShortcutAction::Clipboard => handle_clipboard_shortcut(handle.clone()),
            ShortcutAction::Dictation => {
                let app = handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::dictation::toggle_global_dictation(app).await {
                        error!("Failed to toggle dictation: {error}");
                    }
                });
            }
        }
    }).map_err(|error| error.to_string())
}

fn accept_dictation_press(pressed: &AtomicBool, state: ShortcutState) -> bool {
    if state == ShortcutState::Released {
        pressed.store(false, Ordering::Relaxed);
        false
    } else {
        // Holding the key must not copy a pending result and then start a new
        // microphone session through autorepeated Pressed notifications.
        !pressed.swap(true, Ordering::Relaxed)
    }
}

fn unregister_binding(app: &tauri::AppHandle, binding: &Binding) -> Result<(), String> {
    app.global_shortcut().unregister(binding.shortcut.clone()).map_err(|error| error.to_string())
}

/// A new shortcut conflict must not prevent the translator/tray from starting.
pub fn register_startup_shortcuts(app: &tauri::AppHandle, current: &mut CurrentShortcuts) {
    let desired = current.bindings();
    let errors = register_missing_with(&mut current.registered, &desired, &mut |binding| register_binding(app, binding));
    if !errors.is_empty() {
        let message = errors.join("; ");
        error!("Some global shortcuts could not be registered: {message}");
        current.last_error = Some(message);
    }
    refresh_dictation_tray(app, current);
}

fn dictation_tray_text(current: &CurrentShortcuts) -> String {
    let mut label = String::new();
    for (modifier, symbol) in [(Modifiers::CONTROL, "⌃"), (Modifiers::ALT, "⌥"), (Modifiers::SHIFT, "⇧"), (Modifiers::SUPER, "⌘")] {
        if current.dictation.mods.contains(modifier) { label.push_str(symbol); }
    }
    let key = current.dictation.key.to_string();
    label.push_str(key.strip_prefix("Key").or_else(|| key.strip_prefix("Digit")).unwrap_or(&key));
    label.push_str(if current.suspended { " · 단축키 일시 중지" }
        else if current.is_registered(ShortcutAction::Dictation, &current.dictation) { " · 어디서나 받아쓰기" }
        else { " · 받아쓰기 단축키 등록 확인 필요" });
    label
}

fn refresh_dictation_tray(app: &tauri::AppHandle, current: &CurrentShortcuts) {
    #[cfg(target_os = "macos")]
    {
        let text = dictation_tray_text(current);
        let handle = app.clone();
        // Do not wait on the UI thread while holding CurrentShortcuts.
        if let Err(e) = app.run_on_main_thread(move || {
            if let Some(item) = handle.try_state::<crate::DictationTrayHint>() {
                if let Err(e) = item.0.set_text(text) { error!("Failed to update dictation tray hint: {e}"); }
            }
        }) { error!("Failed to schedule dictation tray hint: {e}"); }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, current); }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    select_registered: bool,
    clipboard_registered: bool,
    dictation_registered: bool,
    suspended: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn get_shortcut_status(state: tauri::State<'_, Mutex<CurrentShortcuts>>) -> Result<ShortcutStatus, String> {
    let current = state.lock().map_err(|error| error.to_string())?;
    Ok(ShortcutStatus {
        select_registered: current.is_registered(ShortcutAction::Select, &current.select),
        clipboard_registered: current.is_registered(ShortcutAction::Clipboard, &current.clipboard),
        dictation_registered: current.is_registered(ShortcutAction::Dictation, &current.dictation),
        suspended: current.suspended, error: current.last_error.clone(),
    })
}

fn suspend_with(
    current: &mut CurrentShortcuts,
    register: &mut impl FnMut(&Binding) -> Result<(), String>,
    unregister: &mut impl FnMut(&Binding) -> Result<(), String>,
) -> Result<(), String> {
    if current.suspended { return Ok(()); }
    let previous = current.registered.clone();
    let mut errors = remove_registered_with(&mut current.registered, unregister);
    if !errors.is_empty() {
        errors.extend(register_missing_with(&mut current.registered, &previous, register));
        let message = errors.join("; ");
        current.last_error = Some(message.clone());
        return Err(message);
    }
    current.resume_bindings = previous;
    current.suspended = true;
    Ok(())
}

#[tauri::command]
pub fn suspend_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
) -> Result<(), String> {
    let mut current = state.lock().map_err(|error| error.to_string())?;
    let result = suspend_with(&mut current, &mut |binding| register_binding(&app, binding),
        &mut |binding| unregister_binding(&app, binding));
    refresh_dictation_tray(&app, &current);
    result
}

fn resume_suspended_with(
    current: &mut CurrentShortcuts,
    register: &mut impl FnMut(&Binding) -> Result<(), String>,
) -> Result<(), String> {
    if !current.suspended { return Ok(()); }
    let desired = current.resume_bindings.clone();
    let errors = register_missing_with(&mut current.registered, &desired, register);
    if !errors.is_empty() {
        let message = errors.join("; ");
        current.last_error = Some(message.clone());
        // Keep successful restorations and retry only the missing ones next time.
        return Err(message);
    }
    current.suspended = false;
    current.resume_bindings.clear();
    Ok(())
}

#[tauri::command]
pub fn resume_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
) -> Result<(), String> {
    let mut current = state.lock().map_err(|error| error.to_string())?;
    let result = resume_suspended_with(&mut current, &mut |binding| register_binding(&app, binding));
    refresh_dictation_tray(&app, &current);
    result
}

/// Normal close awaits resume in the frontend; this is the webview-destruction fallback.
pub fn restore_after_settings_destroyed(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Mutex<CurrentShortcuts>>();
    let mut current = state.lock().map_err(|error| error.to_string())?;
    let result = resume_suspended_with(&mut current, &mut |binding| register_binding(app, binding));
    refresh_dictation_tray(app, &current);
    result
}

#[tauri::command]
pub fn update_shortcuts(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<CurrentShortcuts>>,
    select_shortcut: String,
    clipboard_shortcut: String,
    dictation_shortcut: Option<String>,
) -> Result<(), String> {
    let new_select = parse_shortcut_str(&select_shortcut)?;
    let new_clipboard = parse_shortcut_str(&clipboard_shortcut)?;
    let mut current = state.lock().map_err(|error| error.to_string())?;
    let new_dictation = match dictation_shortcut {
        Some(value) => parse_shortcut_str(&value)?,
        None => current.dictation.clone(),
    };
    validate_shortcuts(&new_select, &new_clipboard, cfg!(target_os = "macos").then_some(&new_dictation))?;
    let replacement = CurrentShortcuts::new(new_select, new_clipboard, new_dictation);
    if let Err(error) = replace_bindings_with(&mut current.registered, &replacement.bindings(),
        &mut |binding| register_binding(&app, binding), &mut |binding| unregister_binding(&app, binding)) {
        current.last_error = Some(error.clone());
        refresh_dictation_tray(&app, &current);
        return Err(error);
    }
    current.select = replacement.select;
    current.clipboard = replacement.clipboard;
    current.dictation = replacement.dictation;
    current.suspended = false;
    current.resume_bindings.clear();
    current.last_error = None;
    refresh_dictation_tray(&app, &current);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> CurrentShortcuts {
        CurrentShortcuts::new(parse_shortcut_str("Super+Ctrl+KeyT").unwrap(),
            parse_shortcut_str("Super+Ctrl+Shift+KeyT").unwrap(),
            parse_shortcut_str("Super+Ctrl+KeyD").unwrap())
    }

    fn all_bindings(current: &CurrentShortcuts) -> Vec<Binding> {
        vec![Binding { shortcut: current.select.clone(), action: ShortcutAction::Select },
            Binding { shortcut: current.clipboard.clone(), action: ShortcutAction::Clipboard },
            Binding { shortcut: current.dictation.clone(), action: ShortcutAction::Dictation }]
    }

    #[test]
    fn tray_hint_uses_the_configured_key_and_registration_state() {
        let mut current = configured();
        current.dictation = parse_shortcut_str("Super+Alt+F7").unwrap();
        current.registered = all_bindings(&current);
        assert_eq!(dictation_tray_text(&current), "⌥⌘F7 · 어디서나 받아쓰기");
        current.suspended = true;
        assert_eq!(dictation_tray_text(&current), "⌥⌘F7 · 단축키 일시 중지");
        current.suspended = false;
        current.registered.clear();
        assert_eq!(dictation_tray_text(&current), "⌥⌘F7 · 받아쓰기 단축키 등록 확인 필요");
    }

    #[test]
    fn a_remaining_different_binding_never_marks_the_configured_key_ready() {
        let mut current = configured();
        current.registered = vec![Binding { action: ShortcutAction::Dictation,
            shortcut: parse_shortcut_str("Super+Alt+F7").unwrap() }];
        assert!(!current.is_registered(ShortcutAction::Dictation, &current.dictation));
        assert_eq!(dictation_tray_text(&current), "⌃⌘D · 받아쓰기 단축키 등록 확인 필요");
    }

    #[test]
    fn a_held_dictation_shortcut_cannot_repeat_into_a_new_recording() {
        let pressed = AtomicBool::new(false);
        assert!(accept_dictation_press(&pressed, ShortcutState::Pressed));
        for _ in 0..10 { assert!(!accept_dictation_press(&pressed, ShortcutState::Pressed)); }
        assert!(!accept_dictation_press(&pressed, ShortcutState::Released));
        assert!(accept_dictation_press(&pressed, ShortcutState::Pressed));
    }

    #[test]
    fn dictation_conflict_at_startup_preserves_both_translation_bindings() {
        let mut current = configured();
        let errors = register_missing_with(&mut current.registered, &all_bindings(&configured()), &mut |binding| {
            if binding.action == ShortcutAction::Dictation { Err("occupied".into()) } else { Ok(()) }
        });
        assert_eq!(errors.len(), 1);
        assert_eq!(current.registered.len(), 2);
        assert!(current.registered.iter().all(|binding| binding.action != ShortcutAction::Dictation));
    }

    #[test]
    fn failed_update_restores_only_the_previously_registered_set() {
        let mut current = configured();
        current.registered = all_bindings(&current)[..2].to_vec();
        let previous = current.registered.clone();
        let mut calls = Vec::new();
        let error = replace_bindings_with(&mut current.registered, &all_bindings(&configured()),
            &mut |binding| {
                calls.push(binding.action);
                if binding.action == ShortcutAction::Dictation { Err("occupied".into()) } else { Ok(()) }
            }, &mut |_| Ok(())).unwrap_err();
        assert!(error.contains("복원 완료"));
        assert_eq!(current.registered, previous);
        assert_eq!(calls.iter().filter(|&&action| action == ShortcutAction::Dictation).count(), 1);
    }

    #[test]
    fn destruction_restoration_is_idempotent_and_keeps_startup_omissions() {
        let mut current = configured();
        current.registered = all_bindings(&current)[..2].to_vec();
        let previous = current.registered.clone();
        suspend_with(&mut current, &mut |_| Ok(()), &mut |_| Ok(())).unwrap();
        suspend_with(&mut current, &mut |_| panic!("already suspended"), &mut |_| panic!("already suspended")).unwrap();
        assert!(current.suspended);
        assert!(current.registered.is_empty());
        assert_eq!(current.resume_bindings, previous);
        resume_suspended_with(&mut current, &mut |_| Ok(())).unwrap();
        assert!(!current.suspended);
        assert_eq!(current.registered, previous);
        resume_suspended_with(&mut current, &mut |_| panic!("normal close already restored")).unwrap();
    }

    #[test]
    fn partial_resume_retries_missing_bindings_without_registering_twice() {
        let mut current = configured();
        current.registered = all_bindings(&current);
        suspend_with(&mut current, &mut |_| Ok(()), &mut |_| Ok(())).unwrap();
        assert!(resume_suspended_with(&mut current, &mut |binding| {
            if binding.action == ShortcutAction::Clipboard { Err("occupied".into()) } else { Ok(()) }
        }).is_err());
        assert!(current.suspended);
        assert_eq!(current.registered.len(), 2);
        let mut retries = Vec::new();
        resume_suspended_with(&mut current, &mut |binding| { retries.push(binding.action); Ok(()) }).unwrap();
        assert_eq!(retries, vec![ShortcutAction::Clipboard]);
        assert!(!current.suspended);
        assert_eq!(current.registered.len(), 3);
    }

    #[test]
    fn failed_suspend_restores_working_bindings_and_does_not_claim_suspension() {
        let mut current = configured();
        current.registered = all_bindings(&current);
        let mut previous = current.registered.clone();
        assert!(suspend_with(&mut current, &mut |_| Ok(()), &mut |binding| {
            if binding.action == ShortcutAction::Clipboard { Err("cannot unregister".into()) } else { Ok(()) }
        }).is_err());
        assert!(!current.suspended);
        let ids = |bindings: &mut Vec<Binding>| { bindings.sort_by_key(|binding| binding.shortcut.id()); };
        ids(&mut current.registered);
        ids(&mut previous);
        assert_eq!(current.registered, previous);
    }

    #[test]
    fn equivalent_shortcuts_are_rejected_before_registration() {
        let select = parse_shortcut_str("Super+Ctrl+KeyT").unwrap();
        let equivalent = parse_shortcut_str("Control+Command+KeyT").unwrap();
        let dictation = parse_shortcut_str("Super+Ctrl+KeyD").unwrap();
        assert!(validate_shortcuts(&select, &equivalent, Some(&dictation)).is_err());
        assert!(validate_shortcuts(&dictation, &select, Some(&dictation)).is_err());
    }

    #[test]
    fn unsupported_dictation_does_not_reserve_an_existing_translation_shortcut() {
        let select = parse_shortcut_str(crate::dictation::DEFAULT_DICTATION_SHORTCUT).unwrap();
        let clipboard = parse_shortcut_str("Ctrl+Alt+Shift+KeyT").unwrap();
        // Windows/Linux only register translation bindings. A saved translation
        // shortcut must remain saveable even when it matches the new macOS default.
        assert!(validate_shortcuts(&select, &clipboard, None).is_ok());
        assert!(validate_shortcuts(&clipboard, &select, None).is_ok());
        assert!(validate_shortcuts(&select, &select, None).is_err());
        assert!(validate_shortcuts(&select, &clipboard, Some(&select)).is_err());
    }

    #[test]
    fn default_dictation_binding_does_not_conflict_with_translation() {
        assert!(validate_shortcuts(
            &parse_shortcut_str(DEFAULT_SELECT_SHORTCUT).unwrap(),
            &parse_shortcut_str(DEFAULT_CLIPBOARD_SHORTCUT).unwrap(),
            Some(&parse_shortcut_str(crate::dictation::DEFAULT_DICTATION_SHORTCUT).unwrap()),
        ).is_ok());
    }
}
