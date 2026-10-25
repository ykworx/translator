/// Embedded at compilation; reading this never initializes the app or opens user settings.
pub fn info() -> serde_json::Value {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/build-info.json")))
        .expect("build script generated invalid build metadata")
}

#[tauri::command]
pub fn get_build_info() -> serde_json::Value {
    info()
}
