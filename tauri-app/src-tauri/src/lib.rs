use log::{error, warn};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static RE_STYLE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+style="[^"]*""#).unwrap());
static RE_DATA: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+data-[a-z-]+="[^"]*""#).unwrap());
static RE_CLASS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+class="[^"]*""#).unwrap());

/// Read HTML from clipboard if it contains a table.
#[tauri::command]
fn read_clipboard_html() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // Read HTML from NSPasteboard via objc2 FFI (no swift process spawn)
        let html = {
            use objc2_app_kit::NSPasteboard;
            use objc2_foundation::NSString;
            let pasteboard = NSPasteboard::generalPasteboard();
            let html_type = NSString::from_str("public.html");
            pasteboard.stringForType(&html_type).map(|s| s.to_string())
        }?;
        if !html.is_empty() && html.to_lowercase().contains("<table") {
            // Strip style/data-*/class attributes to reduce tokens
            let cleaned = RE_STYLE.replace_all(&html, "");
            let cleaned = RE_DATA.replace_all(&cleaned, "");
            let cleaned = RE_CLASS.replace_all(&cleaned, "");
            // Extract just the <table>...</table>
            if let Some(start) = cleaned.to_lowercase().find("<table") {
                if let Some(end_pos) = cleaned.to_lowercase().find("</table>") {
                    let table = &cleaned[start..end_pos + 8];
                    return Some(table.to_string());
                }
            }
            return Some(cleaned.to_string());
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Decode a PNG byte slice into a Tauri Image (RGBA).
fn png_to_image(png_bytes: &[u8]) -> Option<Image<'static>> {
    let decoder = image::ImageReader::new(std::io::Cursor::new(png_bytes))
        .with_guessed_format()
        .map_err(|e| warn!("Failed to guess image format: {e}"))
        .ok()?;
    let dyn_img = decoder
        .decode()
        .map_err(|e| warn!("Failed to decode image: {e}"))
        .ok()?;
    let rgba = dyn_img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Some(Image::new_owned(rgba.into_raw(), w, h))
}

/// Start tray icon animation (loading dots)
#[tauri::command]
fn tray_anim_start(app: tauri::AppHandle, state: tauri::State<'_, TrayAnimState>) {
    if state.animating.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() {
        return;
    }
    let animating = state.animating.clone();
    std::thread::spawn(move || {
        let frames: Vec<&[u8]> = vec![
            include_bytes!("../icons/tray_0.png"),
            include_bytes!("../icons/tray_1.png"),
            include_bytes!("../icons/tray_2.png"),
            include_bytes!("../icons/tray_3.png"),
        ];
        let mut idx = 0usize;
        while animating.load(Ordering::Acquire) {
            if let Some(tray) = app.tray_by_id("main-tray") {
                if let Some(img) = png_to_image(frames[idx]) {
                    if let Err(e) = tray.set_icon(Some(img)) {
                        warn!("Failed to set tray animation icon: {e}");
                    }
                }
            }
            idx = (idx + 1) % frames.len();
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        // Restore static icon as template (for macOS menu bar auto-coloring)
        if let Some(tray) = app.tray_by_id("main-tray") {
            if let Some(img) = png_to_image(include_bytes!("../icons/tray.png")) {
                if let Err(e) = tray.set_icon(Some(img)) {
                    warn!("Failed to restore tray icon: {e}");
                }
            }
            #[cfg(target_os = "macos")]
            if let Err(e) = tray.set_icon_as_template(true) {
                warn!("Failed to set tray icon as template: {e}");
            }
        }
    });
}

/// Stop tray icon animation
#[tauri::command]
fn tray_anim_stop(state: tauri::State<'_, TrayAnimState>) {
    state.animating.store(false, Ordering::Release);
}

struct TrayAnimState {
    animating: Arc<AtomicBool>,
}

/// Read image from clipboard and return as base64-encoded PNG, or None if no image.
#[tauri::command]
fn read_clipboard_image() -> Option<String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| warn!("Failed to open clipboard: {e}"))
        .ok()?;
    let img = clipboard
        .get_image()
        .map_err(|e| warn!("Failed to get image from clipboard: {e}"))
        .ok()?;

    let buffer: image::RgbaImage = image::ImageBuffer::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;

    let mut png_data = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_data);
    buffer
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| error!("Failed to encode clipboard image as PNG: {e}"))
        .ok()?;

    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(&png_data))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(TrayAnimState {
            animating: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![read_clipboard_image, read_clipboard_html, tray_anim_start, tray_anim_stop])
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
                        // Left click -> toggle main window
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                if let Err(e) = window.hide() {
                                    warn!("Failed to hide window on tray click: {e}");
                                }
                            } else {
                                if let Err(e) = window.show() {
                                    warn!("Failed to show window on tray click: {e}");
                                }
                                if let Err(e) = window.set_focus() {
                                    warn!("Failed to focus window on tray click: {e}");
                                }
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
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(e) = window.emit("open-settings", ()) {
                            error!("Failed to emit open-settings event: {e}");
                        }
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

            // Global shortcut: Cmd+Ctrl+T (macOS) / Ctrl+Alt+T (Windows/Linux) — copy + translate
            #[cfg(target_os = "macos")]
            let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::CONTROL), Code::KeyT);
            #[cfg(not(target_os = "macos"))]
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyT);

            // Clipboard-only shortcut: Cmd+Ctrl+Shift+T (macOS) / Ctrl+Alt+Shift+T — translate clipboard as-is
            #[cfg(target_os = "macos")]
            let clipboard_shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyT);
            #[cfg(not(target_os = "macos"))]
            let clipboard_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SHIFT), Code::KeyT);

            app.global_shortcut().on_shortcut(clipboard_shortcut, {
                let app_handle = app.handle().clone();
                move |_app: &tauri::AppHandle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let app = app_handle.clone();
                        std::thread::spawn(move || {
                            if let Some(window) = app.get_webview_window("main") {
                                if !window.is_visible().unwrap_or(false) {
                                    if let Err(e) = window.show() {
                                        warn!("Failed to show window: {e}");
                                    }
                                    if let Err(e) = window.set_focus() {
                                        warn!("Failed to focus window: {e}");
                                    }
                                }
                                if let Err(e) = window.emit("global-translate", ()) {
                                    error!("Failed to emit global-translate event: {e}");
                                }
                            }
                        });
                    }
                }
            })?;

            app.global_shortcut().on_shortcut(shortcut, move |app: &tauri::AppHandle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        // Simulate Cmd+C to copy selected text to clipboard via CoreGraphics
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
                        // Wait for clipboard to update
                        std::thread::sleep(std::time::Duration::from_millis(150));

                        if let Some(window) = app.get_webview_window("main") {
                            if !window.is_visible().unwrap_or(false) {
                                if let Err(e) = window.show() {
                                    warn!("Failed to show window on global shortcut: {e}");
                                }
                                if let Err(e) = window.set_focus() {
                                    warn!("Failed to focus window on global shortcut: {e}");
                                }
                            }
                            if let Err(e) = window.emit("global-translate", ()) {
                                error!("Failed to emit global-translate event: {e}");
                            }
                        }
                    });
                }
            })?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide window instead of closing — app stays in tray
                if let Err(e) = window.hide() {
                    warn!("Failed to hide window on close: {e}");
                }
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
