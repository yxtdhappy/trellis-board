use super::*;

#[test]
fn maps_tool_ids_to_init_flags() {
    let tools = vec![
        "cursor".to_string(),
        "pi".to_string(),
        "unknown-tool".to_string(),
    ];
    assert_eq!(
        trellis_agent_tool_flags(&tools),
        vec!["--cursor", "--pi", "--pi-presence", "all"]
    );
    assert!(trellis_agent_tool_flags(&[]).is_empty());
    assert_eq!(
        trellis_agent_tool_flags(&["claude-code".to_string()]),
        vec!["--claude"]
    );
}

#[test]
fn builds_init_arguments_in_order() {
    let tools = vec!["codex".to_string(), "snow".to_string()];
    assert_eq!(
        init_args(Path::new(r"C:\runtime\trellis.js"), "dev-1", &tools),
        vec![
            r"C:\runtime\trellis.js".to_string(),
            "init".to_string(),
            "-y".to_string(),
            "--skip-existing".to_string(),
            "-u".to_string(),
            "dev-1".to_string(),
            "--codex".to_string(),
            "--snow".to_string(),
        ]
    );
}

#[test]
fn builds_agent_only_helper_arguments() {
    let tools = vec!["codex".to_string(), "snow".to_string()];
    assert_eq!(
        agent_only_args(
            Path::new(r"C:\runtime\trellis.js"),
            Path::new(r"C:\repo"),
            &tools
        ),
        vec![
            "--input-type=module".to_string(),
            "-".to_string(),
            r"C:\runtime\trellis.js".to_string(),
            r"C:\repo".to_string(),
            "codex".to_string(),
            "snow".to_string(),
        ]
    );
}

#[test]
fn agent_only_helper_uses_trellis_configurators() {
    assert!(AGENT_ONLY_INIT_HELPER.contains("resolveSupportedPython"));
    assert!(AGENT_ONLY_INIT_HELPER.contains("PLATFORM_IDS"));
    assert!(AGENT_ONLY_INIT_HELPER.contains("configurePlatform"));
    assert!(AGENT_ONLY_INIT_HELPER.contains("setWriteMode(\"skip\")"));
    assert!(AGENT_ONLY_INIT_HELPER.contains("initializeHashes"));
    assert!(!AGENT_ONLY_INIT_HELPER.contains(".trellis/spec"));
}

#[test]
fn maps_agent_only_pi_exdev_failure() {
    let root =
        std::env::temp_dir().join(format!("trellis-cli-failure-{}", uuid::Uuid::new_v4()));
    let output = ProcessOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: "configure failed".to_string(),
    };
    let error = trellis_failure(
        &root,
        &["codex".to_string()],
        &output,
        "Trellis Agent 配置失败",
    );
    assert!(error.message.starts_with("Trellis Agent 配置失败："));

    std::fs::create_dir_all(root.join(".pi").join("extensions").join("trellis")).unwrap();
    let output = ProcessOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: "EXDEV: cross-device link not permitted".to_string(),
    };
    let error = trellis_failure(
        &root,
        &["pi".to_string()],
        &output,
        "Trellis Agent 配置失败",
    );
    assert!(error.message.starts_with("Pi 模板补齐失败："));
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("piRepairRequired"))
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn detects_tools_from_repository_markers() {
    let root =
        std::env::temp_dir().join(format!("trellis-cli-detect-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".cursor")).unwrap();
    std::fs::create_dir_all(root.join(".pi").join("extensions").join("trellis")).unwrap();
    std::fs::write(
        root.join(".pi")
            .join("extensions")
            .join("trellis")
            .join("index.ts"),
        "",
    )
    .unwrap();
    assert_eq!(detect_agent_tools(&root).await, vec!["cursor".to_string()]);
    std::fs::write(root.join(".pi").join("settings.json"), "{}").unwrap();
    assert_eq!(
        detect_agent_tools(&root).await,
        vec!["cursor".to_string(), "pi".to_string()]
    );
    std::fs::remove_dir_all(&root).unwrap();
}

fn temp_repo(label: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("trellis-cli-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".trellis")).unwrap();
    root
}

#[test]
fn both_successful_init_paths_use_shared_cleanup() {
    let source = include_str!("../trellis_cli.rs");
    assert_eq!(source.matches("finish_init(repo_path, Ok(()))").count(), 2);
}

#[tokio::test]
async fn successful_init_removes_only_pycache_template_hashes() {
    let root = temp_repo("hash-cleanup");
    let pyc_path = root
        .join(".trellis")
        .join("__pycache__")
        .join("module.cpython-311.pyc");
    std::fs::create_dir_all(pyc_path.parent().unwrap()).unwrap();
    std::fs::write(&pyc_path, b"bytecode").unwrap();
    let manifest_path = root.join(".trellis").join(".template-hashes.json");
    std::fs::write(
        &manifest_path,
        r#"{
  "__version": 2,
  "custom": {"untouched": true},
  "hashes": {
    ".trellis/spec/keep.md": "keep-value",
    ".trellis/__pycache__/module.cpython-311.pyc": "drop-pycache",
    ".trellis/scripts/tool.pyc": "drop-pyc",
    ".trellis/__pycachex__/keep.txt": "keep-near-match",
    ".trellis\\scripts\\__pycache__\\win.pyc": "drop-windows-key"
  }
}
"#,
    )
    .unwrap();

    finish_init(&root, Ok(())).await.unwrap();

    let updated: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(
        updated.get("__version").and_then(serde_json::Value::as_u64),
        Some(2)
    );
    assert_eq!(
        updated
            .pointer("/custom/untouched")
            .and_then(serde_json::Value::as_bool),
        Some(true)
    );
    let hashes = updated
        .get("hashes")
        .and_then(serde_json::Value::as_object)
        .unwrap();
    assert_eq!(hashes.len(), 2);
    assert_eq!(
        hashes
            .get(".trellis/spec/keep.md")
            .and_then(serde_json::Value::as_str),
        Some("keep-value")
    );
    assert_eq!(
        hashes
            .get(".trellis/__pycachex__/keep.txt")
            .and_then(serde_json::Value::as_str),
        Some("keep-near-match")
    );
    assert!(pyc_path.exists());
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn invalid_manifest_fails_without_rewriting() {
    let root = temp_repo("invalid-manifest");
    let manifest_path = root.join(".trellis").join(".template-hashes.json");
    let original = b"{ invalid json";
    std::fs::write(&manifest_path, original).unwrap();

    assert!(cleanup_template_hashes(&root).await.is_err());
    assert_eq!(
        std::fs::read(&manifest_path).unwrap().as_slice(),
        original.as_slice()
    );

    let original = br#"{"__version":2}"#;
    std::fs::write(&manifest_path, original).unwrap();
    assert!(cleanup_template_hashes(&root).await.is_err());
    assert_eq!(
        std::fs::read(&manifest_path).unwrap().as_slice(),
        original.as_slice()
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn successful_init_downgrades_cleanup_errors() {
    let root = temp_repo("cleanup-downgrade");
    let manifest_path = root.join(".trellis").join(".template-hashes.json");
    let original = b"{ invalid json";
    std::fs::write(&manifest_path, original).unwrap();

    let result = finish_init(&root, Ok(())).await;

    assert!(result.is_ok());
    assert_eq!(
        std::fs::read(&manifest_path).unwrap().as_slice(),
        original.as_slice()
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn failed_init_does_not_clean_manifest() {
    let root = temp_repo("failed-init");
    let manifest_path = root.join(".trellis").join(".template-hashes.json");
    let original = br#"{"hashes":{".trellis/__pycache__/x.pyc":"stale"}}"#;
    std::fs::write(&manifest_path, original).unwrap();
    let result = finish_init(
        &root,
        Err(AgentError::new(code::GIT_FAILED, "原始初始化错误")),
    )
    .await;

    assert_eq!(result.unwrap_err().message, "原始初始化错误");
    assert_eq!(
        std::fs::read(&manifest_path).unwrap().as_slice(),
        original.as_slice()
    );
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn manifest_without_target_hashes_is_not_rewritten() {
    let root = temp_repo("no-target");
    let manifest_path = root.join(".trellis").join(".template-hashes.json");
    let original = br#"{
  "hashes": {".trellis/spec/keep.md":"keep-value"}
}"#;
    std::fs::write(&manifest_path, original).unwrap();

    cleanup_template_hashes(&root).await.unwrap();

    assert_eq!(
        std::fs::read(&manifest_path).unwrap().as_slice(),
        original.as_slice()
    );
    std::fs::remove_dir_all(&root).unwrap();
}
