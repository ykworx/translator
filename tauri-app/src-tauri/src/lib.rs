mod clipboard;
mod tray;

use log::{error, warn};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_store::StoreExt;

/// Get current cursor position in logical coordinates (macOS points).
#[cfg(target_os = "macos")]
fn get_cursor_position() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let pos = event.location();
    Some((pos.x, pos.y))
}

/// Center and show window on the monitor where the cursor is.
fn show_window_centered(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Some((cx, cy)) = get_cursor_position() {
        if let Ok(monitors) = window.available_monitors() {
            for monitor in &monitors {
                let sf = monitor.scale_factor();
                let mp = monitor.position();
                let ms = monitor.size();
                // Convert monitor physical bounds to logical (points)
                let mx = mp.x as f64 / sf;
                let my = mp.y as f64 / sf;
                let mw = ms.width as f64 / sf;
                let mh = ms.height as f64 / sf;
                if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
                    // Center window on this monitor (in logical coordinates)
                    let win_w = 520.0;
                    let win_h = 520.0;
                    let x = mx + (mw - win_w) / 2.0;
                    let y = my + (mh - win_h) / 2.0;
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(x, y)) {
                        warn!("Failed to set window position: {e}");
                    }
                    break;
                }
            }
        }
    }
    // Move window to the active Space before showing
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindowCollectionBehavior;
        let ns_window = window.ns_window().expect("Failed to get NSWindow");
        let ns_window: objc2::rc::Retained<objc2_app_kit::NSWindow> =
            unsafe { objc2::rc::Retained::retain(ns_window as *mut objc2_app_kit::NSWindow).unwrap() };
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::MoveToActiveSpace
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
    }
    if let Err(e) = window.show() {
        warn!("Failed to show window: {e}");
    }
    if let Err(e) = window.set_focus() {
        warn!("Failed to focus window: {e}");
    }
}

// ─── Dynamic shortcut support ────────────────────────
#[cfg(target_os = "macos")]
const DEFAULT_SELECT_SHORTCUT: &str = "Super+Ctrl+KeyT";
#[cfg(target_os = "macos")]
const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Super+Ctrl+Shift+KeyT";
#[cfg(not(target_os = "macos"))]
const DEFAULT_SELECT_SHORTCUT: &str = "Ctrl+Alt+KeyT";
#[cfg(not(target_os = "macos"))]
const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+Shift+KeyT";

struct CurrentShortcuts {
    select: Shortcut,
    clipboard: Shortcut,
}

fn str_to_code(s: &str) -> Result<Code, String> {
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

fn parse_shortcut_str(s: &str) -> Result<Shortcut, String> {
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
                if !window.is_visible().unwrap_or(false) {
                    show_window_centered(&window);
                }
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
            if !window.is_visible().unwrap_or(false) {
                show_window_centered(&window);
            }
            if let Err(e) = window.emit("global-translate", ()) {
                error!("Failed to emit global-translate event: {e}");
            }
        }
    }) {
        error!("Failed to dispatch to main thread: {e}");
    }
}

/// Register both shortcut handlers.
fn register_shortcut_handlers(
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
fn suspend_shortcuts(
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
fn resume_shortcuts(
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
fn update_shortcuts(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(tray::TrayAnimState {
            animating: Arc::new(AtomicBool::new(false)),
        })
        .manage(Mutex::new(CurrentShortcuts {
            select: parse_shortcut_str(DEFAULT_SELECT_SHORTCUT).unwrap(),
            clipboard: parse_shortcut_str(DEFAULT_CLIPBOARD_SHORTCUT).unwrap(),
        }))
        .invoke_handler(tauri::generate_handler![
            clipboard::read_clipboard_image,
            clipboard::read_clipboard_html,
            tray::tray_anim_start,
            tray::tray_anim_stop,
            update_shortcuts,
            suspend_shortcuts,
            resume_shortcuts
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // Tray menu
            let about_item = MenuItem::with_id(app, "about", "Transrator에 관하여…", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let shortcut_hint =
                MenuItem::with_id(app, "shortcut-hint", "⌘+Ctrl+T: 선택 번역 | +Shift: 클립보드 번역", false, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "설정…", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&about_item, &sep1, &shortcut_hint, &settings_item, &sep2, &quit_item])?;

            // Get existing tray icon (created from tauri.conf.json)
            let tray = app.tray_by_id("main-tray").expect("tray not found");
            tray.set_menu(Some(menu))?;
            tray.set_show_menu_on_left_click(false)?;

            let app_handle = app.handle().clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click { button, button_state, .. } = event {
                    if button == tauri::tray::MouseButton::Left && button_state == tauri::tray::MouseButtonState::Up {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                if let Err(e) = window.hide() {
                                    warn!("Failed to hide window on tray click: {e}");
                                }
                            } else {
                                show_window_centered(&window);
                            }
                        }
                    }
                }
            });

            tray.on_menu_event(move |app, event| match event.id.as_ref() {
                "quit" => {
                    app.exit(0);
                }
                "settings" => {
                    // Reuse existing settings window if open
                    if let Some(win) = app.get_webview_window("settings") {
                        win.show().ok();
                        win.set_focus().ok();
                        return;
                    }
                    // Create a new settings window
                    match tauri::WebviewWindowBuilder::new(
                        app,
                        "settings",
                        tauri::WebviewUrl::App("settings.html".into()),
                    )
                    .title("설정")
                    .inner_size(480.0, 520.0)
                    .resizable(false)
                    .minimizable(false)
                    .maximizable(false)
                    .build()
                    {
                        Ok(win) => {
                            // Center on cursor's monitor
                            #[cfg(target_os = "macos")]
                            if let Some((cx, cy)) = get_cursor_position() {
                                if let Ok(monitors) = win.available_monitors() {
                                    for monitor in &monitors {
                                        let sf = monitor.scale_factor();
                                        let mp = monitor.position();
                                        let ms = monitor.size();
                                        let mx = mp.x as f64 / sf;
                                        let my = mp.y as f64 / sf;
                                        let mw = ms.width as f64 / sf;
                                        let mh = ms.height as f64 / sf;
                                        if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
                                            let x = mx + (mw - 480.0) / 2.0;
                                            let y = my + (mh - 520.0) / 2.0;
                                            win.set_position(tauri::LogicalPosition::new(x, y)).ok();
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => error!("Failed to create settings window: {e}"),
                    }
                }
                "about" => {
                    #[cfg(target_os = "macos")]
                    {
                        use objc2_app_kit::NSApplication;
                        use objc2_foundation::NSAttributedString;
                        use objc2::MainThreadMarker;
                        use objc2_foundation::{NSString, NSDictionary};
                        use objc2::runtime::AnyObject;
                        if let Some(mtm) = MainThreadMarker::new() {
                            let app_instance = NSApplication::sharedApplication(mtm);
                            let credits_str = NSString::from_str(
                                "AI 기반 팝업 번역기\nPowered by Google Gemini\n\n⌘+Ctrl+T: 선택 번역\n⌘+Ctrl+Shift+T: 클립보드 번역\n\n© 2026 ykworx"
                            );
                            let credits = NSAttributedString::from_nsstring(&credits_str);
                            let credits_obj: objc2::rc::Retained<AnyObject> = objc2::rc::Retained::into_super(objc2::rc::Retained::into_super(credits));
                            let key = NSString::from_str("Credits");
                            let options = NSDictionary::from_slices(&[&*key], &[&*credits_obj]);
                            unsafe { app_instance.orderFrontStandardAboutPanelWithOptions(&*options) };
                        }
                    }
                }
                _ => {}
            });

            // Read shortcut settings from store (or use defaults)
            let store = app.store("settings.json")?;
            let select_str = store.get("selectShortcut")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| DEFAULT_SELECT_SHORTCUT.to_string());
            let clipboard_str = store.get("clipboardShortcut")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| DEFAULT_CLIPBOARD_SHORTCUT.to_string());

            let select_shortcut = parse_shortcut_str(&select_str)
                .unwrap_or_else(|_| parse_shortcut_str(DEFAULT_SELECT_SHORTCUT).unwrap());
            let clipboard_shortcut = parse_shortcut_str(&clipboard_str)
                .unwrap_or_else(|_| parse_shortcut_str(DEFAULT_CLIPBOARD_SHORTCUT).unwrap());

            // Update managed state with actual shortcuts
            {
                let sc_state = app.state::<Mutex<CurrentShortcuts>>();
                let mut current = sc_state.lock().unwrap();
                current.select = select_shortcut.clone();
                current.clipboard = clipboard_shortcut.clone();
            }

            register_shortcut_handlers(app.handle(), select_shortcut, clipboard_shortcut)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Only hide-to-tray for the main window; let other windows close normally
                if window.label() == "main" {
                    if let Err(e) = window.hide() {
                        warn!("Failed to hide window on close: {e}");
                    }
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
