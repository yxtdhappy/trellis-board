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
        vec!["--cursor", "--pi"]
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

fn temp_root(label: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("trellis-cli-{label}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn exdev_output(stderr: &str) -> ProcessOutput {
    ProcessOutput {
        exit_code: 1,
        stdout: String::new(),
        stderr: stderr.to_string(),
    }
}

#[test]
fn selects_repair_platforms_in_fixed_order() {
    assert_eq!(
        selected_repair_platforms(&["omp".to_string(), "pi".to_string()]),
        vec!["pi".to_string(), "omp".to_string()]
    );
    assert_eq!(selected_repair_platforms(&[" pi ".to_string()]), vec!["pi".to_string()]);
    assert!(selected_repair_platforms(&["codex".to_string()]).is_empty());
    assert!(selected_repair_platforms(&[]).is_empty());
}

#[test]
fn normalizes_bare_drive_root() {
    let normalized = normalize_repo_root(Path::new("D:"));
    if cfg!(windows) {
        assert_eq!(normalized, PathBuf::from("D:\\"));
    } else {
        assert_eq!(normalized, PathBuf::from("D:"));
    }

    let normal = Path::new(r"D:\projects\demo");
    assert_eq!(normalize_repo_root(normal), normal);
}

#[test]
fn detects_pi_repair_signature_from_output_and_directory() {
    let root = temp_root("repair-pi");
    let pi_tools = vec!["pi".to_string()];
    let bare_output = exdev_output("EXDEV: cross-device link not permitted");
    assert!(repair_platforms_for_failure(&root, &pi_tools, &bare_output).is_empty());

    let output = exdev_output("EXDEV: rename .pi/extensions/trellis/index.ts");
    assert_eq!(repair_platforms_for_failure(&root, &pi_tools, &output), vec!["pi".to_string()]);

    let output = exdev_output("EXDEV: rename .pi\\extensions\\trellis\\index.ts");
    assert_eq!(repair_platforms_for_failure(&root, &pi_tools, &output), vec!["pi".to_string()]);

    std::fs::create_dir_all(root.join(".pi").join("extensions").join("trellis")).unwrap();
    assert_eq!(
        repair_platforms_for_failure(&root, &pi_tools, &bare_output),
        vec!["pi".to_string()]
    );

    let codex_tools = vec!["codex".to_string()];
    assert!(repair_platforms_for_failure(&root, &codex_tools, &bare_output).is_empty());
    let other_error = exdev_output("EPERM: operation not permitted");
    assert!(repair_platforms_for_failure(&root, &pi_tools, &other_error).is_empty());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn detects_omp_output_signature_without_existing_directory() {
    let root = temp_root("repair-omp");
    let output = exdev_output("EXDEV: rename .omp/extensions/trellis/index.ts");
    let omp_tools = vec!["omp".to_string()];
    assert_eq!(repair_platforms_for_failure(&root, &omp_tools, &output), vec!["omp".to_string()]);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn repairs_both_selected_platforms_on_any_signature() {
    let root = temp_root("repair-both");
    let tools = vec!["pi".to_string(), "omp".to_string()];
    let output = exdev_output("EXDEV: rename .pi/extensions/trellis/index.ts");
    assert_eq!(
        repair_platforms_for_failure(&root, &tools, &output),
        vec!["pi".to_string(), "omp".to_string()]
    );

    // 未选中平台的签名不触发补齐。
    let omp_only = exdev_output("EXDEV: rename .omp/extensions/trellis/index.ts");
    let pi_tools = vec!["pi".to_string()];
    assert!(repair_platforms_for_failure(&root, &pi_tools, &omp_only).is_empty());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn builds_repair_helper_arguments() {
    assert_eq!(
        repair_helper_args(
            Path::new(r"C:\runtime\trellis.js"),
            Path::new(r"C:\repo"),
            "repair",
            &["pi".to_string(), "omp".to_string()],
        ),
        vec![
            "--input-type=module".to_string(),
            "-".to_string(),
            r"C:\runtime\trellis.js".to_string(),
            r"C:\repo".to_string(),
            "repair".to_string(),
            "pi".to_string(),
            "omp".to_string(),
        ]
    );
    assert_eq!(
        hash_helper_args(
            Path::new(r"C:\runtime\trellis.js"),
            Path::new(r"C:\repo"),
            r#"{"platforms":["pi"],"missing":["a.md"]}"#,
        ),
        vec![
            "--input-type=module".to_string(),
            "-".to_string(),
            r"C:\runtime\trellis.js".to_string(),
            r"C:\repo".to_string(),
            "hash".to_string(),
            r#"{"platforms":["pi"],"missing":["a.md"]}"#.to_string(),
        ]
    );
}

#[test]
fn parses_snapshot_missing_paths_from_last_json_line() {
    assert_eq!(
        parse_snapshot_missing_paths(
            "noise\n{\"missing\":[\".pi/settings.json\"],\"existing\":[\".pi/a.md\"]}\n",
        ),
        vec![".pi/settings.json".to_string()]
    );
    assert!(parse_snapshot_missing_paths("").is_empty());
    assert!(parse_snapshot_missing_paths("not json").is_empty());
    assert!(parse_snapshot_missing_paths("{\"missing\":\"bad\"}").is_empty());
}

#[test]
fn repair_and_retry_failures_are_actionable() {
    let tools = vec!["pi".to_string(), "omp".to_string()];
    let output = exdev_output("helper failed");

    let repair = repair_failure(&tools, &["pi".to_string(), "omp".to_string()], &output);
    assert!(repair.message.starts_with("Pi/OMP 模板补齐失败："));
    let details = repair.details.as_ref().unwrap();
    assert_eq!(details.get("repairFailed").and_then(serde_json::Value::as_bool), Some(true));
    assert_eq!(details.get("repairPlatforms"), Some(&serde_json::json!(["pi", "omp"])));
    assert!(details.get("repoPath").is_none());

    let omp_repair = repair_failure(&tools, &["omp".to_string()], &output);
    assert!(omp_repair.message.starts_with("OMP 模板补齐失败："));
    let pi_repair = repair_failure(&tools, &["pi".to_string()], &output);
    assert!(pi_repair.message.starts_with("Pi 模板补齐失败："));

    let retry = retry_failure(
        &tools,
        &["pi".to_string()],
        &output,
        "Trellis Agent 配置失败",
    );
    assert!(retry.message.starts_with("Trellis Agent 配置失败（模板已补齐，重试仍失败）："));
    let details = retry.details.as_ref().unwrap();
    assert_eq!(details.get("retryFailed").and_then(serde_json::Value::as_bool), Some(true));
    assert_eq!(details.get("repairPlatforms"), Some(&serde_json::json!(["pi"])));

    let generic = trellis_failure(&tools, &output, "Trellis 初始化失败");
    assert!(generic.message.starts_with("Trellis 初始化失败："));
    let details = generic.details.as_ref().unwrap();
    assert_eq!(details.get("repairPlatforms"), Some(&serde_json::json!([])));
}

#[test]
fn embedded_repair_helper_writes_templates_directly() {
    assert!(AGENT_TEMPLATE_REPAIR_HELPER.contains("collectPlatformTemplates"));
    assert!(AGENT_TEMPLATE_REPAIR_HELPER.contains("initializeHashes"));
    assert!(AGENT_TEMPLATE_REPAIR_HELPER.contains("resolveSupportedPython"));
    assert!(AGENT_TEMPLATE_REPAIR_HELPER.contains("openSync(target, \"wx\")"));
    assert!(!AGENT_TEMPLATE_REPAIR_HELPER.contains("fs.renameSync"));
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
