pub mod benchmark;
pub mod build_info;
mod clipboard;
mod caption_capture;
mod model_manager;
mod speech_model;
mod openai;
mod gemini;
mod cloud_http;
mod connections;
mod settings_store;
mod settings_navigation;
mod shortcut;
mod speech;
mod dictation;
mod screen_pen;
pub use dictation::list_dictation_microphones as list_microphones_for_diagnostics;
mod window;

use log::{error, warn};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_global_shortcut::Shortcut;

static SETTINGS_WINDOW_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
pub(crate) struct DictationTrayHint(pub tauri::menu::MenuItem<tauri::Wry>);

fn show_settings_window(app: &tauri::AppHandle, tab: Option<settings_navigation::SettingsTab>) -> Result<(), String> {
    // Menu, tray and webview requests can arrive on different async workers.
    let _creation = SETTINGS_WINDOW_LOCK.lock().map_err(|_| "설정 창 상태를 확인하지 못했습니다.")?;
    if let Some(tab) = tab { app.state::<settings_navigation::SettingsNavigation>().request(tab)?; }
    if let Some(win) = app.get_webview_window("settings") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        if let Some(tab) = tab {
            // The frontend listens before consuming the queued request, so
            // navigation works even while a new settings webview is loading.
            if let Err(e) = win.emit("settings-navigation", tab) { warn!("Failed to notify settings navigation: {e}"); }
        }
        return Ok(());
    }
    let win = tauri::WebviewWindowBuilder::new(app, "settings", tauri::WebviewUrl::App("settings.html".into()))
        .title("설정").inner_size(480.0, 520.0)
        .resizable(false).minimizable(false).maximizable(false)
        .build().map_err(|e| e.to_string())?;
    center_window_on_cursor(&win, 480.0, 520.0);
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    show_settings_window(&app, None)
}

#[tauri::command]
async fn open_dictation_settings(app: tauri::AppHandle) -> Result<(), String> {
    show_settings_window(&app, Some(settings_navigation::SettingsTab::Dictation))
}

fn request_settings_window(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = open_settings(app).await { error!("Failed to open settings: {e}"); }
    });
}

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
    parse_shortcut_str, register_startup_shortcuts,
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
        .manage(settings_navigation::SettingsNavigation::default())
        .manage(connections::ConnectionManager::default())
        .manage(Mutex::new(CurrentShortcuts::new(
            parse_default_shortcut(DEFAULT_SELECT_SHORTCUT, "select"),
            parse_default_shortcut(DEFAULT_CLIPBOARD_SHORTCUT, "clipboard"),
            parse_default_shortcut(dictation::DEFAULT_DICTATION_SHORTCUT, "dictation"),
        )))
        .invoke_handler(tauri::generate_handler![
            open_settings,
            open_dictation_settings,
            settings_navigation::consume_settings_navigation,
            build_info::get_build_info,
            open_handwriting_overlay,
            screen_pen::open_screen_pen,
            dictation::toggle_global_dictation,
            dictation::supports_global_dictation,
            dictation::list_dictation_microphones,
            dictation::get_dictation_permissions,
            dictation::request_dictation_permissions,
            dictation::preview_dictation_panel,
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
            shortcut::get_shortcut_status,
            model_manager::check_whisper_model,
            model_manager::download_whisper_model,
            model_manager::delete_whisper_model,
            model_manager::load_whisper_model,
            model_manager::ensure_whisper_loaded,
            model_manager::set_whisper_domain_hint,
            openai::openai_generate_text,
            openai::openai_generate_image,
            openai::openai_generate_text_stream,
            gemini::gemini_generate_text,
            gemini::gemini_generate_image,
            gemini::gemini_generate_text_stream,
            connections::capture_connection,
            connections::get_credential_status,
            connections::save_provider_credential,
            connections::delete_provider_credential,
            settings_store::settings_load,
            settings_store::settings_get,
            settings_store::settings_set,
            settings_store::settings_delete,
            settings_store::settings_save,
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
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                if let Some(app_menu) = menu.items()?.first().and_then(|item| item.as_submenu()) {
                    app_menu.insert(&MenuItem::with_id(app, "app-settings", "설정…", true, Some("CmdOrCtrl+,"))?, 2)?;
                    app_menu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
                }
                app.set_menu(menu)?;
            }
            // Native-only Store: block plaintext credential IPC and auto-save.
            settings_store::store(app.handle()).map_err(std::io::Error::other)?;
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
            #[cfg(target_os = "macos")]
            let dictation_hint = MenuItem::with_id(app, "dictation-hint", "⌘+Ctrl+D: 어디서나 받아쓰기", false, None::<&str>)?;
            #[cfg(target_os = "macos")]
            let dictation_settings = MenuItem::with_id(app, "dictation-settings", "받아쓰기 준비…", true, None::<&str>)?;
            let screen_pen_item = MenuItem::with_id(app, "screen-pen", "화면 펜 켜기", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&about_item, &sep1, &shortcut_hint, &settings_item, &screen_pen_item, &sep2, &quit_item])?;
            #[cfg(target_os = "macos")]
            {
                menu.insert(&dictation_hint, 3)?;
                menu.insert(&dictation_settings, 4)?;
                app.manage(DictationTrayHint(dictation_hint));
            }

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
                "screen-pen" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = screen_pen::open_screen_pen(app).await { error!("Failed to open screen pen: {e}"); }
                    });
                }
                "settings" => {
                    request_settings_window(app);
                }
                "dictation-settings" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = open_dictation_settings(app).await { error!("Failed to open dictation setup: {e}"); }
                    });
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
            let store = settings_store::store(app.handle()).map_err(std::io::Error::other)?;
            let select_str = store.get("selectShortcut")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| DEFAULT_SELECT_SHORTCUT.to_string());
            let clipboard_str = store.get("clipboardShortcut")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| DEFAULT_CLIPBOARD_SHORTCUT.to_string());

            let dictation_str = store.get("dictationShortcut")
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| dictation::DEFAULT_DICTATION_SHORTCUT.to_string());
            let dictation_shortcut = parse_configured_shortcut(
                &dictation_str, dictation::DEFAULT_DICTATION_SHORTCUT, "dictation",
            );
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
                current.dictation = dictation_shortcut.clone();
                register_startup_shortcuts(app.handle(), &mut current);
            }

            caption_capture::init_app_handle(app.handle().clone());
            dictation::init(app.handle().clone());

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "app-settings" { request_settings_window(app); }
        })
        .on_window_event(|window, event| {
            if window.label() == "settings" && matches!(event, WindowEvent::Destroyed) {
                if let Err(error) = shortcut::restore_after_settings_destroyed(window.app_handle()) {
                    error!("Failed to restore shortcuts after settings destruction: {error}");
                }
                return;
            }
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
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(settings) = app_handle.get_webview_window("settings").filter(|win| win.is_visible().unwrap_or(false)) {
                    settings.set_focus().ok();
                } else if let Some(main) = app_handle.get_webview_window("main") {
                    show_window_centered(&main);
                }
            }
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                settings_store::prepare_exit(app_handle);
            }
            if let tauri::RunEvent::Exit = event {
                log::info!("Tauri exit — shutting down whisper");
                dictation::shutdown();
                model_manager::shutdown_whisper();
            }
        });
}
