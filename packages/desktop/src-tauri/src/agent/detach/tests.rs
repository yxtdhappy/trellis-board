use super::*;
use crate::agent::store::AgentConfig;

fn binding() -> AgentBinding {
    AgentBinding {
        local_id: "local-1".to_string(),
        server_binding_id: Some("binding-1".to_string()),
        task_space_id: "space-1".to_string(),
        project_id: "project-1".to_string(),
        repo_path: "C:/repo".to_string(),
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
        bindings: vec![binding()],
    }
}

#[test]
fn terminal_errors_cover_404_and_known_binding_states() {
    let mut error = AgentError::new(code::HTTP_ERROR, "not found");
    error.status = Some(404);
    assert!(terminal_detach_error(&error));
    error.status = None;
    error.server_code = Some("BINDING_ALREADY_DETACHED".to_string());
    assert!(terminal_detach_error(&error));
    error.server_code = Some("REMOTE_MISMATCH".to_string());
    assert!(!terminal_detach_error(&error));
}

#[tokio::test]
async fn mark_pending_updates_only_the_selected_binding() {
    let root = std::env::temp_dir().join(format!("trellis-detach-{}", uuid::Uuid::new_v4()));
    let store = ConfigStore::new_unsecured_for_test(root);
    store.ensure_directories().await.expect("directories");
    let mut seeded = config();
    let mut other = binding();
    other.local_id = "local-2".to_string();
    other.task_space_id = "space-2".to_string();
    other.local_repo_key = "c".repeat(64);
    seeded.bindings.push(other);
    store.save_config(seeded).await.expect("config");

    let selected = mark_pending(&store, "space-1").await.expect("pending");
    assert_eq!(selected.task_space_id, "space-1");
    assert!(!selected.detach_pending);
    let saved = store
        .read_config(false)
        .await
        .expect("read")
        .expect("config");
    assert!(saved.bindings[0].detach_pending);
    assert!(!saved.bindings[1].detach_pending);
    assert_eq!(
        saved.bindings[0].last_error.as_deref(),
        Some("服务端解绑待确认")
    );
}
