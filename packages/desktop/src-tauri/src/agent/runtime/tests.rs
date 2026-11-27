use super::*;
use serde_json::json;

fn binding(task_space_id: &str) -> AgentBinding {
    AgentBinding {
        local_id: format!("local-{task_space_id}"),
        server_binding_id: Some(format!("binding-{task_space_id}")),
        task_space_id: task_space_id.to_string(),
        project_id: "project-1".to_string(),
        repo_path: format!("C:/repos/{task_space_id}"),
        branch_name: "main".to_string(),
        baseline_branch: None,
        team_id: Some("team-1".to_string()),
        remote_identity_key: "a".repeat(64),
        local_repo_key: "b".repeat(64),
        display_name: "Repo".to_string(),
        created_at: "2026-11-12T00:00:00.000Z".to_string(),
        allow_file_remote: false,
        is_worktree: false,
        read_only: false,
        sync_status: "approved".to_string(),
        detach_pending: false,
        initial_sync_mode: "bootstrap".to_string(),
        initial_sync_completed: true,
        initial_review_pending: false,
        tracked_task_dirs: Vec::new(),
        live_sync_status: "ready".to_string(),
        live_sync_error: None,
        last_synced_at: None,
        last_head: None,
        last_error: None,
        last_error_code: None,
    }
}

fn config() -> AgentConfig {
    AgentConfig {
        schema_version: crate::agent::store::CONFIG_SCHEMA_VERSION,
        revision: "0123456789abcdef0123456789abcdef".to_string(),
        server_url: "http://localhost:4310".to_string(),
        ca_file: None,
        allow_local_git_remotes: false,
        agent_id: "agent-1".to_string(),
        device_name: "PC".to_string(),
        username: Some("dev".to_string()),
        team_id: None,
        teams: Vec::new(),
        protocol_version: 3,
        agent_version: None,
        paired_at: None,
        bindings: vec![binding("space-b"), binding("space-a")],
    }
}

#[test]
fn heartbeat_payload_reports_sorted_listener_snapshot() {
    let payload = heartbeat_payload(
        &config(),
        &[
            "space-b".to_string(),
            "space-a".to_string(),
            "space-a".to_string(),
        ],
    );
    assert_eq!(payload["listenerReportVersion"], LISTENER_REPORT_VERSION);
    assert_eq!(
        payload["listeningTaskSpaceIds"],
        json!(["space-a", "space-b"])
    );
    assert_eq!(payload["bindings"].as_array().expect("bindings").len(), 2);
}

#[test]
fn empty_heartbeat_revokes_bindings_but_keeps_detach_pending() {
    let mut config = config();
    config.bindings[1].detach_pending = true;
    let heartbeat = HeartbeatResponse {
        protocol_version: AGENT_PROTOCOL_VERSION,
        compatible: true,
        minimum_agent_version: None,
        bindings: Vec::new(),
    };
    assert!(merge_heartbeat_bindings(&mut config, &heartbeat));
    assert_eq!(config.bindings[0].sync_status, "revoked");
    assert_eq!(config.bindings[1].sync_status, "approved");
    assert!(config.bindings[1].detach_pending);
}

#[test]
fn heartbeat_updates_server_binding_and_branch_guard() {
    let mut config = config();
    let heartbeat = HeartbeatResponse {
        protocol_version: AGENT_PROTOCOL_VERSION,
        compatible: true,
        minimum_agent_version: None,
        bindings: vec![ServerBinding {
            id: Some("binding-space-a".to_string()),
            task_space_id: "space-a".to_string(),
            project_id: Some("project-1".to_string()),
            team_id: Some("team-2".to_string()),
            local_repo_key: Some("b".repeat(64)),
            status: "approved".to_string(),
            branch_name: Some("dev".to_string()),
            baseline_branch: None,
            error_code: None,
            error: None,
            read_only: true,
        }],
    };
    assert!(merge_heartbeat_bindings(&mut config, &heartbeat));
    let updated = config
        .bindings
        .iter()
        .find(|binding| binding.task_space_id == "space-a")
        .expect("space-a");
    assert_eq!(updated.team_id.as_deref(), Some("team-2"));
    assert!(updated.read_only);
    assert_eq!(
        updated.last_error_code.as_deref(),
        Some("BINDING_BRANCH_MISMATCH")
    );
}

#[test]
fn detach_pending_blocks_new_task_commands() {
    let mut binding = binding("space-a");
    binding.detach_pending = true;
    let command = AgentCommand {
        id: "command-1".to_string(),
        binding_id: "binding-space-a".to_string(),
        kind: crate::agent::protocol::COMMAND_CREATE_TASK.to_string(),
        payload: json!({ "taskSpaceId": "space-a" }),
    };
    assert!(!command_target_active(&[binding], &command));
}

#[test]
fn command_frame_supports_nested_and_legacy_shapes() {
    let command = json!({
        "id": "command-1",
        "bindingId": "binding-space-a",
        "type": "assign_task",
        "payload": {
            "taskSpaceId": "space-a",
            "assigneeUserId": "user-a",
            "executionTaskKey": "space-a::task-a"
        }
    });
    assert_eq!(
        command_from_frame(&json!({ "payload": { "command": command.clone() } })),
        command
    );
    assert_eq!(
        command_from_frame(&json!({ "command": command.clone() })),
        command
    );
}

#[test]
fn merge_heartbeat_handles_binding_unknown_remote_mismatch_and_disabled() {
    let mut config = config();
    let mut space_c = binding("space-c");
    space_c.last_error_code = Some(code::BRANCH_MISMATCH.to_string());
    space_c.last_error = Some("本地分支不一致".to_string());
    config.bindings.push(space_c);
    config.bindings[1].last_error_code = Some(code::BRANCH_MISMATCH.to_string());

    let heartbeat = HeartbeatResponse {
        protocol_version: AGENT_PROTOCOL_VERSION,
        compatible: true,
        minimum_agent_version: None,
        bindings: vec![
            ServerBinding {
                id: None,
                task_space_id: "space-a".to_string(),
                project_id: None,
                team_id: None,
                local_repo_key: None,
                status: "rejected".to_string(),
                branch_name: None,
                baseline_branch: None,
                error_code: Some("BINDING_UNKNOWN".to_string()),
                error: Some("当前设备尚未接入该任务空间".to_string()),
                read_only: false,
            },
            ServerBinding {
                id: Some("binding-space-b".to_string()),
                task_space_id: "space-b".to_string(),
                project_id: None,
                team_id: None,
                local_repo_key: Some("c".repeat(64)),
                status: "rejected".to_string(),
                branch_name: None,
                baseline_branch: None,
                error_code: Some("REMOTE_MISMATCH".to_string()),
                error: Some("本地仓库与已绑定仓库不一致".to_string()),
                read_only: false,
            },
            ServerBinding {
                id: Some("binding-space-c".to_string()),
                task_space_id: "space-c".to_string(),
                project_id: Some("project-1".to_string()),
                team_id: None,
                local_repo_key: Some("b".repeat(64)),
                status: "disabled".to_string(),
                branch_name: Some("dev".to_string()),
                baseline_branch: None,
                error_code: Some("TASK_SPACE_RETIRED".to_string()),
                error: Some("任务空间已弃用".to_string()),
                read_only: false,
            },
        ],
    };

    assert!(merge_heartbeat_bindings(&mut config, &heartbeat));

    let a = config
        .bindings
        .iter()
        .find(|item| item.task_space_id == "space-a")
        .expect("space-a");
    assert_eq!(a.sync_status, "rejected");
    assert_eq!(a.server_binding_id, None);
    assert_eq!(a.last_error_code.as_deref(), Some("BINDING_UNKNOWN"));
    assert_eq!(a.last_error.as_deref(), Some("当前设备尚未接入该任务空间"));

    let b = config
        .bindings
        .iter()
        .find(|item| item.task_space_id == "space-b")
        .expect("space-b");
    assert_eq!(b.sync_status, "rejected");
    assert_eq!(b.last_error_code.as_deref(), Some("REMOTE_MISMATCH"));
    assert_eq!(b.last_error.as_deref(), Some("本地仓库与已绑定仓库不一致"));

    let c = config
        .bindings
        .iter()
        .find(|item| item.task_space_id == "space-c")
        .expect("space-c");
    assert_eq!(c.sync_status, "disabled");
    assert_eq!(c.last_error_code.as_deref(), Some("TASK_SPACE_RETIRED"));
    assert_eq!(c.last_error.as_deref(), Some("任务空间已弃用"));
}

#[test]
fn merge_heartbeat_keeps_binding_id_when_rejection_omits_it() {
    let mut config = config();
    let heartbeat = HeartbeatResponse {
        protocol_version: AGENT_PROTOCOL_VERSION,
        compatible: true,
        minimum_agent_version: None,
        bindings: vec![ServerBinding {
            id: None,
            task_space_id: "space-a".to_string(),
            project_id: None,
            team_id: None,
            local_repo_key: None,
            status: "rejected".to_string(),
            branch_name: None,
            baseline_branch: None,
            error_code: Some("ASSIGNMENT_REJECTED".to_string()),
            error: Some("服务端拒绝该绑定".to_string()),
            read_only: false,
        }],
    };
    assert!(merge_heartbeat_bindings(&mut config, &heartbeat));
    let updated = config
        .bindings
        .iter()
        .find(|binding| binding.task_space_id == "space-a")
        .expect("space-a");
    assert_eq!(updated.sync_status, "rejected");
    assert_eq!(
        updated.server_binding_id.as_deref(),
        Some("binding-space-a")
    );
    assert_eq!(
        updated.last_error_code.as_deref(),
        Some("ASSIGNMENT_REJECTED")
    );
}

#[test]
fn merge_heartbeat_preserves_approved_branch_guard_and_skips_unrelated_repo() {
    let mut config = config();
    config.bindings[1].last_error_code = Some(code::BRANCH_MISMATCH.to_string());
    config.bindings[1].last_error = Some("本地不在 main 分支".to_string());
    config.bindings[0].detach_pending = true;

    let mut space_c = binding("space-c");
    space_c.local_repo_key = "d".repeat(64);
    config.bindings.push(space_c);

    let heartbeat = HeartbeatResponse {
        protocol_version: AGENT_PROTOCOL_VERSION,
        compatible: true,
        minimum_agent_version: None,
        bindings: vec![
            ServerBinding {
                id: Some("binding-space-a".to_string()),
                task_space_id: "space-a".to_string(),
                project_id: Some("project-1".to_string()),
                team_id: Some("team-1".to_string()),
                local_repo_key: Some("b".repeat(64)),
                status: "approved".to_string(),
                branch_name: Some("main".to_string()),
                baseline_branch: None,
                error_code: None,
                error: None,
                read_only: false,
            },
            ServerBinding {
                id: None,
                task_space_id: "space-b".to_string(),
                project_id: None,
                team_id: None,
                local_repo_key: None,
                status: "rejected".to_string(),
                branch_name: None,
                baseline_branch: None,
                error_code: Some("BINDING_UNKNOWN".to_string()),
                error: Some("当前设备尚未接入该任务空间".to_string()),
                read_only: false,
            },
            ServerBinding {
                id: Some("binding-space-c".to_string()),
                task_space_id: "space-c".to_string(),
                project_id: Some("project-1".to_string()),
                team_id: None,
                local_repo_key: Some("e".repeat(64)),
                status: "disabled".to_string(),
                branch_name: Some("main".to_string()),
                baseline_branch: None,
                error_code: Some("TASK_SPACE_DISABLED".to_string()),
                error: Some("任务空间已停用".to_string()),
                read_only: false,
            },
        ],
    };

    assert!(!merge_heartbeat_bindings(&mut config, &heartbeat));
    assert_eq!(
        config.bindings[1].last_error_code.as_deref(),
        Some(code::BRANCH_MISMATCH)
    );
    assert_eq!(config.bindings[0].sync_status, "approved");
    assert_eq!(config.bindings[2].sync_status, "approved");
}
