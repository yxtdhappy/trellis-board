use super::*;

#[test]
fn normalizes_server_urls() {
    assert_eq!(
        normalize_server_url("http://localhost:4310").unwrap(),
        "http://localhost:4310"
    );
    assert_eq!(
        normalize_server_url("http://spec-board.weintdata.cn/weint-spec-board/").unwrap(),
        "http://spec-board.weintdata.cn/weint-spec-board"
    );
    assert_eq!(
        server_origin("http://spec-board.weintdata.cn/weint-spec-board/").unwrap(),
        "http://spec-board.weintdata.cn"
    );
    assert_eq!(
        server_origin("https://[::1]:8443/weint-spec-board").unwrap(),
        "https://[::1]:8443"
    );
    assert!(normalize_server_url("http://localhost:4310/api").is_err());
    assert!(normalize_server_url("http://localhost:4310/weint-spec-board/login.html").is_err());
    assert!(normalize_server_url("http://localhost:4310/a//b").is_err());
    assert!(normalize_server_url("http://localhost:4310/../evil").is_err());
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

#[test]
fn parses_rejected_and_disabled_heartbeat_bindings() {
    let payload = json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "compatible": true,
        "bindings": [
            {
                "taskSpaceId": "space-missing",
                "status": "rejected",
                "errorCode": "BINDING_UNKNOWN",
                "error": "当前设备尚未接入该任务空间"
            },
            {
                "id": "binding-mismatch",
                "taskSpaceId": "space-mismatch",
                "status": "rejected",
                "errorCode": "REMOTE_MISMATCH",
                "error": "本地仓库与已绑定仓库不一致"
            },
            {
                "id": "binding-disabled",
                "taskSpaceId": "space-disabled",
                "projectId": "project-1",
                "localRepoKey": "a".repeat(64),
                "status": "disabled",
                "errorCode": "TASK_SPACE_RETIRED",
                "error": "任务空间已弃用"
            }
        ]
    });
    let parsed = parse_heartbeat_response(&payload).expect("heartbeat response");
    assert_eq!(parsed.bindings.len(), 3);

    assert_eq!(parsed.bindings[0].id, None);
    assert_eq!(parsed.bindings[0].project_id, None);
    assert_eq!(parsed.bindings[0].local_repo_key, None);
    assert_eq!(parsed.bindings[0].status, "rejected");
    assert_eq!(
        parsed.bindings[0].error_code.as_deref(),
        Some("BINDING_UNKNOWN")
    );

    assert_eq!(parsed.bindings[1].id.as_deref(), Some("binding-mismatch"));
    assert_eq!(parsed.bindings[1].project_id, None);
    assert_eq!(parsed.bindings[1].local_repo_key, None);
    assert_eq!(
        parsed.bindings[1].error_code.as_deref(),
        Some("REMOTE_MISMATCH")
    );

    assert_eq!(parsed.bindings[2].id.as_deref(), Some("binding-disabled"));
    assert_eq!(parsed.bindings[2].project_id.as_deref(), Some("project-1"));
    assert_eq!(parsed.bindings[2].status, "disabled");
    assert_eq!(
        parsed.bindings[2].error_code.as_deref(),
        Some("TASK_SPACE_RETIRED")
    );
}

#[test]
fn rejects_invalid_or_missing_heartbeat_binding_fields() {
    let cases = [
        (
            "approved missing id",
            json!({
                "taskSpaceId": "space-1",
                "projectId": "project-1",
                "localRepoKey": "a".repeat(64),
                "status": "approved"
            }),
            "绑定 ID 格式无效",
        ),
        (
            "disabled missing projectId",
            json!({
                "id": "binding-1",
                "taskSpaceId": "space-1",
                "localRepoKey": "a".repeat(64),
                "status": "disabled"
            }),
            "项目 ID 格式无效",
        ),
        (
            "approved missing localRepoKey",
            json!({
                "id": "binding-1",
                "taskSpaceId": "space-1",
                "projectId": "project-1",
                "status": "approved"
            }),
            "心跳响应包含无效本地仓库标识",
        ),
        (
            "rejected invalid id format",
            json!({
                "id": "bad id!",
                "taskSpaceId": "space-1",
                "status": "rejected"
            }),
            "绑定 ID 格式无效",
        ),
        (
            "rejected non-string projectId",
            json!({
                "taskSpaceId": "space-1",
                "projectId": 123,
                "status": "rejected"
            }),
            "项目 ID 格式无效",
        ),
        (
            "rejected invalid localRepoKey",
            json!({
                "taskSpaceId": "space-1",
                "localRepoKey": "not-sha256",
                "status": "rejected"
            }),
            "心跳响应包含无效本地仓库标识",
        ),
        (
            "unknown status",
            json!({
                "id": "binding-1",
                "taskSpaceId": "space-1",
                "projectId": "project-1",
                "localRepoKey": "a".repeat(64),
                "status": "unknown"
            }),
            "心跳响应包含未知绑定状态",
        ),
    ];

    for (label, binding_json, expected_message) in cases {
        let payload = json!({
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "compatible": true,
            "bindings": [binding_json]
        });
        let error = parse_heartbeat_response(&payload).expect_err(label);
        assert_eq!(error.code, code::INVALID_RESPONSE, "{label}");
        assert_eq!(error.message, expected_message, "{label}");
    }
}
