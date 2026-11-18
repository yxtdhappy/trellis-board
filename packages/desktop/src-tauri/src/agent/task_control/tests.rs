use super::*;

fn control(state: &str, task_id: &str) -> TaskControl {
    TaskControl {
        execution_task_key: format!("space-1::{task_id}"),
        task_id: task_id.to_string(),
        relative_dir: format!(".trellis/tasks/{task_id}"),
        title: task_id.to_string(),
        state: state.to_string(),
        task_version: 3,
        assignee_user_id: Some("user-b".to_string()),
        handoff_state: "none".to_string(),
        materialized_revision: None,
        materialized_at: None,
        lease_held_by_other_user: false,
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    }
}

#[test]
fn only_writable_controls_select_server_task_bodies() {
    let controls = vec![
        control("materialized", "a"),
        control("claimed", "b"),
        control("pending_delivery", "c"),
        control("reassigned", "d"),
        control("archived", "e"),
        control("handoff_materialized", "f"),
    ];
    assert_eq!(
        selected_server_task_ids(Some(&controls)).expect("selection"),
        BTreeSet::from(["a".to_string(), "b".to_string(), "c".to_string()])
    );
    assert!(selected_server_task_ids(None).is_none());
}

#[test]
fn upload_fence_adds_version_and_token_without_touching_files() {
    let mut request = json!({ "files": [{"path": "a/task.json"}] });
    UploadFence {
        task_version: 7,
        lease_token: "lease-token".to_string(),
    }
    .apply(&mut request);
    assert_eq!(request["taskVersion"], 7);
    assert_eq!(request["leaseToken"], "lease-token");
    assert_eq!(request["files"][0]["path"], "a/task.json");
}

#[test]
fn corrupted_state_resets_to_empty_and_cannot_trigger_cleanup() {
    let parsed = parse_state_file("{not-json");
    assert_eq!(parsed, TaskControlStateFile::empty());
    assert!(parsed.leases.is_empty());
}

#[test]
fn control_parser_defaults_optional_materialization_fields() {
    let parsed = TaskControl::from_control_value(&json!({
        "executionTaskKey": "space-1::task-a",
        "taskId": "task-a",
        "relativeDir": ".trellis/tasks/task-a",
        "state": "claimed",
        "taskVersion": 2,
        "assigneeUserId": "user-b"
    }))
    .expect("control");
    assert_eq!(parsed.handoff_state, "");
    assert_eq!(parsed.materialized_revision, None);
    assert!(!parsed.lease_held_by_other_user);
    assert_eq!(parsed.control_state(), TaskControlState::Claimed);

    let flagged = TaskControl::from_control_value(&json!({
        "executionTaskKey": "space-1::task-a",
        "taskId": "task-a",
        "relativeDir": ".trellis/tasks/task-a",
        "state": "handoff_materialized",
        "taskVersion": 2,
        "leaseHeldByOtherUser": true
    }))
    .expect("handoff control");
    assert!(flagged.lease_held_by_other_user);
}

#[test]
fn stored_control_rejects_directory_escape() {
    let mut invalid = control("materialized", "task-a");
    invalid.relative_dir = ".trellis/tasks/../evil".to_string();
    assert!(StoredTaskControl::from_control("local-1", &invalid).is_err());
}

#[test]
fn stored_task_version_never_regresses() {
    let mut state = TaskControlStateFile::empty();
    let control = control("materialized", "task-a");
    state
        .upsert_control("local-1", &control)
        .expect("store control");
    let execution_task_key = control.execution_task_key.clone();

    assert!(state.update_task_version(&execution_task_key, 4));
    assert!(!state.update_task_version(&execution_task_key, 3));
    assert_eq!(
        state.controls[&execution_task_key].task_version,
        4
    );
}

#[test]
fn stale_control_version_cannot_replace_newer_state() {
    let mut state = TaskControlStateFile::empty();
    let mut newer = control("claimed", "task-a");
    newer.task_version = 4;
    state
        .upsert_control("local-1", &newer)
        .expect("store newer control");
    let mut stale = newer.clone();
    stale.task_version = 3;
    stale.state = "materialized".to_string();
    assert!(!state
        .upsert_control("local-1", &stale)
        .expect("ignore stale control"));
    assert_eq!(state.controls["space-1::task-a"].task_version, 4);
    assert_eq!(state.controls["space-1::task-a"].state, "claimed");
}

#[test]
fn lease_state_round_trips_for_restart_recovery() {
    let mut state = TaskControlStateFile::empty();
    assert!(state.set_lease(
        "space-1::task-a",
        StoredTaskLease {
            token: "lease-token".to_string(),
            expires_at: "2026-11-17T10:00:00.000Z".to_string(),
            lease_id: Some("lease-1".to_string()),
            updated_at: "2026-11-17T09:50:00.000Z".to_string(),
        },
    ));
    let restored = parse_state_file(
        &serde_json::to_string(&state).expect("serialize control state"),
    );
    assert_eq!(
        restored.leases["space-1::task-a"].token.as_str(),
        "lease-token"
    );
}

#[test]
fn stored_control_recovers_execution_key_for_deletion_only_upload() {
    let mut state = TaskControlStateFile::empty();
    state
        .upsert_control("local-1", &control("materialized", "task-a"))
        .expect("store control");

    assert_eq!(
        state
            .execution_task_key_for_dir(
                "local-1",
                "space-1",
                ".trellis/tasks/task-a"
            )
            .map(String::as_str),
        Some("space-1::task-a")
    );
    assert!(state
        .execution_task_key_for_dir("local-2", "space-1", ".trellis/tasks/task-a")
        .is_none());
}

#[test]
fn handoff_ack_state_survives_restart_and_keeps_conflict_notice() {
    let mut state = TaskControlStateFile::empty();
    let mut handoff = control("handoff_materialized", "task-a");
    handoff.handoff_state = "source_cleanup_pending".to_string();
    state
        .upsert_handoff_control("local-1", &handoff)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &handoff.execution_task_key);
    assert!(state.mark_handoff_ack_pending(
        &key,
        "conflict",
        Some("git_tracked".to_string()),
        None,
        None,
        2,
        128,
        "2026-11-17T01:00:00.000Z",
    ));
    let restored =
        parse_state_file(&serde_json::to_string(&state).expect("serialize control state"));
    let pending = restored.pending_handoff_acks("local-1");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1.reason.as_deref(), Some("git_tracked"));

    let mut restored = restored;
    assert!(restored.mark_handoff_ack_done(&key, "2026-11-17T01:01:00.000Z"));
    let notices = restored.pending_handoff_notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].outcome, "conflict");
    assert!(restored.pending_handoff_acks("local-1").is_empty());
}

#[test]
fn cleaned_handoff_notice_waits_for_ack_completion() {
    let mut state = TaskControlStateFile::empty();
    let mut handoff = control("handoff_materialized", "task-b");
    handoff.handoff_state = "source_cleanup_pending".to_string();
    state
        .upsert_handoff_control("local-1", &handoff)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &handoff.execution_task_key);
    assert!(state.mark_handoff_ack_pending(
        &key,
        "cleaned",
        None,
        Some("backup-1".to_string()),
        Some("a".repeat(64)),
        2,
        128,
        "2026-11-17T01:00:00.000Z",
    ));
    assert!(state.pending_handoff_notices().is_empty());
    assert_eq!(state.pending_handoff_acks("local-1").len(), 1);
    assert!(state.mark_handoff_ack_done(&key, "2026-11-17T01:01:00.000Z"));
    let notices = state.pending_handoff_notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].outcome, "cleaned");
}
