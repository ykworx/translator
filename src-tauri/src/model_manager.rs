use log::warn;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

const MODEL_DIR_NAME: &str = "models";
const GGML_MODEL_FILENAME: &str = "ggml-large-v3-turbo.bin";
const GGML_MODEL_FILENAME_LEGACY: &str = "ggml-medium.bin"; // 이전 버전 호환
const COREML_MODEL_FILENAME: &str = "ggml-large-v3-turbo-encoder.mlmodelc.zip";
const COREML_MODEL_DIR: &str = "ggml-large-v3-turbo-encoder.mlmodelc";

/// Called at app startup – loads the Whisper model if it was previously downloaded.
pub fn auto_load_model(handle: &AppHandle) {
    let dir = match handle.path().app_data_dir() {
        Ok(d) => d.join(MODEL_DIR_NAME),
        Err(_) => return,
    };
    // Try q5_0 first, fall back to legacy FP16
    let ggml_path = {
        let q5 = dir.join(GGML_MODEL_FILENAME);
        if q5.exists() {
            q5
        } else {
            let legacy = dir.join(GGML_MODEL_FILENAME_LEGACY);
            if legacy.exists() { legacy } else { return; }
        }
    };

    log::info!("[model_manager] Auto-loading Whisper model from {}", ggml_path.display());

    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn whisper_engine_load_model(model_path: *const c_char) -> *mut c_char;
            fn speech_free_string(pointer: *mut c_char);
        }

        if let Ok(path_cstr) = CString::new(ggml_path.to_string_lossy().as_bytes()) {
            let result_ptr = unsafe { whisper_engine_load_model(path_cstr.as_ptr()) };
            if !result_ptr.is_null() {
                unsafe { speech_free_string(result_ptr) };
            }
            log::info!("[model_manager] Auto-load complete");
        }
    }
}

const GGML_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
const COREML_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-encoder.mlmodelc.zip";

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub downloaded: bool,
    pub ggml_downloaded: bool,
    pub coreml_downloaded: bool,
    pub size_bytes: u64,
    pub path: String,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    downloaded: u64,
    total: u64,
    percent: f64,
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 디렉토리를 찾을 수 없습니다: {e}"))?;
    Ok(data_dir.join(MODEL_DIR_NAME))
}

fn ggml_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = models_dir(app)?;
    let q5 = dir.join(GGML_MODEL_FILENAME);
    if q5.exists() { return Ok(q5); }
    let legacy = dir.join(GGML_MODEL_FILENAME_LEGACY);
    if legacy.exists() { return Ok(legacy); }
    Ok(q5) // default path for new downloads
}


#[tauri::command]
pub async fn check_whisper_model(app: AppHandle) -> Result<ModelStatus, String> {
    let dir = models_dir(&app)?;
    let coreml_path = dir.join(COREML_MODEL_DIR);

    // Check q5_0 or legacy FP16
    let ggml_q5 = dir.join(GGML_MODEL_FILENAME);
    let ggml_legacy = dir.join(GGML_MODEL_FILENAME_LEGACY);
    let (ggml_exists, ggml_path) = if ggml_q5.exists() {
        (true, ggml_q5)
    } else if ggml_legacy.exists() {
        (true, ggml_legacy)
    } else {
        (false, ggml_q5)
    };
    let coreml_exists = coreml_path.exists();

    let size = if ggml_exists {
        std::fs::metadata(&ggml_path)
            .map(|m| m.len())
            .unwrap_or(0)
    } else {
        0
    };

    Ok(ModelStatus {
        downloaded: ggml_exists && coreml_exists,
        ggml_downloaded: ggml_exists,
        coreml_downloaded: coreml_exists,
        size_bytes: size,
        path: ggml_path.to_string_lossy().to_string(),
        error: None,
    })
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle) -> Result<ModelStatus, String> {
    let dir = models_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("모델 디렉토리 생성 실패: {e}"))?;

    // Download ggml model
    let ggml_path = dir.join(GGML_MODEL_FILENAME);
    if !ggml_path.exists() {
        download_file(&app, GGML_MODEL_URL, &ggml_path, "ggml-medium-q5_0.bin").await?;
    }

    // Download CoreML model (zip)
    let coreml_zip_path = dir.join(COREML_MODEL_FILENAME);
    let coreml_dir_path = dir.join(COREML_MODEL_DIR);
    if !coreml_dir_path.exists() {
        download_file(&app, COREML_MODEL_URL, &coreml_zip_path, "coreml-encoder.zip").await?;

        // Extract zip
        let file = std::fs::File::open(&coreml_zip_path)
            .map_err(|e| format!("CoreML zip 파일 열기 실패: {e}"))?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| format!("CoreML zip 파싱 실패: {e}"))?;
        archive.extract(&dir)
            .map_err(|e| format!("CoreML zip 압축 해제 실패: {e}"))?;

        // Clean up zip file
        std::fs::remove_file(&coreml_zip_path).ok();
    }

    check_whisper_model(app).await
}

async fn download_file(
    app: &AppHandle,
    url: &str,
    dest: &PathBuf,
    label: &str,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{label} 다운로드 요청 실패: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("{label} 다운로드 실패: HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;

    let tmp_path = dest.with_extension("tmp");
    let mut file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("{label} 임시 파일 생성 실패: {e}"))?;

    let mut stream = response.bytes_stream();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("{label} 다운로드 중 오류: {e}"))?;
        std::io::Write::write_all(&mut file, &chunk)
            .map_err(|e| format!("{label} 파일 쓰기 오류: {e}"))?;
        downloaded += chunk.len() as u64;

        // Emit progress every 200ms
        if last_emit.elapsed().as_millis() >= 200 {
            let progress = DownloadProgress {
                file: label.to_string(),
                downloaded,
                total,
                percent: if total > 0 {
                    (downloaded as f64 / total as f64) * 100.0
                } else {
                    0.0
                },
            };
            if let Err(e) = app.emit("model-download-progress", &progress) {
                warn!("Failed to emit model-download-progress: {e}");
            }
            last_emit = std::time::Instant::now();
        }
    }

    // Final progress
    let progress = DownloadProgress {
        file: label.to_string(),
        downloaded,
        total,
        percent: 100.0,
    };
    if let Err(e) = app.emit("model-download-progress", &progress) {
        warn!("Failed to emit final model-download-progress: {e}");
    }

    // Rename tmp to final
    std::fs::rename(&tmp_path, dest)
        .map_err(|e| format!("{label} 파일 이동 실패: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_whisper_model(app: AppHandle) -> Result<ModelStatus, String> {
    log::info!("[model_manager] delete_whisper_model called");

    // Unload model first (thread-safe, no runOnMain)
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn whisper_engine_unload_model();
        }
        unsafe { whisper_engine_unload_model() };
        log::info!("[model_manager] whisper_engine_unload_model done");
    }

    let dir = models_dir(&app)?;
    log::info!("[model_manager] models dir: {}", dir.display());

    // Delete both q5_0 and legacy FP16 if they exist
    for filename in [GGML_MODEL_FILENAME, GGML_MODEL_FILENAME_LEGACY] {
        let ggml_path = dir.join(filename);
        if ggml_path.exists() {
            log::info!("[model_manager] deleting ggml: {}", ggml_path.display());
            std::fs::remove_file(&ggml_path)
                .map_err(|e| format!("ggml 모델 삭제 실패: {e}"))?;
        }
    }

    let coreml_path = dir.join(COREML_MODEL_DIR);
    if coreml_path.exists() {
        log::info!("[model_manager] deleting coreml: {}", coreml_path.display());
        std::fs::remove_dir_all(&coreml_path)
            .map_err(|e| format!("CoreML 모델 삭제 실패: {e}"))?;
    } else {
        log::info!("[model_manager] coreml not found: {}", coreml_path.display());
    }

    check_whisper_model(app).await
}

#[tauri::command]
pub async fn load_whisper_model(app: AppHandle) -> Result<ModelStatus, String> {
    let ggml_path = ggml_model_path(&app)?;

    if !ggml_path.exists() {
        return Err("Whisper 모델이 다운로드되지 않았습니다. 설정에서 모델을 먼저 다운로드해주세요.".into());
    }

    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn whisper_engine_load_model(model_path: *const c_char) -> *mut c_char;
            fn speech_free_string(pointer: *mut c_char);
        }

        let path_cstr = CString::new(ggml_path.to_string_lossy().as_bytes())
            .map_err(|_| "모델 경로에 null 바이트가 포함되어 있습니다.".to_string())?;

        let result_ptr = unsafe { whisper_engine_load_model(path_cstr.as_ptr()) };
        if result_ptr.is_null() {
            return Err("모델 로드 결과를 가져올 수 없습니다.".into());
        }

        let raw = unsafe { std::ffi::CStr::from_ptr(result_ptr) }
            .to_str()
            .map(str::to_owned)
            .map_err(|_| "모델 로드 결과가 유효하지 않은 UTF-8입니다.".to_string());
        unsafe { speech_free_string(result_ptr) };

        let raw = raw?;
        let result: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("모델 로드 결과 파싱 실패: {e}"))?;

        let loaded = result.get("loaded").and_then(|v| v.as_bool()).unwrap_or(false);
        if !loaded {
            let error = result.get("error").and_then(|v| v.as_str()).unwrap_or("알 수 없는 오류");
            return Err(error.to_string());
        }
    }

    check_whisper_model(app).await
}

#[tauri::command]
pub fn set_whisper_domain_hint(hint: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn whisper_engine_set_initial_prompt(prompt: *const c_char);
        }
        let cstr = CString::new(hint.as_bytes())
            .map_err(|_| "힌트에 null 바이트가 포함되어 있습니다.".to_string())?;
        unsafe { whisper_engine_set_initial_prompt(cstr.as_ptr()) };
    }
    Ok(())
}
