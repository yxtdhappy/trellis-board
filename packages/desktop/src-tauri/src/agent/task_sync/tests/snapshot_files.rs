use super::*;
use super::support::*;

#[tokio::test]
async fn local_only_task_upload_treats_missing_directory_as_first_snapshot() {
    let (root, store, _sync, mut binding) =
        test_task_sync_fixture("trellis-local-only-first-upload").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-local";
    let task_json = format!("{task_dir}/task.json");
    write_task_json(repo, task_dir, "task-local", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "local task"]);
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
                        "revision": 10,
                        "revisionGuardVersion": REVISION_GUARD_VERSION,
                        "sequence": 0
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    let (server_url, changes, requests, server_task) = mock_api_server(json!({
        "revision": 10,
        "directoryStatus": 404,
        "writeRevision": 11
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;

    let result = sync
        .upload_directories(&binding, &[task_dir.to_string()], false, None)
        .await
        .expect("first upload");
    assert_eq!(result["committedRevision"], 11);

    let sent = changes.lock().await.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["files"][0]["path"], task_json);

    let requests = requests.lock().await.clone();
    assert!(requests
        .iter()
        .any(|request| request.contains("/files?taskDir=")));
    assert!(requests.iter().any(|request| {
        request == "POST /api/agent/task-spaces/space-1/changes"
    }));

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn snapshot_controls_distinguish_legacy_and_authoritative_empty() {
    assert!(parse_snapshot_controls(&json!({ "files": [] }))
        .expect("legacy snapshot")
        .is_none());
    assert_eq!(
        parse_snapshot_controls(&json!({ "files": [], "controls": [] }))
            .expect("authoritative snapshot")
            .expect("controls")
            .len(),
        0
    );
}


#[tokio::test]
async fn deletion_only_upload_recovers_persisted_control_identity() {
    let (root, store, sync, binding) =
        test_task_sync_fixture("trellis-control-delete").await;
    let mut state = TaskControlStateFile::empty();
    state
        .upsert_control(
            &binding.local_id,
            &TaskControl {
                execution_task_key: "space-1::task-a".to_string(),
                task_id: "task-a".to_string(),
                relative_dir: ".trellis/tasks/task-a".to_string(),
                title: "任务 A".to_string(),
                state: "materialized".to_string(),
                task_version: 3,
                assignee_user_id: Some("user-b".to_string()),
                handoff_state: "none".to_string(),
                materialized_revision: None,
                materialized_at: None,
                lease_held_by_other_user: false,
                updated_at: "2026-11-17T00:00:00.000Z".to_string(),
            },
        )
        .expect("persist control");
    store
        .write_json(&store.paths.task_control_file, &state)
        .await
        .expect("write control state");

    let files = vec![
        json!({
            "path": ".trellis/tasks/task-a/task.json",
            "deleted": true,
        }),
        json!({
            "path": ".trellis/tasks/task-a/prd.md",
            "deleted": true,
        }),
    ];
    assert_eq!(
        sync.persisted_control_key_for_upload(&binding, &files)
            .await
            .expect("recover control key"),
        Some("space-1::task-a".to_string())
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn task_directory_resolution_rejects_invalid_relative_path() {
    let binding = test_binding("space-1");
    let error = resolve_task_directory(&binding, ".trellis/tasks/../evil")
        .await
        .expect_err("目录穿越");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    let details = error.details.expect("路径错误详情");
    assert_eq!(
        details["taskDir"],
        json!(".trellis/tasks/../evil")
    );
}


#[test]
fn groups_more_than_batch_limit_across_task_directories() {
    let files: Vec<Value> = (0..1100)
        .map(|index| {
            let task_dir = if index < 550 {
                ".trellis/tasks/a"
            } else {
                ".trellis/tasks/b"
            };
            snapshot_file_value(format!("{task_dir}/file-{index}.md"), "")
        })
        .collect();

    let groups = group_task_snapshot_files(&files).expect("跨目录聚合应允许超过单批上限");
    assert_eq!(groups.len(), 2);
    assert!(groups.iter().all(|group| group.files.len() == 550));
}


#[test]
fn validates_upload_batch_file_count_boundary() {
    let mut files = batch_file_values(TASK_SNAPSHOT_MAX_FILES);
    assert!(validate_upload_batch(&files).is_ok());

    files.push(snapshot_file_value(
        format!(".trellis/tasks/a/file-{}.md", TASK_SNAPSHOT_MAX_FILES),
        "",
    ));
    let error = validate_upload_batch(&files).expect_err("超过文件数上限应失败");
    assert!(error.message.contains("1024"));
}


#[test]
fn validates_upload_batch_byte_boundary() {
    let full_file = "x".repeat(TASK_SNAPSHOT_MAX_FILE_BYTES);
    let file_count = TASK_SNAPSHOT_MAX_BATCH_BYTES / TASK_SNAPSHOT_MAX_FILE_BYTES;
    let mut files: Vec<Value> = (0..file_count)
        .map(|index| {
            snapshot_file_value(
                format!(".trellis/tasks/a/file-{index}.md"),
                full_file.clone(),
            )
        })
        .collect();
    assert!(validate_upload_batch(&files).is_ok());

    files.push(snapshot_file_value(".trellis/tasks/a/extra.md", "x"));
    let error = validate_upload_batch(&files).expect_err("超过字节上限应失败");
    assert!(error.message.contains("64 MiB"));
}


#[test]
fn upload_batch_rejects_archive_paths() {
    let files = vec![snapshot_file_value(
        ".trellis/tasks/archive/2026-11/a/prd.md",
        "old",
    )];
    let error = validate_upload_batch(&files).expect_err("归档路径必须拒绝");
    assert!(error.message.contains("服务端 Git"));
}


#[test]
fn group_rejects_duplicate_snapshot_paths() {
    let files = vec![
        snapshot_file_value(".trellis/tasks/a/prd.md", "one"),
        snapshot_file_value(".trellis/tasks/a/prd.md", "two"),
    ];

    let error = group_task_snapshot_files(&files).expect_err("重复路径应失败");
    assert!(error.message.contains("不能重复"));
}


#[test]
fn server_snapshot_parser_ignores_archive_files() {
    let snapshot = json!({
        "files": [
            snapshot_file_value(".trellis/tasks/a/prd.md", "active"),
            snapshot_file_value(".trellis/tasks/archive/2026-11/a/prd.md", "archived"),
            {
                "path": ".trellis/tasks/archive/2026-11/a/screenshot.png",
                "content": "ignored"
            }
        ]
    });
    let files = parse_snapshot_files(&snapshot).expect("snapshot");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, ".trellis/tasks/a/prd.md");
}


#[test]
fn directory_parser_rejects_archive_targets() {
    let error = parse_directory_files(
        &json!({ "files": [] }),
        ".trellis/tasks/archive/2026-11/a",
    )
    .expect_err("归档目录不能走 Agent 快照");
    assert_eq!(error.code, code::INVALID_RESPONSE);
}


#[test]
fn groups_ignore_archived_task_directories() {
    let files = vec![
        snapshot_file_value(".trellis/tasks/a/prd.md", ""),
        snapshot_file_value(".trellis/tasks/archive/2026-11/b/prd.md", ""),
    ];

    let groups = group_task_snapshot_files(&files).expect("归档路径应被忽略");
    assert_eq!(groups.len(), 1);
    assert_eq!(groups.iter().filter(|group| group.archived).count(), 0);
    assert_eq!(groups.iter().filter(|group| !group.archived).count(), 1);
}


#[test]
fn task_title_reads_trimmed_title_or_none() {
    let titled = task_group(
        "demo",
        ".trellis/tasks/11-12-demo",
        &[("task.json", r#"{"id":"demo","title":"  修复登录  "}"#)],
    );
    assert_eq!(task_title(&titled).as_deref(), Some("修复登录"));

    let untitled = task_group(
        "demo",
        ".trellis/tasks/11-12-demo",
        &[("task.json", r#"{"id":"demo","title":"   "}"#)],
    );
    assert_eq!(task_title(&untitled), None);

    let broken = task_group(
        "demo",
        ".trellis/tasks/11-12-demo",
        &[("task.json", "{not json")],
    );
    assert_eq!(task_title(&broken), None);
}


#[test]
fn difference_control_carries_both_task_titles() {
    let task_dir = ".trellis/tasks/11-12-demo";
    let local = task_group(
        "demo",
        task_dir,
        &[("task.json", r#"{"id":"demo","title":"本地标题"}"#)],
    );
    let server = task_group(
        "demo",
        task_dir,
        &[("task.json", r#"{"id":"demo","title":"服务端标题"}"#)],
    );
    let difference = Difference {
        kind: DiffKind::ContentConflict,
        task_id: Some("demo".to_string()),
        task_dir: task_dir.to_string(),
        local: Some(local),
        server: Some(server),
    };
    let control = difference.to_control();
    assert_eq!(control["title"], "本地标题");
    assert_eq!(control["local"]["title"], "本地标题");
    assert_eq!(control["server"]["title"], "服务端标题");

    let fallback = Difference {
        kind: DiffKind::ServerOnly,
        task_id: Some("demo".to_string()),
        task_dir: task_dir.to_string(),
        local: None,
        server: Some(task_group(
            "demo",
            task_dir,
            &[("task.json", r#"{"id":"demo","title":"服务端标题"}"#)],
        )),
    };
    assert_eq!(fallback.to_control()["title"], "服务端标题");
    assert!(fallback.to_control()["local"].is_null());

    let untitled = Difference {
        kind: DiffKind::LocalOnly,
        task_id: None,
        task_dir: task_dir.to_string(),
        local: Some(task_group("demo", task_dir, &[("task.json", "{}")])),
        server: None,
    };
    assert!(untitled.to_control()["title"].is_null());
}


#[test]
fn normalizes_text_and_paths() {
    assert_eq!(normalize_snapshot_text("\u{feff}a\r\nb\rc"), "a\nb\nc");
    assert!(normalize_snapshot_path(".trellis/tasks/01-x/prd.md").is_ok());
    assert!(normalize_snapshot_path(".trellis/tasks/../prd.md").is_err());
    assert!(normalize_snapshot_path(".trellis/tasks/01-x/prd.exe").is_err());
    assert_eq!(
        task_directory_from_path(".trellis/tasks/archive/2026-09/01-x/prd.md")
            .expect("archive path")
            .task_dir,
        ".trellis/tasks/archive/2026-09/01-x"
    );
}


#[test]
fn classifies_snapshot_differences() {
    let local = vec![
        task_group(
            "a",
            ".trellis/tasks/a",
            &[("prd.md", "one"), ("task.json", "{\"id\":\"a\"}")],
        ),
        task_group(
            "b",
            ".trellis/tasks/b",
            &[("prd.md", "local"), ("task.json", "{\"id\":\"b\"}")],
        ),
    ];
    let server = vec![
        task_group(
            "a",
            ".trellis/tasks/a",
            &[("prd.md", "one"), ("task.json", "{\"id\":\"a\"}")],
        ),
        task_group(
            "b",
            ".trellis/tasks/b",
            &[("prd.md", "server"), ("task.json", "{\"id\":\"b\"}")],
        ),
        task_group(
            "c",
            ".trellis/tasks/c",
            &[("prd.md", "remote"), ("task.json", "{\"id\":\"c\"}")],
        ),
    ];
    let differences = classify_task_snapshots(&local, &server);
    let by_id: HashMap<String, DiffKind> = differences
        .iter()
        .map(|item| (item.action_key(), item.kind))
        .collect();
    assert_eq!(by_id.get("a"), Some(&DiffKind::Same));
    assert_eq!(by_id.get("b"), Some(&DiffKind::ContentConflict));
    assert_eq!(by_id.get("c"), Some(&DiffKind::ServerOnly));
}


#[test]
fn rejects_duplicate_task_ids_as_invalid() {
    let local = vec![
        task_group(
            "dup",
            ".trellis/tasks/a",
            &[("task.json", "{\"id\":\"dup\"}")],
        ),
        task_group(
            "dup",
            ".trellis/tasks/b",
            &[("task.json", "{\"id\":\"dup\"}")],
        ),
    ];
    let differences = classify_task_snapshots(&local, &[]);
    assert_eq!(differences.len(), 2);
    assert!(differences
        .iter()
        .all(|item| item.kind == DiffKind::Invalid));
}


#[test]
fn builds_upload_files_with_deletions() {
    let local = task_group("a", ".trellis/tasks/a", &[("prd.md", "new")]);
    let server_files = vec![SnapshotFile {
        path: ".trellis/tasks/a/notes.md".into(),
        task_dir: ".trellis/tasks/a".into(),
        file_path: "notes.md".into(),
        archived: false,
        archive_month: None,
        content: "old".into(),
        sha256: snapshot_sha256("old"),
        deleted: false,
        base_sha256: None,
    }];
    let mut baselines = BTreeMap::new();
    baselines.insert(
        ".trellis/tasks/a/notes.md".to_string(),
        snapshot_sha256("old"),
    );
    let files =
        build_directory_files(".trellis/tasks/a", Some(&local), &server_files, &baselines);
    assert_eq!(files.len(), 2);
    let deleted = files.iter().find(|file| file.deleted).expect("deletion");
    assert_eq!(deleted.path, ".trellis/tasks/a/notes.md");
    assert_eq!(
        deleted.base_sha256.as_deref(),
        Some(snapshot_sha256("old").as_str())
    );
}


#[tokio::test]
async fn reads_local_task_snapshot_files() {
    let root = std::env::temp_dir().join(format!("trellis-snap-{}", uuid::Uuid::new_v4()));
    let task_dir = root.join(".trellis").join("tasks").join("01-x");
    tokio::fs::create_dir_all(&task_dir).await.expect("mkdir");
    tokio::fs::write(task_dir.join("prd.md"), "# hi\r\n")
        .await
        .expect("write");
    let archive_dir = root
        .join(".trellis")
        .join("tasks")
        .join("archive")
        .join("2026-11")
        .join("old");
    tokio::fs::create_dir_all(&archive_dir)
        .await
        .expect("archive mkdir");
    tokio::fs::write(archive_dir.join("prd.md"), [0xff, 0xfe])
        .await
        .expect("archive write");
    let files = read_local_task_snapshot_files(&root, None)
        .await
        .expect("read");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["content"], "# hi\n");
    let selected = HashSet::from([".trellis/tasks/01-x".to_string()]);
    let targeted = read_local_task_snapshot_files(&root, Some(&selected))
        .await
        .expect("targeted read");
    assert_eq!(targeted.len(), 1);
    assert_eq!(targeted[0]["path"], ".trellis/tasks/01-x/prd.md");
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[tokio::test]
async fn targeted_local_read_does_not_decode_sibling_task_bodies() {
    let root = std::env::temp_dir().join(format!(
        "trellis-targeted-scan-{}",
        uuid::Uuid::new_v4()
    ));
    let selected = root.join(".trellis").join("tasks").join("selected");
    let sibling = root.join(".trellis").join("tasks").join("sibling");
    tokio::fs::create_dir_all(&selected).await.expect("selected");
    tokio::fs::create_dir_all(&sibling).await.expect("sibling");
    tokio::fs::write(selected.join("prd.md"), "ok")
        .await
        .expect("selected file");
    tokio::fs::write(sibling.join("prd.md"), [0xff, 0xfe])
        .await
        .expect("invalid sibling");

    let task_dirs = HashSet::from([".trellis/tasks/selected".to_string()]);
    let files = read_local_task_snapshot_files(&root, Some(&task_dirs))
        .await
        .expect("targeted scan");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], ".trellis/tasks/selected/prd.md");
    let _ = tokio::fs::remove_dir_all(root).await;
}


#[test]
fn with_task_dir_injects_and_keeps_existing_directory() {
    let error = with_task_dir(
        AgentError::new(code::HTTP_ERROR, "写入失败"),
        ".trellis/tasks/task-a",
    );
    assert_eq!(
        error
            .details
            .as_ref()
            .and_then(|details| details.get("taskDir")),
        Some(&json!(".trellis/tasks/task-a"))
    );

    let mut existing = AgentError::new(code::HTTP_ERROR, "写入失败");
    existing.details = Some(json!({ "taskDir": ".trellis/tasks/task-b" }));
    let kept = with_task_dir(existing, ".trellis/tasks/task-a");
    assert_eq!(
        kept.details
            .as_ref()
            .and_then(|details| details.get("taskDir")),
        Some(&json!(".trellis/tasks/task-b"))
    );
}


#[test]
fn write_forbidden_and_archived_errors_are_classified_apart() {
    let mut forbidden = AgentError::new(code::HTTP_ERROR, "无权限");
    forbidden.status = Some(403);
    assert!(is_foreign_task_error(&forbidden));
    assert!(!is_archived_task_error(&forbidden));

    let mut revoked = AgentError::new(code::AUTH_REVOKED, "登录失效");
    revoked.status = Some(403);
    assert!(!is_foreign_task_error(&revoked));

    let mut archived = AgentError::new(code::HTTP_ERROR, "已归档");
    archived.server_code = Some("TASK_ARCHIVED".into());
    assert!(is_archived_task_error(&archived));
    assert!(!is_foreign_task_error(&archived));

    let mut managed = AgentError::new(code::HTTP_ERROR, "归档由服务端管理");
    managed.server_code = Some("ARCHIVE_SYNC_SERVER_MANAGED".into());
    assert!(is_archived_task_error(&managed));

    let mut other = AgentError::new(code::HTTP_ERROR, "服务异常");
    other.status = Some(500);
    assert!(!is_foreign_task_error(&other));
    assert!(!is_archived_task_error(&other));
}


#[tokio::test]
async fn directory_digest_compares_copies_by_content() {
    let root = std::env::temp_dir().join(format!("digest-{}", uuid::Uuid::new_v4()));
    let active = root.join("active");
    let archived = root.join("archived");
    tokio::fs::create_dir_all(&active).await.expect("active");
    tokio::fs::create_dir_all(&archived)
        .await
        .expect("archived");
    tokio::fs::write(active.join("task.json"), "{\"id\":\"a\"}")
        .await
        .expect("write");
    tokio::fs::write(archived.join("task.json"), "{\"id\":\"a\"}")
        .await
        .expect("write");
    assert_eq!(
        task_directory_digest(&active).await.expect("active digest"),
        task_directory_digest(&archived)
            .await
            .expect("archived digest")
    );

    tokio::fs::write(archived.join("prd.md"), "# 差异")
        .await
        .expect("write");
    assert_ne!(
        task_directory_digest(&active).await.expect("active digest"),
        task_directory_digest(&archived)
            .await
            .expect("archived digest")
    );
    let _ = tokio::fs::remove_dir_all(root).await;
}
