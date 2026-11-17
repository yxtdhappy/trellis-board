use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Mutex, Notify, OnceCell};

use crate::agent::http::{ApiClient, MAX_SNAPSHOT_RESPONSE_BYTES};
use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::state_events::StateSink;
use crate::agent::store::{AgentBinding, ConfigStore};
use crate::agent::task_control::{
    handoff_state_key, parse_state_file, selected_server_task_ids, StoredTaskHandoff,
    StoredTaskLease, TaskControl, TaskControlStateFile, UploadFence,
};

pub const TASK_SNAPSHOT_MAX_FILES: usize = 1024;
pub const TASK_SNAPSHOT_MAX_FILE_BYTES: usize = 1024 * 1024;
pub const TASK_SNAPSHOT_MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
pub const OWNERSHIP_INDEX_VERSION: u32 = 4;
const ACTIVE_TASKS_ROOT: &str = ".trellis/tasks";
const ARCHIVE_TASKS_ROOT: &str = ".trellis/tasks/archive";
const OWNERSHIP_INDEX_MAX_BYTES: u64 = 16 * 1024 * 1024;
const OWNERSHIP_INDEX_MAX_BINDINGS: usize = 64;
const OWNERSHIP_INDEX_MAX_TASKS: usize = 20_000;
const OWNERSHIP_INDEX_MAX_FILES: usize = 100_000;
const OWNERSHIP_INDEX_MAX_TRACKED_PATHS: usize = 50_000;
const CURSOR_VERSION: u64 = 3;
const REVISION_GUARD_VERSION: u64 = 1;
const REVISION_GUARD_SYNC_MODE: &str = "revision-guard";
const CONFLICT_SYNC_MODE: &str = "conflict-use-server";
const PENDING_REJECTED_LIMIT: usize = 50;
const OWNERSHIP_INBOX_MAX_CHANGES: usize = 200;
const TASK_OWNERSHIP_QUERY_LIMIT: usize = 200;
const HANDOFF_MAX_FILES: u64 = 100_000;
const HANDOFF_MAX_BYTES: u64 = 64 * 1024 * 1024;
const HANDOFF_MANIFEST_FILE: &str = "handoff-manifest.json";
const HANDOFF_META_FILE: &str = "handoff-meta.json";
const UPLOAD_MIN_INTERVAL: Duration = Duration::from_millis(260);
const RATE_LIMIT_RETRY_DELAY: Duration = Duration::from_millis(1000);
const RATE_LIMIT_RETRY_MAX_DELAY: Duration = Duration::from_millis(5000);
const MAX_RATE_LIMIT_RETRIES: u32 = 2;
const SNAPSHOT_EXTENSIONS: [&str; 6] = [".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"];
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);
const SYNC_TRACE_ENV: &str = "TRELLIS_DESKTOP_SYNC_TRACE";
/// ProjectRail 按事件刷新并保留 10 秒可见兜底；关联展示允许短时复用，同步门禁仍逐次精确校验。
const OWNERSHIP_PROJECTION_CACHE_TTL: Duration = Duration::from_secs(15);
/// 分支守卫错误码：这些失败保留本地绑定状态，不覆盖成通用同步错误。
const BRANCH_GUARD_CODES: [&str; 7] = [
    code::BRANCH_MISMATCH,
    code::BRANCH_INVALID,
    code::DETACHED_HEAD,
    code::GIT_FAILED,
    code::NOT_GIT_REPOSITORY,
    code::REPO_NOT_FOUND,
    code::REPO_PATH_INVALID,
];

pub(crate) fn is_branch_guard_code(value: &str) -> bool {
    BRANCH_GUARD_CODES.contains(&value)
}

fn is_branch_guard_error(error: &AgentError) -> bool {
    is_branch_guard_code(&error.code)
}

fn task_sync_error_event(
    binding: Option<&AgentBinding>,
    task_space_id: &str,
    error: &AgentError,
    message: String,
) -> Value {
    let mut event = json!({
        "type": "task_sync_error",
        "taskSpaceId": task_space_id,
        "code": error.code.clone(),
        "message": message,
    });
    if let Some(binding) = binding {
        event["projectName"] = Value::String(binding.display_name.clone());
        event["branchName"] = Value::String(binding.branch_name.clone());
    }
    if let Some(task_dir) = error
        .details
        .as_ref()
        .and_then(|details| details.get("taskDir"))
        .and_then(Value::as_str)
    {
        event["taskDir"] = Value::String(task_dir.to_string());
    }
    event
}

fn approved_bindings(bindings: Vec<AgentBinding>) -> HashMap<String, AgentBinding> {
    let mut map = HashMap::new();
    for binding in bindings {
        if binding.sync_status == "approved"
            && !binding.detach_pending
            && !binding.task_space_id.is_empty()
        {
            map.insert(binding.task_space_id.clone(), binding);
        }
    }
    map
}

fn binding_selection_unchanged(
    current: &HashMap<String, AgentBinding>,
    next: &HashMap<String, AgentBinding>,
) -> bool {
    current.len() == next.len()
        && next.iter().all(|(task_space_id, binding)| {
            current
                .get(task_space_id)
                .is_some_and(|existing| binding_entry_unchanged(existing, binding))
        })
}

fn binding_entry_unchanged(existing: &AgentBinding, next: &AgentBinding) -> bool {
    existing.local_id == next.local_id
        && existing.repo_path == next.repo_path
        && existing.branch_name == next.branch_name
        && existing.baseline_branch == next.baseline_branch
        && existing.initial_sync_completed == next.initial_sync_completed
        && existing.read_only == next.read_only
}

fn association_state_unchanged(existing: &AgentBinding, next: &AgentBinding) -> bool {
    let mut existing = existing.clone();
    let mut next = next.clone();
    existing.last_synced_at = None;
    next.last_synced_at = None;
    existing.last_head = None;
    next.last_head = None;
    existing == next
}

fn association_map_unchanged(
    current: &HashMap<String, AgentBinding>,
    next: &HashMap<String, AgentBinding>,
) -> bool {
    current.len() == next.len()
        && next.iter().all(|(task_space_id, binding)| {
            current
                .get(task_space_id)
                .is_some_and(|existing| association_state_unchanged(existing, binding))
        })
}

/// 服务端 409 会给出可用的最小 clientSequence；只在 CONFLICT 且为正整数时采纳。
fn required_client_sequence(error: &AgentError) -> Option<u64> {
    if error.server_code.as_deref() != Some("CONFLICT") {
        return None;
    }
    error
        .details
        .as_ref()?
        .get("requiredClientSequence")?
        .as_u64()
        .filter(|value| *value > 0)
}

fn is_explicit_pending_rejection(value: &str) -> bool {
    matches!(
        value,
        "TASK_OWNERSHIP_REQUIRED"
            | "TASK_OWNERSHIP_MISMATCH"
            | "TASK_MERGE_EVIDENCE_REQUIRED"
            | "TASK_MERGE_EVIDENCE_INVALID"
            | "TASK_OWNED_BY_BASELINE"
    )
}

fn skipped_for_explicit_pending_rejection(uploaded: &Value) -> bool {
    uploaded.get("skipped").and_then(Value::as_bool) == Some(true)
        && uploaded
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(is_explicit_pending_rejection)
}

pub type ControlSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotFile {
    pub path: String,
    pub task_dir: String,
    pub file_path: String,
    pub archived: bool,
    pub archive_month: Option<String>,
    pub content: String,
    pub sha256: String,
    pub deleted: bool,
    pub base_sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotGroup {
    pub task_dir: String,
    pub archived: bool,
    pub archive_month: Option<String>,
    pub files: Vec<SnapshotFile>,
    pub task_id: Option<String>,
    pub task_branch: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffKind {
    Same,
    ServerOnly,
    LocalOnly,
    ContentConflict,
    MoveDeleteConflict,
    Invalid,
}

#[derive(Debug, Clone)]
pub struct Difference {
    pub kind: DiffKind,
    pub task_id: Option<String>,
    pub task_dir: String,
    pub local: Option<SnapshotGroup>,
    pub server: Option<SnapshotGroup>,
}

impl Difference {
    pub fn action_key(&self) -> String {
        self.task_id
            .clone()
            .unwrap_or_else(|| self.task_dir.clone())
    }

    fn to_control(&self) -> Value {
        let title = self
            .local
            .as_ref()
            .and_then(task_title)
            .or_else(|| self.server.as_ref().and_then(task_title));
        json!({
            "type": match self.kind {
                DiffKind::Same => "same",
                DiffKind::ServerOnly => "server-only",
                DiffKind::LocalOnly => "local-only",
                DiffKind::ContentConflict => "content-conflict",
                DiffKind::MoveDeleteConflict => "move-delete-conflict",
                DiffKind::Invalid => "invalid",
            },
            "taskId": self.task_id,
            "taskDir": self.task_dir,
            "title": title,
            "local": self.local.as_ref().map(|group| json!({
                "taskId": group.task_id,
                "taskDir": group.task_dir,
                "title": task_title(group),
            })),
            "server": self.server.as_ref().map(|group| json!({
                "taskId": group.task_id,
                "taskDir": group.task_dir,
                "title": task_title(group),
            })),
        })
    }
}

pub fn normalize_snapshot_text(value: &str) -> String {
    let stripped = value.strip_prefix('\u{feff}').unwrap_or(value);
    stripped.replace("\r\n", "\n").replace('\r', "\n")
}

pub fn snapshot_sha256(value: &str) -> String {
    let normalized = normalize_snapshot_text(value);
    let digest = Sha256::digest(normalized.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_uppercase())
}

fn is_handoff_backup_id(value: &str) -> bool {
    value.len() == 24
        && value
            .strip_prefix("handoff-")
            .is_some_and(|suffix| suffix.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn sha256_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn handoff_manifest(
    files: &[Value],
    task_dir: &str,
) -> AgentResult<(String, u64, u64, Value)> {
    let prefix = format!("{task_dir}/");
    let mut entries = Vec::with_capacity(files.len());
    let mut total_bytes = 0u64;
    for file in files {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少路径"))?;
        let relative = path.strip_prefix(&prefix).ok_or_else(|| {
            AgentError::new(code::INVALID_RESPONSE, "任务文件不属于 handoff 目录")
        })?;
        let content = file
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少正文"))?;
        let sha256 = file
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少摘要"))?;
        if !is_sha256(sha256) || sha256 != snapshot_sha256(content) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件摘要不一致");
        }
        let size = u64::try_from(normalize_snapshot_text(content).as_bytes().len())
            .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件大小超出范围"))?;
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件总大小溢出"))?;
        entries.push(json!({
            "path": relative,
            "sha256": sha256,
            "sizeBytes": size,
        }));
    }
    entries.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .cmp(&right.get("path").and_then(Value::as_str))
    });
    let manifest = json!({
        "version": 1,
        "taskDir": task_dir,
        "files": entries,
    });
    let bytes = serde_json::to_vec(&manifest).map_err(|error| {
        AgentError::new(
            code::INVALID_RESPONSE,
            format!("handoff manifest 序列化失败: {error}"),
        )
    })?;
    let manifest_sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((
        manifest_sha256,
        files.len() as u64,
        total_bytes,
        manifest,
    ))
}

fn handoff_ack_request(handoff: &StoredTaskHandoff) -> AgentResult<Value> {
    let mut request = json!({
        "outcome": handoff.outcome,
        "fileCount": handoff.file_count,
        "totalBytes": handoff.total_bytes,
    });
    match handoff.outcome.as_str() {
        "cleaned" => {
            let backup_id = handoff
                .backup_id
                .as_deref()
                .filter(|value| is_handoff_backup_id(value))
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "handoff 清理状态缺少备份 ID")
                })?;
            let manifest = handoff
                .manifest_sha256
                .as_deref()
                .filter(|value| is_sha256(value))
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "handoff 清理状态缺少 manifest 摘要")
                })?;
            request["backupId"] = Value::String(backup_id.to_string());
            request["manifestSha256"] = Value::String(manifest.to_string());
        }
        "conflict" => {
            let reason = handoff
                .reason
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            request["reason"] = Value::String(reason.to_string());
        }
        _ => {
            return protocol::err(code::INVALID_RESPONSE, "handoff ACK 结果尚未确定");
        }
    }
    Ok(request)
}

fn handoff_notice(binding: &AgentBinding, handoff: &StoredTaskHandoff) -> Value {
    let handoff_state = if handoff.outcome == "conflict" {
        "source_cleanup_conflict"
    } else {
        handoff.server_handoff_state.as_str()
    };
    json!({
        "type": "task_handoff",
        "taskSpaceId": binding.task_space_id,
        "executionTaskKey": handoff.execution_task_key,
        "taskId": handoff.task_id,
        "taskDir": handoff.relative_dir,
        "handoffState": handoff_state,
        "outcome": handoff.outcome,
        "reason": handoff.reason,
        "backupId": handoff.backup_id,
    })
}

fn git_entries_all_untracked(entries: &[crate::agent::git::GitStatusEntry]) -> bool {
    !entries.is_empty() && entries.iter().all(|entry| entry.status == "??")
}

pub(crate) fn is_archive_task_dir(task_dir: &str) -> bool {
    task_dir == ARCHIVE_TASKS_ROOT
        || task_dir
            .strip_prefix(ARCHIVE_TASKS_ROOT)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn is_archive_snapshot_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == ARCHIVE_TASKS_ROOT
        || normalized
            .strip_prefix(ARCHIVE_TASKS_ROOT)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

fn active_task_directory_from_relative(path: &str) -> Option<String> {
    let task_dir = task_directory_from_relative(path)?;
    (!is_archive_task_dir(&task_dir)).then_some(task_dir)
}

pub(crate) fn active_task_directory_from_path(path: &str) -> Option<String> {
    let task_dir = task_directory_from_path(path).ok()?.task_dir;
    (!is_archive_task_dir(&task_dir)).then_some(task_dir)
}

fn sync_trace(task_space_id: &str, phase: &str, started: Instant, details: Value) {
    if std::env::var_os(SYNC_TRACE_ENV).is_none()
        && std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_none()
    {
        return;
    }
    crate::logging::warn(&format!(
        "任务同步阶段 {{\"taskSpaceId\":\"{}\",\"phase\":\"{}\",\"elapsedMs\":{},\"details\":{}}}",
        task_space_id,
        phase,
        started.elapsed().as_millis(),
        details
    ));
}

pub fn normalize_snapshot_path(value: &str) -> AgentResult<String> {
    let raw = value.trim();
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') {
        return protocol::err(code::INVALID_RESPONSE, "任务文件路径无效");
    }
    let normalized = raw
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized != raw
        || normalized
            .split('/')
            .any(|part| part == "." || part == "..")
        || !normalized.starts_with(".trellis/tasks/")
    {
        return protocol::err(code::INVALID_RESPONSE, "任务文件必须位于 .trellis/tasks 内");
    }
    let lower = normalized.to_lowercase();
    if !SNAPSHOT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return protocol::err(code::INVALID_RESPONSE, "任务文件类型不受支持");
    }
    Ok(normalized)
}

pub struct TaskPathParts {
    pub task_dir: String,
    pub file_path: String,
    pub archived: bool,
    pub archive_month: Option<String>,
}

pub fn task_directory_from_path(value: &str) -> AgentResult<TaskPathParts> {
    let relative_path = normalize_snapshot_path(value)?;
    let parts: Vec<&str> = relative_path.split('/').collect();
    if parts.get(2) == Some(&"archive") {
        let month_ok = parts.get(3).is_some_and(|month| is_archive_month(month));
        if parts.len() < 6 || !month_ok {
            return protocol::err(code::INVALID_RESPONSE, "归档任务目录格式无效");
        }
        return Ok(TaskPathParts {
            task_dir: parts[..5].join("/"),
            file_path: parts[5..].join("/"),
            archived: true,
            archive_month: Some(parts[3].to_string()),
        });
    }
    if parts.len() < 4 {
        return protocol::err(code::INVALID_RESPONSE, "任务目录格式无效");
    }
    Ok(TaskPathParts {
        task_dir: parts[..3].join("/"),
        file_path: parts[3..].join("/"),
        archived: false,
        archive_month: None,
    })
}

pub fn task_directory_from_relative(relative_path: &str) -> Option<String> {
    let normalized = relative_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.first() != Some(&".trellis") || parts.get(1) != Some(&"tasks") {
        return None;
    }
    if parts.get(2) == Some(&"archive") {
        if parts.len() < 5 || !is_archive_month(parts[3]) {
            return None;
        }
        return Some(parts[..5].join("/"));
    }
    if parts.len() < 3 {
        return None;
    }
    Some(parts[..3].join("/"))
}

fn is_archive_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
}

pub fn validate_snapshot_file(value: &Value) -> AgentResult<SnapshotFile> {
    let Some(object) = value.as_object() else {
        return protocol::err(code::INVALID_RESPONSE, "任务文件记录无效");
    };
    let raw_path = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件路径无效"))?;
    let content = match object.get("content") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(_) => return protocol::err(code::INVALID_RESPONSE, "任务文件内容必须是文本"),
    };
    if content.contains('\0') {
        return protocol::err(code::INVALID_RESPONSE, "任务文件不能包含 NUL");
    }
    let normalized = normalize_snapshot_text(&content);
    if normalized.len() > TASK_SNAPSHOT_MAX_FILE_BYTES {
        return protocol::err(code::INVALID_RESPONSE, "单个任务文件超过 1 MiB");
    }
    let sha256 = snapshot_sha256(&normalized);
    if let Some(supplied) = object.get("sha256").and_then(Value::as_str) {
        if !is_sha256(supplied) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件摘要无效");
        }
        if supplied != sha256 {
            return protocol::err(code::INVALID_RESPONSE, "任务文件摘要与内容不一致");
        }
    }
    let base_sha256 = match object.get("baseSha256").and_then(Value::as_str) {
        Some(value) => {
            if !is_sha256(value) {
                return protocol::err(code::INVALID_RESPONSE, "任务文件基线摘要无效");
            }
            Some(value.to_string())
        }
        None => None,
    };
    let parts = task_directory_from_path(raw_path)?;
    Ok(SnapshotFile {
        path: normalize_snapshot_path(raw_path)?,
        task_dir: parts.task_dir,
        file_path: parts.file_path,
        archived: parts.archived,
        archive_month: parts.archive_month,
        content: normalized,
        sha256,
        deleted: object.get("deleted").and_then(Value::as_bool) == Some(true),
        base_sha256,
    })
}

pub fn group_task_snapshot_files(files: &[Value]) -> AgentResult<Vec<SnapshotGroup>> {
    let mut groups: Vec<SnapshotGroup> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut seen = HashSet::new();
    for value in files {
        let archived = value
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(is_archive_snapshot_path);
        if archived {
            continue;
        }
        let file = validate_snapshot_file(value)?;
        if !seen.insert(file.path.clone()) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件路径不能重复");
        }
        let position = match index.get(&file.task_dir) {
            Some(position) => *position,
            None => {
                groups.push(SnapshotGroup {
                    task_dir: file.task_dir.clone(),
                    archived: file.archived,
                    archive_month: file.archive_month.clone(),
                    files: Vec::new(),
                    task_id: None,
                    task_branch: None,
                });
                index.insert(file.task_dir.clone(), groups.len() - 1);
                groups.len() - 1
            }
        };
        let group = &mut groups[position];
        if group.archived != file.archived {
            return protocol::err(code::INVALID_RESPONSE, "同一批次不能混合活动与归档任务路径");
        }
        if file.file_path == "task.json"
            && !file.deleted
            && (group.task_id.is_none() || group.task_branch.is_none())
        {
            let metadata = parse_task_metadata(&file.content);
            let (task_id, task_branch) = metadata;
            group.task_id = group.task_id.take().or(task_id);
            group.task_branch = group.task_branch.take().or(task_branch);
        }
        group.files.push(file);
    }
    for group in &mut groups {
        group
            .files
            .sort_by(|left, right| left.path.cmp(&right.path));
    }
    Ok(groups)
}

fn validate_upload_batch(files: &[Value]) -> AgentResult<()> {
    if files.iter().any(|file| {
        file.get("path")
            .and_then(Value::as_str)
            .is_some_and(is_archive_snapshot_path)
    }) {
        return protocol::err(
            code::INVALID_RESPONSE,
            "归档任务由服务端 Git 管理，客户端不能上传归档路径",
        );
    }
    if files.len() > TASK_SNAPSHOT_MAX_FILES {
        return protocol::err(
            code::INVALID_RESPONSE,
            format!("单批任务文件不能超过 {TASK_SNAPSHOT_MAX_FILES} 个"),
        );
    }
    let total_bytes = files
        .iter()
        .map(|file| {
            file.get("content")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0)
        })
        .fold(0usize, |total, bytes| total.saturating_add(bytes));
    if total_bytes > TASK_SNAPSHOT_MAX_BATCH_BYTES {
        return protocol::err(code::INVALID_RESPONSE, "任务文件批次超过 64 MiB");
    }
    Ok(())
}

fn parse_task_id(content: &str) -> Option<String> {
    parse_task_metadata(content).0
}

fn parse_task_metadata(content: &str) -> (Option<String>, Option<String>) {
    let Ok(parsed) = serde_json::from_str::<Value>(content) else {
        return (None, None);
    };
    (
        parsed
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        parsed
            .get("branch")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    )
}

fn task_title(group: &SnapshotGroup) -> Option<String> {
    let content = group
        .files
        .iter()
        .find(|file| file.file_path == "task.json" && !file.deleted)?
        .content
        .as_str();
    let parsed: Value = serde_json::from_str(content).ok()?;
    parsed
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn task_fingerprint(group: &SnapshotGroup) -> String {
    let mut hasher = Sha256::new();
    for file in &group.files {
        if file.deleted {
            continue;
        }
        hasher.update(file.path.as_bytes());
        hasher.update([0]);
        hasher.update(file.sha256.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

fn file_map(group: &SnapshotGroup) -> BTreeMap<String, String> {
    group
        .files
        .iter()
        .filter(|file| !file.deleted)
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}

fn same_files(left: &BTreeMap<String, String>, right: &BTreeMap<String, String>) -> bool {
    left == right
}

pub fn classify_task_snapshots(
    local_groups: &[SnapshotGroup],
    server_groups: &[SnapshotGroup],
) -> Vec<Difference> {
    let mut local_by_id: HashMap<String, Vec<usize>> = HashMap::new();
    let mut server_by_id: HashMap<String, Vec<usize>> = HashMap::new();
    let mut local_by_dir: HashMap<String, usize> = HashMap::new();
    let mut server_by_dir: HashMap<String, usize> = HashMap::new();
    let mut bad_local: HashSet<usize> = HashSet::new();
    let mut bad_server: HashSet<usize> = HashSet::new();

    for (position, group) in local_groups.iter().enumerate() {
        local_by_dir.insert(group.task_dir.clone(), position);
        match &group.task_id {
            Some(task_id) => local_by_id
                .entry(task_id.clone())
                .or_default()
                .push(position),
            None => {
                bad_local.insert(position);
            }
        }
    }
    for (position, group) in server_groups.iter().enumerate() {
        server_by_dir.insert(group.task_dir.clone(), position);
        match &group.task_id {
            Some(task_id) => server_by_id
                .entry(task_id.clone())
                .or_default()
                .push(position),
            None => {
                bad_server.insert(position);
            }
        }
    }

    let mut task_ids: HashSet<String> = local_by_id.keys().cloned().collect();
    task_ids.extend(server_by_id.keys().cloned());
    for task_id in task_ids {
        let local_matches = local_by_id.get(&task_id).map(Vec::as_slice).unwrap_or(&[]);
        let server_matches = server_by_id.get(&task_id).map(Vec::as_slice).unwrap_or(&[]);
        if local_matches.len() < 2 && server_matches.len() < 2 {
            continue;
        }
        bad_local.extend(local_matches.iter().copied());
        bad_server.extend(server_matches.iter().copied());
    }

    for (task_dir, local_position) in &local_by_dir {
        if let Some(server_position) = server_by_dir.get(task_dir) {
            if local_groups[*local_position].task_id != server_groups[*server_position].task_id {
                bad_local.insert(*local_position);
                bad_server.insert(*server_position);
            }
        }
    }

    let mut differences = Vec::new();
    let mut paired_server: HashSet<usize> = HashSet::new();
    let mut sorted_bad_local: Vec<usize> = bad_local.iter().copied().collect();
    sorted_bad_local.sort_unstable();
    for position in sorted_bad_local {
        let local_group = &local_groups[position];
        let partner = server_by_dir
            .get(&local_group.task_dir)
            .copied()
            .filter(|server_position| bad_server.contains(server_position));
        differences.push(Difference {
            kind: DiffKind::Invalid,
            task_id: None,
            task_dir: local_group.task_dir.clone(),
            local: Some(local_group.clone()),
            server: partner.map(|server_position| server_groups[server_position].clone()),
        });
        if let Some(partner) = partner {
            paired_server.insert(partner);
        }
    }
    let mut sorted_bad_server: Vec<usize> = bad_server.iter().copied().collect();
    sorted_bad_server.sort_unstable();
    for position in sorted_bad_server {
        if paired_server.contains(&position) {
            continue;
        }
        let server_group = &server_groups[position];
        differences.push(Difference {
            kind: DiffKind::Invalid,
            task_id: None,
            task_dir: server_group.task_dir.clone(),
            local: None,
            server: Some(server_group.clone()),
        });
    }

    let mut keys: Vec<String> = Vec::new();
    for (position, group) in local_groups.iter().enumerate() {
        if bad_local.contains(&position) {
            continue;
        }
        let key = group
            .task_id
            .clone()
            .unwrap_or_else(|| group.task_dir.clone());
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    for (position, group) in server_groups.iter().enumerate() {
        if bad_server.contains(&position) {
            continue;
        }
        let key = group
            .task_id
            .clone()
            .unwrap_or_else(|| group.task_dir.clone());
        if !keys.contains(&key) {
            keys.push(key);
        }
    }

    for key in keys {
        let local_group = local_groups
            .iter()
            .enumerate()
            .find(|(position, group)| {
                !bad_local.contains(position)
                    && group
                        .task_id
                        .clone()
                        .unwrap_or_else(|| group.task_dir.clone())
                        == key
            })
            .map(|(_, group)| group.clone());
        let server_group = server_groups
            .iter()
            .enumerate()
            .find(|(position, group)| {
                !bad_server.contains(position)
                    && group
                        .task_id
                        .clone()
                        .unwrap_or_else(|| group.task_dir.clone())
                        == key
            })
            .map(|(_, group)| group.clone());
        match (&local_group, &server_group) {
            (Some(local), None) => differences.push(Difference {
                kind: DiffKind::LocalOnly,
                task_id: Some(key),
                task_dir: local.task_dir.clone(),
                local: local_group,
                server: None,
            }),
            (None, Some(server)) => differences.push(Difference {
                kind: DiffKind::ServerOnly,
                task_id: Some(key),
                task_dir: server.task_dir.clone(),
                local: None,
                server: server_group,
            }),
            (Some(local), Some(server)) => {
                let kind = if same_files(&file_map(local), &file_map(server)) {
                    DiffKind::Same
                } else if local.task_dir != server.task_dir {
                    DiffKind::MoveDeleteConflict
                } else {
                    DiffKind::ContentConflict
                };
                differences.push(Difference {
                    kind,
                    task_id: Some(key),
                    task_dir: server.task_dir.clone(),
                    local: local_group,
                    server: server_group,
                });
            }
            (None, None) => {}
        }
    }
    differences
}

fn baselines_from_snapshot(files: &[SnapshotFile]) -> BTreeMap<String, String> {
    files
        .iter()
        .filter(|file| {
            !file.deleted && !file.archived && is_sha256(&file.sha256)
        })
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}

fn merge_baselines(
    current: &BTreeMap<String, String>,
    files: &[SnapshotFile],
) -> BTreeMap<String, String> {
    let mut next = normalize_baselines(current);
    for file in files {
        if file.deleted {
            next.remove(&file.path);
        } else if is_sha256(&file.sha256) {
            next.insert(file.path.clone(), file.sha256.clone());
        }
    }
    next
}

fn normalize_baselines(value: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    value
        .iter()
        .filter(|(path_name, sha256)| {
            is_sha256(sha256)
                && normalize_snapshot_path(path_name).is_ok()
                && active_task_directory_from_path(path_name).is_some()
        })
        .map(|(path_name, sha256)| (path_name.clone(), sha256.clone()))
        .collect()
}

fn file_state_from_group(group: &SnapshotGroup) -> BTreeMap<String, String> {
    group
        .files
        .iter()
        .filter(|file| !file.deleted && !file.archived)
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}

fn baselines_by_task_dir(
    baselines: &BTreeMap<String, String>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut grouped = BTreeMap::new();
    for (path_name, sha256) in normalize_baselines(baselines) {
        if let Some(task_dir) = active_task_directory_from_relative(&path_name) {
            grouped
                .entry(task_dir)
                .or_insert_with(BTreeMap::new)
                .insert(path_name, sha256);
        }
    }
    grouped
}

fn local_sync_state_from_groups(
    cursor: &Cursor,
    local_groups: &[SnapshotGroup],
    server_baselines: &BTreeMap<String, String>,
) -> (
    Vec<String>,
    BTreeMap<String, BTreeMap<String, String>>,
    HashSet<String>,
) {
    let by_dir: HashMap<&str, &SnapshotGroup> = local_groups
        .iter()
        .map(|group| (group.task_dir.as_str(), group))
        .collect();
    let mut next_deferred = cursor.deferred.clone();
    let mut task_dirs: HashSet<String> = by_dir
        .keys()
        .map(|task_dir| (*task_dir).to_string())
        .collect();
    let cursor_baselines = baselines_by_task_dir(&cursor.baselines);
    let server_baselines = baselines_by_task_dir(server_baselines);
    task_dirs.extend(cursor.deferred.keys().cloned());
    task_dirs.extend(cursor_baselines.keys().cloned());
    task_dirs.extend(server_baselines.keys().cloned());
    let mut dirty = Vec::new();
    let mut reconciled_deferred = HashSet::new();
    for task_dir in task_dirs {
        let local_state = by_dir
            .get(task_dir.as_str())
            .map(|group| file_state_from_group(group))
            .unwrap_or_default();
        // cursor 基线只判 dirty；只有合并服务端基线完全一致时才记录为精确收敛。
        if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
            if local_state.is_empty() {
                continue;
            }
            if deferred_state == &local_state {
                if server_baselines
                    .get(task_dir.as_str())
                    .is_some_and(|baseline| baseline == &local_state)
                {
                    next_deferred.remove(&task_dir);
                    reconciled_deferred.insert(task_dir.clone());
                }
                continue;
            }
            next_deferred.remove(&task_dir);
        }
        let cursor_matches = cursor_baselines
            .get(task_dir.as_str())
            .map_or(local_state.is_empty(), |baseline| baseline == &local_state);
        if !cursor_matches {
            dirty.push(task_dir);
        }
    }
    (dirty, next_deferred, reconciled_deferred)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    pub revision: u64,
    pub revision_guard_version: u64,
    pub sequence: u64,
    pub baseline_reconciled_head: String,
    pub pending: Option<PendingBatch>,
    pub pending_rejected: BTreeMap<String, PendingRejection>,
    pub baselines: BTreeMap<String, String>,
    pub deferred: BTreeMap<String, BTreeMap<String, String>>,
    pub ownership_pending: BTreeMap<String, String>,
    pub conflict_blocked: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingBatch {
    pub batch_id: String,
    pub client_sequence: u64,
    pub files: Vec<Value>,
    pub merge_evidence: Option<Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRejection {
    pub batch_id: String,
    pub client_sequence: u64,
    pub reason: String,
    pub created_at: String,
    pub blocked_at: String,
}

fn cursor_from_entry(entry: &Value) -> Cursor {
    let mut cursor = Cursor {
        revision: entry.get("revision").and_then(Value::as_u64).unwrap_or(0),
        revision_guard_version: entry
            .get("revisionGuardVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        sequence: entry.get("sequence").and_then(Value::as_u64).unwrap_or(0),
        baseline_reconciled_head: entry
            .get("baselineReconciledHead")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pending: entry.get("pending").and_then(parse_pending_batch),
        pending_rejected: entry
            .get("pendingRejected")
            .map(parse_pending_rejected)
            .unwrap_or_default(),
        baselines: entry
            .get("baselines")
            .and_then(parse_baselines)
            .unwrap_or_default(),
        deferred: entry
            .get("deferred")
            .and_then(parse_deferred)
            .unwrap_or_default(),
        ownership_pending: entry
            .get("ownershipPending")
            .map(parse_ownership_pending)
            .unwrap_or_default(),
        conflict_blocked: entry
            .get("conflictBlocked")
            .map(parse_conflict_blocked)
            .unwrap_or_default(),
    };
    cursor.baselines = normalize_baselines(&cursor.baselines);
    cursor.deferred.retain(|task_dir, files| {
        !is_archive_task_dir(task_dir)
            && files
                .keys()
                .all(|path| active_task_directory_from_path(path).is_some())
    });
    cursor
        .ownership_pending
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    cursor
        .conflict_blocked
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    cursor
        .pending_rejected
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    trim_pending_rejections(&mut cursor.pending_rejected);
    cursor.pending = cursor
        .pending
        .and_then(|batch| migrate_archive_pending_batch(batch, cursor.sequence));
    cursor
}

fn migrate_archive_pending_batch(batch: PendingBatch, cursor_sequence: u64) -> Option<PendingBatch> {
    let mut kept = Vec::with_capacity(batch.files.len());
    let mut changed = false;
    for file in &batch.files {
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            kept.push(file.clone());
            continue;
        };
        if is_archive_snapshot_path(path) {
            changed = true;
            continue;
        }
        kept.push(file.clone());
    }
    if kept.is_empty() {
        return None;
    }
    if !changed {
        return Some(batch);
    }
    const SUFFIX: &str = ".archive-filtered.v1";
    let prefix_len = 127usize.saturating_sub(SUFFIX.len());
    let prefix: String = batch.batch_id.chars().take(prefix_len).collect();
    Some(PendingBatch {
        batch_id: format!("{prefix}{SUFFIX}"),
        client_sequence: next_client_sequence(cursor_sequence),
        files: kept,
        merge_evidence: None,
        created_at: batch.created_at,
    })
}

fn cursor_entry_needs_archive_migration(entry: &Value) -> bool {
    entry
        .get("pending")
        .and_then(|pending| pending.get("files"))
        .and_then(Value::as_array)
        .is_some_and(|files| {
            files.iter().any(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(is_archive_snapshot_path)
            })
        })
        || entry
            .get("baselines")
            .and_then(Value::as_object)
            .is_some_and(|values| values.keys().any(|path| is_archive_snapshot_path(path)))
        || entry
            .get("deferred")
            .and_then(Value::as_object)
            .is_some_and(|values| {
                values.iter().any(|(task_dir, files)| {
                    is_archive_task_dir(task_dir)
                        || files.as_object().is_some_and(|values| {
                            values.keys().any(|path| is_archive_snapshot_path(path))
                        })
                })
            })
        || ["ownershipPending", "conflictBlocked", "pendingRejected"]
            .iter()
            .any(|field| {
            entry
                .get(*field)
                .and_then(Value::as_object)
                .is_some_and(|values| values.keys().any(|task_dir| is_archive_task_dir(task_dir)))
            })
}

struct OwnershipReview {
    group: SnapshotGroup,
    reason: String,
}

struct OwnershipDecision {
    task_dir: String,
    action: String,
    branch_name: String,
}

#[derive(Default)]
struct OwnershipResolution {
    syncable: HashMap<String, SnapshotGroup>,
    paused: Vec<SnapshotGroup>,
    reviews: Vec<OwnershipReview>,
    invalid: Vec<String>,
    project_task_spaces: Vec<Value>,
    merge_evidence: HashMap<String, Value>,
}

#[derive(Debug, Clone)]
pub struct UploadFile {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub deleted: bool,
    pub base_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadMode {
    New,
    Preclassified,
    Replay,
}

impl UploadFile {
    fn to_value(&self) -> Value {
        let mut value = json!({
            "path": self.path,
            "content": self.content,
            "sha256": self.sha256,
            "deleted": self.deleted,
        });
        if let Some(base) = &self.base_sha256 {
            value["baseSha256"] = Value::String(base.clone());
        }
        value
    }
}

enum WatchEvent {
    TaskPath {
        task_space_id: String,
        relative_path: String,
    },
    GitChanged {
        task_space_id: String,
    },
}

#[derive(Default)]
struct WatchState {
    watchers: Vec<RecommendedWatcher>,
    tx: Option<mpsc::UnboundedSender<WatchEvent>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipIndex {
    pub version: u32,
    #[serde(default)]
    pub bindings: BTreeMap<String, OwnershipIndexBinding>,
}

impl OwnershipIndex {
    fn empty() -> Self {
        Self {
            version: OWNERSHIP_INDEX_VERSION,
            bindings: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipIndexBinding {
    pub task_space_id: String,
    pub repo_path: String,
    pub branch_name: String,
    #[serde(default)]
    pub baseline_branch: Option<String>,
    #[serde(default)]
    pub head_commit: String,
    #[serde(default)]
    pub head_fingerprint: String,
    #[serde(default)]
    pub git_index_fingerprint: String,
    #[serde(default)]
    pub tracked_paths: Vec<String>,
    #[serde(default)]
    pub tracked_paths_loaded: bool,
    #[serde(default)]
    pub tasks: BTreeMap<String, OwnershipTaskIndex>,
    #[serde(default)]
    pub files: BTreeMap<String, OwnershipFileIndex>,
    #[serde(default)]
    pub files_complete: bool,
    #[serde(default)]
    pub dirty_task_dirs: Vec<String>,
    #[serde(default)]
    pub paused: Vec<String>,
    #[serde(default)]
    pub local_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipTaskIndex {
    pub task_json_size: u64,
    #[serde(default)]
    pub task_json_modified_ns: Option<u64>,
    pub task_json_sha256: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipFileIndex {
    pub size: u64,
    #[serde(default)]
    pub modified_ns: Option<u64>,
    pub sha256: String,
}

fn valid_cached_task_dir(task_dir: &str) -> bool {
    task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref() == Some(task_dir)
        && !is_archive_task_dir(task_dir)
        && protocol::resolve_task_dir_under(Path::new(".trellis/tasks"), task_dir).is_some()
}

fn valid_cached_snapshot_path(path: &str) -> bool {
    task_directory_from_path(path).is_ok()
        && active_task_directory_from_path(path).is_some()
        && SNAPSHOT_EXTENSIONS
            .iter()
            .any(|extension| path.to_lowercase().ends_with(extension))
}

fn normalize_cached_dirs(values: Vec<String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .filter(|task_dir| valid_cached_task_dir(task_dir))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.sort();
    values
}

pub(crate) async fn ownership_tasks_root_is_safe(repo_path: &Path) -> bool {
    for path in [
        repo_path.join(".trellis"),
        repo_path.join(".trellis").join("tasks"),
    ] {
        let Ok(metadata) = tokio::fs::symlink_metadata(path).await else {
            return false;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return false;
        }
    }
    true
}

fn normalize_index(mut index: OwnershipIndex) -> Option<OwnershipIndex> {
    if index.version != OWNERSHIP_INDEX_VERSION
        || index.bindings.len() > OWNERSHIP_INDEX_MAX_BINDINGS
    {
        return None;
    }
    for binding in index.bindings.values_mut() {
        let tracked_paths = binding
            .tracked_paths
            .drain(..)
            .filter(|path| {
                task_directory_from_path(path).is_ok_and(|parts| {
                    !parts.archived && parts.file_path == "task.json"
                })
            })
            .collect::<HashSet<_>>();
        if tracked_paths.len() > OWNERSHIP_INDEX_MAX_TRACKED_PATHS {
            return None;
        }
        binding.tracked_paths = tracked_paths.into_iter().collect();
        binding.tracked_paths.sort();
        binding
            .files
            .retain(|path, file| valid_cached_snapshot_path(path) && is_sha256(&file.sha256));
        if binding.files.len() > OWNERSHIP_INDEX_MAX_FILES {
            return None;
        }
        binding.dirty_task_dirs =
            normalize_cached_dirs(std::mem::take(&mut binding.dirty_task_dirs));
        if binding.dirty_task_dirs.len() > OWNERSHIP_INDEX_MAX_TASKS {
            return None;
        }
        binding.local_dirs = normalize_cached_dirs(std::mem::take(&mut binding.local_dirs));
        binding.tasks.retain(|task_dir, task| {
            valid_cached_task_dir(task_dir) && is_sha256(&task.task_json_sha256)
        });
        if binding.tasks.len() > OWNERSHIP_INDEX_MAX_TASKS {
            return None;
        }
        for (task_dir, task) in &binding.tasks {
            let Some(file) = binding.files.get(&format!("{task_dir}/task.json")) else {
                return None;
            };
            if file.size != task.task_json_size
                || file.modified_ns != task.task_json_modified_ns
                || file.sha256 != task.task_json_sha256
            {
                return None;
            }
        }
        let task_file_dirs = binding
            .files
            .keys()
            .filter_map(|path| task_directory_from_path(path).ok())
            .filter(|parts| parts.file_path == "task.json")
            .map(|parts| parts.task_dir)
            .collect::<HashSet<_>>();
        if task_file_dirs.len() != binding.tasks.len()
            || task_file_dirs
                .iter()
                .any(|task_dir| !binding.tasks.contains_key(task_dir))
        {
            return None;
        }
        binding.paused = normalize_cached_dirs(std::mem::take(&mut binding.paused));
        if binding.local_dirs.len() > OWNERSHIP_INDEX_MAX_TASKS {
            return None;
        }
        let local_dirs: HashSet<String> = binding.local_dirs.iter().cloned().collect();
        if binding
            .tasks
            .keys()
            .any(|task_dir| !local_dirs.contains(task_dir))
        {
            return None;
        }
        binding
            .paused
            .retain(|task_dir| local_dirs.contains(task_dir));
        let mut expected_paused: Vec<String> = binding
            .tasks
            .iter()
            .filter(|(_, task)| {
                task.branch
                    .as_deref()
                    .is_some_and(|branch| branch != binding.branch_name)
            })
            .map(|(task_dir, _)| task_dir.clone())
            .collect();
        if !expected_paused.is_empty() {
            if binding.baseline_branch.as_deref() == Some(binding.branch_name.as_str()) {
                if !binding.tracked_paths_loaded {
                    return None;
                }
                let tracked_paths: HashSet<&str> =
                    binding.tracked_paths.iter().map(String::as_str).collect();
                expected_paused.retain(|task_dir| {
                    !tracked_paths.contains(format!("{task_dir}/task.json").as_str())
                });
            } else if binding.tracked_paths_loaded {
                return None;
            }
        }
        expected_paused.sort();
        if binding.paused != expected_paused {
            return None;
        }
    }
    Some(index)
}

pub(crate) async fn load_ownership_index(path: &Path) -> Option<OwnershipIndex> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > OWNERSHIP_INDEX_MAX_BYTES
    {
        return None;
    }
    let text = tokio::fs::read_to_string(path).await.ok()?;
    if text.len() as u64 > OWNERSHIP_INDEX_MAX_BYTES {
        return None;
    }
    let index = serde_json::from_str::<OwnershipIndex>(&text).ok()?;
    normalize_index(index)
}

pub(crate) fn indexed_ownership_projection(
    index: &OwnershipIndex,
    binding: &AgentBinding,
) -> Option<(
    Arc<HashSet<String>>,
    Arc<HashSet<String>>,
    String,
    String,
)> {
    let entry = index.bindings.get(&binding.local_id)?;
    if entry.task_space_id != binding.task_space_id
        || entry.repo_path != binding.repo_path
        || entry.branch_name != binding.branch_name
        || entry.baseline_branch != binding.baseline_branch
    {
        return None;
    }
    Some((
        Arc::new(entry.paused.iter().cloned().collect()),
        Arc::new(entry.local_dirs.iter().cloned().collect()),
        entry.head_commit.clone(),
        entry.head_fingerprint.clone(),
    ))
}

fn indexed_local_groups(entry: &OwnershipIndexBinding) -> AgentResult<Vec<SnapshotGroup>> {
    let mut groups = BTreeMap::<String, SnapshotGroup>::new();
    for (path, file) in &entry.files {
        let parts = task_directory_from_path(path)?;
        if parts.archived {
            continue;
        }
        let task = entry.tasks.get(&parts.task_dir);
        let group = groups
            .entry(parts.task_dir.clone())
            .or_insert_with(|| SnapshotGroup {
                task_dir: parts.task_dir.clone(),
                archived: parts.archived,
                archive_month: parts.archive_month.clone(),
                files: Vec::new(),
                task_id: task.and_then(|task| task.task_id.clone()),
                task_branch: task.and_then(|task| task.branch.clone()),
            });
        group.files.push(SnapshotFile {
            path: path.clone(),
            task_dir: parts.task_dir,
            file_path: parts.file_path,
            archived: parts.archived,
            archive_month: parts.archive_month,
            content: String::new(),
            sha256: file.sha256.clone(),
            deleted: false,
            base_sha256: None,
        });
    }
    let mut groups = groups.into_values().collect::<Vec<_>>();
    for group in &mut groups {
        group.files.sort_by(|left, right| left.path.cmp(&right.path));
    }
    Ok(groups)
}

struct HeadTreeCache {
    branch_name: String,
    head_commit: String,
    tracked_paths: Arc<HashSet<String>>,
    validated_at: Instant,
}

struct OwnershipProjectionCache {
    local_id: String,
    branch_name: String,
    baseline_branch: Option<String>,
    repo_path: String,
    head_commit: String,
    head_fingerprint: String,
    paused: Arc<HashSet<String>>,
    local_dirs: Arc<HashSet<String>>,
    validated_at: Instant,
}

#[derive(Clone, Copy)]
struct ProjectionEpoch {
    global: u64,
    local: u64,
}

#[derive(Default)]
struct OwnershipValidationState {
    pending: Mutex<HashSet<String>>,
    notify: Notify,
}

fn ownership_projection_cache_matches(
    entry: &OwnershipProjectionCache,
    binding: &AgentBinding,
) -> bool {
    entry.local_id == binding.local_id
        && entry.branch_name == binding.branch_name
        && entry.baseline_branch == binding.baseline_branch
        && entry.repo_path == binding.repo_path
}

struct HandoffSource {
    files: Vec<Value>,
    backup_id: String,
    manifest_sha256: String,
    manifest: Value,
    file_count: u64,
    total_bytes: u64,
}

enum HandoffSourceState {
    Ready(HandoffSource),
    Conflict(&'static str),
}

pub struct TaskSync {
    store: Arc<ConfigStore>,
    api: Arc<ApiClient>,
    emit: ControlSink,
    state_sink: Option<StateSink>,
    bindings: Mutex<HashMap<String, AgentBinding>>,
    suppressed: Mutex<HashMap<String, Option<String>>>,
    upload_gate: Mutex<HashMap<String, Instant>>,
    cursor_state: Mutex<Option<Value>>,
    cursor_write: Mutex<()>,
    task_control_state: Mutex<TaskControlStateFile>,
    task_control_loaded: OnceCell<()>,
    task_control_write: Mutex<()>,
    last_baseline_files: Mutex<Vec<SnapshotFile>>,
    head_tree_cache: Mutex<HashMap<String, HeadTreeCache>>,
    ownership_projection_cache: Mutex<HashMap<String, OwnershipProjectionCache>>,
    ownership_projection_epoch: std::sync::atomic::AtomicU64,
    ownership_projection_local_epoch: Mutex<HashMap<String, u64>>,
    ownership_index: Mutex<OwnershipIndex>,
    ownership_index_loaded: OnceCell<()>,
    ownership_index_writer: std::sync::atomic::AtomicBool,
    ownership_validation_state: Arc<OwnershipValidationState>,
    ownership_validation_started: std::sync::atomic::AtomicBool,
    ownership_refresh_lock: Mutex<()>,
    ownership_inbox_unavailable: std::sync::atomic::AtomicBool,
    binding_selection_lock: Mutex<()>,
    binding_sync_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    syncing_task_spaces: Mutex<HashMap<String, usize>>,
    binding_sync_idle: Notify,
    heartbeat_wake: Option<Arc<Notify>>,
    deferred_uploads: Mutex<HashMap<String, HashSet<String>>>,
    #[cfg(test)]
    head_tree_scans: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    branch_validations: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    task_json_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    task_file_reads: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    task_entries_examined: std::sync::atomic::AtomicUsize,
    baseline_owned: Mutex<HashSet<String>>,
    watch: Mutex<WatchState>,
}

impl TaskSync {
    pub fn new(store: Arc<ConfigStore>, api: Arc<ApiClient>, emit: ControlSink) -> Self {
        Self {
            store,
            api,
            emit,
            state_sink: None,
            bindings: Mutex::new(HashMap::new()),
            suppressed: Mutex::new(HashMap::new()),
            upload_gate: Mutex::new(HashMap::new()),
            cursor_state: Mutex::new(None),
            cursor_write: Mutex::new(()),
            task_control_state: Mutex::new(TaskControlStateFile::empty()),
            task_control_loaded: OnceCell::new(),
            task_control_write: Mutex::new(()),
            last_baseline_files: Mutex::new(Vec::new()),
            head_tree_cache: Mutex::new(HashMap::new()),
            ownership_projection_cache: Mutex::new(HashMap::new()),
            ownership_projection_epoch: std::sync::atomic::AtomicU64::new(0),
            ownership_projection_local_epoch: Mutex::new(HashMap::new()),
            ownership_index: Mutex::new(OwnershipIndex::empty()),
            ownership_index_loaded: OnceCell::new(),
            ownership_index_writer: std::sync::atomic::AtomicBool::new(false),
            ownership_validation_state: Arc::new(OwnershipValidationState::default()),
            ownership_validation_started: std::sync::atomic::AtomicBool::new(false),
            ownership_refresh_lock: Mutex::new(()),
            ownership_inbox_unavailable: std::sync::atomic::AtomicBool::new(false),
            binding_selection_lock: Mutex::new(()),
            binding_sync_locks: Mutex::new(HashMap::new()),
            syncing_task_spaces: Mutex::new(HashMap::new()),
            binding_sync_idle: Notify::new(),
            heartbeat_wake: None,
            deferred_uploads: Mutex::new(HashMap::new()),
            #[cfg(test)]
            head_tree_scans: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            branch_validations: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            task_json_reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            task_file_reads: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            task_entries_examined: std::sync::atomic::AtomicUsize::new(0),
            baseline_owned: Mutex::new(HashSet::new()),
            watch: Mutex::new(WatchState::default()),
        }
    }

    pub fn with_ownership_index_writer(self) -> Self {
        self.ownership_index_writer
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self
    }

    pub fn with_state_sink(mut self, sink: StateSink) -> Self {
        self.state_sink = Some(sink);
        self
    }

    pub fn with_heartbeat_wake(mut self, wake: Arc<Notify>) -> Self {
        self.heartbeat_wake = Some(wake);
        self
    }

    fn wake_heartbeat(&self) {
        if let Some(wake) = &self.heartbeat_wake {
            wake.notify_one();
        }
    }

    async fn task_space_sync_lock(&self, task_space_id: &str) -> Arc<Mutex<()>> {
        self.binding_sync_locks
            .lock()
            .await
            .entry(task_space_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn ensure_ownership_index_loaded(&self) {
        self.ownership_index_loaded
            .get_or_init(|| async {
                let loaded = load_ownership_index(&self.store.paths.ownership_index_file)
                    .await
                    .unwrap_or_else(OwnershipIndex::empty);
                *self.ownership_index.lock().await = loaded;
            })
            .await;
    }

    async fn ensure_task_control_loaded(&self) {
        self.task_control_loaded
            .get_or_init(|| async {
                let state =
                    match tokio::fs::read_to_string(&self.store.paths.task_control_file).await {
                        Ok(raw) => parse_state_file(&raw),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            TaskControlStateFile::empty()
                        }
                        Err(error) => {
                            crate::logging::warn(&format!(
                                "读取任务控制状态失败，按空状态继续：{error}"
                            ));
                            TaskControlStateFile::empty()
                        }
                    };
                *self.task_control_state.lock().await = state;
            })
            .await;
    }

    async fn merge_task_controls(
        &self,
        binding: &AgentBinding,
        controls: &[TaskControl],
    ) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            let changed = state.merge_binding_controls(
                &binding.local_id,
                &binding.task_space_id,
                controls,
            )?;
            changed.then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(())
    }

    async fn upsert_task_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            state
                .upsert_control(&binding.local_id, control)?
                .then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(())
    }

    async fn upsert_task_handoff_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<String> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let key = handoff_state_key(&binding.local_id, &control.execution_task_key);
        let next = {
            let mut state = self.task_control_state.lock().await;
            state
                .upsert_handoff_control(&binding.local_id, control)?
                .then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(key)
    }

    async fn stored_task_handoff(&self, key: &str) -> Option<StoredTaskHandoff> {
        self.ensure_task_control_loaded().await;
        self.task_control_state
            .lock()
            .await
            .handoff(key)
            .cloned()
    }

    async fn mark_handoff_ack_pending(
        &self,
        key: &str,
        outcome: &str,
        reason: Option<&str>,
        backup_id: Option<&str>,
        manifest_sha256: Option<&str>,
        file_count: u64,
        total_bytes: u64,
    ) -> AgentResult<()> {
        let updated_at = protocol::now_iso8601();
        self.persist_task_control_change(|state| {
            state.mark_handoff_ack_pending(
                key,
                outcome,
                reason.map(str::to_string),
                backup_id.map(str::to_string),
                manifest_sha256.map(str::to_string),
                file_count,
                total_bytes,
                &updated_at,
            )
        })
        .await?;
        Ok(())
    }

    async fn mark_handoff_ack_done(&self, key: &str) -> AgentResult<()> {
        let updated_at = protocol::now_iso8601();
        self.persist_task_control_change(|state| state.mark_handoff_ack_done(key, &updated_at))
            .await?;
        Ok(())
    }

    async fn emit_handoff_notice(
        &self,
        binding: &AgentBinding,
        key: &str,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<()> {
        let state = if handoff.outcome == "conflict" {
            "source_cleanup_conflict"
        } else {
            handoff.server_handoff_state.as_str()
        };
        if handoff.notified_state == state {
            return Ok(());
        }
        (self.emit)(handoff_notice(binding, handoff));
        self.persist_task_control_change(|controls| {
            controls.mark_handoff_notified(key, state)
        })
        .await?;
        Ok(())
    }

    async fn persist_task_control_change<F>(&self, mutator: F) -> AgentResult<bool>
    where
        F: FnOnce(&mut TaskControlStateFile) -> bool,
    {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            if mutator(&mut state) {
                Some(state.clone())
            } else {
                None
            }
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
            return Ok(true);
        }
        Ok(false)
    }

    async fn save_task_lease(
        &self,
        execution_task_key: &str,
        lease: Value,
    ) -> AgentResult<()> {
        let token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "租约响应缺少 token"))?;
        let expires_at = lease
            .get("expiresAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let stored = StoredTaskLease {
            token: token.to_string(),
            expires_at: expires_at.to_string(),
            lease_id: lease
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string),
            updated_at: protocol::now_iso8601(),
        };
        self.persist_task_control_change(|state| {
            state.set_lease(execution_task_key, stored)
        })
        .await?;
        Ok(())
    }

    async fn stored_task_lease(&self, execution_task_key: &str) -> Option<StoredTaskLease> {
        self.ensure_task_control_loaded().await;
        self.task_control_state
            .lock()
            .await
            .leases
            .get(execution_task_key)
            .cloned()
    }

    async fn has_persisted_task_control(&self, execution_task_key: &str) -> bool {
        self.ensure_task_control_loaded().await;
        self.task_control_state
            .lock()
            .await
            .controls
            .contains_key(execution_task_key)
    }

    async fn remove_task_lease(&self, execution_task_key: &str) -> AgentResult<()> {
        self.persist_task_control_change(|state| state.remove_lease(execution_task_key))
            .await?;
        Ok(())
    }

    async fn update_control_task_version(
        &self,
        execution_task_key: &str,
        task_version: u64,
    ) -> AgentResult<()> {
        self.persist_task_control_change(|state| {
            state.update_task_version(execution_task_key, task_version)
        })
        .await?;
        Ok(())
    }

    async fn claim_remote_task(
        &self,
        binding: &AgentBinding,
        execution_task_key: &str,
    ) -> AgentResult<(TaskControl, String)> {
        let encoded = urlencode(execution_task_key);
        let response = self
            .api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/claim"),
                None,
                Duration::from_secs(60),
            )
            .await?;
        let task = response.get("task").ok_or_else(|| {
            AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 task")
        })?;
        let control = TaskControl::from_task_value(task)?;
        let lease = response
            .get("lease")
            .filter(|lease| !lease.is_null())
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 lease")
            })?;
        let lease_token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 lease.token")
            })?
            .to_string();
        self.upsert_task_control(binding, &control).await?;
        self.save_task_lease(&control.execution_task_key, lease.clone())
            .await?;
        Ok((control, lease_token))
    }

    async fn heartbeat_remote_task(
        &self,
        binding: &AgentBinding,
        execution_task_key: &str,
        lease_token: &str,
    ) -> AgentResult<(TaskControl, String)> {
        let encoded = urlencode(execution_task_key);
        let response = self
            .api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/heartbeat"),
                Some(&json!({ "leaseToken": lease_token })),
                Duration::from_secs(60),
            )
            .await?;
        let task = response.get("task").ok_or_else(|| {
            AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 task")
        })?;
        let control = TaskControl::from_task_value(task)?;
        let lease = response.get("lease").filter(|lease| !lease.is_null()).ok_or_else(
            || AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 lease"),
        )?;
        let next_token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 lease.token")
            })?
            .to_string();
        self.upsert_task_control(binding, &control).await?;
        self.save_task_lease(&control.execution_task_key, lease.clone())
            .await?;
        Ok((control, next_token))
    }

    async fn release_remote_task(
        &self,
        execution_task_key: &str,
        lease_token: &str,
    ) -> AgentResult<Value> {
        let encoded = urlencode(execution_task_key);
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/release"),
                Some(&json!({ "leaseToken": lease_token })),
                Duration::from_secs(60),
            )
            .await
    }

    async fn ack_remote_handoff(&self, handoff: &StoredTaskHandoff) -> AgentResult<Value> {
        let encoded = urlencode(&handoff.execution_task_key);
        let body = handoff_ack_request(handoff)?;
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/handoff-ack"),
                Some(&body),
                Duration::from_secs(60),
            )
            .await
    }

    async fn attempt_handoff_ack(&self, key: &str) -> AgentResult<bool> {
        let Some(handoff) = self.stored_task_handoff(key).await else {
            return Ok(false);
        };
        if handoff.ack_state != "pending" || handoff.outcome.is_empty() {
            return Ok(false);
        }
        match self.ack_remote_handoff(&handoff).await {
            Ok(_) => {
                self.mark_handoff_ack_done(key).await?;
                Ok(true)
            }
            Err(error) if error.server_code.as_deref() == Some("HANDOFF_LEASE_HELD") => {
                self.mark_handoff_ack_pending(
                    key,
                    "conflict",
                    Some("lease_active"),
                    handoff.backup_id.as_deref(),
                    handoff.manifest_sha256.as_deref(),
                    handoff.file_count,
                    handoff.total_bytes,
                )
                .await?;
                crate::logging::warn(&format!(
                    "handoff ACK 被有效租约阻止 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                Ok(false)
            }
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff ACK 暂未送达 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                Ok(false)
            }
        }
    }

    async fn handoff_task_directory_exists(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<bool> {
        let source = resolve_task_directory(binding, task_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => protocol::err(code::INVALID_RESPONSE, "handoff 任务目录不是真实目录"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_error(error)),
        }
    }

    async fn handoff_backup_target(
        &self,
        binding: &AgentBinding,
        backup_id: &str,
    ) -> AgentResult<PathBuf> {
        if !is_handoff_backup_id(backup_id) {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份 ID 格式无效");
        }
        let task_space_id =
            protocol::assert_safe_id_default(Some(&binding.task_space_id), "任务空间 ID")?;
        self.store.ensure_directories().await?;
        let metadata = tokio::fs::symlink_metadata(&self.store.paths.live_backups_dir)
            .await
            .map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份根目录必须是真实目录");
        }
        let root = self
            .store
            .paths
            .live_backups_dir
            .join(task_space_id);
        match tokio::fs::symlink_metadata(&root).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return protocol::err(code::INVALID_RESPONSE, "handoff 任务空间备份目录无效")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::create_dir(&root).await.map_err(io_error)?;
            }
            Err(error) => return Err(io_error(error)),
        }
        let target = root.join(backup_id);
        if !protocol::is_path_inside(&root, &target) {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份目录越界");
        }
        Ok(target)
    }

    async fn handoff_backup_is_valid(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<bool> {
        let (Some(backup_id), Some(expected_manifest_sha256)) =
            (handoff.backup_id.as_deref(), handoff.manifest_sha256.as_deref())
        else {
            return Ok(false);
        };
        if !is_sha256(expected_manifest_sha256) {
            return Ok(false);
        }
        let target = match self.handoff_backup_target(binding, backup_id).await {
            Ok(target) => target,
            Err(_) => return Ok(false),
        };
        match tokio::fs::symlink_metadata(&target).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        }
        cleanup_handoff_backup_temps(&target).await?;
        let canonical_root = tokio::fs::canonicalize(target.parent().unwrap_or(&target))
            .await
            .map_err(io_error)?;
        let canonical_target = tokio::fs::canonicalize(&target).await.map_err(io_error)?;
        if !protocol::is_path_inside(&canonical_root, &canonical_target) {
            return Ok(false);
        }
        let manifest_bytes = match tokio::fs::read(target.join(HANDOFF_MANIFEST_FILE)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        if sha256_bytes(&manifest_bytes) != expected_manifest_sha256 {
            return Ok(false);
        }
        let manifest: Value = match serde_json::from_slice(&manifest_bytes) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        if manifest.get("version").and_then(Value::as_u64) != Some(1)
            || manifest.get("taskDir").and_then(Value::as_str) != Some(handoff.relative_dir.as_str())
            || !handoff_manifest_files_match(
                &target,
                &manifest,
                handoff.file_count,
                handoff.total_bytes,
            )
            .await?
        {
            return Ok(false);
        }
        let meta_bytes = match tokio::fs::read(target.join(HANDOFF_META_FILE)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        let meta: Value = match serde_json::from_slice(&meta_bytes) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        Ok(
            meta.get("version").and_then(Value::as_u64) == Some(1)
                && meta.get("backupId").and_then(Value::as_str) == Some(backup_id)
                && meta.get("taskSpaceId").and_then(Value::as_str)
                    == Some(binding.task_space_id.as_str())
                && meta.get("executionTaskKey").and_then(Value::as_str)
                    == Some(handoff.execution_task_key.as_str())
                && meta.get("taskId").and_then(Value::as_str) == Some(handoff.task_id.as_str())
                && meta.get("taskDir").and_then(Value::as_str)
                    == Some(handoff.relative_dir.as_str())
                && meta.get("manifestSha256").and_then(Value::as_str)
                    == Some(expected_manifest_sha256)
                && meta.get("fileCount").and_then(Value::as_u64) == Some(handoff.file_count)
                && meta.get("totalBytes").and_then(Value::as_u64) == Some(handoff.total_bytes),
        )
    }

    async fn write_handoff_backup_metadata(
        &self,
        binding: &AgentBinding,
        target: &Path,
        handoff: &StoredTaskHandoff,
        control: &TaskControl,
        source: &HandoffSource,
    ) -> AgentResult<()> {
        let manifest_bytes = serde_json::to_vec(&source.manifest).map_err(|error| {
            AgentError::new(
                code::INVALID_RESPONSE,
                format!("handoff manifest 序列化失败: {error}"),
            )
        })?;
        if sha256_bytes(&manifest_bytes) != source.manifest_sha256 {
            return protocol::err(code::INVALID_RESPONSE, "handoff manifest 摘要不稳定");
        }
        self.store
            .write_atomic(&target.join(HANDOFF_MANIFEST_FILE), &manifest_bytes)
            .await?;
        let meta = json!({
            "version": 1,
            "backupId": source.backup_id,
            "taskSpaceId": binding.task_space_id,
            "executionTaskKey": handoff.execution_task_key,
            "taskId": handoff.task_id,
            "taskDir": handoff.relative_dir,
            "materializedRevision": control.materialized_revision,
            "manifestSha256": source.manifest_sha256,
            "fileCount": source.file_count,
            "totalBytes": source.total_bytes,
            "createdAt": protocol::now_iso8601(),
        });
        let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|error| {
            AgentError::new(
                code::INVALID_RESPONSE,
                format!("handoff 元数据序列化失败: {error}"),
            )
        })?;
        self.store
            .write_atomic(&target.join(HANDOFF_META_FILE), &meta_bytes)
            .await?;
        let mut expected = handoff.clone();
        expected.backup_id = Some(source.backup_id.clone());
        expected.manifest_sha256 = Some(source.manifest_sha256.clone());
        expected.file_count = source.file_count;
        expected.total_bytes = source.total_bytes;
        if !self.handoff_backup_is_valid(binding, &expected).await? {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份内容校验失败");
        }
        Ok(())
    }

    async fn ensure_handoff_backup(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
        control: &TaskControl,
        source: &HandoffSource,
    ) -> AgentResult<bool> {
        let mut expected = handoff.clone();
        expected.backup_id = Some(source.backup_id.clone());
        expected.manifest_sha256 = Some(source.manifest_sha256.clone());
        expected.file_count = source.file_count;
        expected.total_bytes = source.total_bytes;
        if self.handoff_backup_is_valid(binding, &expected).await? {
            return Ok(true);
        }
        let target = self
            .handoff_backup_target(binding, &source.backup_id)
            .await?;
        let mut created_target = false;
        match tokio::fs::symlink_metadata(&target).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                cleanup_handoff_backup_temps(&target).await?;
                if !handoff_manifest_files_match(
                    &target,
                    &source.manifest,
                    source.file_count,
                    source.total_bytes,
                )
                .await?
                {
                    return protocol::err(code::INVALID_RESPONSE, "已有 handoff 备份内容不一致");
                }
            }
            Ok(_) => {
                return protocol::err(code::INVALID_RESPONSE, "handoff 备份目标不是真实目录")
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let source_dir = resolve_task_directory(binding, &handoff.relative_dir).await?;
                copy_directory(&source_dir, &target).await?;
                created_target = true;
            }
            Err(error) => return Err(io_error(error)),
        }
        if let Err(error) = self
            .write_handoff_backup_metadata(binding, &target, handoff, control, source)
            .await
        {
            if created_target {
                if let Err(cleanup_error) = tokio::fs::remove_dir_all(&target).await {
                    crate::logging::warn(&format!(
                        "handoff 无效备份清理失败：{}",
                        protocol::safe_error_message(&cleanup_error.to_string())
                    ));
                }
            }
            return Err(error);
        }
        Ok(true)
    }

    async fn cleanup_handoff_trash(&self, binding: &AgentBinding) {
        let trash_root = Path::new(&binding.repo_path).join(".trellis");
        let Ok(mut entries) = tokio::fs::read_dir(&trash_root).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            if !name
                .to_string_lossy()
                .starts_with(".agent-handoff-cleanup-")
            {
                continue;
            }
            let Ok(metadata) = tokio::fs::symlink_metadata(entry.path()).await else {
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            if let Err(error) = tokio::fs::remove_dir_all(entry.path()).await {
                crate::logging::warn(&format!(
                    "handoff 遗留暂存目录清理失败：{}",
                    protocol::safe_error_message(&error.to_string())
                ));
            }
        }
    }

    async fn remove_handoff_source(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
        files: &[Value],
    ) -> AgentResult<()> {
        {
            let mut suppressed = self.suppressed.lock().await;
            for file in files {
                if let Some(path) = file.get("path").and_then(Value::as_str) {
                    suppressed.insert(absolute_task_path(binding, path), None);
                }
            }
        }
        let source = resolve_task_directory(binding, &handoff.relative_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return protocol::err(code::INVALID_RESPONSE, "handoff 任务源不是真实目录"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
        }
        let branch_matches = matches!(
            git_head_branch_name(Path::new(&binding.repo_path)).await,
            Some(Some(branch)) if branch == binding.branch_name
        );
        if !branch_matches {
            return protocol::err(code::INVALID_RESPONSE, "当前分支已变化，拒绝清理 handoff");
        }
        let trash = Path::new(&binding.repo_path)
            .join(".trellis")
            .join(format!(".agent-handoff-cleanup-{}", uuid::Uuid::new_v4()));
        match tokio::fs::rename(&source, &trash).await {
            Ok(()) => {
                match tokio::fs::symlink_metadata(&trash).await {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    _ => {
                        let _ = tokio::fs::rename(&trash, &source).await;
                        return protocol::err(code::INVALID_RESPONSE, "handoff 清理目标不是真实目录");
                    }
                }
                if let Err(error) = tokio::fs::remove_dir_all(&trash).await {
                    crate::logging::warn(&format!(
                        "handoff 暂存目录清理失败 {}：{}",
                        handoff.task_id,
                        protocol::safe_error_message(&error.to_string())
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let prefix = format!("{}/", handoff.relative_dir);
        let baselines = cursor
            .baselines
            .iter()
            .filter(|(path, _)| !path.starts_with(&prefix))
            .map(|(path, sha256)| (path.clone(), sha256.clone()))
            .collect();
        let deferred = cursor
            .deferred
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, files)| (task_dir.clone(), files.clone()))
            .collect();
        let ownership_pending = cursor
            .ownership_pending
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, reason)| (task_dir.clone(), reason.clone()))
            .collect();
        let pending_rejected = cursor
            .pending_rejected
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, item)| (task_dir.clone(), item.clone()))
            .collect();
        let conflict_blocked = cursor
            .conflict_blocked
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, conflict_id)| (task_dir.clone(), conflict_id.clone()))
            .collect();
        if let Err(error) = self
            .write_cursor(
                &binding.task_space_id,
                CursorPatch {
                    baselines: Some(baselines),
                    deferred: Some(deferred),
                    ownership_pending: Some(ownership_pending),
                    pending_rejected: Some(pending_rejected),
                    conflict_blocked: Some(conflict_blocked),
                    ..Default::default()
                },
            )
            .await
        {
            crate::logging::warn(&format!(
                "handoff 后清理本地 cursor 失败 {}：{}",
                handoff.task_id,
                protocol::safe_error_message(&error.message)
            ));
        }
        self.invalidate_ownership_projection(&binding.task_space_id)
            .await;
        Ok(())
    }

    async fn retry_pending_handoff_acks(&self, binding: &AgentBinding) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let pending = {
            let state = self.task_control_state.lock().await;
            state.pending_handoff_acks(&binding.local_id)
        };
        for (key, mut handoff) in pending {
            if handoff.lease_held_by_other_user {
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some("lease_active"),
                    handoff.backup_id.as_deref(),
                    handoff.manifest_sha256.as_deref(),
                    handoff.file_count,
                    handoff.total_bytes,
                )
                .await?;
                handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
                continue;
            }
            if handoff.outcome == "cleaned" {
                let backup_valid = match self.handoff_backup_is_valid(binding, &handoff).await {
                    Ok(valid) => valid,
                    Err(error) => {
                        crate::logging::warn(&format!(
                            "handoff 备份复核失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("unknown"),
                            handoff.backup_id.as_deref(),
                            handoff.manifest_sha256.as_deref(),
                            handoff.file_count,
                            handoff.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        if let Some(current) = self.stored_task_handoff(&key).await {
                            self.emit_handoff_notice(binding, &key, &current).await?;
                        }
                        continue;
                    }
                };
                if !backup_valid {
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("missing"),
                        handoff.backup_id.as_deref(),
                        handoff.manifest_sha256.as_deref(),
                        handoff.file_count,
                        handoff.total_bytes,
                    )
                    .await?;
                    handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                } else {
                    let exists =
                        match self
                            .handoff_task_directory_exists(binding, &handoff.relative_dir)
                            .await
                        {
                            Ok(exists) => exists,
                            Err(error) => {
                                crate::logging::warn(&format!(
                                    "handoff 本地目录复核失败 {}：{}",
                                    handoff.task_id,
                                    protocol::safe_error_message(&error.message)
                                ));
                                self.mark_handoff_ack_pending(
                                    &key,
                                    "conflict",
                                    Some("unknown"),
                                    handoff.backup_id.as_deref(),
                                    handoff.manifest_sha256.as_deref(),
                                    handoff.file_count,
                                    handoff.total_bytes,
                                )
                                .await?;
                                let _ = self.attempt_handoff_ack(&key).await?;
                                if let Some(current) = self.stored_task_handoff(&key).await {
                                    self.emit_handoff_notice(binding, &key, &current).await?;
                                }
                                continue;
                            }
                        };
                    if exists {
                        let branch_matches = matches!(
                            git_head_branch_name(Path::new(&binding.repo_path)).await,
                            Some(Some(branch)) if branch == binding.branch_name
                        );
                        let (reason, files) = if branch_matches {
                            match self.handoff_source_state(binding, &handoff).await {
                                Err(error) => {
                                    crate::logging::warn(&format!(
                                        "handoff 恢复清理状态检查失败 {}：{}",
                                        handoff.task_id,
                                        protocol::safe_error_message(&error.message)
                                    ));
                                    self.mark_handoff_ack_pending(
                                        &key,
                                        "conflict",
                                        Some("unknown"),
                                        handoff.backup_id.as_deref(),
                                        handoff.manifest_sha256.as_deref(),
                                        handoff.file_count,
                                        handoff.total_bytes,
                                    )
                                    .await?;
                                    let _ = self.attempt_handoff_ack(&key).await?;
                                    if let Some(current) = self.stored_task_handoff(&key).await {
                                        self.emit_handoff_notice(binding, &key, &current).await?;
                                    }
                                    continue;
                                }
                                Ok(HandoffSourceState::Ready(source))
                                    if handoff.manifest_sha256.as_deref()
                                        == Some(source.manifest_sha256.as_str()) =>
                                {
                                    (None, Some(source.files))
                                }
                                Ok(HandoffSourceState::Ready(_)) => {
                                    (Some("baseline_mismatch"), None)
                                }
                                Ok(HandoffSourceState::Conflict(reason)) => (Some(reason), None),
                            }
                        } else {
                            (Some("branch_mismatch"), None)
                        };
                        let cleanup_failed = if let Some(files) = files {
                            match self.remove_handoff_source(binding, &handoff, &files).await {
                                Ok(()) => false,
                                Err(error) => {
                                    crate::logging::warn(&format!(
                                        "handoff 恢复清理本地目录失败 {}：{}",
                                        handoff.task_id,
                                        protocol::safe_error_message(&error.message)
                                    ));
                                    true
                                }
                            }
                        } else {
                            false
                        };
                        let conflict_reason = if cleanup_failed {
                            Some("cleanup_failed")
                        } else {
                            reason
                        };
                        if let Some(reason) = conflict_reason {
                            self.mark_handoff_ack_pending(
                                &key,
                                "conflict",
                                Some(reason),
                                handoff.backup_id.as_deref(),
                                handoff.manifest_sha256.as_deref(),
                                handoff.file_count,
                                handoff.total_bytes,
                            )
                            .await?;
                        }
                        handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                    }
                }
            }
            let _ = self.attempt_handoff_ack(&key).await?;
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
        }
        Ok(())
    }

    async fn handoff_source_state(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<HandoffSourceState> {
        let source = resolve_task_directory(binding, &handoff.relative_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Ok(HandoffSourceState::Conflict("git_modified")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HandoffSourceState::Conflict("missing"))
            }
            Err(error) => return Err(io_error(error)),
        }
        let selected = HashSet::from([handoff.relative_dir.clone()]);
        let files = self.local_files(binding, Some(&selected)).await?;
        if files.is_empty() {
            return Ok(HandoffSourceState::Conflict("no_files"));
        }
        let task_json_path = format!("{}/task.json", handoff.relative_dir);
        let task_id_matches = files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some(task_json_path.as_str())
                && file
                    .get("content")
                    .and_then(Value::as_str)
                    .and_then(parse_task_id)
                    .as_deref()
                    == Some(handoff.task_id.as_str())
        });
        if !task_id_matches {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let directory_paths = task_directory_file_paths(&source).await?;
        let canonical_paths: BTreeSet<String> = files
            .iter()
            .filter_map(|file| file.get("path").and_then(Value::as_str))
            .filter_map(|path| {
                path.strip_prefix(&format!("{}/", handoff.relative_dir))
                    .map(str::to_string)
            })
            .collect();
        if directory_paths != canonical_paths {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let baseline: BTreeMap<String, String> = cursor
            .baselines
            .iter()
            .filter_map(|(path, sha256)| {
                path.strip_prefix(&format!("{}/", handoff.relative_dir))
                    .map(|relative| (relative.to_string(), sha256.clone()))
            })
            .collect();
        let local: BTreeMap<String, String> = files
            .iter()
            .filter_map(|file| {
                Some((
                    file.get("path")?
                        .as_str()?
                        .strip_prefix(&format!("{}/", handoff.relative_dir))?
                        .to_string(),
                    file.get("sha256")?.as_str()?.to_string(),
                ))
            })
            .collect();
        if baseline.is_empty() || baseline != local {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let branch_matches = matches!(
            git_head_branch_name(Path::new(&binding.repo_path)).await,
            Some(Some(branch)) if branch == binding.branch_name
        );
        if !branch_matches {
            return Ok(HandoffSourceState::Conflict("branch_mismatch"));
        }
        let git_entries = match crate::agent::git::status_paths(
            Path::new(&binding.repo_path),
            &self.binding_hooks_dir(binding),
            &[handoff.relative_dir.clone()],
        )
        .await
        {
            Ok(entries) => entries,
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff 前检查 Git 状态失败 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                return Ok(HandoffSourceState::Conflict("git_modified"));
            }
        };
        if git_entries.is_empty() {
            return Ok(HandoffSourceState::Conflict("git_tracked"));
        }
        if !git_entries_all_untracked(&git_entries) {
            return Ok(HandoffSourceState::Conflict("git_modified"));
        }
        let (manifest_sha256, file_count, total_bytes, manifest) =
            handoff_manifest(&files, &handoff.relative_dir)?;
        if file_count > HANDOFF_MAX_FILES || total_bytes > HANDOFF_MAX_BYTES {
            return Ok(HandoffSourceState::Conflict("backup_too_large"));
        }
        let backup_id = format!("handoff-{}", &manifest_sha256[..16]);
        Ok(HandoffSourceState::Ready(HandoffSource {
            files,
            backup_id,
            manifest_sha256,
            manifest,
            file_count,
            total_bytes,
        }))
    }

    async fn process_handoff_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<()> {
        let key = self
            .upsert_task_handoff_control(binding, control)
            .await?;
        let Some(handoff) = self.stored_task_handoff(&key).await else {
            return Ok(());
        };
        if handoff.lease_held_by_other_user && handoff.ack_state != "done" {
            self.mark_handoff_ack_pending(
                &key,
                "conflict",
                Some("lease_active"),
                handoff.backup_id.as_deref(),
                handoff.manifest_sha256.as_deref(),
                handoff.file_count,
                handoff.total_bytes,
            )
            .await?;
            let _ = self.attempt_handoff_ack(&key).await?;
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
            return Ok(());
        }
        if control.handoff_state == "source_cleanup_conflict" || !handoff.outcome.is_empty() {
            if handoff.ack_state == "pending" {
                let _ = self.attempt_handoff_ack(&key).await?;
            }
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
            return Ok(());
        }

        let source_state = match self.handoff_source_state(binding, &handoff).await {
            Ok(state) => state,
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff 本地状态检查失败 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some("unknown"),
                    None,
                    None,
                    0,
                    0,
                )
                .await?;
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
                return Ok(());
            }
        };
        match source_state {
            HandoffSourceState::Conflict(reason) => {
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some(reason),
                    None,
                    None,
                    0,
                    0,
                )
                .await?;
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
            }
            HandoffSourceState::Ready(source) => {
                let backed_up = self
                    .ensure_handoff_backup(binding, &handoff, control, &source)
                    .await;
                if !matches!(&backed_up, Ok(true)) {
                    if let Err(error) = backed_up {
                        crate::logging::warn(&format!(
                            "handoff 备份失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                    }
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("backup_failed"),
                        None,
                        None,
                        source.file_count,
                        source.total_bytes,
                    )
                    .await?;
                    let _ = self.attempt_handoff_ack(&key).await?;
                    return Ok(());
                }
                self.mark_handoff_ack_pending(
                    &key,
                    "cleaned",
                    None,
                    Some(&source.backup_id),
                    Some(&source.manifest_sha256),
                    source.file_count,
                    source.total_bytes,
                )
                .await?;
                let latest_state = match self.handoff_source_state(binding, &handoff).await {
                    Ok(state) => state,
                    Err(error) => {
                        crate::logging::warn(&format!(
                            "handoff 删除前复核失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("unknown"),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                };
                match latest_state {
                    HandoffSourceState::Ready(latest)
                        if latest.manifest_sha256.as_str() == source.manifest_sha256.as_str() => {}
                    HandoffSourceState::Ready(_) => {
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("baseline_mismatch"),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                    HandoffSourceState::Conflict(reason) => {
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some(reason),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                }
                if let Err(error) = self
                    .remove_handoff_source(binding, &handoff, &source.files)
                    .await
                {
                    crate::logging::warn(&format!(
                        "handoff 清理本地目录失败 {}：{}",
                        handoff.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("cleanup_failed"),
                        Some(&source.backup_id),
                        Some(&source.manifest_sha256),
                        source.file_count,
                        source.total_bytes,
                    )
                    .await?;
                    let _ = self.attempt_handoff_ack(&key).await?;
                    return Ok(());
                }
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
            }
        }
        Ok(())
    }

    async fn process_handoff_controls(
        &self,
        binding: &AgentBinding,
        controls: &[TaskControl],
    ) -> AgentResult<()> {
        self.cleanup_handoff_trash(binding).await;
        self.retry_pending_handoff_acks(binding).await?;
        for control in controls.iter().filter(|control| {
            control.state == "handoff_materialized"
                && matches!(
                    control.handoff_state.as_str(),
                    "source_cleanup_pending" | "source_cleanup_conflict"
                )
        }) {
            self.process_handoff_control(binding, control).await?;
        }
        Ok(())
    }

    async fn remote_task_control(
        &self,
        _binding: &AgentBinding,
        execution_task_key: &str,
    ) -> AgentResult<Option<TaskControl>> {
        let encoded = urlencode(execution_task_key);
        match self
            .api
            .request_json(
                Method::GET,
                &format!("/api/agent/tasks/{encoded}"),
                None,
                Duration::from_secs(60),
            )
            .await
        {
            Ok(response) => {
                let task = response.get("task").ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "任务控制响应缺少 task")
                })?;
                let control = TaskControl::from_task_value(task)?;
                self.update_control_task_version(
                    &control.execution_task_key,
                    control.task_version,
                )
                    .await?;
                Ok(Some(control))
            }
            Err(error)
                if error.status == Some(404)
                    || error.server_code.as_deref() == Some("NOT_FOUND") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    async fn prepare_controlled_server_groups(
        &self,
        binding: &AgentBinding,
        controls: Option<&[TaskControl]>,
        groups: &mut Vec<SnapshotGroup>,
    ) -> AgentResult<()> {
        let Some(controls) = controls else {
            return Ok(());
        };
        let selected = selected_server_task_ids(Some(controls)).unwrap_or_default();
        groups.retain(|group| {
            group
                .task_id
                .as_ref()
                .is_some_and(|task_id| selected.contains(task_id))
        });
        let mut allowed = Vec::with_capacity(groups.len());
        for group in groups.drain(..) {
            let Some(task_id) = group.task_id.as_deref() else {
                continue;
            };
            let Some(control) = controls.iter().find(|control| control.task_id == task_id) else {
                continue;
            };
            if !control.is_writable_local() {
                continue;
            }
            match self
                .claim_remote_task(binding, &control.execution_task_key)
                .await
            {
                Ok(_) => allowed.push(group),
                Err(error)
                    if matches!(
                        error.server_code.as_deref(),
                        Some("TASK_ARCHIVED")
                            | Some("TASK_WRITE_FORBIDDEN")
                            | Some("TASK_LEASE_HELD")
                            | Some("TASK_LEASE_INVALID")
                            | Some("FORBIDDEN")
                    ) =>
                {
                    crate::logging::warn(&format!(
                        "跳过不可落地任务 {}：{}",
                        control.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        *groups = allowed;
        Ok(())
    }

    async fn release_inactive_task_leases(
        &self,
        controls: Option<&[TaskControl]>,
    ) {
        let Some(controls) = controls else {
            return;
        };
        for control in controls
            .iter()
            .filter(|control| !control.is_writable_local())
        {
            crate::logging::warn(&format!(
                "任务进入 {:?} 控制状态，本地数据保留并停止写回：{}",
                control.control_state(),
                control.relative_dir
            ));
            let Some(lease) = self
                .stored_task_lease(&control.execution_task_key)
                .await
            else {
                continue;
            };
            match self
                .release_remote_task(&control.execution_task_key, &lease.token)
                .await
            {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.server_code.as_deref(),
                        Some("TASK_LEASE_INVALID")
                            | Some("TASK_LEASE_REQUIRED")
                            | Some("NOT_FOUND")
                    ) => {}
                Err(error) => {
                    crate::logging::warn(&format!(
                        "释放失效任务租约失败 {}：{}",
                        control.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                }
            }
            if let Err(error) = self
                .remove_task_lease(&control.execution_task_key)
                .await
            {
                crate::logging::warn(&format!(
                    "删除本地失效任务租约失败 {}：{}",
                    control.task_id,
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }

    async fn persisted_control_key_for_upload(
        &self,
        binding: &AgentBinding,
        files: &[Value],
    ) -> AgentResult<Option<String>> {
        let task_dirs: BTreeSet<String> = files
            .iter()
            .filter_map(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .and_then(active_task_directory_from_relative)
            })
            .collect();
        if task_dirs.is_empty() {
            return Ok(None);
        }
        self.ensure_task_control_loaded().await;
        let state = self.task_control_state.lock().await;
        let execution_task_keys: BTreeSet<String> = task_dirs
            .iter()
            .filter_map(|task_dir| {
                state
                    .execution_task_key_for_dir(
                        &binding.local_id,
                        &binding.task_space_id,
                        task_dir,
                    )
                    .cloned()
            })
            .collect();
        if execution_task_keys.len() > 1 {
            return protocol::err(
                code::INVALID_RESPONSE,
                "单个上传批次匹配到多个持久化任务控制",
            );
        }
        Ok(execution_task_keys.into_iter().next())
    }

    async fn persist_ownership_index(&self) -> AgentResult<()> {
        if !self
            .ownership_index_writer
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        let index = self.ownership_index.lock().await.clone();
        if index.bindings.len() > OWNERSHIP_INDEX_MAX_BINDINGS
            || index
                .bindings
                .values()
                .any(|binding| {
                    binding.tasks.len() > OWNERSHIP_INDEX_MAX_TASKS
                        || binding.files.len() > OWNERSHIP_INDEX_MAX_FILES
                        || binding.dirty_task_dirs.len() > OWNERSHIP_INDEX_MAX_TASKS
                        || binding.local_dirs.len() > OWNERSHIP_INDEX_MAX_TASKS
                        || binding.tracked_paths.len() > OWNERSHIP_INDEX_MAX_TRACKED_PATHS
                })
        {
            return protocol::err(code::CONFIG_INVALID, "ownership 索引超过条目上限");
        }
        let mut bytes = serde_json::to_vec_pretty(&index).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("ownership 索引序列化失败: {error}"),
            )
        })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > OWNERSHIP_INDEX_MAX_BYTES {
            return protocol::err(code::CONFIG_INVALID, "ownership 索引超过大小上限");
        }
        self.store
            .write_atomic(&self.store.paths.ownership_index_file, &bytes)
            .await
    }

    async fn retain_ownership_index_bindings(&self, active_local_ids: &HashSet<String>) {
        let _refresh = self.ownership_refresh_lock.lock().await;
        self.ensure_ownership_index_loaded().await;
        let changed = {
            let mut index = self.ownership_index.lock().await;
            let before = index.bindings.len();
            index
                .bindings
                .retain(|local_id, _| active_local_ids.contains(local_id));
            before != index.bindings.len()
        };
        if changed {
            if let Err(error) = self.persist_ownership_index().await {
                crate::logging::warn(&format!(
                    "清理 ownership 索引失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }

    async fn discard_ownership_index_binding(&self, local_id: &str) {
        let _refresh = self.ownership_refresh_lock.lock().await;
        self.ensure_ownership_index_loaded().await;
        let removed = self
            .ownership_index
            .lock()
            .await
            .bindings
            .remove(local_id)
            .is_some();
        if removed {
            if let Err(error) = self.persist_ownership_index().await {
                crate::logging::warn(&format!(
                    "删除无效 ownership 索引失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }

    fn notify_state_changed(&self) {
        if let Some(sink) = &self.state_sink {
            sink();
        }
    }

    pub(crate) fn notify_bindings_changed(&self) {
        self.notify_state_changed();
    }

    pub async fn set_bindings(&self, bindings: Vec<AgentBinding>) {
        let next = approved_bindings(bindings);
        let active_ids: HashSet<String> = next.keys().cloned().collect();
        let changed = {
            let mut current = self.bindings.lock().await;
            let changed = !association_map_unchanged(&current, &next);
            *current = next;
            changed
        };
        if changed {
            self.notify_state_changed();
            self.wake_heartbeat();
        }
        self.ownership_projection_epoch.fetch_add(
            1,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.head_tree_cache.lock().await.clear();
        self.ownership_projection_cache.lock().await.clear();
        self.baseline_owned.lock().await.clear();
        self.binding_sync_locks
            .lock()
            .await
            .retain(|task_space_id, _| active_ids.contains(task_space_id));
    }

    pub async fn update_bindings(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
        let task_space_ids = self.prepare_bindings(bindings).await;
        self.sync_task_spaces(task_space_ids).await;
    }

    pub(crate) async fn prepare_startup_bindings(
        self: &Arc<Self>,
        bindings: Vec<AgentBinding>,
    ) -> Vec<String> {
        self.prepare_bindings(bindings).await
    }

    pub(crate) async fn sync_task_spaces(self: &Arc<Self>, task_space_ids: Vec<String>) {
        if task_space_ids.is_empty() {
            return;
        }
        let trace = std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some();
        let mut jobs = tokio::task::JoinSet::new();
        for task_space_id in task_space_ids {
            let this = self.clone();
            jobs.spawn(async move {
                let started = Instant::now();
                if !this.bindings.lock().await.contains_key(&task_space_id) {
                    this.finish_binding_sync(&task_space_id).await;
                    return;
                }
                let serial = this.task_space_sync_lock(&task_space_id).await;
                let _serial = serial.lock().await;
                if this.pull_and_report(&task_space_id).await {
                    this.invalidate_ownership_projection(&task_space_id).await;
                    this.validate_ownership_binding(&task_space_id).await;
                }
                this.finish_binding_sync(&task_space_id).await;
                if trace {
                    crate::logging::warn(&format!(
                        "启动同步完成 taskSpaceId={} elapsedMs={}",
                        task_space_id,
                        started.elapsed().as_millis()
                    ));
                }
                sync_trace(
                    &task_space_id,
                    "startup-total",
                    started,
                    json!({ "trigger": "startup" }),
                );
            });
        }
        while let Some(result) = jobs.join_next().await {
            if let Err(error) = result {
                crate::logging::warn(&format!("任务空间同步任务异常退出：{error}"));
            }
        }
    }

    pub(crate) async fn wait_for_binding_sync(&self) {
        loop {
            let notified = self.binding_sync_idle.notified();
            tokio::pin!(notified);
            let _ = notified.as_mut().enable();
            if self.syncing_task_spaces.lock().await.is_empty() {
                return;
            }
            notified.await;
        }
    }

    async fn finish_binding_sync(self: &Arc<Self>, task_space_id: &str) {
        {
            let mut syncing = self.syncing_task_spaces.lock().await;
            let Some(count) = syncing.get_mut(task_space_id) else {
                self.deferred_uploads.lock().await.remove(task_space_id);
                drop(syncing);
                self.binding_sync_idle.notify_waiters();
                self.wake_heartbeat();
                return;
            };
            if *count > 1 {
                *count -= 1;
                return;
            }
        }

        let mut had_deferred_event = false;
        loop {
            let binding = self.bindings.lock().await.get(task_space_id).cloned();
            let step = {
                let mut syncing = self.syncing_task_spaces.lock().await;
                if !syncing.contains_key(task_space_id) {
                    self.deferred_uploads.lock().await.remove(task_space_id);
                    break;
                }
                let mut deferred = self.deferred_uploads.lock().await;
                if let Some(paths) = deferred.get_mut(task_space_id) {
                    had_deferred_event = true;
                    let paths = std::mem::take(paths);
                    deferred.remove(task_space_id);
                    Some((paths, false))
                } else if had_deferred_event {
                    had_deferred_event = false;
                    Some((HashSet::new(), true))
                } else {
                    let count = syncing.get(task_space_id).copied().unwrap_or_default();
                    if count <= 1 {
                        syncing.remove(task_space_id);
                    } else if let Some(count) = syncing.get_mut(task_space_id) {
                        *count -= 1;
                    }
                    break;
                }
            };
            let Some((paths, validate_after_deferred)) = step else {
                break;
            };
            if validate_after_deferred {
                self.invalidate_ownership_projection(task_space_id).await;
                self.validate_ownership_binding(task_space_id).await;
                continue;
            }
            if binding
                .as_ref()
                .is_some_and(|binding| !binding.read_only && binding.initial_sync_completed)
            {
                let mut paths: Vec<String> = paths.into_iter().collect();
                paths.sort();
                if let Err(error) = self.upload_dirty(task_space_id, &paths).await {
                    self.report_error(task_space_id, &error).await;
                }
            }
        }
        self.binding_sync_idle.notify_waiters();
        self.wake_heartbeat();
    }

    async fn prepare_bindings(self: &Arc<Self>, bindings: Vec<AgentBinding>) -> Vec<String> {
        let _selection = self.binding_selection_lock.lock().await;
        let _lifecycle = self.cursor_write.lock().await;
        let active_local_ids: Option<HashSet<String>> = match self.store.read_config(false).await {
            Ok(Some(config)) => Some(
                config
                    .bindings
                    .iter()
                    .filter(|binding| binding.sync_status == "approved" && !binding.detach_pending)
                    .map(|binding| binding.local_id.clone())
                    .collect(),
            ),
            _ => None,
        };
        if let Some(active_local_ids) = &active_local_ids {
            self.retain_ownership_index_bindings(active_local_ids).await;
        }
        let filtered = bindings
            .into_iter()
            .filter(|binding| {
                active_local_ids
                    .as_ref()
                    .is_some_and(|ids| ids.contains(&binding.local_id))
            })
            .collect::<Vec<_>>();
        let candidate = approved_bindings(filtered.clone());
        let mut branch_state_matches = true;
        for binding in candidate.values() {
            if !matches!(
                git_head_branch_name(Path::new(&binding.repo_path)).await,
                Some(Some(branch)) if branch == binding.branch_name
            ) {
                branch_state_matches = false;
                break;
            }
        }
        let (unchanged, state_changed) = {
            let mut current = self.bindings.lock().await;
            let unchanged = binding_selection_unchanged(&current, &candidate);
            let state_changed = !association_map_unchanged(&current, &candidate);
            if unchanged && branch_state_matches {
                *current = candidate;
            }
            (unchanged && branch_state_matches, state_changed)
        };
        if state_changed {
            self.notify_state_changed();
        }
        if unchanged {
            return Vec::new();
        }
        drop(_lifecycle);

        let selected = self.select_bindings(filtered).await;
        let (unchanged, state_changed, pull_task_space_ids) = {
            let map = approved_bindings(selected.clone());
            let mut current = self.bindings.lock().await;
            let unchanged = binding_selection_unchanged(&current, &map);
            let state_changed = !association_map_unchanged(&current, &map);
            let mut pull_task_space_ids = Vec::new();
            for (task_space_id, binding) in &map {
                let should_pull = current
                    .get(task_space_id)
                    .map(|existing| !binding_entry_unchanged(existing, binding))
                    .unwrap_or(true);
                if should_pull {
                    pull_task_space_ids.push(task_space_id.clone());
                }
            }
            pull_task_space_ids.sort();
            *current = map.clone();
            (unchanged, state_changed, pull_task_space_ids)
        };
        if state_changed {
            self.notify_state_changed();
        }
        if unchanged {
            return Vec::new();
        }
        self.ownership_projection_epoch.fetch_add(
            1,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.head_tree_cache.lock().await.clear();
        self.ownership_projection_cache.lock().await.clear();
        self.baseline_owned.lock().await.clear();
        let selected_task_space_ids: HashSet<String> = selected
            .iter()
            .map(|binding| binding.task_space_id.clone())
            .collect();
        self.binding_sync_locks
            .lock()
            .await
            .retain(|task_space_id, _| selected_task_space_ids.contains(task_space_id));
        {
            let mut syncing = self.syncing_task_spaces.lock().await;
            syncing.retain(|task_space_id, _| selected_task_space_ids.contains(task_space_id));
            for task_space_id in &pull_task_space_ids {
                *syncing.entry(task_space_id.clone()).or_default() += 1;
            }
            self.deferred_uploads
                .lock()
                .await
                .retain(|task_space_id, _| selected_task_space_ids.contains(task_space_id));
        }
        self.binding_sync_idle.notify_waiters();
        self.rebuild_watchers(selected).await;
        pull_task_space_ids
    }

    /// 同一本地仓库多绑定时按真实分支挑唯一可用的绑定（对照 JS `_selectBindingsForRepositories`）。
    async fn select_bindings(&self, bindings: Vec<AgentBinding>) -> Vec<AgentBinding> {
        let mut groups: BTreeMap<String, Vec<AgentBinding>> = BTreeMap::new();
        for binding in bindings.into_iter().filter(|binding| {
            binding.sync_status == "approved"
                && !binding.detach_pending
                && !binding.task_space_id.is_empty()
        }) {
            groups
                .entry(binding.local_repo_key.clone())
                .or_default()
                .push(binding);
        }
        let mut selected = Vec::new();
        for items in groups.into_values() {
            if items.len() == 1 {
                let binding = items.into_iter().next().expect("single binding");
                if matches!(
                    git_head_branch_name(Path::new(&binding.repo_path)).await,
                    Some(Some(branch)) if branch == binding.branch_name
                ) {
                    if binding
                        .last_error_code
                        .as_deref()
                        .is_some_and(is_branch_guard_code)
                    {
                        self.clear_branch_guard_error(&binding).await;
                    }
                    selected.push(binding);
                } else {
                    match self.assert_binding_branch(&binding).await {
                        Ok(_) => selected.push(binding),
                        Err(error) => self.report_binding_error(&binding, &error),
                    }
                }
                continue;
            }
            let mut matches = Vec::new();
            for binding in &items {
                if matches!(
                    git_head_branch_name(Path::new(&binding.repo_path)).await,
                    Some(Some(branch)) if branch == binding.branch_name
                ) {
                    if binding
                        .last_error_code
                        .as_deref()
                        .is_some_and(is_branch_guard_code)
                    {
                        self.clear_branch_guard_error(binding).await;
                    }
                    matches.push(binding.clone());
                } else {
                    match self.assert_binding_branch(binding).await {
                        Ok(_) => matches.push(binding.clone()),
                        Err(error) => {
                            self.report_binding_error(binding, &error);
                        }
                    }
                }
            }
            if matches.len() == 1 {
                selected.extend(matches);
                continue;
            }
            if matches.is_empty() {
                continue;
            }
            let error = AgentError::new(
                code::CONFIG_INVALID,
                "同一本地仓库存在多个任务空间绑定，已暂停该仓库同步",
            );
            for binding in &items {
                self.persist_binding_sync_error(binding, &error).await;
            }
            if let Some(binding) = items.first() {
                (self.emit)(task_sync_error_event(
                    Some(binding),
                    &binding.task_space_id,
                    &error,
                    error.message.clone(),
                ));
            }
        }
        selected
    }

    fn report_binding_error(&self, binding: &AgentBinding, error: &AgentError) {
        (self.emit)(task_sync_error_event(
            Some(binding),
            &binding.task_space_id,
            error,
            protocol::safe_error_message(&error.message),
        ));
    }

    /// 校验仓库当前分支与绑定分支一致；失败时把错误写入绑定状态并保留。
    async fn assert_binding_branch(&self, binding: &AgentBinding) -> AgentResult<String> {
        #[cfg(test)]
        self.branch_validations
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.assert_binding_active(binding).await?;
        let hooks_dir = self.binding_hooks_dir(binding);
        match crate::agent::git::assert_repository_branch(
            Path::new(&binding.repo_path),
            &hooks_dir,
            &binding.branch_name,
        )
        .await
        {
            Ok(branch) => {
                self.clear_branch_guard_error(binding).await;
                Ok(branch)
            }
            Err(error) => {
                if is_branch_guard_error(&error) {
                    self.persist_binding_sync_error(binding, &error).await;
                }
                Err(error)
            }
        }
    }

    async fn binding_head(&self, binding: &AgentBinding) -> AgentResult<(String, String)> {
        let branch = self.assert_binding_branch(binding).await?;
        let hooks_dir = self.binding_hooks_dir(binding);
        let head = crate::agent::git::head_commit(Path::new(&binding.repo_path), &hooks_dir, false)
            .await?
            .ok_or_else(|| AgentError::new(code::DETACHED_HEAD, "本地仓库没有可用 HEAD"))?;
        Ok((branch, head))
    }

    async fn head_tree_paths(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<(String, Arc<HashSet<String>>)> {
        let (branch, head) = self.binding_head(binding).await?;
        let tracked_paths = self
            .head_tree_paths_for_commit(binding, &branch, &head)
            .await?;
        Ok((head, tracked_paths))
    }

    async fn head_tree_paths_for_commit(
        &self,
        binding: &AgentBinding,
        branch: &str,
        head: &str,
    ) -> AgentResult<Arc<HashSet<String>>> {
        let hooks_dir = self.binding_hooks_dir(binding);
        let repo = Path::new(&binding.repo_path);
        {
            let mut cache = self.head_tree_cache.lock().await;
            if let Some(entry) = cache.get_mut(&binding.task_space_id) {
                if entry.branch_name == branch && entry.head_commit == head {
                    entry.validated_at = Instant::now();
                    return Ok(entry.tracked_paths.clone());
                }
            }
        }
        #[cfg(test)]
        self.head_tree_scans
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let paths = crate::agent::git::ls_tree(repo, &hooks_dir, Some(&head)).await?;
        let tracked_paths = Arc::new(paths.into_iter().collect::<HashSet<_>>());
        self.head_tree_cache.lock().await.insert(
            binding.task_space_id.clone(),
            HeadTreeCache {
                branch_name: branch.to_string(),
                head_commit: head.to_string(),
                tracked_paths: tracked_paths.clone(),
                validated_at: Instant::now(),
            },
        );
        Ok(tracked_paths)
    }

    #[cfg(test)]
    async fn projected_head_tree_paths(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<(String, Arc<HashSet<String>>)> {
        {
            let cache = self.head_tree_cache.lock().await;
            if let Some(entry) = cache.get(&binding.task_space_id) {
                if entry.branch_name == binding.branch_name
                    && entry.validated_at.elapsed() < OWNERSHIP_PROJECTION_CACHE_TTL
                {
                    return Ok((entry.head_commit.clone(), entry.tracked_paths.clone()));
                }
            }
        }
        self.head_tree_paths(binding).await
    }

    async fn invalidate_ownership_projection(&self, task_space_id: &str) {
        let mut cache = self.ownership_projection_cache.lock().await;
        let mut epochs = self.ownership_projection_local_epoch.lock().await;
        *epochs.entry(task_space_id.to_string()).or_default() += 1;
        cache.remove(task_space_id);
    }

    async fn projection_epoch(&self, task_space_id: &str) -> ProjectionEpoch {
        ProjectionEpoch {
            global: self
                .ownership_projection_epoch
                .load(std::sync::atomic::Ordering::SeqCst),
            local: self
                .ownership_projection_local_epoch
                .lock()
                .await
                .get(task_space_id)
                .copied()
                .unwrap_or_default(),
        }
    }

    async fn projection_epoch_matches(
        &self,
        task_space_id: &str,
        projection_epoch: ProjectionEpoch,
    ) -> bool {
        self.ownership_projection_epoch
            .load(std::sync::atomic::Ordering::SeqCst)
            == projection_epoch.global
            && self
                .ownership_projection_local_epoch
                .lock()
                .await
                .get(task_space_id)
                .copied()
                .unwrap_or_default()
                == projection_epoch.local
    }

    async fn cache_ownership_projection(
        &self,
        task_space_id: String,
        projection_epoch: ProjectionEpoch,
        entry: OwnershipProjectionCache,
    ) {
        let mut cache = self.ownership_projection_cache.lock().await;
        if self
            .projection_epoch_matches(&task_space_id, projection_epoch)
            .await
        {
            cache.insert(task_space_id, entry);
        }
    }

    async fn task_worktree_dirty_dirs(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<Option<HashSet<String>>> {
        let paths = [
            ".trellis/tasks".to_string(),
            ":(exclude).trellis/tasks/archive".to_string(),
        ];
        let entries = match crate::agent::git::status_paths(
            Path::new(&binding.repo_path),
            &self.binding_hooks_dir(binding),
            &paths,
        )
        .await
        {
            Ok(entries) => entries,
            Err(error) => {
                crate::logging::warn(&format!(
                    "读取任务工作区状态失败，回退全量扫描：{}",
                    protocol::safe_error_message(&error.message)
                ));
                return Ok(None);
            }
        };
        let mut dirty = HashSet::new();
        for entry in entries {
            for path in std::iter::once(&entry.path).chain(entry.original_path.as_ref()) {
                if is_archive_snapshot_path(path) {
                    continue;
                }
                let Some(task_dir) = active_task_directory_from_relative(path) else {
                    return Ok(None);
                };
                dirty.insert(task_dir);
            }
        }
        Ok(Some(dirty))
    }

    async fn task_head_changed_dirs(
        &self,
        binding: &AgentBinding,
        previous_head: &str,
        current_head: &str,
    ) -> Option<HashSet<String>> {
        if previous_head.is_empty() || current_head.is_empty() || previous_head == current_head {
            return Some(HashSet::new());
        }
        match crate::agent::git::diff_tree(
            Path::new(&binding.repo_path),
            &self.binding_hooks_dir(binding),
            previous_head,
            current_head,
        )
        .await
        {
            Ok(paths) => {
                let mut dirty = HashSet::new();
                for path in paths {
                    if is_archive_snapshot_path(&path) {
                        continue;
                    }
                    let Ok(parts) = task_directory_from_path(&path) else {
                        return None;
                    };
                    if parts.archived {
                        continue;
                    }
                    dirty.insert(parts.task_dir);
                }
                Some(dirty)
            }
            Err(error) => {
                crate::logging::warn(&format!(
                    "读取任务 HEAD 差量失败，回退全量扫描：{}",
                    protocol::safe_error_message(&error.message)
                ));
                None
            }
        }
    }

    async fn scan_ownership_index_files(
        &self,
        repo_path: &Path,
        previous_tasks: &BTreeMap<String, OwnershipTaskIndex>,
        previous_files: &BTreeMap<String, OwnershipFileIndex>,
        scan_task_dirs: Option<&HashSet<String>>,
        hash_all_files: bool,
    ) -> AgentResult<(
        BTreeMap<String, OwnershipTaskIndex>,
        BTreeMap<String, OwnershipFileIndex>,
        Vec<String>,
        usize,
        usize,
    )> {
        let trellis_root = repo_path.join(".trellis");
        let tasks_root = trellis_root.join("tasks");
        for (path, label) in [(&trellis_root, ".trellis"), (&tasks_root, ".trellis/tasks")] {
            match tokio::fs::symlink_metadata(path).await {
                Ok(metadata)
                    if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return protocol::err(
                        code::MISSING_TRELLIS,
                        format!("{label} 必须是真实目录"),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok((
                        BTreeMap::new(),
                        BTreeMap::new(),
                        Vec::new(),
                        0,
                        0,
                    ))
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        let mut tasks = BTreeMap::new();
        let mut files = BTreeMap::new();
        let mut local_dirs = HashSet::new();
        let mut parsed = 0;
        let mut hashed = 0;
        let mut stack: Vec<PathBuf> = match scan_task_dirs {
            Some(task_dirs) => task_dirs
                .iter()
                .filter(|task_dir| !is_archive_task_dir(task_dir))
                .filter_map(|task_dir| {
                    protocol::resolve_task_dir_under(Path::new(".trellis/tasks"), task_dir)
                        .map(|path| repo_path.join(path))
                })
                .collect(),
            None => vec![tasks_root],
        };
        while let Some(directory) = stack.pop() {
            match tokio::fs::symlink_metadata(&directory).await {
                Ok(metadata)
                    if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Err(error)
                    if scan_task_dirs.is_some()
                        && error.kind() == std::io::ErrorKind::NotFound =>
                {
                    continue
                }
                Ok(_) => {
                    return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接")
                }
                Err(error) => return Err(io_error(error)),
            }
            let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
            while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
                let path = entry.path();
                let relative = path
                    .strip_prefix(repo_path)
                    .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if is_archive_snapshot_path(&relative) {
                    continue;
                }
                let metadata = tokio::fs::symlink_metadata(&path).await.map_err(io_error)?;
                if metadata.file_type().is_symlink() {
                    return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接");
                }
                if metadata.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !metadata.is_file() {
                    continue;
                }
                #[cfg(test)]
                self.task_entries_examined
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !SNAPSHOT_EXTENSIONS.iter().any(|ext| name.ends_with(ext)) {
                    continue;
                }
                let Ok(parts) = task_directory_from_path(&relative) else {
                    continue;
                };
                if parts.archived {
                    continue;
                }
                local_dirs.insert(parts.task_dir.clone());
                if !hash_all_files && parts.file_path != "task.json" {
                    continue;
                }
                let modified_ns = metadata
                    .modified()
                    .ok()
                    .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|value| u64::try_from(value.as_nanos()).ok());
                let reusable_file = previous_files.get(&relative).filter(|cached| {
                    cached.size == metadata.len()
                        && cached.modified_ns.is_some()
                        && cached.modified_ns == modified_ns
                });
                let task_metadata_cached =
                    parts.file_path != "task.json" || previous_tasks.contains_key(&parts.task_dir);
                if let Some(cached) = reusable_file.filter(|_| task_metadata_cached) {
                    files.insert(relative.clone(), cached.clone());
                    if parts.file_path == "task.json" {
                        let task = previous_tasks
                            .get(&parts.task_dir)
                            .ok_or_else(|| {
                                AgentError::new(
                                    code::INVALID_RESPONSE,
                                    "ownership 文件缓存缺少 task.json 元数据",
                                )
                            })?;
                        tasks.insert(parts.task_dir.clone(), task.clone());
                    }
                    continue;
                }
                if metadata.len() > TASK_SNAPSHOT_MAX_FILE_BYTES as u64 {
                    return protocol::err(code::INVALID_RESPONSE, "单个任务文件超过 1 MiB");
                }
                #[cfg(test)]
                self.task_file_reads
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                #[cfg(test)]
                if parts.file_path == "task.json" {
                    self.task_json_reads
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                hashed += 1;
                let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本")
                })?;
                let content = normalize_snapshot_text(&text);
                let sha256 = snapshot_sha256(&content);
                files.insert(
                    relative,
                    OwnershipFileIndex {
                        size: metadata.len(),
                        modified_ns,
                        sha256: sha256.clone(),
                    },
                );
                if parts.file_path == "task.json" {
                    let (task_id, branch) = parse_task_metadata(&content);
                    parsed += 1;
                    tasks.insert(
                        parts.task_dir,
                        OwnershipTaskIndex {
                            task_json_size: metadata.len(),
                            task_json_modified_ns: modified_ns,
                            task_json_sha256: sha256,
                            task_id,
                            branch,
                        },
                    );
                }
                if tasks.len() > OWNERSHIP_INDEX_MAX_TASKS {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务数量超过索引上限");
                }
                if files.len() > OWNERSHIP_INDEX_MAX_FILES {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务文件数量超过索引上限");
                }
            }
        }
        let mut local_dirs: Vec<String> = local_dirs.into_iter().collect();
        if local_dirs.len() > OWNERSHIP_INDEX_MAX_TASKS {
            return protocol::err(code::INVALID_RESPONSE, "本地任务目录数量超过索引上限");
        }
        local_dirs.sort();
        Ok((tasks, files, local_dirs, hashed, parsed))
    }

    async fn refresh_ownership_index_binding(
        &self,
        binding: &AgentBinding,
        projection_epoch: ProjectionEpoch,
    ) -> AgentResult<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
        self.refresh_ownership_index_binding_with_scan(binding, projection_epoch, false)
            .await
    }

    async fn refresh_ownership_index_binding_with_scan(
        &self,
        binding: &AgentBinding,
        projection_epoch: ProjectionEpoch,
        force_file_scan: bool,
    ) -> AgentResult<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
        let started = Instant::now();
        let _refresh = self.ownership_refresh_lock.lock().await;
        self.ensure_ownership_index_loaded().await;
        self.assert_binding_active(binding).await?;
        let previous = self
            .ownership_index
            .lock()
            .await
            .bindings
            .get(&binding.local_id)
            .filter(|entry| {
                entry.task_space_id == binding.task_space_id
                    && entry.repo_path == binding.repo_path
                    && entry.branch_name == binding.branch_name
                    && entry.baseline_branch == binding.baseline_branch
            })
            .cloned();
        let current_head_fingerprint = git_head_fingerprint(Path::new(&binding.repo_path)).await;
        let current_git_index_fingerprint =
            git_index_fingerprint(Path::new(&binding.repo_path)).await;
        let already_cached = {
            let cache = self.ownership_projection_cache.lock().await;
            cache
                .get(&binding.task_space_id)
                .filter(|entry| ownership_projection_cache_matches(entry, binding))
                .filter(|entry| current_head_fingerprint.as_ref() == Some(&entry.head_fingerprint))
                .map(|entry| (entry.paused.clone(), entry.local_dirs.clone()))
        };
        let files_complete = previous.as_ref().is_some_and(|entry| entry.files_complete);
        if !force_file_scan {
            if let Some((paused, local_dirs)) = already_cached {
                if self
                    .projection_epoch_matches(&binding.task_space_id, projection_epoch)
                    .await
                {
                    return Ok((paused, local_dirs));
                }
            }
        }
        let head_cache_matches = previous.as_ref().is_some_and(|entry| {
            !entry.head_commit.is_empty()
                && !entry.head_fingerprint.is_empty()
                && current_head_fingerprint.as_ref() == Some(&entry.head_fingerprint)
        });
        let previous_head_commit = previous
            .as_ref()
            .filter(|entry| entry.files_complete && !entry.head_commit.is_empty())
            .map(|entry| entry.head_commit.clone());
        let (head_commit, head_changed_dirs, previous_tracked_paths, previous_tracked_loaded) = if head_cache_matches {
            let entry = previous
                .as_ref()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "ownership 索引状态无效"))?;
            (
                entry.head_commit.clone(),
                Some(HashSet::new()),
                entry.tracked_paths.iter().cloned().collect::<HashSet<_>>(),
                entry.tracked_paths_loaded,
            )
        } else {
            let (_, head_commit) = self.binding_head(binding).await?;
            let head_changed_dirs = match previous_head_commit.as_deref() {
                Some(previous_head) => {
                    self.task_head_changed_dirs(binding, previous_head, &head_commit)
                        .await
                }
                None => None,
            };
            (head_commit, head_changed_dirs, HashSet::new(), false)
        };

        let mut git_calls = if head_cache_matches { 0 } else { 3 };
        git_calls += 1;
        if !head_cache_matches && head_changed_dirs.is_some() {
            git_calls += 1;
        }
        let worktree_dirty = self.task_worktree_dirty_dirs(binding).await?;
        let reuse_incremental = (head_cache_matches || head_changed_dirs.is_some())
            && worktree_dirty.is_some()
            && previous.is_some()
            && !(force_file_scan && !files_complete);
        let (
            tasks,
            files,
            local_dirs,
            files_complete,
            hashed,
            parsed,
            scan_mode,
        ) = if reuse_incremental {
            let entry = previous.as_ref().ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "ownership 索引状态无效")
            })?;
            let current_dirty = worktree_dirty.clone().unwrap_or_default();
            let mut scan_dirs = current_dirty;
            scan_dirs.extend(entry.dirty_task_dirs.iter().cloned());
            scan_dirs.extend(head_changed_dirs.unwrap_or_default());
            if scan_dirs.is_empty() {
                (
                    entry.tasks.clone(),
                    entry.files.clone(),
                    entry.local_dirs.clone(),
                    entry.files_complete,
                    0,
                    0,
                    "reused",
                )
            } else {
                let (scanned_tasks, scanned_files, scanned_dirs, hashed, parsed) = self
                    .scan_ownership_index_files(
                        Path::new(&binding.repo_path),
                        &entry.tasks,
                        &entry.files,
                        Some(&scan_dirs),
                        entry.files_complete,
                    )
                    .await?;
                let mut tasks = entry.tasks.clone();
                tasks.retain(|task_dir, _| !scan_dirs.contains(task_dir));
                tasks.extend(scanned_tasks);
                let mut files = entry.files.clone();
                files.retain(|path, _| {
                    task_directory_from_path(path)
                        .ok()
                        .map_or(true, |parts| !scan_dirs.contains(&parts.task_dir))
                });
                files.extend(scanned_files);
                let mut local_dirs: HashSet<String> =
                    entry.local_dirs.iter().cloned().collect();
                local_dirs.retain(|task_dir| !scan_dirs.contains(task_dir));
                local_dirs.extend(scanned_dirs);
                let mut local_dirs: Vec<String> = local_dirs.into_iter().collect();
                local_dirs.sort();
                (
                    tasks,
                    files,
                    local_dirs,
                    entry.files_complete,
                    hashed,
                    parsed,
                    if head_cache_matches {
                        "incremental"
                    } else {
                        "head-incremental"
                    },
                )
            }
        } else {
            let previous_tasks = previous
                .as_ref()
                .map(|entry| entry.tasks.clone())
                .unwrap_or_default();
            let previous_files = previous
                .as_ref()
                .map(|entry| entry.files.clone())
                .unwrap_or_default();
            let hash_all_files = force_file_scan || files_complete;
            let (tasks, files, local_dirs, hashed, parsed) = self
                .scan_ownership_index_files(
                    Path::new(&binding.repo_path),
                    &previous_tasks,
                    &previous_files,
                    None,
                    hash_all_files,
                )
                .await?;
            (
                tasks,
                files,
                local_dirs,
                hash_all_files,
                hashed,
                parsed,
                "full",
            )
        };
        let mut paused: HashSet<String> = tasks
            .iter()
            .filter(|(_, task)| {
                task.branch
                    .as_deref()
                    .is_some_and(|branch| branch != binding.branch_name)
            })
            .map(|(task_dir, _)| task_dir.clone())
            .collect();
        let need_head_tree =
            !paused.is_empty() && binding.baseline_branch.as_deref() == Some(&binding.branch_name);
        let (tracked_paths, tracked_paths_loaded) = if need_head_tree {
            if head_cache_matches && previous_tracked_loaded {
                (previous_tracked_paths, true)
            } else {
                git_calls += 1;
                let paths = self
                    .head_tree_paths_for_commit(binding, &binding.branch_name, &head_commit)
                    .await?;
                (paths.as_ref().clone(), true)
            }
        } else if head_cache_matches {
            (previous_tracked_paths, previous_tracked_loaded)
        } else {
            (HashSet::new(), false)
        };
        if !paused.is_empty() {
            paused.retain(|task_dir| !tracked_paths.contains(&format!("{task_dir}/task.json")));
        }

        let mut tracked_paths: Vec<String> = tracked_paths
            .into_iter()
            .filter(|path| {
                task_directory_from_path(path)
                    .is_ok_and(|parts| !parts.archived && parts.file_path == "task.json")
            })
            .collect();
        tracked_paths.sort();
        let mut paused: Vec<String> = paused.into_iter().collect();
        paused.sort();
        if !self
            .projection_epoch_matches(&binding.task_space_id, projection_epoch)
            .await
        {
            return protocol::err(code::BINDING_UNKNOWN, "ownership 校验已失效");
        }
        let task_json_reused = tasks.len().saturating_sub(parsed);
        let head_fingerprint = current_head_fingerprint.clone().unwrap_or_default();
        let dirty_task_dir_count = worktree_dirty.as_ref().map(HashSet::len).unwrap_or(0);
        let mut dirty_task_dirs: Vec<String> =
            worktree_dirty.unwrap_or_default().into_iter().collect();
        dirty_task_dirs.sort();
        let entry = OwnershipIndexBinding {
            task_space_id: binding.task_space_id.clone(),
            repo_path: binding.repo_path.clone(),
            branch_name: binding.branch_name.clone(),
            baseline_branch: binding.baseline_branch.clone(),
            head_commit: head_commit.clone(),
            head_fingerprint: head_fingerprint.clone(),
            git_index_fingerprint: current_git_index_fingerprint.unwrap_or_default(),
            tracked_paths,
            tracked_paths_loaded,
            tasks,
            files,
            files_complete,
            dirty_task_dirs,
            paused: paused.clone(),
            local_dirs: local_dirs.clone(),
        };
        let index_changed = previous.as_ref() != Some(&entry);
        self.ownership_index
            .lock()
            .await
            .bindings
            .insert(binding.local_id.clone(), entry);
        if index_changed {
            if let Err(error) = self.persist_ownership_index().await {
                crate::logging::warn(&format!(
                    "保存 ownership 索引失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
        let invalidate_reason = if previous.is_none() {
            "binding-cache-miss"
        } else if !head_cache_matches {
            "head-or-ref-changed"
        } else if hashed > 0 {
            "task-file-metadata-changed"
        } else {
            "none"
        };
        crate::logging::warn(&format!(
            "ownership 索引校验 {{\"taskSpaceId\":\"{}\",\"cacheHit\":{},\"invalidateReason\":\"{invalidate_reason}\",\"scanMode\":\"{scan_mode}\",\"taskDirs\":{},\"dirtyTaskDirs\":{},\"taskJsonReused\":{},\"taskJsonParsed\":{},\"taskFilesHashed\":{},\"headCacheHit\":{},\"gitCalls\":{},\"elapsedMs\":{}}}",
            binding.task_space_id,
            previous.is_some(),
            local_dirs.len(),
            dirty_task_dir_count,
            task_json_reused,
            parsed,
            hashed,
            head_cache_matches,
            git_calls,
            started.elapsed().as_millis()
        ));
        let paused: Arc<HashSet<String>> = Arc::new(paused.into_iter().collect());
        let local_dirs: Arc<HashSet<String>> = Arc::new(local_dirs.into_iter().collect());
        self.cache_ownership_projection(
            binding.task_space_id.clone(),
            projection_epoch,
            OwnershipProjectionCache {
                local_id: binding.local_id.clone(),
                branch_name: binding.branch_name.clone(),
                baseline_branch: binding.baseline_branch.clone(),
                repo_path: binding.repo_path.clone(),
                head_commit,
                head_fingerprint,
                paused: paused.clone(),
                local_dirs: local_dirs.clone(),
                validated_at: Instant::now(),
            },
        )
        .await;
        Ok((paused, local_dirs))
    }

    async fn validate_ownership_binding(self: &Arc<Self>, task_space_id: &str) {
        let started = Instant::now();
        let binding = self.bindings.lock().await.get(task_space_id).cloned();
        let Some(binding) = binding else {
            return;
        };
        self.ensure_ownership_index_loaded().await;
        let before = self
            .ownership_index
            .lock()
            .await
            .bindings
            .get(&binding.local_id)
            .map(|entry| (entry.paused.clone(), entry.local_dirs.clone()));
        let projection_epoch = self.projection_epoch(task_space_id).await;
        match self
            .refresh_ownership_index_binding(&binding, projection_epoch)
            .await
        {
            Ok((paused, local_dirs)) => {
                let mut paused: Vec<String> = paused.iter().cloned().collect();
                let mut local_dirs: Vec<String> = local_dirs.iter().cloned().collect();
                paused.sort();
                local_dirs.sort();
                if before != Some((paused, local_dirs)) {
                    self.notify_state_changed();
                }
            }
            Err(error) => {
                if error.code != code::BINDING_UNKNOWN {
                    self.discard_ownership_index_binding(&binding.local_id)
                        .await;
                    self.invalidate_ownership_projection(task_space_id).await;
                    self.notify_state_changed();
                }
                crate::logging::warn(&format!(
                    "ownership 增量校验失败：{}",
                    protocol::safe_error_message(&error.to_string())
                ))
            }
        }
        sync_trace(
            task_space_id,
            "ownership-validation",
            started,
            json!({ "trigger": "ownership" }),
        );
    }

    async fn enqueue_ownership_validation(&self, task_space_id: &str) {
        self.ownership_validation_state
            .pending
            .lock()
            .await
            .insert(task_space_id.to_string());
        self.ownership_validation_state.notify.notify_one();
    }

    pub(crate) fn ensure_ownership_validation_worker(self: &Arc<Self>) {
        if self
            .ownership_validation_started
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let this = Arc::downgrade(self);
        let state = self.ownership_validation_state.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                state.notify.notified().await;
                let Some(sync) = this.upgrade() else {
                    return;
                };
                loop {
                    let pending = {
                        let mut pending = state.pending.lock().await;
                        if pending.is_empty() {
                            break;
                        }
                        std::mem::take(&mut *pending)
                    };
                    let mut pending: Vec<String> = pending.into_iter().collect();
                    pending.sort();
                    for task_space_id in pending {
                        let serial = sync.task_space_sync_lock(&task_space_id).await;
                        let _serial = serial.lock().await;
                        sync.validate_ownership_binding(&task_space_id).await;
                    }
                }
                drop(sync);
            }
        });
    }

    /// ProjectRail 轮询只复用展示投影；真正上传前仍由同步门禁重新校验。
    pub(crate) async fn ownership_projection(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
        let projection_epoch = self.projection_epoch(&binding.task_space_id).await;
        let current_head_fingerprint = git_head_fingerprint(Path::new(&binding.repo_path)).await;
        let cached = {
            let cache = self.ownership_projection_cache.lock().await;
            cache
                .get(&binding.task_space_id)
                .filter(|entry| ownership_projection_cache_matches(entry, binding))
                .map(|entry| {
                    (
                        entry.head_commit.clone(),
                        entry.paused.clone(),
                        entry.local_dirs.clone(),
                        entry.validated_at,
                        entry.head_fingerprint.clone(),
                    )
                })
        };
        if let Some((_, paused, local_dirs, validated_at, cached_fingerprint)) = &cached {
            let fingerprint_unchanged =
                current_head_fingerprint.as_ref() == Some(cached_fingerprint);
            let fallback_ttl_valid = current_head_fingerprint.is_none()
                && validated_at.elapsed() < OWNERSHIP_PROJECTION_CACHE_TTL;
            if fingerprint_unchanged || fallback_ttl_valid {
                let mut cache = self.ownership_projection_cache.lock().await;
                if let Some(entry) = cache.get_mut(&binding.task_space_id) {
                    if self
                        .projection_epoch_matches(&binding.task_space_id, projection_epoch)
                        .await
                        && ownership_projection_cache_matches(entry, binding)
                    {
                        entry.validated_at = Instant::now();
                        return Ok((paused.clone(), local_dirs.clone()));
                    }
                }
            }
        }

        let tasks_root_safe =
            ownership_tasks_root_is_safe(Path::new(&binding.repo_path)).await;
        if tasks_root_safe
            && self
                .ownership_validation_started
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            self.ensure_ownership_index_loaded().await;
            let indexed =
                indexed_ownership_projection(&*self.ownership_index.lock().await, binding);
            if let Some((paused, local_dirs, head_commit, head_fingerprint)) = indexed {
                self.cache_ownership_projection(
                    binding.task_space_id.clone(),
                    projection_epoch,
                    OwnershipProjectionCache {
                        local_id: binding.local_id.clone(),
                        branch_name: binding.branch_name.clone(),
                        baseline_branch: binding.baseline_branch.clone(),
                        repo_path: binding.repo_path.clone(),
                        head_commit,
                        head_fingerprint,
                        paused: paused.clone(),
                        local_dirs: local_dirs.clone(),
                        validated_at: Instant::now(),
                    },
                )
                .await;
                return Ok((paused, local_dirs));
            }
        }

        let result = self
            .refresh_ownership_index_binding(binding, projection_epoch)
            .await;
        if result
            .as_ref()
            .is_err_and(|error| error.code != code::BINDING_UNKNOWN)
        {
            self.discard_ownership_index_binding(&binding.local_id)
                .await;
        }
        result
    }

    /// 本地关联展示与同步门禁共用同一套基线错分支判定和 HEAD tree 缓存。
    #[cfg(test)]
    pub(crate) async fn ownership_paused_task_dirs(
        &self,
        binding: &AgentBinding,
        groups: &[SnapshotGroup],
    ) -> HashSet<String> {
        let mut paused: HashSet<String> = groups
            .iter()
            .filter(|group| {
                group
                    .task_branch
                    .as_deref()
                    .is_some_and(|branch| branch != binding.branch_name)
            })
            .map(|group| group.task_dir.clone())
            .collect();
        if paused.is_empty()
            || binding.baseline_branch.as_deref() != Some(binding.branch_name.as_str())
        {
            return paused;
        }
        if let Ok((_, tracked_paths)) = self.projected_head_tree_paths(binding).await {
            paused.retain(|task_dir| !tracked_paths.contains(&format!("{task_dir}/task.json")));
        }
        paused
    }

    fn baseline_owned_key(task_space_id: &str, task_id: &str) -> String {
        format!("{task_space_id}\0{task_id}")
    }

    async fn baseline_owned(&self, task_space_id: &str, task_id: &str) -> bool {
        self.baseline_owned
            .lock()
            .await
            .contains(&Self::baseline_owned_key(task_space_id, task_id))
    }

    async fn mark_baseline_owned(&self, task_space_id: &str, task_id: &str) {
        self.baseline_owned
            .lock()
            .await
            .insert(Self::baseline_owned_key(task_space_id, task_id));
    }

    async fn assert_binding_active(&self, binding: &AgentBinding) -> AgentResult<()> {
        let config = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?;
        let current = config
            .bindings
            .iter()
            .find(|item| item.local_id == binding.local_id);
        if current.is_some_and(|item| {
            item.sync_status == "approved" && !item.detach_pending
        }) {
            Ok(())
        } else {
            protocol::err(code::BINDING_UNKNOWN, "本地任务空间关联已停用或正在解除")
        }
    }

    async fn task_space_is_active(&self, task_space_id: &str) -> bool {
        self.store
            .read_config(false)
            .await
            .ok()
            .flatten()
            .is_some_and(|config| {
                config.bindings.iter().any(|binding| {
                    binding.task_space_id == task_space_id
                        && binding.sync_status == "approved"
                        && !binding.detach_pending
                })
            })
    }

    fn binding_hooks_dir(&self, binding: &AgentBinding) -> PathBuf {
        self.store.paths.hooks_base_dir.join(&binding.local_id)
    }

    async fn persist_binding_sync_error(&self, binding: &AgentBinding, error: &AgentError) {
        let message = protocol::safe_error_message(&error.message);
        let error_code = error.code.clone();
        let local_id = binding.local_id.clone();
        let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed_in_update = changed.clone();
        let result = self
            .store
            .update_config(false, move |current| {
                let Some(config) = current else {
                    return Ok(None);
                };
                let mut next = config.clone();
                let mut changed = false;
                for item in next.bindings.iter_mut() {
                    if item.local_id != local_id {
                        continue;
                    }
                    if item.live_sync_status == "error"
                        && item.live_sync_error.as_deref() == Some(message.as_str())
                        && item.last_error_code.as_deref() == Some(error_code.as_str())
                    {
                        continue;
                    }
                    item.live_sync_status = "error".into();
                    item.live_sync_error = Some(message.clone());
                    item.last_error_code = Some(error_code.clone());
                    item.last_error = Some(message.clone());
                    changed = true;
                }
                if changed {
                    changed_in_update.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(Some(next))
                } else {
                    Ok(None)
                }
            })
            .await;
        match result {
            Ok(_) if changed.load(std::sync::atomic::Ordering::SeqCst) => {
                self.notify_state_changed()
            }
            Ok(_) => {}
            Err(error) => {
                crate::logging::warn(&format!(
                    "保存任务同步状态失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }

    async fn clear_branch_guard_error(&self, binding: &AgentBinding) {
        let local_id = binding.local_id.clone();
        let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed_in_update = changed.clone();
        let result = self
            .store
            .update_config(false, move |current| {
                let Some(config) = current else {
                    return Ok(None);
                };
                let mut next = config.clone();
                let mut changed = false;
                for item in next.bindings.iter_mut() {
                    if item.local_id != local_id {
                        continue;
                    }
                    let Some(previous) = item.last_error_code.clone() else {
                        continue;
                    };
                    if !is_branch_guard_code(&previous) {
                        continue;
                    }
                    item.live_sync_status = if item.initial_sync_completed {
                        "ready".into()
                    } else {
                        "syncing".into()
                    };
                    item.live_sync_error = None;
                    item.last_error_code = None;
                    item.last_error = None;
                    changed = true;
                }
                if changed {
                    changed_in_update.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(Some(next))
                } else {
                    Ok(None)
                }
            })
            .await;
        match result {
            Ok(_) if changed.load(std::sync::atomic::Ordering::SeqCst) => {
                self.notify_state_changed()
            }
            Ok(_) => {}
            Err(error) => {
                crate::logging::warn(&format!(
                    "保存分支恢复状态失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }

    /// 拉取、补收敛基线任务，并对失败写日志和 `task_sync_error` 控制事件。
    pub async fn pull_and_report(&self, task_space_id: &str) -> bool {
        let revision_before = self.read_cursor(task_space_id).await.revision;
        let mut reconciled_deferred = HashSet::new();
        let revalidate = match self
            .pull_task_space_tracking(task_space_id, &mut reconciled_deferred)
            .await
        {
            Ok(result) if result.get("pendingReview").and_then(Value::as_bool) != Some(true) => {
                let repaired = result.get("repaired").and_then(Value::as_bool) == Some(true);
                if let Err(error) = self
                    .reconcile_baseline_tasks(task_space_id, &reconciled_deferred)
                    .await
                {
                    self.report_error(task_space_id, &error).await;
                }
                repaired
            }
            Ok(_) => true,
            Err(error) => {
                self.report_error(task_space_id, &error).await;
                true
            }
        };
        revalidate || self.read_cursor(task_space_id).await.revision != revision_before
    }
    pub async fn pull_and_report_for_event(
        self: &Arc<Self>,
        task_space_id: &str,
        event_revision: Option<u64>,
    ) {
        let serial = self.task_space_sync_lock(task_space_id).await;
        let _serial = serial.lock().await;
        match self
            .pull_task_space_for_event(task_space_id, event_revision)
            .await
        {
            Ok(result) => {
                if result.get("skipped").and_then(Value::as_bool) != Some(true) {
                    self.invalidate_ownership_projection(task_space_id).await;
                    self.ensure_ownership_validation_worker();
                    self.enqueue_ownership_validation(task_space_id).await;
                }
            }
            Err(error) => self.report_error(task_space_id, &error).await,
        }
    }

    async fn report_error(&self, task_space_id: &str, error: &AgentError) {
        let binding = self.bindings.lock().await.get(task_space_id).cloned();
        let message = protocol::safe_error_message(&error.to_string());
        crate::logging::warn(&format!(
            "任务空间同步失败 {{\"taskSpaceId\":\"{task_space_id}\",\"error\":\"{message}\"}}"
        ));
        (self.emit)(task_sync_error_event(
            binding.as_ref(),
            task_space_id,
            error,
            message,
        ));
    }

    /// 监听各绑定仓库的 `.trellis`，把本地改动按任务目录合并后上传。
    async fn rebuild_watchers(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
        let mut prepared = Vec::with_capacity(bindings.len());
        for binding in bindings {
            let git_paths = git_watch_paths(Path::new(&binding.repo_path)).await;
            prepared.push((binding, git_paths));
        }
        let mut state = self.watch.lock().await;
        state.watchers.clear();
        let tx = match state.tx.clone() {
            Some(tx) => tx,
            None => {
                let (tx, rx) = mpsc::unbounded_channel();
                let this = self.clone();
                tauri::async_runtime::spawn(async move { this.watch_loop(rx).await });
                state.tx = Some(tx.clone());
                tx
            }
        };
        for (binding, git_paths) in prepared {
            let root = Path::new(&binding.repo_path).join(".trellis");
            if !binding.read_only && root.is_dir() {
                let task_space_id = binding.task_space_id.clone();
                let watch_root = root.clone();
                let sender = tx.clone();
                let watcher = notify::recommended_watcher(
                    move |result: notify::Result<notify::Event>| {
                        let Ok(event) = result else {
                            return;
                        };
                        if !is_relevant_watch_event(&event) {
                            return;
                        }
                        let is_remove =
                            matches!(&event.kind, notify::event::EventKind::Remove(_));
                        for path in event.paths {
                            let Ok(relative) = path.strip_prefix(&watch_root) else {
                                continue;
                            };
                            let relative = relative.to_string_lossy().replace('\\', "/");
                            if !is_watched_trellis_path(&relative) {
                                continue;
                            }
                            let full_relative = format!(".trellis/{relative}");
                            let file_changed = SNAPSHOT_EXTENSIONS
                                .iter()
                                .any(|extension| full_relative.to_lowercase().ends_with(extension));
                            let removed_task_dir = !is_remove
                                && !path.exists()
                                && active_task_directory_from_relative(&full_relative).is_some();
                            if !file_changed
                                && !is_remove
                                && !removed_task_dir
                            {
                                continue;
                            }
                            if active_task_directory_from_relative(&full_relative).is_none() {
                                continue;
                            }
                            let _ = sender.send(WatchEvent::TaskPath {
                                task_space_id: task_space_id.clone(),
                                relative_path: full_relative,
                            });
                        }
                    },
                );
                match watcher {
                    Ok(mut watcher) => {
                        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
                            crate::logging::warn(&format!("任务目录监听失败：{error}"));
                        } else {
                            state.watchers.push(watcher);
                        }
                    }
                    Err(error) => {
                        crate::logging::warn(&format!("任务目录监听失败：{error}"));
                    }
                }
            }

            if git_paths.is_empty() {
                continue;
            }
            let task_space_id = binding.task_space_id;
            let sender = tx.clone();
            let mut watcher =
                match notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    if result.is_ok_and(|event| is_relevant_watch_event(&event)) {
                        let _ = sender.send(WatchEvent::GitChanged {
                            task_space_id: task_space_id.clone(),
                        });
                    }
                }) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        crate::logging::warn(&format!("本地 Git 监听失败：{error}"));
                        continue;
                    }
                };
            let mut watched = false;
            for (path, mode) in git_paths {
                if let Err(error) = watcher.watch(&path, mode) {
                    let error = protocol::safe_error_message(&error.to_string());
                    crate::logging::warn(&format!("本地 Git 元数据监听失败：{error}"));
                    continue;
                }
                watched = true;
            }
            if watched {
                state.watchers.push(watcher);
            }
        }
    }

    async fn watch_loop(self: Arc<Self>, mut receiver: mpsc::UnboundedReceiver<WatchEvent>) {
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        let mut git_changed: HashSet<String> = HashSet::new();
        loop {
            let Some(first) = receiver.recv().await else {
                break;
            };
            match first {
                WatchEvent::TaskPath {
                    task_space_id,
                    relative_path,
                } => {
                    if active_task_directory_from_relative(&relative_path).is_none() {
                        continue;
                    }
                    pending
                        .entry(task_space_id)
                        .or_default()
                        .insert(relative_path);
                }
                WatchEvent::GitChanged { task_space_id } => {
                    git_changed.insert(task_space_id);
                }
            }
            loop {
                match tokio::time::timeout(WATCH_DEBOUNCE, receiver.recv()).await {
                    Ok(Some(event)) => {
                        match event {
                            WatchEvent::TaskPath {
                                task_space_id,
                                relative_path,
                            } => {
                                if active_task_directory_from_relative(&relative_path).is_none() {
                                    continue;
                                }
                                pending
                                    .entry(task_space_id)
                                    .or_default()
                                    .insert(relative_path);
                            }
                            WatchEvent::GitChanged { task_space_id } => {
                                git_changed.insert(task_space_id);
                            }
                        }
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            for (task_space_id, paths) in std::mem::take(&mut pending) {
                let started = Instant::now();
                let syncing = {
                    let syncing = self.syncing_task_spaces.lock().await;
                    if syncing.contains_key(&task_space_id) {
                        self.deferred_uploads
                            .lock()
                            .await
                            .entry(task_space_id.clone())
                            .or_default()
                            .extend(paths.iter().cloned());
                        true
                    } else {
                        false
                    }
                };
                if syncing {
                    continue;
                }
                let mut paths: Vec<String> = paths.into_iter().collect();
                paths.sort();
                let target_count = paths
                    .iter()
                    .filter_map(|path| active_task_directory_from_relative(path))
                    .collect::<HashSet<_>>()
                    .len();
                // 首次同步未完成时 watcher 仍在监听，但上传必须等 bootstrap 拉取落地，
                // 否则会用本地旧内容抢在服务端快照之前写入（对照 JS `_uploadDirty` 的守卫）。
                let ready = self
                    .bindings
                    .lock()
                    .await
                    .get(&task_space_id)
                    .is_some_and(|binding| !binding.read_only && binding.initial_sync_completed);
                if ready {
                    let serial = self.task_space_sync_lock(&task_space_id).await;
                    let _serial = serial.lock().await;
                    if let Err(error) = self.upload_dirty(&task_space_id, &paths).await {
                        self.report_error(&task_space_id, &error).await;
                    }
                }
                self.invalidate_ownership_projection(&task_space_id).await;
                self.ensure_ownership_validation_worker();
                self.enqueue_ownership_validation(&task_space_id).await;
                self.notify_state_changed();
                sync_trace(
                    &task_space_id,
                    "watcher-total",
                    started,
                    json!({
                        "trigger": "watcher",
                        "targetDirs": target_count,
                        "pathCount": paths.len(),
                    }),
                );
            }
            for task_space_id in std::mem::take(&mut git_changed) {
                if !self
                    .bindings
                    .lock()
                    .await
                    .contains_key(&task_space_id)
                {
                    continue;
                }
                let syncing = {
                    let syncing = self.syncing_task_spaces.lock().await;
                    if syncing.contains_key(&task_space_id) {
                        self.deferred_uploads
                            .lock()
                            .await
                            .entry(task_space_id.clone())
                            .or_default();
                        true
                    } else {
                        false
                    }
                };
                if syncing {
                    continue;
                }
                self.invalidate_ownership_projection(&task_space_id).await;
                self.ensure_ownership_validation_worker();
                self.enqueue_ownership_validation(&task_space_id).await;
                self.notify_state_changed();
            }
        }
    }

    async fn binding(&self, task_space_id: &str) -> AgentResult<AgentBinding> {
        self.bindings
            .lock()
            .await
            .get(task_space_id)
            .cloned()
            .filter(|binding| !binding.detach_pending)
            .ok_or_else(|| AgentError::new(code::BINDING_UNKNOWN, "任务空间尚未关联到本地仓库"))
    }

    pub async fn active_bindings(&self) -> Vec<AgentBinding> {
        let mut bindings: Vec<AgentBinding> = {
            let bindings = self.bindings.lock().await;
            bindings.values().cloned().collect()
        };
        // 监听集合只排除首次同步尚未完成的绑定：增量/补拉进行中仍算在线监听，
        // 否则一次长同步就会让客户端在服务端永久显示为不在线。
        bindings.retain(|binding| binding.initial_sync_completed && !binding.detach_pending);
        bindings.sort_by(|left, right| left.task_space_id.cmp(&right.task_space_id));
        bindings
    }

    async fn load_cursor_state(&self) -> Value {
        tokio::fs::read_to_string(&self.store.paths.task_cursors_file)
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|value| {
                value.get("version").and_then(Value::as_u64) == Some(CURSOR_VERSION)
                    && value.get("taskSpaces").is_some_and(Value::is_object)
            })
            .unwrap_or_else(|| json!({ "version": CURSOR_VERSION, "taskSpaces": {} }))
    }

    async fn read_cursor_state(&self) -> Value {
        let mut guard = self.cursor_state.lock().await;
        if let Some(state) = guard.as_ref() {
            return state.clone();
        }
        let state = self.load_cursor_state().await;
        *guard = Some(state.clone());
        state
    }

    async fn read_cursor_event_state(&self, task_space_id: &str) -> (u64, bool) {
        let mut guard = self.cursor_state.lock().await;
        if guard.is_none() {
            let state = self.load_cursor_state().await;
            *guard = Some(state);
        }
        let entry = guard
            .as_ref()
            .and_then(|state| state.get("taskSpaces"))
            .and_then(|spaces| spaces.get(task_space_id));
        let revision = entry
            .and_then(|entry| entry.get("revision"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let has_pending = entry
            .cloned()
            .is_some_and(|entry| cursor_from_entry(&entry).pending.is_some());
        (revision, has_pending)
    }

    pub async fn read_cursor(&self, task_space_id: &str) -> Cursor {
        let state = self.read_cursor_state().await;
        let Some(entry) = state
            .get("taskSpaces")
            .and_then(|spaces| spaces.get(task_space_id))
        else {
            return Cursor::default();
        };
        cursor_from_entry(entry)
    }

    async fn write_cursor(&self, task_space_id: &str, next: CursorPatch) -> AgentResult<()> {
        let _guard = self.cursor_write.lock().await;
        let known = self.bindings.lock().await.contains_key(task_space_id);
        if !known || !self.task_space_is_active(task_space_id).await {
            return Ok(());
        }
        // 多进程共享同一游标文件：先拿文件锁，再丢弃缓存重新读取，避免覆盖别人的写入。
        let _file_guard = self.store.lock_task_cursors(Duration::from_secs(5)).await?;
        *self.cursor_state.lock().await = None;
        let mut state = self.read_cursor_state().await;
        let tasks = state
            .get_mut("taskSpaces")
            .and_then(Value::as_object_mut)
            .cloned()
            .unwrap_or_default();
        let mut tasks = tasks;
        let mut entry = tasks
            .get(task_space_id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let mut cursor = cursor_from_entry(&Value::Object(entry.clone()));
        let patch_changed = apply_cursor_patch(&mut cursor, &next);
        let archive_migration = cursor_entry_needs_archive_migration(&Value::Object(entry.clone()));
        if !patch_changed && !archive_migration {
            *self.cursor_state.lock().await = Some(state);
            return Ok(());
        }
        entry.insert("revision".into(), json!(cursor.revision));
        entry.insert(
            "revisionGuardVersion".into(),
            json!(cursor.revision_guard_version),
        );
        entry.insert("sequence".into(), json!(cursor.sequence));
        if next.baseline_reconciled_head.is_some() {
            entry.insert(
                "baselineReconciledHead".into(),
                json!(cursor.baseline_reconciled_head),
            );
        }
        entry.insert("baselines".into(), baselines_to_value(&cursor.baselines));
        entry.insert("deferred".into(), deferred_to_value(&cursor.deferred));
        entry.insert(
            "ownershipPending".into(),
            ownership_pending_to_value(&cursor.ownership_pending),
        );
        entry.insert(
            "conflictBlocked".into(),
            conflict_blocked_to_value(&cursor.conflict_blocked),
        );
        entry.insert(
            "pendingRejected".into(),
            pending_rejected_to_value(&cursor.pending_rejected),
        );
        match cursor.pending {
            Some(batch) => {
                entry.insert(
                    "pending".into(),
                    json!({
                        "batchId": batch.batch_id,
                        "clientSequence": batch.client_sequence,
                        "files": batch.files,
                        "mergeEvidence": batch.merge_evidence,
                        "createdAt": batch.created_at,
                    }),
                );
            }
            None => {
                entry.remove("pending");
            }
        }
        entry.insert("updatedAt".into(), Value::String(protocol::now_iso8601()));
        tasks.insert(task_space_id.to_string(), Value::Object(entry));
        state["taskSpaces"] = Value::Object(tasks);
        let text = serde_json::to_string_pretty(&state).unwrap_or_else(|_| "{}".into());
        self.store
            .write_atomic(
                &self.store.paths.task_cursors_file,
                format!("{text}\n").as_bytes(),
            )
            .await?;
        *self.cursor_state.lock().await = Some(state);
        self.notify_state_changed();
        Ok(())
    }

    async fn migrate_cursor_archive_state(&self, task_space_id: &str) -> AgentResult<()> {
        self.write_cursor(task_space_id, CursorPatch::default()).await
    }

    pub async fn remove_task_cursor(&self, task_space_id: &str) -> AgentResult<()> {
        let _guard = self.cursor_write.lock().await;
        let _file_guard = self.store.lock_task_cursors(Duration::from_secs(5)).await?;
        *self.cursor_state.lock().await = None;
        let mut state = self.read_cursor_state().await;
        let removed = state
            .get_mut("taskSpaces")
            .and_then(Value::as_object_mut)
            .and_then(|spaces| spaces.remove(task_space_id))
            .is_some();
        if !removed {
            return Ok(());
        }
        let text = serde_json::to_string_pretty(&state).unwrap_or_else(|_| "{}".into());
        self.store
            .write_atomic(
                &self.store.paths.task_cursors_file,
                format!("{text}\n").as_bytes(),
            )
            .await?;
        *self.cursor_state.lock().await = Some(state);
        self.notify_state_changed();
        Ok(())
    }

    /// 按服务端要求抬高待上传批次的 clientSequence（仅同一批次、且序号确实变大）。
    async fn update_pending_client_sequence(
        &self,
        task_space_id: &str,
        batch_id: &str,
        client_sequence: u64,
    ) -> AgentResult<()> {
        let cursor = self.read_cursor(task_space_id).await;
        let Some(pending) = cursor.pending.clone() else {
            return Ok(());
        };
        if pending.batch_id != batch_id || pending.client_sequence >= client_sequence {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                pending: Some(Some(PendingBatch {
                    client_sequence,
                    ..pending
                })),
                ..Default::default()
            },
        )
        .await
    }

    async fn local_files(
        &self,
        binding: &AgentBinding,
        task_dirs: Option<&HashSet<String>>,
    ) -> AgentResult<Vec<Value>> {
        read_local_task_snapshot_files(Path::new(&binding.repo_path), task_dirs).await
    }

    async fn local_groups(
        &self,
        binding: &AgentBinding,
        task_dirs: Option<&HashSet<String>>,
    ) -> AgentResult<Vec<SnapshotGroup>> {
        let files = self.local_files(binding, task_dirs).await?;
        group_task_snapshot_files(&files)
    }

    async fn fetch_task_ownership(
        &self,
        task_space_id: &str,
        task_ids: &[String],
    ) -> AgentResult<Value> {
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/task-ownership"),
                Some(&json!({ "taskIds": task_ids })),
                Duration::from_secs(60),
            )
            .await
    }

    async fn remember_ownership_reviews(
        &self,
        task_space_id: &str,
        reviews: &[OwnershipReview],
    ) -> AgentResult<Vec<OwnershipReview>> {
        if reviews.is_empty() {
            return Ok(Vec::new());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut pending = cursor.ownership_pending.clone();
        let mut fresh = Vec::new();
        for review in reviews {
            let fingerprint = task_fingerprint(&review.group);
            if pending.get(&review.group.task_dir) == Some(&fingerprint) {
                continue;
            }
            pending.insert(review.group.task_dir.clone(), fingerprint);
            fresh.push(OwnershipReview {
                group: review.group.clone(),
                reason: review.reason.clone(),
            });
        }
        if pending != cursor.ownership_pending {
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    ownership_pending: Some(pending),
                    ..Default::default()
                },
            )
            .await?;
        }
        Ok(fresh)
    }

    async fn clear_ownership_pending(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut pending = cursor.ownership_pending.clone();
        let before = pending.len();
        for task_dir in task_dirs {
            pending.remove(task_dir);
        }
        if pending.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                ownership_pending: Some(pending),
                ..Default::default()
            },
        )
        .await
    }

    async fn settle_rejected_pending(
        &self,
        binding: &AgentBinding,
        pending: &PendingBatch,
        reason: &str,
    ) -> AgentResult<()> {
        let task_dirs = pending_task_dirs(&pending.files);
        if task_dirs.is_empty() {
            return Ok(());
        }
        let groups = group_task_snapshot_files(&pending.files).unwrap_or_default();
        let groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let mut rejected = cursor.pending_rejected.clone();
        let mut ownership = cursor.ownership_pending.clone();
        let blocked_at = protocol::now_iso8601();
        let created_at = if pending.created_at.is_empty() {
            blocked_at.clone()
        } else {
            pending.created_at.clone()
        };
        for task_dir in &task_dirs {
            rejected.insert(
                task_dir.clone(),
                PendingRejection {
                    batch_id: pending.batch_id.clone(),
                    client_sequence: pending.client_sequence,
                    reason: reason.to_string(),
                    created_at: created_at.clone(),
                    blocked_at: blocked_at.clone(),
                },
            );
        }
        if reason == "TASK_OWNERSHIP_REQUIRED" {
            for task_dir in &task_dirs {
                if let Some(group) = groups_by_dir.get(task_dir) {
                    if group.task_id.is_some() {
                        ownership.insert(task_dir.clone(), task_fingerprint(group));
                    }
                }
            }
        } else {
            for task_dir in &task_dirs {
                ownership.remove(task_dir);
            }
        }
        trim_pending_rejections(&mut rejected);
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                pending: Some(None),
                pending_rejected: Some(rejected),
                ownership_pending: Some(ownership),
                ..Default::default()
            },
        )
        .await?;
        let groups: Vec<SnapshotGroup> = groups_by_dir.into_values().collect();
        self.sync_ownership_inbox(
            binding,
            &cursor.ownership_pending,
            &groups,
        )
        .await;
        Ok(())
    }

    async fn clear_pending_rejections(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut rejected = cursor.pending_rejected.clone();
        let before = rejected.len();
        for task_dir in task_dirs {
            rejected.remove(task_dir);
        }
        if rejected.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                pending_rejected: Some(rejected),
                ..Default::default()
            },
        )
        .await
    }

    async fn mark_conflict_blocked(
        &self,
        task_space_id: &str,
        result: &Value,
        files: &[Value],
    ) -> AgentResult<()> {
        let Some(conflict_id) = result.get("conflictId").and_then(Value::as_str) else {
            return Ok(());
        };
        let task_dirs: HashSet<String> = files
            .iter()
            .filter_map(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .and_then(active_task_directory_from_relative)
            })
            .collect();
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut blocked = cursor.conflict_blocked.clone();
        for task_dir in task_dirs {
            blocked.insert(task_dir, conflict_id.to_string());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                conflict_blocked: Some(blocked),
                ..Default::default()
            },
        )
        .await
    }

    async fn clear_conflict_blocked(
        &self,
        task_space_id: &str,
        conflict_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        let cursor = self.read_cursor(task_space_id).await;
        let mut blocked = cursor.conflict_blocked.clone();
        let before = blocked.len();
        for task_dir in task_dirs {
            if blocked.get(task_dir).map(String::as_str) == Some(conflict_id) {
                blocked.remove(task_dir);
            }
        }
        if blocked.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                conflict_blocked: Some(blocked),
                ..Default::default()
            },
        )
        .await
    }

    fn ownership_event(
        &self,
        binding: &AgentBinding,
        reviews: &[OwnershipReview],
        project_task_spaces: &[Value],
    ) {
        let items: Vec<Value> = reviews
            .iter()
            .map(|review| {
                json!({
                    "taskId": review.group.task_id,
                    "taskDir": review.group.task_dir,
                    "title": task_title(&review.group).or_else(|| review.group.task_id.clone()),
                    "branchName": review.group.task_branch,
                    "suggestedBranchName": Value::Null,
                    "choices": project_task_spaces,
                })
            })
            .collect();
        if items.is_empty() {
            return;
        }
        (self.emit)(json!({
            "type": "task_ownership_review",
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "items": items,
        }));
    }

    async fn sync_ownership_inbox(
        &self,
        binding: &AgentBinding,
        previous_pending: &BTreeMap<String, String>,
        groups: &[SnapshotGroup],
    ) {
        if binding.read_only {
            return;
        }
        if self
            .ownership_inbox_unavailable
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let current = self
            .read_cursor(&binding.task_space_id)
            .await
            .ownership_pending;
        let mut groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .iter()
            .cloned()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let missing: HashSet<String> = current
            .keys()
            .filter(|task_dir| !groups_by_dir.contains_key(*task_dir))
            .cloned()
            .collect();
        if !missing.is_empty() {
            if let Ok(extra) = self.local_groups(binding, Some(&missing)).await {
                for group in extra {
                    groups_by_dir.insert(group.task_dir.clone(), group);
                }
            }
        }

        let mut upserts = Vec::new();
        for (task_dir, fingerprint) in &current {
            let Some(group) = groups_by_dir.get(task_dir) else {
                continue;
            };
            let Some(task_id) = group
                .task_id
                .as_deref()
                .filter(|value| !value.is_empty() && value.len() <= 128)
            else {
                continue;
            };
            if !is_sha256(fingerprint) {
                continue;
            }
            let title: String = task_title(group)
                .or_else(|| Some(task_id.to_string()))
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            upserts.push(json!({
                "taskId": task_id,
                "taskDir": task_dir,
                "title": title,
                "reason": "TASK_OWNERSHIP_REQUIRED",
                "fingerprint": fingerprint,
            }));
        }

        let mut deletes = Vec::new();
        for task_dir in previous_pending
            .keys()
            .filter(|task_dir| !current.contains_key(*task_dir))
        {
            let task_id = match groups_by_dir
                .get(task_dir)
                .and_then(|group| group.task_id.clone())
            {
                Some(task_id) => task_id,
                None => match self
                    .read_ownership_inbox_task_id(binding, task_dir)
                    .await
                {
                    Some(task_id) => task_id,
                    None => task_dir.rsplit('/').next().unwrap_or_default().to_string(),
                },
            };
            if task_id.is_empty() || task_id.len() > 128 {
                continue;
            }
            deletes.push(json!({
                "taskId": task_id,
                "taskDir": task_dir,
            }));
        }

        for chunk in upserts.chunks(OWNERSHIP_INBOX_MAX_CHANGES) {
            if !self
                .put_ownership_inbox(binding, chunk, &[])
                .await
            {
                return;
            }
        }
        for chunk in deletes.chunks(OWNERSHIP_INBOX_MAX_CHANGES) {
            if !self
                .put_ownership_inbox(binding, &[], chunk)
                .await
            {
                return;
            }
        }
    }

    async fn read_ownership_inbox_task_id(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> Option<String> {
        let path = Path::new(&binding.repo_path).join(task_dir).join("task.json");
        let content = tokio::fs::read_to_string(path).await.ok()?;
        parse_task_metadata(&content).0
    }

    async fn put_ownership_inbox(
        &self,
        binding: &AgentBinding,
        upserts: &[Value],
        deletes: &[Value],
    ) -> bool {
        if upserts.is_empty() && deletes.is_empty() {
            return true;
        }
        let observed = match self.assert_binding_branch(binding).await {
            Ok(value) => value,
            Err(_) => return false,
        };
        let result = self
            .api
            .request_json(
                Method::PUT,
                &format!(
                    "/api/agent/task-spaces/{}/ownership-inbox",
                    binding.task_space_id
                ),
                Some(&json!({
                    "observedBranchName": observed,
                    "upserts": upserts,
                    "deletes": deletes,
                })),
                Duration::from_secs(60),
            )
            .await;
        match result {
            Ok(_) => true,
            Err(error) if matches!(error.status, Some(404) | Some(405)) => {
                if !self
                    .ownership_inbox_unavailable
                    .swap(true, std::sync::atomic::Ordering::SeqCst)
                {
                    crate::logging::warn(
                        "服务端不支持待归属摘要接口，继续使用普通任务同步",
                    );
                }
                false
            }
            Err(error) => {
                crate::logging::warn(&format!(
                    "待归属摘要同步失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
                false
            }
        }
    }

    async fn resolve_task_ownership(
        &self,
        binding: &AgentBinding,
        groups: &[SnapshotGroup],
    ) -> AgentResult<OwnershipResolution> {
        let unresolved_ids: Vec<String> = groups
            .iter()
            .filter(|group| group.task_id.is_some() && group.task_branch.is_none())
            .filter_map(|group| group.task_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut project_task_spaces = vec![json!({
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "isBaseline": binding.baseline_branch.as_deref() == Some(binding.branch_name.as_str()),
        })];
        let mut claims_by_task: HashMap<String, Vec<Value>> = HashMap::new();
        for chunk in unresolved_ids.chunks(TASK_OWNERSHIP_QUERY_LIMIT) {
            let result = self
                .fetch_task_ownership(&binding.task_space_id, chunk)
                .await?;
            if let Some(items) = result
                .get("projectTaskSpaces")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                project_task_spaces = items.clone();
            }
            if let Some(tasks) = result.get("tasks").and_then(Value::as_array) {
                for task in tasks {
                    let Some(task_id) = task.get("taskId").and_then(Value::as_str) else {
                        continue;
                    };
                    let claims = task
                        .get("claims")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    claims_by_task.insert(task_id.to_string(), claims);
                }
            }
        }

        let mut resolution = OwnershipResolution {
            project_task_spaces: project_task_spaces.clone(),
            ..Default::default()
        };
        let mut head_tree: Option<(String, Arc<HashSet<String>>)> = None;
        for group in groups {
            let Some(task_id) = group.task_id.as_deref() else {
                resolution.invalid.push(group.task_dir.clone());
                continue;
            };
            if self.baseline_owned(&binding.task_space_id, task_id).await {
                resolution.paused.push(group.clone());
                continue;
            }
            if let Some(branch_name) = group.task_branch.as_deref() {
                self.resolve_group_ownership(
                    binding,
                    group.clone(),
                    task_id,
                    branch_name,
                    &mut head_tree,
                    &mut resolution,
                )
                .await?;
                continue;
            }
            let claims = claims_by_task.get(task_id).cloned().unwrap_or_default();
            let explicit_branches: HashSet<String> = claims
                .iter()
                .filter_map(|claim| claim.get("taskBranch").and_then(Value::as_str))
                .filter(|branch| !branch.is_empty())
                .map(str::to_string)
                .collect();
            let occurrence_branches: HashSet<String> = claims
                .iter()
                .filter_map(|claim| claim.get("branchName").and_then(Value::as_str))
                .filter(|branch| !branch.is_empty())
                .map(str::to_string)
                .collect();
            let inferred = if explicit_branches.len() > 1 {
                None
            } else if explicit_branches.len() == 1 {
                explicit_branches.iter().next().cloned()
            } else if claims.len() == 1 {
                claims[0]
                    .get("branchName")
                    .and_then(Value::as_str)
                    .filter(|branch| !branch.is_empty())
                    .map(str::to_string)
            } else if occurrence_branches.len() == 1 {
                occurrence_branches.iter().next().cloned()
            } else if claims.is_empty() && project_task_spaces.len() == 1 {
                project_task_spaces[0]
                    .get("branchName")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            };
            let Some(inferred) = inferred else {
                resolution.reviews.push(OwnershipReview {
                    group: group.clone(),
                    reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                });
                continue;
            };
            crate::agent::task_command::set_task_directory_branch(
                Path::new(&binding.repo_path),
                &group.task_dir,
                &inferred,
            )
            .await?;
            let mut selected = HashSet::new();
            selected.insert(group.task_dir.clone());
            let refreshed = self
                .local_groups(binding, Some(&selected))
                .await?
                .into_iter()
                .find(|candidate| candidate.task_dir == group.task_dir)
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "任务分支归属写入后未能读回")
                })?;
            if refreshed.task_branch.as_deref() != Some(inferred.as_str()) {
                return protocol::err(code::INVALID_RESPONSE, "任务分支归属写入后未能读回");
            }
            if let Some(task_json) = refreshed
                .files
                .iter()
                .find(|file| file.file_path == "task.json")
            {
                self.suppressed.lock().await.insert(
                    absolute_task_path(binding, &task_json.path),
                    Some(task_json.sha256.clone()),
                );
            }
            self.resolve_group_ownership(
                binding,
                refreshed,
                task_id,
                &inferred,
                &mut head_tree,
                &mut resolution,
            )
            .await?;
        }

        let fresh = self
            .remember_ownership_reviews(&binding.task_space_id, &resolution.reviews)
            .await?;
        self.clear_ownership_pending(
            &binding.task_space_id,
            &resolution
                .syncable
                .keys()
                .cloned()
                .chain(
                    resolution
                        .paused
                        .iter()
                        .map(|group| group.task_dir.clone()),
                )
                .collect::<Vec<_>>(),
        )
        .await?;
        self.clear_pending_rejections(
            &binding.task_space_id,
            &resolution.syncable.keys().cloned().collect::<Vec<_>>(),
        )
        .await?;
        let current_ownership_pending = self
            .read_cursor(&binding.task_space_id)
            .await
            .ownership_pending;
        self.sync_ownership_inbox(binding, &current_ownership_pending, groups)
            .await;
        self.ownership_event(binding, &fresh, &resolution.project_task_spaces);
        Ok(resolution)
    }

    async fn resolve_group_ownership(
        &self,
        binding: &AgentBinding,
        group: SnapshotGroup,
        task_id: &str,
        branch_name: &str,
        head_tree: &mut Option<(String, Arc<HashSet<String>>)>,
        resolution: &mut OwnershipResolution,
    ) -> AgentResult<()> {
        if branch_name == binding.branch_name {
            resolution
                .syncable
                .insert(group.task_dir.clone(), group);
            return Ok(());
        }
        if binding.baseline_branch.as_deref() != Some(binding.branch_name.as_str()) {
            resolution.paused.push(group);
            return Ok(());
        }
        let (head, paths) = match head_tree.as_ref() {
            Some(value) => value.clone(),
            None => {
                let value = self.head_tree_paths(binding).await?;
                *head_tree = Some(value.clone());
                value
            }
        };
        let tracked_path = format!("{}/task.json", group.task_dir);
        if !paths.contains(&tracked_path) {
            resolution.paused.push(group);
            return Ok(());
        }
        resolution.merge_evidence.insert(
            group.task_dir.clone(),
            json!({
                "version": 1,
                "type": "tracked-in-head",
                "taskId": task_id,
                "taskDir": group.task_dir,
                "trackedPath": tracked_path,
                "sourceBranch": branch_name,
                "baselineBranch": binding.branch_name,
                "headCommit": head,
            }),
        );
        resolution
            .syncable
            .insert(group.task_dir.clone(), group);
        Ok(())
    }

    async fn fetch_snapshot(&self, task_space_id: &str, after_revision: u64) -> AgentResult<Value> {
        self.api
            .request_json_limited(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/snapshot?afterRevision={after_revision}"),
                None,
                Duration::from_secs(120),
                MAX_SNAPSHOT_RESPONSE_BYTES,
            )
            .await
    }

    pub(crate) async fn fetch_directory(
        &self,
        task_space_id: &str,
        task_dir: &str,
    ) -> AgentResult<Value> {
        if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
            != Some(task_dir)
        {
            return protocol::err(
                code::INVALID_RESPONSE,
                "任务目录无效或已由服务端 Git 归档",
            );
        }
        let encoded = urlencode(task_dir);
        self.api
            .request_json_limited(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/files?taskDir={encoded}"),
                None,
                Duration::from_secs(120),
                MAX_SNAPSHOT_RESPONSE_BYTES,
            )
            .await
    }

    async fn write_server_cursor(&self, task_space_id: &str, revision: u64) -> AgentResult<()> {
        let known = self.bindings.lock().await.contains_key(task_space_id);
        if !known || !self.task_space_is_active(task_space_id).await {
            return Ok(());
        }
        self.api
            .request_json(
                Method::PUT,
                &format!("/api/agent/task-spaces/{task_space_id}/cursor"),
                Some(&json!({ "revision": revision })),
                Duration::from_secs(60),
            )
            .await
            .map(|_| ())
    }

    async fn apply_server_groups(
        &self,
        binding: &AgentBinding,
        revision: u64,
        groups: &[SnapshotGroup],
        mode: &str,
        persist_cursor: bool,
    ) -> AgentResult<bool> {
        let mut changed = false;
        for group in groups {
            if group.archived
                || is_archive_task_dir(&group.task_dir)
                || group.files.iter().any(|file| file.archived)
            {
                continue;
            }
            self.assert_binding_branch(binding).await?;
            let allow_cross_branch = allows_cross_source_server_group(binding, mode);
            if !allow_cross_branch
                && group
                    .task_branch
                    .as_deref()
                    .is_some_and(|branch| branch != binding.branch_name)
            {
                continue;
            }
            let mut selected = HashSet::new();
            selected.insert(group.task_dir.clone());
            let previous = self.local_files(binding, Some(&selected)).await?;
            if group.files.is_empty() {
                if mode == "incremental" {
                    let mut suppressed = self.suppressed.lock().await;
                    for file in previous_values_paths(&previous) {
                        suppressed.insert(absolute_task_path(binding, &file), None);
                    }
                    drop(suppressed);
                    self.remove_task_directory(binding, &group.task_dir).await?;
                    changed = true;
                }
                continue;
            }
            self.backup_directory(binding, &group.task_dir).await?;
            write_task_directory(binding, group).await?;
            let next_paths: HashSet<String> =
                group.files.iter().map(|file| file.path.clone()).collect();
            {
                let mut suppressed = self.suppressed.lock().await;
                for file in previous_values_paths(&previous) {
                    if !next_paths.contains(&file) {
                        suppressed.insert(absolute_task_path(binding, &file), None);
                    }
                }
                for file in &group.files {
                    suppressed.insert(
                        absolute_task_path(binding, &file.path),
                        Some(snapshot_sha256(&file.content)),
                    );
                }
            }
            changed = true;
        }
        if changed && persist_cursor {
            self.write_cursor(
                &binding.task_space_id,
                CursorPatch {
                    revision: Some(revision),
                    ..Default::default()
                },
            )
            .await?;
        }
        Ok(changed)
    }

    async fn remove_task_directory(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<()> {
        if is_archive_task_dir(task_dir) {
            return protocol::err(
                code::INVALID_RESPONSE,
                "客户端不能修改服务端 Git 管理的归档目录",
            );
        }
        let target = resolve_task_directory(binding, task_dir).await?;
        match tokio::fs::remove_dir_all(&target).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AgentError::new(
                code::INVALID_RESPONSE,
                format!("无法删除任务目录: {error}"),
            )),
        }
    }

    async fn backup_directory(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<Option<String>> {
        let backup_id = uuid::Uuid::new_v4().to_string();
        Ok(self
            .backup_directory_with_id(binding, task_dir, &backup_id)
            .await?
            .then_some(backup_id))
    }

    async fn backup_directory_with_id(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
        backup_id: &str,
    ) -> AgentResult<bool> {
        if is_archive_task_dir(task_dir) {
            return protocol::err(
                code::INVALID_RESPONSE,
                "客户端不能修改服务端 Git 管理的归档目录",
            );
        }
        let source = resolve_task_directory(binding, task_dir).await?;
        if !source.exists() {
            return Ok(false);
        }
        let target = self
            .store
            .paths
            .live_backups_dir
            .join(&binding.task_space_id)
            .join(backup_id);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AgentError::new(code::INVALID_RESPONSE, format!("无法创建备份目录: {error}"))
            })?;
        }
        copy_directory(&source, &target).await?;
        Ok(true)
    }

    async fn suppressed_event(&self, binding: &AgentBinding, relative_path: &str) -> bool {
        let absolute = absolute_task_path(binding, relative_path);
        let expected = {
            let mut suppressed = self.suppressed.lock().await;
            match suppressed.remove(&absolute) {
                Some(value) => value,
                None => return false,
            }
        };
        let Some(expected) = expected else {
            return true;
        };
        match tokio::fs::read(&absolute).await {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => snapshot_sha256(&text) == expected,
                Err(_) => false,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => false,
        }
    }

    async fn local_sync_state(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        server_baselines: &BTreeMap<String, String>,
    ) -> AgentResult<(
        Vec<String>,
        BTreeMap<String, BTreeMap<String, String>>,
        HashSet<String>,
    )> {
        let groups = self.local_metadata_groups(binding).await?;
        Ok(local_sync_state_from_groups(
            cursor,
            &groups,
            server_baselines,
        ))
    }

    async fn local_metadata_groups(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<Vec<SnapshotGroup>> {
        let projection_epoch = self.projection_epoch(&binding.task_space_id).await;
        self.refresh_ownership_index_binding_with_scan(binding, projection_epoch, true)
            .await?;
        let epoch_ok = self
            .projection_epoch_matches(&binding.task_space_id, projection_epoch)
            .await;
        if !epoch_ok {
            return protocol::err(code::BINDING_UNKNOWN, "本地任务文件索引已失效");
        }
        self.ensure_ownership_index_loaded().await;
        let index = self.ownership_index.lock().await;
        let entry = index
            .bindings
            .get(&binding.local_id)
            .filter(|entry| {
                entry.task_space_id == binding.task_space_id
                    && entry.repo_path == binding.repo_path
                    && entry.branch_name == binding.branch_name
                    && entry.baseline_branch == binding.baseline_branch
            })
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "本地任务文件索引缺少当前绑定")
            })?;
        if !entry.files_complete {
            return protocol::err(code::INVALID_RESPONSE, "本地任务文件索引尚未完整");
        }
        indexed_local_groups(entry)
    }

    pub async fn pull_task_space(&self, task_space_id: &str) -> AgentResult<Value> {
        let mut reconciled_deferred = HashSet::new();
        self.pull_task_space_tracking(task_space_id, &mut reconciled_deferred)
            .await
    }

    async fn pull_task_space_tracking(
        &self,
        task_space_id: &str,
        reconciled_deferred: &mut HashSet<String>,
    ) -> AgentResult<Value> {
        let binding = match self.binding(task_space_id).await {
            Ok(binding) => binding,
            Err(error) if error.code == code::BINDING_UNKNOWN => {
                return Ok(json!({
                    "skipped": true,
                    "reason": "BINDING_INACTIVE",
                }))
            }
            Err(error) => return Err(error),
        };
        self.pull_tracking(&binding, reconciled_deferred).await
    }

    async fn pull_task_space_for_event(
        &self,
        task_space_id: &str,
        event_revision: Option<u64>,
    ) -> AgentResult<Value> {
        if let Ok(binding) = self.binding(task_space_id).await {
            let (cursor_revision, has_pending_upload) =
                self.read_cursor_event_state(task_space_id).await;
            let guard_due = binding.initial_sync_completed
                && self
                    .read_cursor(task_space_id)
                    .await
                    .revision_guard_version
                    < REVISION_GUARD_VERSION;
            if !guard_due
                && !should_pull_for_event(
                binding.initial_sync_completed,
                binding.initial_review_pending,
                cursor_revision,
                event_revision,
                has_pending_upload,
            )
            {
                self.retry_pending_handoff_acks(&binding).await?;
                return Ok(json!({
                    "skipped": true,
                    "reason": "REVISION_CURRENT",
                    "revision": cursor_revision,
                }));
            }
        }
        self.pull_task_space(task_space_id).await
    }

    async fn pull(&self, binding: &AgentBinding) -> AgentResult<Value> {
        let mut reconciled_deferred = HashSet::new();
        self.pull_tracking(binding, &mut reconciled_deferred)
            .await
    }

    async fn pull_tracking(
        &self,
        binding: &AgentBinding,
        reconciled_deferred: &mut HashSet<String>,
    ) -> AgentResult<Value> {
        let started = Instant::now();
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let cursor_started = Instant::now();
        self.migrate_cursor_archive_state(&task_space_id).await?;
        let mut cursor = self.read_cursor(&task_space_id).await;
        sync_trace(
            &task_space_id,
            "pull-cursor",
            cursor_started,
            json!({
                "trigger": "pull",
                "revision": cursor.revision,
                "hasPending": cursor.pending.is_some(),
            }),
        );
        let initial_sync = !binding.initial_sync_completed;
        if let Some(pending) = cursor.pending.clone() {
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                let pending_after = self.read_cursor(&task_space_id).await.pending;
                if pending_after.is_some()
                    && result.get("skipped").and_then(Value::as_bool) == Some(true)
                {
                    return Ok(json!({
                        "skipped": true,
                        "reason": result.get("reason").cloned().unwrap_or(Value::Null),
                        "blocked": result.get("blocked").cloned().unwrap_or(Value::Null),
                        "conflicts": [],
                        "revision": cursor.revision,
                        "pendingReview": true,
                    }));
                }
                if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(json!({
                        "conflicts": [result],
                        "revision": cursor.revision,
                        "pendingReview": true,
                    }));
                }
            }
            cursor = self.read_cursor(&task_space_id).await;
        }
        if !initial_sync && cursor.revision_guard_version < REVISION_GUARD_VERSION {
            return Box::pin(self.repair_revision_guard(binding)).await;
        }
        let after_revision = if initial_sync { 0 } else { cursor.revision };
        let http_started = Instant::now();
        let snapshot = self.fetch_snapshot(&task_space_id, after_revision).await?;
        sync_trace(
            &task_space_id,
            "pull-http",
            http_started,
            json!({
                "trigger": "pull",
                "afterRevision": after_revision,
            }),
        );
        let snapshot_controls = parse_snapshot_controls(&snapshot)?;
        if initial_sync {
            return self
                .pull_initial_sync(binding, &snapshot, snapshot_controls.as_deref())
                .await;
        }
        if let Some(controls) = &snapshot_controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }

        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let deleted_dirs: HashSet<String> = snapshot_files
            .iter()
            .filter(|file| file.deleted)
            .map(|file| file.task_dir.clone())
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_binding(binding, &mut server_groups);
        self.prepare_controlled_server_groups(
            binding,
            snapshot_controls.as_deref(),
            &mut server_groups,
        )
        .await?;
        let snapshot_baselines = if after_revision == 0 {
            baselines_from_snapshot(&snapshot_files)
        } else {
            merge_baselines(&cursor.baselines, &snapshot_files)
        };
        let mut latest_revision = snapshot
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();

        let local_started = Instant::now();
        let (dirty_dirs, deferred, exact_reconciled) = self
            .local_sync_state(binding, &cursor, &snapshot_baselines)
            .await?;
        let inactive_dirs = inactive_control_dirs(snapshot_controls.as_deref());
        let dirty_dirs: Vec<String> = dirty_dirs
            .into_iter()
            .filter(|task_dir| !inactive_dirs.contains(task_dir))
            .collect();
        let deferred: BTreeMap<String, BTreeMap<String, String>> = deferred
            .into_iter()
            .filter(|(task_dir, _)| !inactive_dirs.contains(task_dir))
            .collect();
        sync_trace(
            &task_space_id,
            "pull-local",
            local_started,
            json!({
                "trigger": "pull",
                "dirtyDirs": dirty_dirs.len(),
                "deferredDirs": deferred.len(),
            }),
        );
        reconciled_deferred.extend(exact_reconciled);
        if deferred != cursor.deferred {
            self.write_cursor(
                &task_space_id,
                CursorPatch {
                    deferred: Some(deferred.clone()),
                    ..Default::default()
                },
            )
            .await?;
            cursor = self.read_cursor(&task_space_id).await;
        }
        if !dirty_dirs.is_empty() {
            let uploaded = self
                .upload_directories(binding, &dirty_dirs, false, None)
                .await?;
            if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({
                    "skipped": true,
                    "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
                    "blocked": uploaded.get("blocked").cloned().unwrap_or(Value::Null),
                    "conflicts": [],
                    "revision": cursor.revision,
                    "pendingReview": true,
                }));
            }
            if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                return Ok(json!({
                    "conflicts": [uploaded],
                    "revision": cursor.revision,
                    "pendingReview": true,
                }));
            }
            return Box::pin(self.pull_tracking(binding, reconciled_deferred)).await;
        }

        if after_revision == 0 {
            let local_groups = self.local_groups(binding, None).await?;
            let differences = hide_control_tombstone_local_only(
                classify_task_snapshots(&local_groups, &server_groups),
                snapshot_controls.as_deref(),
            );
            let conflict_kinds = [
                DiffKind::ContentConflict,
                DiffKind::MoveDeleteConflict,
                DiffKind::Invalid,
            ];
            let conflicts: Vec<&Difference> = differences
                .iter()
                .filter(|item| conflict_kinds.contains(&item.kind))
                .collect();
            if binding.initial_review_pending || !conflicts.is_empty() {
                self.emit_differences(binding, snapshot_revision(&snapshot), &differences);
                return Ok(json!({
                    "conflicts": conflicts.iter().map(|item| json!({
                        "type": format!("{:?}", item.kind),
                        "taskId": item.task_id,
                        "taskDir": item.task_dir,
                    })).collect::<Vec<_>>(),
                    "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(&snapshot),
                    "pendingReview": true,
                }));
            }
            let server_only: Vec<SnapshotGroup> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::ServerOnly)
                .filter_map(|item| item.server.clone())
                .collect();
            self.apply_server_groups(
                binding,
                snapshot_revision(&snapshot),
                &server_only,
                "safe",
                false,
            )
            .await?;
            let local_only: Vec<String> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::LocalOnly)
                .filter_map(|item| item.local.as_ref().map(|group| group.task_dir.clone()))
                .filter(|task_dir| !deferred.contains_key(task_dir))
                .filter(|task_dir| !inactive_dirs.contains(task_dir))
                .collect();
            if !local_only.is_empty() {
                let uploaded = self
                    .upload_directories(binding, &local_only, false, None)
                    .await?;
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(json!({
                        "skipped": true,
                        "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
                        "conflicts": [],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(&snapshot),
                        "pendingReview": true,
                    }));
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(json!({
                        "conflicts": [uploaded],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(&snapshot),
                        "pendingReview": true,
                    }));
                }
                baseline_files.extend(self.last_baseline_files.lock().await.clone());
            }
        } else {
            let mut changed_dirs: HashSet<String> = server_groups
                .iter()
                .map(|group| group.task_dir.clone())
                .collect();
            changed_dirs.extend(deleted_dirs.iter().cloned());
            let mut by_dir: Vec<SnapshotGroup> = Vec::new();
            for task_dir in changed_dirs {
                let directory = self.fetch_directory(&task_space_id, &task_dir).await?;
                let files = parse_directory_files(&directory, &task_dir)?;
                by_dir.push(SnapshotGroup {
                    task_dir: task_dir.clone(),
                    archived: files.first().map(|file| file.archived).unwrap_or(false),
                    archive_month: files.first().and_then(|file| file.archive_month.clone()),
                    task_id: files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_id(&file.content)),
                    task_branch: files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_metadata(&file.content).1),
                    files,
                });
            }
            retain_server_groups_for_binding(binding, &mut by_dir);
            self.prepare_controlled_server_groups(
                binding,
                snapshot_controls.as_deref(),
                &mut by_dir,
            )
            .await?;
            let protected: HashSet<String> = cursor
                .deferred
                .keys()
                .filter(|task_dir| by_dir.iter().any(|group| &group.task_dir == *task_dir))
                .cloned()
                .collect();
            if !protected.is_empty() {
                let local_groups = self.local_groups(binding, Some(&protected)).await?;
                let changed_groups: Vec<SnapshotGroup> = by_dir
                    .iter()
                    .filter(|group| protected.contains(&group.task_dir))
                    .cloned()
                    .collect();
                let differences = classify_task_snapshots(&local_groups, &changed_groups);
                self.emit_differences(binding, snapshot_revision(&snapshot), &differences);
                return Ok(json!({
                    "conflicts": differences.iter()
                        .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                        .map(Difference::to_control)
                        .collect::<Vec<_>>(),
                    "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(&snapshot),
                    "pendingReview": true,
                }));
            }
            self.apply_server_groups(
                binding,
                snapshot_revision(&snapshot),
                &by_dir,
                "incremental",
                false,
            )
            .await?;
        }

        let baselines = merge_baselines(&snapshot_baselines, &baseline_files);
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(latest_revision),
                baselines: Some(baselines),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(&task_space_id, latest_revision)
            .await?;
        sync_trace(
            &task_space_id,
            "pull-total",
            started,
            json!({
                "trigger": "pull",
                "revision": latest_revision,
            }),
        );
        Ok(json!({ "conflicts": [], "revision": latest_revision }))
    }

    async fn repair_revision_guard(&self, binding: &AgentBinding) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let cursor = self.read_cursor(&task_space_id).await;
        if cursor.revision_guard_version >= REVISION_GUARD_VERSION {
            return Ok(json!({
                "skipped": true,
                "reason": "REVISION_GUARD_CURRENT",
                "revision": cursor.revision,
            }));
        }

        let snapshot = self.fetch_snapshot(&task_space_id, 0).await?;
        let controls = parse_snapshot_controls(&snapshot)?;
        if let Some(controls) = &controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let local_groups = self.local_groups(binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_revision_guard(binding, &mut server_groups);
        self.prepare_controlled_server_groups(
            binding,
            controls.as_deref(),
            &mut server_groups,
        )
        .await?;
        let differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls.as_deref(),
        );
        let server_only: Vec<SnapshotGroup> = differences
            .iter()
            .filter(|item| item.kind == DiffKind::ServerOnly)
            .filter_map(|item| item.server.clone())
            .collect();
        self.apply_server_groups(
            binding,
            snapshot_revision(&snapshot),
            &server_only,
            REVISION_GUARD_SYNC_MODE,
            false,
        )
        .await?;

        let inactive_dirs = inactive_control_dirs(controls.as_deref());
        let mut deferred = cursor.deferred.clone();
        let mut conflicts = Vec::new();
        let mut local_only = Vec::new();
        for difference in &differences {
            match difference.kind {
                DiffKind::Same | DiffKind::ServerOnly => {}
                DiffKind::LocalOnly => {
                    if let Some(local) = difference.local.clone() {
                        if !inactive_dirs.contains(&local.task_dir) {
                            local_only.push(local);
                        }
                    }
                }
                DiffKind::ContentConflict
                | DiffKind::MoveDeleteConflict
                | DiffKind::Invalid => {
                    conflicts.push(difference.to_control());
                    let task_dir = difference
                        .local
                        .as_ref()
                        .map(|group| group.task_dir.clone())
                        .or_else(|| {
                            difference
                                .server
                                .as_ref()
                                .map(|group| group.task_dir.clone())
                        })
                        .unwrap_or_else(|| difference.task_dir.clone());
                    let state = difference
                        .local
                        .as_ref()
                        .map(file_state_from_group)
                        .or_else(|| {
                            difference
                                .server
                                .as_ref()
                                .map(file_state_from_group)
                        })
                        .unwrap_or_default();
                    deferred.insert(task_dir, state);
                }
            }
        }

        let ownership = if local_only.is_empty() {
            OwnershipResolution::default()
        } else {
            self.resolve_task_ownership(binding, &local_only).await?
        };
        for local in &local_only {
            let Some(syncable) = ownership.syncable.get(&local.task_dir) else {
                deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                continue;
            };
            let files: Vec<Value> = syncable
                .files
                .iter()
                .map(|file| {
                    json!({
                        "path": file.path,
                        "content": file.content,
                        "sha256": file.sha256,
                        "baseSha256": Value::Null,
                    })
                })
                .collect();
            let current = self.read_cursor(&task_space_id).await;
            let uploaded = self
                .upload_preclassified_batch(
                    binding,
                    &current,
                    files,
                    ownership.merge_evidence.get(&local.task_dir).cloned(),
                )
                .await?;
            if uploaded.is_none()
                || uploaded.as_ref().is_some_and(|value| {
                    value.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
                        || value.get("skipped").and_then(Value::as_bool) == Some(true)
                })
            {
                deferred.insert(local.task_dir.clone(), file_state_from_group(local));
            }
        }

        let verified = self.fetch_snapshot(&task_space_id, 0).await?;
        let verified_controls = parse_snapshot_controls(&verified)?;
        if let Some(controls) = &verified_controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let verified_files = parse_snapshot_files(&verified)?;
        let verified_server_files: Vec<SnapshotFile> = verified_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut verified_server = groups_from_structs(&verified_server_files)?;
        retain_server_groups_for_revision_guard(binding, &mut verified_server);
        self.prepare_controlled_server_groups(
            binding,
            verified_controls.as_deref(),
            &mut verified_server,
        )
        .await?;
        let verified_local = self.local_groups(binding, None).await?;
        let verified_differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&verified_local, &verified_server),
            verified_controls.as_deref(),
        );
        let unresolved: Vec<&Difference> = verified_differences
            .iter()
            .filter(|item| item.kind != DiffKind::Same)
            .filter(|item| {
                !deferred.contains_key(&item.task_dir)
                    && !item
                        .local
                        .as_ref()
                        .is_some_and(|local| deferred.contains_key(&local.task_dir))
                    && !item
                        .server
                        .as_ref()
                        .is_some_and(|server| deferred.contains_key(&server.task_dir))
            })
            .collect();
        if !unresolved.is_empty() {
            return protocol::err(
                code::INVALID_RESPONSE,
                "revision guard 全量对账未收敛，保留本地任务并等待下次重试",
            );
        }

        let mut baselines = baselines_from_snapshot(&verified_files);
        for task_dir in deferred.keys() {
            let prefix = format!("{task_dir}/");
            baselines.retain(|path_name, _| !path_name.starts_with(&prefix));
            for (path_name, sha256) in &cursor.baselines {
                if path_name.starts_with(&prefix) {
                    baselines.insert(path_name.clone(), sha256.clone());
                }
            }
        }
        let verified_revision = snapshot_revision(&verified);
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(verified_revision),
                revision_guard_version: Some(REVISION_GUARD_VERSION),
                baselines: Some(baselines),
                deferred: Some(deferred.clone()),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(&task_space_id, verified_revision)
            .await?;
        let ownership_pending = self
            .read_cursor(&task_space_id)
            .await
            .ownership_pending;
        self.sync_ownership_inbox(binding, &ownership_pending, &verified_local)
            .await;
        if !conflicts.is_empty() {
            let conflict_differences: Vec<Difference> = verified_differences
                .iter()
                .filter(|item| {
                    deferred.contains_key(&item.task_dir)
                        || item
                            .local
                            .as_ref()
                            .is_some_and(|local| deferred.contains_key(&local.task_dir))
                })
                .cloned()
                .collect();
            self.emit_differences(binding, verified_revision, &conflict_differences);
        }
        Ok(json!({
            "repaired": true,
            "revision": verified_revision,
            "downloaded": server_only.len(),
            "deferred": deferred.keys().cloned().collect::<Vec<_>>(),
            "conflicts": conflicts,
            "pendingReview": !conflicts.is_empty(),
        }))
    }

    async fn pull_initial_sync(
        &self,
        binding: &AgentBinding,
        snapshot: &Value,
        controls: Option<&[TaskControl]>,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        if let Some(controls) = controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let local_groups = self.local_groups(binding, None).await?;
        let snapshot_files = parse_snapshot_files(snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_initial_sync(binding, &local_groups, &mut server_groups);
        self.prepare_controlled_server_groups(binding, controls, &mut server_groups)
            .await?;
        let server_baselines = baselines_from_snapshot(&snapshot_files);
        let differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls,
        );
        let actionable: Vec<&Difference> = differences
            .iter()
            .filter(|item| item.kind != DiffKind::Same)
            .collect();
        let mode = initial_sync_mode(binding);

        if mode == "review" && !actionable.is_empty() {
            self.emit_differences(binding, snapshot_revision(snapshot), &differences);
            return Ok(json!({
                "conflicts": actionable.iter()
                    .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                    .map(|item| item.to_control())
                    .collect::<Vec<_>>(),
                "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                "revision": snapshot_revision(snapshot),
                "pendingReview": true,
            }));
        }

        let mut latest_revision = snapshot_revision(snapshot);
        let mut completion_baselines = server_baselines.clone();
        let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

        if mode == "bootstrap" {
            let blocking: Vec<&Difference> = actionable
                .iter()
                .copied()
                .filter(|item| item.kind != DiffKind::LocalOnly)
                .collect();
            if !blocking.is_empty() {
                self.emit_differences(binding, snapshot_revision(snapshot), &differences);
                return Ok(json!({
                    "conflicts": blocking.iter()
                        .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                        .map(|item| item.to_control())
                        .collect::<Vec<_>>(),
                    "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(snapshot),
                    "pendingReview": true,
                }));
            }
            let inactive_dirs = inactive_control_dirs(controls);
            let local_only: Vec<String> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::LocalOnly)
                .filter_map(|item| item.local.as_ref().map(|group| group.task_dir.clone()))
                .filter(|task_dir| !inactive_dirs.contains(task_dir))
                .collect();
            if !local_only.is_empty() {
                let uploaded = self
                    .upload_directories(binding, &local_only, false, None)
                    .await?;
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(json!({
                        "conflicts": [uploaded],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(snapshot),
                        "pendingReview": true,
                    }));
                }
                completion_baselines = merge_baselines(
                    &completion_baselines,
                    &self.last_baseline_files.lock().await.clone(),
                );
            }
        } else if mode == "safe" {
            let server_only: Vec<SnapshotGroup> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::ServerOnly)
                .filter_map(|item| item.server.clone())
                .collect();
            self.apply_server_groups(
                binding,
                snapshot_revision(snapshot),
                &server_only,
                "safe",
                false,
            )
            .await?;
            for difference in &actionable {
                if difference.kind == DiffKind::ServerOnly {
                    continue;
                }
                if let Some(local) = &difference.local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
            }
        }

        if mode == "bootstrap" {
            let verified = self.fetch_snapshot(&task_space_id, 0).await?;
            let verified_controls = parse_snapshot_controls(&verified)?;
            if let Some(controls) = &verified_controls {
                self.merge_task_controls(binding, controls).await?;
                self.release_inactive_task_leases(Some(controls)).await;
                self.process_handoff_controls(binding, controls).await?;
            }
            let verified_local = self.local_groups(binding, None).await?;
            let verified_files = parse_snapshot_files(&verified)?;
            let verified_server_files: Vec<SnapshotFile> = verified_files
                .iter()
                .filter(|file| !file.deleted)
                .cloned()
                .collect();
            let mut verified_server = groups_from_structs(&verified_server_files)?;
            self.prepare_controlled_server_groups(
                binding,
                verified_controls.as_deref(),
                &mut verified_server,
            )
            .await?;
            let verified_differences = hide_control_tombstone_local_only(
                classify_task_snapshots(&verified_local, &verified_server),
                verified_controls.as_deref(),
            );
            let unresolved = verified_differences
                .iter()
                .filter(|item| item.kind != DiffKind::Same)
                .count();
            if unresolved > 0 {
                self.emit_differences(binding, snapshot_revision(&verified), &verified_differences);
                return Ok(json!({
                    "conflicts": verified_differences.iter()
                        .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                        .map(|item| item.to_control())
                        .collect::<Vec<_>>(),
                    "differences": verified_differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(&verified),
                    "pendingReview": true,
                }));
            }
            latest_revision = latest_revision.max(snapshot_revision(&verified));
            completion_baselines = baselines_from_snapshot(&verified_files);
        }

        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(latest_revision),
                baselines: Some(completion_baselines),
                deferred: Some(deferred),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(&task_space_id, latest_revision)
            .await?;
        self.complete_initial_sync(&task_space_id, &mode).await?;
        Ok(json!({
            "conflicts": [],
            "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
            "revision": latest_revision,
            "pendingReview": false,
        }))
    }

    fn emit_differences(&self, binding: &AgentBinding, revision: u64, differences: &[Difference]) {
        (self.emit)(json!({
            "type": "initial_sync_review",
            "taskSpaceId": binding.task_space_id,
            "revision": revision,
            "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
        }));
    }

    async fn complete_initial_sync(&self, task_space_id: &str, mode: &str) -> AgentResult<()> {
        self.write_cursor(
            task_space_id,
            CursorPatch {
                revision_guard_version: Some(REVISION_GUARD_VERSION),
                ..Default::default()
            },
        )
        .await?;
        let completed_at = protocol::now_iso8601();
        {
            let mut bindings = self.bindings.lock().await;
            if let Some(binding) = bindings.get_mut(task_space_id) {
                binding.initial_sync_mode = mode.to_string();
                binding.initial_sync_completed = true;
                binding.initial_review_pending = false;
                binding.live_sync_status = "ready".into();
                binding.live_sync_error = None;
                binding.last_synced_at = Some(completed_at.clone());
            }
        }
        self.store
            .update_config(true, |current| {
                let Some(config) = current else {
                    return Ok(None);
                };
                let mut next = config.clone();
                for binding in &mut next.bindings {
                    if binding.task_space_id == task_space_id {
                        binding.initial_sync_mode = mode.to_string();
                        binding.initial_sync_completed = true;
                        binding.initial_review_pending = false;
                        binding.live_sync_status = "ready".into();
                        binding.live_sync_error = None;
                        binding.last_synced_at = Some(completed_at.clone());
                    }
                }
                Ok(Some(next))
            })
            .await?;
        self.notify_state_changed();
        Ok(())
    }

    async fn upload_dirty(
        &self,
        task_space_id: &str,
        dirty_paths: &[String],
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let mut task_dirs: HashSet<String> = HashSet::new();
        for dirty_path in dirty_paths {
            let Some(task_dir) = active_task_directory_from_relative(dirty_path) else {
                continue;
            };
            if self.suppressed_event(&binding, dirty_path).await {
                continue;
            }
            task_dirs.insert(task_dir);
        }
        if task_dirs.is_empty() {
            return Ok(Value::Null);
        }
        let dirs: Vec<String> = task_dirs.into_iter().collect();
        self.upload_directories(&binding, &dirs, true, None).await
    }

    /// 启动或绑定更新后，为已经存在于基线 HEAD 的错分支任务补一次合入证据。
    async fn reconcile_baseline_tasks(
        &self,
        task_space_id: &str,
        reconciled_deferred_dirs: &HashSet<String>,
    ) -> AgentResult<Value> {
        let config = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"))?;
        let Some(binding) = config.bindings.into_iter().find(|binding| {
            binding.task_space_id == task_space_id
                && binding.sync_status == "approved"
                && !binding.detach_pending
        }) else {
            return Ok(json!({
                "skipped": true,
                "reason": "BINDING_INACTIVE",
            }));
        };
        if binding.read_only
            || !binding.initial_sync_completed
            || binding.baseline_branch.as_deref() != Some(binding.branch_name.as_str())
        {
            return Ok(json!({
                "skipped": true,
                "reason": "BASELINE_RECONCILIATION_NOT_REQUIRED",
            }));
        }
        let cursor = self.read_cursor(task_space_id).await;
        let indexed_head = {
            self.ensure_ownership_index_loaded().await;
            let index = self.ownership_index.lock().await;
            index
                .bindings
                .get(&binding.local_id)
                .filter(|entry| {
                    entry.task_space_id == binding.task_space_id
                        && entry.repo_path == binding.repo_path
                        && entry.branch_name == binding.branch_name
                        && entry.baseline_branch == binding.baseline_branch
                })
                .map(|entry| (entry.head_commit.clone(), entry.head_fingerprint.clone()))
        };
        if let Some((head_commit, head_fingerprint)) = &indexed_head {
            if !head_commit.is_empty()
                && !head_fingerprint.is_empty()
                && &cursor.baseline_reconciled_head == head_commit
            {
                if std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some() {
                    crate::logging::warn(&format!(
                        "基线任务补交跳过 taskSpaceId={}",
                        binding.task_space_id
                    ));
                }
                return Ok(json!({
                    "skipped": true,
                    "reason": "BASELINE_RECONCILIATION_CURRENT",
                }));
            }
        }
        let groups = self.local_groups(&binding, None).await?;
        let mut task_dirs: Vec<String> = groups
            .iter()
            .filter(|group| {
                !cursor.deferred.contains_key(&group.task_dir)
                    && !reconciled_deferred_dirs.contains(&group.task_dir)
                    && group
                        .task_branch
                        .as_deref()
                        .is_some_and(|branch| branch != binding.branch_name)
            })
            .map(|group| group.task_dir.clone())
            .collect();
        task_dirs.sort_unstable();
        if task_dirs.is_empty() {
            return Ok(json!({
                "skipped": true,
                "reason": "BASELINE_RECONCILIATION_NOT_REQUIRED",
            }));
        }
        let result = self
            .upload_directories(&binding, &task_dirs, false, None)
            .await?;
        if result.get("skipped").and_then(Value::as_bool) == Some(true)
            || result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
        {
            return Ok(result);
        }
        let Some((head_commit, expected_fingerprint)) = indexed_head else {
            return Ok(result);
        };
        if git_head_fingerprint(Path::new(&binding.repo_path))
            .await
            .as_deref()
            != Some(expected_fingerprint.as_str())
        {
            return Ok(result);
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                baseline_reconciled_head: Some(head_commit),
                ..Default::default()
            },
        )
        .await?;
        if std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some() {
            crate::logging::warn(&format!(
                "基线任务补交完成 taskSpaceId={} candidates={}",
                binding.task_space_id,
                task_dirs.len()
            ));
        }
        Ok(result)
    }

    pub(crate) async fn claim_execution_task(
        &self,
        task_space_id: &str,
        execution_task_key: &str,
    ) -> AgentResult<Value> {
        if !execution_task_key.starts_with(&format!("{task_space_id}::")) {
            return protocol::err(code::COMMAND_INVALID, "任务执行身份与当前任务空间不一致");
        }
        let binding = self.binding(task_space_id).await?;
        let (control, _) = self
            .claim_remote_task(&binding, execution_task_key)
            .await?;
        Ok(json!({
            "executionTaskKey": control.execution_task_key,
            "taskId": control.task_id,
            "taskVersion": control.task_version,
            "state": control.state,
            "handoffState": control.handoff_state,
        }))
    }

    pub async fn sync_task_directories(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
        reconcile: bool,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let serial = self.task_space_sync_lock(task_space_id).await;
        let _serial = serial.lock().await;
        self.upload_directories(&binding, task_dirs, reconcile, None)
            .await
    }

    pub async fn sync_task_directories_with_base(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
        base_sha: Option<&BTreeMap<String, String>>,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let serial = self.task_space_sync_lock(task_space_id).await;
        let _serial = serial.lock().await;
        self.upload_directories(&binding, task_dirs, false, base_sha)
            .await
    }

    pub async fn list_task_ownership(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        let groups = self.local_groups(&binding, None).await?;
        let local_dirs: HashSet<String> =
            groups.iter().map(|group| group.task_dir.clone()).collect();
        let cursor = self.read_cursor(task_space_id).await;
        self.clear_ownership_pending(
            task_space_id,
            &cursor
                .ownership_pending
                .keys()
                .filter(|task_dir| !local_dirs.contains(*task_dir))
                .cloned()
                .collect::<Vec<_>>(),
        )
        .await?;
        self.sync_ownership_inbox(
            &binding,
            &cursor.ownership_pending,
            &groups,
        )
        .await;
        let candidates: Vec<SnapshotGroup> = groups
            .into_iter()
            .filter(|group| {
                group
                    .task_branch
                    .as_deref()
                    .map(|branch| branch != binding.branch_name)
                    .unwrap_or(false)
                    || cursor.ownership_pending.contains_key(&group.task_dir)
            })
            .collect();
        let resolution = self.resolve_task_ownership(&binding, &candidates).await?;
        let mut project_task_spaces = resolution.project_task_spaces.clone();
        if let Ok(result) = self
            .fetch_task_ownership(&binding.task_space_id, &[])
            .await
        {
            if let Some(items) = result
                .get("projectTaskSpaces")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                project_task_spaces = items.clone();
            }
        }
        let mut items: Vec<Value> = resolution
            .paused
            .iter()
            .map(|group| {
                json!({
                    "taskId": group.task_id,
                    "taskDir": group.task_dir,
                    "title": task_title(group).or_else(|| group.task_id.clone()),
                    "branchName": group.task_branch,
                    "suggestedBranchName": Value::Null,
                    "choices": project_task_spaces.clone(),
                })
            })
            .collect();
        items.extend(resolution.reviews.iter().map(|review| {
            json!({
                "taskId": review.group.task_id,
                "taskDir": review.group.task_dir,
                "title": task_title(&review.group).or_else(|| review.group.task_id.clone()),
                "branchName": review.group.task_branch,
                "suggestedBranchName": Value::Null,
                "choices": project_task_spaces.clone(),
            })
        }));
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "projectTaskSpaces": project_task_spaces,
            "items": items,
        }))
    }

    pub async fn set_task_ownership(
        &self,
        task_space_id: &str,
        decisions: Value,
    ) -> AgentResult<Value> {
        let raw = decisions
            .as_array()
            .cloned()
            .ok_or_else(|| AgentError::new(code::CONFIG_INVALID, "任务归属决定必须是数组"))?;
        if raw.is_empty() || raw.len() > TASK_OWNERSHIP_QUERY_LIMIT {
            return protocol::err(
                code::CONFIG_INVALID,
                "任务归属决定必须包含 1 到 200 个任务",
            );
        }
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        let groups = self.local_groups(&binding, None).await?;
        let groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut normalized = Vec::with_capacity(raw.len());
        let mut seen = HashSet::new();
        for item in raw {
            let task_dir = item
                .get("taskDir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
                != Some(task_dir.as_str())
                || !groups_by_dir.contains_key(&task_dir)
            {
                return protocol::err(code::CONFIG_INVALID, "任务归属决定包含无效的任务目录");
            }
            if !seen.insert(task_dir.clone()) {
                return protocol::err(code::CONFIG_INVALID, "同一任务不能重复提交归属决定");
            }
            let action = item
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if action != "use-branch" && action != "defer" {
                return protocol::err(code::CONFIG_INVALID, "任务归属动作无效");
            }
            let branch_name = item
                .get("branchName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if action == "use-branch" && branch_name.is_empty() {
                return protocol::err(code::CONFIG_INVALID, "归属任务时必须选择有效分支");
            }
            normalized.push(OwnershipDecision {
                task_dir,
                action,
                branch_name,
            });
        }

        let task_ids: Vec<String> = normalized
            .iter()
            .filter_map(|decision| groups_by_dir.get(&decision.task_dir)?.task_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let ownership = if normalized
            .iter()
            .any(|decision| decision.action == "use-branch")
        {
            self.fetch_task_ownership(&binding.task_space_id, &task_ids)
                .await?
        } else {
            json!({ "projectTaskSpaces": [] })
        };
        let mut allowed_branches: HashSet<String> = ownership
            .get("projectTaskSpaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|space| space.get("branchName").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        allowed_branches.insert(binding.branch_name.clone());
        for decision in &normalized {
            if decision.action == "use-branch"
                && !allowed_branches.contains(&decision.branch_name)
            {
                return protocol::err(
                    code::CONFIG_INVALID,
                    "只能把任务归属到当前项目可见的有效分支",
                );
            }
        }

        let cursor = self.read_cursor(task_space_id).await;
        let mut pending = cursor.ownership_pending.clone();
        let mut current_branch = Vec::new();
        let mut applied = 0usize;
        let mut deferred = 0usize;
        for decision in &normalized {
            if decision.action == "defer" {
                let group = groups_by_dir
                    .get(&decision.task_dir)
                    .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "本地任务不存在"))?;
                pending.insert(decision.task_dir.clone(), task_fingerprint(group));
                deferred += 1;
                continue;
            }
            crate::agent::task_command::set_task_directory_branch(
                Path::new(&binding.repo_path),
                &decision.task_dir,
                &decision.branch_name,
            )
            .await?;
            pending.remove(&decision.task_dir);
            applied += 1;
            if decision.branch_name == binding.branch_name {
                current_branch.push(decision.task_dir.clone());
            }
        }
        if pending != cursor.ownership_pending {
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    ownership_pending: Some(pending),
                    ..Default::default()
                },
            )
            .await?;
        }
        self.clear_pending_rejections(
            task_space_id,
            &normalized
                .iter()
                .map(|decision| decision.task_dir.clone())
                .collect::<Vec<_>>(),
        )
        .await?;
        let ownership_groups: Vec<SnapshotGroup> =
            groups_by_dir.values().cloned().collect();
        self.sync_ownership_inbox(
            &binding,
            &cursor.ownership_pending,
            &ownership_groups,
        )
        .await;
        let sync = if current_branch.is_empty() {
            Value::Null
        } else {
            self.sync_task_directories(task_space_id, &current_branch, true)
                .await?
        };
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "appliedCount": applied,
            "deferredCount": deferred,
            "currentBranchCount": current_branch.len(),
            "sync": sync,
        }))
    }

    /// 显式补同步首次同步时暂缓的本地任务目录（对照 JS `syncDeferredTasks`）。
    pub async fn sync_deferred_tasks(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        if binding.read_only {
            return protocol::err(code::COMMAND_INVALID, "只读关联不能上传本地任务");
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let mut task_dirs: Vec<String> = cursor.deferred.keys().cloned().collect();
        if task_dirs.is_empty() {
            return Ok(json!({
                "taskSpaceId": binding.task_space_id,
                "syncedCount": 0,
                "remainingCount": 0,
                "remainingTaskDirs": [],
                "conflict": false,
                "conflictId": Value::Null,
            }));
        }
        task_dirs.sort_unstable();
        let uploaded = self
            .upload_directories(&binding, &task_dirs, true, None)
            .await?;
        let next = self.read_cursor(&binding.task_space_id).await;
        let mut remaining: Vec<String> = next.deferred.keys().cloned().collect();
        remaining.sort_unstable();
        let skipped = uploaded.get("skipped").and_then(Value::as_bool) == Some(true);
        let conflict = uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT");
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "syncedCount": if conflict || skipped { 0 } else { task_dirs.len().saturating_sub(remaining.len()) },
            "remainingCount": remaining.len(),
            "remainingTaskDirs": remaining,
            "skipped": skipped,
            "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
            "conflict": conflict,
            "conflictId": if conflict {
                uploaded.get("conflictId").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        }))
    }

    async fn upload_directories(
        &self,
        binding: &AgentBinding,
        task_dirs: &[String],
        reconcile: bool,
        base_sha: Option<&BTreeMap<String, String>>,
    ) -> AgentResult<Value> {
        let started = Instant::now();
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let cursor_started = Instant::now();
        self.migrate_cursor_archive_state(&task_space_id).await?;
        let mut cursor = self.read_cursor(&task_space_id).await;
        sync_trace(
            &task_space_id,
            "upload-cursor",
            cursor_started,
            json!({
                "trigger": "upload",
                "revision": cursor.revision,
                "hasPending": cursor.pending.is_some(),
            }),
        );
        let mut applied_revision = cursor.revision;
        let mut committed_revision = 0u64;
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        let mut prehandled_dirs = HashSet::new();
        let mut pending_outcome = None;
        let mut last_nonblocking_skip = None;
        let mut uploaded_any = false;
        if let Some(pending) = cursor.pending.clone() {
            let retry_files = pending.files.clone();
            let retry_dirs = pending_task_dirs(&retry_files);
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                let pending_after = self.read_cursor(&task_space_id).await.pending;
                if pending_after.is_some()
                    || result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
                {
                    return Ok(result);
                }
                if result.get("skipped").and_then(Value::as_bool) != Some(true) {
                    committed_revision = committed_revision.max(
                        result
                            .get("revision")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    );
                    baseline_files.extend(parse_snapshot_files_from_values(&retry_files)?);
                }
                prehandled_dirs.extend(retry_dirs);
                pending_outcome = Some(result);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }
        if cursor.revision_guard_version < REVISION_GUARD_VERSION
            && binding.initial_sync_completed
        {
            return Box::pin(self.repair_revision_guard(binding)).await;
        }

        self.ensure_task_control_loaded().await;
        let inactive_control_dirs: HashSet<String> = {
            let state = self.task_control_state.lock().await;
            state
                .controls_for_binding(&binding.local_id, &binding.task_space_id)
                .filter(|(_, control)| !control.control_state().is_writable_local())
                .map(|(_, control)| control.relative_dir.clone())
                .collect()
        };
        let requested: HashSet<String> = task_dirs
            .iter()
            .filter(|task_dir| !is_archive_task_dir(task_dir))
            .filter(|task_dir| !inactive_control_dirs.contains(*task_dir))
            .filter(|task_dir| !prehandled_dirs.contains(*task_dir))
            .cloned()
            .collect();
        if requested.is_empty() {
            if let Some(result) = pending_outcome {
                return Ok(result);
            }
            return Ok(json!({
                "skipped": true,
                "reason": if task_dirs.iter().all(|task_dir| {
                    is_archive_task_dir(task_dir) || inactive_control_dirs.contains(task_dir)
                }) {
                    "TASK_CONTROL_INACTIVE"
                } else {
                    "ARCHIVE_SYNC_SERVER_MANAGED"
                },
            }));
        }
        let local_started = Instant::now();
        let local_groups = self
            .local_groups(binding, Some(&requested))
            .await?;
        sync_trace(
            &task_space_id,
            "upload-local",
            local_started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "localGroups": local_groups.len(),
            }),
        );
        let ownership_started = Instant::now();
        let ownership = self.resolve_task_ownership(binding, &local_groups).await?;
        sync_trace(
            &task_space_id,
            "upload-ownership",
            ownership_started,
            json!({
                "trigger": "upload",
                "syncable": ownership.syncable.len(),
                "paused": ownership.paused.len(),
                "reviews": ownership.reviews.len(),
            }),
        );
        let blocked_dirs: HashSet<String> = cursor.conflict_blocked.keys().cloned().collect();
        let allowed: Vec<String> = requested
            .iter()
            .filter(|task_dir| {
                if blocked_dirs.contains(*task_dir) {
                    return false;
                }
                !local_groups
                    .iter()
                    .any(|group| &group.task_dir == *task_dir)
                    || ownership.syncable.contains_key(*task_dir)
            })
            .cloned()
            .collect();
        if allowed.is_empty() {
            let reason = if !ownership.reviews.is_empty() || !ownership.invalid.is_empty() {
                "TASK_OWNERSHIP_REQUIRED"
            } else if !ownership.paused.is_empty() {
                "TASK_BRANCH_OTHER"
            } else {
                "TASK_CONFLICT_PENDING"
            };
            return Ok(json!({
                "skipped": true,
                "reason": reason,
                "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                "invalid": ownership.invalid,
            }));
        }
        let local_by_dir: HashMap<String, SnapshotGroup> = local_groups
            .iter()
            .cloned()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut entries: Vec<(String, Option<SnapshotGroup>, Vec<SnapshotFile>)> = Vec::new();
        let unique: HashSet<String> = allowed.into_iter().collect();
        let http_started = Instant::now();
        for task_dir in unique {
            let server_files = match self.fetch_directory(&task_space_id, &task_dir).await {
                Ok(server) => parse_directory_files(&server, &task_dir)?,
                Err(error) if error.status == Some(404) => Vec::new(),
                Err(error) => return Err(error),
            };
            entries.push((
                task_dir.clone(),
                local_by_dir.get(&task_dir).cloned(),
                server_files,
            ));
        }
        sync_trace(
            &task_space_id,
            "upload-http",
            http_started,
            json!({
                "trigger": "upload",
                "directories": entries.len(),
            }),
        );

        let mut handled: HashSet<String> = HashSet::new();
        for (source, target) in move_pairs(&entries) {
            let mut files = build_directory_files(
                &source.0,
                None,
                &source.2,
                base_sha.unwrap_or(&cursor.baselines),
            );
            files.extend(build_directory_files(
                &target.0,
                target.1.as_ref(),
                &target.2,
                base_sha.unwrap_or(&cursor.baselines),
            ));
            let value: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
            let evidence = ownership
                .merge_evidence
                .get(&target.0)
                .or_else(|| ownership.merge_evidence.get(&source.0))
                .cloned();
            if let Some(uploaded) = self
                .upload_persisted_batch(binding, &cursor, value, evidence)
                .await?
            {
                if skipped_for_explicit_pending_rejection(&uploaded) {
                    if self.read_cursor(&task_space_id).await.pending.is_none() {
                        handled.insert(source.0.clone());
                        handled.insert(target.0.clone());
                        last_nonblocking_skip = Some(uploaded);
                        continue;
                    }
                }
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                uploaded_any = true;
                handled.insert(source.0.clone());
                handled.insert(target.0.clone());
                committed_revision = committed_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
                baseline_files.extend(uploads_to_snapshot_files(&files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        for (task_dir, local, server_files) in &entries {
            if handled.contains(task_dir) {
                continue;
            }
            let files = build_directory_files(
                task_dir,
                local.as_ref(),
                server_files,
                base_sha.unwrap_or(&cursor.baselines),
            );
            let value: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
            let evidence = ownership.merge_evidence.get(task_dir).cloned();
            if let Some(uploaded) = self
                .upload_persisted_batch(binding, &cursor, value, evidence)
                .await?
            {
                if skipped_for_explicit_pending_rejection(&uploaded) {
                    if self.read_cursor(&task_space_id).await.pending.is_none() {
                        last_nonblocking_skip = Some(uploaded);
                        continue;
                    }
                }
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                uploaded_any = true;
                committed_revision = committed_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
                baseline_files.extend(uploads_to_snapshot_files(&files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        self.last_baseline_files
            .lock()
            .await
            .clone_from(&baseline_files);
        sync_trace(
            &task_space_id,
            "upload",
            started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "baselineFiles": baseline_files.len(),
                "revision": applied_revision,
                "committedRevision": committed_revision,
            }),
        );

        if reconcile {
            Box::pin(self.pull(binding)).await?;
            applied_revision = self.read_cursor(&task_space_id).await.revision;
        }
        if !uploaded_any {
            if let Some(result) = last_nonblocking_skip {
                return Ok(result);
            }
        }
        sync_trace(
            &task_space_id,
            "upload-total",
            started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "reconcile": reconcile,
                "revision": applied_revision,
                "committedRevision": committed_revision,
            }),
        );
        Ok(json!({
            "revision": applied_revision,
            "committedRevision": committed_revision,
            "sequence": cursor.sequence,
            "baselineFiles": baseline_files.iter().map(|file| json!({
                "path": file.path,
                "sha256": file.sha256,
            })).collect::<Vec<_>>(),
        }))
    }

    async fn upload_persisted_batch(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        files: Vec<Value>,
        merge_evidence: Option<Value>,
    ) -> AgentResult<Option<Value>> {
        if files.is_empty() {
            return Ok(None);
        }
        validate_upload_batch(&files)?;
        let batch = PendingBatch {
            batch_id: uuid::Uuid::new_v4().to_string(),
            client_sequence: next_client_sequence(cursor.sequence),
            files,
            merge_evidence,
            created_at: protocol::now_iso8601(),
        };
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                revision: Some(cursor.revision),
                sequence: Some(cursor.sequence),
                pending: Some(Some(batch.clone())),
                ..Default::default()
            },
        )
        .await?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::New).await?,
        ))
    }

    async fn upload_preclassified_batch(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        files: Vec<Value>,
        merge_evidence: Option<Value>,
    ) -> AgentResult<Option<Value>> {
        if files.is_empty() {
            return Ok(None);
        }
        validate_upload_batch(&files)?;
        let batch = PendingBatch {
            batch_id: uuid::Uuid::new_v4().to_string(),
            client_sequence: next_client_sequence(cursor.sequence),
            files,
            merge_evidence,
            created_at: protocol::now_iso8601(),
        };
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                pending: Some(Some(batch.clone())),
                ..Default::default()
            },
        )
        .await?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::Preclassified)
                .await?,
        ))
    }

    async fn retry_pending_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
    ) -> AgentResult<Option<Value>> {
        validate_upload_batch(&batch.files)?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::Replay)
                .await?,
        ))
    }

    async fn upload_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
        mode: UploadMode,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let mut execution_task_keys =
            execution_task_keys_from_upload(&task_space_id, &batch.files)?;
        if execution_task_keys.is_empty() {
            if let Some(execution_task_key) = self
                .persisted_control_key_for_upload(binding, &batch.files)
                .await?
            {
                execution_task_keys.insert(execution_task_key);
            }
        }
        if execution_task_keys.len() > 1 {
            return protocol::err(
                code::INVALID_RESPONSE,
                "单个上传批次不能包含多个执行任务身份",
            );
        }
        let upload_execution_task_key = execution_task_keys.iter().next().cloned();
        let mut fence = None;
        if let Some(execution_task_key) = upload_execution_task_key.as_ref() {
            if let Some(control) = self
                .remote_task_control(binding, execution_task_key)
                .await?
            {
                if !control.is_writable_local() {
                    self.write_cursor(
                        &task_space_id,
                        CursorPatch {
                            pending: Some(None),
                            ..Default::default()
                        },
                    )
                    .await?;
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_CONTROL_INACTIVE",
                        "controlState": control.state,
                    }));
                }
                let fenced = if let Some(stored_lease) = self
                    .stored_task_lease(execution_task_key)
                    .await
                {
                    match self
                        .heartbeat_remote_task(
                            binding,
                            execution_task_key,
                            &stored_lease.token,
                        )
                        .await
                    {
                        Ok(value) => Ok(value),
                        Err(error)
                            if matches!(
                                error.server_code.as_deref(),
                                Some("TASK_LEASE_INVALID")
                                    | Some("TASK_LEASE_REQUIRED")
                            ) =>
                        {
                            self.claim_remote_task(binding, execution_task_key)
                                .await
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    self.claim_remote_task(binding, execution_task_key)
                        .await
                };
                match fenced {
                    Ok((claimed, lease_token)) => {
                        fence = Some(UploadFence {
                            task_version: claimed.task_version,
                            lease_token,
                        });
                    }
                    Err(error)
                        if matches!(
                            error.server_code.as_deref(),
                            Some("TASK_ARCHIVED")
                                | Some("TASK_WRITE_FORBIDDEN")
                                | Some("FORBIDDEN")
                        ) =>
                    {
                        self.write_cursor(
                            &task_space_id,
                            CursorPatch {
                                pending: Some(None),
                                ..Default::default()
                            },
                        )
                        .await?;
                        return Ok(json!({
                            "skipped": true,
                            "reason": error.server_code,
                            "message": error.message,
                        }));
                    }
                    Err(error)
                        if matches!(
                            error.server_code.as_deref(),
                            Some("TASK_LEASE_HELD") | Some("TASK_LEASE_INVALID")
                        ) =>
                    {
                        return Ok(json!({
                            "skipped": true,
                            "reason": error.server_code,
                            "message": error.message,
                        }));
                    }
                    Err(error) => return Err(error),
                }
            } else if self.has_persisted_task_control(execution_task_key).await {
                self.write_cursor(
                    &task_space_id,
                    CursorPatch {
                        pending: Some(None),
                        ..Default::default()
                    },
                )
                .await?;
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_CONTROL_MISSING",
                    "message": "服务端已没有该任务控制记录，本地任务保留并停止自动上传",
                }));
            }
        }
        let task_dirs = pending_task_dirs(&batch.files);
        let cursor = self.read_cursor(&task_space_id).await;
        let blocked: Vec<Value> = task_dirs
            .iter()
            .filter_map(|task_dir| {
                cursor
                    .conflict_blocked
                    .get(task_dir)
                    .map(|conflict_id| json!({ "taskDir": task_dir, "conflictId": conflict_id }))
            })
            .collect();
        if !blocked.is_empty() {
            return Ok(json!({
                "skipped": true,
                "reason": "TASK_CONFLICT_PENDING",
                "blocked": blocked,
            }));
        }
        if mode == UploadMode::New {
            let local_groups = self.local_groups(binding, Some(&task_dirs)).await?;
            for group in &local_groups {
                let Some(current_task_json) = group
                    .files
                    .iter()
                    .find(|file| file.file_path == "task.json" && !file.deleted)
                else {
                    continue;
                };
                let Some(pending_task_json) = batch.files.iter().find(|file| {
                    file.get("path").and_then(Value::as_str)
                        == Some(current_task_json.path.as_str())
                }) else {
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_OWNERSHIP_PENDING_MISMATCH",
                        "taskDir": group.task_dir,
                    }));
                };
                let pending_branch = pending_task_json
                    .get("content")
                    .and_then(Value::as_str)
                    .map(parse_task_metadata)
                    .and_then(|metadata| metadata.1);
                let current_branch = parse_task_metadata(&current_task_json.content).1;
                if pending_branch != current_branch {
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_OWNERSHIP_PENDING_MISMATCH",
                        "taskDir": group.task_dir,
                    }));
                }
            }
            let ownership = self.resolve_task_ownership(binding, &local_groups).await?;
            if local_groups.iter().any(|group| {
                !ownership.syncable.contains_key(&group.task_dir)
                    && !ownership
                        .paused
                        .iter()
                        .any(|paused| paused.task_dir == group.task_dir)
            }) {
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_OWNERSHIP_REQUIRED",
                    "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
                    "invalid": ownership.invalid,
                }));
            }
            if !ownership.paused.is_empty() {
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_BRANCH_OTHER",
                    "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                }));
            }
        }
        let mut active_sequence = batch.client_sequence;
        let mut sequence_recovered = false;
        let mut retry_delay = Duration::ZERO;
        let mut attempt = 0u32;
        let result = loop {
            // 每次尝试都重新校验分支，并把实际分支名带给服务端。
            let observed = self.assert_binding_branch(binding).await?;
            let request =
                build_upload_request(&batch, active_sequence, &observed, fence.as_ref());
            match self
                .upload_with_slot(&task_space_id, retry_delay, &request)
                .await
            {
                Ok(value) => break value,
                Err(error) if error.server_code.as_deref() == Some("TASK_FILE_CONFLICT") => {
                    break json!({
                        "code": "TASK_FILE_CONFLICT",
                        "conflictId": error.conflict_id,
                        "message": error.message,
                        "details": error.details,
                    });
                }
                Err(error) if error.server_code.as_deref() == Some("TASK_OWNED_BY_BASELINE") => {
                    if let Some(task_id) = error
                        .details
                        .as_ref()
                        .and_then(|details| details.get("taskId"))
                        .and_then(Value::as_str)
                    {
                        self.mark_baseline_owned(&task_space_id, task_id).await;
                    }
                    break json!({
                        "skipped": true,
                        "reason": "TASK_OWNED_BY_BASELINE",
                        "details": error.details,
                    });
                }
                Err(error)
                    if error
                        .server_code
                        .as_deref()
                        .is_some_and(is_explicit_pending_rejection) =>
                {
                    break json!({
                        "skipped": true,
                        "rejected": true,
                        "reason": error.server_code,
                        "message": error.message,
                        "details": error.details,
                    });
                }
                Err(error) if error.status == Some(429) && error.retryable => {
                    if attempt >= MAX_RATE_LIMIT_RETRIES {
                        return Err(error);
                    }
                    attempt += 1;
                    retry_delay = error
                        .retry_after_ms
                        .map(|value| {
                            Duration::from_millis(
                                value.min(RATE_LIMIT_RETRY_MAX_DELAY.as_millis() as u64),
                            )
                        })
                        .unwrap_or(RATE_LIMIT_RETRY_DELAY);
                }
                Err(error) => {
                    // 游标落后于服务端时，按服务端给出的最小序号改写待上传批次后重试一次。
                    let required = required_client_sequence(&error);
                    match required {
                        Some(required) if !sequence_recovered && required > active_sequence => {
                            crate::logging::warn(&format!(
                                "上传序号落后于服务端，改用 {required} 重试 {}",
                                batch.batch_id
                            ));
                            self.update_pending_client_sequence(
                                &task_space_id,
                                &batch.batch_id,
                                required,
                            )
                            .await?;
                            active_sequence = required;
                            sequence_recovered = true;
                            let _ = self.read_cursor(&task_space_id).await;
                            retry_delay = Duration::ZERO;
                        }
                        _ => return Err(error),
                    }
                }
            }
        };

        let mut persisted_execution_task_key = upload_execution_task_key.clone();
        if let Some(task) = result
            .get("control")
            .and_then(|control| control.get("task"))
            .filter(|task| !task.is_null())
        {
            let control = TaskControl::from_task_value(task)?;
            persisted_execution_task_key = Some(response_control_execution_task_key(
                upload_execution_task_key.as_deref(),
                &control,
            )?);
            self.upsert_task_control(binding, &control).await?;
        }
        if let Some(execution_task_key) = persisted_execution_task_key.as_deref() {
            if let Some(lease) = result.get("lease").filter(|lease| !lease.is_null()) {
                self.save_task_lease(execution_task_key, lease.clone()).await?;
            }
            if let Some(task_version) = result.get("taskVersion").and_then(Value::as_u64) {
                self.update_control_task_version(execution_task_key, task_version)
                    .await?;
            }
        }
        let cursor = self.read_cursor(&task_space_id).await;
        if let Some(reason) = result
            .get("reason")
            .and_then(Value::as_str)
            .filter(|value| is_explicit_pending_rejection(value))
        {
            let rejected_batch = PendingBatch {
                client_sequence: active_sequence,
                ..batch.clone()
            };
            self.settle_rejected_pending(binding, &rejected_batch, reason)
                .await?;
            return Ok(result);
        }
        if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
            self.mark_conflict_blocked(&task_space_id, &result, &batch.files)
                .await?;
            let files = parse_snapshot_files_from_values(&batch.files)?;
            self.write_cursor(
                &task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision),
                    sequence: Some(active_sequence),
                    deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                    pending: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            (self.emit)(json!({
                "type": "task_file_conflict",
                "taskSpaceId": task_space_id,
                "conflict": conflict_summary(&result),
            }));
            return Ok(result);
        }

        let files = parse_snapshot_files_from_values(&batch.files)?;
        {
            let mut suppressed = self.suppressed.lock().await;
            for file in &files {
                suppressed.insert(
                    absolute_task_path(binding, &file.path),
                    if file.deleted {
                        None
                    } else {
                        Some(file.sha256.clone())
                    },
                );
            }
        }
        let baselines = merge_baselines(&cursor.baselines, &files);
        let mut ownership_pending = cursor.ownership_pending.clone();
        let mut pending_rejected = cursor.pending_rejected.clone();
        for task_dir in &task_dirs {
            ownership_pending.remove(task_dir);
            pending_rejected.remove(task_dir);
        }
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(cursor.revision),
                sequence: Some(active_sequence),
                baselines: Some(baselines),
                deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                pending: Some(None),
                pending_rejected: Some(pending_rejected),
                ownership_pending: Some(ownership_pending),
                ..Default::default()
            },
        )
        .await?;
        self.last_baseline_files.lock().await.clone_from(&files);
        Ok(result)
    }

    async fn upload_with_slot(
        &self,
        task_space_id: &str,
        delay: Duration,
        request: &Value,
    ) -> AgentResult<Value> {
        loop {
            let wait_for = {
                let gate = self.upload_gate.lock().await;
                let now = Instant::now();
                let ready_at = gate
                    .get(task_space_id)
                    .copied()
                    .map(|next| next.max(now + delay))
                    .unwrap_or(now + delay);
                if ready_at > now {
                    Some(ready_at - now)
                } else {
                    None
                }
            };
            match wait_for {
                Some(duration) => tokio::time::sleep(duration).await,
                None => {
                    let mut gate = self.upload_gate.lock().await;
                    let now = Instant::now();
                    let ready = gate
                        .get(task_space_id)
                        .copied()
                        .map(|next| next <= now)
                        .unwrap_or(true);
                    if !ready {
                        continue;
                    }
                    gate.insert(task_space_id.to_string(), now + UPLOAD_MIN_INTERVAL);
                    break;
                }
            }
        }
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/changes"),
                Some(request),
                Duration::from_secs(120),
            )
            .await
    }

    pub async fn resolve_initial_sync(
        &self,
        task_space_id: &str,
        mode: &str,
        decisions: &[Value],
    ) -> AgentResult<Value> {
        if mode != "safe" && mode != "review" {
            return protocol::err(code::COMMAND_INVALID, "首次同步处理方式无效");
        }
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        let snapshot = self.fetch_snapshot(task_space_id, 0).await?;
        let controls = parse_snapshot_controls(&snapshot)?;
        if let Some(controls) = &controls {
            self.merge_task_controls(&binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(&binding, controls).await?;
        }
        let local_groups = self.local_groups(&binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_initial_sync(&binding, &local_groups, &mut server_groups);
        self.prepare_controlled_server_groups(&binding, controls.as_deref(), &mut server_groups)
            .await?;
        let snapshot_baselines = baselines_from_snapshot(&snapshot_files);
        let differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls.as_deref(),
        );

        if mode == "safe" {
            let server_only: Vec<SnapshotGroup> = differences
                .iter()
                .filter(|item| {
                    item.kind == DiffKind::ServerOnly
                        && item
                            .server
                            .as_ref()
                            .and_then(|group| group.task_id.as_ref())
                            .is_some()
                })
                .filter_map(|item| item.server.clone())
                .collect();
            self.apply_server_groups(
                &binding,
                snapshot_revision(&snapshot),
                &server_only,
                "safe",
                false,
            )
            .await?;
            let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
            for difference in &differences {
                if matches!(difference.kind, DiffKind::Same | DiffKind::ServerOnly) {
                    continue;
                }
                if let Some(local) = &difference.local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
            }
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(snapshot_revision(&snapshot)),
                    baselines: Some(snapshot_baselines),
                    deferred: Some(deferred),
                    ..Default::default()
                },
            )
            .await?;
            self.write_server_cursor(task_space_id, snapshot_revision(&snapshot))
                .await?;
            self.complete_initial_sync(task_space_id, mode).await?;
            let actionable = differences
                .iter()
                .filter(|item| item.kind != DiffKind::Same)
                .count();
            return Ok(json!({
                "taskSpaceId": task_space_id,
                "mode": mode,
                "revision": snapshot_revision(&snapshot),
                "downloaded": server_only.len(),
                "skipped": actionable.saturating_sub(server_only.len()),
            }));
        }

        let mut decision_map: HashMap<String, String> = HashMap::new();
        for decision in decisions {
            let key = decision
                .get("taskId")
                .and_then(Value::as_str)
                .or_else(|| decision.get("taskDir").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            let action = decision
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("skip")
                .to_string();
            decision_map.insert(key, action);
        }
        let mut latest_revision = snapshot_revision(&snapshot);
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let (mut downloaded, mut uploaded, mut saved_local, mut skipped) = (0u32, 0u32, 0u32, 0u32);
        for difference in &differences {
            if difference.kind == DiffKind::Same {
                continue;
            }
            let action = decision_map
                .get(&difference.action_key())
                .cloned()
                .unwrap_or_else(|| "skip".into());
            let local = difference.local.clone();
            let server = difference.server.clone();
            if action == "skip" {
                if let Some(local) = &local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
                skipped += 1;
                continue;
            }
            if difference.kind == DiffKind::ServerOnly || action == "use-server" {
                if let (Some(local), Some(server)) = (&local, &server) {
                    if local.task_dir != server.task_dir {
                        self.backup_directory(&binding, &local.task_dir).await?;
                    }
                }
                let groups: Vec<SnapshotGroup> = server
                    .as_ref()
                    .filter(|group| !group.files.is_empty())
                    .cloned()
                    .into_iter()
                    .collect();
                self.apply_server_groups(
                    &binding,
                    snapshot_revision(&snapshot),
                    &groups,
                    "safe",
                    false,
                )
                .await?;
                if let (Some(local), Some(server)) = (&local, &server) {
                    if local.task_dir != server.task_dir {
                        self.remove_task_directory(&binding, &local.task_dir)
                            .await?;
                    }
                }
                downloaded += 1;
                continue;
            }
            if difference.kind == DiffKind::LocalOnly || action == "use-local" {
                let Some(local) = local.clone() else {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务目录不存在");
                };
                let result = self
                    .upload_reviewed_local_task(&binding, &local, server.as_ref())
                    .await?;
                if result.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(json!({
                        "taskSpaceId": task_space_id,
                        "mode": mode,
                        "revision": latest_revision,
                        "downloaded": downloaded,
                        "uploaded": uploaded,
                        "savedLocal": saved_local,
                        "skipped": skipped + 1,
                        "pendingReview": true,
                        "reason": result.get("reason").cloned().unwrap_or(Value::Null),
                    }));
                }
                baseline_files.extend(self.last_baseline_files.lock().await.clone());
                uploaded += 1;
                continue;
            }
            if action == "save-local" {
                let Some(local) = local.clone() else {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务目录不存在");
                };
                self.backup_directory(&binding, &local.task_dir).await?;
                deferred.insert(local.task_dir.clone(), file_state_from_group(&local));
                saved_local += 1;
            }
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                revision: Some(latest_revision),
                baselines: Some(merge_baselines(&snapshot_baselines, &baseline_files)),
                deferred: Some(deferred),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(task_space_id, latest_revision)
            .await?;
        self.complete_initial_sync(task_space_id, mode).await?;
        Ok(json!({
            "taskSpaceId": task_space_id,
            "mode": mode,
            "revision": latest_revision,
            "downloaded": downloaded,
            "uploaded": uploaded,
            "savedLocal": saved_local,
            "skipped": skipped,
        }))
    }

    async fn upload_reviewed_local_task(
        &self,
        binding: &AgentBinding,
        local: &SnapshotGroup,
        server: Option<&SnapshotGroup>,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let reviewed_baselines = server
            .map(|group| baselines_from_snapshot(&group.files))
            .unwrap_or_default();
        if server.is_some_and(|group| group.task_dir == local.task_dir) {
            return self
                .upload_directories(
                    binding,
                    std::slice::from_ref(&local.task_dir),
                    false,
                    Some(&reviewed_baselines),
                )
                .await;
        }
        let ownership = self
            .resolve_task_ownership(binding, std::slice::from_ref(local))
            .await?;
        if !ownership.syncable.contains_key(&local.task_dir) {
            return Ok(json!({
                "skipped": true,
                "reason": if ownership.paused.is_empty() {
                    "TASK_OWNERSHIP_REQUIRED"
                } else {
                    "TASK_BRANCH_OTHER"
                },
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
            }));
        }
        let server_files = match server {
            Some(group) => {
                let directory = self
                    .fetch_directory(&task_space_id, &group.task_dir)
                    .await?;
                parse_directory_files(&directory, &group.task_dir)?
            }
            None => Vec::new(),
        };
        let cursor = self.read_cursor(&task_space_id).await;
        let mut files: Vec<UploadFile> = local
            .files
            .iter()
            .map(|file| UploadFile {
                path: file.path.clone(),
                content: file.content.clone(),
                sha256: file.sha256.clone(),
                deleted: false,
                base_sha256: None,
            })
            .collect();
        for file in &server_files {
            files.push(UploadFile {
                path: file.path.clone(),
                content: String::new(),
                sha256: snapshot_sha256(""),
                deleted: true,
                base_sha256: Some(file.sha256.clone()),
            });
        }
        let values: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
        Ok(self
            .upload_persisted_batch(
                binding,
                &cursor,
                values,
                ownership.merge_evidence.get(&local.task_dir).cloned(),
            )
            .await?
            .unwrap_or(Value::Null))
    }

    pub async fn decide_conflict(
        &self,
        task_space_id: &str,
        conflict_id: &str,
        action: &str,
        files: Option<&[String]>,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let observed = self.assert_binding_branch(&binding).await?;
        let conflicts = self.fetch_conflicts(task_space_id).await?;
        let conflict = conflicts
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(conflict_id))
            .cloned()
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突不存在或已处理"))?;
        let directories = self.conflict_directories(&binding, &conflict).await?;
        if action == "use-server" {
            let server_dir = directories
                .server
                .clone()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突缺少服务端任务目录"))?;
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    self.backup_directory(&binding, local).await?;
                }
            }
            let revision = conflict
                .get("serverRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            self.apply_server_groups(
                &binding,
                revision,
                &[SnapshotGroup {
                    task_dir: server_dir.clone(),
                    archived: false,
                    archive_month: None,
                    task_id: None,
                    task_branch: directories
                        .server_files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_metadata(&file.content).1),
                    files: directories.server_files.clone(),
                }],
                CONFLICT_SYNC_MODE,
                true,
            )
            .await?;
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    self.remove_task_directory(&binding, local).await?;
                }
            }
            let cursor = self.read_cursor(task_space_id).await;
            let mut baselines = cursor.baselines.clone();
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    baselines.retain(|path_name, _| !path_name.starts_with(&format!("{local}/")));
                }
            }
            baselines.extend(baselines_from_snapshot(&directories.server_files));
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision.max(revision)),
                    baselines: Some(baselines),
                    ..Default::default()
                },
            )
            .await?;
            let resolved = self
                .resolve_conflict(task_space_id, conflict_id, &json!({ "action": action }))
                .await?;
            let task_dirs: Vec<String> = [directories.local.clone(), directories.server.clone()]
                .into_iter()
                .flatten()
                .collect();
            self.clear_conflict_blocked(task_space_id, conflict_id, &task_dirs)
                .await?;
            return Ok(resolved);
        }
        if action == "save-local-copy" {
            let local = directories
                .local
                .clone()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突缺少本地任务目录"))?;
            let backup = self.backup_directory(&binding, &local).await?;
            return Ok(json!({
                "conflictId": conflict_id,
                "action": action,
                "resolved": false,
                "backup": backup,
            }));
        }
        if action != "overwrite-server" {
            return protocol::err(code::COMMAND_INVALID, "冲突处理动作无效");
        }
        let mut selected: Vec<SnapshotFile> = Vec::new();
        if let Some(requested) = files {
            let group = self
                .local_groups(
                    &binding,
                    Some(&HashSet::from([directories
                        .local
                        .clone()
                        .unwrap_or_default()])),
                )
                .await?;
            for group in group {
                for file in group.files {
                    if requested.iter().any(|path_name| path_name == &file.path) {
                        selected.push(file);
                    }
                }
            }
        }
        if selected.is_empty() {
            if let Some(local_dir) = &directories.local {
                let groups = self
                    .local_groups(&binding, Some(&HashSet::from([local_dir.clone()])))
                    .await?;
                selected = groups
                    .into_iter()
                    .find(|group| &group.task_dir == local_dir)
                    .map(|group| group.files)
                    .unwrap_or_default();
            }
        }
        if selected.is_empty() {
            return protocol::err(code::COMMAND_INVALID, "覆盖服务端时必须提供本地任务文件");
        }
        let selected_paths: HashSet<String> =
            selected.iter().map(|file| file.path.clone()).collect();
        let mut values: Vec<Value> = selected
            .iter()
            .map(|file| {
                json!({
                    "path": file.path,
                    "content": file.content,
                    "sha256": file.sha256,
                    "deleted": file.deleted,
                })
            })
            .collect();
        for file in &directories.server_files {
            if selected_paths.contains(&file.path) {
                continue;
            }
            values.push(json!({
                "path": file.path,
                "content": "",
                "sha256": snapshot_sha256(""),
                "deleted": true,
                "baseSha256": file.sha256,
            }));
        }
        let selected_dirs: HashSet<String> = selected
            .iter()
            .filter_map(|file| active_task_directory_from_relative(&file.path))
            .collect();
        let local_groups = self.local_groups(&binding, Some(&selected_dirs)).await?;
        let ownership = self.resolve_task_ownership(&binding, &local_groups).await?;
        if local_groups
            .iter()
            .any(|group| !ownership.syncable.contains_key(&group.task_dir))
        {
            return Ok(json!({
                "skipped": true,
                "reason": if ownership.paused.is_empty() { "TASK_OWNERSHIP_REQUIRED" } else { "TASK_BRANCH_OTHER" },
                "conflictId": conflict_id,
                "action": action,
                "resolved": false,
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
            }));
        }
        let merge_evidence = local_groups
            .iter()
            .find_map(|group| ownership.merge_evidence.get(&group.task_dir))
            .cloned();
        let cursor = self.read_cursor(task_space_id).await;
        let backup = match &directories.local {
            Some(local_dir) => self.backup_directory(&binding, local_dir).await?,
            None => None,
        };
        let next_sequence = next_client_sequence(cursor.sequence);
        let result = self
            .resolve_conflict(
                task_space_id,
                conflict_id,
                &json!({
                    "action": action,
                    "batchId": uuid::Uuid::new_v4().to_string(),
                    "clientSequence": next_sequence,
                    "files": values,
                    "observedBranchName": observed,
                    "mergeEvidence": merge_evidence,
                }),
            )
            .await?;
        if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
            self.mark_conflict_blocked(task_space_id, &result, &values)
                .await?;
        } else {
            let uploaded_files = parse_snapshot_files_from_values(&values)?;
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision),
                    sequence: Some(next_sequence),
                    baselines: Some(merge_baselines(&cursor.baselines, &uploaded_files)),
                    pending: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            let task_dirs: Vec<String> = [directories.local.clone(), directories.server.clone()]
                .into_iter()
                .flatten()
                .collect();
            self.clear_conflict_blocked(task_space_id, conflict_id, &task_dirs)
                .await?;
        }
        let mut payload = result;
        payload["backup"] = json!(backup);
        Ok(payload)
    }

    pub async fn conflict_details(
        &self,
        task_space_id: &str,
        conflict_id: &str,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let conflicts = self.fetch_conflicts(task_space_id).await?;
        let conflict = conflicts
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(conflict_id))
            .cloned()
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突不存在或已处理"))?;
        let directories = self.conflict_directories(&binding, &conflict).await?;
        let local_files = match &directories.local {
            Some(local_dir) => {
                let groups = self
                    .local_groups(&binding, Some(&HashSet::from([local_dir.clone()])))
                    .await?;
                groups
                    .into_iter()
                    .find(|group| &group.task_dir == local_dir)
                    .map(|group| group.files)
                    .unwrap_or_default()
            }
            None => Vec::new(),
        };
        let mut paths: HashSet<String> = local_files.iter().map(|file| file.path.clone()).collect();
        paths.extend(
            directories
                .server_files
                .iter()
                .map(|file| file.path.clone()),
        );
        if let Some(items) = conflict.get("files").and_then(Value::as_array) {
            for item in items {
                if let Some(path_name) = item.get("path").and_then(Value::as_str) {
                    if !is_archive_snapshot_path(path_name) {
                        paths.insert(path_name.to_string());
                    }
                }
            }
        }
        let mut sorted: Vec<String> = paths.into_iter().collect();
        sorted.sort();
        let files: Vec<Value> = sorted
            .into_iter()
            .map(|path_name| {
                let local = local_files.iter().find(|file| file.path == path_name);
                let remote = directories
                    .server_files
                    .iter()
                    .find(|file| file.path == path_name);
                let detail = conflict
                    .get("files")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("path").and_then(Value::as_str) == Some(&path_name)
                        })
                    });
                json!({
                    "path": path_name,
                    "localContent": local.map(|file| file.content.clone()),
                    "serverContent": remote.map(|file| file.content.clone()),
                    "changedBy": detail.and_then(|item| item.get("changedBy")).cloned()
                        .or_else(|| remote.map(|file| json!(file.sha256))),
                })
            })
            .collect();
        Ok(json!({
            "taskSpaceId": task_space_id,
            "conflictId": conflict_id,
            "taskId": conflict.get("taskId"),
            "taskTitle": conflict.get("taskTitle").or_else(|| conflict.get("taskId")).or_else(|| conflict.get("taskDir")).unwrap_or(&Value::String("任务".into())),
            "taskDir": conflict.get("taskDir"),
            "localTaskDir": directories.local,
            "serverTaskDir": directories.server,
            "files": files,
        }))
    }

    async fn fetch_conflicts(&self, task_space_id: &str) -> AgentResult<Vec<Value>> {
        let value = self
            .api
            .request_json(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/conflicts"),
                None,
                Duration::from_secs(60),
            )
            .await?;
        Ok(value
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|conflict| !conflict_is_archive_only(conflict))
            .collect())
    }

    async fn resolve_conflict(
        &self,
        task_space_id: &str,
        conflict_id: &str,
        body: &Value,
    ) -> AgentResult<Value> {
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/conflicts/{conflict_id}/resolve"),
                Some(body),
                Duration::from_secs(120),
            )
            .await
    }

    async fn conflict_directories(
        &self,
        binding: &AgentBinding,
        conflict: &Value,
    ) -> AgentResult<ConflictDirectories> {
        let task_dir = conflict
            .get("taskDir")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (mut local, mut server) = conflict_task_directories(task_dir);
        local = local.filter(|task_dir| !is_archive_task_dir(task_dir));
        server = server.filter(|task_dir| !is_archive_task_dir(task_dir));
        let mut candidates: Vec<String> = Vec::new();
        for candidate in [local.clone(), server.clone()].into_iter().flatten() {
            if !is_archive_task_dir(&candidate) && !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
        if let Some(items) = conflict.get("files").and_then(Value::as_array) {
            for item in items {
                if let Some(path_name) = item.get("path").and_then(Value::as_str) {
                    if let Some(candidate) = active_task_directory_from_relative(path_name) {
                        if !candidates.contains(&candidate) {
                            candidates.push(candidate);
                        }
                    }
                }
            }
        }
        for candidate in &candidates {
            let groups = self
                .local_groups(binding, Some(&HashSet::from([candidate.clone()])))
                .await?;
            if !groups.is_empty() {
                local = Some(candidate.clone());
                break;
            }
        }
        let mut server_files = Vec::new();
        for candidate in &candidates {
            let directory = self
                .fetch_directory(&binding.task_space_id, candidate)
                .await?;
            let files = parse_directory_files(&directory, candidate)?;
            if !files.is_empty() {
                server = Some(candidate.clone());
                server_files = files;
                break;
            }
        }
        Ok(ConflictDirectories {
            local,
            server,
            server_files,
        })
    }
}

impl Drop for TaskSync {
    fn drop(&mut self) {
        self.ownership_validation_state.notify.notify_one();
    }
}

struct ConflictDirectories {
    local: Option<String>,
    server: Option<String>,
    server_files: Vec<SnapshotFile>,
}

#[derive(Default)]
struct CursorPatch {
    revision: Option<u64>,
    revision_guard_version: Option<u64>,
    sequence: Option<u64>,
    baseline_reconciled_head: Option<String>,
    pending: Option<Option<PendingBatch>>,
    pending_rejected: Option<BTreeMap<String, PendingRejection>>,
    baselines: Option<BTreeMap<String, String>>,
    deferred: Option<BTreeMap<String, BTreeMap<String, String>>>,
    ownership_pending: Option<BTreeMap<String, String>>,
    conflict_blocked: Option<BTreeMap<String, String>>,
}

fn apply_cursor_patch(cursor: &mut Cursor, next: &CursorPatch) -> bool {
    let before = cursor.clone();
    if let Some(revision) = next.revision {
        cursor.revision = cursor.revision.max(revision);
    }
    if let Some(revision_guard_version) = next.revision_guard_version {
        cursor.revision_guard_version =
            cursor.revision_guard_version.max(revision_guard_version);
    }
    if let Some(sequence) = next.sequence {
        cursor.sequence = cursor.sequence.max(sequence);
    }
    if let Some(head) = &next.baseline_reconciled_head {
        cursor.baseline_reconciled_head = head.clone();
    }
    if let Some(pending) = &next.pending {
        cursor.pending = pending.clone();
    }
    if let Some(pending_rejected) = &next.pending_rejected {
        cursor.pending_rejected = pending_rejected.clone();
    }
    if let Some(baselines) = &next.baselines {
        cursor.baselines = baselines.clone();
    }
    if let Some(deferred) = &next.deferred {
        cursor.deferred = deferred.clone();
    }
    if let Some(ownership_pending) = &next.ownership_pending {
        cursor.ownership_pending = ownership_pending.clone();
    }
    if let Some(conflict_blocked) = &next.conflict_blocked {
        cursor.conflict_blocked = conflict_blocked.clone();
    }
    *cursor != before
}

fn should_pull_for_event(
    initial_sync_completed: bool,
    initial_review_pending: bool,
    cursor_revision: u64,
    event_revision: Option<u64>,
    has_pending_upload: bool,
) -> bool {
    let Some(event_revision) = event_revision else {
        return true;
    };
    !initial_sync_completed
        || initial_review_pending
        || has_pending_upload
        || event_revision > cursor_revision
}

fn conflict_task_directories(value: &str) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = value
        .split(" -> ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let local = parts.first().map(|part| part.to_string());
    let server = parts.last().map(|part| part.to_string());
    (local, server)
}

fn conflict_is_archive_only(conflict: &Value) -> bool {
    let (local, server) = conflict
        .get("taskDir")
        .and_then(Value::as_str)
        .map(conflict_task_directories)
        .unwrap_or((None, None));
    let mut recognized = false;
    for task_dir in [local, server].into_iter().flatten() {
        recognized = true;
        if !is_archive_task_dir(&task_dir) {
            return false;
        }
    }
    if let Some(files) = conflict.get("files").and_then(Value::as_array) {
        for file in files {
            if let Some(task_dir) = file
                .get("path")
                .and_then(Value::as_str)
                .and_then(task_directory_from_relative)
            {
                recognized = true;
                if !is_archive_task_dir(&task_dir) {
                    return false;
                }
            }
        }
    }
    recognized
}

fn conflict_summary(result: &Value) -> Value {
    let details = result.get("details").cloned().unwrap_or(Value::Null);
    json!({
        "conflictId": result.get("conflictId"),
        "taskId": details.get("taskId"),
        "taskTitle": details.get("taskTitle").cloned().unwrap_or(Value::String("任务".into())),
        "files": details.get("files").cloned().unwrap_or(Value::Array(Vec::new())),
        "message": result.get("message").and_then(Value::as_str).unwrap_or("任务文件已被其他成员修改"),
        "suggestion": details.get("suggestion").cloned().unwrap_or(Value::String("先查看差异，再选择保留哪一份".into())),
    })
}

fn initial_sync_mode(binding: &AgentBinding) -> String {
    if matches!(
        binding.initial_sync_mode.as_str(),
        "bootstrap" | "safe" | "review"
    ) {
        return binding.initial_sync_mode.clone();
    }
    if binding.initial_review_pending {
        "review".into()
    } else {
        "safe".into()
    }
}

fn retain_server_groups_for_binding(binding: &AgentBinding, groups: &mut Vec<SnapshotGroup>) {
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && group
                .task_branch
                .as_deref()
                .map(|branch| branch == binding.branch_name)
                .unwrap_or(true)
    });
}

fn binding_is_baseline(binding: &AgentBinding) -> bool {
    binding.baseline_branch.as_deref() == Some(binding.branch_name.as_str())
}

fn allows_cross_source_server_group(binding: &AgentBinding, mode: &str) -> bool {
    binding_is_baseline(binding)
        && (mode == REVISION_GUARD_SYNC_MODE || mode == CONFLICT_SYNC_MODE)
}

/// 一次性全量对账必须保住基线任务空间里已由服务端接纳的跨来源任务；
/// 普通增量同步仍按当前绑定分支过滤。
fn retain_server_groups_for_revision_guard(
    binding: &AgentBinding,
    groups: &mut Vec<SnapshotGroup>,
) {
    let allow_cross_branch = binding_is_baseline(binding);
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && (allow_cross_branch
                || group
                    .task_branch
                    .as_deref()
                    .map(|branch| branch == binding.branch_name)
                    .unwrap_or(true))
    });
}

/// 首次同步的差异分类：`task.json` 记录的 `branch` 是任务当时的开发分支；
/// 归档任务已退出客户端同步，只有本地存在的同目录活动任务才保留跨分支组。
fn retain_server_groups_for_initial_sync(
    binding: &AgentBinding,
    local_groups: &[SnapshotGroup],
    groups: &mut Vec<SnapshotGroup>,
) {
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && (group
                .task_branch
                .as_deref()
                .map(|branch| branch == binding.branch_name)
                .unwrap_or(true)
                || local_groups
                    .iter()
                    .any(|local| local.task_dir == group.task_dir))
    });
}

fn hide_control_tombstone_local_only(
    differences: Vec<Difference>,
    controls: Option<&[TaskControl]>,
) -> Vec<Difference> {
    let Some(controls) = controls else {
        return differences;
    };
    let blocked: HashSet<&str> = controls
        .iter()
        .filter(|control| !control.is_writable_local())
        .map(|control| control.relative_dir.as_str())
        .collect();
    differences
        .into_iter()
        .filter(|difference| {
            !(difference.kind == DiffKind::LocalOnly
                && difference
                    .local
                    .as_ref()
                    .is_some_and(|group| blocked.contains(group.task_dir.as_str())))
        })
        .collect()
}

fn inactive_control_dirs(controls: Option<&[TaskControl]>) -> HashSet<String> {
    controls
        .unwrap_or_default()
        .iter()
        .filter(|control| !control.is_writable_local())
        .map(|control| control.relative_dir.clone())
        .collect()
}

fn snapshot_revision(snapshot: &Value) -> u64 {
    snapshot
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// 服务端按 taskSpace 要求 `clientSequence` 严格递增，且历史值来自旧版 JS 客户端的
/// `Date.now()`。因此始终取「本地 cursor + 1」与当前毫秒时间的较大值，避免重装/换实现后
/// 从 1 开始被服务端拒绝。
fn next_client_sequence(cursor_sequence: u64) -> u64 {
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    cursor_sequence.saturating_add(1).max(wall)
}

fn parse_snapshot_files(snapshot: &Value) -> AgentResult<Vec<SnapshotFile>> {
    let values = snapshot
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    parse_snapshot_files_from_values(&values)
}

fn parse_snapshot_controls(snapshot: &Value) -> AgentResult<Option<Vec<TaskControl>>> {
    let Some(values) = snapshot.get("controls") else {
        return Ok(None);
    };
    let values = values.as_array().ok_or_else(|| {
        AgentError::new(code::INVALID_RESPONSE, "快照 controls 必须是数组")
    })?;
    values
        .iter()
        .map(TaskControl::from_control_value)
        .collect::<AgentResult<Vec<_>>>()
        .map(Some)
}

fn execution_task_keys_from_upload(
    task_space_id: &str,
    files: &[Value],
) -> AgentResult<BTreeSet<String>> {
    let mut task_ids = BTreeSet::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            continue;
        };
        if file.get("deleted").and_then(Value::as_bool) == Some(true)
            || !path.ends_with("/task.json")
        {
            continue;
        }
        let Some(content) = file.get("content").and_then(Value::as_str) else {
            continue;
        };
        let document: Value = serde_json::from_str(content).map_err(|_| {
            AgentError::new(code::INVALID_RESPONSE, "task.json 不是合法 JSON")
        })?;
        let task_id = document
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "task.json 缺少 id"))?;
        task_ids.insert(format!("{task_space_id}::{task_id}"));
    }
    Ok(task_ids)
}

fn response_control_execution_task_key(
    requested: Option<&str>,
    control: &TaskControl,
) -> AgentResult<String> {
    if let Some(requested) = requested {
        if requested != control.execution_task_key {
            return protocol::err(code::INVALID_RESPONSE, "任务上传响应的执行身份不一致");
        }
        return Ok(requested.to_string());
    }
    Ok(control.execution_task_key.clone())
}

fn build_upload_request(
    batch: &PendingBatch,
    client_sequence: u64,
    observed_branch_name: &str,
    fence: Option<&UploadFence>,
) -> Value {
    let mut request = json!({
        "batchId": batch.batch_id,
        "clientSequence": client_sequence,
        "files": batch.files,
        "observedBranchName": observed_branch_name,
    });
    if let Some(evidence) = &batch.merge_evidence {
        request["mergeEvidence"] = evidence.clone();
    }
    if let Some(fence) = fence {
        fence.apply(&mut request);
    }
    request
}

fn pending_task_dirs(files: &[Value]) -> HashSet<String> {
    files
        .iter()
        .filter_map(|file| {
            file.get("path")
                .and_then(Value::as_str)
                .and_then(active_task_directory_from_relative)
        })
        .collect()
}

fn parse_snapshot_files_from_values(values: &[Value]) -> AgentResult<Vec<SnapshotFile>> {
    values
        .iter()
        .filter(|value| {
            !value
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(is_archive_snapshot_path)
        })
        .map(validate_snapshot_file)
        .collect()
}

pub(crate) fn parse_directory_files(
    directory: &Value,
    task_dir: &str,
) -> AgentResult<Vec<SnapshotFile>> {
    if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
        != Some(task_dir)
    {
        return protocol::err(
            code::INVALID_RESPONSE,
            "任务目录无效或已由服务端 Git 归档",
        );
    }
    let values = directory
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut files = parse_snapshot_files_from_values(&values)?;
    for file in &mut files {
        if file.task_dir.is_empty() {
            file.task_dir = task_dir.to_string();
        }
    }
    Ok(files)
}

fn groups_from_structs(files: &[SnapshotFile]) -> AgentResult<Vec<SnapshotGroup>> {
    let values: Vec<Value> = files
        .iter()
        .map(|file| {
            json!({
                "path": file.path,
                "content": file.content,
                "sha256": file.sha256,
                "deleted": file.deleted,
                "baseSha256": file.base_sha256,
            })
        })
        .collect();
    group_task_snapshot_files(&values)
}

fn build_directory_files(
    task_dir: &str,
    local: Option<&SnapshotGroup>,
    server_files: &[SnapshotFile],
    baselines: &BTreeMap<String, String>,
) -> Vec<UploadFile> {
    let current: HashMap<String, String> = server_files
        .iter()
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect();
    let empty: Vec<SnapshotFile> = Vec::new();
    let local_files = local.map(|group| &group.files).unwrap_or(&empty);
    let local_paths: HashSet<String> = local_files.iter().map(|file| file.path.clone()).collect();
    let mut files: Vec<UploadFile> = local_files
        .iter()
        .map(|file| UploadFile {
            path: file.path.clone(),
            content: file.content.clone(),
            sha256: file.sha256.clone(),
            deleted: false,
            base_sha256: baselines.get(&file.path).cloned(),
        })
        .collect();
    for (path_name, sha256) in current {
        if local_paths.contains(&path_name) {
            continue;
        }
        let belongs =
            active_task_directory_from_relative(&path_name).as_deref() == Some(task_dir);
        if !belongs {
            continue;
        }
        files.push(UploadFile {
            path: path_name.clone(),
            content: String::new(),
            sha256: snapshot_sha256(""),
            deleted: true,
            base_sha256: Some(sha256),
        });
    }
    files
}

fn uploads_to_snapshot_files(files: &[UploadFile]) -> AgentResult<Vec<SnapshotFile>> {
    let values: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
    parse_snapshot_files_from_values(&values)
}

type DirectoryEntry = (String, Option<SnapshotGroup>, Vec<SnapshotFile>);

fn move_pairs(entries: &[DirectoryEntry]) -> Vec<(DirectoryEntry, DirectoryEntry)> {
    let sources: Vec<&DirectoryEntry> = entries
        .iter()
        .filter(|(_, local, server)| local.is_none() && !server.is_empty())
        .collect();
    let targets: Vec<&DirectoryEntry> = entries
        .iter()
        .filter(|(_, local, server)| local.is_some() && server.is_empty())
        .collect();
    let mut pairs = Vec::new();
    for source in sources {
        let task_id = source
            .2
            .iter()
            .find(|file| file.file_path == "task.json")
            .and_then(|file| parse_task_id(&file.content));
        let Some(task_id) = task_id else { continue };
        if let Some(target) = targets.iter().find(|(_, local, _)| {
            local
                .as_ref()
                .and_then(|group| group.task_id.clone())
                .as_deref()
                == Some(task_id.as_str())
        }) {
            pairs.push(((*source).clone(), (*target).clone()));
        }
    }
    pairs
}

fn clear_deferred_for_files(
    deferred: &BTreeMap<String, BTreeMap<String, String>>,
    files: &[SnapshotFile],
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut next = deferred.clone();
    for file in files {
        if let Some(task_dir) = active_task_directory_from_relative(&file.path) {
            next.remove(&task_dir);
        }
    }
    next
}

fn baselines_to_value(baselines: &BTreeMap<String, String>) -> Value {
    Value::Object(
        baselines
            .iter()
            .map(|(path_name, sha256)| (path_name.clone(), Value::String(sha256.clone())))
            .collect(),
    )
}

fn deferred_to_value(deferred: &BTreeMap<String, BTreeMap<String, String>>) -> Value {
    Value::Object(
        deferred
            .iter()
            .map(|(task_dir, files)| (task_dir.clone(), baselines_to_value(files)))
            .collect(),
    )
}

fn parse_baselines(value: &Value) -> Option<BTreeMap<String, String>> {
    let object = value.as_object()?;
    let mut baselines = BTreeMap::new();
    for (path_name, sha256) in object {
        let Some(sha256) = sha256.as_str() else {
            continue;
        };
        if is_sha256(sha256)
            && normalize_snapshot_path(path_name).is_ok()
            && active_task_directory_from_path(path_name).is_some()
        {
            baselines.insert(path_name.clone(), sha256.to_string());
        }
    }
    Some(baselines)
}

fn parse_deferred(value: &Value) -> Option<BTreeMap<String, BTreeMap<String, String>>> {
    let object = value.as_object()?;
    let mut deferred = BTreeMap::new();
    for (task_dir, files) in object {
        let Some(files) = parse_baselines(files) else {
            continue;
        };
        if files.is_empty() {
            continue;
        }
        if !is_archive_task_dir(task_dir)
            && files.keys().all(|path_name| {
                active_task_directory_from_relative(path_name).as_deref()
                    == Some(task_dir.as_str())
            })
        {
            deferred.insert(task_dir.clone(), files);
        }
    }
    Some(deferred)
}

fn ownership_pending_to_value(pending: &BTreeMap<String, String>) -> Value {
    Value::Object(
        pending
            .iter()
            .map(|(task_dir, fingerprint)| {
                (
                    task_dir.clone(),
                    json!({
                        "fingerprint": fingerprint,
                        "reason": "TASK_OWNERSHIP_REQUIRED",
                    }),
                )
            })
            .collect(),
    )
}

fn conflict_blocked_to_value(blocked: &BTreeMap<String, String>) -> Value {
    Value::Object(
        blocked
            .iter()
            .map(|(task_dir, conflict_id)| (task_dir.clone(), json!({ "conflictId": conflict_id })))
            .collect(),
    )
}

fn pending_rejected_to_value(rejected: &BTreeMap<String, PendingRejection>) -> Value {
    Value::Object(
        rejected
            .iter()
            .map(|(task_dir, item)| {
                (
                    task_dir.clone(),
                    json!({
                        "batchId": item.batch_id,
                        "clientSequence": item.client_sequence,
                        "reason": item.reason,
                        "createdAt": item.created_at,
                        "blockedAt": item.blocked_at,
                    }),
                )
            })
            .collect(),
    )
}

fn parse_pending_rejected(value: &Value) -> BTreeMap<String, PendingRejection> {
    let mut rejected = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return rejected;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir)
            || task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
                != Some(task_dir.as_str())
        {
            continue;
        }
        let Some(batch_id) = state
            .get("batchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(client_sequence) = state
            .get("clientSequence")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        else {
            continue;
        };
        let Some(reason) = state
            .get("reason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(blocked_at) = state
            .get("blockedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let created_at = state
            .get("createdAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(blocked_at);
        rejected.insert(
            task_dir.clone(),
            PendingRejection {
                batch_id: batch_id.to_string(),
                client_sequence,
                reason: reason.to_string(),
                created_at: created_at.to_string(),
                blocked_at: blocked_at.to_string(),
            },
        );
    }
    trim_pending_rejections(&mut rejected);
    rejected
}

fn trim_pending_rejections(rejected: &mut BTreeMap<String, PendingRejection>) {
    if rejected.len() <= PENDING_REJECTED_LIMIT {
        return;
    }
    let mut entries: Vec<(String, String)> = rejected
        .iter()
        .map(|(task_dir, item)| (task_dir.clone(), item.blocked_at.clone()))
        .collect();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)));
    let keep: HashSet<String> = entries
        .into_iter()
        .take(PENDING_REJECTED_LIMIT)
        .map(|(task_dir, _)| task_dir)
        .collect();
    rejected.retain(|task_dir, _| keep.contains(task_dir));
}

fn parse_ownership_pending(value: &Value) -> BTreeMap<String, String> {
    let mut pending = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return pending;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir) {
            continue;
        }
        if task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
            != Some(task_dir.as_str())
        {
            continue;
        }
        let fingerprint = state
            .get("fingerprint")
            .and_then(Value::as_str)
            .filter(|value| is_sha256(value));
        if let Some(fingerprint) = fingerprint {
            pending.insert(task_dir.clone(), fingerprint.to_string());
        }
    }
    pending
}

fn parse_conflict_blocked(value: &Value) -> BTreeMap<String, String> {
    let mut blocked = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return blocked;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir) {
            continue;
        }
        if task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
            != Some(task_dir.as_str())
        {
            continue;
        }
        let conflict_id = state
            .as_str()
            .or_else(|| state.get("conflictId").and_then(Value::as_str))
            .filter(|value| !value.is_empty() && value.len() <= 128);
        if let Some(conflict_id) = conflict_id {
            blocked.insert(task_dir.clone(), conflict_id.to_string());
        }
    }
    blocked
}

fn parse_pending_batch(value: &Value) -> Option<PendingBatch> {
    let batch_id = value.get("batchId").and_then(Value::as_str)?.to_string();
    let client_sequence = value.get("clientSequence").and_then(Value::as_u64)?;
    if client_sequence == 0 {
        return None;
    }
    let files = value.get("files").and_then(Value::as_array)?.clone();
    if files.is_empty() {
        return None;
    }
    Some(PendingBatch {
        batch_id,
        client_sequence,
        files,
        merge_evidence: value.get("mergeEvidence").cloned(),
        created_at: value
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// 只关心任务目录：`upload_dirty` 对其它路径无能为力，少转发少唤醒。
fn is_watched_trellis_path(relative: &str) -> bool {
    relative == "tasks"
        || (relative.starts_with("tasks/")
            && relative != "tasks/archive"
            && !relative.starts_with("tasks/archive/"))
}

fn is_relevant_watch_event(event: &notify::Event) -> bool {
    !event.kind.is_access()
}

async fn git_head_branch_name(repo_path: &Path) -> Option<Option<String>> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let head = tokio::fs::read_to_string(git_dir.join("HEAD")).await.ok()?;
    Some(
        head.trim()
            .strip_prefix("ref: refs/heads/")
            .map(str::to_string),
    )
}

/// 只读取 HEAD 指向的引用；ownership 投影未变化时无需启动 Git 子进程。
async fn git_head_fingerprint(repo_path: &Path) -> Option<String> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let common_dir = tokio::fs::read_to_string(git_dir.join("commondir"))
        .await
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
    let head = tokio::fs::read_to_string(git_dir.join("HEAD")).await.ok()?;
    let head = head.trim().to_string();
    let value = if let Some(reference) = head.strip_prefix("ref: ") {
        if !reference.starts_with("refs/")
            || reference
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return None;
        }
        let loose = tokio::fs::read_to_string(common_dir.join(reference))
            .await
            .ok()
            .map(|value| value.trim().to_string());
        if let Some(value) = loose {
            value
        } else {
            tokio::fs::read_to_string(common_dir.join("packed-refs"))
                .await
                .ok()
                .and_then(|packed| {
                    packed.lines().find_map(|line| {
                        line.strip_suffix(reference)
                            .map(str::trim)
                            .filter(|value| !value.is_empty())
                            .map(str::to_string)
                    })
                })
                .unwrap_or_else(|| "<missing>".to_string())
        }
    } else {
        head.clone()
    };
    Some(format!("{head}\n{value}"))
}

async fn git_index_fingerprint(repo_path: &Path) -> Option<String> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let path = git_dir.join("index");
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return Some("<missing>".to_string());
    };
    let modified_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|value| u64::try_from(value.as_nanos()).ok())
        .unwrap_or_default();
    Some(format!("{}:{modified_ns}", metadata.len()))
}

async fn git_watch_paths(repo_path: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    let Some(git_dir) = resolve_git_dir(repo_path).await else {
        return Vec::new();
    };
    let common_dir = tokio::fs::read_to_string(git_dir.join("commondir"))
        .await
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
    let candidates = [
        (git_dir.join("HEAD"), RecursiveMode::NonRecursive),
        (git_dir.join("index"), RecursiveMode::NonRecursive),
        (
            common_dir.join("packed-refs"),
            RecursiveMode::NonRecursive,
        ),
        (common_dir.join("refs"), RecursiveMode::Recursive),
    ];
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for (path, mode) in candidates {
        if !seen.insert(path.clone()) || tokio::fs::metadata(&path).await.is_err() {
            continue;
        }
        paths.push((path, mode));
    }
    paths
}

async fn resolve_git_dir(repo_path: &Path) -> Option<PathBuf> {
    let dot_git = repo_path.join(".git");
    if tokio::fs::metadata(&dot_git)
        .await
        .ok()
        .is_some_and(|metadata| metadata.is_dir())
    {
        return Some(dot_git);
    }
    let text = tokio::fs::read_to_string(&dot_git).await.ok()?;
    let value = text
        .lines()
        .next()?
        .strip_prefix("gitdir:")?
        .trim();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        repo_path.join(path)
    };
    tokio::fs::canonicalize(&path).await.ok().or(Some(path))
}

fn absolute_task_path(binding: &AgentBinding, relative_path: &str) -> String {
    Path::new(&binding.repo_path)
        .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        .to_string_lossy()
        .to_string()
}

fn task_directory_error(task_dir: &str, message: impl Into<String>) -> AgentError {
    let mut error = AgentError::new(code::INVALID_RESPONSE, message);
    if task_dir.starts_with(".trellis/tasks/") && task_dir.chars().count() <= 500 {
        error.details = Some(json!({ "taskDir": task_dir }));
    }
    error
}

async fn resolve_task_directory(
    binding: &AgentBinding,
    task_dir: &str,
) -> AgentResult<PathBuf> {
    if is_archive_task_dir(task_dir) {
        return Err(task_directory_error(
            task_dir,
            "客户端不能访问服务端 Git 管理的归档目录",
        ));
    }
    let trellis_root = Path::new(&binding.repo_path).join(".trellis");
    let tasks_root = trellis_root.join("tasks");
    let target = protocol::resolve_task_dir_under(&tasks_root, task_dir)
        .ok_or_else(|| task_directory_error(task_dir, "任务目录路径校验失败"))?;
    let relative = target
        .strip_prefix(&tasks_root)
        .map_err(|_| task_directory_error(task_dir, "任务目录路径校验失败"))?;
    let mut current = tasks_root.clone();
    let mut paths = vec![trellis_root, current.clone()];
    for component in relative.components() {
        current.push(component.as_os_str());
        paths.push(current.clone());
    }
    for path in paths {
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(task_directory_error(task_dir, "任务目录路径不能经过符号链接"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(target)
}

async fn write_task_directory(binding: &AgentBinding, group: &SnapshotGroup) -> AgentResult<()> {
    if group.archived
        || is_archive_task_dir(&group.task_dir)
        || group.files.iter().any(|file| file.archived)
    {
        return protocol::err(
            code::INVALID_RESPONSE,
            "客户端不能写入服务端 Git 管理的归档目录",
        );
    }
    let target = resolve_task_directory(binding, &group.task_dir).await?;
    let temp_root = Path::new(&binding.repo_path)
        .join(".trellis")
        .join(format!(".agent-sync-{}", uuid::Uuid::new_v4()));
    let staged = temp_root.join("next");
    let backup = temp_root.join("previous");
    tokio::fs::create_dir_all(&staged).await.map_err(io_error)?;
    for file in &group.files {
        let relative = file
            .path
            .strip_prefix(&format!("{}/", group.task_dir))
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件不属于目标目录"))?;
        let target_file = staged.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !protocol::is_path_inside(&staged, &target_file) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件路径越界");
        }
        if let Some(parent) = target_file.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
        }
        tokio::fs::write(&target_file, normalize_snapshot_text(&file.content))
            .await
            .map_err(io_error)?;
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
    }
    match tokio::fs::rename(&target, &backup).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(error)),
    }
    if let Err(error) = tokio::fs::rename(&staged, &target).await {
        let _ = tokio::fs::rename(&backup, &target).await;
        let _ = tokio::fs::remove_dir_all(&temp_root).await;
        return Err(io_error(error));
    }
    let _ = tokio::fs::remove_dir_all(&backup).await;
    let _ = tokio::fs::remove_dir_all(&temp_root).await;
    Ok(())
}

fn io_error(error: std::io::Error) -> AgentError {
    AgentError::new(code::INVALID_RESPONSE, format!("任务文件写入失败: {error}"))
}

async fn copy_directory(source: &Path, target: &Path) -> AgentResult<()> {
    let source_metadata = tokio::fs::symlink_metadata(source).await.map_err(io_error)?;
    if !source_metadata.is_dir() || source_metadata.file_type().is_symlink() {
        return protocol::err(code::INVALID_RESPONSE, "备份源必须是真实目录");
    }
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
    }
    match tokio::fs::create_dir(target).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return protocol::err(code::INVALID_RESPONSE, "备份目标已存在，拒绝覆盖")
        }
        Err(error) => return Err(io_error(error)),
    }
    let copy_result: AgentResult<()> = async {
        let mut stack = vec![source.to_path_buf()];
        while let Some(directory) = stack.pop() {
            let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
            while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
                let path = entry.path();
                if !protocol::is_path_inside(source, &path) {
                    return protocol::err(code::INVALID_RESPONSE, "备份源文件路径越界");
                }
                let relative = path
                    .strip_prefix(source)
                    .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "备份源文件路径越界"))?
                    .to_path_buf();
                let destination = target.join(&relative);
                if !protocol::is_path_inside(target, &destination) {
                    return protocol::err(code::INVALID_RESPONSE, "备份目标文件路径越界");
                }
                let metadata = tokio::fs::symlink_metadata(&path).await.map_err(io_error)?;
                if metadata.file_type().is_symlink() {
                    return protocol::err(code::INVALID_RESPONSE, "备份源不允许符号链接");
                }
                if metadata.is_dir() {
                    tokio::fs::create_dir(&destination).await.map_err(io_error)?;
                    stack.push(path);
                } else if metadata.is_file() {
                    if let Some(parent) = destination.parent() {
                        tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
                    }
                    tokio::fs::copy(&path, &destination)
                        .await
                        .map_err(io_error)?;
                } else {
                    return protocol::err(code::INVALID_RESPONSE, "备份源包含不支持的文件类型");
                }
            }
        }
        Ok(())
    }
    .await;
    if copy_result.is_err() {
        if let Err(error) = tokio::fs::remove_dir_all(target).await {
            crate::logging::warn(&format!(
                "handoff 不完整备份清理失败：{}",
                protocol::safe_error_message(&error.to_string())
            ));
        }
    }
    copy_result
}

async fn task_directory_file_paths(source: &Path) -> AgentResult<BTreeSet<String>> {
    let metadata = tokio::fs::symlink_metadata(source).await.map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return protocol::err(code::INVALID_RESPONSE, "任务目录必须是真实目录");
    }
    let mut paths = BTreeSet::new();
    let mut stack = vec![source.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let path = entry.path();
            let metadata = tokio::fs::symlink_metadata(&path).await.map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接");
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                return protocol::err(code::INVALID_RESPONSE, "任务目录包含不支持的文件类型");
            }
            let relative = path
                .strip_prefix(source)
                .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            paths.insert(relative);
        }
    }
    Ok(paths)
}

fn safe_handoff_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn is_handoff_metadata_temp(name: &str) -> bool {
    name.ends_with(".tmp")
        && (name.starts_with(&format!(".{HANDOFF_MANIFEST_FILE}."))
            || name.starts_with(&format!(".{HANDOFF_META_FILE}.")))
}

async fn cleanup_handoff_backup_temps(target: &Path) -> AgentResult<()> {
    let mut entries = tokio::fs::read_dir(target).await.map_err(io_error)?;
    while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
        if !is_handoff_metadata_temp(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let metadata = tokio::fs::symlink_metadata(entry.path())
            .await
            .map_err(io_error)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return protocol::err(code::INVALID_RESPONSE, "handoff 元数据临时文件状态异常");
        }
        tokio::fs::remove_file(entry.path()).await.map_err(io_error)?;
    }
    Ok(())
}

async fn handoff_manifest_files_match(
    target: &Path,
    manifest: &Value,
    expected_count: u64,
    expected_total_bytes: u64,
) -> AgentResult<bool> {
    let Some(entries) = manifest.get("files").and_then(Value::as_array) else {
        return Ok(false);
    };
    if entries.len() as u64 != expected_count {
        return Ok(false);
    }
    let mut expected = BTreeMap::new();
    for entry in entries {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(sha256) = entry.get("sha256").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(size) = entry.get("sizeBytes").and_then(Value::as_u64) else {
            return Ok(false);
        };
        if !safe_handoff_relative_path(path) || !is_sha256(sha256) {
            return Ok(false);
        }
        if expected.insert(path.to_string(), (sha256.to_string(), size)).is_some() {
            return Ok(false);
        }
    }
    let mut actual_paths = task_directory_file_paths(target).await?;
    actual_paths.remove(HANDOFF_MANIFEST_FILE);
    actual_paths.remove(HANDOFF_META_FILE);
    let expected_paths: BTreeSet<String> = expected.keys().cloned().collect();
    if actual_paths != expected_paths {
        return Ok(false);
    }
    let mut actual_total_bytes = 0u64;
    for (path, (expected_sha256, expected_size)) in expected {
        let absolute = target.join(&path);
        if !protocol::is_path_inside(target, &absolute) {
            return Ok(false);
        }
        let bytes = match tokio::fs::read(&absolute).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        let Ok(content) = String::from_utf8(bytes) else {
            return Ok(false);
        };
        let normalized = normalize_snapshot_text(&content);
        let size = u64::try_from(normalized.as_bytes().len())
            .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "备份文件大小超出范围"))?;
        if size != expected_size || snapshot_sha256(&content) != expected_sha256 {
            return Ok(false);
        }
        actual_total_bytes = actual_total_bytes
            .checked_add(size)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "备份文件大小溢出"))?;
    }
    Ok(actual_total_bytes == expected_total_bytes)
}

fn previous_values_paths(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.get("path").and_then(Value::as_str))
        .filter(|path| !is_archive_snapshot_path(path))
        .map(str::to_string)
        .collect()
}

pub async fn read_local_task_snapshot_files(
    repo_path: &Path,
    task_dirs: Option<&HashSet<String>>,
) -> AgentResult<Vec<Value>> {
    let trellis_root = repo_path.join(".trellis");
    let tasks_root = trellis_root.join("tasks");
    for (path, label) in [(&trellis_root, ".trellis"), (&tasks_root, ".trellis/tasks")] {
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return protocol::err(
                    code::MISSING_TRELLIS,
                    format!("{label} 必须是真实目录"),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_error(error)),
        }
    }
    let mut files = Vec::new();
    let mut stack: Vec<PathBuf> = match task_dirs {
        Some(selected) => selected
            .iter()
            .filter(|task_dir| !is_archive_task_dir(task_dir))
            .filter_map(|task_dir| {
                protocol::resolve_task_dir_under(Path::new(ACTIVE_TASKS_ROOT), task_dir)
                    .map(|path| repo_path.join(path))
            })
            .collect(),
        None => vec![tasks_root.clone()],
    };
    while let Some(directory) = stack.pop() {
        match tokio::fs::symlink_metadata(&directory).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Err(error)
                if task_dirs.is_some() && error.kind() == std::io::ErrorKind::NotFound =>
            {
                continue
            }
            Ok(_) => {
                return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接")
            }
            Err(error) => return Err(io_error(error)),
        }
        let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let path = entry.path();
            let relative = path
                .strip_prefix(repo_path)
                .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            if is_archive_snapshot_path(&relative) {
                continue;
            }
            let metadata = tokio::fs::symlink_metadata(&path).await.map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接");
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !SNAPSHOT_EXTENSIONS.iter().any(|ext| name.ends_with(ext)) {
                continue;
            }
            let task_dir = match active_task_directory_from_relative(&relative) {
                Some(task_dir) => task_dir,
                None => continue,
            };
            if let Some(selected) = task_dirs {
                if !selected.contains(&task_dir) {
                    continue;
                }
            }
            let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本")
            })?;
            let content = normalize_snapshot_text(&text);
            files.push(json!({
                "path": format!(".trellis/{}", relative.trim_start_matches(".trellis/")),
                "content": content,
                "sha256": snapshot_sha256(&content),
            }));
        }
    }
    Ok(files)
}

pub(crate) fn urlencode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::store::AgentConfig;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn required_sequence_only_reads_conflict_details() {
        let mut error = AgentError::new(code::HTTP_ERROR, "clientSequence 必须严格递增");
        error.server_code = Some("CONFLICT".into());
        error.details = Some(json!({ "requiredClientSequence": 1_712_345_678_900u64 }));
        assert_eq!(required_client_sequence(&error), Some(1_712_345_678_900));
        // 非 CONFLICT、缺失或非正数的 details 一律不当作序号恢复信号。
        assert_eq!(
            required_client_sequence(&AgentError::new(code::HTTP_ERROR, "x")),
            None
        );
        error.server_code = Some("TASK_FILE_CONFLICT".into());
        assert_eq!(required_client_sequence(&error), None);
        error.server_code = Some("CONFLICT".into());
        error.details = Some(json!({ "requiredClientSequence": 0 }));
        assert_eq!(required_client_sequence(&error), None);
    }

    #[test]
    fn branch_guard_codes_cover_branch_failures() {
        assert!(is_branch_guard_code(code::BRANCH_MISMATCH));
        assert!(is_branch_guard_code(code::DETACHED_HEAD));
        assert!(!is_branch_guard_code(code::LOCAL_DIRTY));
    }

    #[test]
    fn baseline_branch_change_invalidates_binding_cache() {
        let current = test_binding("space-main");
        let mut next = current.clone();
        next.baseline_branch = Some("main".to_string());
        assert!(!binding_entry_unchanged(&current, &next));
    }

    #[test]
    fn pending_batch_preserves_merge_evidence() {
        let evidence = json!({
            "version": 1,
            "type": "tracked-in-head",
            "taskId": "task-a",
            "taskDir": ".trellis/tasks/task-a",
            "trackedPath": ".trellis/tasks/task-a/task.json",
            "sourceBranch": "dev1",
            "baselineBranch": "dev",
            "headCommit": "a".repeat(40),
        });
        let pending = parse_pending_batch(&json!({
            "batchId": "batch-1",
            "clientSequence": 3,
            "files": [{ "path": ".trellis/tasks/task-a/task.json" }],
            "mergeEvidence": evidence.clone(),
        }))
        .expect("pending batch");
        assert_eq!(pending.merge_evidence, Some(evidence));
    }

    #[test]
    fn cursor_defaults_new_guard_fields_and_bounds_rejected_summaries() {
        let legacy = cursor_from_entry(&json!({
            "revision": 12,
            "sequence": 9,
            "pendingRejected": {
                ".trellis/tasks/task-a": {
                    "batchId": "batch-a",
                    "clientSequence": 8,
                    "reason": "TASK_MERGE_EVIDENCE_REQUIRED",
                    "blockedAt": "2026-11-18T00:00:00.000Z"
                }
            }
        }));
        assert_eq!(legacy.revision_guard_version, 0);
        let rejected = legacy
            .pending_rejected
            .get(".trellis/tasks/task-a")
            .expect("rejected summary");
        assert_eq!(rejected.reason, "TASK_MERGE_EVIDENCE_REQUIRED");
        assert_eq!(rejected.created_at, rejected.blocked_at);

        let mut summaries = BTreeMap::new();
        for index in 0..55 {
            summaries.insert(
                format!(".trellis/tasks/task-{index}"),
                PendingRejection {
                    batch_id: format!("batch-{index}"),
                    client_sequence: index as u64 + 1,
                    reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                    created_at: format!("2026-11-18T00:00:{index:02}.000Z"),
                    blocked_at: format!("2026-11-18T00:00:{index:02}.000Z"),
                },
            );
        }
        trim_pending_rejections(&mut summaries);
        assert_eq!(summaries.len(), PENDING_REJECTED_LIMIT);
        assert!(!summaries.contains_key(".trellis/tasks/task-0"));
        assert!(summaries.contains_key(".trellis/tasks/task-54"));
    }

    #[test]
    fn pending_rejection_classifier_is_explicit_only() {
        for value in [
            "TASK_OWNERSHIP_REQUIRED",
            "TASK_OWNERSHIP_MISMATCH",
            "TASK_MERGE_EVIDENCE_REQUIRED",
            "TASK_MERGE_EVIDENCE_INVALID",
            "TASK_OWNED_BY_BASELINE",
        ] {
            assert!(is_explicit_pending_rejection(value), "{value}");
        }
        for value in ["NETWORK_ERROR", "HTTP_ERROR", "TASK_FILE_CONFLICT", "CONFLICT"] {
            assert!(!is_explicit_pending_rejection(value), "{value}");
        }
    }

    #[test]
    fn pending_skip_continues_only_for_explicit_rejection() {
        assert!(skipped_for_explicit_pending_rejection(&json!({
            "skipped": true,
            "reason": "TASK_OWNERSHIP_REQUIRED"
        })));
        assert!(skipped_for_explicit_pending_rejection(&json!({
            "skipped": true,
            "reason": "TASK_OWNED_BY_BASELINE"
        })));
        for reason in [
            "TASK_CONTROL_INACTIVE",
            "TASK_CONTROL_MISSING",
            "TASK_ARCHIVED",
            "TASK_WRITE_FORBIDDEN",
            "TASK_FILE_CONFLICT",
        ] {
            assert!(
                !skipped_for_explicit_pending_rejection(&json!({
                    "skipped": true,
                    "reason": reason
                })),
                "{reason}"
            );
        }
        assert!(!skipped_for_explicit_pending_rejection(&json!({
            "skipped": false,
            "reason": "TASK_OWNERSHIP_REQUIRED"
        })));
    }

    fn test_binding(task_space_id: &str) -> AgentBinding {
        AgentBinding {
            local_id: format!("local-{task_space_id}"),
            server_binding_id: Some(format!("binding-{task_space_id}")),
            task_space_id: task_space_id.to_string(),
            project_id: "project-1".to_string(),
            repo_path: format!("C:/repos/{task_space_id}"),
            branch_name: "main".to_string(),
            baseline_branch: None,
            team_id: None,
            remote_identity_key: "a".repeat(64),
            local_repo_key: "b".repeat(64),
            display_name: "Repo".to_string(),
            created_at: "2026-11-12T00:00:00.000Z".to_string(),
            allow_file_remote: false,
            read_only: false,
            sync_status: "approved".to_string(),
            detach_pending: false,
            initial_sync_mode: "bootstrap".to_string(),
            initial_sync_completed: true,
            initial_review_pending: false,
            live_sync_status: "ready".to_string(),
            live_sync_error: None,
            last_synced_at: None,
            last_head: None,
            last_error: None,
            last_error_code: None,
        }
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = std::process::Command::new(crate::agent::git::GIT_BINARY)
            .args(["-C", repo.to_str().expect("utf8 path")])
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_git_repo(repo: &Path) {
        run_git(repo, &["init", "--initial-branch=main"]);
        run_git(repo, &["config", "user.email", "test@example.com"]);
        run_git(repo, &["config", "user.name", "Test"]);
        run_git(repo, &["config", "commit.gpgsign", "false"]);
    }

    async fn write_task_json(repo: &Path, task_dir: &str, task_id: &str, branch: &str) {
        let directory = repo.join(task_dir);
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("task directory");
        tokio::fs::write(
            directory.join("task.json"),
            format!("{{\"id\":\"{task_id}\",\"branch\":\"{branch}\"}}\n"),
        )
        .await
        .expect("task json");
    }

    async fn mock_api_server(
        snapshot_payload: Value,
    ) -> (
        String,
        Arc<Mutex<Vec<Value>>>,
        Arc<Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock server");
        let address = listener.local_addr().expect("mock address");
        let changes = Arc::new(Mutex::new(Vec::new()));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let write_response_index = Arc::new(Mutex::new(0usize));
        let snapshot_payload = Arc::new(snapshot_payload);
        let captured_changes = changes.clone();
        let captured_requests = requests.clone();
        let captured_write_response_index = write_response_index.clone();
        let captured_snapshot_payload = snapshot_payload.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let changes = captured_changes.clone();
                let requests = captured_requests.clone();
                let write_response_index = captured_write_response_index.clone();
                let snapshot_payload = captured_snapshot_payload.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        if let Some(index) = request
                            .windows(4)
                            .position(|window| window == b"\r\n\r\n")
                        {
                            break index;
                        }
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                    };
                    let header = String::from_utf8_lossy(&request[..header_end]).to_string();
                    let has_json_content_type = header.lines().any(|line| {
                        let Some((name, value)) = line.split_once(':') else {
                            return false;
                        };
                        name.eq_ignore_ascii_case("content-type")
                            && value
                                .trim()
                                .to_ascii_lowercase()
                                .starts_with("application/json")
                    });
                    let content_length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    while request.len() < header_end + 4 + content_length {
                        let read = socket.read(&mut chunk).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..read]);
                    }
                    let body_start = header_end + 4;
                    let body = serde_json::from_slice::<Value>(
                        &request[body_start..body_start + content_length],
                    )
                    .unwrap_or(Value::Null);
                    let request_line = header.lines().next().unwrap_or_default();
                    let mut parts = request_line.split_whitespace();
                    let method = parts.next().unwrap_or_default();
                    let path = parts.next().unwrap_or_default();
                    requests
                        .lock()
                        .await
                        .push(format!("{method} {path}"));
                    let write_response = if method == "POST" && path.ends_with("/changes") {
                        let mut index = write_response_index.lock().await;
                        let current = *index;
                        *index += 1;
                        snapshot_payload
                            .get("writeResponses")
                            .and_then(Value::as_array)
                            .and_then(|responses| responses.get(current))
                            .cloned()
                    } else {
                        None
                    };
                    let (status, payload) = if method != "GET"
                        && method != "HEAD"
                        && !has_json_content_type
                    {
                        (
                            "415 Unsupported Media Type",
                            json!({ "code": "JSON_REQUIRED" }),
                        )
                    } else if path.contains("/snapshot?") {
                        ("200 OK", snapshot_payload.as_ref().clone())
                    } else if path.contains("/files?") {
                        let status = snapshot_payload
                            .get("directoryStatus")
                            .and_then(Value::as_u64)
                            .unwrap_or(200);
                        if status == 404 {
                            ("404 Not Found", json!({ "code": "TASK_NOT_FOUND" }))
                        } else {
                            (
                                "200 OK",
                                json!({
                                    "files": snapshot_payload
                                        .get("files")
                                        .cloned()
                                        .unwrap_or_else(|| Value::Array(Vec::new()))
                                }),
                            )
                        }
                    } else if method == "PUT" && path.ends_with("/cursor") {
                        ("200 OK", json!({}))
                    } else if method == "PUT" && path.ends_with("/ownership-inbox") {
                        ("200 OK", json!({ "ok": true }))
                    } else if method == "POST" && path.ends_with("/changes") {
                        changes.lock().await.push(body);
                        match write_response
                            .or_else(|| snapshot_payload.get("writeResponse").cloned())
                        {
                            Some(response) => {
                                let status = response
                                    .get("status")
                                    .and_then(Value::as_u64)
                                    .unwrap_or(200);
                                let status_line = match status {
                                    400 => "400 Bad Request",
                                    404 => "404 Not Found",
                                    405 => "405 Method Not Allowed",
                                    409 => "409 Conflict",
                                    429 => "429 Too Many Requests",
                                    500 => "500 Internal Server Error",
                                    _ => "200 OK",
                                };
                                (
                                    status_line,
                                    response.get("payload").cloned().unwrap_or(Value::Null),
                                )
                            }
                            None => (
                                "200 OK",
                                json!({
                                    "revision": snapshot_payload
                                        .get("writeRevision")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(2)
                                }),
                            ),
                        }
                    } else if method == "GET" && path.starts_with("/api/agent/tasks/") {
                        let key = decode_mock_task_key(path.trim_start_matches("/api/agent/tasks/"));
                        let control = snapshot_payload
                            .get("controls")
                            .and_then(Value::as_array)
                            .and_then(|controls| {
                                controls.iter().find(|control| {
                                    control.get("executionTaskKey").and_then(Value::as_str)
                                        == Some(key.as_str())
                                })
                            });
                        match control {
                            Some(control) => (
                                "200 OK",
                                json!({
                                    "task": remote_task_from_control(control),
                                    "contentAvailable": false,
                                }),
                            ),
                            None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                        }
                    } else if method == "POST" && path.ends_with("/claim") {
                        let encoded = path
                            .trim_start_matches("/api/agent/tasks/")
                            .trim_end_matches("/claim");
                        let key = decode_mock_task_key(encoded);
                        let control = snapshot_payload
                            .get("controls")
                            .and_then(Value::as_array)
                            .and_then(|controls| {
                                controls.iter().find(|control| {
                                    control.get("executionTaskKey").and_then(Value::as_str)
                                        == Some(key.as_str())
                                })
                            });
                        match control {
                            Some(control) => (
                                "200 OK",
                                json!({
                                    "task": remote_task_from_control(control),
                                    "lease": {
                                        "token": "lease-token",
                                        "expiresAt": "2099-01-01T00:00:00.000Z"
                                    }
                                }),
                            ),
                            None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                        }
                    } else if method == "POST" && path.ends_with("/heartbeat") {
                        let encoded = path
                            .trim_start_matches("/api/agent/tasks/")
                            .trim_end_matches("/heartbeat");
                        let key = decode_mock_task_key(encoded);
                        let control = snapshot_payload
                            .get("controls")
                            .and_then(Value::as_array)
                            .and_then(|controls| {
                                controls.iter().find(|control| {
                                    control.get("executionTaskKey").and_then(Value::as_str)
                                        == Some(key.as_str())
                                })
                            });
                        match control {
                            Some(control) => (
                                "200 OK",
                                json!({
                                    "task": remote_task_from_control(control),
                                    "lease": {
                                        "token": body.get("leaseToken").and_then(Value::as_str).unwrap_or("lease-token"),
                                        "expiresAt": "2099-01-01T00:00:00.000Z"
                                    }
                                }),
                            ),
                            None => ("404 Not Found", json!({ "code": "NOT_FOUND" })),
                        }
                    } else if method == "POST" && path.ends_with("/release") {
                        ("200 OK", json!({ "released": true, "idempotent": false }))
                    } else {
                        ("404 Not Found", json!({ "error": "unexpected request" }))
                    };
                    let payload = serde_json::to_vec(&payload).expect("response json");
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        payload.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    let _ = socket.write_all(&payload).await;
                });
            }
        });
        (format!("http://{address}"), changes, requests, task)
    }

    fn decode_mock_task_key(value: &str) -> String {
        let mut bytes = Vec::with_capacity(value.len());
        let raw = value.as_bytes();
        let mut index = 0;
        while index < raw.len() {
            if raw[index] == b'%' && index + 2 < raw.len() {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    bytes.push(byte);
                    index += 3;
                    continue;
                }
            }
            bytes.push(raw[index]);
            index += 1;
        }
        String::from_utf8(bytes).unwrap_or_else(|_| value.to_string())
    }

    fn remote_task_from_control(control: &Value) -> Value {
        let state = control
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("claimed");
        let materialization_state = match state {
            "pending_delivery" => "pending",
            "materialized" | "handoff_materialized" | "reassigned" | "archived" => "materialized",
            _ => "claimed",
        };
        let mut task = control.clone();
        task["archived"] = Value::Bool(state == "archived");
        task["materializationState"] = Value::String(materialization_state.to_string());
        task
    }

    struct ReplayFixture {
        root: PathBuf,
        store: Arc<ConfigStore>,
        sync: Arc<TaskSync>,
        binding: AgentBinding,
        changes: Arc<Mutex<Vec<Value>>>,
        requests: Arc<Mutex<Vec<String>>>,
        server_task: tokio::task::JoinHandle<()>,
        old_files: Vec<Value>,
        evidence: Value,
    }

    async fn replay_fixture(prefix: &str, write_response: Option<Value>) -> ReplayFixture {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture(prefix).await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        write_task_json(repo, task_dir, "task-a", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task"]);
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let old_content = "{\"id\":\"task-a\",\"branch\":null}\n";
        let old_files = vec![json!({
            "path": ".trellis/tasks/task-a/task.json",
            "content": old_content,
            "sha256": snapshot_sha256(old_content),
        })];
        let evidence = json!({
            "version": 1,
            "type": "tracked-in-head",
            "taskId": "task-a",
            "taskDir": task_dir,
            "trackedPath": ".trellis/tasks/task-a/task.json",
            "sourceBranch": "main",
            "baselineBranch": "team-board",
            "headCommit": "a".repeat(40),
        });
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 10,
                            "revisionGuardVersion": 1,
                            "sequence": 7,
                            "baselines": {
                                ".trellis/tasks/task-a/task.json": snapshot_sha256(old_content)
                            },
                            "pending": {
                                "batchId": "pending-batch",
                                "clientSequence": 7,
                                "files": old_files.clone(),
                                "mergeEvidence": evidence.clone(),
                                "createdAt": "2026-11-17T08:52:29.033Z"
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");

        let mut snapshot = json!({
            "revision": 10,
            "files": [],
            "writeRevision": 20
        });
        if let Some(response) = write_response {
            snapshot["writeResponse"] = response;
        }
        let (server_url, changes, requests, server_task) = mock_api_server(snapshot).await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;
        ReplayFixture {
            root,
            store,
            sync,
            binding,
            changes,
            requests,
            server_task,
            old_files,
            evidence,
        }
    }

    #[tokio::test]
    async fn pending_replay_reuses_snapshot_and_does_not_advance_applied_revision() {
        let fixture = replay_fixture("trellis-pending-replay", None).await;
        let pending = fixture
            .sync
            .read_cursor("space-1")
            .await
            .pending
            .expect("pending");
        let result = fixture
            .sync
            .retry_pending_batch(&fixture.binding, pending)
            .await
            .expect("replay")
            .expect("replay result");
        assert_eq!(result["revision"], 20);
        let sent = fixture
            .changes
            .lock()
            .await
            .first()
            .cloned()
            .expect("upload request");
        assert_eq!(sent["batchId"], "pending-batch");
        assert_eq!(sent["clientSequence"], 7);
        assert_eq!(sent["observedBranchName"], "main");
        assert_eq!(sent["files"], json!(fixture.old_files));
        assert_eq!(sent["mergeEvidence"], fixture.evidence);

        let cursor = fixture.store.read_task_cursors().await;
        assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 10);
        assert!(cursor["taskSpaces"]["space-1"].get("pending").is_none());

        fixture.server_task.abort();
        let _ = tokio::fs::remove_dir_all(fixture.root).await;
    }

    #[tokio::test]
    async fn local_only_task_upload_treats_missing_directory_as_first_snapshot() {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture("trellis-local-only-first-upload").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-local";
        let task_json = format!("{task_dir}/task.json");
        write_task_json(repo, task_dir, "task-local", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "local task"]);
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let (server_url, changes, requests, server_task) = mock_api_server(json!({
            "revision": 10,
            "directoryStatus": 404,
            "writeRevision": 11
        }))
        .await;
        let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;

        let result = sync
            .upload_directories(&binding, &[task_dir.to_string()], false, None)
            .await
            .expect("first upload");
        assert_eq!(result["committedRevision"], 11);

        let sent = changes.lock().await.clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0]["files"][0]["path"], task_json);

        let requests = requests.lock().await.clone();
        assert!(requests
            .iter()
            .any(|request| request.contains("/files?taskDir=")));
        assert!(requests.iter().any(|request| {
            request == "POST /api/agent/task-spaces/space-1/changes"
        }));

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn explicit_pending_rejection_clears_body_and_records_bounded_summary() {
        let fixture = replay_fixture(
            "trellis-pending-rejected",
            Some(json!({
                "status": 409,
                "payload": {
                    "error": "任务分支尚未确定",
                    "code": "TASK_OWNERSHIP_REQUIRED",
                    "details": { "taskDir": ".trellis/tasks/task-a" }
                }
            })),
        )
        .await;
        let pending = fixture
            .sync
            .read_cursor("space-1")
            .await
            .pending
            .expect("pending");
        let result = fixture
            .sync
            .retry_pending_batch(&fixture.binding, pending)
            .await
            .expect("rejected result")
            .expect("rejected response");
        assert_eq!(result["skipped"], true);
        assert_eq!(result["reason"], "TASK_OWNERSHIP_REQUIRED");

        let cursor = fixture.store.read_task_cursors().await;
        let space = &cursor["taskSpaces"]["space-1"];
        assert!(space.get("pending").is_none());
        assert_eq!(
            space["pendingRejected"][".trellis/tasks/task-a"]["reason"],
            "TASK_OWNERSHIP_REQUIRED"
        );
        assert!(
            space["pendingRejected"][".trellis/tasks/task-a"]
                .get("files")
                .is_none()
        );
        assert_eq!(
            space["ownershipPending"][".trellis/tasks/task-a"]["reason"],
            "TASK_OWNERSHIP_REQUIRED"
        );
        assert!(fixture
            .requests
            .lock()
            .await
            .iter()
            .any(|request| request.ends_with("/ownership-inbox")));

        fixture.server_task.abort();
        let _ = tokio::fs::remove_dir_all(fixture.root).await;
    }

    #[tokio::test]
    async fn explicit_pending_rejection_does_not_block_following_task_upload() {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture("trellis-pending-rejected-following-task").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let blocked_dir = ".trellis/tasks/task-a";
        let next_dir = ".trellis/tasks/task-b";
        let next_task_json = format!("{next_dir}/task.json");
        write_task_json(repo, blocked_dir, "task-a", "main").await;
        write_task_json(repo, next_dir, "task-b", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let pending_content = "{\"id\":\"task-a\",\"branch\":null}\n";
        let pending_files = vec![json!({
            "path": format!("{blocked_dir}/task.json"),
            "content": pending_content,
            "sha256": snapshot_sha256(pending_content),
        })];
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 10,
                            "revisionGuardVersion": 1,
                            "sequence": 7,
                            "pending": {
                                "batchId": "pending-batch",
                                "clientSequence": 7,
                                "files": pending_files
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");

        let (server_url, changes, _requests, server_task) = mock_api_server(json!({
            "revision": 10,
            "files": [],
            "writeResponses": [
                {
                    "status": 409,
                    "payload": {
                        "error": "任务分支尚未确定",
                        "code": "TASK_OWNERSHIP_REQUIRED"
                    }
                },
                {
                    "status": 200,
                    "payload": { "revision": 21 }
                }
            ]
        }))
        .await;
        let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;

        let result = sync
            .upload_directories(
                &binding,
                &[blocked_dir.to_string(), next_dir.to_string()],
                false,
                None,
            )
            .await
            .expect("upload");
        assert_eq!(result["committedRevision"], 21);

        let sent = changes.lock().await.clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["batchId"], "pending-batch");
        assert_eq!(sent[0]["files"][0]["content"], pending_content);
        assert_eq!(sent[1]["files"][0]["path"], next_task_json);

        let cursor = store.read_task_cursors().await;
        let space = &cursor["taskSpaces"]["space-1"];
        assert!(space.get("pending").is_none());
        assert_eq!(
            space["pendingRejected"][blocked_dir]["reason"],
            "TASK_OWNERSHIP_REQUIRED"
        );
        assert!(space["baselines"].get(next_task_json.as_str()).is_some());
        assert_eq!(space["revision"], 10);

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn revision_guard_repairs_once_without_overwriting_conflicted_local_task() {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture("trellis-revision-guard").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        let task_path = repo.join(task_dir).join("task.json");
        let local_content =
            "{\"id\":\"task-a\",\"branch\":\"main\",\"title\":\"本地版本\"}\n";
        tokio::fs::create_dir_all(task_path.parent().expect("parent"))
            .await
            .expect("task dir");
        tokio::fs::write(&task_path, local_content)
            .await
            .expect("local task");
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task"]);
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let previous_baseline = "b".repeat(64);
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 1,
                            "revisionGuardVersion": 0,
                            "sequence": 1,
                            "baselines": {
                                ".trellis/tasks/task-a/task.json": previous_baseline.clone()
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");
        let remote_content =
            "{\"id\":\"task-a\",\"branch\":\"main\",\"title\":\"服务端版本\"}\n";
        let (server_url, _changes, requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": [
                snapshot_file_value(".trellis/tasks/task-a/task.json", remote_content)
            ]
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;

        let result = sync
            .repair_revision_guard(&binding)
            .await
            .expect("repair");
        assert_eq!(result["repaired"], true);
        assert_eq!(
            tokio::fs::read_to_string(&task_path)
                .await
                .expect("local content"),
            local_content
        );
        let cursor = store.read_task_cursors().await;
        assert_eq!(
            cursor["taskSpaces"]["space-1"]["revisionGuardVersion"],
            REVISION_GUARD_VERSION
        );
        assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 1);
        assert!(cursor["taskSpaces"]["space-1"]["deferred"]
            .get(task_dir)
            .is_some());
        assert_eq!(
            cursor["taskSpaces"]["space-1"]["baselines"][".trellis/tasks/task-a/task.json"],
            previous_baseline
        );

        let snapshot_requests = requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/snapshot?"))
            .count();
        let second = sync
            .repair_revision_guard(&binding)
            .await
            .expect("guard current");
        assert_eq!(second["reason"], "REVISION_GUARD_CURRENT");
        assert_eq!(
            requests
                .lock()
                .await
                .iter()
                .filter(|request| request.contains("/snapshot?"))
                .count(),
            snapshot_requests
        );

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn revision_guard_downloads_baseline_cross_source_server_only_task() {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture("trellis-revision-guard-cross-source").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        tokio::fs::write(repo.join("README.md"), "repo\n")
            .await
            .expect("readme");
        run_git(repo, &["add", "README.md"]);
        run_git(repo, &["commit", "--no-verify", "-m", "init"]);

        binding.baseline_branch = Some("main".to_string());
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 1,
                            "revisionGuardVersion": 0,
                            "sequence": 1
                        }
                    }
                }),
            )
            .await
            .expect("cursor");

        let task_dir = ".trellis/tasks/task-source";
        let task_json = "{\"id\":\"task-source\",\"branch\":\"feature/source\"}\n";
        let task_json_path = format!("{task_dir}/task.json");
        let prd_path = format!("{task_dir}/prd.md");
        let (server_url, changes, _requests, server_task) = mock_api_server(json!({
            "revision": 3,
            "files": [
                snapshot_file_value(task_json_path.as_str(), task_json),
                snapshot_file_value(prd_path.as_str(), "# 来源任务\n")
            ]
        }))
        .await;
        let api = Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store.clone(), api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;

        let result = sync
            .repair_revision_guard(&binding)
            .await
            .expect("repair");
        assert_eq!(result["repaired"], true);
        assert_eq!(result["downloaded"], 1);
        assert_eq!(
            tokio::fs::read_to_string(repo.join(task_json_path.as_str()))
                .await
                .expect("downloaded task json"),
            task_json
        );
        assert_eq!(
            tokio::fs::read_to_string(repo.join(prd_path.as_str()))
                .await
                .expect("downloaded prd"),
            "# 来源任务\n"
        );
        let cursor = store.read_task_cursors().await;
        assert_eq!(
            cursor["taskSpaces"]["space-1"]["revisionGuardVersion"],
            REVISION_GUARD_VERSION
        );
        assert_eq!(cursor["taskSpaces"]["space-1"]["revision"], 3);
        assert_eq!(
            cursor["taskSpaces"]["space-1"]["baselines"][task_json_path.as_str()],
            snapshot_sha256(task_json)
        );
        assert!(changes.lock().await.is_empty());

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn revision_guard_keeps_cross_source_tasks_only_for_baseline_binding() {
        let group = SnapshotGroup {
            task_dir: ".trellis/tasks/task-source".to_string(),
            archived: false,
            archive_month: None,
            files: Vec::new(),
            task_id: Some("task-source".to_string()),
            task_branch: Some("feature/source".to_string()),
        };
        let mut binding = test_binding("space-1");
        binding.baseline_branch = Some("team-board".to_string());
        let mut groups = vec![group.clone()];
        retain_server_groups_for_revision_guard(&binding, &mut groups);
        assert!(groups.is_empty());

        binding.baseline_branch = Some("main".to_string());
        groups.push(group);
        retain_server_groups_for_revision_guard(&binding, &mut groups);
        assert_eq!(groups.len(), 1);
    }

    #[test]
    fn cross_source_server_apply_requires_baseline_guard_or_conflict_mode() {
        let mut binding = test_binding("space-1");
        binding.baseline_branch = Some("main".to_string());
        assert!(allows_cross_source_server_group(
            &binding,
            REVISION_GUARD_SYNC_MODE
        ));
        assert!(allows_cross_source_server_group(
            &binding,
            CONFLICT_SYNC_MODE
        ));
        assert!(!allows_cross_source_server_group(&binding, "safe"));
        assert!(!allows_cross_source_server_group(&binding, "incremental"));

        binding.baseline_branch = Some("team-board".to_string());
        assert!(!allows_cross_source_server_group(
            &binding,
            REVISION_GUARD_SYNC_MODE
        ));
        assert!(!allows_cross_source_server_group(
            &binding,
            CONFLICT_SYNC_MODE
        ));
    }

    #[test]
    fn upload_request_carries_persisted_fencing_fields() {
        let files = vec![json!({
            "path": ".trellis/tasks/task-a/task.json",
            "content": "{\"id\":\"task-a\",\"branch\":null}\n",
            "sha256": snapshot_sha256("{\"id\":\"task-a\",\"branch\":null}\n"),
        })];
        let evidence = json!({
            "version": 1,
            "type": "tracked-in-head",
            "taskId": "task-a",
            "taskDir": ".trellis/tasks/task-a",
            "trackedPath": ".trellis/tasks/task-a/task.json",
            "sourceBranch": "main",
            "baselineBranch": "team-board",
            "headCommit": "a".repeat(40),
        });
        let batch = PendingBatch {
            batch_id: "batch-1".to_string(),
            client_sequence: 7,
            files: files.clone(),
            merge_evidence: Some(evidence.clone()),
            created_at: "2026-11-18T00:00:00.000Z".to_string(),
        };
        let request = build_upload_request(
            &batch,
            8,
            "main",
            Some(&UploadFence {
                task_version: 4,
                lease_token: "lease-token".to_string(),
            }),
        );
        assert_eq!(request["taskVersion"], 4);
        assert_eq!(request["leaseToken"], "lease-token");
        assert_eq!(request["files"][0]["path"], ".trellis/tasks/task-a/task.json");
        assert_eq!(request["files"], json!(files));
        assert_eq!(request["mergeEvidence"], evidence);
        assert_eq!(request["batchId"], "batch-1");
        assert_eq!(request["clientSequence"], 8);
        assert_eq!(request["observedBranchName"], "main");
    }

    #[test]
    fn first_upload_response_control_supplies_persisted_execution_key() {
        let control = TaskControl::from_control_value(&json!({
            "executionTaskKey": "space-1::task-a",
            "taskId": "task-a",
            "relativeDir": ".trellis/tasks/task-a",
            "title": "任务 A",
            "state": "materialized",
            "taskVersion": 1
        }))
        .expect("control");
        assert_eq!(
            response_control_execution_task_key(None, &control)
                .expect("response key")
                .as_str(),
            "space-1::task-a"
        );
        assert!(response_control_execution_task_key(Some("space-1::other"), &control).is_err());
    }

    #[test]
    fn snapshot_controls_distinguish_legacy_and_authoritative_empty() {
        assert!(parse_snapshot_controls(&json!({ "files": [] }))
            .expect("legacy snapshot")
            .is_none());
        assert_eq!(
            parse_snapshot_controls(&json!({ "files": [], "controls": [] }))
                .expect("authoritative snapshot")
                .expect("controls")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn deletion_only_upload_recovers_persisted_control_identity() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-control-delete").await;
        let mut state = TaskControlStateFile::empty();
        state
            .upsert_control(
                &binding.local_id,
                &TaskControl {
                    execution_task_key: "space-1::task-a".to_string(),
                    task_id: "task-a".to_string(),
                    relative_dir: ".trellis/tasks/task-a".to_string(),
                    title: "任务 A".to_string(),
                    state: "materialized".to_string(),
                    task_version: 3,
                    assignee_user_id: Some("user-b".to_string()),
                    handoff_state: "none".to_string(),
                    materialized_revision: None,
                    materialized_at: None,
                    lease_held_by_other_user: false,
                    updated_at: "2026-11-17T00:00:00.000Z".to_string(),
                },
            )
            .expect("persist control");
        store
            .write_json(&store.paths.task_control_file, &state)
            .await
            .expect("write control state");

        let files = vec![
            json!({
                "path": ".trellis/tasks/task-a/task.json",
                "deleted": true,
            }),
            json!({
                "path": ".trellis/tasks/task-a/prd.md",
                "deleted": true,
            }),
        ];
        assert_eq!(
            sync.persisted_control_key_for_upload(&binding, &files)
                .await
                .expect("recover control key"),
            Some("space-1::task-a".to_string())
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn claim_persists_lease_for_restart_recovery() {
        let (root, store, _sync, binding) =
            test_task_sync_fixture("trellis-control-lease").await;
        let controls = json!([{
            "executionTaskKey": "space-1::task-a",
            "taskId": "task-a",
            "relativeDir": ".trellis/tasks/task-a",
            "title": "任务 A",
            "state": "materialized",
            "taskVersion": 3,
            "assigneeUserId": "user-b",
            "handoffState": "none",
            "updatedAt": "2026-11-17T00:00:00.000Z"
        }]);
        let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": [],
            "controls": controls,
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = TaskSync::new(store.clone(), api.clone(), sink);
        sync.set_bindings(vec![binding.clone()]).await;
        let (control, token) = sync
            .claim_remote_task(&binding, "space-1::task-a")
            .await
            .expect("claim");
        assert_eq!(control.task_version, 3);
        assert_eq!(token, "lease-token");
        let (heartbeat_control, heartbeat_token) = sync
            .heartbeat_remote_task(&binding, "space-1::task-a", &token)
            .await
            .expect("heartbeat");
        assert_eq!(heartbeat_control.task_version, 3);
        assert_eq!(heartbeat_token, "lease-token");
        drop(sync);

        let restarted_sink: ControlSink = Arc::new(|_| {});
        let restarted = TaskSync::new(store.clone(), api, restarted_sink);
        let restored = restarted
            .stored_task_lease("space-1::task-a")
            .await
            .expect("restored lease");
        assert_eq!(restored.token, "lease-token");
        assert_eq!(restored.expires_at, "2099-01-01T00:00:00.000Z");
        let released = restarted
            .release_remote_task("space-1::task-a", &restored.token)
            .await
            .expect("release");
        assert_eq!(released["released"], true);
        restarted
            .remove_task_lease("space-1::task-a")
            .await
            .expect("remove lease");
        assert!(restarted
            .stored_task_lease("space-1::task-a")
            .await
            .is_none());

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    async fn test_task_sync_fixture(
        prefix: &str,
    ) -> (PathBuf, Arc<ConfigStore>, TaskSync, AgentBinding) {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
        store.ensure_directories().await.expect("directories");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = TaskSync::new(store.clone(), api, sink);
        let mut binding = test_binding("space-1");
        let repo_path = root.join("repo");
        tokio::fs::create_dir_all(repo_path.join(".trellis").join("tasks"))
            .await
            .expect("task root");
        binding.repo_path = repo_path.to_string_lossy().to_string();
        (root, store, sync, binding)
    }

    #[tokio::test]
    async fn heartbeat_wake_fires_only_when_bindings_change() {
        let (_root, _store, sync, binding) = test_task_sync_fixture("heartbeat-wake").await;
        let wake = Arc::new(Notify::new());
        let sync = sync.with_heartbeat_wake(wake.clone());

        let notified = wake.notified();
        tokio::pin!(notified);
        sync.set_bindings(vec![binding.clone()]).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(500), notified)
                .await
                .is_ok(),
            "绑定集合变化必须唤醒心跳"
        );

        let notified = wake.notified();
        tokio::pin!(notified);
        sync.set_bindings(vec![binding]).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(200), notified)
                .await
                .is_err(),
            "绑定集合未变化不应唤醒心跳"
        );
    }

    async fn exact_deferred_fixture(
        prefix: &str,
    ) -> (PathBuf, Arc<ConfigStore>, AgentBinding, String) {
        let (root, store, _sync, mut binding) = test_task_sync_fixture(prefix).await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a".to_string();
        write_task_json(repo, &task_dir, "task-a", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task"]);
        binding.initial_sync_completed = true;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let task_hash = snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"main\"}\n");
        write_deferred_cursor(&store, &task_dir, &task_hash, &task_hash).await;
        (root, store, binding, task_dir)
    }

    async fn write_deferred_cursor(
        store: &ConfigStore,
        task_dir: &str,
        baseline_hash: &str,
        deferred_hash: &str,
    ) {
        let task_json = format!("{task_dir}/task.json");
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 1,
                            "revisionGuardVersion": 1,
                            "sequence": 1,
                            "baselines": {
                                (task_json.clone()): baseline_hash
                            },
                            "deferred": {
                                (task_dir): {
                                    (task_json): deferred_hash
                                }
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");
    }

    #[tokio::test]
    async fn baseline_ownership_ignores_tracked_source_branches_and_reuses_head_tree() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-baseline-ownership").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        for index in 0..17 {
            write_task_json(
                repo,
                &format!(".trellis/tasks/tracked-{index}"),
                &format!("tracked-{index}"),
                "dev1",
            )
            .await;
        }
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(
            repo,
            &["commit", "--no-verify", "-m", "track merged tasks"],
        );
        write_task_json(
            repo,
            ".trellis/tasks/active-probe",
            "active-probe",
            "dev1",
        )
        .await;
        let groups = sync.local_groups(&binding, None).await.expect("local groups");
        assert_eq!(groups.len(), 18);

        binding.baseline_branch = Some("main".to_string());
        binding.branch_name = "dev1".to_string();
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        assert!(sync
            .ownership_paused_task_dirs(&binding, &groups)
            .await
            .is_empty());
        assert!(sync.head_tree_cache.lock().await.is_empty());
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        binding.branch_name = "main".to_string();
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let paused = sync
            .ownership_paused_task_dirs(&binding, &groups)
            .await;
        assert_eq!(
            paused.into_iter().collect::<Vec<_>>(),
            vec![".trellis/tasks/active-probe".to_string()]
        );
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let associations =
            crate::agent::device::read_local_associations(&store, Some(&sync))
                .await
                .expect("local associations");
        assert_eq!(associations[0].ownership_paused_count, 1);
        assert_eq!(
            associations[0].ownership_paused_task_dirs,
            vec![".trellis/tasks/active-probe".to_string()]
        );
        let (_, first_paths) = sync.head_tree_paths(&binding).await.expect("head tree");
        let (_, second_paths) = sync.head_tree_paths(&binding).await.expect("cached head tree");
        assert_eq!(first_paths.len(), 17);
        assert!(Arc::ptr_eq(&first_paths, &second_paths));
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        run_git(repo, &["checkout", "--quiet", "-b", "dev1"]);
        let cached_paused = sync
            .ownership_paused_task_dirs(&binding, &groups)
            .await;
        assert_eq!(
            cached_paused.into_iter().collect::<Vec<_>>(),
            vec![".trellis/tasks/active-probe".to_string()]
        );
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        {
            let mut cache = sync.head_tree_cache.lock().await;
            let entry = cache
                .get_mut(&binding.task_space_id)
                .expect("cached head tree");
            entry.validated_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
        }
        let stale_paused = sync
            .ownership_paused_task_dirs(&binding, &groups)
            .await;
        assert_eq!(stale_paused.len(), 18);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn ownership_projection_caches_local_task_scan() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-projection-cache").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(
            repo,
            ".trellis/tasks/merged-task",
            "merged-task",
            "dev1",
        )
        .await;
        write_task_json(
            repo,
            ".trellis/tasks/active-probe",
            "active-probe",
            "dev1",
        )
        .await;
        run_git(repo, &["add", ".trellis/tasks/merged-task"]);
        run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let (paused, local_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("initial projection");
        assert_eq!(
            paused.iter().cloned().collect::<Vec<_>>(),
            vec![".trellis/tasks/active-probe".to_string()]
        );
        assert_eq!(local_dirs.len(), 2);
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        write_task_json(repo, ".trellis/tasks/new-probe", "new-probe", "dev1").await;
        let (cached_paused, cached_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("cached projection");
        assert_eq!(cached_paused.len(), 1);
        assert_eq!(cached_dirs.len(), 2);

        let stale_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
        {
            let mut cache = sync.ownership_projection_cache.lock().await;
            let entry = cache
                .get_mut(&binding.task_space_id)
                .expect("stale ownership projection");
            entry.validated_at = stale_at;
        }
        let (unchanged_paused, unchanged_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("same-head projection");
        assert_eq!(unchanged_paused.len(), 1);
        assert_eq!(unchanged_dirs.len(), 2);
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        {
            let cache = sync.ownership_projection_cache.lock().await;
            let entry = cache
                .get(&binding.task_space_id)
                .expect("refreshed ownership projection");
            assert!(entry.validated_at > stale_at);
            assert!(entry.validated_at.elapsed() < OWNERSHIP_PROJECTION_CACHE_TTL);
        }

        sync.invalidate_ownership_projection(&binding.task_space_id)
            .await;
        let (refreshed_paused, refreshed_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("invalidated projection");
        let mut refreshed = refreshed_paused.iter().cloned().collect::<Vec<_>>();
        refreshed.sort();
        assert_eq!(
            refreshed,
            vec![
                ".trellis/tasks/active-probe".to_string(),
                ".trellis/tasks/new-probe".to_string()
            ]
        );
        assert_eq!(refreshed_dirs.len(), 3);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn ownership_projection_does_not_write_back_after_invalidation() {
        let (root, _store, sync, binding) =
            test_task_sync_fixture("trellis-ownership-projection-race").await;
        let projection_epoch = sync.projection_epoch(&binding.task_space_id).await;

        sync.invalidate_ownership_projection(&binding.task_space_id)
            .await;
        sync.cache_ownership_projection(
            binding.task_space_id.clone(),
            projection_epoch,
            OwnershipProjectionCache {
                local_id: binding.local_id.clone(),
                branch_name: binding.branch_name.clone(),
                baseline_branch: binding.baseline_branch.clone(),
                repo_path: binding.repo_path.clone(),
                head_commit: "stale-head".to_string(),
                head_fingerprint: "stale-fingerprint".to_string(),
                paused: Arc::new(HashSet::new()),
                local_dirs: Arc::new(HashSet::new()),
                validated_at: Instant::now(),
            },
        )
        .await;

        assert!(!sync
            .ownership_projection_cache
            .lock()
            .await
            .contains_key(&binding.task_space_id));
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn unrelated_projection_invalidation_does_not_block_cache_write() {
        let (root, _store, sync, binding) =
            test_task_sync_fixture("trellis-ownership-projection-local-epoch").await;
        let projection_epoch = sync.projection_epoch(&binding.task_space_id).await;

        sync.invalidate_ownership_projection("another-task-space")
            .await;
        sync.cache_ownership_projection(
            binding.task_space_id.clone(),
            projection_epoch,
            OwnershipProjectionCache {
                local_id: binding.local_id.clone(),
                branch_name: binding.branch_name.clone(),
                baseline_branch: binding.baseline_branch.clone(),
                repo_path: binding.repo_path.clone(),
                head_commit: "head".to_string(),
                head_fingerprint: "fingerprint".to_string(),
                paused: Arc::new(HashSet::new()),
                local_dirs: Arc::new(HashSet::new()),
                validated_at: Instant::now(),
            },
        )
        .await;

        assert!(sync
            .ownership_projection_cache
            .lock()
            .await
            .contains_key(&binding.task_space_id));
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn ownership_projection_refreshes_paused_after_head_change() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-projection-head").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/baseline-task", "baseline-task", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "baseline task"]);
        write_task_json(
            repo,
            ".trellis/tasks/merged-later",
            "merged-later",
            "dev1",
        )
        .await;

        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let (paused, local_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("initial projection");
        assert_eq!(
            paused.iter().cloned().collect::<Vec<_>>(),
            vec![".trellis/tasks/merged-later".to_string()]
        );
        assert_eq!(local_dirs.len(), 2);
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );

        {
            let mut cache = sync.ownership_projection_cache.lock().await;
            let entry = cache
                .get_mut(&binding.task_space_id)
                .expect("cached ownership projection");
            entry.validated_at = Instant::now() - OWNERSHIP_PROJECTION_CACHE_TTL;
        }
        run_git(repo, &["add", ".trellis/tasks/merged-later"]);
        run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

        let (refreshed_paused, refreshed_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("projection after head change");
        assert!(refreshed_paused.is_empty());
        assert_eq!(refreshed_dirs.len(), 2);
        assert_eq!(
            sync.head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn ownership_projection_does_not_decode_other_task_files() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-ownership-projection-content").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        tokio::fs::write(
            repo.join(".trellis/tasks/task-a").join("prd.md"),
            [0xff_u8, 0xfe],
        )
        .await
        .expect("invalid utf8 prd");
        let text_only = repo.join(".trellis/tasks/text-only");
        tokio::fs::create_dir_all(&text_only)
            .await
            .expect("text-only directory");
        tokio::fs::write(text_only.join("prd.md"), [0xff_u8, 0xfe])
            .await
            .expect("invalid utf8 text-only prd");
        let ignored = repo.join(".trellis/tasks/ignored");
        tokio::fs::create_dir_all(&ignored)
            .await
            .expect("ignored directory");
        tokio::fs::write(ignored.join("image.bin"), [0xff_u8, 0xfe])
            .await
            .expect("unsupported file");
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task files"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let (paused, local_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("projection ignores non-task content");
        assert!(paused.is_empty());
        let mut dirs: Vec<String> = local_dirs.iter().cloned().collect();
        dirs.sort();
        assert_eq!(
            dirs,
            vec![
                ".trellis/tasks/task-a".to_string(),
                ".trellis/tasks/text-only".to_string()
            ]
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn persistent_ownership_index_reuses_tasks_without_git() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-index-hit").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        write_task_json(repo, ".trellis/tasks/task-b", "task-b", "dev1").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let sync = sync.with_ownership_index_writer();
        let (paused, local_dirs) = sync
            .ownership_projection(&binding)
            .await
            .expect("initial persistent projection");
        assert!(paused.is_empty());
        assert_eq!(local_dirs.len(), 2);
        assert!(store.paths.ownership_index_file.exists());

        let reads = sync
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst);
        let scans = sync
            .head_tree_scans
            .load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(reads, 2);
        assert_eq!(scans, 1);
        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let restarted =
            TaskSync::new(store.clone(), api, Arc::new(|_| {})).with_ownership_index_writer();
        restarted
            .ownership_validation_started
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let (paused, local_dirs) = restarted
            .ownership_projection(&binding)
            .await
            .expect("persistent projection after restart");
        assert!(paused.is_empty());
        assert_eq!(local_dirs.len(), 2);
        assert_eq!(
            restarted
                .task_json_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .task_entries_examined
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .branch_validations
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .head_tree_scans
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn temporary_task_sync_never_writes_ownership_index() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-index-read-only").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        binding.live_sync_status = "ready".to_string();
        sync.set_bindings(vec![binding.clone()]).await;
        sync.ownership_projection(&binding)
            .await
            .expect("temporary projection");
        assert!(!store.paths.ownership_index_file.exists());

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn persistent_ownership_index_reparses_only_changed_task_json() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-ownership-index-incremental").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        write_task_json(repo, ".trellis/tasks/task-b", "task-b", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let sync = sync.with_ownership_index_writer();
        sync.ownership_projection(&binding)
            .await
            .expect("initial projection");

        let target = repo.join(".trellis/tasks/task-b/task.json");
        tokio::fs::write(
            &target,
            b"{\"id\":\"task-b\",\"branch\":\"dev1\",\"title\":\"changed\"}\n",
        )
        .await
        .expect("change task json");
        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let restarted = TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
        let projection_epoch = restarted.projection_epoch("space-1").await;
        restarted
            .refresh_ownership_index_binding(&binding, projection_epoch)
            .await
            .expect("incremental projection");
        assert_eq!(
            restarted
                .task_json_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            restarted
                .branch_validations
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn warm_local_sync_reuses_all_task_file_hashes_without_reads() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-local-sync-index-hit").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        write_task_json(repo, task_dir, "task-a", "main").await;
        tokio::fs::write(repo.join(task_dir).join("prd.md"), "# 任务\n")
            .await
            .expect("prd");
        tokio::fs::write(repo.join(task_dir).join("implement.jsonl"), "{}\n")
            .await
            .expect("jsonl");
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let warmup = sync.with_ownership_index_writer();
        let projection_epoch = warmup.projection_epoch("space-1").await;
        warmup
            .refresh_ownership_index_binding_with_scan(&binding, projection_epoch, true)
            .await
            .expect("warm ownership file index");
        assert_eq!(
            warmup.task_file_reads.load(std::sync::atomic::Ordering::SeqCst),
            3
        );

        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let restarted =
            TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
        let (dirty, _, _) = restarted
            .local_sync_state(&binding, &Cursor::default(), &BTreeMap::new())
            .await
            .expect("warm local sync");
        assert_eq!(dirty, vec![task_dir.to_string()]);
        assert_eq!(
            restarted
                .task_file_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .task_json_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .task_entries_examined
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn local_sync_rehashes_only_changed_file_and_matches_full_scan() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-local-sync-index-incremental").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        write_task_json(repo, task_dir, "task-a", "main").await;
        let prd = repo.join(task_dir).join("prd.md");
        tokio::fs::write(&prd, "# 原内容\n").await.expect("prd");
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let warmup = sync.with_ownership_index_writer();
        let projection_epoch = warmup.projection_epoch("space-1").await;
        warmup
            .refresh_ownership_index_binding_with_scan(&binding, projection_epoch, true)
            .await
            .expect("warm ownership file index");
        tokio::fs::write(&prd, "# 原内容已修改\n")
            .await
            .expect("changed prd");

        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let restarted =
            TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
        let cursor = Cursor::default();
        let server_baselines = BTreeMap::new();
        let indexed = restarted
            .local_sync_state(&binding, &cursor, &server_baselines)
            .await
            .expect("incremental local sync");
        assert_eq!(
            restarted
                .task_file_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            restarted
                .task_json_reads
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(
            restarted
                .task_entries_examined
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );

        let files = read_local_task_snapshot_files(repo, None)
            .await
            .expect("full local scan");
        let groups = group_task_snapshot_files(&files).expect("full local groups");
        let full = local_sync_state_from_groups(&cursor, &groups, &server_baselines);
        assert_eq!(indexed, full);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn forced_local_sync_detects_change_after_projection_warmup() {
        let (root, store, _sync, binding) =
            test_task_sync_fixture("trellis-local-sync-force-after-warmup").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        write_task_json(repo, task_dir, "task-a", "main").await;
        let prd = repo.join(task_dir).join("prd.md");
        tokio::fs::write(&prd, "# 原内容\n").await.expect("prd");
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");

        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_ownership_index_writer();
        let cursor = Cursor::default();
        let server_baselines = BTreeMap::new();
        sync.local_sync_state(&binding, &cursor, &server_baselines)
            .await
            .expect("initial local sync");

        tokio::fs::write(&prd, "# 原内容已修改\n")
            .await
            .expect("changed prd");
        let reads_before = sync
            .task_file_reads
            .load(std::sync::atomic::Ordering::SeqCst);
        let json_reads_before = sync
            .task_json_reads
            .load(std::sync::atomic::Ordering::SeqCst);
        let entries_before = sync
            .task_entries_examined
            .load(std::sync::atomic::Ordering::SeqCst);

        let (dirty, _, _) = sync
            .local_sync_state(&binding, &cursor, &server_baselines)
            .await
            .expect("forced local sync");
        assert_eq!(dirty, vec![task_dir.to_string()]);
        assert_eq!(
            sync.task_file_reads
                .load(std::sync::atomic::Ordering::SeqCst)
                - reads_before,
            1
        );
        assert_eq!(
            sync.task_json_reads
                .load(std::sync::atomic::Ordering::SeqCst)
                - json_reads_before,
            0
        );
        assert_eq!(
            sync.task_entries_examined
                .load(std::sync::atomic::Ordering::SeqCst)
                - entries_before,
            2
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn persistent_projection_does_not_bypass_branch_guard() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-index-branch-guard").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "task"]);
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        sync.with_ownership_index_writer()
            .ownership_projection(&binding)
            .await
            .expect("cached projection");
        run_git(repo, &["checkout", "--quiet", "-b", "feature"]);

        binding.live_sync_status = "ready".to_string();
        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let restarted = TaskSync::new(store, api, Arc::new(|_| {}));
        let error = restarted
            .assert_binding_branch(&binding)
            .await
            .expect_err("stale ownership cache must not bypass branch guard");
        assert_eq!(error.code, code::BRANCH_MISMATCH);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn associations_read_persistent_index_before_runtime_starts() {
        let (root, store, sync, mut binding) =
            test_task_sync_fixture("trellis-ownership-index-device").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/task-a", "task-a", "main").await;
        write_task_json(repo, ".trellis/tasks/task-b", "task-b", "dev1").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "tasks"]);
        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        sync.with_ownership_index_writer()
            .ownership_projection(&binding)
            .await
            .expect("projection");
        tokio::fs::remove_dir_all(repo.join(".trellis/tasks/task-a"))
            .await
            .expect("remove task-a");
        tokio::fs::remove_dir_all(repo.join(".trellis/tasks/task-b"))
            .await
            .expect("remove task-b");

        let associations = crate::agent::device::read_local_associations(&store, None)
            .await
            .expect("indexed associations");
        assert_eq!(associations.len(), 1);
        assert_eq!(associations[0].ownership_paused_count, 0);
        assert_eq!(associations[0].deferred_count, 0);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn initial_sync_pending_binding_not_listening() {
        let (root, store, mut binding, _task_dir) =
            exact_deferred_fixture("trellis-listening-pending").await;
        binding.initial_sync_completed = false;
        let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));

        let task_space_ids = sync.prepare_startup_bindings(vec![binding]).await;

        assert_eq!(task_space_ids, vec!["space-1".to_string()]);
        assert!(sync.active_bindings().await.is_empty());
        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn startup_bindings_activate_before_background_pull() {
        let (root, store, binding, task_dir) =
            exact_deferred_fixture("trellis-startup-activate").await;
        let (server_url, _changes, requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api = Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));

        let task_space_ids = sync
            .prepare_startup_bindings(vec![binding])
            .await;

        assert_eq!(task_space_ids, vec!["space-1".to_string()]);
        assert_eq!(sync.active_bindings().await.len(), 1);
        assert!(requests.lock().await.is_empty());
        let (events, receiver) = mpsc::unbounded_channel();
        let watcher_sync = sync.clone();
        let watch_task = tokio::spawn(async move { watcher_sync.watch_loop(receiver).await });
        events
            .send(WatchEvent::TaskPath {
                task_space_id: "space-1".to_string(),
                relative_path: format!("{task_dir}/task.json"),
            })
            .expect("watch event");
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if sync.deferred_uploads.lock().await.contains_key("space-1") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("deferred watch event");
        let waiter = {
            let sync = sync.clone();
            tokio::spawn(async move { sync.wait_for_binding_sync().await })
        };
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());

        sync.sync_task_spaces(task_space_ids).await;
        waiter.await.expect("sync waiter");
        assert_eq!(sync.active_bindings().await.len(), 1);
        assert!(sync.deferred_uploads.lock().await.is_empty());
        assert!(requests
            .lock()
            .await
            .iter()
            .any(|request| request.contains("/snapshot?")));
        drop(events);
        watch_task.await.expect("watch loop");

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn binding_sync_waiters_wake_after_last_job() {
        let (root, store, binding, _) =
            exact_deferred_fixture("trellis-binding-sync-waiters").await;
        let api = Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api"));
        let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
        sync.prepare_startup_bindings(vec![binding]).await;

        let first = {
            let sync = sync.clone();
            tokio::spawn(async move { sync.wait_for_binding_sync().await })
        };
        let second = {
            let sync = sync.clone();
            tokio::spawn(async move { sync.wait_for_binding_sync().await })
        };
        tokio::task::yield_now().await;
        sync.finish_binding_sync("space-1").await;

        tokio::time::timeout(Duration::from_secs(1), first)
            .await
            .expect("first waiter")
            .expect("first task");
        tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("second waiter")
            .expect("second task");

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn ownership_index_rejects_schema_and_invalid_paths() {
        let root = std::env::temp_dir().join(format!(
            "trellis-ownership-index-schema-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("ownership-index.json");
        tokio::fs::create_dir_all(&root).await.expect("root");
        tokio::fs::write(&path, br#"{"version":999,"bindings":{}}"#)
            .await
            .expect("schema");
        assert!(load_ownership_index(&path).await.is_none());

        let mut binding = serde_json::Map::new();
        binding.insert("taskSpaceId".into(), json!("space"));
        binding.insert("repoPath".into(), json!("C:/repo"));
        binding.insert("branchName".into(), json!("main"));
        binding.insert(
            "tasks".into(),
            json!({"../escape":{"taskJsonSize":1,"taskJsonSha256":"x"}}),
        );
        binding.insert(
            "files".into(),
            json!({"../escape":{"size":1,"sha256":"x"}}),
        );
        binding.insert("paused".into(), json!(["../escape"]));
        binding.insert("localDirs".into(), json!(["../escape"]));
        let mut bindings = serde_json::Map::new();
        bindings.insert("local".into(), Value::Object(binding));
        tokio::fs::write(
            &path,
            serde_json::to_vec(&json!({"version": OWNERSHIP_INDEX_VERSION, "bindings": bindings}))
                .expect("encode invalid paths"),
        )
        .await
        .expect("invalid paths");
        let index = load_ownership_index(&path)
            .await
            .expect("index remains readable");
        assert!(index.bindings["local"].tasks.is_empty());
        assert!(index.bindings["local"].files.is_empty());
        assert!(index.bindings["local"].paused.is_empty());
        assert!(index.bindings["local"].local_dirs.is_empty());

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn ownership_index_rejects_oversized_tracked_paths() {
        let tracked_paths = (0..=OWNERSHIP_INDEX_MAX_TRACKED_PATHS)
            .map(|index| format!(".trellis/tasks/task-{index}/task.json"))
            .collect();
        let entry = OwnershipIndexBinding {
            task_space_id: "space".to_string(),
            repo_path: "C:/repo".to_string(),
            branch_name: "main".to_string(),
            baseline_branch: Some("main".to_string()),
            head_commit: "a".repeat(40),
            head_fingerprint: "fingerprint".to_string(),
            git_index_fingerprint: "index".to_string(),
            tracked_paths,
            tracked_paths_loaded: true,
            tasks: BTreeMap::new(),
            files: BTreeMap::new(),
            files_complete: false,
            dirty_task_dirs: Vec::new(),
            paused: Vec::new(),
            local_dirs: Vec::new(),
        };
        let index = OwnershipIndex {
            version: OWNERSHIP_INDEX_VERSION,
            bindings: BTreeMap::from([("local".to_string(), entry)]),
        };

        assert!(normalize_index(index).is_none());
    }

    #[tokio::test]
    async fn local_task_scan_rejects_non_directory_trellis_root() {
        let root = std::env::temp_dir().join(format!(
            "trellis-local-scan-root-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&root).await.expect("root");
        tokio::fs::write(root.join(".trellis"), b"not a directory")
            .await
            .expect("trellis file");

        let error = read_local_task_snapshot_files(&root, None)
            .await
            .expect_err("invalid trellis root");
        assert_eq!(error.code, code::MISSING_TRELLIS);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn binding_update_reconciles_existing_tracked_baseline_task() {
        let (root, store, _sync, mut binding) =
            test_task_sync_fixture("trellis-baseline-reconcile").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/merged-task";
        let task_json = format!("{task_dir}/task.json");
        let deferred_dir = ".trellis/tasks/deferred-task";
        let deferred_task_json = format!("{deferred_dir}/task.json");
        write_task_json(repo, task_dir, "merged-task", "dev1").await;
        write_task_json(repo, deferred_dir, "deferred-task", "dev1").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "merge task"]);

        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 1,
                            "revisionGuardVersion": 1,
                            "sequence": 1,
                            "baselines": {
                                (task_json.clone()): snapshot_sha256(
                                    "{\"id\":\"merged-task\",\"branch\":\"dev1\"}\n"
                                )
                            },
                            "deferred": {
                                (deferred_dir): {
                                    (deferred_task_json): snapshot_sha256(
                                        "{\"id\":\"deferred-task\",\"branch\":\"dev1\"}\n"
                                    )
                                }
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");
        let (server_url, changes, _requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api = Arc::new(
            ApiClient::new(&server_url, None, None).expect("mock api client"),
        );
        let sink: ControlSink = Arc::new(|_| {});
        let api_for_restart = api.clone();
        let sync = Arc::new(
            TaskSync::new(store.clone(), api, sink).with_ownership_index_writer(),
        );

        sync.update_bindings(vec![binding.clone()]).await;

        {
            let changes = changes.lock().await;
            assert_eq!(changes.len(), 1, "启动时应自动补交一次任务快照");
            assert_eq!(changes[0]["mergeEvidence"]["taskId"], "merged-task");
            assert_eq!(changes[0]["mergeEvidence"]["taskDir"], task_dir);
            assert_eq!(changes[0]["mergeEvidence"]["sourceBranch"], "dev1");
            assert_eq!(changes[0]["mergeEvidence"]["baselineBranch"], "main");
            assert_eq!(changes[0]["files"][0]["path"], task_json);
            assert_eq!(changes[0]["observedBranchName"], "main");
        }
        assert!(sync
            .read_cursor("space-1")
            .await
            .pending
            .is_none());
        drop(sync);

        let restarted = Arc::new(
            TaskSync::new(
                store.clone(),
                api_for_restart.clone(),
                Arc::new(|_| {}),
            )
            .with_ownership_index_writer(),
        );
        restarted.update_bindings(vec![binding.clone()]).await;
        assert_eq!(
            changes.lock().await.len(),
            1,
            "同一 HEAD 已完成基线补交后，正常重启不得再次上传"
        );
        drop(restarted);

        run_git(
            repo,
            &["commit", "--allow-empty", "--no-verify", "-m", "advance"],
        );
        let advanced = Arc::new(
            TaskSync::new(store.clone(), api_for_restart, Arc::new(|_| {}))
                .with_ownership_index_writer(),
        );
        advanced.update_bindings(vec![binding]).await;
        assert_eq!(
            changes.lock().await.len(),
            2,
            "HEAD 变化后必须重新补交一次合入证据"
        );
        server_task.abort();

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn startup_pull_reconciles_exact_deferred_once_at_same_revision() {
        let (root, store, binding, task_dir) =
            exact_deferred_fixture("trellis-deferred-startup").await;
        let (server_url, changes, requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

        sync.update_bindings(vec![binding.clone()]).await;

        let cursor = sync.read_cursor("space-1").await;
        assert!(!cursor.deferred.contains_key(&task_dir));
        assert!(cursor.pending.is_none());
        assert!(changes.lock().await.is_empty());
        let snapshot_requests = requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/snapshot?"))
            .count();
        assert_eq!(snapshot_requests, 1);

        sync.update_bindings(vec![binding]).await;
        let repeated_snapshot_requests = requests
            .lock()
            .await
            .iter()
            .filter(|request| request.contains("/snapshot?"))
            .count();
        assert_eq!(repeated_snapshot_requests, 1);

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn unchanged_startup_pull_skips_second_ownership_validation() {
        let (root, store, binding, _) =
            exact_deferred_fixture("trellis-startup-single-validation").await;
        let (server_url, _changes, _requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding]).await;

        assert!(!sync.pull_and_report("space-1").await);

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn startup_deferred_reconcile_does_not_trigger_baseline_upload() {
        let (root, store, mut binding, task_dir) =
            exact_deferred_fixture("trellis-deferred-no-upload").await;
        let repo = Path::new(&binding.repo_path);
        write_task_json(repo, &task_dir, "task-a", "dev1").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "source task"]);
        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let task_hash =
            snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
        write_deferred_cursor(&store, &task_dir, &task_hash, &task_hash).await;
        let (server_url, changes, requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

        sync.update_bindings(vec![binding]).await;

        let cursor = sync.read_cursor("space-1").await;
        assert!(!cursor.deferred.contains_key(&task_dir));
        assert!(cursor.pending.is_none());
        assert!(changes.lock().await.is_empty());
        assert!(requests
            .lock()
            .await
            .iter()
            .all(|request| !request.ends_with("/changes")));

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn startup_local_deferred_change_still_allows_baseline_reconcile() {
        let (root, store, mut binding, task_dir) =
            exact_deferred_fixture("trellis-deferred-local-change").await;
        let repo = Path::new(&binding.repo_path);
        let old_hash =
            snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"main\"}\n");
        write_task_json(repo, &task_dir, "task-a", "dev1").await;
        run_git(repo, &["add", ".trellis/tasks"]);
        run_git(repo, &["commit", "--no-verify", "-m", "source task"]);
        binding.baseline_branch = Some("main".to_string());
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let changed_hash =
            snapshot_sha256("{\"id\":\"task-a\",\"branch\":\"dev1\"}\n");
        write_deferred_cursor(&store, &task_dir, &changed_hash, &old_hash).await;
        let (server_url, changes, _requests, server_task) = mock_api_server(json!({
            "revision": 1,
            "files": []
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

        sync.update_bindings(vec![binding]).await;

        let cursor = sync.read_cursor("space-1").await;
        assert!(!cursor.deferred.contains_key(&task_dir));
        let changes = changes.lock().await;
        assert_eq!(changes.len(), 1, "本地状态变化后仍应保留基线补交行为");
        assert_eq!(changes[0]["mergeEvidence"]["taskId"], "task-a");

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn normal_pull_reconciles_exact_deferred_without_dirty_upload() {
        let (root, store, binding, task_dir) =
            exact_deferred_fixture("trellis-deferred-pull").await;
        let task_json = format!("{task_dir}/task.json");
        let repo_path = Path::new(&binding.repo_path).to_path_buf();
        let content = "{\"id\":\"task-a\",\"branch\":\"main\"}\n";
        let task_hash = snapshot_sha256(content);
        let stale_hash = "0".repeat(64);
        write_deferred_cursor(&store, &task_dir, &stale_hash, &task_hash).await;
        let (server_url, changes, _requests, server_task) = mock_api_server(json!({
            "revision": 2,
            "files": [{
                "path": task_json.clone(),
                "content": content,
                "sha256": task_hash.clone(),
                "deleted": false
            }]
        }))
        .await;
        let api =
            Arc::new(ApiClient::new(&server_url, None, None).expect("mock api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = TaskSync::new(store.clone(), api, sink);
        sync.set_bindings(vec![binding]).await;

        let result = sync
            .pull_task_space("space-1")
            .await
            .expect("pull exact deferred");

        assert_eq!(result["revision"], 2);
        assert_eq!(result["conflicts"].as_array().map(Vec::len), Some(0));
        let cursor = sync.read_cursor("space-1").await;
        assert!(!cursor.deferred.contains_key(&task_dir));
        assert!(cursor.pending.is_none());
        assert!(changes.lock().await.is_empty());
        assert_eq!(cursor.baselines.get(&task_json), Some(&task_hash));
        assert_eq!(
            tokio::fs::read_to_string(repo_path.join(&task_json))
                .await
                .expect("local task"),
            content
        );

        server_task.abort();
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn rejects_archived_task_directory_under_temp_repo() {
        let (root, _store, _sync, binding) = test_task_sync_fixture("trellis-task-path").await;
        let tasks_root = Path::new(&binding.repo_path).join(".trellis").join("tasks");

        assert_eq!(
            resolve_task_directory(&binding, ".trellis/tasks/active-task")
                .await
                .expect("active task"),
            tasks_root.join("active-task")
        );
        let error = resolve_task_directory(
            &binding,
            ".trellis/tasks/archive/2026-11/archived-task",
        )
        .await
        .expect_err("归档目录必须由服务端 Git 管理");
        assert_eq!(error.code, code::INVALID_RESPONSE);

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn invalid_remove_keeps_existing_task_directory() {
        let (root, _store, sync, binding) =
            test_task_sync_fixture("trellis-task-remove").await;
        let sentinel = Path::new(&binding.repo_path)
            .join(".trellis")
            .join("tasks")
            .join("keep");
        tokio::fs::create_dir_all(&sentinel)
            .await
            .expect("sentinel dir");
        tokio::fs::write(sentinel.join("prd.md"), "keep")
            .await
            .expect("sentinel file");

        let error = sync
            .remove_task_directory(&binding, ".trellis/tasks/../keep")
            .await
            .expect_err("非法目录应失败");
        assert_eq!(error.code, code::INVALID_RESPONSE);
        assert!(sentinel.join("prd.md").exists());

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn invalid_backup_does_not_create_live_backup() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-task-backup").await;

        let error = sync
            .backup_directory(&binding, ".trellis/tasks/../keep")
            .await
            .expect_err("非法目录应失败");
        assert_eq!(error.code, code::INVALID_RESPONSE);
        assert!(!store
            .paths
            .live_backups_dir
            .join(&binding.task_space_id)
            .exists());

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn task_directory_resolution_rejects_invalid_relative_path() {
        let binding = test_binding("space-1");
        let error = resolve_task_directory(&binding, ".trellis/tasks/../evil")
            .await
            .expect_err("目录穿越");
        assert_eq!(error.code, code::INVALID_RESPONSE);
        let details = error.details.expect("路径错误详情");
        assert_eq!(
            details["taskDir"],
            json!(".trellis/tasks/../evil")
        );
    }

    #[test]
    fn sync_error_event_contains_readable_scope_without_repo_path() {
        let binding = test_binding("space-1");
        let error = task_directory_error(".trellis/tasks/a", "任务目录路径校验失败");
        let event = task_sync_error_event(
            Some(&binding),
            &binding.task_space_id,
            &error,
            error.message.clone(),
        );
        assert_eq!(event["projectName"], json!("Repo"));
        assert_eq!(event["branchName"], json!("main"));
        assert_eq!(event["taskDir"], json!(".trellis/tasks/a"));
        assert!(event.get("repoPath").is_none());
        assert!(!event.to_string().contains("C:/repos"));
    }

    fn test_config(binding: AgentBinding) -> AgentConfig {
        AgentConfig {
            schema_version: crate::agent::store::CONFIG_SCHEMA_VERSION,
            revision: "0123456789abcdef0123456789abcdef".to_string(),
            server_url: "http://localhost:4310".to_string(),
            ca_file: None,
            allow_local_git_remotes: false,
            agent_id: "agent-1".to_string(),
            device_name: "PC".to_string(),
            username: Some("dev".to_string()),
            team_id: None,
            teams: Vec::new(),
            protocol_version: 3,
            agent_version: None,
            paired_at: None,
            bindings: vec![binding],
        }
    }

    fn snapshot_file_value(path: impl Into<String>, content: impl Into<String>) -> Value {
        let path: String = path.into();
        let content: String = content.into();
        json!({
            "path": path,
            "content": content,
        })
    }

    fn batch_file_values(count: usize) -> Vec<Value> {
        (0..count)
            .map(|index| snapshot_file_value(format!(".trellis/tasks/a/file-{index}.md"), ""))
            .collect()
    }

    #[test]
    fn groups_more_than_batch_limit_across_task_directories() {
        let files: Vec<Value> = (0..1100)
            .map(|index| {
                let task_dir = if index < 550 {
                    ".trellis/tasks/a"
                } else {
                    ".trellis/tasks/b"
                };
                snapshot_file_value(format!("{task_dir}/file-{index}.md"), "")
            })
            .collect();

        let groups = group_task_snapshot_files(&files).expect("跨目录聚合应允许超过单批上限");
        assert_eq!(groups.len(), 2);
        assert!(groups.iter().all(|group| group.files.len() == 550));
    }

    #[test]
    fn validates_upload_batch_file_count_boundary() {
        let mut files = batch_file_values(TASK_SNAPSHOT_MAX_FILES);
        assert!(validate_upload_batch(&files).is_ok());

        files.push(snapshot_file_value(
            format!(".trellis/tasks/a/file-{}.md", TASK_SNAPSHOT_MAX_FILES),
            "",
        ));
        let error = validate_upload_batch(&files).expect_err("超过文件数上限应失败");
        assert!(error.message.contains("1024"));
    }

    #[tokio::test]
    async fn rejects_oversized_batch_before_pending_write_and_retry() {
        let root = std::env::temp_dir().join(format!(
            "trellis-upload-limit-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
        store.ensure_directories().await.expect("directories");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let sync = TaskSync::new(store.clone(), api, sink);
        let binding = test_binding("space-1");
        let files = batch_file_values(TASK_SNAPSHOT_MAX_FILES + 1);

        let write_error = sync
            .upload_persisted_batch(&binding, &Cursor::default(), files.clone(), None)
            .await
            .expect_err("新批次应在写入 pending 前拒绝");
        assert!(write_error.message.contains("1024"));
        assert!(!store.paths.task_cursors_file.exists(), "超限新批次不得留下 pending");

        let retry_error = sync
            .retry_pending_batch(
                &binding,
                PendingBatch {
                    batch_id: "oversized-batch".to_string(),
                    client_sequence: 1,
                    files,
                    merge_evidence: None,
                    created_at: "2026-11-18T00:00:00.000Z".to_string(),
                },
            )
            .await
            .expect_err("超限 pending 应在重试前拒绝");
        assert!(retry_error.message.contains("1024"));
        assert!(!store.paths.task_cursors_file.exists(), "超限 pending 重试不得产生新写入");

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn validates_upload_batch_byte_boundary() {
        let full_file = "x".repeat(TASK_SNAPSHOT_MAX_FILE_BYTES);
        let file_count = TASK_SNAPSHOT_MAX_BATCH_BYTES / TASK_SNAPSHOT_MAX_FILE_BYTES;
        let mut files: Vec<Value> = (0..file_count)
            .map(|index| {
                snapshot_file_value(
                    format!(".trellis/tasks/a/file-{index}.md"),
                    full_file.clone(),
                )
            })
            .collect();
        assert!(validate_upload_batch(&files).is_ok());

        files.push(snapshot_file_value(".trellis/tasks/a/extra.md", "x"));
        let error = validate_upload_batch(&files).expect_err("超过字节上限应失败");
        assert!(error.message.contains("64 MiB"));
    }

    #[test]
    fn upload_batch_rejects_archive_paths() {
        let files = vec![snapshot_file_value(
            ".trellis/tasks/archive/2026-11/a/prd.md",
            "old",
        )];
        let error = validate_upload_batch(&files).expect_err("归档路径必须拒绝");
        assert!(error.message.contains("服务端 Git"));
    }

    #[test]
    fn group_rejects_duplicate_snapshot_paths() {
        let files = vec![
            snapshot_file_value(".trellis/tasks/a/prd.md", "one"),
            snapshot_file_value(".trellis/tasks/a/prd.md", "two"),
        ];

        let error = group_task_snapshot_files(&files).expect_err("重复路径应失败");
        assert!(error.message.contains("不能重复"));
    }

    #[test]
    fn archive_pending_batch_is_migrated_without_reusing_batch_id() {
        let archive_only = PendingBatch {
            batch_id: "batch.archive-only".into(),
            client_sequence: 10,
            files: vec![snapshot_file_value(
                ".trellis/tasks/archive/2026-11/a/prd.md",
                "old",
            )],
            merge_evidence: None,
            created_at: "2026-11-18T00:00:00.000Z".to_string(),
        };
        assert!(migrate_archive_pending_batch(archive_only, 10).is_none());

        let mut deletion = snapshot_file_value(".trellis/tasks/a/prd.md", "");
        deletion["deleted"] = json!(true);
        let mixed = PendingBatch {
            batch_id: "batch.archive-mixed".into(),
            client_sequence: 10,
            files: vec![
                deletion,
                snapshot_file_value(".trellis/tasks/archive/2026-11/a/prd.md", "old"),
            ],
            merge_evidence: Some(json!({
                "taskDir": ".trellis/tasks/archive/2026-11/a"
            })),
            created_at: "2026-11-18T00:00:00.000Z".to_string(),
        };
        let migrated = migrate_archive_pending_batch(mixed, 10).expect("active deletion");
        assert_ne!(migrated.batch_id, "batch.archive-mixed");
        assert!(migrated.client_sequence > 10);
        assert_eq!(migrated.files.len(), 1);
        assert!(migrated.merge_evidence.is_none());
        assert_eq!(
            migrated.files[0]["path"],
            json!(".trellis/tasks/a/prd.md")
        );
    }

    #[test]
    fn cursor_sanitizes_archive_paths() {
        let entry = json!({
            "revision": 8,
            "revisionGuardVersion": 1,
            "sequence": 9,
            "baselines": {
                ".trellis/tasks/a/prd.md": "a".repeat(64),
                ".trellis/tasks/archive/2026-11/b/prd.md": "b".repeat(64)
            },
            "deferred": {
                ".trellis/tasks/archive/2026-11/b": {
                    ".trellis/tasks/archive/2026-11/b/prd.md": "b".repeat(64)
                }
            },
            "ownershipPending": {
                ".trellis/tasks/archive/2026-11/b": {
                    "fingerprint": "c".repeat(64)
                }
            },
            "conflictBlocked": {
                ".trellis/tasks/archive/2026-11/b": {
                    "conflictId": "conflict-1"
                }
            },
            "pendingRejected": {
                ".trellis/tasks/archive/2026-11/b": {
                    "batchId": "batch-1",
                    "clientSequence": 9,
                    "reason": "TASK_OWNERSHIP_REQUIRED",
                    "blockedAt": "2026-11-18T00:00:00.000Z"
                }
            }
        });
        let cursor = cursor_from_entry(&entry);
        assert_eq!(cursor.revision_guard_version, 1);
        assert!(cursor.baselines.contains_key(".trellis/tasks/a/prd.md"));
        assert!(!cursor
            .baselines
            .contains_key(".trellis/tasks/archive/2026-11/b/prd.md"));
        assert!(cursor.deferred.is_empty());
        assert!(cursor.ownership_pending.is_empty());
        assert!(cursor.conflict_blocked.is_empty());
        assert!(cursor.pending_rejected.is_empty());
    }

    #[test]
    fn server_snapshot_parser_ignores_archive_files() {
        let snapshot = json!({
            "files": [
                snapshot_file_value(".trellis/tasks/a/prd.md", "active"),
                snapshot_file_value(".trellis/tasks/archive/2026-11/a/prd.md", "archived"),
                {
                    "path": ".trellis/tasks/archive/2026-11/a/screenshot.png",
                    "content": "ignored"
                }
            ]
        });
        let files = parse_snapshot_files(&snapshot).expect("snapshot");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, ".trellis/tasks/a/prd.md");
    }

    #[test]
    fn directory_parser_rejects_archive_targets() {
        let error = parse_directory_files(
            &json!({ "files": [] }),
            ".trellis/tasks/archive/2026-11/a",
        )
        .expect_err("归档目录不能走 Agent 快照");
        assert_eq!(error.code, code::INVALID_RESPONSE);
    }

    #[test]
    fn groups_ignore_archived_task_directories() {
        let files = vec![
            snapshot_file_value(".trellis/tasks/a/prd.md", ""),
            snapshot_file_value(".trellis/tasks/archive/2026-11/b/prd.md", ""),
        ];

        let groups = group_task_snapshot_files(&files).expect("归档路径应被忽略");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups.iter().filter(|group| group.archived).count(), 0);
        assert_eq!(groups.iter().filter(|group| !group.archived).count(), 1);
    }

    #[test]
    fn event_revision_only_skips_completed_unchanged_sync() {
        assert!(!should_pull_for_event(true, false, 10, Some(10), false));
        assert!(!should_pull_for_event(true, false, 10, Some(9), false));
        assert!(should_pull_for_event(true, false, 10, Some(11), false));
        assert!(should_pull_for_event(false, false, 10, Some(10), false));
        assert!(should_pull_for_event(true, true, 10, Some(10), false));
        assert!(should_pull_for_event(true, false, 10, Some(10), true));
        assert!(should_pull_for_event(true, false, 10, None, false));
    }

    fn assert_cursor_patch_changes_once(
        cursor: &mut Cursor,
        make_patch: impl Fn() -> CursorPatch,
    ) {
        assert!(apply_cursor_patch(cursor, &make_patch()));
        assert!(!apply_cursor_patch(cursor, &make_patch()));
    }

    #[test]
    fn cursor_patch_only_reports_real_changes() {
        let mut cursor = Cursor::default();
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                revision: Some(10),
                revision_guard_version: Some(REVISION_GUARD_VERSION),
                sequence: Some(2),
                ..Default::default()
            },
        );

        let baselines = BTreeMap::from([(".trellis/tasks/a/prd.md".to_string(), "a".repeat(64))]);
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                baselines: Some(baselines.clone()),
                ..Default::default()
            },
        );

        let deferred = BTreeMap::from([(
            ".trellis/tasks/a".to_string(),
            BTreeMap::from([(".trellis/tasks/a/prd.md".to_string(), "b".repeat(64))]),
        )]);
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                deferred: Some(deferred.clone()),
                ..Default::default()
            },
        );

        let ownership = BTreeMap::from([(".trellis/tasks/a".to_string(), "fingerprint".to_string())]);
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                ownership_pending: Some(ownership.clone()),
                ..Default::default()
            },
        );

        let blocked = BTreeMap::from([(".trellis/tasks/a".to_string(), "conflict-1".to_string())]);
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                conflict_blocked: Some(blocked.clone()),
                ..Default::default()
            },
        );

        let rejected = BTreeMap::from([(
            ".trellis/tasks/a".to_string(),
            PendingRejection {
                batch_id: "batch-rejected".to_string(),
                client_sequence: 3,
                reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                created_at: "2026-11-18T00:00:00.000Z".to_string(),
                blocked_at: "2026-11-18T00:01:00.000Z".to_string(),
            },
        )]);
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                pending_rejected: Some(rejected.clone()),
                ..Default::default()
            },
        );

        let pending = PendingBatch {
            batch_id: "batch-1".to_string(),
            client_sequence: 3,
            files: vec![json!({ "path": ".trellis/tasks/a/prd.md" })],
            merge_evidence: None,
            created_at: "2026-11-18T00:00:00.000Z".to_string(),
        };
        assert_cursor_patch_changes_once(
            &mut cursor,
            || CursorPatch {
                pending: Some(Some(pending.clone())),
                ..Default::default()
            },
        );
        assert!(apply_cursor_patch(
            &mut cursor,
            &CursorPatch {
                pending: Some(None),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn exact_deferred_state_reconciles_without_dirty_upload() {
        let task_dir = ".trellis/tasks/task-a";
        let group = task_group(
            "task-a",
            task_dir,
            &[("task.json", "{\"id\":\"task-a\"}\n")],
        );
        let local_state = file_state_from_group(&group);
        let task_json = format!("{task_dir}/task.json");
        let cursor = Cursor {
            baselines: BTreeMap::from([(task_json.clone(), "0".repeat(64))]),
            deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
            ..Default::default()
        };

        let (dirty, deferred, reconciled) =
            local_sync_state_from_groups(&cursor, &[group], &local_state);

        assert!(dirty.is_empty());
        assert!(deferred.is_empty());
        assert_eq!(reconciled.len(), 1);
        assert!(reconciled.contains(task_dir));
    }

    #[test]
    fn grouped_baselines_keep_task_scope() {
        let task_a_dir = ".trellis/tasks/task-a";
        let task_b_dir = ".trellis/tasks/task-b";
        let task_a = task_group(
            "task-a",
            task_a_dir,
            &[("task.json", "{\"id\":\"task-a\"}\n")],
        );
        let task_b = task_group(
            "task-b",
            task_b_dir,
            &[("task.json", "{\"id\":\"task-b\"}\n")],
        );
        let task_a_state = file_state_from_group(&task_a);
        let task_b_state = file_state_from_group(&task_b);
        let cursor = Cursor {
            baselines: task_a_state.clone(),
            deferred: BTreeMap::from([(task_b_dir.to_string(), task_b_state)]),
            ..Default::default()
        };
        let server_baselines = task_a_state;

        let (dirty, deferred, reconciled) =
            local_sync_state_from_groups(&cursor, &[task_a, task_b], &server_baselines);

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
        assert!(reconciled.is_empty());
    }

    #[test]
    fn hash_mismatch_keeps_deferred_protected() {
        let task_dir = ".trellis/tasks/task-a";
        let group = task_group(
            "task-a",
            task_dir,
            &[("task.json", "{\"id\":\"task-a\"}\n")],
        );
        let local_state = file_state_from_group(&group);
        let task_json = format!("{task_dir}/task.json");
        let cursor = Cursor {
            deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
            ..Default::default()
        };
        let server = BTreeMap::from([(task_json, "0".repeat(64))]);

        let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
    }

    #[test]
    fn server_missing_file_keeps_deferred_protected() {
        let task_dir = ".trellis/tasks/task-a";
        let group = task_group(
            "task-a",
            task_dir,
            &[
                ("task.json", "{\"id\":\"task-a\"}\n"),
                ("prd.md", "# task\n"),
            ],
        );
        let local_state = file_state_from_group(&group);
        let task_json = format!("{task_dir}/task.json");
        let cursor = Cursor {
            deferred: BTreeMap::from([(task_dir.to_string(), local_state.clone())]),
            ..Default::default()
        };
        let server = BTreeMap::from([(
            task_json,
            local_state[".trellis/tasks/task-a/task.json"].clone(),
        )]);

        let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
    }

    #[test]
    fn local_extra_file_keeps_deferred_protected() {
        let task_dir = ".trellis/tasks/task-a";
        let group = task_group(
            "task-a",
            task_dir,
            &[
                ("task.json", "{\"id\":\"task-a\"}\n"),
                ("prd.md", "# task\n"),
            ],
        );
        let local_state = file_state_from_group(&group);
        let server = BTreeMap::from([(
            format!("{task_dir}/task.json"),
            local_state[".trellis/tasks/task-a/task.json"].clone(),
        )]);
        let cursor = Cursor {
            deferred: BTreeMap::from([(task_dir.to_string(), local_state)]),
            ..Default::default()
        };

        let (dirty, deferred, _) = local_sync_state_from_groups(&cursor, &[group], &server);

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
    }

    #[test]
    fn empty_server_baseline_keeps_deferred_protected() {
        let task_dir = ".trellis/tasks/task-a";
        let group = task_group(
            "task-a",
            task_dir,
            &[("task.json", "{\"id\":\"task-a\"}\n")],
        );
        let local_state = file_state_from_group(&group);
        let cursor = Cursor {
            deferred: BTreeMap::from([(task_dir.to_string(), local_state)]),
            ..Default::default()
        };

        let (dirty, deferred, _) =
            local_sync_state_from_groups(&cursor, &[group], &BTreeMap::new());

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
    }

    #[test]
    fn missing_local_directory_keeps_deferred_protected() {
        let task_dir = ".trellis/tasks/task-a";
        let task_json = format!("{task_dir}/task.json");
        let deferred_state = BTreeMap::from([(
            task_json,
            snapshot_sha256("{\"id\":\"task-a\"}\n"),
        )]);
        let cursor = Cursor {
            baselines: deferred_state.clone(),
            deferred: BTreeMap::from([(task_dir.to_string(), deferred_state.clone())]),
            ..Default::default()
        };

        let (dirty, deferred, _) =
            local_sync_state_from_groups(&cursor, &[], &deferred_state);

        assert!(dirty.is_empty());
        assert_eq!(deferred, cursor.deferred);
    }

    #[test]
    fn changed_deferred_state_still_uses_cursor_baseline_for_dirty() {
        let task_dir = ".trellis/tasks/task-a";
        let task_json = format!("{task_dir}/task.json");
        let group = task_group(
            "task-a",
            task_dir,
            &[("task.json", "{\"id\":\"task-a\",\"title\":\"changed\"}\n")],
        );
        let old_state =
            BTreeMap::from([(task_json.clone(), snapshot_sha256("{\"id\":\"task-a\"}\n"))]);
        let cursor = Cursor {
            baselines: old_state.clone(),
            deferred: BTreeMap::from([(task_dir.to_string(), old_state.clone())]),
            ..Default::default()
        };

        let (dirty, deferred, reconciled) =
            local_sync_state_from_groups(&cursor, &[group], &old_state);

        assert_eq!(dirty, vec![task_dir.to_string()]);
        assert!(deferred.is_empty());
        assert!(reconciled.is_empty());
    }

    #[test]
    fn detach_pending_is_excluded_and_selection_identity_is_stable() {
        let selected = test_binding("space-1");
        let mut pending = test_binding("space-2");
        pending.detach_pending = true;
        let map = approved_bindings(vec![selected.clone(), pending]);
        assert_eq!(map.len(), 1);
        assert!(binding_selection_unchanged(
            &map,
            &approved_bindings(vec![selected])
        ));
    }

    #[tokio::test]
    async fn bindings_notify_only_after_actual_change() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-binding-events-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let changes_sink = changes.clone();
        let state_sink: StateSink = Arc::new(move || {
            changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_state_sink(state_sink);
        let binding = test_binding("space-1");

        sync.set_bindings(vec![binding.clone()]).await;
        sync.set_bindings(vec![binding.clone()]).await;
        assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);

        let mut heartbeat_metadata = binding.clone();
        heartbeat_metadata.last_synced_at = Some("2026-11-14T00:00:00.000Z".to_string());
        heartbeat_metadata.last_head = Some("abc123".to_string());
        sync.set_bindings(vec![heartbeat_metadata]).await;
        assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);

        let mut changed = binding;
        changed.live_sync_status = "error".to_string();
        sync.set_bindings(vec![changed]).await;
        assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn heartbeat_metadata_reuses_selected_bindings_without_git_validation() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-binding-heartbeat-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root.clone()));
        let repo = root.join("repo");
        tokio::fs::create_dir_all(&repo)
            .await
            .expect("repository directory");
        init_git_repo(&repo);
        let mut binding = test_binding("space-1");
        binding.repo_path = repo.to_string_lossy().to_string();
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sync = Arc::new(TaskSync::new(store, api, Arc::new(|_| {})));
        sync.set_bindings(vec![binding.clone()]).await;
        sync.branch_validations
            .store(0, std::sync::atomic::Ordering::SeqCst);

        let mut heartbeat_metadata = binding.clone();
        heartbeat_metadata.last_synced_at = Some("2026-11-14T00:00:00.000Z".to_string());
        heartbeat_metadata.last_head = Some("abc123".to_string());
        sync.update_bindings(vec![heartbeat_metadata]).await;

        assert_eq!(
            sync.branch_validations
                .load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        run_git(&repo, &["checkout", "-b", "feature"]);
        sync.branch_validations
            .store(0, std::sync::atomic::Ordering::SeqCst);
        sync.update_bindings(vec![binding]).await;
        assert_eq!(
            sync.branch_validations
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn ignores_access_only_watch_events() {
        let access = notify::Event::new(notify::event::EventKind::Access(
            notify::event::AccessKind::Open(notify::event::AccessMode::Read),
        ));
        let modify =
            notify::Event::new(notify::event::EventKind::Modify(notify::event::ModifyKind::Any));

        assert!(!is_relevant_watch_event(&access));
        assert!(is_relevant_watch_event(&modify));
    }

    #[tokio::test]
    async fn head_fingerprint_changes_with_current_branch_commit() {
        let (root, _store, _sync, binding) =
            test_task_sync_fixture("trellis-head-fingerprint").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let before = git_head_fingerprint(repo).await.expect("unborn HEAD");
        tokio::fs::write(repo.join("README.md"), "one\n")
            .await
            .expect("readme");
        run_git(repo, &["add", "README.md"]);
        run_git(repo, &["commit", "--no-verify", "-m", "first"]);
        let after = git_head_fingerprint(repo).await.expect("committed HEAD");

        assert_ne!(before, after);
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn head_diff_only_scans_changed_active_task_directories() {
        let (root, _store, sync, binding) =
            test_task_sync_fixture("trellis-head-diff").await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        write_task_json(repo, ".trellis/tasks/live", "live", "main").await;
        run_git(repo, &["add", "."]);
        run_git(repo, &["commit", "--no-verify", "-m", "first"]);
        let first = crate::agent::git::head_commit(
            repo,
            &sync.binding_hooks_dir(&binding),
            false,
        )
        .await
        .expect("first head")
        .expect("first commit");

        write_task_json(repo, ".trellis/tasks/live", "live", "main").await;
        tokio::fs::write(
            repo.join(".trellis/tasks/live/prd.md"),
            "# changed\n",
        )
        .await
        .expect("changed file");
        run_git(repo, &["add", "."]);
        run_git(repo, &["commit", "--no-verify", "-m", "second"]);
        let second = crate::agent::git::head_commit(
            repo,
            &sync.binding_hooks_dir(&binding),
            false,
        )
        .await
        .expect("second head")
        .expect("second commit");
        let changed = sync
            .task_head_changed_dirs(&binding, &first, &second)
            .await
            .expect("head diff");
        assert_eq!(
            changed,
            HashSet::from([".trellis/tasks/live".to_string()])
        );

        let archive = repo
            .join(".trellis")
            .join("tasks")
            .join("archive")
            .join("2026-11");
        tokio::fs::create_dir_all(&archive)
            .await
            .expect("archive month");
        tokio::fs::rename(
            repo.join(".trellis/tasks/live"),
            archive.join("live"),
        )
        .await
        .expect("archive move");
        tokio::fs::write(archive.join("live").join("screenshot.png"), [0xff, 0xfe])
            .await
            .expect("archive binary");
        run_git(repo, &["add", "-A", "."]);
        run_git(repo, &["commit", "--no-verify", "-m", "archive"]);
        let third = crate::agent::git::head_commit(
            repo,
            &sync.binding_hooks_dir(&binding),
            false,
        )
        .await
        .expect("third head")
        .expect("third commit");
        let archived = sync
            .task_head_changed_dirs(&binding, &second, &third)
            .await
            .expect("archive diff");
        assert_eq!(
            archived,
            HashSet::from([".trellis/tasks/live".to_string()])
        );
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn task_space_sync_locks_are_shared_per_space_only() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-space-lock-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sync = TaskSync::new(store, api, Arc::new(|_| {}));
        let first = sync.task_space_sync_lock("space-1").await;
        let same = sync.task_space_sync_lock("space-1").await;
        let other = sync.task_space_sync_lock("space-2").await;
        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[tokio::test]
    async fn repeated_binding_error_notifies_only_once() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-binding-error-events-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        let binding = test_binding("space-1");
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let changes_sink = changes.clone();
        let state_sink: StateSink = Arc::new(move || {
            changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let sync = TaskSync::new(store, api, Arc::new(|_| {})).with_state_sink(state_sink);
        sync.set_bindings(vec![binding.clone()]).await;
        changes.store(0, std::sync::atomic::Ordering::SeqCst);
        let error = AgentError::new(code::HTTP_ERROR, "同步失败");

        sync.persist_binding_sync_error(&binding, &error).await;
        sync.persist_binding_sync_error(&binding, &error).await;

        assert_eq!(changes.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn remove_task_cursor_only_deletes_selected_task_space() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-cursor-remove-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        store.ensure_directories().await.expect("directories");
        store
            .write_atomic(
                &store.paths.task_cursors_file,
                br#"{"version":3,"taskSpaces":{"space-1":{"revision":1},"space-2":{"revision":2}}}"#,
            )
            .await
            .expect("cursor file");
        let api = Arc::new(
            ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"),
        );
        let sink: ControlSink = Arc::new(|_| {});
        let changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let changes_sink = changes.clone();
        let state_sink: StateSink = Arc::new(move || {
            changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let sync = TaskSync::new(store.clone(), api, sink).with_state_sink(state_sink);
        sync.remove_task_cursor("space-1").await.expect("remove");
        let state = store.read_task_cursors().await;
        assert!(state["taskSpaces"].get("space-1").is_none());
        assert_eq!(state["taskSpaces"]["space-2"]["revision"], 2);
        assert_eq!(
            changes.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn write_cursor_skips_unchanged_patch() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-cursor-noop-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        store.ensure_directories().await.expect("directories");
        let binding = test_binding("space-1");
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        let initial = json!({
            "version": CURSOR_VERSION,
            "taskSpaces": {
                "space-1": {
                    "revision": 10,
                    "sequence": 2,
                    "updatedAt": "2026-11-13T00:00:00.000Z",
                    "baselines": {
                        ".trellis/tasks/a/prd.md": "a".repeat(64)
                    },
                    "deferred": {
                        ".trellis/tasks/a": {
                            ".trellis/tasks/a/prd.md": "b".repeat(64)
                        }
                    }
                }
            }
        });
        store
            .write_json(&store.paths.task_cursors_file, &initial)
            .await
            .expect("cursor file");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sink: ControlSink = Arc::new(|_| {});
        let state_changes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let state_changes_sink = state_changes.clone();
        let state_sink: StateSink = Arc::new(move || {
            state_changes_sink.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });
        let sync = TaskSync::new(store.clone(), api, sink).with_state_sink(state_sink);
        sync.set_bindings(vec![binding]).await;
        state_changes.store(0, std::sync::atomic::Ordering::SeqCst);

        let before = tokio::fs::read(&store.paths.task_cursors_file)
            .await
            .expect("cursor before");
        sync.write_cursor(
            "space-1",
            CursorPatch {
                revision: Some(10),
                sequence: Some(2),
                baselines: Some(BTreeMap::from([(
                    ".trellis/tasks/a/prd.md".to_string(),
                    "a".repeat(64),
                )])),
                deferred: Some(BTreeMap::from([(
                    ".trellis/tasks/a".to_string(),
                    BTreeMap::from([(
                        ".trellis/tasks/a/prd.md".to_string(),
                        "b".repeat(64),
                    )]),
                )])),
                ..Default::default()
            },
        )
        .await
        .expect("noop cursor");
        let after = tokio::fs::read(&store.paths.task_cursors_file)
            .await
            .expect("cursor after");
        assert_eq!(after, before);
        assert_eq!(
            state_changes.load(std::sync::atomic::Ordering::SeqCst),
            0
        );

        sync.write_cursor(
            "space-1",
            CursorPatch {
                revision: Some(11),
                ..Default::default()
            },
        )
        .await
        .expect("changed cursor");
        let state = store.read_task_cursors().await;
        assert_eq!(state["taskSpaces"]["space-1"]["revision"], 11);
        assert_eq!(
            state_changes.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn archive_pending_migration_is_persisted_once() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-cursor-archive-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        store.ensure_directories().await.expect("directories");
        let binding = test_binding("space-1");
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 1,
                            "sequence": 5,
                            "baselines": {
                                ".trellis/tasks/archive/2026-11/a/prd.md": "a".repeat(64)
                            },
                            "pending": {
                                "batchId": "batch-archive-mixed",
                                "clientSequence": 5,
                                "files": [
                                    {
                                        "path": ".trellis/tasks/a/prd.md",
                                        "content": "",
                                        "sha256": snapshot_sha256(""),
                                        "deleted": true
                                    },
                                    {
                                        "path": ".trellis/tasks/archive/2026-11/a/prd.md",
                                        "content": "old",
                                        "sha256": snapshot_sha256("old")
                                    }
                                ]
                            }
                        }
                    }
                }),
            )
            .await
            .expect("cursor");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let sync = TaskSync::new(store.clone(), api, Arc::new(|_| {}));
        sync.set_bindings(vec![binding.clone()]).await;

        sync.migrate_cursor_archive_state(&binding.task_space_id)
            .await
            .expect("migrate");
        let state = store.read_task_cursors().await;
        let entry = &state["taskSpaces"]["space-1"];
        assert!(entry["baselines"]
            .as_object()
            .is_some_and(|values| values.is_empty()));
        assert_eq!(
            entry["pending"]["files"].as_array().map(Vec::len),
            Some(1)
        );
        assert_ne!(entry["pending"]["batchId"], json!("batch-archive-mixed"));
        assert_eq!(
            entry["pending"]["files"][0]["path"],
            json!(".trellis/tasks/a/prd.md")
        );
    }

    #[tokio::test]
    async fn current_event_revision_skips_snapshot_and_local_scan() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-event-revision-{}",
            uuid::Uuid::new_v4()
        ));
        let store = Arc::new(ConfigStore::new_unsecured_for_test(root));
        store.ensure_directories().await.expect("directories");
        store
            .write_json(
                &store.paths.task_cursors_file,
                &json!({
                    "version": CURSOR_VERSION,
                    "taskSpaces": {
                        "space-1": {
                            "revision": 10,
                            "revisionGuardVersion": 1,
                            "sequence": 2
                        }
                    }
                }),
            )
            .await
            .expect("cursor file");
        let api =
            Arc::new(ApiClient::new("http://127.0.0.1:1", None, None).expect("api client"));
        let reports = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let sink_reports = reports.clone();
        let sink: ControlSink = Arc::new(move |value| {
            sink_reports
                .lock()
                .expect("reports lock")
                .push(value);
        });
        let before = tokio::fs::read(&store.paths.task_cursors_file)
            .await
            .expect("cursor before");
        let sync = TaskSync::new(store.clone(), api, sink);
        sync.set_bindings(vec![test_binding("space-1")]).await;

        let result = sync
            .pull_task_space_for_event("space-1", Some(10))
            .await
            .expect("event revision");

        assert_eq!(result["skipped"], true);
        assert_eq!(result["reason"], "REVISION_CURRENT");
        assert_eq!(result["revision"], 10);
        let after = tokio::fs::read(&store.paths.task_cursors_file)
            .await
            .expect("cursor after");
        assert_eq!(after, before);
        assert!(reports.lock().expect("reports lock").is_empty());
    }

    fn task_group(task_id: &str, task_dir: &str, files: &[(&str, &str)]) -> SnapshotGroup {
        let mut snapshot_files = Vec::new();
        for (file_path, content) in files {
            snapshot_files.push(SnapshotFile {
                path: format!("{task_dir}/{file_path}"),
                task_dir: task_dir.to_string(),
                file_path: (*file_path).to_string(),
                archived: false,
                archive_month: None,
                content: (*content).to_string(),
                sha256: snapshot_sha256(content),
                deleted: false,
                base_sha256: None,
            });
        }
        SnapshotGroup {
            task_dir: task_dir.to_string(),
            archived: false,
            archive_month: None,
            files: snapshot_files,
            task_id: Some(task_id.to_string()),
            task_branch: None,
        }
    }

    #[test]
    fn task_title_reads_trimmed_title_or_none() {
        let titled = task_group(
            "demo",
            ".trellis/tasks/11-12-demo",
            &[("task.json", r#"{"id":"demo","title":"  修复登录  "}"#)],
        );
        assert_eq!(task_title(&titled).as_deref(), Some("修复登录"));

        let untitled = task_group(
            "demo",
            ".trellis/tasks/11-12-demo",
            &[("task.json", r#"{"id":"demo","title":"   "}"#)],
        );
        assert_eq!(task_title(&untitled), None);

        let broken = task_group(
            "demo",
            ".trellis/tasks/11-12-demo",
            &[("task.json", "{not json")],
        );
        assert_eq!(task_title(&broken), None);
    }

    #[test]
    fn difference_control_carries_both_task_titles() {
        let task_dir = ".trellis/tasks/11-12-demo";
        let local = task_group(
            "demo",
            task_dir,
            &[("task.json", r#"{"id":"demo","title":"本地标题"}"#)],
        );
        let server = task_group(
            "demo",
            task_dir,
            &[("task.json", r#"{"id":"demo","title":"服务端标题"}"#)],
        );
        let difference = Difference {
            kind: DiffKind::ContentConflict,
            task_id: Some("demo".to_string()),
            task_dir: task_dir.to_string(),
            local: Some(local),
            server: Some(server),
        };
        let control = difference.to_control();
        assert_eq!(control["title"], "本地标题");
        assert_eq!(control["local"]["title"], "本地标题");
        assert_eq!(control["server"]["title"], "服务端标题");

        let fallback = Difference {
            kind: DiffKind::ServerOnly,
            task_id: Some("demo".to_string()),
            task_dir: task_dir.to_string(),
            local: None,
            server: Some(task_group(
                "demo",
                task_dir,
                &[("task.json", r#"{"id":"demo","title":"服务端标题"}"#)],
            )),
        };
        assert_eq!(fallback.to_control()["title"], "服务端标题");
        assert!(fallback.to_control()["local"].is_null());

        let untitled = Difference {
            kind: DiffKind::LocalOnly,
            task_id: None,
            task_dir: task_dir.to_string(),
            local: Some(task_group("demo", task_dir, &[("task.json", "{}")])),
            server: None,
        };
        assert!(untitled.to_control()["title"].is_null());
    }

    #[test]
    fn initial_sync_keeps_cross_branch_groups_present_locally() {
        let binding = test_binding("space-1");
        let files = [("task.json", r#"{"id":"demo","branch":"codex/demo"}"#)];
        let task_dir = ".trellis/tasks/11-12-demo";
        let local = vec![task_group("demo", task_dir, &files)];

        let mut present = vec![task_group("demo", task_dir, &files)];
        present[0].task_branch = Some("codex/demo".to_string());
        retain_server_groups_for_initial_sync(&binding, &local, &mut present);
        assert_eq!(present.len(), 1, "本地存在的跨分支任务必须保留");

        let other_dir = ".trellis/tasks/11-12-other";
        let mut absent = vec![task_group("other", other_dir, &files)];
        absent[0].task_branch = Some("codex/demo".to_string());
        retain_server_groups_for_initial_sync(&binding, &local, &mut absent);
        assert!(absent.is_empty(), "本地不存在的跨分支任务必须丢弃");
    }

    #[test]
    fn watcher_only_tracks_task_paths() {
        assert!(is_watched_trellis_path("tasks"));
        assert!(is_watched_trellis_path("tasks/11-12-demo/task.json"));
        assert!(!is_watched_trellis_path(
            "tasks/archive/2026-11/11-12-demo/prd.md"
        ));
        assert!(!is_watched_trellis_path(".developer"));
        assert!(!is_watched_trellis_path("workspace/flyfly6/journal-1.md"));
        assert!(!is_watched_trellis_path("spec/backend/index.md"));
        assert_eq!(
            task_directory_from_relative(".trellis/tasks/11-12-demo/prd.md").as_deref(),
            Some(".trellis/tasks/11-12-demo")
        );
        assert_eq!(
            task_directory_from_relative(".trellis/tasks/archive/2026-11/11-12-demo/prd.md")
                .as_deref(),
            Some(".trellis/tasks/archive/2026-11/11-12-demo")
        );
        assert_eq!(
            active_task_directory_from_relative(
                ".trellis/tasks/archive/2026-11/11-12-demo/prd.md"
            ),
            None
        );
        assert_eq!(
            task_directory_from_relative(".trellis/workspace/a.md"),
            None
        );
    }

    #[tokio::test]
    async fn git_watcher_tracks_head_index_and_refs() {
        let root = std::env::temp_dir().join(format!(
            "trellis-git-watch-{}",
            uuid::Uuid::new_v4()
        ));
        let git_dir = root.join(".git");
        tokio::fs::create_dir_all(git_dir.join("refs/heads"))
            .await
            .expect("git dirs");
        tokio::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n")
            .await
            .expect("head");
        tokio::fs::write(git_dir.join("index"), b"")
            .await
            .expect("index");
        tokio::fs::write(git_dir.join("packed-refs"), "")
            .await
            .expect("packed refs");

        let paths = git_watch_paths(&root).await;
        assert!(paths.iter().any(|(path, _)| path.ends_with("HEAD")));
        assert!(paths.iter().any(|(path, _)| path.ends_with("index")));
        assert!(paths.iter().any(|(path, _)| path.ends_with("packed-refs")));
        assert!(paths.iter().any(|(path, _)| path.ends_with("refs")));
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn next_client_sequence_stays_above_cursor_and_wall_clock() {
        let base = next_client_sequence(0);
        assert!(base > 1_700_000_000_000, "序列必须高于旧版 JS 的历史值");
        assert!(next_client_sequence(base) > base);
    }

    #[test]
    fn normalizes_text_and_paths() {
        assert_eq!(normalize_snapshot_text("\u{feff}a\r\nb\rc"), "a\nb\nc");
        assert!(normalize_snapshot_path(".trellis/tasks/01-x/prd.md").is_ok());
        assert!(normalize_snapshot_path(".trellis/tasks/../prd.md").is_err());
        assert!(normalize_snapshot_path(".trellis/tasks/01-x/prd.exe").is_err());
        assert_eq!(
            task_directory_from_path(".trellis/tasks/archive/2026-09/01-x/prd.md")
                .expect("archive path")
                .task_dir,
            ".trellis/tasks/archive/2026-09/01-x"
        );
    }

    #[test]
    fn classifies_snapshot_differences() {
        let local = vec![
            task_group(
                "a",
                ".trellis/tasks/a",
                &[("prd.md", "one"), ("task.json", "{\"id\":\"a\"}")],
            ),
            task_group(
                "b",
                ".trellis/tasks/b",
                &[("prd.md", "local"), ("task.json", "{\"id\":\"b\"}")],
            ),
        ];
        let server = vec![
            task_group(
                "a",
                ".trellis/tasks/a",
                &[("prd.md", "one"), ("task.json", "{\"id\":\"a\"}")],
            ),
            task_group(
                "b",
                ".trellis/tasks/b",
                &[("prd.md", "server"), ("task.json", "{\"id\":\"b\"}")],
            ),
            task_group(
                "c",
                ".trellis/tasks/c",
                &[("prd.md", "remote"), ("task.json", "{\"id\":\"c\"}")],
            ),
        ];
        let differences = classify_task_snapshots(&local, &server);
        let by_id: HashMap<String, DiffKind> = differences
            .iter()
            .map(|item| (item.action_key(), item.kind))
            .collect();
        assert_eq!(by_id.get("a"), Some(&DiffKind::Same));
        assert_eq!(by_id.get("b"), Some(&DiffKind::ContentConflict));
        assert_eq!(by_id.get("c"), Some(&DiffKind::ServerOnly));
    }

    #[test]
    fn rejects_duplicate_task_ids_as_invalid() {
        let local = vec![
            task_group(
                "dup",
                ".trellis/tasks/a",
                &[("task.json", "{\"id\":\"dup\"}")],
            ),
            task_group(
                "dup",
                ".trellis/tasks/b",
                &[("task.json", "{\"id\":\"dup\"}")],
            ),
        ];
        let differences = classify_task_snapshots(&local, &[]);
        assert_eq!(differences.len(), 2);
        assert!(differences
            .iter()
            .all(|item| item.kind == DiffKind::Invalid));
    }

    #[test]
    fn builds_upload_files_with_deletions() {
        let local = task_group("a", ".trellis/tasks/a", &[("prd.md", "new")]);
        let server_files = vec![SnapshotFile {
            path: ".trellis/tasks/a/notes.md".into(),
            task_dir: ".trellis/tasks/a".into(),
            file_path: "notes.md".into(),
            archived: false,
            archive_month: None,
            content: "old".into(),
            sha256: snapshot_sha256("old"),
            deleted: false,
            base_sha256: None,
        }];
        let mut baselines = BTreeMap::new();
        baselines.insert(
            ".trellis/tasks/a/notes.md".to_string(),
            snapshot_sha256("old"),
        );
        let files =
            build_directory_files(".trellis/tasks/a", Some(&local), &server_files, &baselines);
        assert_eq!(files.len(), 2);
        let deleted = files.iter().find(|file| file.deleted).expect("deletion");
        assert_eq!(deleted.path, ".trellis/tasks/a/notes.md");
        assert_eq!(
            deleted.base_sha256.as_deref(),
            Some(snapshot_sha256("old").as_str())
        );
    }

    #[test]
    fn handoff_manifest_is_stable_and_ack_contains_only_cleanup_metadata() {
        let task_dir = ".trellis/tasks/a";
        let files = vec![
            json!({
                "path": ".trellis/tasks/a/task.json",
                "content": "{\"id\":\"a\"}\n",
                "sha256": snapshot_sha256("{\"id\":\"a\"}\n"),
            }),
            json!({
                "path": ".trellis/tasks/a/prd.md",
                "content": "# a\n",
                "sha256": snapshot_sha256("# a\n"),
            }),
        ];
        let (manifest_sha256, file_count, total_bytes, manifest) =
            handoff_manifest(&files, task_dir).expect("manifest");
        assert_eq!(file_count, 2);
        assert_eq!(total_bytes, 15);
        assert!(is_sha256(&manifest_sha256));
        assert_eq!(manifest["files"][0]["path"], "prd.md");

        let handoff = StoredTaskHandoff {
            local_id: "local-1".to_string(),
            task_space_id: "space-1".to_string(),
            execution_task_key: "space-1::a".to_string(),
            task_id: "a".to_string(),
            relative_dir: task_dir.to_string(),
            server_handoff_state: "source_cleanup_pending".to_string(),
            ack_state: "pending".to_string(),
            outcome: "cleaned".to_string(),
            reason: None,
            backup_id: Some("handoff-0123456789abcdef".to_string()),
            manifest_sha256: Some(manifest_sha256.clone()),
            file_count,
            total_bytes,
            lease_held_by_other_user: false,
            notified_state: String::new(),
            updated_at: "2026-11-17T00:00:00.000Z".to_string(),
        };
        let request = handoff_ack_request(&handoff).expect("ack request");
        assert_eq!(request["outcome"], "cleaned");
        assert_eq!(request["backupId"], "handoff-0123456789abcdef");
        assert_eq!(request["manifestSha256"], manifest_sha256);
        assert!(request.get("content").is_none());
        assert!(request.get("path").is_none());
    }

    #[test]
    fn handoff_git_gate_accepts_only_fully_untracked_directories() {
        use crate::agent::git::GitStatusEntry;

        let untracked = vec![
            GitStatusEntry {
                status: "??".to_string(),
                path: ".trellis/tasks/a/task.json".to_string(),
                original_path: None,
            },
            GitStatusEntry {
                status: "??".to_string(),
                path: ".trellis/tasks/a/prd.md".to_string(),
                original_path: None,
            },
        ];
        assert!(git_entries_all_untracked(&untracked));
        let mut tracked = untracked.clone();
        tracked[0].status = "A ".to_string();
        assert!(!git_entries_all_untracked(&tracked));
        assert!(!git_entries_all_untracked(&[]));
    }

    #[tokio::test]
    async fn handoff_source_fails_closed_on_baseline_or_git_uncertainty() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-handoff-source").await;
        store
            .save_config(test_config(binding.clone()))
            .await
            .expect("config");
        sync.set_bindings(vec![binding.clone()]).await;
        let repo = Path::new(&binding.repo_path);
        init_git_repo(repo);
        let task_dir = ".trellis/tasks/task-a";
        let directory = repo.join(task_dir);
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("task directory");
        let task_json = "{\"id\":\"task-a\",\"branch\":\"main\"}\n";
        let prd = "# task-a\n";
        tokio::fs::write(directory.join("task.json"), task_json)
            .await
            .expect("task json");
        tokio::fs::write(directory.join("prd.md"), prd)
            .await
            .expect("prd");
        let handoff = StoredTaskHandoff {
            local_id: binding.local_id.clone(),
            task_space_id: binding.task_space_id.clone(),
            execution_task_key: "space-1::task-a".to_string(),
            task_id: "task-a".to_string(),
            relative_dir: task_dir.to_string(),
            server_handoff_state: "source_cleanup_pending".to_string(),
            ack_state: "pending".to_string(),
            outcome: String::new(),
            reason: None,
            backup_id: None,
            manifest_sha256: None,
            file_count: 0,
            total_bytes: 0,
            lease_held_by_other_user: false,
            notified_state: String::new(),
            updated_at: "2026-11-17T00:00:00.000Z".to_string(),
        };
        sync.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                baselines: Some(BTreeMap::from([(
                    format!("{task_dir}/task.json"),
                    snapshot_sha256(task_json),
                )])),
                ..Default::default()
            },
        )
        .await
        .expect("cursor");
        assert!(matches!(
            sync.handoff_source_state(&binding, &handoff)
                .await
                .expect("baseline state"),
            HandoffSourceState::Conflict("baseline_mismatch")
        ));

        sync.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                baselines: Some(BTreeMap::from([
                    (
                        format!("{task_dir}/task.json"),
                        snapshot_sha256(task_json),
                    ),
                    (format!("{task_dir}/prd.md"), snapshot_sha256(prd)),
                ])),
                ..Default::default()
            },
        )
        .await
        .expect("cursor");
        let git_index = repo.join(".git").join("index");
        tokio::fs::remove_file(&git_index).await.ok();
        tokio::fs::create_dir(&git_index)
            .await
            .expect("invalid git index directory");
        assert!(matches!(
            sync.handoff_source_state(&binding, &handoff)
                .await
                .expect("git gate state"),
            HandoffSourceState::Conflict("git_modified")
        ));
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn handoff_retry_requires_complete_and_verifiable_backup() {
        let (root, store, sync, binding) =
            test_task_sync_fixture("trellis-handoff-backup-check").await;
        let task_dir = ".trellis/tasks/task-backup";
        let source_dir = Path::new(&binding.repo_path).join(task_dir);
        tokio::fs::create_dir_all(&source_dir)
            .await
            .expect("source directory");
        let task_json = "{\"id\":\"task-backup\"}\n";
        let prd = "# task-backup\n";
        tokio::fs::write(source_dir.join("task.json"), task_json)
            .await
            .expect("task json");
        tokio::fs::write(source_dir.join("prd.md"), prd)
            .await
            .expect("prd");
        let files = vec![
            json!({
                "path": format!("{task_dir}/task.json"),
                "content": task_json,
                "sha256": snapshot_sha256(task_json),
            }),
            json!({
                "path": format!("{task_dir}/prd.md"),
                "content": prd,
                "sha256": snapshot_sha256(prd),
            }),
        ];
        let (manifest_sha256, file_count, total_bytes, manifest) =
            handoff_manifest(&files, task_dir).expect("manifest");
        let backup_id = format!("handoff-{}", &manifest_sha256[..16]);
        let source = HandoffSource {
            files,
            backup_id: backup_id.clone(),
            manifest_sha256: manifest_sha256.clone(),
            manifest,
            file_count,
            total_bytes,
        };
        let handoff = StoredTaskHandoff {
            local_id: binding.local_id.clone(),
            task_space_id: binding.task_space_id.clone(),
            execution_task_key: "space-1::task-backup".to_string(),
            task_id: "task-backup".to_string(),
            relative_dir: task_dir.to_string(),
            server_handoff_state: "source_cleanup_pending".to_string(),
            ack_state: "pending".to_string(),
            outcome: "cleaned".to_string(),
            reason: None,
            backup_id: None,
            manifest_sha256: None,
            file_count: 0,
            total_bytes: 0,
            lease_held_by_other_user: false,
            notified_state: String::new(),
            updated_at: "2026-11-17T00:00:00.000Z".to_string(),
        };
        let control = TaskControl {
            execution_task_key: handoff.execution_task_key.clone(),
            task_id: handoff.task_id.clone(),
            relative_dir: handoff.relative_dir.clone(),
            title: "备份任务".to_string(),
            state: "handoff_materialized".to_string(),
            task_version: 2,
            assignee_user_id: Some("user-b".to_string()),
            handoff_state: "source_cleanup_pending".to_string(),
            materialized_revision: Some(1),
            materialized_at: None,
            lease_held_by_other_user: false,
            updated_at: String::new(),
        };
        assert!(sync
            .ensure_handoff_backup(&binding, &handoff, &control, &source)
            .await
            .expect("create backup"));
        let mut expected = handoff.clone();
        expected.backup_id = Some(backup_id.clone());
        expected.manifest_sha256 = Some(manifest_sha256);
        expected.file_count = file_count;
        expected.total_bytes = total_bytes;
        assert!(sync
            .handoff_backup_is_valid(&binding, &expected)
            .await
            .expect("valid backup"));

        let mut missing = expected.clone();
        missing.backup_id = Some("handoff-fedcba9876543210".to_string());
        assert!(!sync
            .handoff_backup_is_valid(&binding, &missing)
            .await
            .expect("missing backup"));
        let mut invalid = expected.clone();
        invalid.backup_id = Some("../escape".to_string());
        assert!(!sync
            .handoff_backup_is_valid(&binding, &invalid)
            .await
            .expect("invalid backup"));

        let backup = store
            .paths
            .live_backups_dir
            .join(&binding.task_space_id)
            .join(&backup_id);
        tokio::fs::write(backup.join("unexpected.tmp"), "x")
            .await
            .expect("unexpected backup file");
        assert!(!sync
            .handoff_backup_is_valid(&binding, &expected)
            .await
            .expect("unexpected file invalidates backup"));
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn reads_local_task_snapshot_files() {
        let root = std::env::temp_dir().join(format!("trellis-snap-{}", uuid::Uuid::new_v4()));
        let task_dir = root.join(".trellis").join("tasks").join("01-x");
        tokio::fs::create_dir_all(&task_dir).await.expect("mkdir");
        tokio::fs::write(task_dir.join("prd.md"), "# hi\r\n")
            .await
            .expect("write");
        let archive_dir = root
            .join(".trellis")
            .join("tasks")
            .join("archive")
            .join("2026-11")
            .join("old");
        tokio::fs::create_dir_all(&archive_dir)
            .await
            .expect("archive mkdir");
        tokio::fs::write(archive_dir.join("prd.md"), [0xff, 0xfe])
            .await
            .expect("archive write");
        let files = read_local_task_snapshot_files(&root, None)
            .await
            .expect("read");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["content"], "# hi\n");
        let selected = HashSet::from([".trellis/tasks/01-x".to_string()]);
        let targeted = read_local_task_snapshot_files(&root, Some(&selected))
            .await
            .expect("targeted read");
        assert_eq!(targeted.len(), 1);
        assert_eq!(targeted[0]["path"], ".trellis/tasks/01-x/prd.md");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn targeted_local_read_does_not_decode_sibling_task_bodies() {
        let root = std::env::temp_dir().join(format!(
            "trellis-targeted-scan-{}",
            uuid::Uuid::new_v4()
        ));
        let selected = root.join(".trellis").join("tasks").join("selected");
        let sibling = root.join(".trellis").join("tasks").join("sibling");
        tokio::fs::create_dir_all(&selected).await.expect("selected");
        tokio::fs::create_dir_all(&sibling).await.expect("sibling");
        tokio::fs::write(selected.join("prd.md"), "ok")
            .await
            .expect("selected file");
        tokio::fs::write(sibling.join("prd.md"), [0xff, 0xfe])
            .await
            .expect("invalid sibling");

        let task_dirs = HashSet::from([".trellis/tasks/selected".to_string()]);
        let files = read_local_task_snapshot_files(&root, Some(&task_dirs))
            .await
            .expect("targeted scan");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["path"], ".trellis/tasks/selected/prd.md");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn suppression_requires_matching_content_and_consumes_once() {
        let (root, _store, sync, binding) =
            test_task_sync_fixture("trellis-watch-suppression").await;
        let relative = ".trellis/tasks/a/prd.md";
        let path = Path::new(&binding.repo_path).join(".trellis/tasks/a/prd.md");
        tokio::fs::create_dir_all(path.parent().expect("parent"))
            .await
            .expect("task dir");
        tokio::fs::write(&path, "expected")
            .await
            .expect("task file");
        sync.suppressed.lock().await.insert(
            absolute_task_path(&binding, relative),
            Some(snapshot_sha256("expected")),
        );
        assert!(sync.suppressed_event(&binding, relative).await);
        assert!(!sync.suppressed_event(&binding, relative).await);

        sync.suppressed.lock().await.insert(
            absolute_task_path(&binding, relative),
            Some(snapshot_sha256("expected")),
        );
        tokio::fs::write(&path, "changed")
            .await
            .expect("changed file");
        assert!(!sync.suppressed_event(&binding, relative).await);
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
