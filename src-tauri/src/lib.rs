pub mod benchmark;
mod clipboard;
mod caption_capture;
mod model_manager;
mod shortcut;
mod speech;
mod window;

use log::{error, warn};
use std::sync::Mutex;
use std::thread::JoinHandle;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::Shortcut;
use tauri_plugin_store::StoreExt;

#[tauri::command]
fn open_handwriting_overlay(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("handwriting-overlay") {
        win.show().map_err(|e| format!("Failed to show overlay: {e}"))?;
        win.set_focus().map_err(|e| format!("Failed to focus overlay: {e}"))?;
        return Ok(());
    }

    let monitors: Vec<tauri::window::Monitor> = app
        .get_webview_window("main")
        .and_then(|w| w.available_monitors().ok())
        .unwrap_or_default();

    // Use primary monitor dimensions; fall back to a large fixed size
    let (ow, oh, ox, oy) = monitors
        .iter()
        .find(|m: &&tauri::window::Monitor| {
            // Prefer the monitor containing the cursor
            #[cfg(target_os = "macos")]
            {
                if let Some((cx, cy)) = window::get_cursor_position() {
                    let sf = m.scale_factor();
                    let mp = m.position();
                    let ms = m.size();
                    let mx = mp.x as f64 / sf;
                    let my = mp.y as f64 / sf;
                    let mw = ms.width as f64 / sf;
                    let mh = ms.height as f64 / sf;
                    return cx >= mx && cx < mx + mw && cy >= my && cy < my + mh;
                }
            }
            let _ = m;
            false
        })
        .or_else(|| monitors.first())
        .map(|m: &tauri::window::Monitor| {
            let sf = m.scale_factor();
            let mp = m.position();
            let ms = m.size();
            (
                ms.width as f64 / sf,
                ms.height as f64 / sf,
                mp.x as f64 / sf,
                mp.y as f64 / sf,
            )
        })
        .unwrap_or((1440.0, 900.0, 0.0, 0.0));

    let win = tauri::WebviewWindowBuilder::new(
        &app,
        "handwriting-overlay",
        tauri::WebviewUrl::App("handwriting-overlay.html".into()),
    )
    .title("필기 인식")
    .inner_size(ow, oh)
    .position(ox, oy)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .closable(true)
    .build()
    .map_err(|e| {
        error!("Failed to create handwriting overlay window: {e}");
        format!("Failed to create handwriting overlay window: {e}")
    })?;

    win.set_focus()
        .map_err(|e| format!("Failed to focus overlay: {e}"))?;
    Ok(())
}

use shortcut::{
    CurrentShortcuts, DEFAULT_CLIPBOARD_SHORTCUT, DEFAULT_SELECT_SHORTCUT,
    parse_shortcut_str, register_shortcut_handlers,
};
use window::{center_window_on_cursor, show_window_centered};

fn parse_default_shortcut(shortcut_str: &str, shortcut_name: &str) -> Shortcut {
    parse_shortcut_str(shortcut_str).expect(&format!(
        "Built-in default {shortcut_name} shortcut `{shortcut_str}` should always parse"
    ))
}

fn parse_configured_shortcut(configured: &str, default: &str, shortcut_name: &str) -> Shortcut {
    match parse_shortcut_str(configured) {
        Ok(shortcut) => shortcut,
        Err(e) => {
            warn!(
                "Invalid configured {shortcut_name} shortcut `{configured}`; falling back to `{default}`: {e}"
            );
            parse_default_shortcut(default, shortcut_name)
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(CurrentShortcuts {
            select: parse_default_shortcut(DEFAULT_SELECT_SHORTCUT, "select"),
            clipboard: parse_default_shortcut(DEFAULT_CLIPBOARD_SHORTCUT, "clipboard"),
        }))
        .manage(Mutex::new(None::<JoinHandle<()>>))
        .invoke_handler(tauri::generate_handler![
            open_handwriting_overlay,
            clipboard::read_clipboard_image,
            clipboard::read_clipboard_html,
            clipboard::write_clipboard_html,
            speech::request_speech_permissions,
            speech::start_speech_recognition,
            speech::stop_speech_recognition,
            speech::get_speech_recognition_state,
            caption_capture::list_caption_capture_windows,
            caption_capture::request_caption_capture_permissions,
            caption_capture::start_app_captions,
            caption_capture::stop_app_captions,
            caption_capture::get_app_caption_state,
            caption_capture::pick_window_under_cursor,
            shortcut::update_shortcuts,
            shortcut::suspend_shortcuts,
            shortcut::resume_shortcuts,
            model_manager::check_whisper_model,
            model_manager::download_whisper_model,
            model_manager::delete_whisper_model,
            model_manager::load_whisper_model,
            model_manager::set_whisper_domain_hint,
            benchmark::run_wav_benchmark,
            benchmark::get_performance_stats,
            benchmark::reset_performance_stats,
            benchmark::set_performance_tracking
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // Tray menu
            let about_item = MenuItem::with_id(app, "about", "Transrator에 관하여…", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            #[cfg(target_os = "macos")]
            let shortcut_hint =
                MenuItem::with_id(app, "shortcut-hint", "⌘+Ctrl+T: 선택 번역 | +Shift: 영역 캡처 번역", false, None::<&str>)?;
            #[cfg(not(target_os = "macos"))]
            let shortcut_hint =
                MenuItem::with_id(app, "shortcut-hint", "⌘+Ctrl+T: 선택 번역 | +Shift: 클립보드 번역", false, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "설정…", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&about_item, &sep1, &shortcut_hint, &settings_item, &sep2, &quit_item])?;

            // Get existing tray icon (created from tauri.conf.json)
            let tray = app
                .tray_by_id("main-tray")
                .expect("Tray icon `main-tray` declared in tauri.conf.json was not found during app setup");
            tray.set_menu(Some(menu))?;
            tray.set_show_menu_on_left_click(false)?;

            let app_handle = app.handle().clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click { button, button_state, .. } = event {
                    if button == tauri::tray::MouseButton::Left && button_state == tauri::tray::MouseButtonState::Up {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            match window.is_visible() {
                                Ok(true) => {
                                    if let Err(e) = window.hide() {
                                        warn!("Failed to hide window on tray click: {e}");
                                    }
                                }
                                Ok(false) => show_window_centered(&window),
                                Err(e) => {
                                    warn!("Failed to determine main window visibility on tray click: {e}");
                                    show_window_centered(&window);
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
                            center_window_on_cursor(&win, 480.0, 520.0);
                            win.set_focus().ok();
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
                                "AI 기반 팝업 번역기\nPowered by Google Gemini\n\n⌘+Ctrl+T: 선택 번역\n⌘+Ctrl+Shift+T: 영역 캡처 번역\n\n© 2026 ykworx"
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

            let select_shortcut =
                parse_configured_shortcut(&select_str, DEFAULT_SELECT_SHORTCUT, "select");
            let clipboard_shortcut = parse_configured_shortcut(
                &clipboard_str,
                DEFAULT_CLIPBOARD_SHORTCUT,
                "clipboard",
            );

            // Update managed state with actual shortcuts
            {
                let sc_state = app.state::<Mutex<CurrentShortcuts>>();
                let mut current = sc_state.lock().map_err(|e| {
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("Failed to lock current shortcuts state during setup: {e}"),
                    )
                })?;
                current.select = select_shortcut.clone();
                current.clipboard = clipboard_shortcut.clone();
            }

            register_shortcut_handlers(app.handle(), select_shortcut, clipboard_shortcut)?;

            caption_capture::init_app_handle(app.handle().clone());

            // Auto-load Whisper model if previously downloaded (background thread to avoid blocking startup)
            {
                let handle = app.handle().clone();
                let join = std::thread::spawn(move || {
                    model_manager::auto_load_model(&handle);
                });
                let state = app.state::<Mutex<Option<JoinHandle<()>>>>();
                *state.lock().unwrap() = Some(join);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" { return; }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if let Err(e) = window.hide() {
                        warn!("Failed to hide window on close: {e}");
                    }
                    api.prevent_close();
                }
                WindowEvent::Focused(false) => {
                    window.set_always_on_top(false).ok();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("Failed to build Tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                log::info!("Tauri exit — shutting down whisper");
                if let Some(state) = app_handle.try_state::<Mutex<Option<JoinHandle<()>>>>() {
                    if let Some(join) = state.lock().unwrap().take() {
                        let _ = join.join();
                    }
                }
                model_manager::shutdown_whisper();
            }
        });
}
