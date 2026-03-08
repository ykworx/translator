use log::warn;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::image::Image;

pub struct TrayAnimState {
    pub animating: Arc<AtomicBool>,
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
pub fn tray_anim_start(app: tauri::AppHandle, state: tauri::State<'_, TrayAnimState>) {
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
pub fn tray_anim_stop(state: tauri::State<'_, TrayAnimState>) {
    state.animating.store(false, Ordering::Release);
}
