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
fn merge_keeps_user_state_and_refreshes_modules() {
    let root = temp_dir("merge");
    let runtime = root.join("runtime");
    let user_dir = root.join("user-plugins");
    let plugins_file = root.join("plugins").join("plugins.json");
    std::fs::create_dir_all(plugins_file.parent().unwrap()).unwrap();
    std::fs::write(
        &plugins_file,
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

    let entries = merge_plugins_file(&plugins_file, &runtime, &user_dir).unwrap();
    assert_eq!(
        entries.enabled,
        vec!["witops-core".to_string(), "custom".to_string()]
    );
    let document: Value = serde_json::from_slice(&std::fs::read(&plugins_file).unwrap()).unwrap();
    let plugins = document["plugins"].as_array().unwrap();
    let witops = plugins
        .iter()
        .find(|entry| entry["id"] == "witops-core")
        .unwrap();
    assert_eq!(witops["enabled"], true);
    assert_eq!(witops["sort"], 5);
    assert_eq!(witops["config"]["x"], 1);
    assert!(witops["module"]
        .as_str()
        .unwrap()
        .replace('\\', "/")
        .ends_with("runtime/plugins/witops-core/index.js"));
    // 用户自建条目保留在末尾。
    assert_eq!(plugins.last().unwrap()["id"], "custom");
    // 新增内置插件默认禁用。
    let accounts = plugins
        .iter()
        .find(|entry| entry["id"] == "accounts-core")
        .unwrap();
    assert_eq!(accounts["enabled"], false);

    let plugin_dir = user_dir.join("accounts-core");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::write(plugin_dir.join("plugin.json"), "{}").unwrap();
    std::fs::write(plugin_dir.join("index.js"), "").unwrap();
    merge_plugins_file(&plugins_file, &runtime, &user_dir).unwrap();
    let document: Value = serde_json::from_slice(&std::fs::read(&plugins_file).unwrap()).unwrap();
    let accounts = document["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["id"] == "accounts-core")
        .unwrap();
    assert_eq!(
        accounts["module"].as_str().unwrap().replace('\\', "/"),
        plugin_dir
            .join("index.js")
            .to_string_lossy()
            .replace('\\', "/")
    );
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
