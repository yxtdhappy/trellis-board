//! Git 写操作：只服务接入初始化的一次性提交与推送，参数由调用方固定。
//! 与读操作共用 git_args 白名单、固定环境、空 hooks 与超时。

use std::path::Path;

use super::{
    classify_commit_failure, classify_push_failure, ensure_hooks_dir, git_failure, run_git,
    GitOperation, GitParams, LOCAL_TIMEOUT, NETWORK_TIMEOUT,
};
use crate::agent::protocol::{code, AgentError, AgentResult};

/// 只暂存调用方给定的路径；paths 为空时 git_args 直接拒绝。
pub async fn add_paths(repo_path: &Path, hooks_dir: &Path, paths: &[String]) -> AgentResult<()> {
    let output = run_write(
        GitOperation::AddPaths,
        repo_path,
        hooks_dir,
        &GitParams {
            paths,
            ..Default::default()
        },
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(git_failure("无法暂存 Trellis 初始化文件", &output))
}

/// `git rm --cached --quiet -- <path>`：只从索引移除，工作区文件保留。
pub async fn untrack_path(repo_path: &Path, hooks_dir: &Path, path: &str) -> AgentResult<()> {
    let paths = [path.to_string()];
    let output = run_write(
        GitOperation::RmCached,
        repo_path,
        hooks_dir,
        &GitParams {
            paths: paths.as_slice(),
            ..Default::default()
        },
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    let detail = format!("{}\n{}", output.stderr, output.stdout);
    if detail.contains("has staged content different") || detail.contains("is not tracked") {
        return Err(AgentError::new(
            code::GIT_FAILED,
            format!("无法把 {path} 从 Git 索引移除：该文件存在未提交的暂存改动，请先处理后再重试"),
        ));
    }
    Err(git_failure("无法把模板基线文件从 Git 索引移除", &output))
}

/// `git diff --cached --quiet -- <paths>`：0 表示无暂存差异，1 表示存在差异。
pub async fn has_staged_changes(
    repo_path: &Path,
    hooks_dir: &Path,
    paths: &[String],
) -> AgentResult<bool> {
    let output = run_write(
        GitOperation::DiffCachedQuiet,
        repo_path,
        hooks_dir,
        &GitParams {
            paths,
            ..Default::default()
        },
    )
    .await?;
    match output.exit_code {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(git_failure("无法检查暂存区差异", &output)),
    }
}

/// `git commit -m <message>`：提交当前索引；调用方需保证索引里只有本次要提交的路径。
pub async fn commit_index(repo_path: &Path, hooks_dir: &Path, message: &str) -> AgentResult<()> {
    let output = run_write(
        GitOperation::CommitIndex,
        repo_path,
        hooks_dir,
        &GitParams {
            message: Some(message),
            ..Default::default()
        },
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(classify_commit_failure(&format!(
        "{}\n{}",
        output.stderr, output.stdout
    )))
}

/// `git commit -m <message> -- <paths>`：pathspec 形式只提交固定路径，不卷入其他已暂存改动。
pub async fn commit_paths(
    repo_path: &Path,
    hooks_dir: &Path,
    message: &str,
    paths: &[String],
) -> AgentResult<()> {
    let output = run_write(
        GitOperation::CommitPaths,
        repo_path,
        hooks_dir,
        &GitParams {
            message: Some(message),
            paths,
            ..Default::default()
        },
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(classify_commit_failure(&format!(
        "{}\n{}",
        output.stderr, output.stdout
    )))
}

/// `git push origin refs/heads/<branch>:refs/heads/<branch>`，使用全限定 refspec。
pub async fn push_branch(repo_path: &Path, hooks_dir: &Path, branch: &str) -> AgentResult<()> {
    let output = run_write(
        GitOperation::PushBranch,
        repo_path,
        hooks_dir,
        &GitParams {
            branch: Some(branch),
            ..Default::default()
        },
    )
    .await?;
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(classify_push_failure(&format!(
        "{}\n{}",
        output.stderr, output.stdout
    )))
}

async fn run_write(
    operation: GitOperation,
    repo_path: &Path,
    hooks_dir: &Path,
    params: &GitParams<'_>,
) -> AgentResult<crate::agent::process::ProcessOutput> {
    ensure_hooks_dir(hooks_dir).await?;
    let timeout = if operation == GitOperation::PushBranch {
        NETWORK_TIMEOUT
    } else {
        LOCAL_TIMEOUT
    };
    run_git(operation, repo_path, hooks_dir, params, timeout).await
}
