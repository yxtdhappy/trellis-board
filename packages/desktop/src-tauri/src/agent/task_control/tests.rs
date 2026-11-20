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
        content_revision: None,
        materialized_at: None,
        lease_held_by_other_user: false,
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    }
}

const FIRST_MATERIALIZED_AT: &str = "2026-11-19T08:00:00.000Z";
const SECOND_MATERIALIZED_AT: &str = "2026-11-20T01:57:03.950Z";
const LEGACY_BACKUP_ID: &str = "handoff-8f4d8c4dab571e0e";

fn handoff_control(task_id: &str) -> TaskControl {
    let mut control = control("handoff_materialized", task_id);
    control.handoff_state = "source_cleanup_pending".to_string();
    control.materialized_at = Some(FIRST_MATERIALIZED_AT.to_string());
    control.materialized_revision = Some(1);
    control
}

fn mark_cleaned(state: &mut TaskControlStateFile, key: &str) {
    assert!(state.mark_handoff_ack_pending(
        key,
        "cleaned",
        None,
        Some(LEGACY_BACKUP_ID.to_string()),
        Some("a".repeat(64)),
        2,
        128,
        "2026-11-19T08:05:00.000Z",
    ));
    assert!(state.mark_handoff_ack_done(key, "2026-11-19T08:06:00.000Z"));
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
    assert_eq!(state.controls[&execution_task_key].task_version, 4);
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
    let restored =
        parse_state_file(&serde_json::to_string(&state).expect("serialize control state"));
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
            .execution_task_key_for_dir("local-1", "space-1", ".trellis/tasks/task-a")
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

#[test]
fn same_materialization_cycle_preserves_done_handoff_ack() {
    let mut state = TaskControlStateFile::empty();
    let first = handoff_control("task-a");
    state
        .upsert_handoff_control("local-1", &first)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &first.execution_task_key);
    mark_cleaned(&mut state, &key);
    // 进程重启后同一轮次仍须保留 done/cleaned。
    let mut state =
        parse_state_file(&serde_json::to_string(&state).expect("serialize control state"));
    let manifest_sha256 = "a".repeat(64);

    // 同一物化轮次内 taskVersion/updatedAt 变化不得重置已完成的 ACK。
    let mut repeat = first.clone();
    repeat.task_version += 1;
    repeat.updated_at = "2026-11-19T09:00:00.000Z".to_string();
    assert!(state
        .upsert_handoff_control("local-1", &repeat)
        .expect("repeat control"));
    let handoff = state.handoff(&key).expect("handoff");
    assert_eq!(handoff.ack_state, "done");
    assert_eq!(handoff.outcome, "cleaned");
    assert_eq!(handoff.backup_id.as_deref(), Some(LEGACY_BACKUP_ID));
    assert_eq!(handoff.manifest_sha256.as_deref(), Some(manifest_sha256.as_str()));
    assert_eq!(handoff.file_count, 2);
    assert_eq!(handoff.total_bytes, 128);
    assert!(!state
        .upsert_handoff_control("local-1", &repeat)
        .expect("idempotent repeat"));
}

#[test]
fn new_materialization_cycle_resets_stale_handoff_ack() {
    let mut state = TaskControlStateFile::empty();
    let first = handoff_control("task-a");
    state
        .upsert_handoff_control("local-1", &first)
        .expect("store first cycle");
    let key = handoff_state_key("local-1", &first.execution_task_key);
    mark_cleaned(&mut state, &key);

    let mut second = first.clone();
    second.materialized_at = Some(SECOND_MATERIALIZED_AT.to_string());
    second.materialized_revision = Some(2);
    second.updated_at = SECOND_MATERIALIZED_AT.to_string();
    assert!(state
        .upsert_handoff_control("local-1", &second)
        .expect("store second cycle"));

    let handoff = state.handoff(&key).expect("handoff");
    assert_eq!(handoff.materialized_at.as_deref(), Some(SECOND_MATERIALIZED_AT));
    assert_eq!(handoff.materialized_revision, Some(2));
    assert_eq!(handoff.ack_state, "pending");
    assert_eq!(handoff.outcome, "");
    assert_eq!(handoff.reason, None);
    assert_eq!(handoff.backup_id, None);
    assert_eq!(handoff.manifest_sha256, None);
    assert_eq!(handoff.file_count, 0);
    assert_eq!(handoff.total_bytes, 0);
    assert_eq!(handoff.notified_state, "");
    assert!(state.pending_handoff_acks("local-1").is_empty());
}

#[test]
fn legacy_handoff_without_cycle_epoch_resets_on_new_control() {
    let mut state = TaskControlStateFile::empty();
    let mut legacy = control("handoff_materialized", "task-a");
    legacy.handoff_state = "source_cleanup_pending".to_string();
    state
        .upsert_handoff_control("local-1", &legacy)
        .expect("store legacy handoff");
    let key = handoff_state_key("local-1", &legacy.execution_task_key);
    mark_cleaned(&mut state, &key);

    // 模拟旧状态文件：轮次字段缺省而不是显式 null。
    let mut encoded = serde_json::to_value(&state).expect("serialize state");
    if let Some(records) = encoded.get_mut("handoffs").and_then(serde_json::Value::as_object_mut) {
        for record in records.values_mut() {
            if let Some(record) = record.as_object_mut() {
                let _ = record.remove("materializedAt");
                let _ = record.remove("materializedRevision");
            }
        }
    }
    let mut restored = parse_state_file(&encoded.to_string());
    let legacy_handoff = restored.handoff(&key).expect("legacy handoff");
    assert!(legacy_handoff.materialized_at.is_none());
    assert!(legacy_handoff.materialized_revision.is_none());

    let epoch = handoff_control("task-a");
    assert!(restored
        .upsert_handoff_control("local-1", &epoch)
        .expect("new epoch control"));
    let handoff = restored.handoff(&key).expect("handoff");
    assert_eq!(handoff.materialized_at.as_deref(), Some(FIRST_MATERIALIZED_AT));
    assert_eq!(handoff.materialized_revision, Some(1));
    assert_eq!(handoff.ack_state, "pending");
    assert_eq!(handoff.outcome, "");
    assert_eq!(handoff.backup_id, None);
}

#[test]
fn merge_binding_controls_drops_handoff_after_control_returns_to_claimed() {
    let mut state = TaskControlStateFile::empty();
    let handoff = handoff_control("task-a");
    state
        .upsert_handoff_control("local-1", &handoff)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &handoff.execution_task_key);
    assert!(state.mark_handoff_ack_pending(
        &key,
        "conflict",
        Some("unknown".to_string()),
        None,
        None,
        2,
        128,
        "2026-11-20T04:30:27.000Z",
    ));
    assert!(state.mark_handoff_ack_done(&key, "2026-11-20T04:30:28.000Z"));
    assert_eq!(state.pending_handoff_notices().len(), 1);

    let claimed = control("claimed", "task-a");
    assert!(state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&claimed))
        .expect("merge claimed control"));
    assert!(state.handoffs.is_empty());
    assert!(state.pending_handoff_notices().is_empty());
}

#[test]
fn stale_handoff_cleanup_alone_reports_state_change() {
    let mut state = TaskControlStateFile::empty();
    let claimed = control("claimed", "task-a");
    assert!(state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&claimed))
        .expect("seed controls"));
    state
        .upsert_handoff_control("local-1", &handoff_control("task-a"))
        .expect("store handoff");

    // 控制面没有变化，只有残留下发的 handoff 记录被删除，也必须要求持久化。
    assert!(state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&claimed))
        .expect("merge unchanged controls"));
    assert!(state.handoffs.is_empty());
    // 清理完成后再次合并相同控制面不得重复写盘。
    assert!(!state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&claimed))
        .expect("repeat merge is a no-op"));
}

#[test]
fn merge_binding_controls_keeps_active_conflict_handoff() {
    let mut state = TaskControlStateFile::empty();
    let mut conflict = handoff_control("task-a");
    conflict.handoff_state = "source_cleanup_conflict".to_string();
    state
        .upsert_handoff_control("local-1", &conflict)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &conflict.execution_task_key);
    assert_eq!(state.handoff(&key).expect("handoff").ack_state, "done");

    state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&conflict))
        .expect("merge active conflict");
    let handoff = state.handoff(&key).expect("retained handoff");
    assert_eq!(handoff.server_handoff_state, "source_cleanup_conflict");
    let notices = state.pending_handoff_notices();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].outcome, "conflict");
}

#[test]
fn merge_binding_controls_keeps_active_pending_handoff() {
    let mut state = TaskControlStateFile::empty();
    let handoff = handoff_control("task-a");
    state
        .upsert_handoff_control("local-1", &handoff)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &handoff.execution_task_key);

    state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&handoff))
        .expect("merge active pending");
    let handoff = state.handoff(&key).expect("retained handoff");
    assert_eq!(handoff.ack_state, "pending");
    assert_eq!(handoff.server_handoff_state, "source_cleanup_pending");
    assert_eq!(state.pending_handoff_notices().len(), 1);
}

#[test]
fn merge_binding_controls_keeps_cleaned_handoff_notice() {
    let mut state = TaskControlStateFile::empty();
    let handoff = handoff_control("task-a");
    state
        .upsert_handoff_control("local-1", &handoff)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &handoff.execution_task_key);
    mark_cleaned(&mut state, &key);

    state
        .merge_binding_controls("local-1", "space-1", &[control("claimed", "task-a")])
        .expect("merge claimed control");
    let handoff = state.handoff(&key).expect("cleaned handoff");
    assert_eq!(handoff.ack_state, "done");
    assert_eq!(handoff.outcome, "cleaned");
    assert_eq!(state.pending_handoff_notices()[0].outcome, "cleaned");
}

#[test]
fn merge_binding_controls_keeps_handoffs_of_other_bindings() {
    let mut state = TaskControlStateFile::empty();
    let mut other_device = handoff_control("task-a");
    other_device.handoff_state = "source_cleanup_conflict".to_string();
    state
        .upsert_handoff_control("local-2", &other_device)
        .expect("store other device handoff");
    let mut other_space = handoff_control("task-b");
    other_space.execution_task_key = "space-2::task-b".to_string();
    other_space.handoff_state = "source_cleanup_conflict".to_string();
    state
        .upsert_handoff_control("local-1", &other_space)
        .expect("store other task space handoff");
    state
        .upsert_handoff_control("local-1", &handoff_control("task-c"))
        .expect("store stale handoff");

    state
        .merge_binding_controls("local-1", "space-1", &[control("claimed", "task-a")])
        .expect("merge current binding");

    assert_eq!(state.handoffs.len(), 2);
    assert!(state
        .handoff(&handoff_state_key("local-2", "space-1::task-a"))
        .is_some());
    assert!(state
        .handoff(&handoff_state_key("local-1", "space-2::task-b"))
        .is_some());
    assert!(state
        .handoff(&handoff_state_key("local-1", "space-1::task-c"))
        .is_none());
}

#[test]
fn merge_binding_controls_drops_handoff_missing_from_control_snapshot() {
    let mut state = TaskControlStateFile::empty();
    let mut conflict = handoff_control("task-a");
    conflict.handoff_state = "source_cleanup_conflict".to_string();
    state
        .upsert_handoff_control("local-1", &conflict)
        .expect("store handoff");

    let other_task = control("claimed", "task-b");
    state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&other_task))
        .expect("merge unrelated control");
    assert!(state.handoffs.is_empty());
    assert!(state.pending_handoff_notices().is_empty());
}

#[test]
fn merge_binding_controls_keeps_handoff_when_snapshot_version_rolls_back() {
    let mut state = TaskControlStateFile::empty();
    let mut materialized = handoff_control("task-a");
    materialized.task_version = 4;
    assert!(state
        .upsert_control("local-1", &materialized)
        .expect("seed handoff control"));
    state
        .upsert_handoff_control("local-1", &materialized)
        .expect("store handoff");
    let key = handoff_state_key("local-1", &materialized.execution_task_key);

    // 延迟到达的旧快照 taskVersion 更低；控制面回退不能被当成离开 handoff。
    let stale_claimed = control("claimed", "task-a");
    assert!(stale_claimed.task_version < materialized.task_version);
    assert!(!state
        .merge_binding_controls("local-1", "space-1", std::slice::from_ref(&stale_claimed))
        .expect("ignore stale snapshot"));
    assert_eq!(state.controls["space-1::task-a"].state, "handoff_materialized");
    let handoff = state.handoff(&key).expect("retained handoff");
    assert_eq!(handoff.server_handoff_state, "source_cleanup_pending");
    assert_eq!(state.pending_handoff_notices().len(), 1);
}
