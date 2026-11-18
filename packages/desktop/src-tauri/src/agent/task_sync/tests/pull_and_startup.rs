use super::*;
use super::support::*;

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

    let result = sync
        .repair_revision_guard(&binding)
        .await
        .expect("repair");
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
    let (root, store, binding, task_dir) =
        exact_deferred_fixture("trellis-startup-activate").await;
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));

    let task_space_ids = sync
        .prepare_startup_bindings(vec![binding])
        .await;

    assert_eq!(task_space_ids, vec!["space-1".to_string()]);
    assert_eq!(sync.active_bindings().await.len(), 1);
    assert!(requests.lock().await.is_empty());
    let (events, receiver) = mpsc::unbounded_channel();
    let watcher_sync = sync.clone();
    let watch_task = tokio::spawn(async move { watcher_sync.watch_loop(receiver).await });
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
    let (root, store, binding, task_dir) =
        exact_deferred_fixture("trellis-deferred-startup").await;
    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
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
async fn unchanged_startup_pull_skips_second_ownership_validation() {
    let (root, store, binding, _) =
        exact_deferred_fixture("trellis-startup-single-validation").await;
    let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding]).await;

    assert!(!sync.pull_and_report("space-1").await);

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
    let task_hash =
        snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
    write_deferred_cursor(&store, &task_dir, &task_hash, &task_hash).await;
    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
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
    let old_hash =
        snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"main\"}\n");
    write_task_json(repo, &task_dir, "task-a", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "source task"]);
    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let changed_hash =
        snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
    write_deferred_cursor(&store, &task_dir, &changed_hash, &old_hash).await;
    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
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
    let (root, store, binding, task_dir) =
        exact_deferred_fixture("trellis-deferred-pull").await;
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
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
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

    let (dirty, deferred, _) =
        local_sync_state_from_groups(&cursor, &[group], &BTreeMap::new());

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
}


#[test]
fn missing_local_directory_keeps_deferred_protected() {
    let task_dir = ".trellis/tasks/task-a";
    let task_json = format!("{task_dir}/task.json");
    let deferred_state = BTreeMap::from([(
        task_json,
        snapshot_sha256("{\"id\":\"task-a\"}\n"),
    )]);
    let cursor = Cursor {
        baselines: deferred_state.clone(),
        deferred: BTreeMap::from([(task_dir.to_string(), deferred_state.clone())]),
        ..Default::default()
    };

    let (dirty, deferred, _) =
        local_sync_state_from_groups(&cursor, &[], &deferred_state);

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
    let old_state =
        BTreeMap::from([(task_json.clone(), snapshot_sha256("{\"id\":\"task-a\"}\n"))]);
    let cursor = Cursor {
        baselines: old_state.clone(),
        deferred: BTreeMap::from([(task_dir.to_string(), old_state.clone())]),
        ..Default::default()
    };

    let (dirty, deferred, reconciled) =
        local_sync_state_from_groups(&cursor, &[group], &old_state);

    assert_eq!(dirty, vec![task_dir.to_string()]);
    assert!(deferred.is_empty());
    assert!(reconciled.is_empty());
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
