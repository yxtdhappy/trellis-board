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
    let value = difference_to_json(&differences[0]);
    assert_eq!(value["type"], "local-only");
    assert_eq!(value["taskId"], "a");
    assert_eq!(value["taskDir"], ".trellis/tasks/a");
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
