//! Git 调用层：固定参数、固定环境、操作白名单与错误映射。
//! 行为对照 agent/git-sync.js，只负责执行 git 子进程与解析结果，不含同步决策。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::agent::process::{
    build_environment, is_timeout, run_process, ProcessOptions, ProcessOutput,
};
use crate::agent::protocol::{code, AgentError, AgentResult};

/// 与 JS 一致：按 PATH 解析 git（Rust 的 Command 会用父进程 PATH 查找裸命令名）。
pub const GIT_BINARY: &str = "git";
/// 固定 SSH 行为：禁止交互、严格校验主机密钥。
pub const FIXED_SSH_COMMAND: &str = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes";
/// 未完成操作的状态标记（对照 JS 的 GIT_STATE_MARKERS）。
pub const GIT_STATE_MARKERS: [&str; 5] = [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
];

const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_OUTPUT_BYTES: usize = 1_048_576;
const ERROR_TAIL_CHARS: usize = 1024;

/// 允许执行的操作；`DiffTree` 是桌面端受限增量扫描扩展，其余条目与 JS 操作白名单一致。
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitOperation {
    CheckRef,
    ConfigSparse,
    ShowToplevel,
    CurrentBranch,
    Head,
    GitPath,
    Status,
    StatusPaths,
    RemoteUrl,
    LsRemote,
    LsTree,
    DiffTree,
    Fetch,
    RevList,
    Merge,
    WorktreeList,
}

#[allow(dead_code)]
impl GitOperation {
    pub const ALL: [GitOperation; 16] = [
        GitOperation::CheckRef,
        GitOperation::ConfigSparse,
        GitOperation::ShowToplevel,
        GitOperation::CurrentBranch,
        GitOperation::Head,
        GitOperation::GitPath,
        GitOperation::Status,
        GitOperation::StatusPaths,
        GitOperation::RemoteUrl,
        GitOperation::LsRemote,
        GitOperation::LsTree,
        GitOperation::DiffTree,
        GitOperation::Fetch,
        GitOperation::RevList,
        GitOperation::Merge,
        GitOperation::WorktreeList,
    ];

    /// JS 侧的操作名（日志与白名单契约共用）。
    pub fn as_str(self) -> &'static str {
        match self {
            GitOperation::CheckRef => "check-ref",
            GitOperation::ConfigSparse => "config-sparse",
            GitOperation::ShowToplevel => "show-toplevel",
            GitOperation::CurrentBranch => "current-branch",
            GitOperation::Head => "head",
            GitOperation::GitPath => "git-path",
            GitOperation::Status => "status",
            GitOperation::StatusPaths => "status-paths",
            GitOperation::RemoteUrl => "remote-url",
            GitOperation::LsRemote => "ls-remote",
            GitOperation::LsTree => "ls-tree",
            GitOperation::DiffTree => "diff-tree",
            GitOperation::Fetch => "fetch",
            GitOperation::RevList => "rev-list",
            GitOperation::Merge => "merge",
            GitOperation::WorktreeList => "worktree-list",
        }
    }
}

/// 单条 porcelain v1 状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitStatusEntry {
    /// 两字符状态：X=索引、Y=工作区（如 ` M`、`??`、`R `）。
    pub status: String,
    /// 工作区相对路径；rename/copy 行取新路径。
    pub path: String,
    /// rename/copy 行的旧路径；普通状态为空。
    pub original_path: Option<String>,
}

impl GitStatusEntry {
    /// 供 dirtySummary 之类的纯文本展示使用。
    pub fn line(&self) -> String {
        format!("{} {}", self.status, self.path)
    }
}

/// 单次 git 调用的可变参数（分支/标记/版本/路径）。
#[derive(Debug, Clone, Default)]
pub struct GitParams<'a> {
    pub branch: Option<&'a str>,
    pub marker: Option<&'a str>,
    pub revision: Option<&'a str>,
    pub paths: &'a [String],
}

/// 构造 `-C <repo> -c ...` 固定前缀 + 操作参数，顺序与 JS 完全一致。
pub fn git_args(
    operation: GitOperation,
    repo_path: &Path,
    hooks_dir: &Path,
    params: &GitParams<'_>,
) -> AgentResult<Vec<String>> {
    if repo_path.as_os_str().is_empty() {
        return Err(AgentError::new(code::GIT_FAILED, "本地仓库路径无效"));
    }
    let hooks = absolute_path(hooks_dir);
    let mut args: Vec<String> = vec![
        "-C".to_string(),
        repo_path.to_string_lossy().into_owned(),
        "-c".to_string(),
        format!("core.hooksPath={}", hooks.to_string_lossy()),
        "-c".to_string(),
        "core.autocrlf=false".to_string(),
        "-c".to_string(),
        "http.sslVerify=true".to_string(),
        "-c".to_string(),
        format!("core.sshCommand={FIXED_SSH_COMMAND}"),
    ];
    // 分支/工作区相关的操作关闭 fsmonitor，避免残留守护进程干扰判定。
    if matches!(
        operation,
        GitOperation::ConfigSparse
            | GitOperation::ShowToplevel
            | GitOperation::CurrentBranch
            | GitOperation::Head
            | GitOperation::GitPath
            | GitOperation::Status
            | GitOperation::StatusPaths
            | GitOperation::DiffTree
            | GitOperation::RevList
            | GitOperation::Merge
    ) {
        args.push("-c".to_string());
        args.push("core.fsmonitor=false".to_string());
    }
    match operation {
        GitOperation::CheckRef => {
            let branch = params
                .branch
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "同步分支参数缺失"))?;
            args.extend([
                "check-ref-format".to_string(),
                format!("refs/heads/{branch}"),
            ]);
        }
        GitOperation::ConfigSparse => {
            args.extend([
                "config".to_string(),
                "--bool".to_string(),
                "core.sparseCheckout".to_string(),
            ]);
        }
        GitOperation::ShowToplevel => {
            args.extend(["rev-parse".to_string(), "--show-toplevel".to_string()]);
        }
        GitOperation::CurrentBranch => {
            args.extend(["branch".to_string(), "--show-current".to_string()]);
        }
        GitOperation::Head => {
            args.extend([
                "rev-parse".to_string(),
                "--verify".to_string(),
                "HEAD^{commit}".to_string(),
            ]);
        }
        GitOperation::GitPath => {
            let marker = params
                .marker
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "Git 状态标记无效"))?;
            if !GIT_STATE_MARKERS.contains(&marker) {
                return Err(AgentError::new(code::GIT_FAILED, "Git 状态标记无效"));
            }
            args.extend([
                "rev-parse".to_string(),
                "--git-path".to_string(),
                marker.to_string(),
            ]);
        }
        GitOperation::Status => {
            args.extend([
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--untracked-files=normal".to_string(),
            ]);
        }
        GitOperation::StatusPaths => {
            args.extend([
                "--no-optional-locks".to_string(),
                "status".to_string(),
                "--porcelain=v1".to_string(),
                "--untracked-files=all".to_string(),
                "--".to_string(),
            ]);
            args.extend(params.paths.iter().cloned());
        }
        GitOperation::RemoteUrl => {
            args.extend([
                "remote".to_string(),
                "get-url".to_string(),
                "origin".to_string(),
            ]);
        }
        GitOperation::LsRemote => {
            let branch = params
                .branch
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "同步分支参数缺失"))?;
            args.extend([
                "ls-remote".to_string(),
                "--exit-code".to_string(),
                "origin".to_string(),
                format!("refs/heads/{branch}"),
            ]);
        }
        GitOperation::LsTree => {
            args.extend([
                "ls-tree".to_string(),
                "-r".to_string(),
                "--name-only".to_string(),
                params.revision.unwrap_or("HEAD").to_string(),
                "--".to_string(),
                ".trellis".to_string(),
            ]);
        }
        GitOperation::DiffTree => {
            let previous = params
                .marker
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "Git 差量基线缺失"))?;
            let revision = params
                .revision
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "Git 差量目标缺失"))?;
            args.extend([
                "diff-tree".to_string(),
                "--no-commit-id".to_string(),
                "--name-status".to_string(),
                "--no-renames".to_string(),
                "-r".to_string(),
                "-z".to_string(),
                previous.to_string(),
                revision.to_string(),
                "--".to_string(),
                ".trellis/tasks".to_string(),
                ":(exclude).trellis/tasks/archive".to_string(),
            ]);
        }
        GitOperation::Fetch => {
            let branch = params
                .branch
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "同步分支参数缺失"))?;
            args.extend([
                "fetch".to_string(),
                "--no-tags".to_string(),
                "origin".to_string(),
                branch.to_string(),
            ]);
        }
        GitOperation::RevList => {
            args.extend([
                "rev-list".to_string(),
                "--left-right".to_string(),
                "--count".to_string(),
                "HEAD...FETCH_HEAD".to_string(),
            ]);
        }
        GitOperation::WorktreeList => {
            args.extend([
                "worktree".to_string(),
                "list".to_string(),
                "--porcelain".to_string(),
            ]);
        }
        GitOperation::Merge => {
            args.extend([
                "merge".to_string(),
                "--ff-only".to_string(),
                "--no-overwrite-ignore".to_string(),
                "FETCH_HEAD".to_string(),
            ]);
        }
    }
    Ok(args)
}

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

/// 未完成的 Git 操作标记（不依赖 git，直接看 git 目录里的标记文件）。
pub fn detect_git_state(repo_path: &Path) -> Option<&'static str> {
    let git_dir = resolve_git_dir(repo_path)?;
    GIT_STATE_MARKERS
        .iter()
        .copied()
        .find(|marker| git_dir.join(*marker).exists())
}

/// 普通 checkout 返回 `.git`，linked worktree 返回共享的 common dir。
pub fn common_dir(repo_path: &Path) -> Option<PathBuf> {
    let git_dir = resolve_git_dir(repo_path)?;
    let common = std::fs::read_to_string(git_dir.join("commondir"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                git_dir.join(path)
            }
        })
        .unwrap_or_else(|| git_dir.clone());
    std::fs::canonicalize(&common).ok().or(Some(common))
}

/// 解析 porcelain v1 输出；rename/copy 行取箭头后的新路径。
pub fn parse_status(output: &str) -> Vec<GitStatusEntry> {
    output.lines().filter_map(parse_status_line).collect()
}

/// fetch 失败分类，消息与 JS classifyFetchFailure 一致。
pub fn classify_fetch_failure(text: &str) -> AgentError {
    let lower = text.to_lowercase();
    if lower.contains("couldn't find remote ref") || lower.contains("remote ref does not exist") {
        return AgentError::new(code::FETCH_FAILED, "远端同步分支不存在");
    }
    let unreachable = [
        "could not resolve",
        "connection refused",
        "unable to access",
        "permission denied",
        "authentication failed",
        "could not read from remote repository",
        "does not appear to be a git repository",
        "no such file or directory",
        "timed out",
    ];
    if unreachable.iter().any(|needle| lower.contains(needle)) {
        return AgentError::new(
            code::REMOTE_UNREACHABLE,
            "无法访问 Git 远端，请检查网络和凭据",
        )
        .retryable(true);
    }
    AgentError::new(
        code::FETCH_FAILED,
        format!("Git fetch 失败：{}", tail_text(text, 500)),
    )
}

/// fast-forward 合并失败分类，消息与 JS classifyMergeFailure 一致。
pub fn classify_merge_failure(text: &str) -> AgentError {
    let lower = text.to_lowercase();
    if lower.contains("untracked working tree files would be overwritten")
        || lower.contains("would be overwritten by merge")
    {
        return AgentError::new(
            code::IGNORED_FILE_CONFLICT,
            "远端文件会覆盖本地 ignored 或未跟踪文件，已拒绝同步",
        );
    }
    if lower.contains("not possible to fast-forward")
        || lower.contains("diverging branches")
        || lower.contains("non-fast-forward")
    {
        return AgentError::new(code::NO_FAST_FORWARD, "本地分支无法安全 fast-forward");
    }
    if lower.contains("local changes")
        || lower.contains("would be overwritten")
        || lower.contains("merge with strategy")
    {
        return AgentError::new(code::LOCAL_DIRTY, "本地工作区不干净，已拒绝合并");
    }
    AgentError::new(
        code::MERGE_FAILED,
        format!("Git fast-forward 合并失败：{}", tail_text(text, 500)),
    )
}

async fn run_git(
    operation: GitOperation,
    repo_path: &Path,
    hooks_dir: &Path,
    params: &GitParams<'_>,
    timeout: Duration,
) -> AgentResult<ProcessOutput> {
    let args = git_args(operation, repo_path, hooks_dir, params)?;
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        env: Some(git_environment()),
        stdin: None,
        timeout: Some(timeout),
        max_output_bytes: MAX_OUTPUT_BYTES,
    };
    run_process(Path::new(GIT_BINARY), &arg_refs, &options)
        .await
        .map_err(map_process_error)
}

fn git_environment() -> BTreeMap<String, String> {
    let mut extra = BTreeMap::new();
    extra.insert("GIT_TERMINAL_PROMPT".to_string(), "0".to_string());
    extra.insert("GCM_INTERACTIVE".to_string(), "Never".to_string());
    extra.insert("GIT_ASKPASS".to_string(), String::new());
    extra.insert("GIT_SSH_COMMAND".to_string(), FIXED_SSH_COMMAND.to_string());
    extra.insert("GIT_OPTIONAL_LOCKS".to_string(), "0".to_string());
    build_environment(Some(&extra))
}

/// 子进程层错误收敛为 Git 错误：超时 → GIT_TIMEOUT，其余 → GIT_FAILED。
fn map_process_error(error: AgentError) -> AgentError {
    if is_timeout(&error) || error.code == code::GIT_TIMEOUT {
        return AgentError::new(code::GIT_TIMEOUT, "Git 命令执行超时")
            .retryable(true)
            .with_details(Some(json!({ "timedOut": true })));
    }
    AgentError::new(
        code::GIT_FAILED,
        format!("无法执行本地 Git 命令：{}", error.message),
    )
    .with_details(Some(json!({ "processErrorCode": error.code })))
}

fn require_success(output: &ProcessOutput, message: &str) -> AgentResult<String> {
    if output.exit_code == 0 {
        return Ok(output.stdout.trim().to_string());
    }
    Err(git_failure(message, output))
}

fn git_failure(message: &str, output: &ProcessOutput) -> AgentError {
    failure_with_code(code::GIT_FAILED, message, output)
}

fn failure_with_code(error_code: &str, message: &str, output: &ProcessOutput) -> AgentError {
    AgentError::new(error_code, format!("{message}：{}", output_tail(output)))
        .with_details(Some(json!({ "exitCode": output.exit_code })))
}

fn output_tail(output: &ProcessOutput) -> String {
    let source = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    tail_text(source, ERROR_TAIL_CHARS)
}

/// 文本末尾 `limit` 个字符，空文本回落到退出码提示。
fn tail_text(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let start = chars.len().saturating_sub(limit);
    let tail: String = chars[start..].iter().collect();
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        "无输出".to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_status_line(line: &str) -> Option<GitStatusEntry> {
    let mut chars = line.char_indices();
    let (_, first) = chars.next()?;
    let (_, second) = chars.next()?;
    let (separator_index, separator) = chars.next()?;
    if separator != ' ' {
        return None;
    }
    let rest = line.get(separator_index + 1..)?;
    let (original_path, path) = if first == 'R' || first == 'C' || second == 'R' || second == 'C' {
        match rest.rsplit_once(" -> ") {
            Some((old, new)) if !old.is_empty() && !new.is_empty() => (Some(old.to_string()), new),
            _ => (None, rest),
        }
    } else {
        (None, rest)
    };
    if path.is_empty() {
        return None;
    }
    Some(GitStatusEntry {
        status: format!("{first}{second}"),
        path: path.to_string(),
        original_path,
    })
}

fn parse_diff_tree_paths(value: &str) -> AgentResult<Vec<String>> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let tokens: Vec<&str> = value.split('\0').collect();
    let mut tokens = tokens.into_iter().filter(|token| !token.is_empty());
    let mut paths = Vec::new();
    while let Some(status) = tokens.next() {
        let path = tokens
            .next()
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "Git 差量输出缺少路径"))?;
        if status.is_empty()
            || status.len() > 2
            || !status.bytes().all(|byte| {
                matches!(
                    byte,
                    b'A' | b'C' | b'D' | b'M' | b'R' | b'T' | b'U' | b'X' | b'B'
                )
            })
        {
            return Err(AgentError::new(
                code::INVALID_RESPONSE,
                "Git 差量输出包含未知状态",
            ));
        }
        if path.contains('\n') || path.contains('\r') || path.contains('\u{fffd}') {
            return Err(AgentError::new(
                code::INVALID_RESPONSE,
                "Git 差量输出包含无效路径",
            ));
        }
        paths.push(path.to_string());
    }
    Ok(paths)
}

fn resolve_git_dir(repo_path: &Path) -> Option<PathBuf> {
    let dot_git = repo_path.join(".git");
    let metadata = std::fs::symlink_metadata(&dot_git).ok()?;
    if metadata.is_dir() {
        return Some(dot_git);
    }
    let contents = std::fs::read_to_string(&dot_git).ok()?;
    let target = contents.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let path = PathBuf::from(target);
    Some(if path.is_absolute() {
        path
    } else {
        repo_path.join(path)
    })
}

/// 对齐 JS 的 path.resolve：相对 hooks 目录按当前工作目录补全。
fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(path))
        .unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests;
