mod clipboard;
mod shortcut;
mod tray;
mod window;

use log::{error, warn};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconEvent,
    Manager, WindowEvent,
};
use tauri_plugin_store::StoreExt;

use shortcut::{
    CurrentShortcuts, DEFAULT_CLIPBOARD_SHORTCUT, DEFAULT_SELECT_SHORTCUT,
    parse_shortcut_str, register_shortcut_handlers,
};
use window::{center_window_on_cursor, show_window_centered};

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
            shortcut::update_shortcuts,
            shortcut::suspend_shortcuts,
            shortcut::resume_shortcuts
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
                            center_window_on_cursor(&win, 480.0, 520.0);
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
            if window.label() != "main" { return; }
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if let Err(e) = window.hide() {
                        warn!("Failed to hide window on close: {e}");
                    }
                    api.prevent_close();
                }
                WindowEvent::Focused(false) => {
                    // Drop always-on-top when focus is lost
                    if let Err(e) = window.set_always_on_top(false) {
                        warn!("Failed to unset always on top: {e}");
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
