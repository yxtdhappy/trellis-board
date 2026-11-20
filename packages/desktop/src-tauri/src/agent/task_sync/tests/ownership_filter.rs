use super::support::*;
use super::*;

async fn write_task_content(repo: &Path, task_dir: &str, content: &str) {
    let directory = repo.join(task_dir);
    tokio::fs::create_dir_all(&directory)
        .await
        .expect("task dir");
    tokio::fs::write(directory.join("task.json"), content)
        .await
        .expect("task json");
}

fn task_dirs(groups: &[SnapshotGroup]) -> Vec<String> {
    let mut dirs = groups
        .iter()
        .map(|group| group.task_dir.clone())
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

#[tokio::test]
async fn foreign_task_dirs_dropped_but_unowned_kept() {
    let (root, store, sync, mut binding) = test_task_sync_fixture("trellis-foreign-owner").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_content(
        repo,
        ".trellis/tasks/foreign",
        "{\"id\":\"foreign\",\"branch\":\"main\",\"creator\":\"alice\",\"assignee\":\"yhj\"}\n",
    )
    .await;
    write_task_content(
        repo,
        ".trellis/tasks/mine-assignee",
        "{\"id\":\"mine-assignee\",\"branch\":\"main\",\"creator\":\"yhj\",\"assignee\":\"DEV\"}\n",
    )
    .await;
    write_task_content(
        repo,
        ".trellis/tasks/mine-creator",
        "{\"id\":\"mine-creator\",\"branch\":\"main\",\"creator\":\"dev\"}\n",
    )
    .await;
    write_task_content(
        repo,
        ".trellis/tasks/no-owner",
        "{\"id\":\"no-owner\",\"branch\":\"main\"}\n",
    )
    .await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let groups = sync
        .local_groups(&binding, None)
        .await
        .expect("local groups");
    assert_eq!(
        task_dirs(&groups),
        vec![
            ".trellis/tasks/mine-assignee".to_string(),
            ".trellis/tasks/mine-creator".to_string(),
            ".trellis/tasks/no-owner".to_string(),
        ]
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn writable_control_row_keeps_foreign_task_dir() {
    let (root, store, sync, mut binding) = test_task_sync_fixture("trellis-foreign-control").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_content(
        repo,
        ".trellis/tasks/foreign",
        "{\"id\":\"foreign\",\"branch\":\"main\",\"creator\":\"alice\",\"assignee\":\"yhj\"}\n",
    )
    .await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);
    binding.initial_sync_completed = true;
    store
        .save_config(test_config(binding.clone()))
        .await
        .expect("config");

    let mut state = TaskControlStateFile::empty();
    state
        .upsert_control(
            &binding.local_id,
            &TaskControl {
                execution_task_key: "space-1::foreign".to_string(),
                task_id: "foreign".to_string(),
                relative_dir: ".trellis/tasks/foreign".to_string(),
                title: "他人任务".to_string(),
                state: "materialized".to_string(),
                task_version: 2,
                assignee_user_id: Some("user-a".to_string()),
                handoff_state: "none".to_string(),
                materialized_revision: None,
                content_revision: None,
                materialized_at: None,
                lease_held_by_other_user: false,
                updated_at: "2026-11-20T00:00:00.000Z".to_string(),
            },
        )
        .expect("persist control");
    store
        .write_json(&store.paths.task_control_file, &state)
        .await
        .expect("write control state");

    let groups = sync
        .local_groups(&binding, None)
        .await
        .expect("local groups");
    assert_eq!(
        task_dirs(&groups),
        vec![".trellis/tasks/foreign".to_string()]
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn missing_local_identity_keeps_all_groups() {
    let (root, _store, sync, binding) = test_task_sync_fixture("trellis-foreign-fail-open").await;
    let repo = Path::new(&binding.repo_path);
    init_git_repo(repo);
    write_task_content(
        repo,
        ".trellis/tasks/foreign",
        "{\"id\":\"foreign\",\"branch\":\"main\",\"creator\":\"alice\",\"assignee\":\"yhj\"}\n",
    )
    .await;
    run_git(repo, &["add", ".trellis/tasks"]);
    run_git(repo, &["commit", "--no-verify", "-m", "task"]);

    let groups = sync
        .local_groups(&binding, None)
        .await
        .expect("local groups");
    assert_eq!(
        task_dirs(&groups),
        vec![".trellis/tasks/foreign".to_string()]
    );

    let _ = tokio::fs::remove_dir_all(root).await;
}
