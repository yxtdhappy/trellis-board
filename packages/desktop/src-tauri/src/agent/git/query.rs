//! Git 读取操作：只读查询、hooks 校验与 worktree/远端信息。

use std::path::{Path, PathBuf};

use crate::agent::protocol::{code, AgentError, AgentResult};

use super::{
    classify_fetch_failure, classify_merge_failure, failure_with_code, git_failure, parse_status,
    parse_diff_tree_paths, require_success, run_git, GitOperation, GitParams, GitStatusEntry,
    LOCAL_TIMEOUT, NETWORK_TIMEOUT,
};

/// hooks 目录必须是真实空目录，避免仓库自带 hook 干扰（对照 JS ensureHooksDirectory）。
pub async fn ensure_hooks_dir(hooks_dir: &Path) -> AgentResult<()> {
    let metadata = match tokio::fs::symlink_metadata(hooks_dir).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return tokio::fs::create_dir_all(hooks_dir).await.map_err(|error| {
                AgentError::new(
                    code::GIT_FAILED,
                    format!("无法创建 Agent hooks 目录：{error}"),
                )
            });
        }
        Err(error) => {
            return Err(AgentError::new(
                code::GIT_FAILED,
                format!("无法检查 Agent hooks 目录：{error}"),
            ));
        }
    };
    // symlink_metadata 下符号链接的 is_dir() 为 false，因此同时排除了链接。
    if !metadata.is_dir() {
        return Err(AgentError::new(
            code::GIT_FAILED,
            "Agent hooks 目录必须是真实空目录",
        ));
    }
    let mut entries = tokio::fs::read_dir(hooks_dir).await.map_err(|error| {
        AgentError::new(
            code::GIT_FAILED,
            format!("无法检查 Agent hooks 目录：{error}"),
        )
    })?;
    let populated = entries
        .next_entry()
        .await
        .map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法读取 Agent hooks 目录：{error}"),
            )
        })?
        .is_some();
    if populated {
        return Err(AgentError::new(
            code::GIT_FAILED,
            "Agent hooks 目录必须为空",
        ));
    }
    Ok(())
}

pub async fn show_toplevel(repo_path: &Path, hooks_dir: &Path) -> AgentResult<PathBuf> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::ShowToplevel,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(failure_with_code(
            code::NOT_GIT_REPOSITORY,
            "目录不是 Git 仓库根",
            &output,
        ));
    }
    let value = output.stdout.trim().to_string();
    if value.is_empty() {
        return Err(AgentError::new(
            code::NOT_GIT_REPOSITORY,
            "目录不是 Git 仓库根",
        ));
    }
    Ok(PathBuf::from(value))
}

/// 当前分支名；空输出视为 detached HEAD（对照 JS readRepositoryState 的判定）。
pub async fn current_branch(repo_path: &Path, hooks_dir: &Path) -> AgentResult<String> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::CurrentBranch,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取本地分支")?;
    if value.is_empty() {
        return Err(AgentError::new(
            code::DETACHED_HEAD,
            "本地仓库处于 detached HEAD",
        ));
    }
    Ok(value)
}

/// 校验仓库当前分支与绑定分支一致；返回实际分支名。
pub async fn assert_repository_branch(
    repo_path: &Path,
    hooks_dir: &Path,
    branch_name: &str,
) -> AgentResult<String> {
    let expected = crate::agent::protocol::validate_branch_name_syntax(branch_name)?;
    let root = show_toplevel(repo_path, hooks_dir).await?;
    let current = current_branch(&root, hooks_dir).await?;
    if current != expected {
        return Err(AgentError::new(
            code::BRANCH_MISMATCH,
            format!("本地当前分支为 {current}，绑定分支为 {expected}"),
        ));
    }
    Ok(current)
}

/// HEAD 提交；`allow_unborn` 为 true 时未提交的空仓库返回 None。
pub async fn head_commit(
    repo_path: &Path,
    hooks_dir: &Path,
    allow_unborn: bool,
) -> AgentResult<Option<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::Head,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        if allow_unborn {
            return Ok(None);
        }
        return Err(git_failure("无法读取本地 HEAD", &output));
    }
    let value = output.stdout.trim().to_string();
    Ok(if value.is_empty() { None } else { Some(value) })
}

pub async fn status(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Vec<GitStatusEntry>> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::Status,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure("无法检查本地工作区状态", &output));
    }
    Ok(parse_status(&output.stdout))
}

pub async fn status_paths(
    repo_path: &Path,
    hooks_dir: &Path,
    paths: &[String],
) -> AgentResult<Vec<GitStatusEntry>> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams {
        paths,
        ..Default::default()
    };
    let output = run_git(
        GitOperation::StatusPaths,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure("无法检查本地文件状态", &output));
    }
    Ok(parse_status(&output.stdout))
}

/// origin 的 URL；缺少 origin 时按 JS 返回 REMOTE_MISSING。
pub async fn remote_url(repo_path: &Path, hooks_dir: &Path) -> AgentResult<String> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::RemoteUrl,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(AgentError::new(
            code::REMOTE_MISSING,
            "本地仓库缺少 origin remote",
        ));
    }
    let value = output.stdout.trim().to_string();
    if value.is_empty() {
        return Err(AgentError::new(
            code::REMOTE_MISSING,
            "本地仓库缺少 origin remote",
        ));
    }
    Ok(value)
}

/// 远端分支引用；`--exit-code` 的 2 表示远端没有该分支，返回 None。
pub async fn ls_remote(
    repo_path: &Path,
    hooks_dir: &Path,
    branch: &str,
) -> AgentResult<Option<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams {
        branch: Some(branch),
        ..Default::default()
    };
    let output = run_git(
        GitOperation::LsRemote,
        repo_path,
        hooks_dir,
        &params,
        NETWORK_TIMEOUT,
    )
    .await?;
    match output.exit_code {
        0 => Ok(Some(output.stdout.trim().to_string())),
        2 => Ok(None),
        _ => {
            let error = git_failure("无法读取远端分支", &output);
            Err(error.retryable(true))
        }
    }
}

/// `git worktree list --porcelain` 的一条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWorktree {
    pub path: PathBuf,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub prunable: bool,
}

pub async fn worktree_list(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Vec<GitWorktree>> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::WorktreeList,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取 Git worktree 列表")?;
    let mut worktrees = Vec::new();
    let mut current: Option<GitWorktree> = None;
    for line in value.lines() {
        if line.is_empty() {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(worktree) = current.take() {
                worktrees.push(worktree);
            }
            current = Some(GitWorktree {
                path: PathBuf::from(path),
                head: None,
                branch: None,
                bare: false,
                prunable: false,
            });
        } else if let Some(worktree) = current.as_mut() {
            if let Some(head) = line.strip_prefix("HEAD ") {
                worktree.head = Some(head.to_string());
            } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
                worktree.branch = Some(branch.to_string());
            } else if line == "bare" {
                worktree.bare = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                worktree.prunable = true;
            }
        }
    }
    if let Some(worktree) = current {
        worktrees.push(worktree);
    }
    Ok(worktrees)
}

/// 本地分支名列表；不含远端跟踪分支。
pub async fn branch_list(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Vec<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::BranchList,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取本地分支列表")?;
    Ok(value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

pub async fn ls_tree(
    repo_path: &Path,
    hooks_dir: &Path,
    revision: Option<&str>,
) -> AgentResult<Vec<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams {
        revision,
        ..Default::default()
    };
    let output = run_git(
        GitOperation::LsTree,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取 HEAD 中的 Trellis 文件")?;
    Ok(value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}

/// `git ls-files --error-unmatch -- <path>`：exit 0 表示已跟踪，1 表示未跟踪（含被忽略或不存在）。
pub async fn is_tracked(repo_path: &Path, hooks_dir: &Path, path: &str) -> AgentResult<bool> {
    ensure_hooks_dir(hooks_dir).await?;
    let paths = [path.to_string()];
    let params = GitParams {
        paths: paths.as_slice(),
        ..Default::default()
    };
    let output = run_git(
        GitOperation::LsFiles,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    match output.exit_code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(git_failure("无法检查文件是否被 Git 跟踪", &output)),
    }
}

/// `git diff --cached --name-only -z`：当前索引相对 HEAD 的全部暂存路径。
pub async fn staged_paths(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Vec<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams::default();
    let output = run_git(
        GitOperation::DiffCachedNames,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code != 0 {
        return Err(git_failure("无法读取暂存区文件列表", &output));
    }
    Ok(output
        .stdout
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect())
}

/// 比较两个提交在 `.trellis/tasks` 下的变化路径。
///
/// 使用 `--no-renames -z`，让移动文件稳定表现为“旧路径删除 + 新路径新增”，
/// 同时避免文件名中的空格、中文或特殊字符影响解析。
pub async fn diff_tree(
    repo_path: &Path,
    hooks_dir: &Path,
    previous: &str,
    revision: &str,
) -> AgentResult<Vec<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    if !is_full_git_oid(previous) || !is_full_git_oid(revision) {
        return Err(AgentError::new(code::GIT_FAILED, "Git 差量提交无效"));
    }
    let params = GitParams {
        marker: Some(previous),
        revision: Some(revision),
        ..Default::default()
    };
    let output = run_git(
        GitOperation::DiffTree,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取任务目录提交差量")?;
    parse_diff_tree_paths(&value)
}

fn is_full_git_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub async fn fetch(repo_path: &Path, hooks_dir: &Path, branch: &str) -> AgentResult<()> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams {
        branch: Some(branch),
        ..Default::default()
    };
    let output = run_git(
        GitOperation::Fetch,
        repo_path,
        hooks_dir,
        &params,
        NETWORK_TIMEOUT,
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(classify_fetch_failure(&format!(
        "{}\n{}",
        output.stderr, output.stdout
    )))
}

/// `rev-list --left-right --count HEAD...FETCH_HEAD` → (本地领先, 远端领先)。
pub async fn rev_list(repo_path: &Path, hooks_dir: &Path) -> AgentResult<(u32, u32)> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::RevList,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法比较本地与远端提交")?;
    let mut parts = value.split_whitespace();
    let local_ahead = parts.next().and_then(|item| item.parse::<u32>().ok());
    let remote_ahead = parts.next().and_then(|item| item.parse::<u32>().ok());
    match (local_ahead, remote_ahead, parts.next()) {
        (Some(local), Some(remote), None) => Ok((local, remote)),
        _ => Err(AgentError::new(
            code::INVALID_RESPONSE,
            "Git 提交计数输出无效",
        )),
    }
}

pub async fn merge_ff_only(repo_path: &Path, hooks_dir: &Path) -> AgentResult<()> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::Merge,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        NETWORK_TIMEOUT,
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(classify_merge_failure(&format!(
        "{}\n{}",
        output.stderr, output.stdout
    )))
}

pub async fn check_ref(repo_path: &Path, hooks_dir: &Path, branch: &str) -> AgentResult<()> {
    ensure_hooks_dir(hooks_dir).await?;
    let params = GitParams {
        branch: Some(branch),
        ..Default::default()
    };
    let output = run_git(
        GitOperation::CheckRef,
        repo_path,
        hooks_dir,
        &params,
        LOCAL_TIMEOUT,
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(AgentError::new(
        code::BRANCH_INVALID,
        "同步分支不符合 Git 引用规则",
    ))
}

/// `config --bool core.sparseCheckout`；退出码 1 表示未配置（视为 false）。
pub async fn config_sparse(repo_path: &Path, hooks_dir: &Path) -> AgentResult<bool> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::ConfigSparse,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    match output.exit_code {
        0 => Ok(output.stdout.trim().eq_ignore_ascii_case("true")),
        1 => Ok(false),
        _ => Err(git_failure("无法读取本地 sparse checkout 配置", &output)),
    }
}
