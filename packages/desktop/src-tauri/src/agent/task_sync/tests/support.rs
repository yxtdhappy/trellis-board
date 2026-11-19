use super::*;

pub(super) fn test_binding(task_space_id: &str) -> AgentBinding {
    AgentBinding {
        local_id: format!("local-{task_space_id}"),
        server_binding_id: Some(format!("binding-{task_space_id}")),
        task_space_id: task_space_id.to_string(),
        project_id: "project-1".to_string(),
        repo_path: format!("C:/repos/{task_space_id}"),
        branch_name: "main".to_string(),
        baseline_branch: None,
        team_id: None,
        remote_identity_key: "a".repeat(64),
        local_repo_key: "b".repeat(64),
        display_name: "Repo".to_string(),
        created_at: "2026-11-12T00:00:00.000Z".to_string(),
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
    }
}

pub(super) fn run_git(repo: &Path, args: &[&str]) {
    let output = std::process::Command::new(crate::agent::git::GIT_BINARY)
        .args(["-C", repo.to_str().expect("utf8 path")])
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

pub(super) fn init_git_repo(repo: &Path) {
    run_git(repo, &["init", "--initial-branch=main"]);
    run_git(repo, &["config", "user.email", "test@example.com"]);
    run_git(repo, &["config", "user.name", "Test"]);
    run_git(repo, &["config", "commit.gpgsign", "false"]);
}

pub(super) async fn write_task_json(repo: &Path, task_dir: &str, task_id: &str, branch: &str) {
    let directory = repo.join(task_dir);
    tokio::fs::create_dir_all(&directory)
        .await
        .expect("task directory");
    tokio::fs::write(
        directory.join("task.json"),
        format!("{{\"id\":\"{task_id}\",\"branch\":\"{branch}\"}}\n"),
    )
    .await
    .expect("task json");
}

pub(super) async fn mock_api_server(
    snapshot_payload: Value,
) -> (
    String,
    Arc<Mutex<Vec<Value>>>,
    Arc<Mutex<Vec<String>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock server");
    let address = listener.local_addr().expect("mock address");
    let changes = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let write_response_index = Arc::new(Mutex::new(0usize));
    let snapshot_payload = Arc::new(snapshot_payload);
    let captured_changes = changes.clone();
    let captured_requests = requests.clone();
    let captured_write_response_index = write_response_index.clone();
    let captured_snapshot_payload = snapshot_payload.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let changes = captured_changes.clone();
            let requests = captured_requests.clone();
            let write_response_index = captured_write_response_index.clone();
            let snapshot_payload = captured_snapshot_payload.clone();
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
                let header = String::from_utf8_lossy(&request[..header_end]).to_string();
                let has_json_content_type = header.lines().any(|line| {
                    let Some((name, value)) = line.split_once(':') else {
                        return false;
                    };
                    name.eq_ignore_ascii_case("content-type")
                        && value
                            .trim()
                            .to_ascii_lowercase()
                            .starts_with("application/json")
                });
                let content_length = header
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                while request.len() < header_end + 4 + content_length {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        return;
                    }
                    request.extend_from_slice(&chunk[..read]);
                }
                let body_start = header_end + 4;
                let body = serde_json::from_slice::<Value>(
                    &request[body_start..body_start + content_length],
                )
                .unwrap_or(Value::Null);
                let request_line = header.lines().next().unwrap_or_default();
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                requests.lock().await.push(format!("{method} {path}"));
                let write_response = if method == "POST" && path.ends_with("/changes") {
                    let mut index = write_response_index.lock().await;
                    let current = *index;
                    *index += 1;
                    snapshot_payload
                        .get("writeResponses")
                        .and_then(Value::as_array)
                        .and_then(|responses| responses.get(current))
                        .cloned()
                } else {
                    None
                };
                let (status, payload) = if method != "GET"
                    && method != "HEAD"
                    && !has_json_content_type
                {
                    (
                        "415 Unsupported Media Type",
                        json!({ "code": "JSON_REQUIRED" }),
                    )
                } else if path.contains("/snapshot?") {
                    ("200 OK", snapshot_payload.as_ref().clone())
                } else if path.contains("/files?") {
                    let status = snapshot_payload
                        .get("directoryStatus")
                        .and_then(Value::as_u64)
                        .unwrap_or(200);
                    match status {
                        403 => ("403 Forbidden", json!({ "code": "FORBIDDEN" })),
                        404 => ("404 Not Found", json!({ "code": "TASK_NOT_FOUND" })),
                        409 => (
                            "409 Conflict",
                            snapshot_payload
                                .get("directoryPayload")
                                .cloned()
                                .unwrap_or_else(
                                    || json!({ "code": "ARCHIVE_SYNC_SERVER_MANAGED" }),
                                ),
                        ),
                        _ => (
                            "200 OK",
                            json!({
                                "files": snapshot_payload
                                    .get("files")
                                    .cloned()
                                    .unwrap_or_else(|| Value::Array(Vec::new()))
                            }),
                        ),
                    }
                } else if method == "PUT" && path.ends_with("/cursor") {
                    ("200 OK", json!({}))
                } else if method == "PUT" && path.ends_with("/ownership-inbox") {
                    ("200 OK", json!({ "ok": true }))
                } else if method == "POST" && path.ends_with("/changes") {
                    changes.lock().await.push(body);
                    match write_response.or_else(|| snapshot_payload.get("writeResponse").cloned())
                    {
                        Some(response) => {
                            let status = response
                                .get("status")
                                .and_then(Value::as_u64)
                                .unwrap_or(200);
                            let status_line = match status {
                                400 => "400 Bad Request",
                                404 => "404 Not Found",
                                405 => "405 Method Not Allowed",
                                409 => "409 Conflict",
                                429 => "429 Too Many Requests",
                                500 => "500 Internal Server Error",
                                _ => "200 OK",
                            };
                            (
                                status_line,
                                response.get("payload").cloned().unwrap_or(Value::Null),
                            )
                        }
                        None => (
                            "200 OK",
                            json!({
                                "revision": snapshot_payload
                                    .get("writeRevision")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(2)
                            }),
                        ),
                    }
                } else if method == "GET" && path.starts_with("/api/agent/tasks/") {
                    let key = decode_mock_task_key(path.trim_start_matches("/api/agent/tasks/"));
                    let control = snapshot_payload
                        .get("controls")
                        .and_then(Value::as_array)
                        .and_then(|controls| {
                            controls.iter().find(|control| {
                                control.get("executionTaskKey").and_then(Value::as_str)
                                    == Some(key.as_str())
                            })
                        });
                    match control {
                        Some(control) => (
                            "200 OK",
                            json!({
                                "task": remote_task_from_control(control),
                                "contentAvailable": false,
                            }),
                        ),
                        None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                    }
                } else if method == "POST" && path.ends_with("/claim") {
                    let encoded = path
                        .trim_start_matches("/api/agent/tasks/")
                        .trim_end_matches("/claim");
                    let key = decode_mock_task_key(encoded);
                    let control = snapshot_payload
                        .get("controls")
                        .and_then(Value::as_array)
                        .and_then(|controls| {
                            controls.iter().find(|control| {
                                control.get("executionTaskKey").and_then(Value::as_str)
                                    == Some(key.as_str())
                            })
                        });
                    match control {
                        Some(control) => (
                            "200 OK",
                            json!({
                                "task": remote_task_from_control(control),
                                "lease": {
                                    "token": "lease-token",
                                    "expiresAt": "2099-01-01T00:00:00.000Z"
                                }
                            }),
                        ),
                        None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                    }
                } else if method == "POST" && path.ends_with("/heartbeat") {
                    let encoded = path
                        .trim_start_matches("/api/agent/tasks/")
                        .trim_end_matches("/heartbeat");
                    let key = decode_mock_task_key(encoded);
                    let control = snapshot_payload
                        .get("controls")
                        .and_then(Value::as_array)
                        .and_then(|controls| {
                            controls.iter().find(|control| {
                                control.get("executionTaskKey").and_then(Value::as_str)
                                    == Some(key.as_str())
                            })
                        });
                    match control {
                        Some(control) => (
                            "200 OK",
                            json!({
                                "task": remote_task_from_control(control),
                                "lease": {
                                    "token": body.get("leaseToken").and_then(Value::as_str).unwrap_or("lease-token"),
                                    "expiresAt": "2099-01-01T00:00:00.000Z"
                                }
                            }),
                        ),
                        None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                    }
                } else if method == "POST" && path.ends_with("/release") {
                    ("200 OK", json!({ "released": true, "idempotent": false }))
                } else {
                    ("404 Not Found", json!({ "error": "unexpected request" }))
                };
                let payload = serde_json::to_vec(&payload).expect("response json");
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&payload).await;
            });
        }
    });
    (format!("http://{address}"), changes, requests, task)
}

pub(super) fn decode_mock_task_key(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' && index + 2 < raw.len() {
            let hex = &value[index + 1..index + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                bytes.push(byte);
                index += 3;
                continue;
            }
        }
        bytes.push(raw[index]);
        index += 1;
    }
    String::from_utf8(bytes).unwrap_or_else(|_| value.to_string())
}

pub(super) fn remote_task_from_control(control: &Value) -> Value {
    let state = control
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("claimed");
    let materialization_state = match state {
        "pending_delivery" => "pending",
        "materialized" | "handoff_materialized" | "reassigned" | "archived" => "materialized",
        _ => "claimed",
    };
    let mut task = control.clone();
    task["archived"] = Value::Bool(state == "archived");
    task["materializationState"] = Value::String(materialization_state.to_string());
    task
}

pub(super) struct ReplayFixture {
    pub(super) root: PathBuf,
    pub(super) store: Arc<ConfigStore>,
    pub(super) sync: Arc<TaskSync>,
    pub(super) binding: AgentBinding,
    pub(super) changes: Arc<Mutex<Vec<Value>>>,
    pub(super) requests: Arc<Mutex<Vec<String>>>,
    pub(super) server_task: tokio::task::JoinHandle<()>,
    pub(super) old_files: Vec<Value>,
    pub(super) evidence: Value,
}

pub(super) async fn replay_fixture(prefix: &str, write_response: Option<Value>) -> ReplayFixture {
    let (root, store, _sync, mut binding) = test_task_sync_fixture(prefix).await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a";
    write_task_json(repo, task_dir, "task-a", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let old_content = "{\"id\":\"task-a\",\"branch\":null}\n";
    let old_files = vec![json!({
        "path": ".trellis/tasks/task-a/task.json",
        "content": old_content,
        "sha256": snapshot_sha256(old_content),
    })];
    let evidence = json!({
        "version": 1,
        "type": "tracked-in-head",
        "taskId": "task-a",
        "taskDir": task_dir,
        "trackedPath": ".trellis/tasks/task-a/task.json",
        "sourceBranch": "main",
        "baselineBranch": "team-board",
        "headCommit": "a".repeat(40),
    });
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
                        "baselines": {
                            ".trellis/tasks/task-a/task.json": snapshot_sha256(old_content)
                        },
                        "pending": {
                            "batchId": "pending-batch",
                            "clientSequence": 7,
                            "files": old_files.clone(),
                            "mergeEvidence": evidence.clone(),
                            "createdAt": "2026-11-17T08:52:29.033Z"
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");

    let mut snapshot = json!({
        "revision": 10,
        "files": [],
        "writeRevision": 20
    });
    if let Some(response) = write_response {
        snapshot["writeResponse"] = response;
    }
    let (server_url, changes, requests, server_task) = mock_api_server(snapshot).await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;
    ReplayFixture {
        root,
        store,
        sync,
        binding,
        changes,
        requests,
        server_task,
        old_files,
        evidence,
    }
}

pub(super) async fn test_task_sync_fixture(
    prefix: &str,
) -> (PathBuf, Arc<ConfigStore>, TaskSync, AgentBinding) {
    let root = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
    store.ensure_directories().await.expect("directories");
    let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
    let sink: ControlSink = Arc::new(|_| {});
    let sync = TaskSync::new(store.clone(), api, sink);
    let mut binding = test_binding("space-1");
    let repo_path = root.join("repo");
    tokio::fs::create_dir_all(repo_path.join(".trellis").join("tasks"))
        .await
        .expect("task root");
    binding.repo_path = repo_path.to_string_lossy().to_string();
    (root, store, sync, binding)
}

pub(super) async fn exact_deferred_fixture(
    prefix: &str,
) -> (PathBuf, Arc<ConfigStore>, AgentBinding, String) {
    let (root, store, _sync, mut binding) = test_task_sync_fixture(prefix).await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    let task_dir = ".trellis/tasks/task-a".to_string();
    write_task_json(repo, &task_dir, "task-a", "main").await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let task_hash = snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"main\"}\n");
    write_deferred_cursor(&store, &task_dir, &task_hash, &task_hash).await;
    (root, store, binding, task_dir)
}

pub(super) async fn write_deferred_cursor(
    store: &ConfigStore,
    task_dir: &str,
    baseline_hash: &str,
    deferred_hash: &str,
) {
    let task_json = format!("{task_dir}/task.json");
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
                            (task_json.clone()): baseline_hash
                        },
                        "deferred": {
                            (task_dir): {
                                (task_json): deferred_hash
                            }
                        }
                    }
                }
            }),
        )
        .await
        .expect("cursor");
}

pub(super) fn test_config(binding: AgentBinding) -> AgentConfig {
    AgentConfig {
        schema_version: crate::agent::store::CONFIG_SCHEMA_VERSION,
        revision: "0123456789abcdef0123456789abcdef".to_string(),
        server_url: "http://localhost:4310".to_string(),
        ca_file: None,
        allow_local_git_remotes: false,
        agent_id: "agent-1".to_string(),
        device_name: "PC".to_string(),
        username: Some("dev".to_string()),
        team_id: None,
        teams: Vec::new(),
        protocol_version: 3,
        agent_version: None,
        paired_at: None,
        bindings: vec![binding],
    }
}

pub(super) fn snapshot_file_value(path: impl Into<String>, content: impl Into<String>) -> Value {
    let path: String = path.into();
    let content: String = content.into();
    json!({
        "path": path,
        "content": content,
    })
}

pub(super) fn batch_file_values(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| snapshot_file_value(format!(".trellis/tasks/a/file-{index}.md"), ""))
        .collect()
}

pub(super) fn assert_cursor_patch_changes_once(
    cursor: &mut Cursor,
    make_patch: impl Fn() -> CursorPatch,
) {
    assert!(apply_cursor_patch(cursor, &make_patch()));
    assert!(!apply_cursor_patch(cursor, &make_patch()));
}

pub(super) fn task_group(task_id: &str, task_dir: &str, files: &[(&str, &str)]) -> SnapshotGroup {
    let mut snapshot_files = Vec::new();
    for (file_path, content) in files {
        snapshot_files.push(SnapshotFile {
            path: format!("{task_dir}/{file_path}"),
            task_dir: task_dir.to_string(),
            file_path: (*file_path).to_string(),
            archived: false,
            archive_month: None,
            content: (*content).to_string(),
            sha256: snapshot_sha256(content),
            deleted: false,
            base_sha256: None,
        });
    }
    SnapshotGroup {
        task_dir: task_dir.to_string(),
        archived: false,
        archive_month: None,
        files: snapshot_files,
        task_id: Some(task_id.to_string()),
        task_branch: None,
    }
}
