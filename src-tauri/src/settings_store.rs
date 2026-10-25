//! Fixed-path, non-secret settings IPC. The generic Store plugin is native-only.
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::{Store, StoreExt};
use uuid::Uuid;

static WRITES: Mutex<()> = Mutex::new(());
// Resource creation and close share this lock. A worker must not recreate the
// Store after ExitRequested, re-enabling the plugin's non-atomic Exit save.
static LIFECYCLE: Mutex<bool> = Mutex::new(false);
const STORE_ERROR: &str = "설정을 읽거나 저장할 수 없습니다. 파일 접근 권한을 확인해주세요.";
const PUBLIC_KEYS: &[&str] = &[
    "myLang",
    "pairLang",
    "model",
    "speechLocale",
    "dictationLocale",
    "dictationHint",
    "dictationMicrophone",
    "dictationIdleSeconds",
    "dictationShortcut",
    "captureMode",
    "captureWindow",
    "targetLanguage",
    "selectShortcut",
    "clipboardShortcut",
    "domainHint",
    "whisperModel",
    "llmBackendId",
    "ollamaBaseUrl",
    "ollamaModel",
    "openaiModel",
    "experimentalCaptions",
];

fn public_key(key: &str) -> Result<(), String> {
    if PUBLIC_KEYS.contains(&key) {
        Ok(())
    } else {
        Err("이 설정은 일반 설정 화면에서 읽거나 변경할 수 없습니다.".into())
    }
}

pub(crate) fn store(app: &AppHandle) -> Result<Arc<Store<tauri::Wry>>, String> {
    let closing = LIFECYCLE.lock().map_err(|_| STORE_ERROR)?;
    if *closing {
        return Err("앱이 종료 중입니다.".into());
    }
    if let Some(store) = app.get_store("settings.json") {
        return Ok(store);
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| STORE_ERROR)?
        .join("settings.json");
    match fs::read(&path) {
        Ok(bytes) => {
            let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| STORE_ERROR)?;
            if !parsed.is_object() {
                return Err(STORE_ERROR.into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err(STORE_ERROR.into()),
    }
    // All persistence is explicit and atomic. Plugin auto-save uses fs::write,
    // which could truncate the source during a failed credential migration.
    app.store_builder("settings.json")
        .disable_auto_save()
        .build()
        .map_err(|_| STORE_ERROR.into())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or(STORE_ERROR)?;
    fs::create_dir_all(parent).map_err(|_| STORE_ERROR)?;
    let temporary = parent.join(format!(".settings-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| STORE_ERROR)?;
        file.write_all(bytes).map_err(|_| STORE_ERROR)?;
        file.sync_all().map_err(|_| STORE_ERROR)?;
        fs::rename(&temporary, path).map_err(|_| STORE_ERROR)?;
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| STORE_ERROR)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn persist_unlocked(app: &AppHandle, store: &Store<tauri::Wry>) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| STORE_ERROR)?
        .join("settings.json");
    let values: BTreeMap<String, Value> = store.entries().into_iter().collect();
    let bytes = serde_json::to_vec(&values).map_err(|_| STORE_ERROR)?;
    atomic_write(&path, &bytes)
}

pub(crate) fn persist(app: &AppHandle) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| STORE_ERROR)?;
    persist_unlocked(app, store(app)?.as_ref())
}

/// Store 2.4 also performs a non-atomic save on RunEvent::Exit, regardless of
/// autoSave. Flush and close its resource on ExitRequested, before that hook.
pub(crate) fn prepare_exit(app: &AppHandle) {
    let Ok(_guard) = WRITES.lock() else {
        return;
    };
    let Ok(mut closing) = LIFECYCLE.lock() else {
        return;
    };
    *closing = true;
    if let Some(store) = app.get_store("settings.json") {
        if persist_unlocked(app, &store).is_err() {
            log::error!("설정의 종료 시 저장을 완료하지 못했습니다.");
        }
        store.close_resource();
    }
}

#[tauri::command]
pub fn settings_load(app: AppHandle) -> Result<u32, String> {
    store(&app)?;
    // Compatibility token, not an arbitrary filesystem resource or Store rid.
    Ok(1)
}

#[tauri::command]
pub fn settings_get(app: AppHandle, key: String) -> Result<(Value, bool), String> {
    public_key(&key)?;
    Ok(match store(&app)?.get(key) {
        Some(value) => (value, true),
        None => (Value::Null, false),
    })
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    public_key(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITES.lock().map_err(|_| STORE_ERROR)?;
        let store = store(&app)?;
        let previous = store.get(&key);
        store.set(&key, value);
        if let Err(error) = persist_unlocked(&app, &store) {
            match previous {
                Some(value) => store.set(&key, value),
                None => {
                    store.delete(&key);
                }
            }
            // A rename can succeed before the directory sync reports failure.
            let _ = persist_unlocked(&app, &store);
            return Err(error);
        }
        Ok(())
    })
    .await
    .map_err(|_| STORE_ERROR.to_string())?
}

#[tauri::command]
pub async fn settings_delete(app: AppHandle, key: String) -> Result<(), String> {
    public_key(&key)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITES.lock().map_err(|_| STORE_ERROR)?;
        let store = store(&app)?;
        let previous = store.get(&key);
        store.delete(&key);
        if let Err(error) = persist_unlocked(&app, &store) {
            if let Some(value) = previous {
                store.set(&key, value);
            }
            let _ = persist_unlocked(&app, &store);
            return Err(error);
        }
        Ok(())
    })
    .await
    .map_err(|_| STORE_ERROR.to_string())?
}

#[tauri::command]
pub async fn settings_save(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || persist(&app))
        .await
        .map_err(|_| STORE_ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn general_ipc_never_accepts_credentials_unknown_keys_or_paths() {
        for key in [
            "apiKey",
            "openaiApiKey",
            "auth-profiles.json",
            "../settings.json",
            "newSecret",
        ] {
            assert!(public_key(key).is_err());
        }
        let constants = include_str!("../../src/constants.ts")
            .split("export const SETTINGS_KEYS = {")
            .nth(1)
            .unwrap()
            .split("} as const")
            .next()
            .unwrap();
        let keys = regex::Regex::new(r#"\w+:\s*"([^"]+)""#).unwrap();
        let public: Vec<&str> = keys
            .captures_iter(constants)
            .filter_map(|capture| {
                let key = capture.get(1).unwrap().as_str();
                (!matches!(key, "apiKey" | "openaiApiKey")).then_some(key)
            })
            .collect();
        for key in &public {
            assert!(
                public_key(key).is_ok(),
                "missing non-secret settings key: {key}"
            );
        }
        assert_eq!(public.len(), PUBLIC_KEYS.len());
    }

    #[test]
    fn generic_store_permissions_are_not_exposed_to_webviews() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(!capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|permission| permission
                .as_str()
                .is_some_and(|id| id.starts_with("store:"))));
    }

    #[test]
    fn atomic_settings_write_preserves_other_keys_and_leaves_no_temporary_file() {
        let directory =
            std::env::temp_dir().join(format!("transrator-settings-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("settings.json");
        atomic_write(&path, br#"{"ollamaModel":"first"}"#).unwrap();
        atomic_write(
            &path,
            br#"{"ollamaModel":"second","dictationLocale":"ko-KR"}"#,
        )
        .unwrap();
        let settings: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(settings["dictationLocale"], "ko-KR");
        assert_eq!(settings["ollamaModel"], "second");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }
}
