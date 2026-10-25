use serde_json::Value;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    unsafe extern "C" {
        fn whisper_engine_load_model(model_path: *const c_char) -> *mut c_char;
        fn whisper_engine_unload_model();
        fn whisper_engine_feed_wav(wav_path: *const c_char, language: *const c_char, dictation: bool) -> *mut c_char;
        fn perf_get_stats() -> *mut c_char;
        fn perf_reset_stats();
        fn perf_set_enabled(enabled: bool);
        fn speech_free_string(pointer: *mut c_char);
    }

    pub fn load_model(path: &str) {
        match CString::new(path) {
            Ok(c_path) => {
                let result = unsafe { whisper_engine_load_model(c_path.as_ptr()) };
                if !result.is_null() {
                    unsafe { speech_free_string(result) };
                }
            }
            Err(_) => {
                eprintln!("[benchmark] Invalid model path");
            }
        }
    }

    pub fn unload_model() {
        unsafe { whisper_engine_unload_model() };
    }

    fn decode_json_value(pointer: *mut c_char) -> Result<Value, String> {
        if pointer.is_null() {
            return Err("Bridge returned null".into());
        }
        let raw = unsafe { CStr::from_ptr(pointer) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "Invalid UTF-8".to_string());
        unsafe { speech_free_string(pointer) };
        let raw = raw?;
        serde_json::from_str(&raw).map_err(|e| format!("JSON parse error: {e}"))
    }

    pub fn feed_wav(path: &str, language: Option<&str>, dictation: bool) -> Result<Value, String> {
        let c_path = CString::new(path).map_err(|_| "Invalid path".to_string())?;
        let c_lang = match language {
            Some(language) => Some(CString::new(language).map_err(|_| "Invalid language".to_string())?),
            None => None,
        };
        let lang_ptr = c_lang.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
        decode_json_value(unsafe { whisper_engine_feed_wav(c_path.as_ptr(), lang_ptr, dictation) })
    }

    pub fn get_perf_stats() -> Result<Value, String> {
        decode_json_value(unsafe { perf_get_stats() })
    }

    pub fn reset_perf_stats() {
        unsafe { perf_reset_stats() }
    }

    pub fn set_perf_enabled(enabled: bool) {
        unsafe { perf_set_enabled(enabled) }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;

    pub fn load_model(_path: &str) {}
    pub fn unload_model() {}

    pub fn feed_wav(_path: &str, _language: Option<&str>, _dictation: bool) -> Result<Value, String> {
        Err("Benchmark is only supported on macOS".into())
    }

    pub fn get_perf_stats() -> Result<Value, String> {
        Err("Performance tracking is only supported on macOS".into())
    }

    pub fn reset_perf_stats() {}

    pub fn set_perf_enabled(_enabled: bool) {}
}

/// Load whisper model for CLI benchmark mode
pub fn load_model_for_benchmark(path: &str) {
    platform::set_perf_enabled(true);
    platform::load_model(path);
}

/// Unload whisper model after CLI benchmark
pub fn unload_model_for_benchmark() {
    platform::unload_model();
}

#[tauri::command]
pub fn run_wav_benchmark(wav_path: String, language: Option<String>, dictation: Option<bool>) -> Result<Value, String> {
    platform::feed_wav(&wav_path, language.as_deref(), dictation.unwrap_or(false))
}

#[tauri::command]
pub fn get_performance_stats() -> Result<Value, String> {
    platform::get_perf_stats()
}

#[tauri::command]
pub fn reset_performance_stats() -> Result<(), String> {
    platform::reset_perf_stats();
    Ok(())
}

#[tauri::command]
pub fn set_performance_tracking(enabled: bool) -> Result<(), String> {
    platform::set_perf_enabled(enabled);
    Ok(())
}
