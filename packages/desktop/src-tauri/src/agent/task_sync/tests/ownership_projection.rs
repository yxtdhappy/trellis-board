use super::*;
use super::support::*;

#[tokio::test]
async fn baseline_ownership_ignores_tracked_source_branches_and_reuses_head_tree() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-baseline-ownership").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    for index in 0..17 {
        write_task_json(
            repo,
            &format!(".trellis/tasks/tracked-{index}"),
            &format!("tracked-{index}"),
            "dev1",
        )
        .await;
    }
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(
        repo,
        &["commit", "--no-verify", "-m", "track merged tasks"],
    );
    write_task_json(
        repo,
        ".trellis/tasks/active-probe",
        "active-probe",
        "dev1",
    )
    .await;
    let groups = sync.local_groups(&binding, None).await.expect("local groups");
    assert_eq!(groups.len(), 18);

    binding.baseline_branch = Some("main".to_string());
    binding.branch_name = "dev1".to_string();
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    assert!(sync
        .ownership_paused_task_dirs(&binding, &groups)
        .await
        .is_empty());
    assert!(sync.head_tree_cache.lock().await.is_empty());
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    binding.branch_name = "main".to_string();
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let paused = sync
        .ownership_paused_task_dirs(&binding, &groups)
        .await;
    assert_eq!(
        paused.into_iter().collect::<Vec<_>>(),
        vec![".trellis/tasks/active-probe".to_string()]
    );
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    let associations =
        crate::agent::device::read_local_associations(&store, Some(&sync))
            .await
            .expect("local associations");
    assert_eq!(associations[0].ownership_paused_count, 1);
    assert_eq!(
        associations[0].ownership_paused_task_dirs,
        vec![".trellis/tasks/active-probe".to_string()]
    );
    let (_, first_paths) = sync.head_tree_paths(&binding).await.expect("head tree");
    let (_, second_paths) = sync.head_tree_paths(&binding).await.expect("cached head tree");
    assert_eq!(first_paths.len(), 17);
    assert!(Arc::ptr_eq(&first_paths, &second_paths));
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    run_git(repo, &["checkout", "--quiet", "-b", "dev1"]);
    let cached_paused = sync
        .ownership_paused_task_dirs(&binding, &groups)
        .await;
    assert_eq!(
        cached_paused.into_iter().collect::<Vec<_>>(),
        vec![".trellis/tasks/active-probe".to_string()]
    );
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    {
        let mut cache = sync.head_tree_cache.lock().await;
        let entry = cache
            .get_mut(&binding.task_space_id)
            .expect("cached head tree");
        entry.validated_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
    }
    let stale_paused = sync
        .ownership_paused_task_dirs(&binding, &groups)
        .await;
    assert_eq!(stale_paused.len(), 18);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_projection_caches_local_task_scan() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-projection-cache").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(
        repo,
        ".trellis/tasks/merged-task",
        "merged-task",
        "dev1",
    )
    .await;
    write_task_json(
        repo,
        ".trellis/tasks/active-probe",
        "active-probe",
        "dev1",
    )
    .await;
    run_git(repo, &["add", ".trellis/tasks/merged-task"]);
    run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let (paused, local_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("initial projection");
    assert_eq!(
        paused.iter().cloned().collect::<Vec<_>>(),
        vec![".trellis/tasks/active-probe".to_string()]
    );
    assert_eq!(local_dirs.len(), 2);
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    write_task_json(repo, ".trellis/tasks/new-probe", "new-probe", "dev1").await;
    let (cached_paused, cached_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("cached projection");
    assert_eq!(cached_paused.len(), 1);
    assert_eq!(cached_dirs.len(), 2);

    let stale_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
    {
        let mut cache = sync.ownership_projection_cache.lock().await;
        let entry = cache
            .get_mut(&binding.task_space_id)
            .expect("stale ownership projection");
        entry.validated_at = stale_at;
    }
    let (unchanged_paused, unchanged_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("same-head projection");
    assert_eq!(unchanged_paused.len(), 1);
    assert_eq!(unchanged_dirs.len(), 2);
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    {
        let cache = sync.ownership_projection_cache.lock().await;
        let entry = cache
            .get(&binding.task_space_id)
            .expect("refreshed ownership projection");
        assert!(entry.validated_at > stale_at);
        assert!(entry.validated_at.elapsed() < OWNERSHIP_PROJECTION_CACHE_TTL);
    }

    sync.invalidate_ownership_projection(&binding.task_space_id)
        .await;
    let (refreshed_paused, refreshed_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("invalidated projection");
    let mut refreshed = refreshed_paused.iter().cloned().collect::<Vec<_>>();
    refreshed.sort();
    assert_eq!(
        refreshed,
        vec![
            ".trellis/tasks/active-probe".to_string(),
            ".trellis/tasks/new-probe".to_string()
        ]
    );
    assert_eq!(refreshed_dirs.len(), 3);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_projection_does_not_write_back_after_invalidation() {
    let (root, _store, sync, binding) =
        test_task_sync_fixture("trellis-ownership-projection-race").await;
    let projection_epoch = sync.projection_epoch(&binding.task_space_id).await;

    sync.invalidate_ownership_projection(&binding.task_space_id)
        .await;
    sync.cache_ownership_projection(
        binding.task_space_id.clone(),
        projection_epoch,
        OwnershipProjectionCache {
            local_id: binding.local_id.clone(),
            branch_name: binding.branch_name.clone(),
            baseline_branch: binding.baseline_branch.clone(),
            repo_path: binding.repo_path.clone(),
            head_commit: "stale-head".to_string(),
            head_fingerprint: "stale-fingerprint".to_string(),
            paused: Arc::new(HashSet::new()),
            local_dirs: Arc::new(HashSet::new()),
            validated_at: Instant::now(),
        },
    )
    .await;

    assert!(!sync
        .ownership_projection_cache
        .lock()
        .await
        .contains_key(&binding.task_space_id));
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn unrelated_projection_invalidation_does_not_block_cache_write() {
    let (root, _store, sync, binding) =
        test_task_sync_fixture("trellis-ownership-projection-local-epoch").await;
    let projection_epoch = sync.projection_epoch(&binding.task_space_id).await;

    sync.invalidate_ownership_projection("another-task-space")
        .await;
    sync.cache_ownership_projection(
        binding.task_space_id.clone(),
        projection_epoch,
        OwnershipProjectionCache {
            local_id: binding.local_id.clone(),
            branch_name: binding.branch_name.clone(),
            baseline_branch: binding.baseline_branch.clone(),
            repo_path: binding.repo_path.clone(),
            head_commit: "head".to_string(),
            head_fingerprint: "fingerprint".to_string(),
            paused: Arc::new(HashSet::new()),
            local_dirs: Arc::new(HashSet::new()),
            validated_at: Instant::now(),
        },
    )
    .await;

    assert!(sync
        .ownership_projection_cache
        .lock()
        .await
        .contains_key(&binding.task_space_id));
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_projection_refreshes_paused_after_head_change() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-projection-head").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(
        repo,
        ".trellis/tasks/baseline-task",
        "baseline-task",
        "main",
    )
    .await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "baseline task"]);
    write_task_json(repo, ".trellis/tasks/merged-later", "merged-later", "dev1").await;

    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let (paused, local_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("initial projection");
    assert_eq!(
        paused.iter().cloned().collect::<Vec<_>>(),
        vec![".trellis/tasks/merged-later".to_string()]
    );
    assert_eq!(local_dirs.len(), 2);
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );

    {
        let mut cache = sync.ownership_projection_cache.lock().await;
        let entry = cache
            .get_mut(&binding.task_space_id)
            .expect("cached ownership projection");
        entry.validated_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
    }
    run_git(repo, &["add", ".trellis/tasks/merged-later"]);
    run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

    let (refreshed_paused, refreshed_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("projection after head change");
    assert!(refreshed_paused.is_empty());
    assert_eq!(refreshed_dirs.len(), 2);
    assert_eq!(
        sync.head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_projection_does_not_decode_other_task_files() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-ownership-projection-content").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    tokio::fs::write(
        repo.join(".trellis/tasks/task-a").join("prd.md"),
        [0xff_u8, 0xfe],
    )
    .await
    .expect("invalid utf8 prd");
    let text_only = repo.join(".trellis/tasks/text-only");
    tokio::fs::create_dir_all(&text_only)
        .await
        .expect("text-only directory");
    tokio::fs::write(text_only.join("prd.md"), [0xff_u8, 0xfe])
        .await
        .expect("invalid utf8 text-only prd");
    let ignored = repo.join(".trellis/tasks/ignored");
    tokio::fs::create_dir_all(&ignored)
        .await
        .expect("ignored directory");
    tokio::fs::write(ignored.join("image.bin"), [0xff_u8, 0xfe])
        .await
        .expect("unsupported file");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task files"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let (paused, local_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("projection ignores non-task content");
    assert!(paused.is_empty());
    let mut dirs: Vec<String> = local_dirs.iter().cloned().collect();
    dirs.sort();
    assert_eq!(
        dirs,
        vec![
            ".trellis/tasks/task-a".to_string(),
            ".trellis/tasks/text-only".to_string()
        ]
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_index_reports_invalid_utf8_path() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-ownership-invalid-utf8").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    tokio::fs::write(
        repo.join(".trellis/tasks/task-a").join("prd.md"),
        [0xff_u8, 0xfe],
    )
    .await
    .expect("invalid utf8 prd");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let sync = sync.with_ownership_index_writer();
    let projection_epoch = sync.projection_epoch("space-1").await;
    let error = sync
        .refresh_ownership_index_binding_with_scan(&binding, projection_epoch, true)
        .await
        .expect_err("invalid utf8 task file");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(
        error.message.contains(".trellis/tasks/task-a/prd.md"),
        "message should include relative path: {}",
        error.message
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn persistent_ownership_index_reuses_tasks_without_git() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-index-hit").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    write_task_json(repo, ".trellis/tasks/task-b", "task-b", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let sync = sync.with_ownership_index_writer();
    let (paused, local_dirs) = sync
        .ownership_projection(&binding)
        .await
        .expect("initial persistent projection");
    assert!(paused.is_empty());
    assert_eq!(local_dirs.len(), 2);
    assert!(store.paths.ownership_index_file.exists());

    let reads = sync
        .task_json_reads
        .load(std::sync::atomic::Ordering::SeqCst);
    let scans = sync
        .head_tree_scans
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(reads, 2);
    assert_eq!(scans, 1);
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let restarted =
        TaskSync::new(store.clone(), api, Arc::new(|_| {})).with_ownership_index_writer();
    restarted
        .ownership_validation_started
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (paused, local_dirs) = restarted
        .ownership_projection(&binding)
        .await
        .expect("persistent projection after restart");
    assert!(paused.is_empty());
    assert_eq!(local_dirs.len(), 2);
    assert_eq!(
        restarted
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .task_entries_examined
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .branch_validations
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn temporary_task_sync_never_writes_ownership_index() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-index-read-only").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    binding.live_sync_status = "ready".to_string();
    sync.set_bindings(vec![binding.clone()]).await;
    sync.ownership_projection(&binding)
        .await
        .expect("temporary projection");
    assert!(!store.paths.ownership_index_file.exists());

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn persistent_ownership_index_reparses_only_changed_task_json() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-ownership-index-incremental").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    write_task_json(repo, ".trellis/tasks/task-b", "task-b", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let sync = sync.with_ownership_index_writer();
    sync.ownership_projection(&binding)
        .await
        .expect("initial projection");

    let target = repo.join(".trellis/tasks/task-b/task.json");
    tokio::fs::write(
        &target,
        b"{\"id\":\"task-b\",\"branch\":\"dev1\",\"title\":\"changed\"}\n",
    )
    .await
    .expect("change task json");
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let restarted = TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
    let projection_epoch = restarted.projection_epoch("space-1").await;
    restarted
        .refresh_ownership_index_binding(&binding, projection_epoch)
        .await
        .expect("incremental projection");
    assert_eq!(
        restarted
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        restarted
            .branch_validations
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn warm_local_sync_reuses_all_task_file_hashes_without_reads() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-local-sync-index-hit").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    write_task_json(repo, task_dir, "task-a", "main").await;
    tokio::fs::write(repo.join(task_dir).join("prd.md"), "# 任务\n")
        .await
        .expect("prd");
    tokio::fs::write(repo.join(task_dir).join("implement.jsonl"), "{}\n")
        .await
        .expect("jsonl");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let warmup = sync.with_ownership_index_writer();
    let projection_epoch = warmup.projection_epoch("space-1").await;
    warmup
        .refresh_ownership_index_binding_with_scan(&binding, projection_epoch, true)
        .await
        .expect("warm ownership file index");
    assert_eq!(
        warmup.task_file_reads.load(std::sync::atomic::Ordering::SeqCst),
        3
    );

    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let restarted =
        TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
    let (dirty, _, _) = restarted
        .local_sync_state(&binding, &Cursor::default(), &BTreeMap::new())
        .await
        .expect("warm local sync");
    assert_eq!(dirty, vec![task_dir.to_string()]);
    assert_eq!(
        restarted
            .task_file_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .task_entries_examined
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn local_sync_rehashes_only_changed_file_and_matches_full_scan() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-local-sync-index-incremental").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    write_task_json(repo, task_dir, "task-a", "main").await;
    let prd = repo.join(task_dir).join("prd.md");
    tokio::fs::write(&prd, "# 原内容\n").await.expect("prd");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let warmup = sync.with_ownership_index_writer();
    let projection_epoch = warmup.projection_epoch("space-1").await;
    warmup
        .refresh_ownership_index_binding_with_scan(&binding, projection_epoch, true)
        .await
        .expect("warm ownership file index");
    tokio::fs::write(&prd, "# 原内容已修改\n")
        .await
        .expect("changed prd");

    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let restarted =
        TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
    let cursor = Cursor::default();
    let server_baselines = BTreeMap::new();
    let indexed = restarted
        .local_sync_state(&binding, &cursor, &server_baselines)
        .await
        .expect("incremental local sync");
    assert_eq!(
        restarted
            .task_file_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(
        restarted
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(
        restarted
            .task_entries_examined
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );

    let files = read_local_task_snapshot_files(repo, None)
        .await
        .expect("full local scan");
    let groups = group_task_snapshot_files(&files).expect("full local groups");
    let full = local_sync_state_from_groups(&cursor, &groups, &server_baselines);
    assert_eq!(indexed, full);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn forced_local_sync_detects_change_after_projection_warmup() {
    let (root, store, _sync, binding) =
        test_task_sync_fixture("trellis-local-sync-force-after-warmup").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    write_task_json(repo, task_dir, "task-a", "main").await;
    let prd = repo.join(task_dir).join("prd.md");
    tokio::fs::write(&prd, "# 原内容\n").await.expect("prd");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
    let cursor = Cursor::default();
    let server_baselines = BTreeMap::new();
    sync.local_sync_state(&binding, &cursor, &server_baselines)
        .await
        .expect("initial local sync");

    tokio::fs::write(&prd, "# 原内容已修改\n")
        .await
        .expect("changed prd");
    let reads_before = sync
        .task_file_reads
        .load(std::sync::atomic::Ordering::SeqCst);
    let json_reads_before = sync
        .task_json_reads
        .load(std::sync::atomic::Ordering::SeqCst);
    let entries_before = sync
        .task_entries_examined
        .load(std::sync::atomic::Ordering::SeqCst);

    let (dirty, _, _) = sync
        .local_sync_state(&binding, &cursor, &server_baselines)
        .await
        .expect("forced local sync");
    assert_eq!(dirty, vec![task_dir.to_string()]);
    assert_eq!(
        sync.task_file_reads
            .load(std::sync::atomic::Ordering::SeqCst)
            - reads_before,
        1
    );
    assert_eq!(
        sync.task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst)
            - json_reads_before,
        0
    );
    assert_eq!(
        sync.task_entries_examined
            .load(std::sync::atomic::Ordering::SeqCst)
            - entries_before,
        2
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn associations_read_persistent_index_before_runtime_starts() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-index-device").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    write_task_json(repo, ".trellis/tasks/task-b", "task-b", "dev1").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    binding.baseline_branch = Some("main".to_string());
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    sync.with_ownership_index_writer()
        .ownership_projection(&binding)
        .await
        .expect("projection");
    tokio::fs::remove_dir_all(repo.join(".trellis/tasks/task-a"))
        .await
        .expect("remove task-a");
    tokio::fs::remove_dir_all(repo.join(".trellis/tasks/task-b"))
        .await
        .expect("remove task-b");

    let associations = crate::agent::device::read_local_associations(&store, None)
        .await
        .expect("indexed associations");
    assert_eq!(associations.len(), 1);
    assert_eq!(associations[0].ownership_paused_count, 0);
    assert_eq!(associations[0].deferred_count, 0);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn ownership_index_rejects_schema_and_invalid_paths() {
    let root = std::env::temp_dir().join(format!(
        "trellis-ownership-index-schema-{}",
        uuid::Uuid::new_v4()
    ));
    let path = root.join("ownership-index.json");
    tokio::fs::create_dir_all(&root).await.expect("root");
    tokio::fs::write(&path, br#"{"version":999,"bindings":{}}"#)
        .await
        .expect("schema");
    assert!(load_ownership_index(&path).await.is_none());

    let mut binding = serde_json::Map::new();
    binding.insert("taskSpaceId".into(), json!("space"));
    binding.insert("repoPath".into(), json!("C:/repo"));
    binding.insert("branchName".into(), json!("main"));
    binding.insert(
        "tasks".into(),
        json!({"../escape":{"taskJsonSize":1,"taskJsonSha256":"x"}}),
    );
    binding.insert(
        "files".into(),
        json!({"../escape":{"size":1,"sha256":"x"}}),
    );
    binding.insert("paused".into(), json!(["../escape"]));
    binding.insert("localDirs".into(), json!(["../escape"]));
    let mut bindings = serde_json::Map::new();
    bindings.insert("local".into(), Value::Object(binding));
    tokio::fs::write(
        &path,
        serde_json::to_vec(&json!({"version": OWNERSHIP_INDEX_VERSION, "bindings": bindings}))
            .expect("encode invalid paths"),
    )
    .await
    .expect("invalid paths");
    let index = load_ownership_index(&path)
        .await
        .expect("index remains readable");
    assert!(index.bindings["local"].tasks.is_empty());
    assert!(index.bindings["local"].files.is_empty());
    assert!(index.bindings["local"].paused.is_empty());
    assert!(index.bindings["local"].local_dirs.is_empty());

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn ownership_index_rejects_oversized_tracked_paths() {
    let tracked_paths = (0..=OWNERSHIP_INDEX_MAX_TRACKED_PATHS)
        .map(|index| format!(".trellis/tasks/task-{index}/task.json"))
        .collect();
    let entry = OwnershipIndexBinding {
        task_space_id: "space".to_string(),
        repo_path: "C:/repo".to_string(),
        branch_name: "main".to_string(),
        baseline_branch: Some("main".to_string()),
        head_commit: "a".repeat(40),
        head_fingerprint: "fingerprint".to_string(),
        git_index_fingerprint: "index".to_string(),
        tracked_paths,
        tracked_paths_loaded: true,
        tasks: BTreeMap::new(),
        files: BTreeMap::new(),
        files_complete: false,
        dirty_task_dirs: Vec::new(),
        paused: Vec::new(),
        local_dirs: Vec::new(),
    };
    let index = OwnershipIndex {
        version: OWNERSHIP_INDEX_VERSION,
        bindings: BTreeMap::from([("local".to_string(), entry)]),
    };

    assert!(normalize_index(index).is_none());
}


#[tokio::test]
async fn local_task_scan_rejects_non_directory_trellis_root() {
    let root = std::env::temp_dir().join(format!(
        "trellis-local-scan-root-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&root).await.expect("root");
    tokio::fs::write(root.join(".trellis"), b"not a directory")
        .await
        .expect("trellis file");

    let error = read_local_task_snapshot_files(&root, None)
        .await
        .expect_err("invalid trellis root");
    assert_eq!(error.code, code::MISSING_TRELLIS);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn head_fingerprint_changes_with_current_branch_commit() {
    let (root, _store, _sync, binding) =
        test_task_sync_fixture("trellis-head-fingerprint").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let before = git_head_fingerprint(repo).await.expect("unborn HEAD");
    tokio::fs::write(repo.join("README.md"), "one\n")
        .await
        .expect("readme");
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "--no-verify", "-m", "first"]);
    let after = git_head_fingerprint(repo).await.expect("committed HEAD");

    assert_ne!(before, after);
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn head_diff_only_scans_changed_active_task_directories() {
    let (root, _store, sync, binding) =
        test_task_sync_fixture("trellis-head-diff").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/live", "live", "main").await;
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "--no-verify", "-m", "first"]);
    let first = crate::agent::git::head_commit(
        repo,
        &sync.binding_hooks_dir(&binding),
        false,
    )
    .await
    .expect("first head")
    .expect("first commit");

    write_task_json(repo, ".trellis/tasks/live", "live", "main").await;
    tokio::fs::write(
        repo.join(".trellis/tasks/live/prd.md"),
        "# changed\n",
    )
    .await
    .expect("changed file");
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "--no-verify", "-m", "second"]);
    let second = crate::agent::git::head_commit(
        repo,
        &sync.binding_hooks_dir(&binding),
        false,
    )
    .await
    .expect("second head")
    .expect("second commit");
    let changed = sync
        .task_head_changed_dirs(&binding, &first, &second)
        .await
        .expect("head diff");
    assert_eq!(
        changed,
        HashSet::from([".trellis/tasks/live".to_string()])
    );

    let archive = repo
        .join(".trellis")
        .join("tasks")
        .join("archive")
        .join("2026-11");
    tokio::fs::create_dir_all(&archive)
        .await
        .expect("archive month");
    tokio::fs::rename(
        repo.join(".trellis/tasks/live"),
        archive.join("live"),
    )
    .await
    .expect("archive move");
    tokio::fs::write(archive.join("live").join("screenshot.png"), [0xff, 0xfe])
        .await
        .expect("archive binary");
    run_git(repo, &["add", "-A", "."]);
    run_git(repo, &["commit", "--no-verify", "-m", "archive"]);
    let third = crate::agent::git::head_commit(
        repo,
        &sync.binding_hooks_dir(&binding),
        false,
    )
    .await
    .expect("third head")
    .expect("third commit");
    let archived = sync
        .task_head_changed_dirs(&binding, &second, &third)
        .await
        .expect("archive diff");
    assert_eq!(
        archived,
        HashSet::from([".trellis/tasks/live".to_string()])
    );
    let _ = tokio::fs::remove_dir_all(root).await;
}
