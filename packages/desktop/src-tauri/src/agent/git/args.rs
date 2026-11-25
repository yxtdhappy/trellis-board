//! Git 操作白名单与参数构造。

use std::path::{Path, PathBuf};

use crate::agent::protocol::{code, AgentError, AgentResult};

use super::{FIXED_SSH_COMMAND, GIT_STATE_MARKERS};

/// 允许执行的操作；`DiffTree` 与末尾四个写操作是桌面端扩展，其余条目与 JS 操作白名单一致。
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
    LsFiles,
    DiffTree,
    DiffCachedNames,
    Fetch,
    RevList,
    Merge,
    WorktreeList,
    BranchList,
    AddPaths,
    RmCached,
    DiffCachedQuiet,
    CommitIndex,
    CommitPaths,
    PushBranch,
}

#[allow(dead_code)]
impl GitOperation {
    pub const ALL: [GitOperation; 25] = [
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
        GitOperation::LsFiles,
        GitOperation::DiffTree,
        GitOperation::DiffCachedNames,
        GitOperation::Fetch,
        GitOperation::RevList,
        GitOperation::Merge,
        GitOperation::WorktreeList,
        GitOperation::BranchList,
        GitOperation::AddPaths,
        GitOperation::RmCached,
        GitOperation::DiffCachedQuiet,
        GitOperation::CommitIndex,
        GitOperation::CommitPaths,
        GitOperation::PushBranch,
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
            GitOperation::LsFiles => "ls-files",
            GitOperation::DiffTree => "diff-tree",
            GitOperation::DiffCachedNames => "diff-cached-names",
            GitOperation::Fetch => "fetch",
            GitOperation::RevList => "rev-list",
            GitOperation::Merge => "merge",
            GitOperation::WorktreeList => "worktree-list",
            GitOperation::BranchList => "branch-list",
            GitOperation::AddPaths => "add-paths",
            GitOperation::RmCached => "rm-cached",
            GitOperation::DiffCachedQuiet => "diff-cached-quiet",
            GitOperation::CommitIndex => "commit-index",
            GitOperation::CommitPaths => "commit-paths",
            GitOperation::PushBranch => "push-branch",
        }
    }
}


/// 单次 git 调用的可变参数（分支/标记/版本/路径）。
#[derive(Debug, Clone, Default)]
pub struct GitParams<'a> {
    pub branch: Option<&'a str>,
    pub marker: Option<&'a str>,
    pub revision: Option<&'a str>,
    pub message: Option<&'a str>,
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
            | GitOperation::LsFiles
            | GitOperation::DiffTree
            | GitOperation::RevList
            | GitOperation::Merge
            | GitOperation::DiffCachedQuiet
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
        GitOperation::LsFiles => {
            require_paths(params)?;
            args.extend([
                "ls-files".to_string(),
                "--error-unmatch".to_string(),
                "--".to_string(),
            ]);
            args.extend(params.paths.iter().cloned());
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
        GitOperation::DiffCachedNames => {
            args.extend([
                "diff".to_string(),
                "--cached".to_string(),
                "--name-only".to_string(),
                "-z".to_string(),
                "--".to_string(),
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
        GitOperation::BranchList => {
            args.extend([
                "for-each-ref".to_string(),
                "--format=%(refname:short)".to_string(),
                "refs/heads".to_string(),
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
        GitOperation::AddPaths => {
            require_paths(params)?;
            args.extend(["add".to_string(), "-A".to_string(), "--".to_string()]);
            args.extend(params.paths.iter().cloned());
        }
        GitOperation::RmCached => {
            require_paths(params)?;
            args.extend([
                "rm".to_string(),
                "--cached".to_string(),
                "--quiet".to_string(),
                "--".to_string(),
            ]);
            args.extend(params.paths.iter().cloned());
        }
        GitOperation::DiffCachedQuiet => {
            require_paths(params)?;
            args.extend([
                "diff".to_string(),
                "--cached".to_string(),
                "--quiet".to_string(),
                "--".to_string(),
            ]);
            args.extend(params.paths.iter().cloned());
        }
        GitOperation::CommitIndex => {
            let message = params
                .message
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "提交信息缺失"))?;
            args.extend(["commit".to_string(), "-m".to_string(), message.to_string()]);
        }
        GitOperation::CommitPaths => {
            require_paths(params)?;
            let message = params
                .message
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "提交信息缺失"))?;
            args.extend([
                "commit".to_string(),
                "-m".to_string(),
                message.to_string(),
                "--".to_string(),
            ]);
            args.extend(params.paths.iter().cloned());
        }
        GitOperation::PushBranch => {
            let branch = params
                .branch
                .ok_or_else(|| AgentError::new(code::GIT_FAILED, "同步分支参数缺失"))?;
            let branch = crate::agent::protocol::validate_branch_name_syntax(branch)?;
            args.extend([
                "push".to_string(),
                "origin".to_string(),
                format!("refs/heads/{branch}:refs/heads/{branch}"),
            ]);
        }
    }
    Ok(args)
}

/// 写操作必须带显式 pathspec，避免空参数被 Git 解释成“全部路径”。
fn require_paths(params: &GitParams<'_>) -> AgentResult<()> {
    if params.paths.is_empty() {
        return Err(AgentError::new(code::GIT_FAILED, "Git 路径参数缺失"));
    }
    Ok(())
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
