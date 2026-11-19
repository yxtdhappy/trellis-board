use super::*;
use super::support::*;

#[tokio::test]
async fn heartbeat_wake_fires_only_when_bindings_change() {
    let (_root, _store, sync, binding) = test_task_sync_fixture("heartbeat-wake").await;
    let wake = Arc::new(Notify::new());
    let sync = sync.with_heartbeat_wake(wake.clone());

    let notified = wake.notified();
    tokio::pin!(notified);
    sync.set_bindings(vec![binding.clone()]).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(500), notified)
            .await
            .is_ok(),
        "绑定集合变化必须唤醒心跳"
    );

    let notified = wake.notified();
    tokio::pin!(notified);
    sync.set_bindings(vec![binding]).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(200), notified)
            .await
            .is_err(),
        "绑定集合未变化不应唤醒心跳"
    );
}


#[tokio::test]
async fn binding_sync_waiters_wake_after_last_job() {
    let (root, store, binding, _) =
        exact_deferred_fixture("trellis-binding-sync-waiters").await;
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
    sync.prepare_startup_bindings(vec![binding]).await;

    let first = {
        let sync = sync.clone();
        tokio::spawn(async move { sync.wait_for_binding_sync().await })
    };
    let second = {
        let sync = sync.clone();
        tokio::spawn(async move { sync.wait_for_binding_sync().await })
    };
    tokio::task::yield_now().await;
    sync.finish_binding_sync("space-1").await;

    tokio::time::timeout(Duration::from_secs(1), first)
        .await
        .expect("first waiter")
        .expect("first task");
    tokio::time::timeout(Duration::from_secs(1), second)
        .await
        .expect("second waiter")
        .expect("second task");

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn binding_update_reconciles_existing_tracked_baseline_task() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-baseline-reconcile").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/merged-task";
    let task_json = format!("{task_dir}/task.json");
    let deferred_dir = ".trellis/tasks/deferred-task";
    let deferred_task_json = format!("{deferred_dir}/task.json");
    write_task_json(repo, task_dir, "merged-task", "dev1").await;
    write_task_json(repo, deferred_dir, "deferred-task", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

    binding.baseline_branch = Some("main".to_string());
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
                        "revisionGuardVersion": 1,
                        "sequence": 1,
                        "baselines": {
                            (task_json.clone()): snapshot_sha256(
                                "{\"id\":\"merged-task\",\"branch\":\"dev1\"}\n"
                            )
                        },
                        "deferred": {
                            (deferred_dir): {
                                (deferred_task_json): snapshot_sha256(
                                    "{\"id\":\"deferred-task\",\"branch\":\"dev1\"}\n"
                                )
                            }
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");
    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": []
    }))
    .await;
    let api = Arc::new(
        ApiClient::new(&server_url, None, None).expect("mock api client"),
    );
    let sink: ControlSink = Arc::new(|_| {});
    let api_for_restart = api.clone();
    let sync = Arc::new(
        TaskSync::new(store.clone(), api, sink).with_ownership_index_writer(),
    );

    sync.update_bindings(vec![binding.clone()]).await;

    {
        let changes = changes.lock().await;
        assert_eq!(changes.len(), 1, "启动时应自动补交一次任务快照");
        assert_eq!(changes[0]["mergeEvidence"]["taskId"], "merged-task");
        assert_eq!(changes[0]["mergeEvidence"]["taskDir"], task_dir);
        assert_eq!(changes[0]["mergeEvidence"]["sourceBranch"], "dev1");
        assert_eq!(changes[0]["mergeEvidence"]["baselineBranch"], "main");
        assert_eq!(changes[0]["files"][0]["path"], task_json);
        assert_eq!(changes[0]["observedBranchName"], "main");
    }
    assert!(sync
        .read_cursor("space-1")
        .await
        .pending
        .is_none());
    drop(sync);

    let restarted = Arc::new(
        TaskSync::new(
            store.clone(),
            api_for_restart.clone(),
            Arc::new(|_| {}),
        )
        .with_ownership_index_writer(),
    );
    restarted.update_bindings(vec![binding.clone()]).await;
    assert_eq!(
        changes.lock().await.len(),
        1,
        "同一 HEAD 已完成基线补交后，正常重启不得再次上传"
    );
    drop(restarted);

    run_git(
        repo,
        &["commit", "--allow-empty", "--no-verify", "-m", "advance"],
    );
    let advanced = Arc::new(
        TaskSync::new(store.clone(), api_for_restart, Arc::new(|_| {}))
            .with_ownership_index_writer(),
    );
    advanced.update_bindings(vec![binding]).await;
    assert_eq!(
        changes.lock().await.len(),
        2,
        "HEAD 变化后必须重新补交一次合入证据"
    );
    server_task.abort();

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn bindings_notify_only_after_actual_change() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-binding-events-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let changes_sink = changes.clone();
    let state_sink: StateSink = Arc::new(move || {
        changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_state_sink(state_sink);
    let binding = test_binding("space-1");

    sync.set_bindings(vec![binding.clone()]).await;
    sync.set_bindings(vec![binding.clone()]).await;
    assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);

    let mut heartbeat_metadata = binding.clone();
    heartbeat_metadata.last_synced_at = Some("2026-11-14T00:00:00.000Z".to_string());
    heartbeat_metadata.last_head = Some("abc123".to_string());
    sync.set_bindings(vec![heartbeat_metadata]).await;
    assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);

    let mut changed = binding;
    changed.live_sync_status = "error".to_string();
    sync.set_bindings(vec![changed]).await;
    assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 2);
}


#[tokio::test]
async fn heartbeat_metadata_reuses_selected_bindings_without_git_validation() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-binding-heartbeat-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
    let repo = root.join("repo");
    tokio::fs::create_dir_all(&repo)
        .await
        .expect("repository directory");
    init_git_repo(&repo);
    let mut binding = test_binding("space-1");
    binding.repo_path = repo.to_string_lossy().to_string();
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;
    sync.branch_validations
        .store(0, std::sync::atomic::Ordering::SeqCst);

    let mut heartbeat_metadata = binding.clone();
    heartbeat_metadata.last_synced_at = Some("2026-11-14T00:00:00.000Z".to_string());
    heartbeat_metadata.last_head = Some("abc123".to_string());
    sync.update_bindings(vec![heartbeat_metadata]).await;

    assert_eq!(
        sync.branch_validations
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    run_git(&repo, &["checkout", "-b", "feature"]);
    sync.branch_validations
        .store(0, std::sync::atomic::Ordering::SeqCst);
    sync.update_bindings(vec![binding]).await;
    assert_eq!(
        sync.branch_validations
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn ignores_access_only_watch_events() {
    let access = notify::Event::new(notify::event::EventKind::Access(
        notify::event::AccessKind::Open(notify::event::AccessMode::Read),
    ));
    let modify =
        notify::Event::new(notify::event::EventKind::Modify(notify::event::ModifyKind::Any));

    assert!(!is_relevant_watch_event(&access));
    assert!(is_relevant_watch_event(&modify));
}


#[tokio::test]
async fn task_space_sync_locks_are_shared_per_space_only() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-space-lock-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sync = TaskSync::new(store, api, Arc::new(|_| {}));
    let first = sync.task_space_sync_lock("space-1").await;
    let same = sync.task_space_sync_lock("space-1").await;
    let other = sync.task_space_sync_lock("space-2").await;
    assert!(Arc::ptr_eq(&first, &same));
    assert!(!Arc::ptr_eq(&first, &other));
}


#[tokio::test]
async fn repeated_binding_error_notifies_only_once() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-binding-error-events-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    let binding = test_binding("space-1");
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let changes_sink = changes.clone();
    let state_sink: StateSink = Arc::new(move || {
        changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_state_sink(state_sink);
    sync.set_bindings(vec![binding.clone()]).await;
    changes.store(0, std::sync::atomic::Ordering::SeqCst);
    let error = AgentError::new(code::HTTP_ERROR, "同步失败");

    sync.persist_binding_sync_error(&binding, &error).await;
    sync.persist_binding_sync_error(&binding, &error).await;

    assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);
}


#[test]
fn watcher_only_tracks_task_paths() {
    assert!(is_watched_trellis_path("tasks"));
    assert!(is_watched_trellis_path("tasks/11-12-demo/task.json"));
    assert!(!is_watched_trellis_path(
        "tasks/archive/2026-11/11-12-demo/prd.md"
    ));
    assert!(!is_watched_trellis_path(".developer"));
    assert!(!is_watched_trellis_path("workspace/flyfly6/journal-1.md"));
    assert!(!is_watched_trellis_path("spec/backend/index.md"));
    assert_eq!(
        task_directory_from_relative(".trellis/tasks/11-12-demo/prd.md").as_deref(),
        Some(".trellis/tasks/11-12-demo")
    );
    assert_eq!(
        task_directory_from_relative(".trellis/tasks/archive/2026-11/11-12-demo/prd.md")
            .as_deref(),
        Some(".trellis/tasks/archive/2026-11/11-12-demo")
    );
    assert_eq!(
        active_task_directory_from_relative(
            ".trellis/tasks/archive/2026-11/11-12-demo/prd.md"
        ),
        None
    );
    assert_eq!(
        task_directory_from_relative(".trellis/workspace/a.md"),
        None
    );
}


#[tokio::test]
async fn git_watcher_tracks_head_index_and_refs() {
    let root = std::env::temp_dir().join(format!(
        "trellis-git-watch-{}",
        uuid::Uuid::new_v4()
    ));
    let git_dir = root.join(".git");
    tokio::fs::create_dir_all(git_dir.join("refs/heads"))
        .await
        .expect("git dirs");
    tokio::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n")
        .await
        .expect("head");
    tokio::fs::write(git_dir.join("index"), b"")
        .await
        .expect("index");
    tokio::fs::write(git_dir.join("packed-refs"), "")
        .await
        .expect("packed refs");

    let paths = git_watch_paths(&root).await;
    assert!(paths.iter().any(|(path, _)| path.ends_with("HEAD")));
    assert!(paths.iter().any(|(path, _)| path.ends_with("index")));
    assert!(paths.iter().any(|(path, _)| path.ends_with("packed-refs")));
    assert!(paths.iter().any(|(path, _)| path.ends_with("refs")));
    let _ = tokio::fs::remove_dir_all(root).await;
}

async fn stored_bindings(store: &ConfigStore) -> Vec<AgentBinding> {
    store
        .read_config(false)
        .await
        .expect("read config")
        .expect("config")
        .bindings
}

fn captured_notices(events: &Arc<std::sync::Mutex<Vec<Value>>>) -> Vec<Value> {
    events
        .lock()
        .expect("events")
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("task_sync_notice"))
        .cloned()
        .collect()
}

fn captured_errors(events: &Arc<std::sync::Mutex<Vec<Value>>>) -> Vec<Value> {
    events
        .lock()
        .expect("events")
        .iter()
        .filter(|event| event.get("type").and_then(Value::as_str) == Some("task_sync_error"))
        .cloned()
        .collect()
}

async fn branch_guard_fixture(
    prefix: &str,
) -> (
    PathBuf,
    Arc<ConfigStore>,
    Arc<TaskSync>,
    AgentBinding,
    Arc<std::sync::Mutex<Vec<Value>>>,
) {
    let (root, store, _sync, binding) = test_task_sync_fixture(prefix).await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    tokio::fs::write(repo.join("README.md"), "x\n")
        .await
        .expect("readme");
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "--no-verify", "-m", "init"]);
    run_git(repo, &["checkout", "--quiet", "-b", "feature"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let captured = events.clone();
    let sink: ControlSink = Arc::new(move |value| {
        captured.lock().expect("events").push(value);
    });
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, sink));
    (root, store, sync, binding, events)
}

#[tokio::test]
async fn branch_mismatch_pauses_sync_and_notifies_once() {
    let (root, store, sync, _binding, events) =
        branch_guard_fixture("trellis-branch-guard-pause").await;

    let ids = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert!(ids.is_empty());
    assert!(sync.active_bindings().await.is_empty());
    let pulled = sync.pull_task_space("space-1").await.expect("inactive pull");
    assert_eq!(pulled["skipped"], json!(true));
    assert_eq!(pulled["reason"], json!("BINDING_INACTIVE"));

    let notices = captured_notices(&events);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["errorCode"], json!("BRANCH_MISMATCH"));
    assert_eq!(notices[0]["projectName"], json!("Repo"));
    assert_eq!(notices[0]["branchName"], json!("main"));
    assert!(captured_errors(&events).is_empty());

    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(captured_notices(&events).len(), 1);
    assert!(sync.active_bindings().await.is_empty());

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn switching_between_unbound_branches_does_not_renotify() {
    let (root, store, sync, binding, events) =
        branch_guard_fixture("trellis-branch-guard-other-branch").await;
    let repo = Path::new(&binding.repo_path);

    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(captured_notices(&events).len(), 1);

    run_git(repo, &["checkout", "--quiet", "-b", "feature-b"]);
    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert!(sync.active_bindings().await.is_empty());
    assert_eq!(captured_notices(&events).len(), 1);

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn branch_guard_recovery_allows_a_new_notice() {
    let (root, store, sync, binding, events) =
        branch_guard_fixture("trellis-branch-guard-recovery").await;
    let repo = Path::new(&binding.repo_path);

    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(captured_notices(&events).len(), 1);

    run_git(repo, &["checkout", "--quiet", "main"]);
    let ids = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(ids, vec!["space-1".to_string()]);
    let recovered = stored_bindings(&store).await;
    assert!(recovered[0].last_error_code.is_none());
    assert_eq!(captured_notices(&events).len(), 1);

    run_git(repo, &["checkout", "--quiet", "feature"]);
    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(captured_notices(&events).len(), 2);

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn branch_guard_notice_dedupes_bindings_in_the_same_repo() {
    let (root, store, sync, binding, events) =
        branch_guard_fixture("trellis-branch-guard-dedupe").await;
    let mut second = binding.clone();
    second.local_id = "local-space-2".to_string();
    second.server_binding_id = Some("binding-space-2".to_string());
    second.task_space_id = "space-2".to_string();
    // 同一仓库的双 approved 绑定属于升级前兼容状态：`save_config` 会拒绝新的双绑定写入，
    // 这里直接写配置文件模拟旧版本遗留状态。
    let mut config = test_config(binding.clone());
    config.bindings.push(second.clone());
    store
        .write_json(&store.paths.config_file, &config)
        .await
        .expect("config");

    let _ = sync
        .prepare_startup_bindings(vec![binding, second])
        .await;
    assert!(sync.active_bindings().await.is_empty());
    assert_eq!(captured_notices(&events).len(), 1);

    let _ = sync
        .prepare_startup_bindings(stored_bindings(&store).await)
        .await;
    assert_eq!(captured_notices(&events).len(), 1);

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn non_branch_guard_error_keeps_modal_control_event() {
    let (_root, _store, sync, binding, events) =
        branch_guard_fixture("trellis-branch-guard-modal").await;
    sync.set_bindings(vec![binding]).await;

    sync.report_error(
        "space-1",
        &AgentError::new(code::HTTP_ERROR, "同步失败"),
    )
    .await;

    let errors = captured_errors(&events);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0]["errorCode"], json!("HTTP_ERROR"));
    assert!(captured_notices(&events).is_empty());

    sync.report_error(
        "space-1",
        &AgentError::new(code::BRANCH_MISMATCH, "本地当前分支为 feature，绑定分支为 main"),
    )
    .await;
    assert_eq!(captured_errors(&events).len(), 1);
    assert!(captured_notices(&events).is_empty());
}
