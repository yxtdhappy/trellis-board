//! Git 状态与失败分类、porcelain/diff-tree 解析。

use std::path::{Path, PathBuf};

use crate::agent::protocol::{code, AgentError, AgentResult};

use super::{tail_text, GitStatusEntry, GIT_STATE_MARKERS};


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
    if is_remote_unreachable(&lower) {
        return unreachable_remote_error();
    }
    AgentError::new(
        code::FETCH_FAILED,
        format!("Git fetch 失败：{}", tail_text(text, 500)),
    )
}

/// push 失败分类：非快进、网络/认证与其他错误分开提示。
pub fn classify_push_failure(text: &str) -> AgentError {
    let lower = text.to_lowercase();
    if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || lower.contains("[rejected]")
    {
        return AgentError::new(
            code::NO_FAST_FORWARD,
            "远端分支包含本地没有的新提交，请先拉取并处理后再推送",
        );
    }
    if is_remote_unreachable(&lower) {
        return unreachable_remote_error();
    }
    AgentError::new(
        code::GIT_FAILED,
        format!("Git push 失败：{}", tail_text(text, 500)),
    )
}

/// commit 身份缺失时给出可操作提示，其余保留 Git 输出。
pub fn classify_commit_failure(text: &str) -> AgentError {
    let lower = text.to_lowercase();
    if lower.contains("please tell me who you are")
        || lower.contains("unable to auto-detect email address")
        || lower.contains("empty ident name")
    {
        return AgentError::new(
            code::GIT_FAILED,
            "Git 提交失败：请先配置 git user.name 与 user.email",
        );
    }
    AgentError::new(
        code::GIT_FAILED,
        format!("Git 提交失败：{}", tail_text(text, 500)),
    )
}

fn is_remote_unreachable(lower: &str) -> bool {
    [
        "could not resolve",
        "connection refused",
        "unable to access",
        "permission denied",
        "authentication failed",
        "could not read from remote repository",
        "does not appear to be a git repository",
        "no such file or directory",
        "timed out",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn unreachable_remote_error() -> AgentError {
    AgentError::new(
        code::REMOTE_UNREACHABLE,
        "无法访问 Git 远端，请检查网络和凭据",
    )
    .retryable(true)
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

pub(crate) fn parse_diff_tree_paths(value: &str) -> AgentResult<Vec<String>> {
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

