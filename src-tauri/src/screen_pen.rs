#[tauri::command]
pub async fn open_screen_pen(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" { fn transrator_show_screen_pen() -> bool; }
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let shown = unsafe { transrator_show_screen_pen() };
            let _ = send.send(shown);
        }).map_err(|_| "화면 펜을 열지 못했습니다. 다시 시도해주세요.".to_string())?;
        if receive.await.unwrap_or(false) { Ok(()) }
        else { Err("화면 펜을 표시할 화면을 찾지 못했습니다.".to_string()) }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = app; Err("화면 펜은 macOS에서 사용할 수 있습니다.".to_string()) }
}
