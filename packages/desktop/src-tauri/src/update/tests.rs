use super::*;

#[test]
fn notification_state_round_trips() {
    let _lock = config::test_env_lock();
    let directory =
        std::env::temp_dir().join(format!("trellis-update-state-{}", uuid::Uuid::new_v4()));
    std::env::set_var("TRELLIS_DESKTOP_HOME", &directory);
    save_last_notified("1.2.3").unwrap();
    assert_eq!(last_notified_version().as_deref(), Some("1.2.3"));
    std::env::remove_var("TRELLIS_DESKTOP_HOME");
    let _ = std::fs::remove_dir_all(directory);
}

#[tokio::test]
async fn fetches_manifest_from_http_server() {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = [
        b"\xEF\xBB\xBF".as_slice(),
        br#"{"version":"9.9.9","file":"TrellisBoard_9.9.9_x64-portable.zip","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size":1,"notes":"test","publishedAt":"2026-11-18T00:00:00Z"}"#.as_slice(),
    ]
    .concat();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let read = socket.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..read]).to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        socket.write_all(&body).unwrap();
        request
    });

    let release = fetch_release(&reqwest::Client::new(), &format!("http://{address}"))
        .await
        .unwrap();
    assert_eq!(release.version, "9.9.9");
    assert_eq!(release.size, 1);
    assert!(server.join().unwrap().contains("GET /latest.json"));
}

#[test]
fn status_uses_camel_case_fields() {
    let status = UpdateStatus {
        enabled: false,
        current_version: "0.4.40".to_string(),
        server: None,
        latest: None,
        update_available: false,
        checked_at: None,
        error: None,
    };
    let value = serde_json::to_value(status).unwrap();
    assert_eq!(value["currentVersion"], "0.4.40");
    assert!(value.get("updateAvailable").is_some());
    assert!(value.get("current_version").is_none());
}

#[test]
fn normalize_server_base_builds_client_updates_url() {
    assert_eq!(
        normalize_server_base("http://10.0.0.12:4317/"),
        Some("http://10.0.0.12:4317/client-updates".to_string())
    );
    assert_eq!(
        normalize_server_base("https://board.internal/login.html?next=/"),
        Some("https://board.internal/client-updates".to_string())
    );
    assert_eq!(
        normalize_server_base("http://[::1]:4317/"),
        Some("http://[::1]:4317/client-updates".to_string())
    );
    assert_eq!(normalize_server_base(""), None);
    assert_eq!(normalize_server_base("ftp://board.internal"), None);
    assert_eq!(normalize_server_base("not-a-url"), None);
}

#[test]
fn effective_base_prefers_compile_time_over_runtime_fallback() {
    assert_eq!(
        resolve_effective_base(
            Some("https://files.internal/updates"),
            Some("https://board.internal/client-updates")
        ),
        Some("https://files.internal/updates".to_string())
    );
    assert_eq!(
        resolve_effective_base(None, Some("https://board.internal/client-updates")),
        Some("https://board.internal/client-updates".to_string())
    );
    assert_eq!(resolve_effective_base(None, None), None);
}

#[tokio::test]
async fn fetches_manifest_from_client_updates_subpath() {
    use std::io::{Read, Write};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = br#"{"version":"0.4.60","file":"TrellisBoard_0.4.60_x64-portable.zip","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size":123}"#;
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0u8; 4096];
        let read = socket.read(&mut request).unwrap();
        let request = String::from_utf8_lossy(&request[..read]).to_string();
        write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        socket.write_all(body).unwrap();
        request
    });

    let base = normalize_server_base(&format!("http://{address}")).unwrap();
    let release = fetch_release(&reqwest::Client::new(), &base).await.unwrap();
    assert_eq!(release.version, "0.4.60");
    assert!(server.join().unwrap().contains("GET /client-updates/latest.json"));
}
