use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::ipc::Channel;

const OPENAI_API_URL: &str = "https://api.openai.com/v1/chat/completions";

const MAX_RETRY_ATTEMPTS: u32 = 4;
const BASE_RETRY_DELAY_MS: u64 = 1500;
const MAX_RETRY_DELAY_MS: u64 = 15000;

/// HTTP status codes that warrant a retry (rate limit + transient server errors).
fn is_retryable(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

/// Parse the `retry-after` header into milliseconds.
/// Only numeric (seconds) values are supported — HTTP-date values are ignored (returns None).
fn parse_retry_after_ms(header: Option<&str>) -> Option<u64> {
    let value = header?.trim();
    if value.is_empty() {
        return None;
    }
    // Numeric seconds → milliseconds
    if let Ok(seconds) = value.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            return Some((seconds * 1000.0) as u64);
        }
    }
    // HTTP-date form is intentionally not supported here.
    None
}

/// Result of parsing a single SSE line from the OpenAI streaming response.
#[derive(Debug, PartialEq)]
enum SseEvent {
    Delta(String),
    Done,
    Skip,
}

/// Parse one SSE line. Lines not starting with `data: ` are skipped. A `[DONE]`
/// payload signals end-of-stream. Otherwise the JSON is parsed and
/// `choices[0].delta.content` is extracted; parse failures are skipped.
fn parse_sse_line(line: &str) -> SseEvent {
    let Some(payload) = line.strip_prefix("data: ") else {
        return SseEvent::Skip;
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return SseEvent::Skip;
    }
    if payload == "[DONE]" {
        return SseEvent::Done;
    }
    match serde_json::from_str::<Value>(payload) {
        Ok(value) => match value
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("delta"))
            .and_then(|d| d.get("content"))
            .and_then(|c| c.as_str())
        {
            Some(content) => SseEvent::Delta(content.to_string()),
            None => SseEvent::Skip,
        },
        Err(_) => SseEvent::Skip,
    }
}

/// POST `body` to the OpenAI API with retry/backoff for retryable statuses.
/// Returns the successful `reqwest::Response`, or a formatted error string.
async fn post_json_with_retry(
    client: &reqwest::Client,
    api_key: &str,
    body: Value,
) -> Result<reqwest::Response, String> {
    let mut attempt: u32 = 0;

    loop {
        let resp = client
            .post(OPENAI_API_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenAI 요청 실패: {e}"))?;

        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }

        let retry_after_ms = parse_retry_after_ms(
            resp.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()),
        );

        let should_retry = is_retryable(status.as_u16()) && attempt < MAX_RETRY_ATTEMPTS;
        if !should_retry {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("OpenAI API error: {} {}", status.as_u16(), text));
        }

        let backoff_ms = retry_after_ms
            .unwrap_or_else(|| BASE_RETRY_DELAY_MS * 2u64.pow(attempt))
            .min(MAX_RETRY_DELAY_MS);
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        attempt += 1;
    }
}

/// Drain all complete (newline-terminated) lines from `buffer`, returning each
/// decoded line (without the trailing `\n`). Incomplete trailing bytes stay in
/// `buffer`. Splitting on the newline byte (0x0A, which never appears inside a
/// UTF-8 multi-byte sequence) means characters split across chunk boundaries —
/// e.g. Korean/Japanese — are reassembled before decoding and never corrupted.
fn drain_complete_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
        let line_bytes: Vec<u8> = buffer.drain(..=pos).collect();
        lines.push(String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]).into_owned());
    }
    lines
}

/// Extract `choices[0].message.content` (trimmed) from a parsed response body.
fn extract_message_content(data: &Value) -> String {
    data.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn openai_generate_text(
    api_key: String,
    model: String,
    prompt: String,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("OpenAI API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.".into());
    }

    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": false,
    });

    let resp = post_json_with_retry(&client, &api_key, body).await?;
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("OpenAI 응답 파싱 실패: {e}"))?;
    Ok(extract_message_content(&data))
}

#[tauri::command]
pub async fn openai_generate_image(
    api_key: String,
    model: String,
    prompt: String,
    image_base64: String,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("OpenAI API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.".into());
    }

    let client = reqwest::Client::new();
    // OpenAI uses image_url as an object { url: "..." }, unlike Ollama's bare string.
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                {
                    "type": "image_url",
                    "image_url": { "url": format!("data:image/png;base64,{image_base64}") }
                }
            ]
        }],
        "stream": false,
    });

    let resp = post_json_with_retry(&client, &api_key, body).await?;
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("OpenAI 응답 파싱 실패: {e}"))?;
    Ok(extract_message_content(&data))
}

#[tauri::command]
pub async fn openai_generate_text_stream(
    api_key: String,
    model: String,
    prompt: String,
    on_chunk: Channel<String>,
) -> Result<String, String> {
    if api_key.is_empty() {
        return Err("OpenAI API 키가 설정되지 않았습니다. 트레이 메뉴에서 설정을 열어주세요.".into());
    }

    let client = reqwest::Client::new();
    let body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": true,
    });

    // Retry applies only to the initial connect (the response is then streamed).
    let resp = post_json_with_retry(&client, &api_key, body).await?;

    let mut stream = resp.bytes_stream();
    // Accumulate RAW bytes so multi-byte UTF-8 characters (Korean/Japanese) split
    // across chunk boundaries aren't corrupted — only complete lines are decoded.
    let mut buffer: Vec<u8> = Vec::new();
    let mut accumulated = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("OpenAI 스트리밍 오류: {e}"))?;
        buffer.extend_from_slice(&chunk);

        for line in drain_complete_lines(&mut buffer) {
            if let SseEvent::Delta(delta) = parse_sse_line(&line) {
                accumulated.push_str(&delta);
                let _ = on_chunk.send(accumulated.clone());
            }
        }
    }

    // Flush any trailing line left in the buffer (no terminating newline).
    if !buffer.is_empty() {
        let line = String::from_utf8_lossy(&buffer);
        if let SseEvent::Delta(delta) = parse_sse_line(&line) {
            accumulated.push_str(&delta);
            let _ = on_chunk.send(accumulated.clone());
        }
    }

    Ok(accumulated.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_line_returns_delta_for_valid_data_line() {
        let line = r#"data: {"choices":[{"delta":{"content":"Hello"}}]}"#;
        assert_eq!(parse_sse_line(line), SseEvent::Delta("Hello".to_string()));
    }

    #[test]
    fn parse_sse_line_returns_done_for_done_marker() {
        assert_eq!(parse_sse_line("data: [DONE]"), SseEvent::Done);
    }

    #[test]
    fn parse_sse_line_skips_non_data_lines() {
        assert_eq!(parse_sse_line("event: message"), SseEvent::Skip);
        assert_eq!(parse_sse_line(""), SseEvent::Skip);
        assert_eq!(parse_sse_line(": keep-alive comment"), SseEvent::Skip);
    }

    #[test]
    fn parse_sse_line_skips_malformed_json() {
        assert_eq!(parse_sse_line("data: {broken json"), SseEvent::Skip);
    }

    #[test]
    fn parse_sse_line_skips_when_delta_content_missing() {
        let line = r#"data: {"choices":[{"delta":{}}]}"#;
        assert_eq!(parse_sse_line(line), SseEvent::Skip);
    }

    #[test]
    fn is_retryable_true_for_retryable_statuses() {
        for status in [429, 500, 502, 503, 504] {
            assert!(is_retryable(status), "expected {status} to be retryable");
        }
    }

    #[test]
    fn is_retryable_false_for_non_retryable_statuses() {
        for status in [200, 400, 401, 403, 404, 422, 501] {
            assert!(!is_retryable(status), "expected {status} to be non-retryable");
        }
    }

    #[test]
    fn parse_retry_after_ms_parses_numeric_seconds() {
        assert_eq!(parse_retry_after_ms(Some("2")), Some(2000));
        assert_eq!(parse_retry_after_ms(Some("0")), Some(0));
        assert_eq!(parse_retry_after_ms(Some("1.5")), Some(1500));
    }

    #[test]
    fn parse_retry_after_ms_returns_none_for_garbage_or_none() {
        assert_eq!(parse_retry_after_ms(None), None);
        assert_eq!(parse_retry_after_ms(Some("")), None);
        assert_eq!(parse_retry_after_ms(Some("not-a-number")), None);
        // HTTP-date form is not supported → None
        assert_eq!(
            parse_retry_after_ms(Some("Wed, 21 Oct 2015 07:28:00 GMT")),
            None
        );
    }

    #[test]
    fn extract_message_content_trims_and_handles_missing() {
        let data = json!({ "choices": [{ "message": { "content": "  hi  " } }] });
        assert_eq!(extract_message_content(&data), "hi");

        let empty = json!({ "choices": [] });
        assert_eq!(extract_message_content(&empty), "");
    }

    #[test]
    fn drain_complete_lines_keeps_partial_remainder() {
        let mut buffer = b"data: a\ndata: b".to_vec();
        let lines = drain_complete_lines(&mut buffer);
        assert_eq!(lines, vec!["data: a".to_string()]);
        assert_eq!(buffer, b"data: b"); // incomplete line kept for the next chunk
    }

    #[test]
    fn drain_complete_lines_reassembles_multibyte_split_across_chunks() {
        // A 3-byte Hangul char is split mid-sequence between two chunks. Decoding
        // per-chunk would corrupt it; the byte buffer must reassemble it intact.
        let line = r#"data: {"choices":[{"delta":{"content":"안녕하세요"}}]}"#;
        let mut full = line.as_bytes().to_vec();
        full.push(b'\n');
        let split = line.find('안').unwrap() + 1; // 1 byte into the 3-byte '안'

        let mut buffer: Vec<u8> = Vec::new();
        buffer.extend_from_slice(&full[..split]);
        assert!(drain_complete_lines(&mut buffer).is_empty()); // no newline yet

        buffer.extend_from_slice(&full[split..]);
        let lines = drain_complete_lines(&mut buffer);
        assert_eq!(lines.len(), 1);
        assert_eq!(
            parse_sse_line(&lines[0]),
            SseEvent::Delta("안녕하세요".to_string())
        );
        assert!(buffer.is_empty());
    }
}
