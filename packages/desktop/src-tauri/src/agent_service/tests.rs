use super::*;
use serde_json::json;

fn scoped(kind: &str) -> Value {
    json!({
        "type": kind,
        "projectName": "trellis-board",
        "branchName": "main",
    })
}

#[test]
fn xml_escape_covers_special_chars() {
    assert_eq!(
        xml_escape("a&b<c>\"d\"'e'"),
        "a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;"
    );
}

#[test]
fn handoff_notification_only_covers_terminal_outcomes() {
    assert_eq!(
        handoff_notification(&json!({ "outcome": "", "taskId": "task-a" })),
        None
    );
    assert_eq!(
        handoff_notification(&json!({
            "outcome": "cleaned",
            "taskId": "e2e-handoff-1",
            "reason": null
        })),
        Some(("任务已被认领，本地副本已清理", "e2e-handoff-1".to_string()))
    );
    assert_eq!(
        handoff_notification(&json!({
            "outcome": "conflict",
            "taskId": "e2e-handoff-2",
            "reason": "lease_active"
        })),
        Some((
            "任务已被认领，本地副本需保留",
            "e2e-handoff-2 · 任务仍有其他客户端持有写租约，暂未清理".to_string()
        ))
    );
}

#[test]
fn review_notification_counts_differences() {
    let mut control = scoped("initial_sync_review");
    control["differences"] = json!([{ "type": "local-only" }, { "type": "content-conflict" }]);
    assert_eq!(
        control_notification(&control, "Weint Spec Board"),
        (
            "有任务差异需要确认".to_string(),
            "trellis-board（main）：2 个任务存在差异，打开客户端逐项处理。".to_string()
        )
    );
}

#[test]
fn conflict_notification_names_the_task_dir() {
    let mut control = scoped("task_file_conflict");
    control["conflict"] = json!({ "taskDir": ".trellis/tasks/11-19-a" });
    assert_eq!(
        control_notification(&control, "Weint Spec Board"),
        (
            "任务文件冲突".to_string(),
            "trellis-board（main）：.trellis/tasks/11-19-a 被同时修改，打开客户端选择保留哪一份。"
                .to_string()
        )
    );
}

#[test]
fn ownership_notification_counts_items() {
    let mut control = scoped("task_ownership_review");
    control["items"] = json!([{ "taskDir": "a" }]);
    assert_eq!(
        control_notification(&control, "Weint Spec Board").1,
        "trellis-board（main）：1 个任务需要确认开发分支。"
    );
}

#[test]
fn sync_error_notification_prefers_message_over_error() {
    let mut control = scoped("task_sync_error");
    control["message"] = json!("上传失败");
    control["error"] = json!("UPLOAD_FAILED");
    assert_eq!(
        control_notification(&control, "Weint Spec Board"),
        (
            "任务同步失败".to_string(),
            "trellis-board（main）：上传失败".to_string()
        )
    );
    control.as_object_mut().unwrap().remove("message");
    assert_eq!(
        control_notification(&control, "Weint Spec Board").1,
        "trellis-board（main）：UPLOAD_FAILED"
    );
}

#[test]
fn unknown_type_falls_back_to_generic_body() {
    let control = scoped("something_new");
    assert_eq!(
        control_notification(&control, "Weint Spec Board"),
        (
            "Weint Spec Board 有新的同步事件".to_string(),
            "trellis-board（main）：打开客户端查看任务同步情况。".to_string()
        )
    );
    assert_eq!(
        control_notification(&control, "Custom Board"),
        (
            "Custom Board 有新的同步事件".to_string(),
            "trellis-board（main）：打开客户端查看任务同步情况。".to_string()
        )
    );
}

#[test]
fn missing_project_omits_the_scope_prefix() {
    let control = json!({
        "type": "initial_sync_review",
        "differences": [{ "type": "local-only" }],
    });
    let (_, body) = control_notification(&control, "Weint Spec Board");
    assert_eq!(body, "1 个任务存在差异，打开客户端逐项处理。");
    assert!(!body.contains('：'));
    assert!(!body.starts_with('（'));
}

#[tokio::test]
async fn select_task_sync_reuses_running_instance_with_serial_lock_and_falls_back() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let root =
        std::env::temp_dir().join(format!("trellis-select-task-sync-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
    store.ensure_directories().await.expect("directories");
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let running = Arc::new(TaskSync::new(store.clone(), api.clone(), Arc::new(|_| {})));
    running
        .set_bindings(vec![AgentBinding {
            local_id: "local-1".to_string(),
            server_binding_id: Some("binding-1".to_string()),
            task_space_id: "space-1".to_string(),
            project_id: "project-1".to_string(),
            repo_path: root.join("repo").to_string_lossy().to_string(),
            branch_name: "main".to_string(),
            baseline_branch: None,
            team_id: None,
            remote_identity_key: "a".repeat(64),
            local_repo_key: "b".repeat(64),
            display_name: "Repo".to_string(),
            created_at: "2026-11-25T00:00:00.000Z".to_string(),
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
        }])
        .await;

    let fallback_called = Arc::new(AtomicBool::new(false));
    let called_clone = fallback_called.clone();
    let (selected, guard) = select_task_sync(Some(running.clone()), "space-1", || async move {
        called_clone.store(true, Ordering::SeqCst);
        unreachable!("fallback must not run when running TaskSync holds the binding")
    })
    .await
    .expect("reuse running task sync");
    assert!(Arc::ptr_eq(&selected, &running));
    assert!(!fallback_called.load(Ordering::SeqCst));
    let guard = guard.expect("serial lock must be held for running TaskSync");
    let lock = running.task_space_sync_lock("space-1").await;
    assert!(
        lock.try_lock().is_err(),
        "per-space sync lock must serialize concurrent operations"
    );
    drop(guard);
    assert!(
        lock.try_lock().is_ok(),
        "dropping guard must release per-space sync lock"
    );

    let fallback_instance = Arc::new(TaskSync::new(store.clone(), api.clone(), Arc::new(|_| {})));
    let fallback_ref = fallback_instance.clone();
    let (unmatched, unmatched_guard) =
        select_task_sync(Some(running.clone()), "space-other", || async move {
            Ok(fallback_ref)
        })
        .await
        .expect("fallback when binding missing");
    assert!(Arc::ptr_eq(&unmatched, &fallback_instance));
    assert!(unmatched_guard.is_none());

    let fallback_ref2 = fallback_instance.clone();
    let (stopped, stopped_guard) =
        select_task_sync(None, "space-1", || async move { Ok(fallback_ref2) })
            .await
            .expect("fallback when runtime stopped");
    assert!(Arc::ptr_eq(&stopped, &fallback_instance));
    assert!(stopped_guard.is_none());

    let _ = tokio::fs::remove_dir_all(root).await;
}
