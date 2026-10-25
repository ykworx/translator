use log::warn;
use crate::speech_model::SpeechModel;
use tauri_plugin_store::StoreExt;
use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::os::raw::c_char;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

static WHISPER_LOADED: AtomicBool = AtomicBool::new(false);
static LOADED_MODEL: AtomicU8 = AtomicU8::new(0);
static LOAD_LOCK: Mutex<()> = Mutex::new(());
static UNLOAD_GENERATION: AtomicU64 = AtomicU64::new(0);
static MODEL_FILES_BUSY: AtomicBool = AtomicBool::new(false);

struct ModelFilesOperation;
impl ModelFilesOperation {
    fn acquire() -> Result<Self, String> {
        MODEL_FILES_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map(|_| Self).map_err(|_| "다른 모델 다운로드 또는 삭제가 진행 중입니다.".into())
    }
}
impl Drop for ModelFilesOperation {
    fn drop(&mut self) { MODEL_FILES_BUSY.store(false, Ordering::SeqCst); }
}

const GRACE_PERIOD: Duration = Duration::from_secs(30);

const MODEL_DIR_NAME: &str = "models";
fn selected_model(app: &AppHandle, requested: Option<&str>) -> Result<SpeechModel, String> {
    let saved = if requested.is_none() {
        app.store("settings.json").map_err(|e| e.to_string())?
            .get("whisperModel").and_then(|v| v.as_str().map(str::to_owned))
    } else { None };
    SpeechModel::parse(requested.or(saved.as_deref()).unwrap_or("large-v3-turbo"))
}

#[tauri::command]
pub async fn ensure_whisper_loaded(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ensure_loaded(&app))
        .await.map_err(|e| e.to_string())?
}

fn ensure_loaded(app: &AppHandle) -> Result<(), String> {
    let _guard = LOAD_LOCK.lock().map_err(|e| format!("lock poisoned: {e}"))?;
    cancel_unload();

    let model = selected_model(app, None)?;
    if WHISPER_LOADED.load(Ordering::SeqCst) && LOADED_MODEL.load(Ordering::SeqCst) == model.cache_id() {
        return Ok(());
    }
    let model_path = models_dir(app)?.join(model.ggml_filename());
    if !model_path.exists() {
        return Err(format!("Whisper {} 모델 파일이 없습니다. 설정에서 선택한 모델을 다운로드해주세요.", model.id()));
    }

    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn whisper_engine_load_model(model_path: *const c_char) -> *mut c_char;
            fn speech_free_string(p: *mut c_char);
            fn whisper_engine_is_model_loaded() -> bool;
        }

        let path_str = model_path.to_string_lossy().to_string();
        let path_cstr = CString::new(path_str).map_err(|e| format!("invalid path: {e}"))?;
        let result_ptr = unsafe { whisper_engine_load_model(path_cstr.as_ptr()) };
        // A failed replacement may have destroyed the previous context. Do not
        // leave a stale Rust cache claiming that the old model is ready.
        if !unsafe { whisper_engine_is_model_loaded() } {
            WHISPER_LOADED.store(false, Ordering::SeqCst);
            LOADED_MODEL.store(0, Ordering::SeqCst);
        }
        if result_ptr.is_null() {
            return Err("Whisper 모델 로드 결과를 가져올 수 없습니다.".to_string());
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
            return Err(format!("Whisper 모델 로드 실패: {error}"));
        }
    }

    LOADED_MODEL.store(model.cache_id(), Ordering::SeqCst);
    WHISPER_LOADED.store(true, Ordering::SeqCst);
    log::info!("[model_manager] whisper loaded (lazy)");
    Ok(())
}

pub fn schedule_unload() {
    schedule_unload_after(GRACE_PERIOD);
}

pub fn schedule_unload_after(delay: Duration) {
    if !WHISPER_LOADED.load(Ordering::SeqCst) {
        return;
    }
    let my_gen = UNLOAD_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    std::thread::spawn(move || {
        std::thread::sleep(delay);
        if UNLOAD_GENERATION.load(Ordering::SeqCst) != my_gen {
            return;
        }

        let Ok(_guard) = LOAD_LOCK.lock() else { return };
        if UNLOAD_GENERATION.load(Ordering::SeqCst) != my_gen {
            return;
        }
        if !WHISPER_LOADED.load(Ordering::SeqCst) {
            return;
        }

        log::info!("[model_manager] idle unload after grace period");
        if native_shutdown() {
            WHISPER_LOADED.store(false, Ordering::SeqCst);
        }
    });
}

pub fn cancel_unload() {
    UNLOAD_GENERATION.fetch_add(1, Ordering::SeqCst);
}

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


#[tauri::command]
pub async fn check_whisper_model(app: AppHandle, model: Option<String>) -> Result<ModelStatus, String> {
    let spec = selected_model(&app, model.as_deref())?;
    model_status(&app, spec)
}

fn model_status(app: &AppHandle, spec: SpeechModel) -> Result<ModelStatus, String> {
    let dir = models_dir(app)?;
    let coreml_exists = encoder_ready(&dir.join(spec.encoder_dir()));
    let ggml_path = dir.join(spec.ggml_filename());
    let ggml_exists = ggml_path.exists();
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
pub async fn download_whisper_model(app: AppHandle, model: Option<String>) -> Result<ModelStatus, String> {
    let _operation = ModelFilesOperation::acquire()?;
    let spec = selected_model(&app, model.as_deref())?;
    let dir = models_dir(&app)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("모델 디렉토리 생성 실패: {e}"))?;

    // Download ggml model
    let ggml_path = dir.join(spec.ggml_filename());
    if !ggml_path.exists() {
        download_file(&app, &spec.download_url(false), &ggml_path, &spec.ggml_filename()).await?;
    }

    // Download CoreML model (zip)
    let coreml_zip_path = dir.join(spec.encoder_filename());
    let coreml_dir_path = dir.join(spec.encoder_dir());
    if !encoder_ready(&coreml_dir_path) {
        download_file(&app, &spec.download_url(true), &coreml_zip_path, &spec.encoder_filename()).await?;
        let archive_dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || install_encoder(&archive_dir, spec))
            .await.map_err(|e| e.to_string())??;
    }

    model_status(&app, spec)
}

fn encoder_ready(path: &std::path::Path) -> bool {
    path.is_dir() && path.join("coremldata.bin").is_file()
}

fn install_encoder(dir: &std::path::Path, spec: SpeechModel) -> Result<(), String> {
    // A failed extraction must not make an incomplete encoder look installed.
    let staging = dir.join(format!(".{}-extracting", spec.id()));
    if staging.exists() { std::fs::remove_dir_all(&staging).map_err(|e| e.to_string())?; }
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let archive_path = dir.join(spec.encoder_filename());
    let file = std::fs::File::open(&archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    archive.extract(&staging).map_err(|e| format!("CoreML 압축 해제 실패: {e}"))?;
    let extracted = staging.join(spec.encoder_dir());
    if !encoder_ready(&extracted) { return Err("CoreML 압축 파일에 완성된 모델이 없습니다.".into()); }
    let destination = dir.join(spec.encoder_dir());
    if destination.exists() { std::fs::remove_dir_all(&destination).map_err(|e| e.to_string())?; }
    std::fs::rename(&extracted, &destination).map_err(|e| e.to_string())?;
    std::fs::remove_dir_all(&staging).ok();
    std::fs::remove_file(&archive_path).ok();
    Ok(())
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

    if downloaded == 0 || (total != 0 && downloaded != total) {
        return Err(format!("{label} 다운로드 크기가 일치하지 않습니다."));
    }
    std::io::Write::flush(&mut file).map_err(|e| e.to_string())?;
    drop(file);
    // Rename tmp to final
    std::fs::rename(&tmp_path, dest)
        .map_err(|e| format!("{label} 파일 이동 실패: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn delete_whisper_model(app: AppHandle, model: Option<String>) -> Result<ModelStatus, String> {
    let spec = selected_model(&app, model.as_deref())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || delete_model_files(&handle, spec))
        .await.map_err(|e| e.to_string())??;
    model_status(&app, spec)
}

fn delete_model_files(app: &AppHandle, spec: SpeechModel) -> Result<(), String> {
    let _operation = ModelFilesOperation::acquire()?;
    let _guard = LOAD_LOCK.lock().map_err(|e| e.to_string())?;
    cancel_unload();
    // Keep load/delete mutually exclusive until the files are gone.
    if !native_shutdown() {
        return Err("음성 입력 또는 자막을 중지한 뒤 모델을 삭제해주세요.".into());
    }
    WHISPER_LOADED.store(false, Ordering::SeqCst);
    let dir = models_dir(&app)?;
    log::info!("[model_manager] models dir: {}", dir.display());

    // Delete only the selected model, preserving other installed models.
    for filename in [spec.ggml_filename(), spec.encoder_filename()] {
        let ggml_path = dir.join(filename);
        if ggml_path.exists() {
            log::info!("[model_manager] deleting ggml: {}", ggml_path.display());
            std::fs::remove_file(&ggml_path)
                .map_err(|e| format!("ggml 모델 삭제 실패: {e}"))?;
        }
    }

    let coreml_path = dir.join(spec.encoder_dir());
    if coreml_path.exists() {
        log::info!("[model_manager] deleting coreml: {}", coreml_path.display());
        std::fs::remove_dir_all(&coreml_path)
            .map_err(|e| format!("CoreML 모델 삭제 실패: {e}"))?;
    } else {
        log::info!("[model_manager] coreml not found: {}", coreml_path.display());
    }

    Ok(())
}

#[tauri::command]
pub async fn load_whisper_model(app: AppHandle) -> Result<ModelStatus, String> {
    ensure_whisper_loaded(app.clone()).await?;
    model_status(&app, selected_model(&app, None)?)
}

fn native_shutdown() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn whisper_engine_shutdown() -> bool; }
        unsafe { whisper_engine_shutdown() }
    }
    #[cfg(not(target_os = "macos"))]
    { true }
}

pub fn shutdown_whisper() -> bool {
    let Ok(_guard) = LOAD_LOCK.lock() else { return false; };
    cancel_unload();
    if !native_shutdown() { return false; }
    WHISPER_LOADED.store(false, Ordering::SeqCst);
    true
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("transrator-model-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).ok(); }
    }

    fn make_encoder_archive(dir: &std::path::Path, spec: SpeechModel, complete: bool) {
        let file = std::fs::File::create(dir.join(spec.encoder_filename())).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let name = if complete { "coremldata.bin" } else { "metadata.json" };
        archive.start_file(format!("{}/{name}", spec.encoder_dir()), zip::write::SimpleFileOptions::default()).unwrap();
        archive.write_all(b"test encoder payload").unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn incomplete_extraction_never_marks_a_model_installed() {
        let dir = TestDirectory::new();
        let spec = SpeechModel::Turbo;
        make_encoder_archive(&dir.0, spec, false);
        assert!(install_encoder(&dir.0, spec).is_err());
        assert!(!encoder_ready(&dir.0.join(spec.encoder_dir())));
    }

    #[test]
    fn complete_encoder_is_installed_atomically_without_touching_other_models() {
        let dir = TestDirectory::new();
        let spec = SpeechModel::Turbo;
        let other = dir.0.join(SpeechModel::Medium.ggml_filename());
        std::fs::write(&other, b"other model").unwrap();
        make_encoder_archive(&dir.0, spec, true);
        install_encoder(&dir.0, spec).unwrap();
        assert!(encoder_ready(&dir.0.join(spec.encoder_dir())));
        assert!(!dir.0.join(spec.encoder_filename()).exists());
        assert!(!dir.0.join(format!(".{}-extracting", spec.id())).exists());
        assert_eq!(std::fs::read(other).unwrap(), b"other model");
    }

    #[test]
    fn file_operation_guard_releases_after_errors_and_scope_exit() {
        {
            let _operation = ModelFilesOperation::acquire().unwrap();
            assert!(ModelFilesOperation::acquire().is_err());
        }
        assert!(ModelFilesOperation::acquire().is_ok());
    }
}
