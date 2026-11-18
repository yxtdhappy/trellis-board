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
        python_runtime: None,
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

#[test]
fn load_keeps_runtime_flags_without_server_url() {
    let _env = test_env_lock();
    let directory = std::env::temp_dir().join(format!(
        "trellis-desktop-config-flags-{}",
        std::process::id()
    ));
    std::env::set_var("TRELLIS_DESKTOP_HOME", &directory);
    std::fs::create_dir_all(&directory).expect("create config dir");
    std::fs::write(
        config_path(),
        r#"{
  "schemaVersion": 3,
  "node_runtime": {"version": "24.13.0", "path": "C:\\Program Files\\nodejs\\node.exe", "source": "path", "installed_at": "2026-11-18T00:00:00Z"},
  "trellis_runtime": {"version": "0.6.17", "cli_path": "C:\\data\\trellis.js", "source": "global", "installed_at": "2026-11-18T00:00:00Z"},
  "python_runtime": {"version": "3.14.3", "path": "C:\\Python314\\python.exe", "source": "path", "installed_at": "2026-11-18T00:00:00Z"}
}"#,
    )
    .expect("write runtime-only config");

    let loaded = load()
        .expect("load runtime-only config")
        .expect("config exists");
    assert_eq!(loaded.server_url, "");
    assert!(loaded.username.is_none());
    assert!(loaded.password.is_none());
    let node: crate::agent::env::NodeRuntimeFlag =
        serde_json::from_value(loaded.node_runtime.clone().expect("node flag")).expect("node");
    assert_eq!(node.version, "24.13.0");
    let trellis: crate::agent::env::TrellisRuntimeFlag =
        serde_json::from_value(loaded.trellis_runtime.clone().expect("trellis flag"))
            .expect("trellis");
    assert_eq!(trellis.version, "0.6.17");
    let python: crate::agent::env::PythonRuntimeFlag =
        serde_json::from_value(loaded.python_runtime.clone().expect("python flag"))
            .expect("python");
    assert_eq!(python.version, "3.14.3");

    save(&loaded).expect("save runtime-only config");
    let reloaded = load()
        .expect("reload runtime-only config")
        .expect("config exists");
    assert!(reloaded.node_runtime.is_some());
    assert!(reloaded.trellis_runtime.is_some());
    assert!(reloaded.python_runtime.is_some());
    let _ = std::fs::remove_dir_all(directory);
}


