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
