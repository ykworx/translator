use log::{error, warn};
use std::sync::LazyLock;

static RE_STYLE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+style="[^"]*""#).unwrap());
static RE_DATA: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+data-[a-z-]+="[^"]*""#).unwrap());
static RE_CLASS: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r#"\s+class="[^"]*""#).unwrap());

/// Read HTML from clipboard if it contains a table.
#[tauri::command]
pub fn read_clipboard_html() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        // Read HTML from NSPasteboard via objc2 FFI (no swift process spawn)
        let html = {
            use objc2_app_kit::NSPasteboard;
            use objc2_foundation::NSString;
            let pasteboard = NSPasteboard::generalPasteboard();
            let html_type = NSString::from_str("public.html");
            pasteboard.stringForType(&html_type).map(|s| s.to_string())
        }?;
        if !html.is_empty() && html.to_lowercase().contains("<table") {
            // Strip style/data-*/class attributes to reduce tokens
            let cleaned = RE_STYLE.replace_all(&html, "");
            let cleaned = RE_DATA.replace_all(&cleaned, "");
            let cleaned = RE_CLASS.replace_all(&cleaned, "");
            // Extract just the <table>...</table>
            if let Some(start) = cleaned.to_lowercase().find("<table") {
                if let Some(end_pos) = cleaned.to_lowercase().find("</table>") {
                    let table = &cleaned[start..end_pos + 8];
                    return Some(table.to_string());
                }
            }
            return Some(cleaned.to_string());
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Read image from clipboard and return as base64-encoded PNG, or None if no image.
#[tauri::command]
pub fn read_clipboard_image() -> Option<String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| warn!("Failed to open clipboard: {e}"))
        .ok()?;
    let img = clipboard
        .get_image()
        .map_err(|e| warn!("Failed to get image from clipboard: {e}"))
        .ok()?;

    let buffer: image::RgbaImage = image::ImageBuffer::from_raw(
        img.width as u32,
        img.height as u32,
        img.bytes.into_owned(),
    )?;

    let mut png_data = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut png_data);
    buffer
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|e| error!("Failed to encode clipboard image as PNG: {e}"))
        .ok()?;

    use base64::Engine;
    Some(base64::engine::general_purpose::STANDARD.encode(&png_data))
}

/// Write HTML to clipboard so it can be pasted as rich content (tables, etc.)
#[tauri::command]
pub fn write_clipboard_html(html: String) {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        let html_type = NSString::from_str("public.html");
        let text_type = NSString::from_str("public.utf8-plain-text");
        let ns_html = NSString::from_str(&html);
        // Also set plain text fallback (strip tags)
        let plain = strip_html_tags(&html);
        let ns_plain = NSString::from_str(&plain);
        pasteboard.setString_forType(&ns_html, &html_type);
        pasteboard.setString_forType(&ns_plain, &text_type);
    }
}

#[cfg(target_os = "macos")]
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    result
}
