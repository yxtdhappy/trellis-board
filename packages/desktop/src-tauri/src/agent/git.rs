//! Git 调用层：固定参数、固定环境、操作白名单与错误映射。
//! 行为对照 agent/git-sync.js，只负责执行 git 子进程与解析结果，不含同步决策。

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use serde_json::json;

use crate::agent::process::{
    build_environment, is_timeout, run_process, ProcessOptions, ProcessOutput,
};
use crate::agent::protocol::{code, AgentError, AgentResult};

mod args;
mod diagnose;
mod query;
mod write;

pub use args::{git_args, GitOperation, GitParams};
pub use diagnose::{
    classify_commit_failure, classify_fetch_failure, classify_merge_failure, classify_push_failure,
    common_dir, detect_git_state, parse_status,
};
pub(crate) use diagnose::parse_diff_tree_paths;
pub use query::{
    assert_repository_branch, branch_list, check_ref, config_sparse, current_branch, diff_tree,
    ensure_hooks_dir, fetch, head_commit, is_tracked, ls_remote, ls_tree, merge_ff_only,
    remote_url, rev_list, show_toplevel, staged_paths, status, status_paths, worktree_list,
    GitWorktree,
};
pub use write::{
    add_paths, commit_index, commit_paths, has_staged_changes, push_branch, untrack_path,
};

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
        // core.sparseCheckout 未配置时 exit 1、diff --cached --quiet 有差异时 exit 1
        // 都是正常分支，由调用方转成结果，不记为命令失败。
        suppress_failure_log: matches!(
            operation,
            GitOperation::ConfigSparse | GitOperation::DiffCachedQuiet
        ),
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

#[cfg(test)]
mod tests;
