use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agent::git;
use crate::agent::store::{AgentBinding, AgentConfig};

#[derive(Debug, Clone)]
pub struct DiscoveredWorktree {
    pub path: String,
    pub branch_name: String,
    pub remote_identity_key: String,
    pub common_dir: String,
    pub baseline_head: Option<String>,
    pub baseline_task_dirs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalTask {
    pub task_dir: String,
    pub id: String,
    pub branch: String,
}

pub fn is_approved(binding: &AgentBinding) -> bool {
    binding.sync_status == "approved" && !binding.detach_pending
}

pub async fn discover(
    bindings: &[AgentBinding],
    hooks_dir: &Path,
) -> (Vec<DiscoveredWorktree>, bool) {
    let mut repos: BTreeMap<String, (PathBuf, String)> = BTreeMap::new();
    for binding in bindings.iter().filter(|binding| is_approved(binding)) {
        let path = PathBuf::from(&binding.repo_path);
        let key = tokio::fs::canonicalize(&path)
            .await
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|_| binding.repo_path.clone());
        repos
            .entry(key)
            .or_insert((path, binding.remote_identity_key.clone()));
    }
    let mut seen: BTreeMap<String, DiscoveredWorktree> = BTreeMap::new();
    let mut all_success = true;
    for (repo_path, remote_identity_key) in repos.values() {
        if !repo_path.is_dir() {
            continue;
        }
        let worktrees = match git::worktree_list(repo_path, hooks_dir).await {
            Ok(worktrees) => worktrees,
            Err(error) => {
                all_success = false;
                crate::logging::warn(&format!(
                    "读取 Git worktree 列表失败 path={} error={}",
                    repo_path.display(),
                    error.message
                ));
                continue;
            }
        };
        for (index, worktree) in worktrees.into_iter().enumerate() {
            // `git worktree list --porcelain` 第一项是主工作树。
            if index == 0 || worktree.bare || worktree.prunable {
                continue;
            }
            let common_dir = git::common_dir(&worktree.path);
            let key = worktree.path.to_string_lossy().to_string();
            if seen.contains_key(&key) {
                continue;
            }
            let baseline_head = git::head_commit(&worktree.path, hooks_dir, true)
                .await
                .ok()
                .flatten();
            let mut baseline: BTreeSet<String> =
                git::ls_tree(&worktree.path, hooks_dir, baseline_head.as_deref())
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(task_dir_from_tree_path)
                    .collect();
            for task in scan_active_tasks(&worktree.path).await {
                baseline.insert(task.task_dir);
            }
            seen.insert(
                key.clone(),
                DiscoveredWorktree {
                    path: key,
                    branch_name: worktree.branch.unwrap_or_default(),
                    remote_identity_key: remote_identity_key.clone(),
                    common_dir: common_dir
                        .map(|value| value.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    baseline_head,
                    baseline_task_dirs: baseline.into_iter().collect(),
                },
            );
        }
    }
    (seen.into_values().collect(), all_success)
}

fn task_dir_from_tree_path(path: String) -> Option<String> {
    let relative = path
        .strip_prefix(".trellis/tasks/")?
        .strip_suffix("/task.json")?;
    if relative.is_empty() || relative == "archive" || relative.starts_with("archive/") {
        return None;
    }
    Some(format!(".trellis/tasks/{relative}"))
}

pub async fn scan_active_tasks(root: &Path) -> Vec<LocalTask> {
    let tasks_root = root.join(".trellis").join("tasks");
    let mut entries = match tokio::fs::read_dir(&tasks_root).await {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut tasks = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_type = match entry.file_type().await {
            Ok(value) => value,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == "archive" {
            continue;
        }
        let task_dir = format!(".trellis/tasks/{name}");
        let raw = match tokio::fs::read_to_string(entry.path().join("task.json")).await {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let id = parsed
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or_default()
            .to_string();
        let branch = parsed
            .get("branch")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        tasks.push(LocalTask {
            task_dir,
            id,
            branch,
        });
    }
    tasks.sort_by(|left, right| left.task_dir.cmp(&right.task_dir));
    tasks
}

pub fn matching_task_dirs(tasks: &[LocalTask], branch_name: &str) -> BTreeSet<String> {
    tasks
        .iter()
        .filter(|task| task.branch == branch_name)
        .map(|task| task.task_dir.clone())
        .collect()
}

pub fn candidate_task_dirs(
    tasks: &[LocalTask],
    branch_name: &str,
    baseline: &[String],
    tracked: &[String],
) -> Vec<String> {
    let baseline: BTreeSet<&str> = baseline.iter().map(String::as_str).collect();
    let tracked: BTreeSet<&str> = tracked.iter().map(String::as_str).collect();
    matching_task_dirs(tasks, branch_name)
        .into_iter()
        .filter(|task_dir| !baseline.contains(task_dir.as_str()))
        .filter(|task_dir| !tracked.contains(task_dir.as_str()))
        .collect()
}

pub fn source_binding<'a>(
    config: &'a AgentConfig,
    remote_identity_key: &str,
) -> Option<&'a AgentBinding> {
    config
        .bindings
        .iter()
        .filter(|binding| is_approved(binding))
        .find(|binding| binding.remote_identity_key == remote_identity_key)
}

pub async fn developer_id(
    worktree: &Path,
    config: &AgentConfig,
    remote_identity_key: &str,
) -> Option<String> {
    let local = worktree.join(".trellis").join(".developer");
    if let Some(value) = read_developer_file(&local).await {
        return Some(value);
    }
    for binding in config.bindings.iter().filter(|binding| {
        is_approved(binding) && binding.remote_identity_key == remote_identity_key
    }) {
        let path = Path::new(&binding.repo_path)
            .join(".trellis")
            .join(".developer");
        if let Some(value) = read_developer_file(&path).await {
            return Some(value);
        }
    }
    config
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn read_developer_file(path: &Path) -> Option<String> {
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    raw.lines().find_map(|line| {
        line.trim()
            .strip_prefix("name=")
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(name: &str, branch: &str) -> LocalTask {
        LocalTask {
            task_dir: format!(".trellis/tasks/{name}"),
            id: name.to_string(),
            branch: branch.to_string(),
        }
    }

    #[test]
    fn candidates_require_branch_match_and_skip_baseline_and_tracked() {
        let tasks = vec![
            task("new", "feature"),
            task("other-branch", "main"),
            task("baseline", "feature"),
            task("tracked", "feature"),
        ];
        let candidates = candidate_task_dirs(
            &tasks,
            "feature",
            &[".trellis/tasks/baseline".to_string()],
            &[".trellis/tasks/tracked".to_string()],
        );
        assert_eq!(candidates, vec![".trellis/tasks/new".to_string()]);
    }

    #[test]
    fn tree_paths_ignore_archive_and_non_task_files() {
        assert_eq!(
            task_dir_from_tree_path(".trellis/tasks/demo/task.json".to_string()),
            Some(".trellis/tasks/demo".to_string())
        );
        assert_eq!(
            task_dir_from_tree_path(".trellis/tasks/archive/2026-11/demo/task.json".to_string()),
            None
        );
        assert_eq!(
            task_dir_from_tree_path(".trellis/tasks/demo/prd.md".to_string()),
            None
        );
    }
}
