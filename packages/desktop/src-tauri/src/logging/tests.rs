use super::*;

#[test]
fn formats_lines_with_iso_timestamp_and_uppercase_level() {
    let line = format_line("warn", "同步失败\n");
    let stamp = line.split(' ').next().unwrap();
    assert!(
        chrono::DateTime::parse_from_rfc3339(stamp).is_ok(),
        "{line}"
    );
    assert!(stamp.ends_with('Z'), "{line}");
    assert!(line.ends_with(" WARN 同步失败\n"), "{line}");
}

#[test]
fn redacts_tokens_and_secret_fields() {
    assert_eq!(
        redact("authorization: Bearer abc.def.ghi"),
        "authorization: Bearer ***"
    );
    assert_eq!(
        redact(r#"{"credential":"secret-value"}"#),
        r#"{"credential":"***"}"#
    );
    assert_eq!(
        redact(r#"{"pairingCode":"abc123"}"#),
        r#"{"pairingCode":"***"}"#
    );
    assert_eq!(
        redact(r#"{"sessionToken":"abc123"}"#),
        r#"{"sessionToken":"***"}"#
    );
}

fn temp_directory() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("trellis-logging-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn rotates_when_log_reaches_limit() {
    let dir = temp_directory();
    let path = dir.join("desktop.log");
    let line = "x".repeat(1024 * 1024);
    for _ in 0..6 {
        append(&path, &line);
    }
    let current = std::fs::metadata(&path).expect("current log").len();
    let rotated = std::fs::metadata(dir.join("desktop.1.log"))
        .expect("rotated log")
        .len();
    assert!(current < MAX_LOG_BYTES, "{current}");
    assert_eq!(rotated, MAX_LOG_BYTES);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keeps_bounded_history() {
    let dir = temp_directory();
    let path = dir.join("desktop.log");
    std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).expect("current log");
    std::fs::write(dir.join("desktop.1.log"), "old").expect("first history");
    std::fs::write(dir.join("desktop.2.log"), "older").expect("second history");
    rotate_if_needed(&path);
    assert!(!path.exists());
    assert_eq!(
        std::fs::metadata(dir.join("desktop.1.log"))
            .expect("rotated log")
            .len(),
        MAX_LOG_BYTES
    );
    assert_eq!(
        std::fs::read_to_string(dir.join("desktop.2.log")).expect("second history"),
        "old"
    );
    assert!(!dir.join("desktop.3.log").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn ignores_write_failure() {
    let dir = temp_directory();
    let path = dir.join("missing").join("desktop.log");
    append(&path, "line\n");
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}
