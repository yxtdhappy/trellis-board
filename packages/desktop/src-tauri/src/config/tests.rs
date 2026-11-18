use super::*;

#[test]
fn config_round_trips_with_remembered_credentials() {
    let _env = test_env_lock();
    let directory = std::env::temp_dir().join(format!(
        "trellis-desktop-config-test-{}",
        std::process::id()
    ));
    std::env::set_var("TRELLIS_DESKTOP_HOME", &directory);
    let config = ClientConfig {
        schema_version: SCHEMA_VERSION,
        server_url: "https://board.example.com".to_string(),
        username: Some("admin".to_string()),
        password: Some("secret-password".to_string()),
        node_runtime: None,
        trellis_runtime: None,
    };
    save(&config).expect("save config");
    let loaded = load().expect("load config").expect("config exists");
    assert_eq!(loaded, config);
    let payload = std::fs::read_to_string(config_path()).unwrap();
    assert!(!payload.contains("credential"));
    assert!(payload.contains("secret-password"));
    assert!(!payload.contains("session"));
    std::fs::write(
        config_path(),
        "\u{feff}{\"schemaVersion\":2,\"serverUrl\":\"https://bom.example.com\"}",
    )
    .expect("write BOM config");
    let migrated = load().expect("load BOM config").expect("BOM config exists");
    assert_eq!(migrated.server_url, "https://bom.example.com");
    assert_eq!(migrated.username, None);
    assert_eq!(migrated.password, None);
    std::fs::write(
        config_path(),
        r#"{"schemaVersion":1,"serverUrl":"https://old.example.com"}"#,
    )
    .expect("write old config");
    assert!(load().expect("load config").is_none());
    let _ = std::fs::remove_dir_all(directory);
}
