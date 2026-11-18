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
