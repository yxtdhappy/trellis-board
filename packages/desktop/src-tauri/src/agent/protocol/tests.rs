use super::*;

#[test]
fn normalizes_server_urls() {
    assert_eq!(
        normalize_server_url("http://localhost:4310").unwrap(),
        "http://localhost:4310"
    );
    assert!(normalize_server_url("http://localhost:4310/api").is_err());
    assert!(normalize_server_url("ftp://localhost").is_err());
    assert!(normalize_server_url("http://user:pass@localhost").is_err());
}

#[test]
fn validates_branch_names() {
    assert!(validate_branch_name_syntax("team-board").is_ok());
    assert!(validate_branch_name_syntax("feat/x").is_ok());
    for invalid in [
        "",
        "-x",
        "HEAD",
        "a..b",
        "a b",
        "x.lock",
        "refs/heads/x",
        "a//b",
    ] {
        assert!(validate_branch_name_syntax(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn resolves_only_normal_task_directory_segments() {
    let root = Path::new("repo").join(".trellis").join("tasks");
    assert_eq!(
        resolve_task_dir_under(&root, ".trellis/tasks/11-12-demo"),
        Some(root.join("11-12-demo"))
    );
    assert_eq!(
        resolve_task_dir_under(&root, ".trellis/tasks/archive/2026-11/11-12-demo"),
        Some(root.join("archive").join("2026-11").join("11-12-demo"))
    );
    for invalid in [
        ".trellis/tasks",
        ".trellis/tasks/",
        ".trellis/tasks/..",
        ".trellis/tasks/../evil",
        ".trellis/tasks/./evil",
        ".trellis/tasks//evil",
        ".trellis/tasks/evil\\name",
        ".trellis/tasks/C:/evil",
        ".trellis/tasks/evil\0name",
        ".trellis/tasks/.. /evil",
        ".trellis/tasks/evil./x",
        ".trellis/tasks/evil /x",
        "elsewhere/tasks/evil",
    ] {
        assert_eq!(resolve_task_dir_under(&root, invalid), None, "{invalid}");
    }
}

#[cfg(windows)]
#[test]
fn resolves_task_directory_for_extended_windows_root() {
    let root = Path::new(r"\\?\D:\repo\.trellis\tasks");
    assert_eq!(
        resolve_task_dir_under(root, ".trellis/tasks/11-12-demo"),
        Some(root.join("11-12-demo"))
    );
}

#[test]
fn compares_versions() {
    assert_eq!(compare_versions("0.6.17", "0.6.17"), Some(0));
    assert_eq!(compare_versions("0.6.16", "0.6.17"), Some(-1));
    assert_eq!(compare_versions("1.0.0", "0.9.9"), Some(1));
    assert_eq!(compare_versions("1.0", "1.0.0"), None);
}

#[test]
fn rejects_unsafe_payloads() {
    let command = json!({
        "id": "cmd-1",
        "bindingId": "bind-1",
        "type": "refresh_status",
        "payload": { "unexpected": true }
    });
    assert!(validate_command(&command).is_err());
    let ok = json!({
        "id": "cmd-1",
        "bindingId": "bind-1",
        "type": "sync_branch",
        "payload": { "taskSpaceId": "ts-1" }
    });
    assert_eq!(validate_command(&ok).unwrap().kind, COMMAND_SYNC_BRANCH);
}

#[test]
fn accepts_control_fields_added_to_task_commands() {
    let command = json!({
        "id": "cmd-1",
        "bindingId": "bind-1",
        "type": "create_task",
        "payload": {
            "taskSpaceId": "space-1",
            "assigneeUserId": "user-b",
            "title": "Fix it",
            "taskId": "task-a",
            "taskVersion": 1,
            "executionTaskKey": "space-1::task-a"
        }
    });
    let parsed = validate_command(&command).expect("控制面任务命令");
    assert_eq!(parsed.payload["taskId"], "task-a");
    assert_eq!(parsed.payload["taskVersion"], 1);
}

#[test]
fn redacts_secrets() {
    let text = safe_error_message("请求失败 Bearer abc.def-123 请重试");
    assert!(!text.contains("abc.def-123"));
}
