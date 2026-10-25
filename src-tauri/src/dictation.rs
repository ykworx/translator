//! Native orchestration: the hidden webview does not own recording sessions.
use crate::model_manager;
use tauri::AppHandle;
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use tauri_plugin_store::StoreExt;

pub const DEFAULT_DICTATION_SHORTCUT: &str = "Super+Ctrl+KeyD";
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: AppHandle) { let _ = APP_HANDLE.set(app); }

#[unsafe(no_mangle)]
pub extern "C" fn dictation_stopped() {
    #[cfg(target_os = "macos")]
    {
        let seconds = APP_HANDLE.get().and_then(|app| app.store("settings.json").ok())
            .and_then(|store| store.get("dictationIdleSeconds"))
            .and_then(|value| value.as_u64()).unwrap_or(300);
        model_manager::cancel_unload();
        if seconds != 0 {
            model_manager::schedule_unload_after(std::time::Duration::from_secs(seconds.min(900)));
        }
    }
    #[cfg(not(target_os = "macos"))]
    model_manager::schedule_unload();
}

pub fn shutdown() {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn dictation_shutdown(); }
        unsafe { dictation_shutdown() };
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use serde::Deserialize;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;

    unsafe extern "C" {
        fn dictation_prepare() -> *mut c_char;
        fn dictation_start_prepared(id: u64, locale: *const c_char, hint: *const c_char, microphone: *const c_char) -> bool;
        fn dictation_list_microphones() -> *mut c_char;
        fn dictation_permissions(request: bool) -> *mut c_char;
        fn dictation_preview() -> bool;
        fn dictation_fail(id: u64, message: *const c_char);
        fn speech_free_string(pointer: *mut c_char);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Preparation {
        pub needs_model: bool,
        pub session_id: Option<u64>,
    }

    pub fn prepare() -> Result<Preparation, String> {
        let pointer = unsafe { dictation_prepare() };
        if pointer.is_null() { return Err("받아쓰기 상태를 가져올 수 없습니다.".into()); }
        let raw = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
        unsafe { speech_free_string(pointer) };
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    pub fn start(id: u64, locale: &str, hint: &str, microphone: &str) -> Result<bool, String> {
        let locale = CString::new(locale).map_err(|e| e.to_string())?;
        let hint = CString::new(hint).map_err(|e| e.to_string())?;
        let microphone = CString::new(microphone).map_err(|e| e.to_string())?;
        Ok(unsafe { dictation_start_prepared(id, locale.as_ptr(), hint.as_ptr(), microphone.as_ptr()) })
    }

    pub fn microphones() -> Result<Vec<super::MicrophoneDevice>, String> {
        let pointer = unsafe { dictation_list_microphones() };
        if pointer.is_null() { return Err("마이크 목록을 가져올 수 없습니다.".into()); }
        let raw = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
        unsafe { speech_free_string(pointer) };
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    pub fn permissions(request: bool) -> Result<super::DictationPermissions, String> {
        let pointer = unsafe { dictation_permissions(request) };
        if pointer.is_null() { return Err("받아쓰기 권한을 확인할 수 없습니다.".into()); }
        let raw = unsafe { CStr::from_ptr(pointer) }.to_string_lossy().into_owned();
        unsafe { speech_free_string(pointer) };
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    pub fn preview() -> bool { unsafe { dictation_preview() } }

    pub fn fail(id: u64, message: &str) {
        let message = CString::new(message.replace('\0', "")).unwrap();
        unsafe { dictation_fail(id, message.as_ptr()) };
    }
}

#[tauri::command]
pub async fn toggle_global_dictation(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let preparation = platform::prepare()?;
        if !preparation.needs_model { return Ok(()); }
        let id = preparation.session_id.ok_or("받아쓰기 세션 ID가 없습니다.")?;
        let result = async {
            let store = app.store("settings.json").map_err(|e| e.to_string())?;
            let locale = store.get("dictationLocale").and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "ko-KR".into());
            let hint = store.get("dictationHint").and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let microphone = store.get("dictationMicrophone").and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            model_manager::ensure_whisper_loaded(app.clone()).await?;
            platform::start(id, &locale, &hint, &microphone)
        }.await;
        match result {
            Ok(true) => Ok(()),
            Ok(false) => { model_manager::schedule_unload(); Ok(()) }
            Err(error) => {
                platform::fail(id, &error);
                model_manager::schedule_unload();
                Err(error)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("전역 받아쓰기는 macOS에서만 지원됩니다.".into())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDevice {
    id: String,
    name: String,
    is_default: bool,
}

#[tauri::command]
pub fn list_dictation_microphones() -> Result<Vec<MicrophoneDevice>, String> {
    #[cfg(target_os = "macos")]
    { platform::microphones() }
    #[cfg(not(target_os = "macos"))]
    { Ok(Vec::new()) }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationPermissions {
    microphone: bool,
    microphone_status: String,
    accessibility: bool,
    model_loaded: bool,
}

#[tauri::command]
pub fn get_dictation_permissions() -> Result<DictationPermissions, String> {
    permissions(false)
}

#[tauri::command]
pub fn request_dictation_permissions() -> Result<DictationPermissions, String> {
    permissions(true)
}

fn permissions(request: bool) -> Result<DictationPermissions, String> {
    #[cfg(target_os = "macos")]
    { platform::permissions(request) }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
        Err("전역 받아쓰기는 macOS에서만 지원됩니다.".into())
    }
}

#[tauri::command]
pub fn preview_dictation_panel() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    { Ok(platform::preview()) }
    #[cfg(not(target_os = "macos"))]
    { Err("전역 받아쓰기는 macOS에서만 지원됩니다.".into()) }
}
