use crate::model_manager;
use log::warn;
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::OnceLock;
use tauri::{Emitter, Manager};

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn init_app_handle(handle: tauri::AppHandle) {
    if APP_HANDLE.set(handle).is_err() {
        warn!("caption_capture app handle was already initialized");
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn caption_state_changed(json_ptr: *const c_char) {
    let Some(handle) = APP_HANDLE.get() else { return };
    let Some(window) = handle.get_webview_window("main") else { return };

    if json_ptr.is_null() { return; }
    let json_str = match unsafe { CStr::from_ptr(json_ptr) }.to_str() {
        Ok(json_str) => json_str,
        Err(e) => {
            warn!("Caption state callback returned invalid UTF-8: {e}");
            return;
        }
    };

    match serde_json::from_str::<AppCaptionStatus>(json_str) {
        Ok(state) => {
            if let Err(e) = window.emit("app-caption-update", state) {
                warn!("Failed to emit app-caption-update event: {e}");
            }
        }
        Err(e) => warn!("Caption state callback returned invalid JSON: {e}"),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindow {
    id: String,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppCaptionStatus {
    transcript: String,
    last_final_transcript: String,
    last_final_segment_id: Option<String>,
    is_running: bool,
    audio_sample_count: Option<u64>,
    last_audio_at_ms: Option<u64>,
    audio_level: Option<f32>,
    error: Option<String>,
    authorized: Option<bool>,
    model_loaded: Option<bool>,
    screen_authorized: Option<bool>,
    permission_prompt_pending: Option<bool>,
    source_app: Option<String>,
    capture_mode: Option<String>,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    unsafe extern "C" {
        fn caption_capture_list_windows() -> *mut c_char;
        fn caption_capture_pick_window_interactive() -> *mut c_char;
        fn app_caption_request_permissions() -> *mut c_char;
        fn app_caption_start(
            locale_identifier: *const c_char,
            capture_mode: *const c_char,
            window_identifier: *const c_char,
        ) -> *mut c_char;
        fn app_caption_stop() -> *mut c_char;
        fn app_caption_get_state() -> *mut c_char;
        fn speech_free_string(pointer: *mut c_char);
    }

    fn decode_json(pointer: *mut c_char) -> Result<AppCaptionStatus, String> {
        if pointer.is_null() {
            return Err("Zoom caption bridge returned no data.".into());
        }

        let raw = unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Zoom caption bridge returned invalid UTF-8.".to_string());
        unsafe { speech_free_string(pointer) };

        let raw = raw?;
        serde_json::from_str::<AppCaptionStatus>(&raw)
            .map_err(|e| format!("App caption bridge JSON parse error: {e}"))
    }

    fn decode_window_list(pointer: *mut c_char) -> Result<Vec<CaptureWindow>, String> {
        if pointer.is_null() {
            return Err("Caption capture bridge returned no window data.".into());
        }

        let raw = unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Caption capture bridge returned invalid UTF-8.".to_string());
        unsafe { speech_free_string(pointer) };

        let raw = raw?;
        serde_json::from_str::<Vec<CaptureWindow>>(&raw)
            .map_err(|e| format!("Caption capture window list parse error: {e}"))
    }

    fn decode_capture_window(pointer: *mut c_char) -> Result<CaptureWindow, String> {
        if pointer.is_null() {
            return Err("Caption capture bridge returned no data.".into());
        }

        let raw = unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Caption capture bridge returned invalid UTF-8.".to_string());
        unsafe { speech_free_string(pointer) };

        let raw = raw?;

        // Check for error response
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(err) = obj.get("error").and_then(|v| v.as_str()) {
                return Err(err.to_string());
            }
        }

        serde_json::from_str::<CaptureWindow>(&raw)
            .map_err(|e| format!("Caption capture pick window parse error: {e}"))
    }

    pub fn list_windows() -> Result<Vec<CaptureWindow>, String> {
        decode_window_list(unsafe { caption_capture_list_windows() })
    }

    pub fn pick_window_interactive() -> Result<CaptureWindow, String> {
        decode_capture_window(unsafe { caption_capture_pick_window_interactive() })
    }

    pub fn request_permissions() -> Result<AppCaptionStatus, String> {
        decode_json(unsafe { app_caption_request_permissions() })
    }

    pub fn start(
        locale_identifier: Option<&str>,
        capture_mode: Option<&str>,
        window_identifier: Option<&str>,
    ) -> Result<AppCaptionStatus, String> {
        let locale = CString::new(locale_identifier.unwrap_or_default())
            .map_err(|_| "Locale identifier contains an unsupported null byte.".to_string())?;
        let capture_mode = CString::new(capture_mode.unwrap_or("window"))
            .map_err(|_| "Capture mode contains an unsupported null byte.".to_string())?;
        let window_identifier = CString::new(window_identifier.unwrap_or_default())
            .map_err(|_| "Window identifier contains an unsupported null byte.".to_string())?;
        decode_json(unsafe {
            app_caption_start(
                locale.as_ptr(),
                capture_mode.as_ptr(),
                window_identifier.as_ptr(),
            )
        })
    }

    pub fn stop() -> Result<AppCaptionStatus, String> {
        decode_json(unsafe { app_caption_stop() })
    }

    pub fn get_state() -> Result<AppCaptionStatus, String> {
        decode_json(unsafe { app_caption_get_state() })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    fn unsupported() -> Result<AppCaptionStatus, String> {
        Err("앱 실시간 자막은 macOS에서만 지원됩니다.".into())
    }

    pub fn list_windows() -> Result<Vec<CaptureWindow>, String> {
        Err("창 오디오 캡처는 macOS에서만 지원됩니다.".into())
    }

    pub fn pick_window_interactive() -> Result<CaptureWindow, String> {
        Err("이 기능은 macOS에서만 지원됩니다.".into())
    }

    pub fn request_permissions() -> Result<AppCaptionStatus, String> {
        unsupported()
    }

    pub fn start(
        _locale_identifier: Option<&str>,
        _capture_mode: Option<&str>,
        _window_identifier: Option<&str>,
    ) -> Result<AppCaptionStatus, String> {
        unsupported()
    }

    pub fn stop() -> Result<AppCaptionStatus, String> {
        unsupported()
    }

    pub fn get_state() -> Result<AppCaptionStatus, String> {
        unsupported()
    }
}

#[tauri::command]
pub fn list_caption_capture_windows() -> Result<Vec<CaptureWindow>, String> {
    platform::list_windows()
}

#[tauri::command]
pub fn request_caption_capture_permissions() -> Result<AppCaptionStatus, String> {
    platform::request_permissions()
}

#[tauri::command]
pub fn start_app_captions(
    locale_identifier: Option<String>,
    capture_mode: Option<String>,
    window_identifier: Option<String>,
) -> Result<AppCaptionStatus, String> {
    platform::start(
        locale_identifier.as_deref(),
        capture_mode.as_deref(),
        window_identifier.as_deref(),
    )
}

#[tauri::command]
pub fn stop_app_captions() -> Result<AppCaptionStatus, String> {
    let result = platform::stop();
    model_manager::schedule_unload();
    result
}

#[tauri::command]
pub fn get_app_caption_state() -> Result<AppCaptionStatus, String> {
    platform::get_state()
}

#[tauri::command]
pub fn pick_window_under_cursor() -> Result<CaptureWindow, String> {
    platform::pick_window_interactive()
}
