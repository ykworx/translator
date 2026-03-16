use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechStatus {
    transcript: String,
    is_running: bool,
    is_final: bool,
    error: Option<String>,
    authorized: Option<bool>,
    speech_authorized: Option<bool>,
    microphone_authorized: Option<bool>,
    permission_prompt_pending: Option<bool>,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    unsafe extern "C" {
        fn speech_request_permissions() -> *mut c_char;
        fn speech_start_recognition(locale_identifier: *const c_char) -> *mut c_char;
        fn speech_stop_recognition() -> *mut c_char;
        fn speech_get_state() -> *mut c_char;
        fn speech_free_string(pointer: *mut c_char);
    }

    fn decode_json(pointer: *mut c_char) -> Result<SpeechStatus, String> {
        if pointer.is_null() {
            return Err("Apple Speech bridge returned no data.".into());
        }

        let raw = unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Apple Speech bridge returned invalid UTF-8.".to_string());
        unsafe { speech_free_string(pointer) };

        let raw = raw?;
        serde_json::from_str::<SpeechStatus>(&raw)
            .map_err(|e| format!("Apple Speech bridge JSON parse error: {e}"))
    }

    pub fn request_permissions() -> Result<SpeechStatus, String> {
        decode_json(unsafe { speech_request_permissions() })
    }

    pub fn start_recognition(locale_identifier: Option<&str>) -> Result<SpeechStatus, String> {
        let locale = CString::new(locale_identifier.unwrap_or_default())
            .map_err(|_| "Locale identifier contains an unsupported null byte.".to_string())?;
        decode_json(unsafe { speech_start_recognition(locale.as_ptr()) })
    }

    pub fn stop_recognition() -> Result<SpeechStatus, String> {
        decode_json(unsafe { speech_stop_recognition() })
    }

    pub fn get_state() -> Result<SpeechStatus, String> {
        decode_json(unsafe { speech_get_state() })
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    fn unsupported() -> Result<SpeechStatus, String> {
        Err("Apple Speech 음성 입력은 macOS에서만 지원됩니다.".into())
    }

    pub fn request_permissions() -> Result<SpeechStatus, String> {
        unsupported()
    }

    pub fn start_recognition(_locale_identifier: Option<&str>) -> Result<SpeechStatus, String> {
        unsupported()
    }

    pub fn stop_recognition() -> Result<SpeechStatus, String> {
        unsupported()
    }

    pub fn get_state() -> Result<SpeechStatus, String> {
        unsupported()
    }
}

#[tauri::command]
pub fn request_speech_permissions() -> Result<SpeechStatus, String> {
    platform::request_permissions()
}

#[tauri::command]
pub fn start_speech_recognition(locale_identifier: Option<String>) -> Result<SpeechStatus, String> {
    platform::start_recognition(locale_identifier.as_deref())
}

#[tauri::command]
pub fn stop_speech_recognition() -> Result<SpeechStatus, String> {
    platform::stop_recognition()
}

#[tauri::command]
pub fn get_speech_recognition_state() -> Result<SpeechStatus, String> {
    platform::get_state()
}
