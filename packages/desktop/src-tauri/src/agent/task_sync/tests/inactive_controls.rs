use super::support::*;
use super::*;

fn inactive_control(execution_task_key: &str, relative_dir: &str, state: &str) -> TaskControl {
    TaskControl {
        execution_task_key: execution_task_key.to_string(),
        task_id: execution_task_key
            .rsplit("::")
            .next()
            .unwrap_or_default()
            .to_string(),
        relative_dir: relative_dir.to_string(),
        title: "任务".to_string(),
        state: state.to_string(),
        task_version: 1,
        assignee_user_id: Some("user-b".to_string()),
        handoff_state: "none".to_string(),
        materialized_revision: None,
        content_revision: None,
        materialized_at: None,
        lease_held_by_other_user: false,
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    }
}

#[test]
fn inactive_control_dirs_skips_archive_controls() {
    let controls = vec![
        inactive_control(
            "space-1::archived-task",
            ".trellis/tasks/archive/2026-11/archived-task",
            "archived",
        ),
        inactive_control("space-1::stale-task", ".trellis/tasks/stale-task", "archived"),
        inactive_control(
            "space-1::reassigned-task",
            ".trellis/tasks/reassigned-task",
            "reassigned",
        ),
        inactive_control(
            "space-1::handoff-task",
            ".trellis/tasks/handoff-task",
            "handoff_materialized",
        ),
        inactive_control(
            "space-1::owned-task",
            ".trellis/tasks/owned-task",
            "materialized",
        ),
    ];

    let dirs = inactive_control_dirs(Some(&controls));

    assert!(!dirs.contains(".trellis/tasks/archive/2026-11/archived-task"));
    assert!(dirs.contains(".trellis/tasks/stale-task"));
    assert!(dirs.contains(".trellis/tasks/reassigned-task"));
    assert!(dirs.contains(".trellis/tasks/handoff-task"));
    assert!(!dirs.contains(".trellis/tasks/owned-task"));
}

#[tokio::test]
async fn release_inactive_leases_ignores_controls_without_lease() {
    let (root, store, _sync, binding) = test_task_sync_fixture("trellis-inactive-no-lease").await;
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": [],
        "controls": [],
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = TaskSync::new(store.clone(), api, Arc::new(|_| {}));
    sync.set_bindings(vec![binding.clone()]).await;
    let controls = vec![
        inactive_control(
            "space-1::archived-task",
            ".trellis/tasks/archive/2026-11/archived-task",
            "archived",
        ),
        inactive_control(
            "space-1::handoff-task",
            ".trellis/tasks/handoff-task",
            "handoff_materialized",
        ),
    ];

    sync.release_inactive_task_leases(Some(&controls)).await;

    assert!(sync
        .stored_task_lease("space-1::archived-task")
        .await
        .is_none());
    assert!(requests
        .lock()
        .await
        .iter()
        .all(|request| !request.ends_with("/release")));

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn release_inactive_leases_releases_stored_lease_for_archived_task() {
    let (root, store, _sync, binding) = test_task_sync_fixture("trellis-inactive-release").await;
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": [],
        "controls": [{
            "executionTaskKey": "space-1::task-a",
            "taskId": "task-a",
            "relativeDir": ".trellis/tasks/task-a",
            "title": "任务 A",
            "state": "materialized",
            "taskVersion": 3,
            "assigneeUserId": "user-b",
            "handoffState": "none",
            "updatedAt": "2026-11-17T00:00:00.000Z"
        }],
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = TaskSync::new(store.clone(), api, Arc::new(|_| {}));
    sync.set_bindings(vec![binding.clone()]).await;
    sync.claim_remote_task(&binding, "space-1::task-a")
        .await
        .expect("claim");
    assert!(sync.stored_task_lease("space-1::task-a").await.is_some());

    // 现场归档 control 的 relative_dir 都在 archive 下；释放逻辑只看 execution_task_key，
    // 这里保持真实形状，避免将来误加 archive 短路后测试仍然通过。
    let controls = vec![inactive_control(
        "space-1::task-a",
        ".trellis/tasks/archive/2026-11/task-a",
        "archived",
    )];
    sync.release_inactive_task_leases(Some(&controls)).await;

    assert!(sync.stored_task_lease("space-1::task-a").await.is_none());
    let release_count = requests
        .lock()
        .await
        .iter()
        .filter(|request| request.ends_with("/release"))
        .count();
    assert_eq!(release_count, 1);

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_archived_controls_removes_active_residue() {
    let (root, store, _sync, binding) =
        test_task_sync_fixture("trellis-archived-residue").await;
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sync = TaskSync::new(store.clone(), api, Arc::new(|_| {}));
    let repo = Path::new(&binding.repo_path);
    let active_dir = repo.join(".trellis/tasks/task-a");
    let archive_dir = repo.join(".trellis/tasks/archive/2026-11/task-a");
    for directory in [&active_dir, &archive_dir] {
        tokio::fs::create_dir_all(directory)
            .await
            .expect("task directory");
        tokio::fs::write(
            directory.join("task.json"),
            b"{\"id\":\"task-a\",\"branch\":\"main\"}\n",
        )
        .await
        .expect("task json");
    }
    let controls = vec![inactive_control(
        "space-1::task-a",
        ".trellis/tasks/archive/2026-11/task-a",
        "archived",
    )];

    sync.cleanup_archived_controls(&binding, &controls).await;

    assert!(tokio::fs::metadata(&active_dir).await.is_err());
    assert!(tokio::fs::metadata(&archive_dir).await.is_ok());

    let _ = tokio::fs::remove_dir_all(root).await;
}
