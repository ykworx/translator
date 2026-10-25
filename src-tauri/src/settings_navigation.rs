use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsTab { Dictation }

/// A single, bounded UI request. It contains no settings or credential values.
#[derive(Default)]
pub struct SettingsNavigation(Mutex<Option<SettingsTab>>);

impl SettingsNavigation {
    pub fn request(&self, tab: SettingsTab) -> Result<(), String> {
        *self.0.lock().map_err(|_| "설정 화면 이동을 준비하지 못했습니다.")? = Some(tab);
        Ok(())
    }

    pub fn take(&self, window: &str) -> Result<Option<SettingsTab>, String> {
        if window != "settings" { return Err("설정 창에서만 화면 이동을 확인할 수 있습니다.".into()); }
        Ok(self.0.lock().map_err(|_| "설정 화면 이동을 확인하지 못했습니다.")?.take())
    }
}

#[tauri::command]
pub fn consume_settings_navigation(window: tauri::WebviewWindow, state: tauri::State<'_, SettingsNavigation>) -> Result<Option<SettingsTab>, String> {
    state.take(window.label())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_settings_can_consume_a_queued_request() {
        let navigation = SettingsNavigation::default();
        navigation.request(SettingsTab::Dictation).unwrap();
        assert!(navigation.take("main").is_err());
        assert!(navigation.take("handwriting-overlay").is_err());
        assert_eq!(navigation.take("settings").unwrap(), Some(SettingsTab::Dictation));
        assert_eq!(navigation.take("settings").unwrap(), None);
    }

    #[test]
    fn repeated_requests_remain_bounded_and_work_after_consumption() {
        let navigation = SettingsNavigation::default();
        for _ in 0..100 { navigation.request(SettingsTab::Dictation).unwrap(); }
        assert_eq!(navigation.take("settings").unwrap(), Some(SettingsTab::Dictation));
        assert_eq!(navigation.take("settings").unwrap(), None);
        navigation.request(SettingsTab::Dictation).unwrap();
        assert_eq!(navigation.take("settings").unwrap(), Some(SettingsTab::Dictation));
    }
}
