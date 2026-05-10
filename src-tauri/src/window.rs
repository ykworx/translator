use log::warn;

/// Get current cursor position in logical coordinates (macOS points).
#[cfg(target_os = "macos")]
pub fn get_cursor_position() -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState).ok()?;
    let event = CGEvent::new(source).ok()?;
    let pos = event.location();
    Some((pos.x, pos.y))
}

/// Center a window on the monitor where the cursor is, using the given logical size.
#[cfg(target_os = "macos")]
pub fn center_window_on_cursor(window: &tauri::WebviewWindow, win_w: f64, win_h: f64) {
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
}

#[cfg(not(target_os = "macos"))]
pub fn center_window_on_cursor(_window: &tauri::WebviewWindow, _win_w: f64, _win_h: f64) {
    // No-op on non-macOS platforms
}

/// Center and show window on the monitor where the cursor is.
pub fn show_window_centered(window: &tauri::WebviewWindow) {
    center_window_on_cursor(window, 620.0, 520.0);
    // Move window to the active Space before showing
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindowCollectionBehavior;
        match window.ns_window() {
            Ok(ns_window) => {
                let ns_window = unsafe {
                    objc2::rc::Retained::<objc2_app_kit::NSWindow>::retain(
                        ns_window as *mut objc2_app_kit::NSWindow,
                    )
                };
                if let Some(ns_window) = ns_window {
                    ns_window.setCollectionBehavior(
                        NSWindowCollectionBehavior::MoveToActiveSpace
                            | NSWindowCollectionBehavior::FullScreenAuxiliary,
                    );
                } else {
                    warn!("Failed to retain NSWindow handle");
                }
            }
            Err(e) => warn!("Failed to get NSWindow handle: {e}"),
        }
    }
    if let Err(e) = window.set_always_on_top(true) {
        warn!("Failed to set always on top: {e}");
    }
    if let Err(e) = window.show() {
        warn!("Failed to show window: {e}");
    }
    if let Err(e) = window.set_focus() {
        warn!("Failed to focus window: {e}");
    }
}
