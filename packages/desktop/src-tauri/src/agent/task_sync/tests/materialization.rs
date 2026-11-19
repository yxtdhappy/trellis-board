use super::support::*;
use super::*;

async fn materialize_fixture(
    prefix: &str,
    files: Vec<Value>,
) -> (PathBuf, Arc<ConfigStore>, Arc<TaskSync>, AgentBinding) {
    let (root, store, _sync, binding) = test_task_sync_fixture(prefix).await;
    let (server_url, _changes, _requests, _server_task) = mock_api_server(json!({
        "revision": 4,
        "files": files
    }))
    .await;
    let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
    let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
    sync.set_bindings(vec![binding.clone()]).await;
    (root, store, sync, binding)
}

#[tokio::test]
async fn materialize_task_directory_writes_server_snapshot() {
    let task_dir = ".trellis/tasks/task-mat";
    let task_json = "{\"id\":\"task-mat\",\"branch\":\"main\",\"title\":\"Mat\"}\n";
    let (_root, _store, sync, binding) = materialize_fixture(
        "trellis-materialize-ok",
        vec![
            snapshot_file_value(format!("{task_dir}/task.json"), task_json),
            snapshot_file_value(format!("{task_dir}/prd.md"), "# Mat\n"),
        ],
    )
    .await;
    let repo = Path::new(&binding.repo_path);

    let written = sync
        .materialize_task_directory(&binding, task_dir)
        .await
        .expect("materialize");
    assert_eq!(written.len(), 2);
    assert_eq!(
        tokio::fs::read_to_string(repo.join(format!("{task_dir}/task.json")))
            .await
            .expect("task json"),
        task_json
    );
    assert_eq!(
        tokio::fs::read_to_string(repo.join(format!("{task_dir}/prd.md")))
            .await
            .expect("prd"),
        "# Mat\n"
    );
}

#[tokio::test]
async fn materialize_task_directory_rejects_existing_target() {
    let task_dir = ".trellis/tasks/task-mat";
    let (_root, _store, sync, binding) = materialize_fixture(
        "trellis-materialize-existing",
        vec![snapshot_file_value(
            format!("{task_dir}/task.json"),
            "{\"id\":\"task-mat\",\"branch\":\"main\"}\n",
        )],
    )
    .await;
    let repo = Path::new(&binding.repo_path);
    tokio::fs::create_dir_all(repo.join(task_dir))
        .await
        .expect("existing target");

    let error = sync
        .materialize_task_directory(&binding, task_dir)
        .await
        .expect_err("existing target");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(error.message.contains("已存在"));
}

#[tokio::test]
async fn materialize_task_directory_rejects_empty_snapshot() {
    let task_dir = ".trellis/tasks/task-mat";
    let (_root, _store, sync, binding) = materialize_fixture(
        "trellis-materialize-empty",
        vec![snapshot_file_value(
            ".trellis/tasks/archive/2026-11/task-old/task.json",
            "{\"id\":\"task-old\"}\n",
        )],
    )
    .await;

    let error = sync
        .materialize_task_directory(&binding, task_dir)
        .await
        .expect_err("archive-only snapshot");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(error.message.contains("文件为空"));
}

#[tokio::test]
async fn materialize_task_directory_requires_task_json() {
    let task_dir = ".trellis/tasks/task-mat";
    let (_root, _store, sync, binding) = materialize_fixture(
        "trellis-materialize-no-task-json",
        vec![snapshot_file_value(
            format!("{task_dir}/prd.md"),
            "# Missing task.json\n",
        )],
    )
    .await;

    let error = sync
        .materialize_task_directory(&binding, task_dir)
        .await
        .expect_err("missing task.json");
    assert_eq!(error.code, code::INVALID_RESPONSE);
    assert!(error.message.contains("task.json"));
}
