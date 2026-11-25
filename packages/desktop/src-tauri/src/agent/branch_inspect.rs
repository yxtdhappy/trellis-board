//! 已关联仓库的本地分支读取；只读，不切换分支。

use std::path::Path;

use serde_json::{json, Value};

use crate::agent::git;
use crate::agent::protocol::{code, AgentResult};

/// 返回 `{ repoPath, currentBranch, branches }`；detached HEAD 时 `currentBranch` 为 null。
pub async fn inspect_branches(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Value> {
    let current_branch = match git::current_branch(repo_path, hooks_dir).await {
        Ok(branch) => Some(branch),
        Err(error) if error.code == code::DETACHED_HEAD => None,
        Err(error) => return Err(error),
    };
    let mut branches = git::branch_list(repo_path, hooks_dir).await?;
    if let Some(current) = current_branch.as_ref() {
        if !branches.iter().any(|branch| branch == current) {
            branches.insert(0, current.clone());
        }
    }
    Ok(json!({
        "repoPath": repo_path.to_string_lossy(),
        "currentBranch": current_branch,
        "branches": branches,
    }))
}

/// Board 命令入口：按已批准关联的仓库路径与临时 hooks 读取分支，并附带 `ok` 标记。
pub async fn inspect_associated_project_branches(
    repo_path: &str,
    hooks: &Path,
) -> Result<Value, String> {
    let inspected = inspect_branches(Path::new(repo_path), hooks).await;
    let _ = std::fs::remove_dir_all(hooks);
    let mut payload = inspected.map_err(|error| error.message)?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    Ok(payload)
}
