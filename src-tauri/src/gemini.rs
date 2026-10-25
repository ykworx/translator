use crate::cloud_http;
use crate::connections::{resolve_runtime, ConnectionManager};
use crate::openai::drain_complete_lines;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};
use tauri::{ipc::Channel, State};

const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models/";
const MAX_RETRIES: u32 = 4;
const MIN_INTERVAL: Duration = Duration::from_millis(1200);

fn endpoint(model: &str, streaming: bool) -> Result<String, String> {
    let model = model.strip_prefix("models/").unwrap_or(model);
    if model.is_empty()
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err("Gemini 모델 이름이 올바르지 않습니다. 설정에서 모델을 확인해주세요.".into());
    }
    let operation = if streaming {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };
    Ok(format!("{GEMINI_BASE}{model}:{operation}"))
}

fn retry_after_ms(value: Option<&str>, now: SystemTime) -> Option<u64> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<f64>() {
        return (seconds.is_finite() && seconds >= 0.0).then_some((seconds * 1000.0) as u64);
    }
    httpdate::parse_http_date(value).ok().map(|date| {
        date.duration_since(now)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64
    })
}

/// Retain Gemini's 1.2-second spacing and retry policy across all app windows.
async fn wait_for_start_slot() {
    static NEXT_START: OnceLock<tokio::sync::Mutex<Instant>> = OnceLock::new();
    let wait = {
        let mut next = NEXT_START
            .get_or_init(|| tokio::sync::Mutex::new(Instant::now()))
            .lock()
            .await;
        let now = Instant::now();
        let slot = (*next).max(now);
        *next = slot + MIN_INTERVAL;
        slot.saturating_duration_since(now)
    };
    tokio::time::sleep(wait).await;
}

async fn post(
    model: &str,
    api_key: &str,
    parts: Value,
    streaming: bool,
) -> Result<reqwest::Response, String> {
    let client = cloud_http::client()?;
    let url = endpoint(model, streaming)?;
    let header = cloud_http::sensitive_header(api_key)?;
    let body = json!({"contents": [{"parts": parts}]});
    let mut attempt = 0u32;
    loop {
        wait_for_start_slot().await;
        let response = client
            .post(&url)
            .header("x-goog-api-key", header.clone())
            .json(&body)
            .send()
            .await
            .map_err(|error| cloud_http::network_error("Gemini", error))?;
        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok(response);
        }
        let retry_after = retry_after_ms(
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()),
            SystemTime::now(),
        );
        if !matches!(status, 429 | 500 | 502 | 503 | 504) || attempt >= MAX_RETRIES {
            let text = response.text().await.unwrap_or_default();
            return Err(cloud_http::api_error("Gemini", status, &text, api_key));
        }
        // Drop the error response before waiting, without exposing its contents.
        drop(response);
        let delay = retry_after.unwrap_or(1500 * 2u64.pow(attempt)).min(15000);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        attempt += 1;
    }
}

fn response_text(data: &Value) -> &str {
    data.pointer("/candidates/0/content/parts/0/text")
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn stream_text(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data:")?.trim();
    let data: Value = serde_json::from_str(payload).ok()?;
    let text = response_text(&data);
    (!text.is_empty()).then(|| text.to_owned())
}

fn parts(prompt: &str, image: Option<&str>) -> Value {
    match image {
        Some(image) => json!([
            {"text": prompt},
            {"inline_data": {"mime_type": "image/png", "data": image}}
        ]),
        None => json!([{"text": prompt}]),
    }
}

async fn generate(model: &str, api_key: &str, parts: Value) -> Result<String, String> {
    let response = post(model, api_key, parts, false).await?;
    let data: Value = response
        .json()
        .await
        .map_err(|_| "Gemini 응답 형식이 올바르지 않습니다.".to_string())?;
    Ok(response_text(&data).trim().to_owned())
}

#[tauri::command]
pub async fn gemini_generate_text(
    state: State<'_, ConnectionManager>,
    runtime_id: String,
    prompt: String,
) -> Result<String, String> {
    let runtime = resolve_runtime(state.inner(), &runtime_id, "gemini-native")?;
    generate(&runtime.model, &runtime.api_key, parts(&prompt, None)).await
}

#[tauri::command]
pub async fn gemini_generate_image(
    state: State<'_, ConnectionManager>,
    runtime_id: String,
    prompt: String,
    image_base64: String,
) -> Result<String, String> {
    let runtime = resolve_runtime(state.inner(), &runtime_id, "gemini-native")?;
    generate(
        &runtime.model,
        &runtime.api_key,
        parts(&prompt, Some(&image_base64)),
    )
    .await
}

#[tauri::command]
pub async fn gemini_generate_text_stream(
    state: State<'_, ConnectionManager>,
    runtime_id: String,
    prompt: String,
    on_chunk: Channel<String>,
) -> Result<String, String> {
    let runtime = resolve_runtime(state.inner(), &runtime_id, "gemini-native")?;
    let response = post(&runtime.model, &runtime.api_key, parts(&prompt, None), true).await?;
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut accumulated = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| cloud_http::network_error("Gemini 스트리밍", error))?;
        buffer.extend_from_slice(&chunk);
        for line in drain_complete_lines(&mut buffer) {
            if let Some(delta) = stream_text(&line) {
                accumulated.push_str(&delta);
                let _ = on_chunk.send(accumulated.clone());
            }
        }
    }
    if !buffer.is_empty() {
        if let Some(delta) = stream_text(&String::from_utf8_lossy(&buffer)) {
            accumulated.push_str(&delta);
            let _ = on_chunk.send(accumulated.clone());
        }
    }
    Ok(accumulated.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_cannot_change_provider_origin_or_embed_a_key() {
        for model in ["gemini-2.5-flash", "models/gemini-2.5-flash"] {
            assert_eq!(
                endpoint(model, false).unwrap(),
                format!("{GEMINI_BASE}gemini-2.5-flash:generateContent")
            );
            let stream = endpoint(model, true).unwrap();
            assert!(stream.ends_with(":streamGenerateContent?alt=sse"));
            assert!(!stream.contains("key="));
        }
        for model in [
            "",
            "../x",
            "https://elsewhere.test",
            "model?key=leak",
            "x#y",
            "x/y",
        ] {
            assert!(endpoint(model, false).is_err());
        }
    }

    #[test]
    fn image_and_text_payloads_preserve_existing_content_contract() {
        assert_eq!(parts("hello", None), json!([{"text": "hello"}]));
        assert_eq!(
            parts("describe", Some("fake-base64")),
            json!([
                {"text": "describe"}, {"inline_data": {"mime_type": "image/png", "data": "fake-base64"}}
            ])
        );
    }

    #[test]
    fn retry_after_supports_numeric_and_date_headers() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        assert_eq!(retry_after_ms(Some("1.5"), now), Some(1500));
        assert_eq!(
            retry_after_ms(
                Some(&httpdate::fmt_http_date(now + Duration::from_secs(3))),
                now
            ),
            Some(3000)
        );
        assert_eq!(
            retry_after_ms(
                Some(&httpdate::fmt_http_date(now - Duration::from_secs(3))),
                now
            ),
            Some(0)
        );
        for header in ["", "NaN", "-1", "garbage"] {
            assert_eq!(retry_after_ms(Some(header), now), None);
        }
    }

    #[test]
    fn streaming_reassembles_multibyte_text_and_final_unterminated_line() {
        let line = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"안녕日本語\"}]}}]}";
        let split = line.find('안').unwrap() + 1;
        let mut buffer = line.as_bytes()[..split].to_vec();
        assert!(drain_complete_lines(&mut buffer).is_empty());
        buffer.extend_from_slice(&line.as_bytes()[split..]);
        assert_eq!(
            stream_text(&String::from_utf8_lossy(&buffer)),
            Some("안녕日本語".into())
        );
        buffer.push(b'\n');
        let lines = drain_complete_lines(&mut buffer);
        assert_eq!(stream_text(&lines[0]), Some("안녕日本語".into()));
        assert!(buffer.is_empty());
    }

    #[test]
    fn sse_ignores_metadata_malformed_data_and_empty_parts() {
        for line in [
            "event: message",
            "data: [DONE]",
            "data: {broken",
            "data: {}",
            "data: {\"candidates\":[]}",
        ] {
            assert_eq!(stream_text(line), None);
        }
    }
}
