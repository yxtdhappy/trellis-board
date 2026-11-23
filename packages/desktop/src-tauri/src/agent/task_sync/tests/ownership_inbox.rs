use super::support::*;
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn mock_inbox_server(
    statuses: Vec<u16>,
) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind inbox server");
    let address = listener.local_addr().expect("inbox address");
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let captured = bodies.clone();
    let statuses = Arc::new(statuses);
    let response_index = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let server = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let bodies = captured.clone();
            let statuses = statuses.clone();
            let response_index = response_index.clone();
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
                let header = String::from_utf8_lossy(&request[..header_end]);
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
                        return;
                    }
                    request.extend_from_slice(&chunk[..read]);
                }
                let body_start = header_end + 4;
                let body = serde_json::from_slice::<Value>(
                    &request[body_start..body_start + content_length],
                )
                .unwrap_or(Value::Null);
                bodies.lock().await.push(body);
                let index = response_index.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let status = statuses
                    .get(index)
                    .copied()
                    .or_else(|| statuses.last().copied())
                    .unwrap_or(200);
                let reason = match status {
                    500 => "Internal Server Error",
                    _ => "OK",
                };
                let payload = if status == 200 {
                    json!({ "ok": true })
                } else {
                    json!({ "code": "TEST_FAILURE" })
                };
                let payload = serde_json::to_vec(&payload).expect("response json");
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&payload).await;
            });
        }
    });
    (format!("http://{address}"), bodies, server)
}

async fn inbox_fixture(
    prefix: &str,
    statuses: Vec<u16>,
) -> (
    PathBuf,
    Arc<ConfigStore>,
    Arc<TaskSync>,
    AgentBinding,
    Arc<Mutex<Vec<Value>>>,
    tokio::task::JoinHandle<()>,
) {
    let (root, store, _sync, binding) = test_task_sync_fixture(prefix).await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    tokio::fs::write(repo.join("README.md"), "fixture\n")
        .await
        .expect("readme");
    run_git(repo, &["add", "README.md"]);
    run_git(repo, &["commit", "--no-verify", "-m", "fixture"]);
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");
    let (server_url, bodies, server) = mock_inbox_server(statuses).await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;
    (root, store, sync, binding, bodies, server)
}

async fn write_ownership_cursor(
    store: &ConfigStore,
    ownership_pending: Value,
    pending_rejected: Value,
) {
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": {
                    "space-1": {
                        "ownershipPending": ownership_pending,
                        "pendingRejected": pending_rejected,
                    }
                }
            }),
        )
        .await
        .expect("ownership cursor");
}

fn pending_fingerprint() -> String {
    "a".repeat(64)
}

fn rejection() -> Value {
    json!({
        "batchId": "batch-1",
        "clientSequence": 1,
        "reason": "TASK_OWNERSHIP_REQUIRED",
        "createdAt": "2026-11-18T00:00:00.000Z",
        "blockedAt": "2026-11-18T00:00:01.000Z",
    })
}

#[tokio::test]
async fn cleanup_deleted_ownership_uses_task_dir_and_clears_both_ledgers() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup", vec![200]).await;
    let repo = Path::new(&binding.repo_path);
    let existing = ".trellis/tasks/existing";
    let missing = ".trellis/tasks/missing";
    write_task_json(repo, existing, "existing", "main").await;
    write_ownership_cursor(
        &store,
        json!({
            existing: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
            missing: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({ missing: rejection() }),
    )
    .await;

    let removed = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect("cleanup");
    assert_eq!(removed, vec![missing.to_string()]);
    let sent = bodies.lock().await.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["deletes"], json!([{ "taskDir": missing }]));
    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.ownership_pending.contains_key(missing));
    assert!(!cursor.pending_rejected.contains_key(missing));
    assert!(cursor.ownership_pending.contains_key(existing));

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_deleted_ownership_preserves_ledgers_on_server_failure() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup-500", vec![500]).await;
    let missing = ".trellis/tasks/missing";
    write_ownership_cursor(
        &store,
        json!({
            missing: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({ missing: rejection() }),
    )
    .await;

    let error = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect_err("server failure must be visible");
    assert_eq!(error.status, Some(500));
    assert_eq!(bodies.lock().await.len(), 1);
    let cursor = sync.read_cursor("space-1").await;
    assert!(cursor.ownership_pending.contains_key(missing));
    assert!(cursor.pending_rejected.contains_key(missing));

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_deleted_ownership_fails_closed_without_tasks_root() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup-root", vec![200]).await;
    let missing = ".trellis/tasks/missing";
    write_ownership_cursor(
        &store,
        json!({
            missing: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({ missing: rejection() }),
    )
    .await;
    tokio::fs::remove_dir_all(Path::new(&binding.repo_path).join(".trellis/tasks"))
        .await
        .expect("remove tasks root");

    let error = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect_err("missing root must fail closed");
    assert_eq!(error.code, code::MISSING_TRELLIS);
    assert!(bodies.lock().await.is_empty());
    let cursor = sync.read_cursor("space-1").await;
    assert!(cursor.ownership_pending.contains_key(missing));
    assert!(cursor.pending_rejected.contains_key(missing));

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_deleted_ownership_clears_ledger_against_old_server() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup-404", vec![404]).await;
    let missing = ".trellis/tasks/missing";
    write_ownership_cursor(
        &store,
        json!({
            missing: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({ missing: rejection() }),
    )
    .await;

    let removed = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect("old server cleanup");
    assert_eq!(removed, vec![missing.to_string()]);
    assert_eq!(bodies.lock().await.len(), 1);
    let cursor = sync.read_cursor("space-1").await;
    assert!(!cursor.ownership_pending.contains_key(missing));
    assert!(!cursor.pending_rejected.contains_key(missing));

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn ownership_inbox_upsert_reports_assignee_and_omits_unknown_owner() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-assignee", vec![200]).await;
    let owned = ".trellis/tasks/owned";
    let unowned = ".trellis/tasks/unowned";
    write_ownership_cursor(
        &store,
        json!({
            owned: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
            unowned: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({}),
    )
    .await;
    let groups = vec![
        task_group(
            "owned",
            owned,
            &[(
                "task.json",
                "{\"id\":\"owned\",\"branch\":null,\"assignee\":\"yuhaojie\"}\n",
            )],
        ),
        task_group(
            "unowned",
            unowned,
            &[("task.json", "{\"id\":\"unowned\",\"branch\":null}\n")],
        ),
    ];

    sync.sync_ownership_inbox(&binding, &BTreeSet::new(), &groups)
        .await;

    let sent = bodies.lock().await.clone();
    assert_eq!(sent.len(), 1);
    let upserts = sent[0]["upserts"].as_array().expect("upserts");
    assert_eq!(upserts.len(), 2);
    let owned_upsert = upserts
        .iter()
        .find(|item| item["taskDir"].as_str() == Some(owned))
        .expect("owned upsert");
    assert_eq!(owned_upsert["assigneeDevId"], json!("yuhaojie"));
    let unowned_upsert = upserts
        .iter()
        .find(|item| item["taskDir"].as_str() == Some(unowned))
        .expect("unowned upsert");
    assert!(unowned_upsert.get("assigneeDevId").is_none());

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn missing_local_group_never_guesses_ownership_delete() {
    let (root, _store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-no-guess", vec![200]).await;
    let missing = ".trellis/tasks/missing";
    let previous = BTreeSet::from([missing.to_string()]);

    sync.sync_ownership_inbox(&binding, &previous, &[]).await;

    assert!(bodies.lock().await.is_empty());
    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn resolved_ownership_delete_contains_only_task_dir() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-resolved", vec![200]).await;
    let task_dir = ".trellis/tasks/resolved";
    let task_json = "{\"id\":\"server-id\",\"branch\":\"main\"}\n";
    write_task_json(Path::new(&binding.repo_path), task_dir, "server-id", "main").await;
    write_ownership_cursor(
        &store,
        json!({
            task_dir: {
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            },
        }),
        json!({}),
    )
    .await;
    let previous = BTreeSet::from([task_dir.to_string()]);
    let groups = vec![task_group(
        "server-id",
        task_dir,
        &[("task.json", task_json)],
    )];
    store
        .write_json(
            &store.paths.task_cursors_file,
            &json!({
                "version": CURSOR_VERSION,
                "taskSpaces": { "space-1": {} }
            }),
        )
        .await
        .expect("resolved cursor");

    sync.sync_ownership_inbox(&binding, &previous, &groups)
        .await;

    let sent = bodies.lock().await.clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["deletes"], json!([{ "taskDir": task_dir }]));
    assert!(sent[0]["deletes"][0].get("taskId").is_none());

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_deleted_ownership_batches_before_clearing_ledgers() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup-batch", vec![200, 200]).await;
    let mut ownership = serde_json::Map::new();
    for index in 0..=OWNERSHIP_INBOX_MAX_CHANGES {
        ownership.insert(
            format!(".trellis/tasks/missing-{index}"),
            json!({
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            }),
        );
    }
    write_ownership_cursor(&store, Value::Object(ownership), json!({})).await;

    let removed = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect("batched cleanup");
    assert_eq!(removed.len(), OWNERSHIP_INBOX_MAX_CHANGES + 1);
    let sent = bodies.lock().await.clone();
    assert_eq!(sent.len(), 2);
    assert_eq!(
        sent[0]["deletes"].as_array().map(Vec::len),
        Some(OWNERSHIP_INBOX_MAX_CHANGES)
    );
    assert_eq!(sent[1]["deletes"].as_array().map(Vec::len), Some(1));
    assert!(sync
        .read_cursor("space-1")
        .await
        .ownership_pending
        .is_empty());

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn cleanup_deleted_ownership_keeps_all_ledgers_after_partial_batch_failure() {
    let (root, store, sync, binding, bodies, server) =
        inbox_fixture("ownership-inbox-cleanup-partial", vec![200, 500]).await;
    let mut ownership = serde_json::Map::new();
    for index in 0..=OWNERSHIP_INBOX_MAX_CHANGES {
        ownership.insert(
            format!(".trellis/tasks/missing-{index}"),
            json!({
                "fingerprint": pending_fingerprint(),
                "reason": "TASK_OWNERSHIP_REQUIRED",
            }),
        );
    }
    write_ownership_cursor(&store, Value::Object(ownership), json!({})).await;

    let error = sync
        .cleanup_missing_ownership_inbox(&binding, None)
        .await
        .expect_err("partial batch failure must be visible");
    assert_eq!(error.status, Some(500));
    assert_eq!(bodies.lock().await.len(), 2);
    assert_eq!(
        sync.read_cursor("space-1").await.ownership_pending.len(),
        OWNERSHIP_INBOX_MAX_CHANGES + 1
    );

    server.abort();
    let _ = tokio::fs::remove_dir_all(root).await;
}
