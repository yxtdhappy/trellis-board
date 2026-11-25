use super::*;
use crate::agent::task_sync::upload::prunable_task_directories;

fn snapshot_file(path: &str, task_dir: &str) -> SnapshotFile {
    SnapshotFile {
        path: path.to_string(),
        task_dir: task_dir.to_string(),
        file_path: path
            .strip_prefix(&format!("{task_dir}/"))
            .unwrap_or(path)
            .to_string(),
        archived: false,
        archive_month: None,
        content: String::new(),
        sha256: String::new(),
        deleted: false,
        base_sha256: None,
    }
}

fn entry(
    task_dir: &str,
    server_files: Vec<SnapshotFile>,
) -> (String, Option<SnapshotGroup>, Vec<SnapshotFile>) {
    (task_dir.to_string(), None, server_files)
}

#[test]
fn prunes_only_empty_remote_absent_local_directories_with_baselines() {
    let dead = ".trellis/tasks/11-20-handoff-manual-e2e-114216";
    let alive = ".trellis/tasks/11-25-project-rail-upload-status";
    let baselines = BTreeMap::from([
        (format!("{dead}/task.json"), "sha-dead".to_string()),
        (format!("{alive}/task.json"), "sha-alive".to_string()),
    ]);
    let entries = vec![
        entry(dead, Vec::new()),
        entry(alive, Vec::new()),
        entry(".trellis/tasks/11-25-never-baselined", Vec::new()),
        entry(
            ".trellis/tasks/11-25-server-has-files",
            vec![snapshot_file(
                ".trellis/tasks/11-25-server-has-files/task.json",
                ".trellis/tasks/11-25-server-has-files",
            )],
        ),
    ];
    let local = HashSet::new();

    assert_eq!(
        prunable_task_directories(&entries, &baselines, &local),
        vec![dead.to_string()]
    );
}

#[test]
fn keeps_baselines_while_local_directory_exists_or_server_has_live_files() {
    let dead = ".trellis/tasks/11-20-handoff-manual-e2e-114216";
    let baselines = BTreeMap::from([(format!("{dead}/task.json"), "sha".to_string())]);
    let entries = vec![entry(dead, Vec::new())];
    let local = HashSet::from([dead.to_string()]);

    assert!(prunable_task_directories(&entries, &baselines, &local).is_empty());

    let entries = vec![entry(
        dead,
        vec![snapshot_file(&format!("{dead}/task.json"), dead)],
    )];
    assert!(prunable_task_directories(&entries, &baselines, &HashSet::new()).is_empty());
}

#[test]
fn does_not_match_baselines_from_a_longer_directory_name() {
    let dir = ".trellis/tasks/11-20-handoff";
    let baselines = BTreeMap::from([(
        ".trellis/tasks/11-20-handoff-extra/task.json".to_string(),
        "sha".to_string(),
    )]);
    let entries = vec![entry(dir, Vec::new())];

    assert!(prunable_task_directories(&entries, &baselines, &HashSet::new()).is_empty());
}

#[test]
fn deduplicates_entries_for_the_same_directory() {
    let dir = ".trellis/tasks/11-20-handoff-manual-e2e-114216";
    let baselines = BTreeMap::from([(format!("{dir}/task.json"), "sha".to_string())]);
    let entries = vec![entry(dir, Vec::new()), entry(dir, Vec::new())];

    assert_eq!(
        prunable_task_directories(&entries, &baselines, &HashSet::new()),
        vec![dir.to_string()]
    );
}
