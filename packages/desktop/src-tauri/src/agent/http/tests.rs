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
fn keeps_scoped_forbidden_as_directory_error() {
    // 目录级 403 不是凭证失效：同步层要靠 server_code 判断“他人任务只读跳过”。
    let error = map_server_error(
        StatusCode::FORBIDDEN,
        &json!({"error": "只能读取本人任务内容", "code": "FORBIDDEN"}),
        None,
    );
    assert_ne!(error.code, code::AUTH_REVOKED);
    assert!(!error.terminal);
    assert_eq!(error.status, Some(403));
    assert_eq!(error.server_code.as_deref(), Some("FORBIDDEN"));
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
