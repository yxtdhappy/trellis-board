use super::*;
use super::support::*;

#[test]
fn required_sequence_only_reads_conflict_details() {
    let mut error = AgentError::new(code::HTTP_ERROR, "clientSequence 必须严格递增");
    error.server_code = Some("CONFLICT".into());
    error.details = Some(json!({ "requiredClientSequence": 1_712_345_678_900u64 }));
    assert_eq!(required_client_sequence(&error), Some(1_712_345_678_900));
    // 非 CONFLICT、缺失或非正数的 details 一律不当作序号恢复信号。
    assert_eq!(
        required_client_sequence(&AgentError::new(code::HTTP_ERROR, "x")),
        None
    );
    error.server_code = Some("TASK_FILE_CONFLICT".into());
    assert_eq!(required_client_sequence(&error), None);
    error.server_code = Some("CONFLICT".into());
    error.details = Some(json!({ "requiredClientSequence": 0 }));
    assert_eq!(required_client_sequence(&error), None);
}


#[test]
fn branch_guard_codes_cover_branch_failures() {
    assert!(is_branch_guard_code(code::BRANCH_MISMATCH));
    assert!(is_branch_guard_code(code::DETACHED_HEAD));
    assert!(!is_branch_guard_code(code::LOCAL_DIRTY));
}


#[test]
fn baseline_branch_change_invalidates_binding_cache() {
    let current = test_binding("space-main");
    let mut next = current.clone();
    next.baseline_branch = Some("main".to_string());
    assert!(!binding_entry_unchanged(&current, &next));
}


#[test]
fn pending_batch_preserves_merge_evidence() {
    let evidence = json!({
        "version": 1,
        "type": "tracked-in-head",
        "taskId": "task-a",
        "taskDir": ".trellis/tasks/task-a",
        "trackedPath": ".trellis/tasks/task-a/task.json",
        "sourceBranch": "dev1",
        "baselineBranch": "dev",
        "headCommit": "a".repeat(40),
    });
    let pending = parse_pending_batch(&json!({
        "batchId": "batch-1",
        "clientSequence": 3,
        "files": [{ "path": ".trellis/tasks/task-a/task.json" }],
        "mergeEvidence": evidence.clone(),
    }))
    .expect("pending batch");
    assert_eq!(pending.merge_evidence, Some(evidence));
}


#[test]
fn cursor_defaults_new_guard_fields_and_bounds_rejected_summaries() {
    let legacy = cursor_from_entry(&json!({
        "revision": 12,
        "sequence": 9,
        "pendingRejected": {
            ".trellis/tasks/task-a": {
                "batchId": "batch-a",
                "clientSequence": 8,
                "reason": "TASK_MERGE_EVIDENCE_REQUIRED",
                "blockedAt": "2026-11-18T00:00:00.000Z"
            }
        }
    }));
    assert_eq!(legacy.revision_guard_version, 0);
    let rejected = legacy
        .pending_rejected
        .get(".trellis/tasks/task-a")
        .expect("rejected summary");
    assert_eq!(rejected.reason, "TASK_MERGE_EVIDENCE_REQUIRED");
    assert_eq!(rejected.created_at, rejected.blocked_at);

    let mut summaries = BTreeMap::new();
    for index in 0..55 {
        summaries.insert(
            format!(".trellis/tasks/task-{index}"),
            PendingRejection {
                batch_id: format!("batch-{index}"),
                client_sequence: index as u64 + 1,
                reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                created_at: format!("2026-11-18T00:00:{index:02}.000Z"),
                blocked_at: format!("2026-11-18T00:00:{index:02}.000Z"),
            },
        );
    }
    trim_pending_rejections(&mut summaries);
    assert_eq!(summaries.len(), PENDING_REJECTED_LIMIT);
    assert!(!summaries.contains_key(".trellis/tasks/task-0"));
    assert!(summaries.contains_key(".trellis/tasks/task-54"));
}


#[test]
fn pending_rejection_classifier_is_explicit_only() {
    for value in [
        "TASK_OWNERSHIP_REQUIRED",
        "TASK_OWNERSHIP_MISMATCH",
        "TASK_MERGE_EVIDENCE_REQUIRED",
        "TASK_MERGE_EVIDENCE_INVALID",
        "TASK_OWNED_BY_BASELINE",
    ] {
        assert!(is_explicit_pending_rejection(value), "{value}");
    }
    for value in ["NETWORK_ERROR", "HTTP_ERROR", "TASK_FILE_CONFLICT", "CONFLICT"] {
        assert!(!is_explicit_pending_rejection(value), "{value}");
    }
}


#[test]
fn pending_skip_continues_only_for_explicit_rejection() {
    assert!(skipped_for_explicit_pending_rejection(&json!({
        "skipped": true,
        "reason": "TASK_OWNERSHIP_REQUIRED"
    })));
    assert!(skipped_for_explicit_pending_rejection(&json!({
        "skipped": true,
        "reason": "TASK_OWNED_BY_BASELINE"
    })));
    for reason in [
        "TASK_CONTROL_INACTIVE",
        "TASK_CONTROL_MISSING",
        "TASK_ARCHIVED",
        "TASK_WRITE_FORBIDDEN",
        "TASK_FILE_CONFLICT",
    ] {
        assert!(
            !skipped_for_explicit_pending_rejection(&json!({
                "skipped": true,
                "reason": reason
            })),
            "{reason}"
        );
    }
    assert!(!skipped_for_explicit_pending_rejection(&json!({
        "skipped": false,
        "reason": "TASK_OWNERSHIP_REQUIRED"
    })));
}


#[tokio::test]
async fn pending_replay_reuses_snapshot_and_does_not_advance_applied_revision() {
    let fixture = replay_fixture("trellis-pending-replay", None).await;
    let pending = fixture
        .sync
        .read_cursor("space-1")
        .await
        .pending
        .expect("pending");
    let result = fixture
        .sync
        .retry_pending_batch(&fixture.binding, pending)
        .await
        .expect("replay")
        .expect("replay result");
    assert_eq!(result["revision"], 20);
    let sent = fixture
        .changes
        .lock()
        .await
        .first()
        .cloned()
        .expect("upload request");
    assert_eq!(sent["batchId"], "pending-batch");
    assert_eq!(sent["clientSequence"], 7);
    assert_eq!(sent["observedBranchName"], "main");
    assert_eq!(sent["files"], json!(fixture.old_files));
    assert_eq!(sent["mergeEvidence"], fixture.evidence);

    let cursor = fixture.store.read_task_cursors().await;
    assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 10);
    assert!(cursor["taskSpaces"]["space-1"].get("pending").is_none());

    fixture.server_task.abort();
    let _ = tokio::fs::remove_dir_all(fixture.root).await;
}


#[tokio::test]
async fn explicit_pending_rejection_clears_body_and_records_bounded_summary() {
    let fixture = replay_fixture(
        "trellis-pending-rejected",
        Some(json!({
            "status": 409,
            "payload": {
                "error": "任务分支尚未确定",
                "code": "TASK_OWNERSHIP_REQUIRED",
                "details": { "taskDir": ".trellis/tasks/task-a" }
            }
        })),
    )
    .await;
    let pending = fixture
        .sync
        .read_cursor("space-1")
        .await
        .pending
        .expect("pending");
    let result = fixture
        .sync
        .retry_pending_batch(&fixture.binding, pending)
        .await
        .expect("rejected result")
        .expect("rejected response");
    assert_eq!(result["skipped"], true);
    assert_eq!(result["reason"], "TASK_OWNERSHIP_REQUIRED");

    let cursor = fixture.store.read_task_cursors().await;
    let space = &cursor["taskSpaces"]["space-1"];
    assert!(space.get("pending").is_none());
    assert_eq!(
        space["pendingRejected"][".trellis/tasks/task-a"]["reason"],
        "TASK_OWNERSHIP_REQUIRED"
    );
    assert!(
        space["pendingRejected"][".trellis/tasks/task-a"]
            .get("files")
            .is_none()
    );
    assert_eq!(
        space["ownershipPending"][".trellis/tasks/task-a"]["reason"],
        "TASK_OWNERSHIP_REQUIRED"
    );
    assert!(fixture
        .requests
        .lock()
        .await
        .iter()
        .any(|request| request.ends_with("/ownership-inbox")));

    fixture.server_task.abort();
    let _ = tokio::fs::remove_dir_all(fixture.root).await;
}


#[tokio::test]
async fn explicit_pending_rejection_does_not_block_following_task_upload() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-pending-rejected-following-task").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let blocked_dir = ".trellis/tasks/task-a";
    let next_dir = ".trellis/tasks/task-b";
    let next_task_json = format!("{next_dir}/task.json");
    write_task_json(repo, blocked_dir, "task-a", "main").await;
    write_task_json(repo, next_dir, "task-b", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let pending_content = "{\"id\":\"task-a\",\"branch\":null}\n";
    let pending_files = vec![json!({
        "path": format!("{blocked_dir}/task.json"),
        "content": pending_content,
        "sha256": snapshot_sha256(pending_content),
    })];
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 10,
                        "revisionGuardVersion": 1,
                        "sequence": 7,
                        "pending": {
                            "batchId": "pending-batch",
                            "clientSequence": 7,
                            "files": pending_files
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    let (server_url, changes, _requests, server_task) = mock_api_server(json!({
        "revision": 10,
        "files": [],
        "writeResponses": [
            {
                "status": 409,
                "payload": {
                    "error": "任务分支尚未确定",
                    "code": "TASK_OWNERSHIP_REQUIRED"
                }
            },
            {
                "status": 200,
                "payload": { "revision": 21 }
            }
        ]
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync
        .upload_directories(
            &binding,
            &[blocked_dir.to_string(), next_dir.to_string()],
            false,
            None,
        )
        .await
        .expect("upload");
    assert_eq!(result["committedRevision"], 21);

    let sent = changes.lock().await.clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["batchId"], "pending-batch");
    assert_eq!(sent[0]["files"][0]["content"], pending_content);
    assert_eq!(sent[1]["files"][0]["path"], next_task_json);

    let cursor = store.read_task_cursors().await;
    let space = &cursor["taskSpaces"]["space-1"];
    assert!(space.get("pending").is_none());
    assert_eq!(
        space["pendingRejected"][blocked_dir]["reason"],
        "TASK_OWNERSHIP_REQUIRED"
    );
    assert!(space["baselines"].get(next_task_json.as_str()).is_some());
    assert_eq!(space["revision"], 10);

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn revision_guard_repairs_once_without_overwriting_conflicted_local_task() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-revision-guard").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    let task_path = repo.join(task_dir).join("task.json");
    let local_content =
        "{\"id\":\"task-a\",\"branch\":\"main\",\"title\":\"本地版本\"}\n";
    tokio::fs::create_dir_all(task_path.parent().expect("parent"))
        .await
        .expect("task dir");
    tokio::fs::write(&task_path, local_content)
        .await
        .expect("local task");
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let previous_baseline = "b".repeat(64);
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 1,
                        "revisionGuardVersion": 0,
                        "sequence": 1,
                        "baselines": {
                            ".trellis/tasks/task-a/task.json": previous_baseline.clone()
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");
    let remote_content =
        "{\"id\":\"task-a\",\"branch\":\"main\",\"title\":\"服务端版本\"}\n";
    let (server_url, _changes, requests, server_task) = mock_api_server(json!({
        "revision": 1,
        "files": [
            snapshot_file_value(".trellis/tasks/task-a/task.json", remote_content)
        ]
    }))
    .await;
    let api =
        Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync
        .repair_revision_guard(&binding)
        .await
        .expect("repair");
    assert_eq!(result["repaired"], true);
    assert_eq!(
        tokio::fs::read_to_string(&task_path)
            .await
            .expect("local content"),
        local_content
    );
    let cursor = store.read_task_cursors().await;
    assert_eq!(
        cursor["taskSpaces"]["space-1"]["revisionGuardVersion"],
        REVISION_GUARD_VERSION
    );
    assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 1);
    assert!(cursor["taskSpaces"]["space-1"]["deferred"]
        .get(task_dir)
        .is_some());
    assert_eq!(
        cursor["taskSpaces"]["space-1"]["baselines"][".trellis/tasks/task-a/task.json"],
        previous_baseline
    );

    let snapshot_requests = requests
        .lock()
        .await
        .iter()
        .filter(|request| request.contains("/snapshot?"))
        .count();
    let second = sync
        .repair_revision_guard(&binding)
        .await
        .expect("guard current");
    assert_eq!(second["reason"], "REVISION_GUARD_CURRENT");
    assert_eq!(
        requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/snapshot?"))
            .count(),
        snapshot_requests
    );

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn upload_request_carries_persisted_fencing_fields() {
    let files = vec![json!({
        "path": ".trellis/tasks/task-a/task.json",
        "content": "{\"id\":\"task-a\",\"branch\":null}\n",
        "sha256": snapshot_sha256("{\"id\":\"task-a\",\"branch\":null}\n"),
    })];
    let evidence = json!({
        "version": 1,
        "type": "tracked-in-head",
        "taskId": "task-a",
        "taskDir": ".trellis/tasks/task-a",
        "trackedPath": ".trellis/tasks/task-a/task.json",
        "sourceBranch": "main",
        "baselineBranch": "team-board",
        "headCommit": "a".repeat(40),
    });
    let batch = PendingBatch {
        batch_id: "batch-1".to_string(),
        client_sequence: 7,
        files: files.clone(),
        merge_evidence: Some(evidence.clone()),
        created_at: "2026-11-18T00:00:00.000Z".to_string(),
    };
    let request = build_upload_request(
        &batch,
        8,
        "main",
        Some(&UploadFence {
            task_version: 4,
            lease_token: "lease-token".to_string(),
        }),
    );
    assert_eq!(request["taskVersion"], 4);
    assert_eq!(request["leaseToken"], "lease-token");
    assert_eq!(request["files"][0]["path"], ".trellis/tasks/task-a/task.json");
    assert_eq!(request["files"], json!(files));
    assert_eq!(request["mergeEvidence"], evidence);
    assert_eq!(request["batchId"], "batch-1");
    assert_eq!(request["clientSequence"], 8);
    assert_eq!(request["observedBranchName"], "main");
}


#[test]
fn first_upload_response_control_supplies_persisted_execution_key() {
    let control = TaskControl::from_control_value(&json!({
        "executionTaskKey": "space-1::task-a",
        "taskId": "task-a",
        "relativeDir": ".trellis/tasks/task-a",
        "title": "任务 A",
        "state": "materialized",
        "taskVersion": 1
    }))
    .expect("control");
    assert_eq!(
        response_control_execution_task_key(None, &control)
            .expect("response key")
            .as_str(),
        "space-1::task-a"
    );
    assert!(response_control_execution_task_key(Some("space-1::other"), &control).is_err());
}


#[tokio::test]
async fn persistent_projection_does_not_bypass_branch_guard() {
    let (root, store, sync, mut binding) =
        test_task_sync_fixture("trellis-ownership-index-branch-guard").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    sync.with_ownership_index_writer()
        .ownership_projection(&binding)
        .await
        .expect("cached projection");
    run_git(repo, &["checkout", "--quiet", "-b", "feature"]);

    binding.live_sync_status = "ready".to_string();
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
    let restarted = TaskSync::new(store, api, Arc::new(|_| {}));
    let error = restarted
        .assert_binding_branch(&binding)
        .await
        .expect_err("stale ownership cache must not bypass branch guard");
    assert_eq!(error.code, code::BRANCH_MISMATCH);

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn rejects_oversized_batch_before_pending_write_and_retry() {
    let root = std::env::temp_dir().join(format!(
        "trellis-upload-limit-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
    store.ensure_directories().await.expect("directories");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = TaskSync::new(store.clone(), api, sink);
    let binding = test_binding("space-1");
    let files = batch_file_values(TASK_SNAPSHOT_MAX_FILES + 1);

    let write_error = sync
        .upload_persisted_batch(&binding, &Cursor::default(), files.clone(), None)
        .await
        .expect_err("新批次应在写入 pending 前拒绝");
    assert!(write_error.message.contains("1024"));
    assert!(!store.paths.task_cursors_file.exists(), "超限新批次不得留下 pending");

    let retry_error = sync
        .retry_pending_batch(
            &binding,
            PendingBatch {
                batch_id: "oversized-batch".to_string(),
                client_sequence: 1,
                files,
                merge_evidence: None,
                created_at: "2026-11-18T00:00:00.000Z".to_string(),
            },
        )
        .await
        .expect_err("超限 pending 应在重试前拒绝");
    assert!(retry_error.message.contains("1024"));
    assert!(!store.paths.task_cursors_file.exists(), "超限 pending 重试不得产生新写入");

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn archive_pending_batch_is_migrated_without_reusing_batch_id() {
    let archive_only = PendingBatch {
        batch_id: "batch.archive-only".into(),
        client_sequence: 10,
        files: vec![snapshot_file_value(
            ".trellis/tasks/archive/2026-11/a/prd.md",
            "old",
        )],
        merge_evidence: None,
        created_at: "2026-11-18T00:00:00.000Z".to_string(),
    };
    assert!(migrate_archive_pending_batch(archive_only, 10).is_none());

    let mut deletion = snapshot_file_value(".trellis/tasks/a/prd.md", "");
    deletion["deleted"] = json!(true);
    let mixed = PendingBatch {
        batch_id: "batch.archive-mixed".into(),
        client_sequence: 10,
        files: vec![
            deletion,
            snapshot_file_value(".trellis/tasks/archive/2026-11/a/prd.md", "old"),
        ],
        merge_evidence: Some(json!({
            "taskDir": ".trellis/tasks/archive/2026-11/a"
        })),
        created_at: "2026-11-18T00:00:00.000Z".to_string(),
    };
    let migrated = migrate_archive_pending_batch(mixed, 10).expect("active deletion");
    assert_ne!(migrated.batch_id, "batch.archive-mixed");
    assert!(migrated.client_sequence > 10);
    assert_eq!(migrated.files.len(), 1);
    assert!(migrated.merge_evidence.is_none());
    assert_eq!(
        migrated.files[0]["path"],
        json!(".trellis/tasks/a/prd.md")
    );
}


#[test]
fn cursor_sanitizes_archive_paths() {
    let entry = json!({
        "revision": 8,
        "revisionGuardVersion": 1,
        "sequence": 9,
        "baselines": {
            ".trellis/tasks/a/prd.md": "a".repeat(64),
            ".trellis/tasks/archive/2026-11/b/prd.md": "b".repeat(64)
        },
        "deferred": {
            ".trellis/tasks/archive/2026-11/b": {
                ".trellis/tasks/archive/2026-11/b/prd.md": "b".repeat(64)
            }
        },
        "ownershipPending": {
            ".trellis/tasks/archive/2026-11/b": {
                "fingerprint": "c".repeat(64)
            }
        },
        "conflictBlocked": {
            ".trellis/tasks/archive/2026-11/b": {
                "conflictId": "conflict-1"
            }
        },
        "pendingRejected": {
            ".trellis/tasks/archive/2026-11/b": {
                "batchId": "batch-1",
                "clientSequence": 9,
                "reason": "TASK_OWNERSHIP_REQUIRED",
                "blockedAt": "2026-11-18T00:00:00.000Z"
            }
        }
    });
    let cursor = cursor_from_entry(&entry);
    assert_eq!(cursor.revision_guard_version, 1);
    assert!(cursor.baselines.contains_key(".trellis/tasks/a/prd.md"));
    assert!(!cursor
        .baselines
        .contains_key(".trellis/tasks/archive/2026-11/b/prd.md"));
    assert!(cursor.deferred.is_empty());
    assert!(cursor.ownership_pending.is_empty());
    assert!(cursor.conflict_blocked.is_empty());
    assert!(cursor.pending_rejected.is_empty());
}


#[test]
fn event_revision_only_skips_completed_unchanged_sync() {
    assert!(!should_pull_for_event(true, false, 10, Some(10), false));
    assert!(!should_pull_for_event(true, false, 10, Some(9), false));
    assert!(should_pull_for_event(true, false, 10, Some(11), false));
    assert!(should_pull_for_event(false, false, 10, Some(10), false));
    assert!(should_pull_for_event(true, true, 10, Some(10), false));
    assert!(should_pull_for_event(true, false, 10, Some(10), true));
    assert!(should_pull_for_event(true, false, 10, None, false));
}


#[test]
fn cursor_patch_only_reports_real_changes() {
    let mut cursor = Cursor::default();
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            revision: Some(10),
            revision_guard_version: Some(REVISION_GUARD_VERSION),
            sequence: Some(2),
            ..Default::default()
        },
    );

    let baselines = BTreeMap::from([(".trellis/tasks/a/prd.md".to_string(), "a".repeat(64))]);
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            baselines: Some(baselines.clone()),
            ..Default::default()
        },
    );

    let deferred = BTreeMap::from([(
        ".trellis/tasks/a".to_string(),
        BTreeMap::from([(".trellis/tasks/a/prd.md".to_string(), "b".repeat(64))]),
    )]);
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            deferred: Some(deferred.clone()),
            ..Default::default()
        },
    );

    let ownership = BTreeMap::from([(".trellis/tasks/a".to_string(), "fingerprint".to_string())]);
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            ownership_pending: Some(ownership.clone()),
            ..Default::default()
        },
    );

    let blocked = BTreeMap::from([(".trellis/tasks/a".to_string(), "conflict-1".to_string())]);
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            conflict_blocked: Some(blocked.clone()),
            ..Default::default()
        },
    );

    let rejected = BTreeMap::from([(
        ".trellis/tasks/a".to_string(),
        PendingRejection {
            batch_id: "batch-rejected".to_string(),
            client_sequence: 3,
            reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
            created_at: "2026-11-18T00:00:00.000Z".to_string(),
            blocked_at: "2026-11-18T00:01:00.000Z".to_string(),
        },
    )]);
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            pending_rejected: Some(rejected.clone()),
            ..Default::default()
        },
    );

    let pending = PendingBatch {
        batch_id: "batch-1".to_string(),
        client_sequence: 3,
        files: vec![json!({ "path": ".trellis/tasks/a/prd.md" })],
        merge_evidence: None,
        created_at: "2026-11-18T00:00:00.000Z".to_string(),
    };
    assert_cursor_patch_changes_once(
        &mut cursor,
        || CursorPatch {
            pending: Some(Some(pending.clone())),
            ..Default::default()
        },
    );
    assert!(apply_cursor_patch(
        &mut cursor,
        &CursorPatch {
            pending: Some(None),
            ..Default::default()
        }
    ));
}


#[test]
fn task_dir_removals_clear_only_target_directory_state() {
    let task_dir = ".trellis/tasks/task-a";
    // 同前缀的兄弟目录必须保留，证明按 `{task_dir}/` 精确前缀移除。
    let sibling = ".trellis/tasks/task-a-copy";
    let other = ".trellis/tasks/task-b";
    let hash = |seed: char| seed.to_string().repeat(64);
    let mut cursor = Cursor {
        baselines: BTreeMap::from([
            (format!("{task_dir}/task.json"), hash('a')),
            (format!("{task_dir}/prd.md"), hash('b')),
            (format!("{sibling}/task.json"), hash('c')),
            (format!("{other}/task.json"), hash('d')),
        ]),
        deferred: BTreeMap::from([
            (
                task_dir.to_string(),
                BTreeMap::from([(format!("{task_dir}/task.json"), hash('a'))]),
            ),
            (
                other.to_string(),
                BTreeMap::from([(format!("{other}/task.json"), hash('d'))]),
            ),
        ]),
        ownership_pending: BTreeMap::from([(task_dir.to_string(), hash('e'))]),
        pending_rejected: BTreeMap::from([(
            task_dir.to_string(),
            PendingRejection {
                batch_id: "batch-1".to_string(),
                client_sequence: 3,
                reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                created_at: "2026-11-19T00:00:00.000Z".to_string(),
                blocked_at: "2026-11-19T00:00:01.000Z".to_string(),
            },
        )]),
        ..Default::default()
    };
    let patch = || CursorPatch {
        task_dir_removals: Some(BTreeSet::from([task_dir.to_string()])),
        ..Default::default()
    };

    assert!(apply_cursor_patch(&mut cursor, &patch()));
    assert!(!cursor.baselines.contains_key(&format!("{task_dir}/task.json")));
    assert!(!cursor.baselines.contains_key(&format!("{task_dir}/prd.md")));
    assert!(!cursor.deferred.contains_key(task_dir));
    assert!(cursor.baselines.contains_key(&format!("{sibling}/task.json")));
    assert_eq!(
        cursor.baselines.get(&format!("{other}/task.json")),
        Some(&hash('d'))
    );
    assert!(cursor.deferred.contains_key(other));
    // 服务端待归属账本由 cleanup_missing_ownership_inbox 配套删除，本 patch 不直接清理。
    assert!(cursor.ownership_pending.contains_key(task_dir));
    assert!(cursor.pending_rejected.contains_key(task_dir));
    assert!(!apply_cursor_patch(&mut cursor, &patch()), "重复 patch 不得产生写入");
}


#[test]
fn grouped_baselines_keep_task_scope() {
    let task_a_dir = ".trellis/tasks/task-a";
    let task_b_dir = ".trellis/tasks/task-b";
    let task_a = task_group(
        "task-a",
        task_a_dir,
        &[("task.json", "{\"id\":\"task-a\"}\n")],
    );
    let task_b = task_group(
        "task-b",
        task_b_dir,
        &[("task.json", "{\"id\":\"task-b\"}\n")],
    );
    let task_a_state = file_state_from_group(&task_a);
    let task_b_state = file_state_from_group(&task_b);
    let cursor = Cursor {
        baselines: task_a_state.clone(),
        deferred: BTreeMap::from([(task_b_dir.to_string(), task_b_state)]),
        ..Default::default()
    };
    let server_baselines = task_a_state;

    let (dirty, deferred, reconciled) =
        local_sync_state_from_groups(&cursor, &[task_a, task_b], &server_baselines);

    assert!(dirty.is_empty());
    assert_eq!(deferred, cursor.deferred);
    assert!(reconciled.is_empty());
}


#[test]
fn detach_pending_is_excluded_and_selection_identity_is_stable() {
    let selected = test_binding("space-1");
    let mut pending = test_binding("space-2");
    pending.detach_pending = true;
    let map = approved_bindings(vec![selected.clone(), pending]);
    assert_eq!(map.len(), 1);
    assert!(binding_selection_unchanged(
        &map,
        &approved_bindings(vec![selected])
    ));
}


#[tokio::test]
async fn remove_task_cursor_only_deletes_selected_task_space() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-cursor-remove-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    store.ensure_directories().await.expect("directories");
    store
        .write_atomic(
            &store.paths.task_cursors_file,
            br#"{"version":3,"taskSpaces":{"space-1":{"revision":1},"space-2":{"revision":2}}}"#,
        )
        .await
        .expect("cursor file");
    let api = Arc::new(
        ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"),
    );
    let sink: ControlSink = Arc::new(|_| {});
    let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let changes_sink = changes.clone();
    let state_sink: StateSink = Arc::new(move || {
        changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let sync = TaskSync::new(store.clone(), api, sink).with_state_sink(state_sink);
    sync.remove_task_cursor("space-1").await.expect("remove");
    let state = store.read_task_cursors().await;
    assert!(state["taskSpaces"].get("space-1").is_none());
    assert_eq!(state["taskSpaces"]["space-2"]["revision"], 2);
    assert_eq!(
        changes.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}


#[tokio::test]
async fn write_cursor_skips_unchanged_patch() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-cursor-noop-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    store.ensure_directories().await.expect("directories");
    let binding = test_binding("space-1");
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let initial = json!({
        "version": CURSOR_VERSION,
        "taskSpaces": {
            "space-1": {
                "revision": 10,
                "sequence": 2,
                "updatedAt": "2026-11-13T00:00:00.000Z",
                "baselines": {
                    ".trellis/tasks/a/prd.md": "a".repeat(64)
                },
                "deferred": {
                    ".trellis/tasks/a": {
                        ".trellis/tasks/a/prd.md": "b".repeat(64)
                    }
                }
            }
        }
    });
    store
        .write_json(&store.paths.task_cursors_file, &initial)
        .await
        .expect("cursor file");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let state_changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let state_changes_sink = state_changes.clone();
    let state_sink: StateSink = Arc::new(move || {
        state_changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    });
    let sync = TaskSync::new(store.clone(), api, sink).with_state_sink(state_sink);
    sync.set_bindings(vec![binding]).await;
    state_changes.store(0, std::sync::atomic::Ordering::SeqCst);

    let before = tokio::fs::read(&store.paths.task_cursors_file)
        .await
        .expect("cursor before");
    sync.write_cursor(
        "space-1",
        CursorPatch {
            revision: Some(10),
            sequence: Some(2),
            baselines: Some(BTreeMap::from([(
                ".trellis/tasks/a/prd.md".to_string(),
                "a".repeat(64),
            )])),
            deferred: Some(BTreeMap::from([(
                ".trellis/tasks/a".to_string(),
                BTreeMap::from([(
                    ".trellis/tasks/a/prd.md".to_string(),
                    "b".repeat(64),
                )]),
            )])),
            ..Default::default()
        },
    )
    .await
    .expect("noop cursor");
    let after = tokio::fs::read(&store.paths.task_cursors_file)
        .await
        .expect("cursor after");
    assert_eq!(after, before);
    assert_eq!(
        state_changes.load(std::sync::atomic::Ordering::SeqCst),
        0
    );

    sync.write_cursor(
        "space-1",
        CursorPatch {
            revision: Some(11),
            ..Default::default()
        },
    )
    .await
    .expect("changed cursor");
    let state = store.read_task_cursors().await;
    assert_eq!(state["taskSpaces"]["space-1"]["revision"], 11);
    assert_eq!(
        state_changes.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}


#[tokio::test]
async fn archive_pending_migration_is_persisted_once() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-cursor-archive-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    store.ensure_directories().await.expect("directories");
    let binding = test_binding("space-1");
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
                        "sequence": 5,
                        "baselines": {
                            ".trellis/tasks/archive/2026-11/a/prd.md": "a".repeat(64)
                        },
                        "pending": {
                            "batchId": "batch-archive-mixed",
                            "clientSequence": 5,
                            "files": [
                                {
                                    "path": ".trellis/tasks/a/prd.md",
                                    "content": "",
                                    "sha256": snapshot_sha256(""),
                                    "deleted": true
                                },
                                {
                                    "path": ".trellis/tasks/archive/2026-11/a/prd.md",
                                    "content": "old",
                                    "sha256": snapshot_sha256("old")
                                }
                            ]
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sync = TaskSync::new(store.clone(), api, Arc::new(|_| {}));
    sync.set_bindings(vec![binding.clone()]).await;

    sync.migrate_cursor_archive_state(&binding.task_space_id)
        .await
        .expect("migrate");
    let state = store.read_task_cursors().await;
    let entry = &state["taskSpaces"]["space-1"];
    assert!(entry["baselines"]
        .as_object()
        .is_some_and(|values| values.is_empty()));
    assert_eq!(
        entry["pending"]["files"].as_array().map(Vec::len),
        Some(1)
    );
    assert_ne!(entry["pending"]["batchId"], json!("batch-archive-mixed"));
    assert_eq!(
        entry["pending"]["files"][0]["path"],
        json!(".trellis/tasks/a/prd.md")
    );
}


#[tokio::test]
async fn current_event_revision_skips_snapshot_and_local_scan() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-event-revision-{}",
        uuid::Uuid::new_v4()
    ));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
    store.ensure_directories().await.expect("directories");
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "revision": 10,
                        "revisionGuardVersion": 1,
                        "sequence": 2
                    }
                }
            }),
        )
        .await
        .expect("cursor file");
    let api =
        Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let reports = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let sink_reports = reports.clone();
    let sink: ControlSink = Arc::new(move |value| {
        sink_reports
            .lock()
            .expect("reports lock")
            .push(value);
    });
    let before = tokio::fs::read(&store.paths.task_cursors_file)
        .await
        .expect("cursor before");
    let sync = TaskSync::new(store.clone(), api, sink);
    sync.set_bindings(vec![test_binding("space-1")]).await;

    let result = sync
        .pull_task_space_for_event("space-1", Some(10))
        .await
        .expect("event revision");

    assert_eq!(result["skipped"], true);
    assert_eq!(result["reason"], "REVISION_CURRENT");
    assert_eq!(result["revision"], 10);
    let after = tokio::fs::read(&store.paths.task_cursors_file)
        .await
        .expect("cursor after");
    assert_eq!(after, before);
    assert!(reports.lock().expect("reports lock").is_empty());
}


#[test]
fn next_client_sequence_stays_above_cursor_and_wall_clock() {
    let base = next_client_sequence(0);
    assert!(base > 1_700_000_000_000, "序列必须高于旧版 JS 的历史值");
    assert!(next_client_sequence(base) > base);
}
