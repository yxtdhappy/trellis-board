use super::*;

fn server_group(task_dir: &str, task_id: &str, relative: &str, sha256: &str) -> Value {
    json!({
        "taskDir": task_dir,
        "taskId": task_id,
        "files": [{ "path": relative, "sha256": sha256 }],
    })
}

fn local_group(task_dir: &str, task_id: &str, relative: &str, content: &str) -> SnapshotGroup {
    let parts = task_sync::task_directory_from_path(relative).expect("path");
    SnapshotGroup {
        task_dir: task_dir.to_string(),
        archived: parts.archived,
        archive_month: parts.archive_month.clone(),
        task_id: Some(task_id.to_string()),
        task_branch: None,
        files: vec![SnapshotFile {
            path: relative.to_string(),
            task_dir: task_dir.to_string(),
            file_path: parts.file_path,
            archived: parts.archived,
            archive_month: parts.archive_month,
            content: content.to_string(),
            sha256: task_sync::snapshot_sha256(content),
            deleted: false,
            base_sha256: None,
        }],
    }
}

#[test]
fn normalizes_server_task_groups() {
    let sha = "a".repeat(64);
    let tasks = json!([server_group(
        ".trellis/tasks/a",
        "a",
        ".trellis/tasks/a/prd.md",
        &sha
    )]);
    let groups = normalize_server_task_groups(Some(&tasks)).expect("groups");
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].task_dir, ".trellis/tasks/a");
    assert_eq!(groups[0].task_id.as_deref(), Some("a"));
    assert_eq!(groups[0].files[0].file_path, "prd.md");
    assert_eq!(groups[0].files[0].sha256, sha);

    assert!(normalize_server_task_groups(None)
        .expect("empty")
        .is_empty());
}

#[test]
fn rejects_invalid_server_task_metadata() {
    let sha = "a".repeat(64);
    let wrong_dir = json!([server_group(
        ".trellis/tasks/a",
        "a",
        ".trellis/tasks/b/prd.md",
        &sha
    )]);
    assert_eq!(
        normalize_server_task_groups(Some(&wrong_dir))
            .unwrap_err()
            .message,
        "服务端任务文件不属于目标目录"
    );

    let bad_sha = json!([server_group(
        ".trellis/tasks/a",
        "a",
        ".trellis/tasks/a/prd.md",
        "not-a-sha"
    )]);
    assert_eq!(
        normalize_server_task_groups(Some(&bad_sha))
            .unwrap_err()
            .message,
        "服务端任务文件摘要无效"
    );

    let missing_files = json!([{ "taskDir": ".trellis/tasks/a" }]);
    assert_eq!(
        normalize_server_task_groups(Some(&missing_files))
            .unwrap_err()
            .message,
        "服务端任务快照第 1 组无效"
    );
}

#[test]
fn classifies_differences_and_counts() {
    let local = vec![
        local_group(".trellis/tasks/a", "a", ".trellis/tasks/a/prd.md", "one"),
        local_group(".trellis/tasks/b", "b", ".trellis/tasks/b/prd.md", "local"),
    ];
    let server_value = json!([
        server_group(
            ".trellis/tasks/a",
            "a",
            ".trellis/tasks/a/prd.md",
            &task_sync::snapshot_sha256("one")
        ),
        server_group(
            ".trellis/tasks/b",
            "b",
            ".trellis/tasks/b/prd.md",
            &task_sync::snapshot_sha256("remote")
        ),
        server_group(
            ".trellis/tasks/c",
            "c",
            ".trellis/tasks/c/prd.md",
            &task_sync::snapshot_sha256("only")
        ),
    ]);
    let server = normalize_server_task_groups(Some(&server_value)).expect("groups");
    let differences = task_sync::classify_task_snapshots(&local, &server);
    let counts = snapshot_counts(&differences);
    assert_eq!(counts["same"], 1);
    assert_eq!(counts["conflicts"], 1);
    assert_eq!(counts["serverOnly"], 1);
    assert_eq!(counts["localOnly"], 0);
    assert_eq!(counts["invalid"], 0);
}

#[test]
fn difference_json_matches_snapshot_shape() {
    let local = vec![local_group(
        ".trellis/tasks/a",
        "a",
        ".trellis/tasks/a/prd.md",
        "one",
    )];
    let differences = task_sync::classify_task_snapshots(&local, &[]);
    let value = difference_to_json(&differences[0], &HashMap::new());
    assert_eq!(value["type"], "local-only");
    assert_eq!(value["taskId"], "a");
    assert_eq!(value["taskDir"], ".trellis/tasks/a");
    assert!(value["title"].is_null());
    assert_eq!(value["local"]["taskDir"], ".trellis/tasks/a");
    assert_eq!(
        value["local"]["files"][0]["path"],
        ".trellis/tasks/a/prd.md"
    );
    assert_eq!(value["local"]["files"][0]["content"], "one");
    assert!(value["server"].is_null());
}

#[test]
fn association_summary_serializes_camel_case() {
    let summary = AssociationSummary {
        ok: true,
        project_id: Some("project-1".to_string()),
        task_space_id: Some("space-1".to_string()),
        repo_path: Some("C:/repo".to_string()),
        display_name: Some("Repo".to_string()),
        branch_name: Some("main".to_string()),
        team_id: Some("team-1".to_string()),
        status: Some("attached".to_string()),
        read_only: Some(false),
        live_sync_status: Some("syncing".to_string()),
        live_sync_error: None,
        initial_review_pending: None,
        error: None,
        code: None,
    };
    let value = serde_json::to_value(&summary).expect("serialize");
    assert_eq!(value["projectId"], "project-1");
    assert_eq!(value["taskSpaceId"], "space-1");
    assert_eq!(value["repoPath"], "C:/repo");
    assert_eq!(value["displayName"], "Repo");
    assert_eq!(value["readOnly"], false);
    assert_eq!(value["liveSyncStatus"], "syncing");
    assert!(value.get("error").is_none());
    assert!(value.get("code").is_none());
}

fn local_task_group(task_dir: &str, task_id: &str, task_json: &str, prd: &str) -> SnapshotGroup {
    let task_json_path = format!("{task_dir}/task.json");
    let prd_path = format!("{task_dir}/prd.md");
    let task_parts = task_sync::task_directory_from_path(&task_json_path).expect("task.json path");
    let prd_parts = task_sync::task_directory_from_path(&prd_path).expect("prd path");
    SnapshotGroup {
        task_dir: task_dir.to_string(),
        archived: task_parts.archived,
        archive_month: task_parts.archive_month.clone(),
        task_id: Some(task_id.to_string()),
        task_branch: None,
        files: vec![
            SnapshotFile {
                path: prd_path,
                task_dir: task_dir.to_string(),
                file_path: prd_parts.file_path,
                archived: prd_parts.archived,
                archive_month: prd_parts.archive_month,
                content: prd.to_string(),
                sha256: task_sync::snapshot_sha256(prd),
                deleted: false,
                base_sha256: None,
            },
            SnapshotFile {
                path: task_json_path,
                task_dir: task_dir.to_string(),
                file_path: task_parts.file_path,
                archived: task_parts.archived,
                archive_month: task_parts.archive_month,
                content: task_json.to_string(),
                sha256: task_sync::snapshot_sha256(task_json),
                deleted: false,
                base_sha256: None,
            },
        ],
    }
}

#[test]
fn preflight_filters_foreign_tasks_cross_branch_and_hidden_dirs_and_keeps_titles() {
    let foreign_json = serde_json::json!({
        "id": "trellis-workflow-evidence-loop",
        "title": "他人任务",
        "assignee": "yhj",
        "creator": "yhj",
        "branch": "main"
    })
    .to_string();
    let mine_json = serde_json::json!({
        "id": "mine",
        "title": "我的本地标题",
        "assignee": "flyfly6",
        "branch": "main"
    })
    .to_string();
    let no_owner_json = serde_json::json!({
        "id": "no-owner",
        "title": "无负责人任务",
        "branch": "main"
    })
    .to_string();
    let hidden_local_json = serde_json::json!({
        "id": "archived-local",
        "title": "本地残留归档任务",
        "assignee": "flyfly6",
        "branch": "main"
    })
    .to_string();
    let legacy_local_json = serde_json::json!({
        "id": "legacy-local",
        "title": "遗留目录",
        "assignee": "flyfly6",
        "branch": "main"
    })
    .to_string();

    let local_groups = vec![
        local_task_group(
            ".trellis/tasks/11-23-trellis-workflow-evidence-loop",
            "trellis-workflow-evidence-loop",
            &foreign_json,
            "# foreign\n",
        ),
        local_task_group(".trellis/tasks/11-25-mine", "mine", &mine_json, "# mine\n"),
        local_task_group(
            ".trellis/tasks/11-25-no-owner",
            "no-owner",
            &no_owner_json,
            "# no owner\n",
        ),
        local_task_group(
            ".trellis/tasks/11-20-archived",
            "archived-local",
            &hidden_local_json,
            "# archived\n",
        ),
        local_task_group(
            ".trellis/tasks/11-18-legacy",
            "legacy-local",
            &legacy_local_json,
            "# legacy\n",
        ),
    ];

    let payload = serde_json::from_value::<serde_json::Map<String, Value>>(json!({
        "status": "existing",
        "tasks": [
            {
                "taskDir": ".trellis/tasks/11-25-mine",
                "taskId": "mine",
                "title": "服务端标题",
                "taskBranch": "main",
                "files": [
                    {
                        "path": ".trellis/tasks/11-25-mine/prd.md",
                        "sha256": task_sync::snapshot_sha256("# mine\n")
                    },
                    {
                        "path": ".trellis/tasks/11-25-mine/task.json",
                        "sha256": task_sync::snapshot_sha256(&mine_json)
                    }
                ]
            },
            {
                "taskDir": ".trellis/tasks/11-25-no-owner",
                "taskId": "no-owner",
                "title": "无负责人任务",
                "taskBranch": "main",
                "files": [
                    {
                        "path": ".trellis/tasks/11-25-no-owner/prd.md",
                        "sha256": task_sync::snapshot_sha256("# no owner\n")
                    },
                    {
                        "path": ".trellis/tasks/11-25-no-owner/task.json",
                        "sha256": task_sync::snapshot_sha256(&no_owner_json)
                    }
                ]
            },
            {
                "taskDir": ".trellis/tasks/11-25-server-only",
                "taskId": "server-only",
                "title": "仅服务端标题",
                "taskBranch": "main",
                "files": [
                    {
                        "path": ".trellis/tasks/11-25-server-only/prd.md",
                        "sha256": task_sync::snapshot_sha256("# server\n")
                    }
                ]
            },
            {
                "taskDir": ".trellis/tasks/11-24-other-branch",
                "taskId": "other-branch",
                "title": "其他分支任务",
                "taskBranch": "feat/other",
                "files": [
                    {
                        "path": ".trellis/tasks/11-24-other-branch/prd.md",
                        "sha256": task_sync::snapshot_sha256("# other\n")
                    }
                ]
            }
        ],
        "hiddenTaskDirs": [".trellis/tasks/11-18-legacy"],
        "archivedTaskBasenames": ["11-20-archived"]
    }))
    .expect("payload map");

    let (differences, server_titles) =
        build_preflight_differences("main", Some("FLYFLY6"), local_groups, &payload)
            .expect("differences");
    let counts = snapshot_counts(&differences);
    assert_eq!(counts["same"], 2);
    assert_eq!(counts["serverOnly"], 1);
    assert_eq!(counts["localOnly"], 0);
    assert_eq!(counts["conflicts"], 0);

    let json_diffs: Vec<Value> = differences
        .iter()
        .map(|diff| difference_to_json(diff, &server_titles))
        .collect();
    let mine_diff = json_diffs
        .iter()
        .find(|diff| diff["taskId"] == "mine")
        .expect("mine diff");
    assert_eq!(mine_diff["title"], "我的本地标题");
    let server_only_diff = json_diffs
        .iter()
        .find(|diff| diff["taskId"] == "server-only")
        .expect("server only diff");
    assert_eq!(server_only_diff["title"], "仅服务端标题");
}

#[test]
fn preflight_filters_foreign_local_tasks_even_for_new_and_branch_new() {
    let foreign_json = serde_json::json!({
        "id": "trellis-workflow-evidence-loop",
        "title": "他人任务",
        "assignee": "yhj",
        "branch": "main"
    })
    .to_string();
    let local_groups = vec![local_task_group(
        ".trellis/tasks/11-23-trellis-workflow-evidence-loop",
        "trellis-workflow-evidence-loop",
        &foreign_json,
        "# foreign\n",
    )];
    let empty_payload = serde_json::Map::new();
    let (differences, _) =
        build_preflight_differences("main", Some("flyfly6"), local_groups, &empty_payload)
            .expect("differences");
    assert!(differences.is_empty());
    let counts = snapshot_counts(&differences);
    assert_eq!(counts["localOnly"], 0);
    assert_eq!(counts["conflicts"], 0);
}
