use super::support::*;
use super::*;

#[tokio::test]
async fn revision_guard_downloads_baseline_cross_source_server_only_task() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-revision-guard-cross-source").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    tokio::fs::write(repo.join("README.md"), "repo\n")
        .await
        .expect("readme");
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "--no-verify", "-m", "init"]);

    binding.baseline_branch = Some("main".to_string());
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 1,
                        "revisionGuardVersion": 0,
                        "sequence": 1
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    let task_dir = ".trellis/tasks/task-source";
    let task_json = "{\"id\":\"task-source\",\"branch\":\"feature/source\"}\n";
    let task_json_path = format!("{task_dir}/task.json");
    let prd_path = format!("{task_dir}/prd.md");
    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 3,
        "files": [
            snapshot_file_value(task_json_path.as_str(), task_json),
            snapshot_file_value(prd_path.as_str(), "# 来源任务\n")
        ]
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync.repair_revision_guard(&binding).await.expect("repair");
    assert_eq!(result["repaired"], true);
    assert_eq!(result["downloaded"], 1);
    assert_eq!(
        tokio::fs::read_to_string(repo.join(task_json_path.as_str()))
            .await
            .expect("downloaded task json"),
        task_json
    );
    assert_eq!(
        tokio::fs::read_to_string(repo.join(prd_path.as_str()))
            .await
            .expect("downloaded prd"),
        "# 来源任务\n"
    );
    let cursor = store.read_task_cursors().await;
    assert_eq!(
        cursor["taskSpaces"]["space-1"]["revisionGuardVersion"],
        REVISION_GUARD_VERSION
    );
    assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 3);
    assert_eq!(
        cursor["taskSpaces"]["space-1"]["baselines"][task_json_path.as_str()],
        snapshot_sha256(task_json)
    );
    assert!(changes.lock().await.is_empty());

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[test]
fn revision_guard_keeps_cross_source_tasks_only_for_baseline_binding() {
    let group = SnapshotGroup {
        task_dir: ".trellis/tasks/task-source".to_string(),
        archived: false,
        archive_month: None,
        files: Vec::new(),
        task_id: Some("task-source".to_string()),
        task_branch: Some("feature/source".to_string()),
    };
    let mut binding = test_binding("space-1");
    binding.baseline_branch = Some("team-board".to_string());
    let mut groups = vec![group.clone()];
    retain_server_groups_for_revision_guard(&binding, &mut groups);
    assert!(groups.is_empty());

    binding.baseline_branch = Some("main".to_string());
    groups.push(group);
    retain_server_groups_for_revision_guard(&binding, &mut groups);
    assert_eq!(groups.len(), 1);
}

#[test]
fn cross_source_server_apply_requires_baseline_guard_or_conflict_mode() {
    let mut binding = test_binding("space-1");
    binding.baseline_branch = Some("main".to_string());
    assert!(allows_cross_source_server_group(
        &binding,
        REVISION_GUARD_SYNC_MODE
    ));
    assert!(allows_cross_source_server_group(
        &binding,
        CONFLICT_SYNC_MODE
    ));
    assert!(!allows_cross_source_server_group(&binding, "safe"));
    assert!(!allows_cross_source_server_group(&binding, "incremental"));

    binding.baseline_branch = Some("team-board".to_string());
    assert!(!allows_cross_source_server_group(
        &binding,
        REVISION_GUARD_SYNC_MODE
    ));
    assert!(!allows_cross_source_server_group(
        &binding,
        CONFLICT_SYNC_MODE
    ));
}

#[tokio::test]
async fn initial_sync_pending_binding_not_listening() {
    let (root, store, mut binding, _task_dir) =
        exact_deferred_fixture("trellis-listening-pending").await;
    binding.initial_sync_completed = false;
    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));

    let task_space_ids = sync.prepare_startup_bindings(vec![binding]).await;

    assert_eq!(task_space_ids, vec!["space-1".to_string()]);
    assert!(sync.active_bindings().await.is_empty());
    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn startup_bindings_activate_before_background_pull() {
    let (root, store, binding, task_dir) = exact_deferred_fixture("trellis-startup-activate").await;
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));

    let task_space_ids = sync.prepare_startup_bindings(vec![binding]).await;

    assert_eq!(task_space_ids, vec!["space-1".to_string()]);
    assert_eq!(sync.active_bindings().await.len(), 1);
    assert!(requests.lock().await.is_empty());
    let (events, receiver) = mpsc::unbounded_channel();
    let (_shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let watcher_sync = Arc::downgrade(&sync);
    let watch_task =
        tokio::spawn(
            async move { TaskSync::watch_loop(watcher_sync, receiver, shutdown_rx).await },
        );
    events
        .send(WatchEvent::TaskPath {
            task_space_id: "space-1".to_string(),
            relative_path: format!("{task_dir}/task.json"),
        })
        .expect("watch event");
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if sync.deferred_uploads.lock().await.contains_key("space-1") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("deferred watch event");
    let waiter = {
        let sync = sync.clone();
        tokio::spawn(async move { sync.wait_for_binding_sync().await })
    };
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());

    sync.sync_task_spaces(task_space_ids).await;
    waiter.await.expect("sync waiter");
    assert_eq!(sync.active_bindings().await.len(), 1);
    assert!(sync.deferred_uploads.lock().await.is_empty());
    assert!(requests
        .lock()
        .await
        .iter()
        .any(|request| request.contains("/snapshot?")));
    drop(events);
    watch_task.await.expect("watch loop");

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn startup_pull_reconciles_exact_deferred_once_at_same_revision() {
    let (root, store, binding, task_dir) = exact_deferred_fixture("trellis-deferred-startup").await;
    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

    sync.update_bindings(vec![binding.clone()]).await;

    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.deferred.contains_key(&task_dir));
    assert!(cursor.pending.is_none());
    assert!(changes.lock().await.is_empty());
    let snapshot_requests = requests
        .lock()
        .await
        .iter()
        .filter(|request| request.contains("/snapshot?"))
        .count();
    assert_eq!(snapshot_requests, 1);

    sync.update_bindings(vec![binding]).await;
    let repeated_snapshot_requests = requests
        .lock()
        .await
        .iter()
        .filter(|request| request.contains("/snapshot?"))
        .count();
    assert_eq!(repeated_snapshot_requests, 1);

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn startup_pull_drops_deferred_entries_for_readonly_mirrors() {
    let (root, store, binding, task_dir) =
        exact_deferred_fixture("trellis-deferred-readonly").await;
    let mut cursors = store.read_task_cursors().await;
    cursors["taskSpaces"]["space-1"]["readonlyTaskDirs"] = json!({
        (task_dir.clone()): "FOREIGN_OWNER:user-1"
    });
    store
        .write_json(&store.paths.task_cursors_file, &cursors)
        .await
        .expect("cursor");

    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));

    sync.update_bindings(vec![binding.clone()]).await;

    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.deferred.contains_key(&task_dir));
    assert_eq!(
        cursor.readonly_task_dirs.get(&task_dir).map(String::as_str),
        Some("FOREIGN_OWNER:user-1")
    );
    assert!(changes.lock().await.is_empty());

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn unchanged_startup_pull_skips_second_ownership_validation() {
    let (root, store, binding, _) =
        exact_deferred_fixture("trellis-startup-single-validation").await;
    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding]).await;

    assert!(!sync.pull_and_report("space-1").await);

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn unchanged_startup_pull_revalidates_pending_ownership_ledger() {
    let (root, store, binding, _) = exact_deferred_fixture("trellis-startup-ownership-retry").await;
    let missing = ".trellis/tasks/offline-missing";
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 1,
                        "revisionGuardVersion": 1,
                        "sequence": 1,
                        "ownershipPending": {
                            missing: {
                                "fingerprint": "a".repeat(64),
                                "reason": "TASK_OWNERSHIP_REQUIRED",
                            },
                        },
                        "pendingRejected": {
                            missing: {
                                "batchId": "batch-1",
                                "clientSequence": 1,
                                "reason": "TASK_OWNERSHIP_REQUIRED",
                                "createdAt": "2026-11-18T00:00:00.000Z",
                                "blockedAt": "2026-11-18T00:00:01.000Z",
                            },
                        },
                    },
                },
            }),
        )
        .await
        .expect("ownership cursor");
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding]).await;

    assert!(sync.pull_and_report("space-1").await);
    sync.sync_task_spaces(vec!["space-1".to_string()]).await;

    assert!(requests
        .lock()
        .await
        .iter()
        .any(|request| { request == "PUT /api/agent/task-spaces/space-1/ownership-inbox" }));
    let cursor = sync.read_cursor("space-1").await;
    assert!(cursor.ownership_pending.is_empty());
    assert!(cursor.pending_rejected.is_empty());

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn startup_deferred_reconcile_does_not_trigger_baseline_upload() {
    let (root, store, mut binding, task_dir) =
        exact_deferred_fixture("trellis-deferred-no-upload").await;
    let repo = Path::new(&binding.repo_path);
    write_task_json(repo, &task_dir, "task-a", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "source task"]);
    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let task_hash = snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
    write_deferred_cursor(&store, &task_dir, &task_hash, &task_hash).await;
    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

    sync.update_bindings(vec![binding]).await;

    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.deferred.contains_key(&task_dir));
    assert!(cursor.pending.is_none());
    assert!(changes.lock().await.is_empty());
    assert!(requests
        .lock()
        .await
        .iter()
        .all(|request| !request.ends_with("/changes")));

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn startup_local_deferred_change_still_allows_baseline_reconcile() {
    let (root, store, mut binding, task_dir) =
        exact_deferred_fixture("trellis-deferred-local-change").await;
    let repo = Path::new(&binding.repo_path);
    let old_hash = snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"main\"}\n");
    write_task_json(repo, &task_dir, "task-a", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "source task"]);
    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let changed_hash = snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
    write_deferred_cursor(&store, &task_dir, &changed_hash, &old_hash).await;
    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

    sync.update_bindings(vec![binding]).await;

    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.deferred.contains_key(&task_dir));
    let changes = changes.lock().await;
    assert_eq!(changes.len(), 1, "本地状态变化后仍应保留基线补交行为");
    assert_eq!(changes[0]["mergeEvidence"]["taskId"], "task-a");

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn normal_pull_reconciles_exact_deferred_without_dirty_upload() {
    let (root, store, binding, task_dir) = exact_deferred_fixture("trellis-deferred-pull").await;
    let task_json = format!("{task_dir}/task.json");
    let repo_path = Path::new(&binding.repo_path).to_path_buf();
    let content = "{\"id\":\"task-a\",\"branch\":\"main\"}\n";
    let task_hash = snapshot_sha256(content);
    let stale_hash = "0".repeat(64);
    write_deferred_cursor(&store, &task_dir, &stale_hash, &task_hash).await;
    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 2,
        "files": [{
            "path": task_json.clone(),
            "content": content,
            "sha256": task_hash.clone(),
            "deleted": false
        }]
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = TaskSync::new(store.clone(), api, sink);
    sync.set_bindings(vec![binding]).await;

    let result = sync
        .pull_task_space("space-1")
        .await
        .expect("pull exact deferred");

    assert_eq!(result["revision"], 2);
    assert_eq!(result["conflicts"].as_array().map(Vec::len), Some(0));
    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.deferred.contains_key(&task_dir));
    assert!(cursor.pending.is_none());
    assert!(changes.lock().await.is_empty());
    assert_eq!(cursor.baselines.get(&task_json), Some(&task_hash));
    assert_eq!(
        tokio::fs::read_to_string(repo_path.join(&task_json))
            .await
            .expect("local task"),
        content
    );

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn archived_directory_409_clears_cursor_state_and_pull_advances_revision() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-archived-residue-pull").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/11-18-archived-task";
    write_task_json(repo, task_dir, "archived-task", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let task_json = format!("{task_dir}/task.json");
    let stale_hash = "0".repeat(64);
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 1,
                        "revisionGuardVersion": 1,
                        "sequence": 1,
                        "baselines": {
                            (task_json.clone()): stale_hash.clone()
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    // E2E 7.4 现场：服务端已把任务移入 archive，本地活跃副本已不存在。
    tokio::fs::remove_dir_all(repo.join(task_dir))
        .await
        .expect("remove archived active dir");
    run_git(repo, &["add", "-A"]);
    run_git(repo, &["commit", "--no-verify", "-m", "archive move"]);

    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 3,
        "files": [],
        "directoryStatus": 409,
        "directoryPayload": {
            "code": "ARCHIVE_SYNC_SERVER_MANAGED",
            "error": "归档任务由服务端 Git 索引管理"
        }
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = tokio::time::timeout(Duration::from_secs(10), sync.pull_task_space("space-1"))
        .await
        .expect("归档 409 后 pull 必须收敛，不能无限重试")
        .expect("pull");
    assert_eq!(result["revision"], 3);

    let cursor = sync.read_cursor("space-1").await;
    assert_eq!(
        cursor.revision, 3,
        "收敛后必须应用快照并推进已应用 revision"
    );
    assert!(!cursor.baselines.contains_key(&task_json));
    assert!(cursor.pending.is_none());
    assert!(changes.lock().await.is_empty(), "归档目录不得产生上传批次");
    let requests = requests.lock().await;
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.contains("/files?"))
            .count(),
        1,
        "归档 409 后不得重复请求同一目录"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.contains("/snapshot?"))
            .count(),
        1,
        "上传未产生提交时直接应用当前快照收敛，不得重复拉取或递归"
    );
    drop(requests);
    assert!(
        tokio::fs::metadata(repo.join(task_dir)).await.is_err(),
        "清理不得重建本地活跃目录"
    );

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[test]
fn exact_deferred_state_reconciles_without_dirty_upload() {
    let task_dir = ".trellis/tasks/task-a";
    let group = task_group(
        "task-a",
        task_dir,
        &[("task.json", "{\"id\":\"task-a\"}\n")],
    );
    let local_state = file_state_from_group(&group);
    let task_json = format!("{task_dir}/task.json");
    let cursor = Cursor {
        baselines: BTreeMap::from([(task_json.clone(), "0".repeat(64))]),
        deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
        ..Default::default()
    };

    let (dirty, deferred, reconciled) =
        local_sync_state_from_groups(&cursor, &[group], &local_state);

    assert!(dirty.is_empty());
    assert!(deferred.is_empty());
    assert_eq!(reconciled.len(), 1);
    assert!(reconciled.contains(task_dir));
}

#[test]
fn hash_mismatch_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let group = task_group(
        "task-a",
        task_dir,
        &[("task.json", "{\"id\":\"task-a\"}\n")],
    );
    let local_state = file_state_from_group(&group);
    let task_json = format!("{task_dir}/task.json");
    let cursor = Cursor {
        deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
        ..Default::default()
    };
    let server = BTreeMap::from([(task_json, "0".repeat(64))]);

    let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}

#[test]
fn server_missing_file_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let group = task_group(
        "task-a",
        task_dir,
        &[
            ("task.json", "{\"id\":\"task-a\"}\n"),
            ("prd.md", "# task\n"),
        ],
    );
    let local_state = file_state_from_group(&group);
    let task_json = format!("{task_dir}/task.json");
    let cursor = Cursor {
        deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
        ..Default::default()
    };
    let server = BTreeMap::from([(
        task_json,
        local_state[".trellis/tasks/task-a/task.json"].clone(),
    )]);

    let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}

#[test]
fn local_extra_file_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let group = task_group(
        "task-a",
        task_dir,
        &[
            ("task.json", "{\"id\":\"task-a\"}\n"),
            ("prd.md", "# task\n"),
        ],
    );
    let local_state = file_state_from_group(&group);
    let server = BTreeMap::from([(
        format!("{task_dir}/task.json"),
        local_state[".trellis/tasks/task-a/task.json"].clone(),
    )]);
    let cursor = Cursor {
        deferred: BTreeMap::from([(task_dir.to_string(), local_state)]),
        ..Default::default()
    };

    let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}

#[test]
fn empty_server_baseline_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let group = task_group(
        "task-a",
        task_dir,
        &[("task.json", "{\"id\":\"task-a\"}\n")],
    );
    let local_state = file_state_from_group(&group);
    let cursor = Cursor {
        deferred: BTreeMap::from([(task_dir.to_string(), local_state)]),
        ..Default::default()
    };

    let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &BTreeMap::new());

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}

#[test]
fn missing_local_directory_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let task_json = format!("{task_dir}/task.json");
    let deferred_state = BTreeMap::from([(task_json, snapshot_sha256("{\"id\":\"task-a\"}\n"))]);
    let cursor = Cursor {
        baselines: deferred_state.clone(),
        deferred: BTreeMap::from([(task_dir.to_string(), deferred_state.clone())]),
        ..Default::default()
    };

    let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[], &deferred_state);

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}

#[test]
fn changed_deferred_state_still_uses_cursor_baseline_for_dirty() {
    let task_dir = ".trellis/tasks/task-a";
    let task_json = format!("{task_dir}/task.json");
    let group = task_group(
        "task-a",
        task_dir,
        &[("task.json", "{\"id\":\"task-a\",\"title\":\"changed\"}\n")],
    );
    let old_state = BTreeMap::from([(task_json.clone(), snapshot_sha256("{\"id\":\"task-a\"}\n"))]);
    let cursor = Cursor {
        baselines: old_state.clone(),
        deferred: BTreeMap::from([(task_dir.to_string(), old_state.clone())]),
        ..Default::default()
    };

    let (dirty, deferred, reconciled) = local_sync_state_from_groups(&cursor, &[group], &old_state);

    assert_eq!(dirty, vec![task_dir.to_string()]);
    assert!(deferred.is_empty());
    assert!(reconciled.is_empty());
}

#[tokio::test]
async fn initial_sync_treats_foreign_local_task_as_readonly_mirror() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-initial-sync-foreign").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-colleague";
    write_task_json(repo, task_dir, "task-colleague", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "colleague task"]);
    binding.initial_sync_mode = "review".to_string();
    binding.initial_sync_completed = false;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 2,
        "files": [],
        "directoryStatus": 403
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let events: Arc<std::sync::Mutex<Vec<Value>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink: ControlSink = {
        let events = events.clone();
        Arc::new(move |event| events.lock().expect("events").push(event))
    };
    let sync = Arc::new(TaskSync::new(store.clone(), api, sink));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync.pull_task_space("space-1").await.expect("initial sync");

    assert_eq!(result["pendingReview"], false);
    assert_eq!(result["differences"].as_array().map(Vec::len), Some(0));
    assert!(
        events.lock().expect("events").is_empty(),
        "他人任务目录不得作为差异弹窗上报"
    );
    let cursor = sync.read_cursor("space-1").await;
    assert_eq!(
        cursor.readonly_task_dirs.get(task_dir).map(String::as_str),
        Some("FOREIGN_OWNER")
    );
    assert!(changes.lock().await.is_empty(), "只读镜像不得上传");

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn initial_sync_keeps_local_task_the_server_does_not_know() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-initial-sync-unknown").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-mine";
    write_task_json(repo, task_dir, "task-mine", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "my task"]);
    binding.initial_sync_mode = "review".to_string();
    binding.initial_sync_completed = false;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 2,
        "files": [],
        "directoryStatus": 404
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync.pull_task_space("space-1").await.expect("initial sync");

    assert_eq!(result["pendingReview"], true);
    let differences = result["differences"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(differences.len(), 1);
    assert_eq!(differences[0]["type"], "local-only");
    let cursor = sync.read_cursor("space-1").await;
    assert!(cursor.readonly_task_dirs.is_empty());

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[test]
fn initial_sync_keeps_cross_branch_groups_present_locally() {
    let binding = test_binding("space-1");
    let files = [("task.json", r#"{"id":"demo","branch":"codex/demo"}"#)];
    let task_dir = ".trellis/tasks/11-12-demo";
    let local = vec![task_group("demo", task_dir, &files)];

    let mut present = vec![task_group("demo", task_dir, &files)];
    present[0].task_branch = Some("codex/demo".to_string());
    retain_server_groups_for_initial_sync(&binding, &local, &mut present);
    assert_eq!(present.len(), 1, "本地存在的跨分支任务必须保留");

    let other_dir = ".trellis/tasks/11-12-other";
    let mut absent = vec![task_group("other", other_dir, &files)];
    absent[0].task_branch = Some("codex/demo".to_string());
    retain_server_groups_for_initial_sync(&binding, &local, &mut absent);
    assert!(absent.is_empty(), "本地不存在的跨分支任务必须丢弃");
}

#[tokio::test]
async fn pull_zero_revision_skips_readonly_and_foreign_local_tasks() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-pull-zero-filter").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let foreign_dir = ".trellis/tasks/11-25-foreign";
    let readonly_dir = ".trellis/tasks/11-25-downloaded";
    write_task_json(repo, foreign_dir, "foreign-1", "main").await;
    write_task_json(repo, readonly_dir, "downloaded-1", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 0,
                        "revisionGuardVersion": REVISION_GUARD_VERSION,
                        "readonlyTaskDirs": {
                            ".trellis/tasks/11-25-downloaded": "DOWNLOADED"
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 4,
        "files": [],
        "directoryStatus": 403
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync
        .pull_task_space("space-1")
        .await
        .expect("pull zero revision");
    assert_eq!(result["revision"], 4);
    assert!(result.get("pendingReview").is_none());
    assert!(
        changes.lock().await.is_empty(),
        "只读与他人任务不得触发上传"
    );
    let cursor = sync.read_cursor("space-1").await;
    assert_eq!(cursor.revision, 4);
    assert_eq!(
        cursor
            .readonly_task_dirs
            .get(foreign_dir)
            .map(String::as_str),
        Some("FOREIGN_OWNER")
    );
    assert_eq!(
        cursor
            .readonly_task_dirs
            .get(readonly_dir)
            .map(String::as_str),
        Some("DOWNLOADED")
    );
    assert!(requests
        .lock()
        .await
        .iter()
        .any(|req| req == "PUT /api/agent/task-spaces/space-1/cursor"));

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn download_task_marks_readonly_and_suppressed_and_rolls_back_on_write_error() {
    let (root, store, _sync, mut binding) = test_task_sync_fixture("trellis-download-guard").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    tokio::fs::write(repo.join("README.md"), "repo\n")
        .await
        .expect("readme");
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "--no-verify", "-m", "init"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let task_dir = ".trellis/tasks/11-25-remote";
    let task_json = "{\"id\":\"remote-1\",\"title\":\"他人任务\",\"branch\":\"main\"}\n";
    let prd_md = "# 他人任务\n";
    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 2,
        "tasks": [{
            "taskId": "remote-1",
            "taskDir": task_dir
        }],
        "files": [
            snapshot_file_value(&format!("{task_dir}/task.json"), task_json),
            snapshot_file_value(&format!("{task_dir}/prd.md"), prd_md)
        ]
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let downloaded = sync
        .download_task("space-1", "remote-1")
        .await
        .expect("download task");
    assert_eq!(downloaded["taskDir"], task_dir);
    assert_eq!(downloaded["fileCount"], 2);

    let cursor = sync.read_cursor("space-1").await;
    assert_eq!(
        cursor.readonly_task_dirs.get(task_dir).map(String::as_str),
        Some("DOWNLOADED")
    );
    let suppressed = sync.suppressed.lock().await;
    assert_eq!(
        suppressed
            .get(&absolute_task_path(
                &binding,
                &format!("{task_dir}/task.json")
            ))
            .cloned()
            .flatten(),
        Some(snapshot_sha256(task_json))
    );
    assert_eq!(
        suppressed
            .get(&absolute_task_path(&binding, &format!("{task_dir}/prd.md")))
            .cloned()
            .flatten(),
        Some(snapshot_sha256(prd_md))
    );
    drop(suppressed);

    // 模拟写盘失败（非目录文件阻断 .trellis/tasks/11-25-bad 创建）：必须回滚 readonly 与 suppressed
    let bad_dir = ".trellis/tasks/11-25-bad";
    let (bad_url, _bad_changes, _bad_requests, bad_server) = mock_api_server(json!({
        "revision": 2,
        "tasks": [{
            "taskId": "bad-1",
            "taskDir": bad_dir
        }],
        "files": [
            snapshot_file_value(&format!("{bad_dir}/task.json"), "{\"id\":\"bad-1\"}\n")
        ]
    }))
    .await;
    let bad_api = Arc::new(ApiClient::new(&bad_url, None, None).expect("bad api"));
    let bad_sync = Arc::new(TaskSync::new(store.clone(), bad_api, Arc::new(|_| {})));
    let mut bad_binding = binding.clone();
    bad_binding.repo_path = root.join("missing-repo").to_string_lossy().to_string();
    // 让 tasks_root 本身是普通文件，从而在 write_task_directory 时触发 IO 错误并测试回滚。
    tokio::fs::create_dir_all(Path::new(&bad_binding.repo_path).join(".trellis"))
        .await
        .expect(".trellis parent");
    tokio::fs::write(
        Path::new(&bad_binding.repo_path)
            .join(".trellis")
            .join("tasks"),
        "not a dir",
    )
    .await
    .expect("blocking file");
    bad_sync.set_bindings(vec![bad_binding.clone()]).await;

    let err = bad_sync
        .download_task("space-1", "bad-1")
        .await
        .expect_err("write error must fail");
    assert!(!err.message.is_empty());
    let after_rollback = bad_sync.read_cursor("space-1").await;
    assert!(!after_rollback.readonly_task_dirs.contains_key(bad_dir));
    assert!(!bad_sync
        .suppressed
        .lock()
        .await
        .contains_key(&absolute_task_path(
            &bad_binding,
            &format!("{bad_dir}/task.json")
        )));

    server_task.abort();
    bad_server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}
