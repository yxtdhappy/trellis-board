use super::*;

#[tokio::test]
async fn clears_ownership_index_with_agent_transient_state() {
    let root =
        std::env::temp_dir().join(format!("trellis-device-transient-{}", uuid::Uuid::new_v4()));
    let store = ConfigStore::new_unsecured_for_test(root.clone());
    store.ensure_directories().await.expect("directories");
    tokio::fs::write(&store.paths.ownership_index_file, b"{}\n")
        .await
        .expect("ownership index");
    tokio::fs::write(&store.paths.task_control_file, b"{}\n")
        .await
        .expect("task control state");

    clear_agent_transient_state(&store)
        .await
        .expect("clear transient state");

    assert!(!store.paths.ownership_index_file.exists());
    assert!(!store.paths.task_control_file.exists());
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[test]
fn device_name_validation_boundaries() {
    assert!(validate_device_name("").is_err());
    assert!(validate_device_name("   ").is_err());
    assert!(validate_device_name(&"a".repeat(81)).is_err());
    assert!(validate_device_name("bad\u{1}name").is_err());
    assert_eq!(
        validate_device_name("  我的电脑  ").expect("trimmed"),
        "我的电脑"
    );
    assert_eq!(
        validate_device_name(&"a".repeat(80)).expect("80 chars"),
        "a".repeat(80)
    );
    assert_eq!(
        validate_device_name("").expect_err("empty").code,
        code::CONFIG_INVALID
    );
}

#[test]
fn username_and_password_validation() {
    assert_eq!(
        validate_username("  Fly.Fly6 ").expect("normalized"),
        "fly.fly6"
    );
    assert_eq!(
        validate_username("ab").unwrap_err().message,
        "登录名格式无效"
    );
    assert_eq!(
        validate_username("bad name").unwrap_err().message,
        "登录名格式无效"
    );
    assert_eq!(
        validate_password("12345").unwrap_err().message,
        "密码至少需要 6 个字符"
    );
    assert_eq!(
        validate_password(&"a".repeat(1025)).unwrap_err().message,
        "密码不能超过 1024 字节"
    );
    assert_eq!(validate_password("123456").expect("ok"), "123456");
    // 多字节字符按字符数而非字节数判断下限。
    assert!(validate_password("密码密码密码").is_ok());
}

#[test]
fn session_token_and_ids_validation() {
    assert!(validate_session_token("short").is_err());
    assert_eq!(
        validate_session_token(&"a".repeat(16)).expect("ok").len(),
        16
    );
    assert_eq!(
        validate_session_token("bad token with spaces")
            .unwrap_err()
            .message,
        "管理员会话 Cookie 格式无效"
    );
    assert_eq!(
        validate_enroll_token(&"a".repeat(31)).unwrap_err().message,
        "设备令牌格式无效"
    );
    assert!(validate_enroll_token(&"a".repeat(32)).is_ok());
}

#[test]
fn parses_session_cookie_rows() {
    let value = "c".repeat(24);
    let rows = vec![
        "other=1; Path=/".to_string(),
        format!("trellis_team_session={value}; Path=/; HttpOnly"),
    ];
    assert_eq!(parse_session_cookie(&rows).expect("parsed"), value);

    assert_eq!(
        parse_session_cookie(&[]).unwrap_err().message,
        "Board 登录响应缺少会话 Cookie"
    );
    let duplicated = vec![
        format!("trellis_team_session={value}"),
        format!("trellis_team_session={value}"),
    ];
    assert_eq!(
        parse_session_cookie(&duplicated).unwrap_err().message,
        "Board 登录响应包含重复会话 Cookie"
    );
    // 非会话 Cookie 不参与计数。
    let unrelated = vec!["theme=dark".to_string()];
    assert!(parse_session_cookie(&unrelated).is_err());
}

#[test]
fn local_association_round_trips_camel_case() {
    let association = LocalAssociation {
        project_id: "project-1".to_string(),
        task_space_id: "task-space-1".to_string(),
        repo_path: "C:/repo".to_string(),
        display_name: "Repo".to_string(),
        branch_name: "main".to_string(),
        team_id: Some("team-1".to_string()),
        status: "approved".to_string(),
        detach_pending: true,
        initial_review_pending: false,
        read_only: true,
        live_sync_status: "idle".to_string(),
        live_sync_error: None,
        deferred_count: 2,
        deferred_task_dirs: vec![
            ".trellis/tasks/11-12-a".to_string(),
            ".trellis/tasks/11-12-b".to_string(),
        ],
        deferred_tasks: vec![
            DeferredTaskInfo {
                task_dir: ".trellis/tasks/11-12-a".to_string(),
                title: Some("修复登录".to_string()),
            },
            DeferredTaskInfo {
                task_dir: ".trellis/tasks/11-12-b".to_string(),
                title: None,
            },
        ],
        ownership_paused_count: 1,
        ownership_paused_task_dirs: vec![".trellis/tasks/11-12-a".to_string()],
        ownership_pending_count: 1,
        ownership_pending_task_dirs: vec![".trellis/tasks/11-12-b".to_string()],
        pending_upload_count: 1,
        pending_upload_task_dirs: vec![".trellis/tasks/11-12-c".to_string()],
        pending_rejected_count: 1,
        pending_rejected_task_dirs: vec![".trellis/tasks/11-12-d".to_string()],
        conflict_pending_count: 1,
        conflict_pending_task_dirs: vec![".trellis/tasks/11-12-e".to_string()],
        last_error_code: Some("GIT_FAILED".to_string()),
        last_error: None,
    };
    let value = serde_json::to_value(&association).expect("serialize");
    assert_eq!(value["projectId"], "project-1");
    assert_eq!(value["taskSpaceId"], "task-space-1");
    assert_eq!(value["repoPath"], "C:/repo");
    assert_eq!(value["detachPending"], true);
    assert_eq!(value["readOnly"], true);
    assert_eq!(value["liveSyncStatus"], "idle");
    assert_eq!(value["deferredCount"], 2);
    assert_eq!(value["deferredTaskDirs"][0], ".trellis/tasks/11-12-a");
    assert_eq!(
        value["deferredTasks"][0]["taskDir"],
        ".trellis/tasks/11-12-a"
    );
    assert_eq!(value["deferredTasks"][0]["title"], "修复登录");
    assert!(value["deferredTasks"][1]["title"].is_null());
    assert_eq!(value["pendingUploadCount"], 1);
    assert_eq!(
        value["pendingRejectedTaskDirs"][0],
        ".trellis/tasks/11-12-d"
    );
    assert_eq!(
        value["conflictPendingTaskDirs"][0],
        ".trellis/tasks/11-12-e"
    );
    assert_eq!(value["lastErrorCode"], "GIT_FAILED");

    let minimal: LocalAssociation = serde_json::from_value(json!({
        "projectId": "p",
        "repoPath": "C:/r",
        "displayName": "d",
        "branchName": "main",
        "status": "approved",
        "readOnly": false,
    }))
    .expect("deserialize");
    assert_eq!(minimal.task_space_id, "");
    assert!(!minimal.detach_pending);
    assert_eq!(minimal.live_sync_status, "pending");
    assert!(minimal.deferred_tasks.is_empty());
    assert_eq!(minimal.pending_upload_count, 0);
    assert_eq!(minimal.pending_rejected_count, 0);
    assert_eq!(minimal.conflict_pending_count, 0);
}

#[test]
fn deferred_task_infos_extract_titles_or_none() {
    let root = std::env::temp_dir().join(format!("trellis-device-titles-{}", uuid::Uuid::new_v4()));
    let titled = root.join(".trellis/tasks/11-12-titled");
    let untitled = root.join(".trellis/tasks/11-12-untitled");
    let broken = root.join(".trellis/tasks/11-12-broken");
    for dir in [&titled, &untitled, &broken] {
        std::fs::create_dir_all(dir).expect("task dir");
    }
    std::fs::write(titled.join("task.json"), r#"{"title":"  修复登录  "}"#).expect("titled");
    std::fs::write(untitled.join("task.json"), r#"{"id":"demo"}"#).expect("untitled");
    std::fs::write(broken.join("task.json"), "{not json").expect("broken");

    let dirs = vec![
        ".trellis/tasks/11-12-titled".to_string(),
        ".trellis/tasks/11-12-untitled".to_string(),
        ".trellis/tasks/11-12-broken".to_string(),
        ".trellis/tasks/11-12-missing".to_string(),
    ];
    let infos = deferred_task_infos(&root, &dirs);
    assert_eq!(infos.len(), 4);
    assert_eq!(infos[0].task_dir, ".trellis/tasks/11-12-titled");
    assert_eq!(infos[0].title.as_deref(), Some("修复登录"));
    assert_eq!(infos[1].title, None);
    assert_eq!(infos[2].title, None);
    assert_eq!(infos[3].title, None);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn association_cursor_status_dirs_are_read_only_projections() {
    let cursors = json!({
        "taskSpaces": {
            "space-1": {
                "pending": {
                    "files": [
                        { "path": ".trellis/tasks/pending/task.json" },
                        { "path": ".trellis/tasks/pending/prd.md" }
                    ]
                },
                "pendingRejected": {
                    ".trellis/tasks/rejected": { "reason": "TASK_OWNERSHIP_REQUIRED" }
                },
                "conflictBlocked": {
                    ".trellis/tasks/conflict": { "conflictId": "conflict-1" }
                }
            }
        }
    });
    assert_eq!(
        pending_upload_task_dirs(&cursors, "space-1"),
        vec![".trellis/tasks/pending".to_string()]
    );
    assert_eq!(
        cursor_task_dirs(&cursors, "space-1", "pendingRejected"),
        vec![".trellis/tasks/rejected".to_string()]
    );
    assert_eq!(
        cursor_task_dirs(&cursors, "space-1", "conflictBlocked"),
        vec![".trellis/tasks/conflict".to_string()]
    );
}

#[test]
fn deferred_task_dirs_exclude_readonly_mirrors() {
    let cursors = json!({
        "taskSpaces": {
            "space-1": {
                "deferred": {
                    ".trellis/tasks/foreign": {
                        ".trellis/tasks/foreign/task.json": "a".repeat(64)
                    },
                    ".trellis/tasks/mine": {
                        ".trellis/tasks/mine/task.json": "b".repeat(64)
                    }
                },
                "readonlyTaskDirs": {
                    ".trellis/tasks/foreign": "FOREIGN_OWNER:user-1"
                }
            }
        }
    });
    assert_eq!(
        deferred_task_dirs(&cursors, "space-1"),
        vec![".trellis/tasks/mine".to_string()]
    );
}

#[test]
fn login_summary_uses_camel_case_and_skips_missing_fields() {
    let pending = DesktopLoginSummary {
        ok: true,
        session_token: None,
        expires_at: None,
        username: None,
        must_change_password: None,
        device_ready: None,
        error: None,
        code: None,
    };
    assert_eq!(
        serde_json::to_value(&pending).expect("serialize"),
        json!({ "ok": true })
    );

    let ready = DesktopLoginSummary {
        ok: true,
        session_token: Some("token".to_string()),
        expires_at: Some("2026-01-01T00:00:00.000Z".to_string()),
        username: Some("fly".to_string()),
        must_change_password: Some(false),
        device_ready: Some(true),
        error: None,
        code: None,
    };
    let value = serde_json::to_value(&ready).expect("serialize");
    assert_eq!(value["sessionToken"], "token");
    assert_eq!(value["expiresAt"], "2026-01-01T00:00:00.000Z");
    assert_eq!(value["mustChangePassword"], false);
    assert_eq!(value["deviceReady"], true);
    assert!(value.get("error").is_none());
    assert!(value.get("code").is_none());
}

#[test]
fn maps_enroll_errors() {
    let terminal = map_enroll_error(AgentError::new(code::DESKTOP_TOKEN_INVALID, "令牌无效"));
    assert_eq!(terminal.code, code::DESKTOP_TOKEN_INVALID);
    assert_eq!(terminal.message, "令牌无效");
    assert!(terminal.terminal);

    let network = map_enroll_error(AgentError::new(code::NETWORK_ERROR, "connection refused"));
    assert_eq!(network.code, code::NETWORK_ERROR);
    assert_eq!(network.message, "无法连接 Board 服务端，请检查网络后重试");
    assert!(network.retryable);

    let other = map_enroll_error(AgentError::new(code::CONFIG_INVALID, "配置无效"));
    assert_eq!(other.code, code::CONFIG_INVALID);
    assert_eq!(other.message, "配置无效");
    assert!(!other.retryable);
}

#[tokio::test]
async fn login_desktop_reuses_device_and_merges_unknown_and_disabled_bindings() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock addr");
    let server_url = format!("http://{address}");
    let repo_key_disabled = "b".repeat(64);
    let repo_key_disabled_clone = repo_key_disabled.clone();

    let server_task = tokio::spawn(async move {
        for _ in 0..3 {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let repo_key_disabled = repo_key_disabled_clone.clone();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                let header_end = loop {
                    if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break index;
                    }
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..read]);
                };
                let header = String::from_utf8_lossy(&request[..header_end]).into_owned();
                let request_line = header.lines().next().unwrap_or("").to_string();
                let content_length = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                while request.len() < header_end + 4 + content_length {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                }

                let (status, extra_headers, body) =
                    if request_line.starts_with("POST /api/auth/login ") {
                        (
                            "200 OK",
                            format!(
                                "Set-Cookie: {SESSION_COOKIE}={}; Path=/; HttpOnly\r\n",
                                "s".repeat(24)
                            ),
                            json!({
                                "user": { "username": "dev", "mustChangePassword": false },
                                "expiresAt": "2026-12-01T00:00:00.000Z"
                            }),
                        )
                    } else if request_line.starts_with("GET /api/runtime ") {
                        (
                            "200 OK",
                            String::new(),
                            json!({
                                "authenticated": true,
                                "user": { "username": "dev" },
                                "teams": [],
                                "allowLocalGitRemotes": false
                            }),
                        )
                    } else if request_line.starts_with("POST /api/agent/heartbeat ") {
                        (
                            "200 OK",
                            String::new(),
                            json!({
                                "protocolVersion": AGENT_PROTOCOL_VERSION,
                                "compatible": true,
                                "bindings": [
                                    {
                                        "taskSpaceId": "space-unknown",
                                        "status": "rejected",
                                        "errorCode": "BINDING_UNKNOWN",
                                        "error": "当前设备尚未接入该任务空间"
                                    },
                                    {
                                        "id": "binding-disabled",
                                        "taskSpaceId": "space-disabled",
                                        "projectId": "project-1",
                                        "localRepoKey": repo_key_disabled,
                                        "status": "disabled",
                                        "errorCode": "TASK_SPACE_DISABLED",
                                        "error": "任务空间已停用"
                                    }
                                ]
                            }),
                        )
                    } else {
                        (
                            "404 Not Found",
                            String::new(),
                            json!({ "error": "unexpected path" }),
                        )
                    };

                let body_bytes = serde_json::to_vec(&body).expect("serialize response");
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body_bytes.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&body_bytes).await;
            });
        }
    });

    let root = std::env::temp_dir().join(format!("trellis-device-login-{}", uuid::Uuid::new_v4()));
    let store = ConfigStore::new_unsecured_for_test(root.clone());
    store.ensure_directories().await.expect("directories");
    CredentialStore::new(&store)
        .save_credential(&"x".repeat(32))
        .await
        .expect("save credential");
    let existing = AgentConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        revision: create_config_revision(),
        server_url: server_url.clone(),
        ca_file: None,
        allow_local_git_remotes: false,
        agent_id: "agent-1".to_string(),
        device_name: "MyPC".to_string(),
        username: Some("dev".to_string()),
        team_id: None,
        teams: Vec::new(),
        protocol_version: AGENT_PROTOCOL_VERSION,
        agent_version: Some(AGENT_VERSION.to_string()),
        paired_at: Some("2026-11-01T00:00:00.000Z".to_string()),
        bindings: vec![
            AgentBinding {
                local_id: "local-unknown".to_string(),
                server_binding_id: Some("binding-unknown".to_string()),
                task_space_id: "space-unknown".to_string(),
                project_id: "project-1".to_string(),
                repo_path: "C:/repos/unknown".to_string(),
                branch_name: "main".to_string(),
                baseline_branch: None,
                team_id: None,
                remote_identity_key: "a".repeat(64),
                local_repo_key: "a".repeat(64),
                display_name: "UnknownRepo".to_string(),
                created_at: "2026-11-01T00:00:00.000Z".to_string(),
                allow_file_remote: false,
                read_only: false,
                sync_status: "approved".to_string(),
                detach_pending: false,
                initial_sync_mode: "bootstrap".to_string(),
                initial_sync_completed: true,
                initial_review_pending: false,
                tracked_task_dirs: Vec::new(),
                live_sync_status: "ready".to_string(),
                live_sync_error: None,
                last_synced_at: None,
                last_head: None,
                last_error: None,
                last_error_code: None,
            },
            AgentBinding {
                local_id: "local-disabled".to_string(),
                server_binding_id: Some("binding-disabled".to_string()),
                task_space_id: "space-disabled".to_string(),
                project_id: "project-1".to_string(),
                repo_path: "C:/repos/disabled".to_string(),
                branch_name: "main".to_string(),
                baseline_branch: None,
                team_id: None,
                remote_identity_key: "b".repeat(64),
                local_repo_key: repo_key_disabled,
                display_name: "DisabledRepo".to_string(),
                created_at: "2026-11-01T00:00:00.000Z".to_string(),
                allow_file_remote: false,
                read_only: false,
                sync_status: "approved".to_string(),
                detach_pending: false,
                initial_sync_mode: "bootstrap".to_string(),
                initial_sync_completed: true,
                initial_review_pending: false,
                tracked_task_dirs: Vec::new(),
                live_sync_status: "ready".to_string(),
                live_sync_error: None,
                last_synced_at: None,
                last_head: None,
                last_error: None,
                last_error_code: None,
            },
        ],
    };
    store
        .update_config(true, move |_| Ok(Some(existing)))
        .await
        .expect("write initial config");

    let api = ApiClient::new(&server_url, None, None).expect("api client");
    let summary = login_desktop(&store, &api, "dev", "secret123", "MyPC", false)
        .await
        .expect("login succeeds");
    assert!(summary.ok);
    assert_eq!(summary.device_ready, Some(true));

    let saved = store
        .read_config(false)
        .await
        .expect("read config")
        .expect("config exists");
    let unknown = saved
        .bindings
        .iter()
        .find(|item| item.task_space_id == "space-unknown")
        .expect("space-unknown");
    assert_eq!(unknown.sync_status, "rejected");
    assert_eq!(unknown.server_binding_id, None);
    assert_eq!(unknown.last_error_code.as_deref(), Some("BINDING_UNKNOWN"));
    assert_eq!(
        unknown.last_error.as_deref(),
        Some("当前设备尚未接入该任务空间")
    );

    let disabled = saved
        .bindings
        .iter()
        .find(|item| item.task_space_id == "space-disabled")
        .expect("space-disabled");
    assert_eq!(disabled.sync_status, "disabled");
    assert_eq!(
        disabled.server_binding_id.as_deref(),
        Some("binding-disabled")
    );
    assert_eq!(
        disabled.last_error_code.as_deref(),
        Some("TASK_SPACE_DISABLED")
    );
    assert_eq!(disabled.last_error.as_deref(), Some("任务空间已停用"));

    server_task.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn session_client_sends_subpath_url_with_pure_origin_header() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let address = listener.local_addr().expect("local addr");
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("accept");
        let mut buf = [0u8; 4096];
        let read = socket.read(&mut buf).await.expect("read");
        let raw = String::from_utf8_lossy(&buf[..read]).to_string();
        let body = r#"{"user":{"username":"alice","mustChangePassword":false},"expiresAt":"2099-01-01T00:00:00Z"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: trellis_team_session={}; Path=/weint-spec-board; HttpOnly\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            "t".repeat(32),
            body.len(),
            body
        );
        socket
            .write_all(response.as_bytes())
            .await
            .expect("write response");
        raw
    });

    let client =
        SessionClient::new(&format!("http://{address}/weint-spec-board/")).expect("client");
    let session = login_request(&client, "alice", "Secret-123")
        .await
        .expect("login succeeds");
    assert_eq!(session.username, "alice");

    let captured = server.await.expect("server join");
    let normalized = captured.replace("\r\n", "\n");
    assert!(
        normalized.starts_with("POST /weint-spec-board/api/auth/login "),
        "unexpected request line: {normalized}"
    );
    assert!(
        normalized
            .to_ascii_lowercase()
            .contains(&format!("\norigin: http://{address}\n")),
        "expected pure origin header without subpath, got: {normalized}"
    );
}
