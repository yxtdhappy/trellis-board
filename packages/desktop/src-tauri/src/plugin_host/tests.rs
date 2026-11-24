use std::path::Path;

use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "trellis-plugin-host-{label}-{}",
        uuid::Uuid::new_v4().simple()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn server_hash_is_stable_and_ignores_trailing_slash() {
    let left = server_hash("https://board.example.com/");
    let right = server_hash("https://board.example.com");
    assert_eq!(left, right);
    assert_eq!(left.len(), 16);
    assert_ne!(left, server_hash("https://other.example.com"));
}

#[test]
fn user_key_is_filesystem_safe() {
    let key = user_key("张三/../CEO");
    assert!(!key.contains('/'));
    assert!(!key.contains(".."));
    assert!(key.starts_with("____"));
    assert_ne!(user_key("a b"), user_key("a_b"));
    assert_eq!(user_key(""), "anonymous-e3b0c442");
}

#[test]
fn scope_dir_isolates_by_server_and_user() {
    let root = Path::new("C:/data");
    let first = scope_dir(root, "https://a.example.com", "alice");
    let second = scope_dir(root, "https://b.example.com", "alice");
    let third = scope_dir(root, "https://a.example.com", "bob");
    assert_ne!(first, second);
    assert_ne!(first, third);
    assert!(first.starts_with(root.join("desktop-plugins")));
}

#[test]
fn state_file_migrates_legacy_plugins_json_and_keeps_minimal_fields() {
    let root = temp_dir("merge");
    let legacy_file = root.join("plugins").join("plugins.json");
    let state_file = root.join("plugin-state.json");
    std::fs::create_dir_all(legacy_file.parent().unwrap()).unwrap();
    std::fs::write(
        &legacy_file,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "plugins": [
                { "id": "witops-core", "enabled": true, "sort": 5, "config": { "x": 1 } },
                { "id": "custom", "module": "./custom/index.js", "enabled": true }
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let entries = ensure_state_file(&root, &state_file).unwrap();
    assert_eq!(
        entries.enabled,
        vec!["witops-core".to_string(), "custom".to_string()]
    );
    // 旧 plugins.json 被迁移改名，不再重新生成 plugins/plugins.json。
    assert!(!legacy_file.exists());
    assert!(root.join("plugins").join("plugins.json.migrated").is_file());

    let document: Value = serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
    let plugins = document["plugins"].as_array().unwrap();
    let witops = plugins
        .iter()
        .find(|entry| entry["id"] == "witops-core")
        .unwrap();
    assert_eq!(witops["enabled"], true);
    assert_eq!(witops["sort"], 5);
    assert!(witops.get("config").is_none());
    assert!(witops.get("module").is_none());
    // 用户自建条目保留在末尾。
    assert_eq!(plugins.last().unwrap()["id"], "custom");
    // 新增内置插件默认禁用。
    let accounts = plugins
        .iter()
        .find(|entry| entry["id"] == "accounts-core")
        .unwrap();
    assert_eq!(accounts["enabled"], false);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn embedded_assets_cover_host_and_builtin_plugins() {
    let names = assets::asset_names();
    assert!(names.contains(&"host.mjs"));
    assert!(names.contains(&"node_modules/@trellis-board/server/plugins/runtime.js"));
    assert!(names.contains(&"node_modules/@trellis-board/shared/slug.js"));
    assert!(names.contains(&"plugin-ui/v1/bridge.js"));
    for plugin in [
        "witops-core",
        "scenario-copilot",
        "jenkins-ops",
        "accounts-core",
        "acp-dispatch",
        "a2a-intake",
    ] {
        assert!(
            names.contains(&format!("plugins/{plugin}/plugin.json").as_str()),
            "缺少内置插件 {plugin}"
        );
        assert!(
            names.contains(&format!("plugins/{plugin}/index.js").as_str()),
            "缺少内置插件入口 {plugin}"
        );
    }
    assert!(!names.iter().any(|name| name.contains("/test/")));
}

#[test]
fn runtime_assets_extract_once() {
    let root = temp_dir("assets");
    let first = assets::ensure_runtime(&root).unwrap();
    assert!(first.join("host.mjs").is_file());
    assert!(first.join(".complete").is_file());
    let second = assets::ensure_runtime(&root).unwrap();
    assert_eq!(first, second);
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn secrets_roundtrip_uses_dpapi() {
    let payload = br#"{"version":1,"refs":{"demo/token":"secret"}}"#;
    let record = protect_secrets(payload).unwrap();
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(record["ciphertext"].as_str().unwrap())
        .unwrap();
    let plaintext = dpapi_unprotect(&ciphertext).unwrap();
    assert_eq!(plaintext, payload);
}
