use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, USER_AGENT};
use reqwest::{Method, StatusCode};
use serde_json::Value;

use crate::agent::protocol::{self, code, AgentError, AgentResult, AGENT_VERSION};

pub const MAX_RESPONSE_BYTES: usize = 1_048_576;
/// 任务空间快照按整仓累计，多任务项目轻易超过 1 MiB，单独放宽。
pub const MAX_SNAPSHOT_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_SSE_BUFFER_BYTES: usize = 1_048_576;
const MAX_SSE_FRAME_BYTES: usize = 1_048_576;
const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RETRY_AFTER_MS: u64 = 300_000;

/// 本机和局域网服务不能被用户级 HTTP_PROXY 截走；公网地址仍沿用代理。
pub(crate) fn bypass_proxy_for_server(server_url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(server_url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || first & 0xfe00 == 0xfc00
                || first & 0xffc0 == 0xfe80
        }
        Err(_) => false,
    }
}

pub struct ApiClient {
    base_url: String,
    credential: Option<String>,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(
        server_url: &str,
        credential: Option<String>,
        ca_file: Option<&Path>,
    ) -> AgentResult<Self> {
        let base_url = protocol::normalize_server_url(server_url)?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none());
        if bypass_proxy_for_server(&base_url) {
            builder = builder.no_proxy();
        }
        if let Some(path) = ca_file.filter(|path| !path.as_os_str().is_empty()) {
            let pem = load_ca_file(path)?;
            for certificate in reqwest::Certificate::from_pem_bundle(&pem).map_err(|error| {
                AgentError::new(code::CA_FILE_INVALID, format!("CA 证书解析失败: {error}"))
            })? {
                builder = builder.add_root_certificate(certificate);
            }
        }
        let http = builder.build().map_err(|error| {
            AgentError::new(code::HTTP_ERROR, format!("HTTP 客户端初始化失败: {error}"))
        })?;
        Ok(Self {
            base_url,
            credential,
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub async fn request_json(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> AgentResult<Value> {
        self.request_json_limited(method, path, body, timeout, MAX_RESPONSE_BYTES)
            .await
    }

    pub async fn request_json_limited(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        max_bytes: usize,
    ) -> AgentResult<Value> {
        let trace = std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some();
        let started = Instant::now();
        let url = format!("{}{}", self.base_url, path);
        let mut request = self
            .http
            .request(method.clone(), &url)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, format!("trellis-board-agent/{AGENT_VERSION}"))
            .timeout(timeout);
        if method != Method::GET && method != Method::HEAD {
            request = request.header(CONTENT_TYPE, "application/json");
        }
        if let Some(credential) = &self.credential {
            request = request.header(AUTHORIZATION, format!("Bearer {credential}"));
        }
        let body_bytes = body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|error| {
                AgentError::new(code::INVALID_RESPONSE, format!("请求体序列化失败: {error}"))
            })?;
        if let Some(request_body) = body_bytes.clone() {
            request = request.body(request_body);
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        let retry_after_ms = parse_retry_after(response.headers().get("retry-after"));
        let bytes = read_limited(response, max_bytes).await?;
        if trace {
            crate::logging::warn(&format!(
                "HTTP 请求 {} {} status={} requestBytes={} responseBytes={} elapsedMs={}",
                method,
                path,
                status.as_u16(),
                body_bytes.as_ref().map_or(0, Vec::len),
                bytes.len(),
                started.elapsed().as_millis()
            ));
        }
        let payload: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|error| {
                AgentError::new(
                    code::INVALID_RESPONSE,
                    format!("服务端返回了无法解析的响应: {error}"),
                )
                .with_status(status.as_u16())
            })?
        };
        if status.is_success() {
            return Ok(payload);
        }
        Err(map_server_error(status, &payload, retry_after_ms))
    }

    pub async fn stream_events<F>(
        &self,
        last_event_id: Option<&str>,
        mut handler: F,
    ) -> AgentResult<()>
    where
        F: FnMut(SseFrame) -> AgentResult<()>,
    {
        let url = format!("{}/api/agent/events", self.base_url);
        let mut request = self
            .http
            .get(&url)
            .header(ACCEPT, "text/event-stream")
            .header(CACHE_CONTROL, "no-cache");
        if let Some(credential) = &self.credential {
            request = request.header(AUTHORIZATION, format!("Bearer {credential}"));
        }
        if let Some(last_event_id) = last_event_id {
            request = request.header("last-event-id", last_event_id);
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        if !status.is_success() {
            let retry_after_ms = parse_retry_after(response.headers().get("retry-after"));
            let bytes = read_limited(response, MAX_RESPONSE_BYTES).await?;
            let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return Err(map_server_error(status, &payload, retry_after_ms));
        }

        if std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some() {
            crate::logging::warn("SSE 已连接 /api/agent/events");
        }
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        loop {
            let chunk = match tokio::time::timeout(SSE_IDLE_TIMEOUT, stream.next()).await {
                Ok(Some(result)) => result.map_err(network_error)?,
                Ok(None) => return protocol::err(code::NETWORK_ERROR, "服务端事件流已关闭"),
                Err(_) => return protocol::err(code::NETWORK_ERROR, "服务端事件流空闲超时"),
            };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            if buffer.len() > MAX_SSE_BUFFER_BYTES {
                return protocol::err(code::INVALID_RESPONSE, "服务端事件流缓冲溢出");
            }
            while let Some(index) = buffer.find("\n\n") {
                let frame_text: String = buffer.drain(..index + 2).collect();
                let normalized = frame_text.replace("\r\n", "\n").replace('\r', "\n");
                if let Some(frame) = parse_frame(&normalized)? {
                    handler(frame)?;
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: Value,
    pub retry_ms: Option<u64>,
}

fn parse_frame(text: &str) -> AgentResult<Option<SseFrame>> {
    if text.len() > MAX_SSE_FRAME_BYTES {
        return protocol::err(code::INVALID_RESPONSE, "服务端事件帧超过大小限制");
    }
    let mut id = None;
    let mut event = None;
    let mut retry_ms = None;
    let mut data = Vec::new();
    for line in text.lines() {
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "id" => id = Some(value.to_string()),
            "event" => event = Some(value.to_string()),
            "retry" => retry_ms = value.parse::<u64>().ok(),
            "data" => data.push(value.to_string()),
            _ => {}
        }
    }
    if data.is_empty() {
        return Ok(None);
    }
    let joined = data.join("\n");
    let parsed = serde_json::from_str(&joined).unwrap_or(Value::String(joined));
    Ok(Some(SseFrame {
        id,
        event,
        data: parsed,
        retry_ms,
    }))
}

fn load_ca_file(path: &Path) -> AgentResult<Vec<u8>> {
    if !path.is_absolute() {
        return protocol::err(code::CA_FILE_INVALID, "CA 证书路径必须是绝对路径");
    }
    let contents = std::fs::read(path).map_err(|error| {
        AgentError::new(code::CA_FILE_INVALID, format!("无法读取 CA 证书: {error}"))
    })?;
    if !String::from_utf8_lossy(&contents).contains("-----BEGIN CERTIFICATE-----") {
        return protocol::err(code::CA_FILE_INVALID, "CA 证书文件内容无效");
    }
    Ok(contents)
}

fn network_error(error: reqwest::Error) -> AgentError {
    if error.is_timeout() {
        return AgentError::new(code::NETWORK_ERROR, "请求服务端超时").retryable(true);
    }
    AgentError::new(code::NETWORK_ERROR, format!("无法连接服务端: {error}")).retryable(true)
}

async fn read_limited(response: reqwest::Response, max_bytes: usize) -> AgentResult<Vec<u8>> {
    let mut stream = response.bytes_stream();
    let mut collected = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if collected.len() + chunk.len() > max_bytes {
            return protocol::err(code::INVALID_RESPONSE, "服务端响应超过大小限制");
        }
        collected.extend_from_slice(&chunk);
    }
    Ok(collected)
}

fn parse_retry_after(value: Option<&reqwest::header::HeaderValue>) -> Option<u64> {
    let text = value?.to_str().ok()?.trim().to_string();
    if let Ok(seconds) = text.parse::<u64>() {
        return Some((seconds * 1000).min(MAX_RETRY_AFTER_MS));
    }
    None
}

fn map_server_error(
    status: StatusCode,
    payload: &Value,
    retry_after_ms: Option<u64>,
) -> AgentError {
    let server_code = payload
        .get("code")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_default();
    let message = payload
        .get("error")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("服务端返回 HTTP {}", status.as_u16()));

    let mut error = AgentError::new(code::HTTP_ERROR, message)
        .with_status(status.as_u16())
        .with_server_code(Some(server_code.clone()));
    if let Some(conflict_id) = payload.get("conflictId").and_then(Value::as_str) {
        error = error.with_conflict(Some(conflict_id.to_string()));
    }
    if let Some(details) = payload.get("details") {
        error = error.with_details(Some(details.clone()));
    }
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        || server_code == code::AUTH_REVOKED
    {
        error.code = code::AUTH_REVOKED.to_string();
        error.terminal = true;
        return error;
    }
    if server_code == "AGENT_PROTOCOL_UNSUPPORTED" || status == StatusCode::UPGRADE_REQUIRED {
        error.code = code::PROTOCOL_INCOMPATIBLE.to_string();
        error.terminal = true;
        return error;
    }
    if server_code == "DESKTOP_TOKEN_INVALID" {
        error.terminal = true;
        return error;
    }
    if status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_EARLY
        || status.is_server_error()
    {
        error.retryable = true;
        error.retry_after_ms = retry_after_ms;
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_sse_frames() {
        let frame = parse_frame("id: 12\nevent: command\ndata: {\"a\":1}\n\n")
            .expect("frame")
            .expect("some");
        assert_eq!(frame.id.as_deref(), Some("12"));
        assert_eq!(frame.event.as_deref(), Some("command"));
        assert_eq!(frame.data["a"], 1);
    }

    #[test]
    fn maps_auth_errors_to_terminal() {
        let error = map_server_error(StatusCode::UNAUTHORIZED, &json!({"message":"nope"}), None);
        assert_eq!(error.code, code::AUTH_REVOKED);
        assert!(error.terminal);
    }

    #[test]
    fn maps_server_errors_to_retryable() {
        let error = map_server_error(StatusCode::BAD_GATEWAY, &json!({}), Some(1500));
        assert!(error.retryable);
        assert_eq!(error.retry_after_ms, Some(1500));
    }

    #[test]
    fn keeps_team_error_message_and_details() {
        // 服务端 Team 错误体是 {error, code, details}，消息必须原样保留给用户。
        let error = map_server_error(
            StatusCode::CONFLICT,
            &json!({
                "error": "clientSequence 必须严格递增",
                "code": "CONFLICT",
                "details": { "requiredClientSequence": 1712345678900u64 }
            }),
            None,
        );
        assert_eq!(error.server_code.as_deref(), Some("CONFLICT"));
        assert_eq!(error.message, "clientSequence 必须严格递增");
        assert!(error.details.is_some());
    }

    #[test]
    fn bypasses_proxy_only_for_local_and_private_servers() {
        for url in [
            "http://localhost:4317",
            "http://agent.local:4317",
            "http://127.0.0.1:4317",
            "http://10.1.2.3:4317",
            "http://172.16.0.1:4317",
            "http://172.31.255.254:4317",
            "http://192.168.65.27:4317",
            "http://169.254.1.1:4317",
            "http://[::1]:4317",
            "http://[fd00::1]:4317",
            "http://[fe80::1]:4317",
        ] {
            assert!(bypass_proxy_for_server(url), "{url}");
        }
        for url in [
            "http://172.32.0.1:4317",
            "https://board.example.com",
            "http://8.8.8.8:4317",
        ] {
            assert!(!bypass_proxy_for_server(url), "{url}");
        }
    }
}
