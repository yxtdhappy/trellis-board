use super::*;

#[test]
fn slugify_keeps_ascii_words() {
    assert_eq!(
        slugify_task_title("Fix desktop Sync Race"),
        "fix-desktop-sync-race"
    );
    assert_eq!(slugify_task_title("  RFC822 Headers  "), "rfc822-headers");
    assert_eq!(slugify_task_title("任务标题"), "");
}

#[test]
fn normalize_slug_prefers_existing_pattern() {
    assert_eq!(normalize_task_slug(" Fix-Desk "), "fix-desk");
    assert_eq!(normalize_task_slug("Fix Desk"), "fix desk");
    assert!(!is_task_slug(&normalize_task_slug("Fix Desk")));
}

#[test]
fn create_execution_key_derives_from_task_control_payload() {
    let command = AgentCommand {
        payload: json!({ "taskId": "task-a", "taskVersion": 1 }),
        ..sample_command()
    };
    assert_eq!(
        create_execution_task_key(&command, &sample_binding()).as_deref(),
        Some("space-1::task-a")
    );
}

#[test]
fn resolve_task_dir_rejects_traversal() {
    let root = Path::new("repo").join(".trellis").join("tasks");
    assert_eq!(
        protocol::resolve_task_dir_under(&root, ".trellis/tasks/../evil"),
        None
    );
    assert_eq!(
        protocol::resolve_task_dir_under(&root, ".trellis/tasks"),
        None
    );
    assert_eq!(
        protocol::resolve_task_dir_under(&root, "elsewhere/tasks/x"),
        None
    );
    assert!(protocol::resolve_task_dir_under(&root, ".trellis/tasks/11-12-fix").is_some());
}

#[test]
fn synced_revision_requires_positive_revision() {
    assert!(require_synced_revision(&json!({ "revision": 3 })).is_ok());
    assert!(require_synced_revision(&json!({ "revision": 0 })).is_err());
    let conflict =
        require_synced_revision(&json!({ "code": "TASK_FILE_CONFLICT" })).unwrap_err();
    assert_eq!(conflict.code, code::HTTP_ERROR);
}

#[test]
fn command_binding_enforces_approved_and_writable() {
    let mut binding = sample_binding();
    let command = sample_command();
    assert!(command_binding(&[binding.clone()], &command).is_ok());
    binding.sync_status = "pending".to_string();
    assert_eq!(
        command_binding(&[binding.clone()], &command)
            .unwrap_err()
            .code,
        code::BINDING_NOT_APPROVED
    );
    binding.sync_status = "approved".to_string();
    binding.read_only = true;
    assert_eq!(
        command_binding(&[binding], &command).unwrap_err().code,
        code::BINDING_NOT_APPROVED
    );

    let mut detaching = sample_binding();
    detaching.detach_pending = true;
    assert_eq!(
        command_binding(&[detaching], &command).unwrap_err().code,
        code::BINDING_UNKNOWN
    );
}

#[test]
fn server_command_binding_checks_project_and_branch() {
    let bindings = vec![sample_binding()];
    let matched = AgentCommand {
        payload: json!({ "taskSpaceId": "space-1", "branchName": "main" }),
        ..sample_command()
    };
    assert!(server_command_binding(&bindings, &matched).is_ok());

    let wrong_branch = AgentCommand {
        payload: json!({ "taskSpaceId": "space-1", "branchName": "dev" }),
        ..sample_command()
    };
    assert_eq!(
        server_command_binding(&bindings, &wrong_branch)
            .unwrap_err()
            .code,
        code::COMMAND_INVALID
    );

    let unknown = AgentCommand {
        binding_id: "other".into(),
        payload: json!({}),
        ..sample_command()
    };
    assert_eq!(
        server_command_binding(&bindings, &unknown)
            .unwrap_err()
            .code,
        code::BINDING_UNKNOWN
    );

    let mut pending = sample_binding();
    pending.sync_status = "pending".into();
    assert_eq!(
        server_command_binding(&[pending], &matched)
            .unwrap_err()
            .code,
        code::BINDING_NOT_APPROVED
    );

    let mut detaching = sample_binding();
    detaching.detach_pending = true;
    assert_eq!(
        server_command_binding(&[detaching], &matched)
            .unwrap_err()
            .code,
        code::BINDING_UNKNOWN
    );
}

#[test]
fn interrupted_git_state_uses_chinese_labels() {
    let root =
        std::env::temp_dir().join(format!("trellis-task-command-git-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".git")).expect("git dir");
    assert!(interrupted_git_state(&root).is_ok());
    std::fs::write(root.join(".git").join("MERGE_HEAD"), b"x").expect("merge head");
    let error = interrupted_git_state(&root).expect_err("合并未完成");
    assert_eq!(error.code, code::GIT_FAILED);
    assert_eq!(
        error.message,
        "仓库存在未完成的合并操作，请先处理后再执行任务命令"
    );
    std::fs::remove_file(root.join(".git").join("MERGE_HEAD")).expect("cleanup");
    std::fs::create_dir_all(root.join(".git").join("rebase-apply")).expect("rebase dir");
    assert!(interrupted_git_state(&root)
        .expect_err("变基未完成")
        .message
        .contains("变基"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn status_report_exposes_binding_and_repository_fields() {
    let inspection = ProjectInspection {
        root: "C:/repo".into(),
        local_repo_key: "local-key".into(),
        branch_name: "main".into(),
        current_branch: "main".into(),
        head: Some("abc".into()),
        clean: false,
        dirty_summary: "M a.md".into(),
        remote_url: "https://example.test/repo.git".into(),
        remote_identity_key: "hash".into(),
        has_trellis: true,
        has_tasks: true,
        has_committed_trellis: true,
        requires_initialization: false,
        existing_agent_tools: Vec::new(),
        repository_name: "repo".into(),
    };
    let report = status_report(&sample_binding(), &inspection, "2026-11-12T00:00:00.000Z");
    assert_eq!(report["bindingId"], json!("binding-1"));
    assert_eq!(report["taskSpaceId"], json!("space-1"));
    assert_eq!(report["projectId"], json!("project-1"));
    assert_eq!(report["branchName"], json!("main"));
    assert_eq!(report["head"], json!("abc"));
    assert_eq!(report["clean"], json!(false));
    assert_eq!(report["syncedAt"], json!("2026-11-12T00:00:00.000Z"));
    assert_eq!(report["localRepoKey"], json!("local-key"));
    assert_eq!(report["remoteIdentityKey"], json!("hash"));
}

#[tokio::test]
async fn atomic_write_json_matches_js_format() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-write-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).expect("temp root");
    let target = root.join("task.json");
    let mut task = json!({ "id": "task-1", "assignee": "old" });
    task["assignee"] = json!("dev");
    atomic_write_json(&target, &task).await.expect("写入");
    let text = std::fs::read_to_string(&target).expect("读取");
    assert_eq!(
        text,
        "{\n  \"assignee\": \"dev\",\n  \"id\": \"task-1\"\n}\n"
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn identical_binding_result_does_not_emit_again() {
    let mut binding = sample_binding();
    binding.sync_status = "approved".to_string();
    binding.last_synced_at = None;
    binding.last_head = None;
    binding.last_error = None;
    binding.last_error_code = None;
    let health = None;

    assert!(apply_binding_result(
        &mut binding,
        Some("2026-11-14T00:00:00.000Z"),
        Some("abc123"),
        &health
    ));
    assert!(!apply_binding_result(
        &mut binding,
        Some("2026-11-14T00:00:00.000Z"),
        Some("abc123"),
        &health
    ));
}

fn test_context(root: &Path) -> (Arc<ConfigStore>, Arc<TaskSync>) {
    let store = Arc::new(ConfigStore::new(root.join("data")));
    let api = Arc::new(
        crate::agent::http::ApiClient::new("http://127.0.0.1:1", None, None)
            .expect("api client"),
    );
    let sink: task_sync::ControlSink = Arc::new(|_| {});
    let task_sync = Arc::new(TaskSync::new(store.clone(), api, sink));
    (store, task_sync)
}

#[tokio::test]
async fn create_task_rejects_title_without_slug() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-slug-{}",
        uuid::Uuid::new_v4()
    ));
    let (store, task_sync) = test_context(&root);
    let context = CommandContext {
        store: &store,
        task_sync: &task_sync,
    };
    let command = AgentCommand {
        payload: json!({ "taskSpaceId": "space-1", "title": "任务标题", "assigneeDevId": "dev" }),
        ..sample_command()
    };
    let error = create_task(
        &context,
        &command,
        &sample_binding(),
        Path::new("hooks"),
        Path::new("repo"),
    )
    .await
    .expect_err("缺少英文标识");
    assert_eq!(error.code, code::COMMAND_INVALID);
    assert_eq!(
        error.message,
        "任务标题没有可用英文标识，请使用包含英文或数字的标题"
    );
}

#[tokio::test]
async fn create_task_rejects_reserved_archive_slug() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-reserved-{}",
        uuid::Uuid::new_v4()
    ));
    let (store, task_sync) = test_context(&root);
    let context = CommandContext {
        store: &store,
        task_sync: &task_sync,
    };
    let command = AgentCommand {
        payload: json!({
            "taskSpaceId": "space-1",
            "title": "archive",
            "assigneeDevId": "dev"
        }),
        ..sample_command()
    };
    let error = create_task(
        &context,
        &command,
        &sample_binding(),
        Path::new("hooks"),
        Path::new("repo"),
    )
    .await
    .expect_err("归档目录是保留标识");
    assert_eq!(error.code, code::COMMAND_INVALID);
    assert!(error.message.contains("保留"));
}

#[tokio::test]
async fn assign_task_rejects_directory_escape() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-escape-{}",
        uuid::Uuid::new_v4()
    ));
    let (store, task_sync) = test_context(&root);
    let context = CommandContext {
        store: &store,
        task_sync: &task_sync,
    };
    let command = AgentCommand {
        payload: json!({
            "taskSpaceId": "space-1",
            "assigneeDevId": "dev",
            "relativeDir": ".trellis/tasks/../evil"
        }),
        ..sample_command()
    };
    let error = assign_task(
        &context,
        &command,
        &sample_binding(),
        Path::new("hooks"),
        Path::new("repo"),
    )
    .await
    .expect_err("目录越界");
    assert_eq!(error.code, code::COMMAND_INVALID);
    assert_eq!(error.message, "改派任务目录越界");
}

#[tokio::test]
async fn assign_task_rejects_archived_target() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-archive-{}",
        uuid::Uuid::new_v4()
    ));
    let (store, task_sync) = test_context(&root);
    let context = CommandContext {
        store: &store,
        task_sync: &task_sync,
    };
    let command = AgentCommand {
        payload: json!({
            "taskSpaceId": "space-1",
            "assigneeDevId": "dev",
            "relativeDir": ".trellis/tasks/archive/2026-11/old"
        }),
        ..sample_command()
    };
    let error = assign_task(
        &context,
        &command,
        &sample_binding(),
        Path::new("hooks"),
        Path::new("repo"),
    )
    .await
    .expect_err("归档任务不能改派");
    assert_eq!(error.code, code::COMMAND_INVALID);
    assert!(error.message.contains("服务端 Git"));
}

#[tokio::test]
async fn refresh_status_and_sync_branch_map_missing_repository() {
    let root = std::env::temp_dir().join(format!(
        "trellis-task-command-repo-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).expect("temp root");
    let (store, task_sync) = test_context(&root);
    let context = CommandContext {
        store: &store,
        task_sync: &task_sync,
    };
    let mut binding = sample_binding();
    binding.repo_path = root.join("missing").to_string_lossy().to_string();
    assert_eq!(
        refresh_status(&context, &binding)
            .await
            .expect_err("仓库不存在")
            .code,
        code::REPO_NOT_FOUND
    );
    assert_eq!(
        sync_branch(&context, &binding)
            .await
            .expect_err("仓库不存在")
            .code,
        code::REPO_NOT_FOUND
    );
    let plain = root.join("plain");
    std::fs::create_dir_all(&plain).expect("plain dir");
    binding.repo_path = plain.to_string_lossy().to_string();
    let error = refresh_status(&context, &binding)
        .await
        .expect_err("非 Git 仓库");
    assert!(
        error.code == code::NOT_GIT_REPOSITORY || error.code == code::REPO_PATH_INVALID,
        "意外的错误码: {}",
        error.code
    );
    std::fs::remove_dir_all(&root).ok();
}

fn sample_binding() -> AgentBinding {
    AgentBinding {
        local_id: "local-1".into(),
        server_binding_id: Some("binding-1".into()),
        task_space_id: "space-1".into(),
        project_id: "project-1".into(),
        repo_path: "C:/repo".into(),
        branch_name: "main".into(),
        baseline_branch: None,
        team_id: Some("team-1".into()),
        remote_identity_key: "remote".into(),
        local_repo_key: "local".into(),
        display_name: "repo".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        allow_file_remote: false,
        read_only: false,
        sync_status: "approved".into(),
        detach_pending: false,
        initial_sync_mode: "review".into(),
        initial_sync_completed: true,
        initial_review_pending: false,
        live_sync_status: "synced".into(),
        live_sync_error: None,
        last_synced_at: None,
        last_head: None,
        last_error: None,
        last_error_code: None,
    }
}

fn sample_command() -> AgentCommand {
    AgentCommand {
        id: "command-1".into(),
        binding_id: "binding-1".into(),
        kind: protocol::COMMAND_CREATE_TASK.into(),
        payload: json!({ "taskSpaceId": "space-1", "title": "Fix it", "assigneeDevId": "dev" }),
    }
}
