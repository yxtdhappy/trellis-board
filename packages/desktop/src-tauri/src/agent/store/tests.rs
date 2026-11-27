use super::*;

fn sample_config() -> AgentConfig {
    AgentConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        revision: "0123456789abcdef0123456789abcdef".into(),
        server_url: "http://localhost:4310".into(),
        ca_file: None,
        allow_local_git_remotes: false,
        agent_id: "agent-1".into(),
        device_name: "PC".into(),
        username: Some("dev".into()),
        team_id: None,
        teams: vec![],
        protocol_version: 3,
        agent_version: None,
        paired_at: None,
        bindings: vec![],
    }
}

#[test]
fn validates_config_revision() {
    assert!(validate_config(&sample_config()).is_ok());
    let mut broken = sample_config();
    broken.revision = "zz".into();
    assert!(validate_config(&broken).is_err());
}

#[test]
fn creates_paths_under_root() {
    let paths = create_agent_paths(Path::new("C:/tmp/agent"));
    assert!(paths.config_file.ends_with("config.json"));
    assert!(paths.task_cursors_file.ends_with("live-cursors.json"));
    assert!(paths.task_control_file.ends_with("task-control-state.json"));
    assert!(paths.ownership_index_file.ends_with("ownership-index.json"));
}

#[test]
fn detach_pending_defaults_false_and_round_trips() {
    let binding = binding("local-1", "ts-1", false);
    let mut value = serde_json::to_value(&binding).expect("serialize");
    value
        .as_object_mut()
        .expect("binding object")
        .remove("detachPending");
    let parsed: AgentBinding = serde_json::from_value(value).expect("deserialize");
    assert!(!parsed.detach_pending);

    let mut value = serde_json::to_value(&binding).expect("serialize");
    value["detachPending"] = serde_json::Value::Bool(true);
    let pending: AgentBinding = serde_json::from_value(value).expect("deserialize");
    assert!(pending.detach_pending);
}

#[test]
fn is_worktree_defaults_false_and_round_trips() {
    let binding = binding("local-1", "ts-1", false);
    let mut value = serde_json::to_value(&binding).expect("serialize");
    value
        .as_object_mut()
        .expect("binding object")
        .remove("isWorktree");
    let parsed: AgentBinding = serde_json::from_value(value).expect("deserialize");
    assert!(!parsed.is_worktree);

    let mut value = serde_json::to_value(&binding).expect("serialize");
    value["isWorktree"] = serde_json::Value::Bool(true);
    let worktree: AgentBinding = serde_json::from_value(value).expect("deserialize");
    assert!(worktree.is_worktree);
}

fn binding(local_id: &str, task_space_id: &str, read_only: bool) -> AgentBinding {
    AgentBinding {
        local_id: local_id.into(),
        server_binding_id: None,
        task_space_id: task_space_id.into(),
        project_id: "project-1".into(),
        repo_path: "C:/repo".into(),
        branch_name: "main".into(),
        baseline_branch: None,
        team_id: None,
        remote_identity_key: "remote".into(),
        local_repo_key: "a".repeat(64),
        display_name: "Repo".into(),
        created_at: "2026-11-12T00:00:00.000Z".into(),
        allow_file_remote: false,
        is_worktree: false,
        read_only,
        sync_status: "approved".into(),
        detach_pending: false,
        initial_sync_mode: "bootstrap".into(),
        initial_sync_completed: true,
        initial_review_pending: false,
        tracked_task_dirs: Vec::new(),
        live_sync_status: "ready".into(),
        live_sync_error: None,
        last_synced_at: None,
        last_head: None,
        last_error: None,
        last_error_code: None,
    }
}

#[test]
fn rejects_second_active_binding_for_same_repository() {
    let first = binding("local-1", "ts-1", false);
    let second = binding("local-2", "ts-2", false);
    let error = assert_repository_bindings_converged(&[first.clone(), second], &[])
        .expect_err("should reject");
    assert_eq!(error.code, code::CONFIG_INVALID);
    // 与上一版配置一致时放行，允许历史数据继续运行。
    let legacy = binding("local-2", "ts-2", false);
    assert!(assert_repository_bindings_converged(
        &[first.clone(), legacy.clone()],
        &[first, legacy]
    )
    .is_ok());
}

#[test]
fn allows_disabled_and_rejected_binding_statuses_in_config() {
    let mut disabled = binding("local-1", "ts-1", false);
    disabled.remote_identity_key = "b".repeat(64);
    disabled.server_binding_id = Some("binding-1".into());
    disabled.sync_status = "disabled".into();
    disabled.last_error_code = Some("TASK_SPACE_DISABLED".into());

    let mut rejected = binding("local-2", "ts-2", false);
    rejected.remote_identity_key = "c".repeat(64);
    rejected.server_binding_id = None;
    rejected.sync_status = "rejected".into();
    rejected.last_error_code = Some("BINDING_UNKNOWN".into());

    let mut config = sample_config();
    config.bindings = vec![disabled, rejected];
    let validated = validate_config(&config).expect("disabled and rejected bindings");
    assert_eq!(validated.bindings[0].sync_status, "disabled");
    assert_eq!(validated.bindings[1].sync_status, "rejected");
}
