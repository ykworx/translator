use reqwest::{header::HeaderValue, redirect::Policy, Client};
use serde_json::Value;
use std::time::Duration;

/// Credentials are bound to the provider's fixed origin. Never follow even a
/// same-origin redirect: a future adapter must explicitly own its routing.
pub(crate) fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(60))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "AI 연결을 초기화하지 못했습니다.".to_string())
}

pub(crate) fn sensitive_header(value: &str) -> Result<HeaderValue, String> {
    let mut header = HeaderValue::from_str(value)
        .map_err(|_| "API 키 형식이 올바르지 않습니다. 키를 다시 저장해주세요.".to_string())?;
    header.set_sensitive(true);
    Ok(header)
}

/// Provider errors can echo request data. Return only the parsed message, with
/// the active credential removed, and never include raw HTML or request URLs.
pub(crate) fn api_error(provider: &str, status: u16, body: &str, secret: &str) -> String {
    let category = match status {
        401 => "인증 실패: API 키를 확인해주세요",
        403 => "접근 권한이 없습니다. 키와 프로젝트 권한을 확인해주세요",
        429 => "요청 한도 또는 할당량을 확인해주세요",
        300..=399 => "서버 주소가 변경되었습니다. 자동으로 다른 주소에 연결하지 않습니다",
        500..=599 => "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요",
        _ => "요청을 처리하지 못했습니다",
    };
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|data| {
            data.get("error")?
                .get("message")?
                .as_str()
                .map(str::to_owned)
        })
        .map(|text| {
            if secret.is_empty() {
                text
            } else {
                text.replace(secret, "[redacted]")
            }
        })
        .map(|text| text.chars().take(400).collect::<String>())
        .unwrap_or_default();
    if message.is_empty() {
        format!("{provider} API error: {status} — {category}")
    } else {
        format!("{provider} API error: {status} — {category}. {message}")
    }
}

pub(crate) fn network_error(provider: &str, error: reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "응답 시간이 초과되었습니다"
    } else if error.is_connect() {
        "서버에 연결할 수 없습니다"
    } else {
        "통신 중 오류가 발생했습니다"
    };
    format!("{provider}: {kind}. 다시 시도해주세요.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_redact_credentials_after_json_unescaping_and_omit_raw_bodies() {
        let secret = "fake-\"private\"-key";
        let body =
            serde_json::json!({"error": {"message": format!("Invalid key {secret}")}}).to_string();
        let error = api_error("Gemini", 401, &body, secret);
        assert!(!error.contains(secret));
        assert!(error.contains("[redacted]"));
        assert!(
            !api_error("OpenAI", 502, "<html>request headers</html>", secret).contains("<html>")
        );
    }

    #[test]
    fn sensitive_headers_reject_line_breaks_and_hide_debug_values() {
        let header = sensitive_header("fake-private-key").unwrap();
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains("fake-private-key"));
        assert!(sensitive_header("key\nother-header: value").is_err());
    }

    #[test]
    fn errors_distinguish_auth_quota_and_redirects() {
        assert!(api_error("OpenAI", 401, "", "").contains("인증 실패"));
        assert!(api_error("OpenAI", 429, "", "").contains("할당량"));
        assert!(api_error("Gemini", 307, "", "").contains("자동으로 다른 주소"));
    }

    #[test]
    fn redirects_do_not_send_credentials_to_a_second_server() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let first = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = first.local_addr().unwrap();
        let location = format!("http://{}/stolen", destination.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = first.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut chunk = [0u8; 1024];
                let count = socket.read(&mut chunk).unwrap();
                assert!(count > 0 && request.len() < 65536);
                request.extend_from_slice(&chunk[..count]);
            }
            assert!(String::from_utf8_lossy(&request).contains("fake-header-secret"));
            write!(socket, "HTTP/1.1 307 Temporary Redirect\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        tauri::async_runtime::block_on(async {
            let response = client()
                .unwrap()
                .post(format!("http://{address}/request"))
                .header(
                    "x-goog-api-key",
                    sensitive_header("fake-header-secret").unwrap(),
                )
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), 307);
        });
        server.join().unwrap();
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
