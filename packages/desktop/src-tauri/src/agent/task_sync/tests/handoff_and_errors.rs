use super::*;
use super::support::*;

#[tokio::test]
async fn claim_persists_lease_for_restart_recovery() {
    let (root, store, _sync, binding) =
        test_task_sync_fixture("trellis-control-lease").await;
    let controls = json!([{
        "executionTaskKey": "space-1::task-a",
        "taskId": "task-a",
        "relativeDir": ".trellis/tasks/task-a",
        "title": "任务 A",
        "state": "materialized",
        "taskVersion": 3,
        "assigneeUserId": "user-b",
        "handoffState": "none",
        "updatedAt": "2026-11-17T00:00:00.000Z"
    }]);
    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": [],
        "controls": controls,
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = TaskSync::new(store.clone(), api.clone(), sink);
    sync.set_bindings(vec![binding.clone()]).await;
    let (control, token) = sync
        .claim_remote_task(&binding, "space-1::task-a")
        .await
        .expect("claim");
    assert_eq!(control.task_version, 3);
    assert_eq!(token, "lease-token");
    let (heartbeat_control, heartbeat_token) = sync
        .heartbeat_remote_task(&binding, "space-1::task-a", &token)
        .await
        .expect("heartbeat");
    assert_eq!(heartbeat_control.task_version, 3);
    assert_eq!(heartbeat_token, "lease-token");
    drop(sync);

    let restarted_sink: ControlSink = Arc::new(|_| {});
    let restarted = TaskSync::new(store.clone(), api, restarted_sink);
    let restored = restarted
        .stored_task_lease("space-1::task-a")
        .await
        .expect("restored lease");
    assert_eq!(restored.token, "lease-token");
    assert_eq!(restored.expires_at, "2099-01-01T00:00:00.000Z");
    let released = restarted
        .release_remote_task("space-1::task-a", &restored.token)
        .await
        .expect("release");
    assert_eq!(released["released"], true);
    restarted
        .remove_task_lease("space-1::task-a")
        .await
        .expect("remove lease");
    assert!(restarted
        .stored_task_lease("space-1::task-a")
        .await
        .is_none());

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn rejects_archived_task_directory_under_temp_repo() {
    let (root, _store, _sync, binding) = test_task_sync_fixture("trellis-task-path").await;
    let tasks_root = Path::new(&binding.repo_path).join(".trellis").join("tasks");

    assert_eq!(
        resolve_task_directory(&binding, ".trellis/tasks/active-task")
            .await
            .expect("active task"),
        tasks_root.join("active-task")
    );
    let error = resolve_task_directory(
        &binding,
        ".trellis/tasks/archive/2026-11/archived-task",
    )
    .await
    .expect_err("归档目录必须由服务端 Git 管理");
    assert_eq!(error.code, code::INVALID_RESPONSE);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn invalid_remove_keeps_existing_task_directory() {
    let (root, _store, sync, binding) =
        test_task_sync_fixture("trellis-task-remove").await;
    let sentinel = Path::new(&binding.repo_path)
        .join(".trellis")
        .join("tasks")
        .join("keep");
    tokio::fs::create_dir_all(&sentinel)
        .await
        .expect("sentinel dir");
    tokio::fs::write(sentinel.join("prd.md"), "keep")
        .await
        .expect("sentinel file");

    let error = sync
        .remove_task_directory(&binding, ".trellis/tasks/../keep")
        .await
        .expect_err("非法目录应失败");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(sentinel.join("prd.md").exists());

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn invalid_backup_does_not_create_live_backup() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-task-backup").await;

    let error = sync
        .backup_directory(&binding, ".trellis/tasks/../keep")
        .await
        .expect_err("非法目录应失败");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(!store
        .paths
        .live_backups_dir
        .join(&binding.task_space_id)
        .exists());

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn sync_error_event_contains_readable_scope_without_repo_path() {
    let binding = test_binding("space-1");
    let error = task_directory_error(".trellis/tasks/a", "任务目录路径校验失败");
    let event = task_sync_error_event(
        Some(&binding),
        &binding.task_space_id,
        &error,
        error.message.clone(),
    );
    assert_eq!(event["projectName"], json!("Repo"));
    assert_eq!(event["branchName"], json!("main"));
    assert_eq!(event["taskDir"], json!(".trellis/tasks/a"));
    assert!(event.get("repoPath").is_none());
    assert!(!event.to_string().contains("C:/repos"));
}


#[test]
fn handoff_manifest_is_stable_and_ack_contains_only_cleanup_metadata() {
    let task_dir = ".trellis/tasks/a";
    let files = vec![
        json!({
            "path": ".trellis/tasks/a/task.json",
            "content": "{\"id\":\"a\"}\n",
            "sha256": snapshot_sha256("{\"id\":\"a\"}\n"),
        }),
        json!({
            "path": ".trellis/tasks/a/prd.md",
            "content": "# a\n",
            "sha256": snapshot_sha256("# a\n"),
        }),
    ];
    let (manifest_sha256, file_count, total_bytes, manifest) =
        handoff_manifest(&files, task_dir).expect("manifest");
    assert_eq!(file_count, 2);
    assert_eq!(total_bytes, 15);
    assert!(is_sha256(&manifest_sha256));
    assert_eq!(manifest["files"][0]["path"], "prd.md");

    let handoff = StoredTaskHandoff {
        local_id: "local-1".to_string(),
        task_space_id: "space-1".to_string(),
        execution_task_key: "space-1::a".to_string(),
        task_id: "a".to_string(),
        relative_dir: task_dir.to_string(),
        server_handoff_state: "source_cleanup_pending".to_string(),
        ack_state: "pending".to_string(),
        outcome: "cleaned".to_string(),
        reason: None,
        backup_id: Some("handoff-0123456789abcdef".to_string()),
        manifest_sha256: Some(manifest_sha256.clone()),
        file_count,
        total_bytes,
        lease_held_by_other_user: false,
        notified_state: String::new(),
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    };
    let request = handoff_ack_request(&handoff).expect("ack request");
    assert_eq!(request["outcome"], "cleaned");
    assert_eq!(request["backupId"], "handoff-0123456789abcdef");
    assert_eq!(request["manifestSha256"], manifest_sha256);
    assert!(request.get("content").is_none());
    assert!(request.get("path").is_none());
}


#[test]
fn handoff_git_gate_accepts_only_fully_untracked_directories() {
    use crate::agent::git::GitStatusEntry;

    let untracked = vec![
        GitStatusEntry {
            status: "??".to_string(),
            path: ".trellis/tasks/a/task.json".to_string(),
            original_path: None,
        },
        GitStatusEntry {
            status: "??".to_string(),
            path: ".trellis/tasks/a/prd.md".to_string(),
            original_path: None,
        },
    ];
    assert!(git_entries_all_untracked(&untracked));
    let mut tracked = untracked.clone();
    tracked[0].status = "A ".to_string();
    assert!(!git_entries_all_untracked(&tracked));
    assert!(!git_entries_all_untracked(&[]));
}


#[tokio::test]
async fn handoff_source_fails_closed_on_baseline_or_git_uncertainty() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-handoff-source").await;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    sync.set_bindings(vec![binding.clone()]).await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    let directory = repo.join(task_dir);
    tokio::fs::create_dir_all(&directory)
        .await
        .expect("task directory");
    let task_json = "{\"id\":\"task-a\",\"branch\":\"main\"}\n";
    let prd = "# task-a\n";
    tokio::fs::write(directory.join("task.json"), task_json)
        .await
        .expect("task json");
    tokio::fs::write(directory.join("prd.md"), prd)
        .await
        .expect("prd");
    let handoff = StoredTaskHandoff {
        local_id: binding.local_id.clone(),
        task_space_id: binding.task_space_id.clone(),
        execution_task_key: "space-1::task-a".to_string(),
        task_id: "task-a".to_string(),
        relative_dir: task_dir.to_string(),
        server_handoff_state: "source_cleanup_pending".to_string(),
        ack_state: "pending".to_string(),
        outcome: String::new(),
        reason: None,
        backup_id: None,
        manifest_sha256: None,
        file_count: 0,
        total_bytes: 0,
        lease_held_by_other_user: false,
        notified_state: String::new(),
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    };
    sync.write_cursor(
        &binding.task_space_id,
        CursorPatch {
            baselines: Some(BTreeMap::from([(
                format!("{task_dir}/task.json"),
                snapshot_sha256(task_json),
            )])),
            ..Default::default()
        },
    )
    .await
    .expect("cursor");
    assert!(matches!(
        sync.handoff_source_state(&binding, &handoff)
            .await
            .expect("baseline state"),
        HandoffSourceState::Conflict("baseline_mismatch")
    ));

    sync.write_cursor(
        &binding.task_space_id,
        CursorPatch {
            baselines: Some(BTreeMap::from([
                (
                    format!("{task_dir}/task.json"),
                    snapshot_sha256(task_json),
                ),
                (format!("{task_dir}/prd.md"), snapshot_sha256(prd)),
            ])),
            ..Default::default()
        },
    )
    .await
    .expect("cursor");
    let git_index = repo.join(".git").join("index");
    tokio::fs::remove_file(&git_index).await.ok();
    tokio::fs::create_dir(&git_index)
        .await
        .expect("invalid git index directory");
    assert!(matches!(
        sync.handoff_source_state(&binding, &handoff)
            .await
            .expect("git gate state"),
        HandoffSourceState::Conflict("git_modified")
    ));
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn handoff_retry_requires_complete_and_verifiable_backup() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-handoff-backup-check").await;
    let task_dir = ".trellis/tasks/task-backup";
    let source_dir = Path::new(&binding.repo_path).join(task_dir);
    tokio::fs::create_dir_all(&source_dir)
        .await
        .expect("source directory");
    let task_json = "{\"id\":\"task-backup\"}\n";
    let prd = "# task-backup\n";
    tokio::fs::write(source_dir.join("task.json"), task_json)
        .await
        .expect("task json");
    tokio::fs::write(source_dir.join("prd.md"), prd)
        .await
        .expect("prd");
    let files = vec![
        json!({
            "path": format!("{task_dir}/task.json"),
            "content": task_json,
            "sha256": snapshot_sha256(task_json),
        }),
        json!({
            "path": format!("{task_dir}/prd.md"),
            "content": prd,
            "sha256": snapshot_sha256(prd),
        }),
    ];
    let (manifest_sha256, file_count, total_bytes, manifest) =
        handoff_manifest(&files, task_dir).expect("manifest");
    let backup_id = format!("handoff-{}", &manifest_sha256[..16]);
    let source = HandoffSource {
        files,
        backup_id: backup_id.clone(),
        manifest_sha256: manifest_sha256.clone(),
        manifest,
        file_count,
        total_bytes,
    };
    let handoff = StoredTaskHandoff {
        local_id: binding.local_id.clone(),
        task_space_id: binding.task_space_id.clone(),
        execution_task_key: "space-1::task-backup".to_string(),
        task_id: "task-backup".to_string(),
        relative_dir: task_dir.to_string(),
        server_handoff_state: "source_cleanup_pending".to_string(),
        ack_state: "pending".to_string(),
        outcome: "cleaned".to_string(),
        reason: None,
        backup_id: None,
        manifest_sha256: None,
        file_count: 0,
        total_bytes: 0,
        lease_held_by_other_user: false,
        notified_state: String::new(),
        updated_at: "2026-11-17T00:00:00.000Z".to_string(),
    };
    let control = TaskControl {
        execution_task_key: handoff.execution_task_key.clone(),
        task_id: handoff.task_id.clone(),
        relative_dir: handoff.relative_dir.clone(),
        title: "备份任务".to_string(),
        state: "handoff_materialized".to_string(),
        task_version: 2,
        assignee_user_id: Some("user-b".to_string()),
        handoff_state: "source_cleanup_pending".to_string(),
        materialized_revision: Some(1),
        materialized_at: None,
        lease_held_by_other_user: false,
        updated_at: String::new(),
    };
    assert!(sync
        .ensure_handoff_backup(&binding, &handoff, &control, &source)
        .await
        .expect("create backup"));
    let mut expected = handoff.clone();
    expected.backup_id = Some(backup_id.clone());
    expected.manifest_sha256 = Some(manifest_sha256);
    expected.file_count = file_count;
    expected.total_bytes = total_bytes;
    assert!(sync
        .handoff_backup_is_valid(&binding, &expected)
        .await
        .expect("valid backup"));

    let mut missing = expected.clone();
    missing.backup_id = Some("handoff-fedcba9876543210".to_string());
    assert!(!sync
        .handoff_backup_is_valid(&binding, &missing)
        .await
        .expect("missing backup"));
    let mut invalid = expected.clone();
    invalid.backup_id = Some("../escape".to_string());
    assert!(!sync
        .handoff_backup_is_valid(&binding, &invalid)
        .await
        .expect("invalid backup"));

    let backup = store
        .paths
        .live_backups_dir
        .join(&binding.task_space_id)
        .join(&backup_id);
    tokio::fs::write(backup.join("unexpected.tmp"), "x")
        .await
        .expect("unexpected backup file");
    assert!(!sync
        .handoff_backup_is_valid(&binding, &expected)
        .await
        .expect("unexpected file invalidates backup"));
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn suppression_requires_matching_content_and_consumes_once() {
    let (root, _store, sync, binding) =
        test_task_sync_fixture("trellis-watch-suppression").await;
    let relative = ".trellis/tasks/a/prd.md";
    let path = Path::new(&binding.repo_path).join(".trellis/tasks/a/prd.md");
    tokio::fs::create_dir_all(path.parent().expect("parent"))
        .await
        .expect("task dir");
    tokio::fs::write(&path, "expected")
        .await
        .expect("task file");
    sync.suppressed.lock().await.insert(
        absolute_task_path(&binding, relative),
        Some(snapshot_sha256("expected")),
    );
    assert!(sync.suppressed_event(&binding, relative).await);
    assert!(!sync.suppressed_event(&binding, relative).await);

    sync.suppressed.lock().await.insert(
        absolute_task_path(&binding, relative),
        Some(snapshot_sha256("expected")),
    );
    tokio::fs::write(&path, "changed")
        .await
        .expect("changed file");
    assert!(!sync.suppressed_event(&binding, relative).await);
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn error_event_carries_error_and_server_codes() {
    let mut error = AgentError::new(code::HTTP_ERROR, "失败");
    error.server_code = Some("TASK_ARCHIVED".into());
    let event = task_sync_error_event(None, "space-1", &error, "失败".into());
    assert_eq!(event["errorCode"], json!(code::HTTP_ERROR));
    assert_eq!(event["serverCode"], json!("TASK_ARCHIVED"));

    let event = task_sync_error_event(
        None,
        "space-1",
        &AgentError::new(code::HTTP_ERROR, "失败"),
        "失败".into(),
    );
    assert!(event.get("serverCode").is_none());
}


#[test]
fn readonly_dirs_round_trip_and_drop_archive_entries() {
    let mut dirs = BTreeMap::new();
    dirs.insert(
        ".trellis/tasks/task-a".to_string(),
        readonly_reason("FOREIGN_OWNER", "user-1"),
    );
    dirs.insert(
        ".trellis/tasks/archive/2026-11/task-b".to_string(),
        readonly_reason("DOWNLOADED", "user-2"),
    );
    let parsed = parse_readonly_task_dirs(&readonly_task_dirs_to_value(&dirs));
    assert_eq!(parsed.len(), 1);
    assert_eq!(
        parsed.get(".trellis/tasks/task-a").map(String::as_str),
        Some("FOREIGN_OWNER:user-1")
    );
    assert_eq!(
        readonly_reason_assignee("FOREIGN_OWNER:user-1"),
        Some("user-1")
    );
    assert_eq!(readonly_reason_assignee("DOWNLOADED"), None);

    let cursor = cursor_from_entry(&json!({
        "readonlyTaskDirs": { ".trellis/tasks/task-c": "DOWNLOADED" },
    }));
    assert_eq!(
        cursor.readonly_task_dirs.get(".trellis/tasks/task-c"),
        Some(&"DOWNLOADED".to_string())
    );

    let mut patch = CursorPatch::default();
    patch.readonly_task_dirs = Some(BTreeMap::new());
    let mut cursor = cursor.clone();
    assert!(apply_cursor_patch(&mut cursor, &patch));
    assert!(cursor.readonly_task_dirs.is_empty());
}


#[tokio::test]
async fn marking_readonly_dir_drops_stale_deferred_entry() {
    let (root, store, sync, _binding) =
        test_task_sync_fixture("trellis-readonly-deferred").await;
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "deferred": {
                            ".trellis/tasks/task-a": {
                                ".trellis/tasks/task-a/task.json": "a".repeat(64)
                            }
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    sync.mark_readonly_dir(
        "space-1",
        ".trellis/tasks/task-a",
        &readonly_reason("FOREIGN_OWNER", "user-1"),
    )
    .await
    .expect("mark readonly");

    let cursor = sync.read_cursor("space-1").await;
    assert!(cursor.deferred.is_empty());
    assert_eq!(
        cursor
            .readonly_task_dirs
            .get(".trellis/tasks/task-a")
            .map(String::as_str),
        Some("FOREIGN_OWNER:user-1")
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}
