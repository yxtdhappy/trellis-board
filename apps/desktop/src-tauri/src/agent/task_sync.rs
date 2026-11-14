use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use reqwest::Method;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Mutex};

use crate::agent::http::{ApiClient, MAX_SNAPSHOT_RESPONSE_BYTES};
use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::store::{AgentBinding, ConfigStore};

pub const TASK_SNAPSHOT_MAX_FILES: usize = 1024;
pub const TASK_SNAPSHOT_MAX_FILE_BYTES: usize = 1024 * 1024;
pub const TASK_SNAPSHOT_MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
const CURSOR_VERSION: u64 = 3;
const TASK_OWNERSHIP_QUERY_LIMIT: usize = 200;
const UPLOAD_MIN_INTERVAL: Duration = Duration::from_millis(260);
const RATE_LIMIT_RETRY_DELAY: Duration = Duration::from_millis(1000);
const RATE_LIMIT_RETRY_MAX_DELAY: Duration = Duration::from_millis(5000);
const MAX_RATE_LIMIT_RETRIES: u32 = 2;
const SNAPSHOT_EXTENSIONS: [&str; 6] = [".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"];
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);
/// ProjectRail 每 3 秒轮询一次；关联展示允许短时复用，同步门禁仍逐次精确校验。
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
            "local": self.local.as_ref().map(|group| json!({
                "taskId": group.task_id,
                "taskDir": group.task_dir,
            })),
            "server": self.server.as_ref().map(|group| json!({
                "taskId": group.task_id,
                "taskDir": group.task_dir,
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
        .filter(|file| !file.deleted && is_sha256(&file.sha256))
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
            is_sha256(sha256) && normalize_snapshot_path(path_name).is_ok()
        })
        .map(|(path_name, sha256)| (path_name.clone(), sha256.clone()))
        .collect()
}

fn file_state_from_group(group: &SnapshotGroup) -> BTreeMap<String, String> {
    group
        .files
        .iter()
        .filter(|file| !file.deleted)
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}

fn baselines_for_task_dir(
    baselines: &BTreeMap<String, String>,
    task_dir: &str,
) -> BTreeMap<String, String> {
    normalize_baselines(baselines)
        .into_iter()
        .filter(|(path_name, _)| {
            task_directory_from_relative(path_name).as_deref() == Some(task_dir)
        })
        .collect()
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
    task_dirs.extend(cursor.deferred.keys().cloned());
    for baselines in [&cursor.baselines, server_baselines] {
        let normalized = normalize_baselines(baselines);
        for path_name in normalized.keys() {
            if let Some(task_dir) = task_directory_from_relative(path_name) {
                task_dirs.insert(task_dir);
            }
        }
    }
    let mut dirty = Vec::new();
    let mut reconciled_deferred = HashSet::new();
    for task_dir in task_dirs {
        let local_state = by_dir
            .get(task_dir.as_str())
            .map(file_state_from_group)
            .unwrap_or_default();
        // cursor 基线只判 dirty；只有合并服务端基线完全一致时才记录为精确收敛。
        if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
            if local_state.is_empty() {
                continue;
            }
            if deferred_state == &local_state {
                if baselines_for_task_dir(server_baselines, &task_dir) == local_state {
                    next_deferred.remove(&task_dir);
                    reconciled_deferred.insert(task_dir.clone());
                }
                continue;
            }
            next_deferred.remove(&task_dir);
        }
        if baselines_for_task_dir(&cursor.baselines, &task_dir) != local_state {
            dirty.push(task_dir);
        }
    }
    (dirty, next_deferred, reconciled_deferred)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    pub revision: u64,
    pub sequence: u64,
    pub pending: Option<PendingBatch>,
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
}

fn cursor_from_entry(entry: &Value) -> Cursor {
    Cursor {
        revision: entry.get("revision").and_then(Value::as_u64).unwrap_or(0),
        sequence: entry.get("sequence").and_then(Value::as_u64).unwrap_or(0),
        pending: entry.get("pending").and_then(parse_pending_batch),
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
    }
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

struct WatchEvent {
    task_space_id: String,
    relative_path: String,
}

#[derive(Default)]
struct WatchState {
    watchers: Vec<RecommendedWatcher>,
    tx: Option<mpsc::UnboundedSender<WatchEvent>>,
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
    paused: Arc<HashSet<String>>,
    local_dirs: Arc<HashSet<String>>,
    validated_at: Instant,
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

pub struct TaskSync {
    store: Arc<ConfigStore>,
    api: Arc<ApiClient>,
    emit: ControlSink,
    bindings: Mutex<HashMap<String, AgentBinding>>,
    suppressed: Mutex<HashMap<String, Option<String>>>,
    upload_gate: Mutex<HashMap<String, Instant>>,
    cursor_state: Mutex<Option<Value>>,
    cursor_write: Mutex<()>,
    last_baseline_files: Mutex<Vec<SnapshotFile>>,
    head_tree_cache: Mutex<HashMap<String, HeadTreeCache>>,
    ownership_projection_cache: Mutex<HashMap<String, OwnershipProjectionCache>>,
    ownership_projection_epoch: std::sync::atomic::AtomicU64,
    #[cfg(test)]
    head_tree_scans: std::sync::atomic::AtomicUsize,
    baseline_owned: Mutex<HashSet<String>>,
    watch: Mutex<WatchState>,
}

impl TaskSync {
    pub fn new(store: Arc<ConfigStore>, api: Arc<ApiClient>, emit: ControlSink) -> Self {
        Self {
            store,
            api,
            emit,
            bindings: Mutex::new(HashMap::new()),
            suppressed: Mutex::new(HashMap::new()),
            upload_gate: Mutex::new(HashMap::new()),
            cursor_state: Mutex::new(None),
            cursor_write: Mutex::new(()),
            last_baseline_files: Mutex::new(Vec::new()),
            head_tree_cache: Mutex::new(HashMap::new()),
            ownership_projection_cache: Mutex::new(HashMap::new()),
            ownership_projection_epoch: std::sync::atomic::AtomicU64::new(0),
            #[cfg(test)]
            head_tree_scans: std::sync::atomic::AtomicUsize::new(0),
            baseline_owned: Mutex::new(HashSet::new()),
            watch: Mutex::new(WatchState::default()),
        }
    }

    pub async fn set_bindings(&self, bindings: Vec<AgentBinding>) {
        *self.bindings.lock().await = approved_bindings(bindings);
        self.ownership_projection_epoch.fetch_add(
            1,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.head_tree_cache.lock().await.clear();
        self.ownership_projection_cache.lock().await.clear();
        self.baseline_owned.lock().await.clear();
    }

    pub async fn update_bindings(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
        let mut selected = self.select_bindings(bindings).await;
        let (unchanged, pull_task_space_ids) = {
            let _lifecycle = self.cursor_write.lock().await;
            if let Ok(Some(config)) = self.store.read_config(false).await {
                let active_local_ids: HashSet<String> = config
                    .bindings
                    .iter()
                    .filter(|binding| {
                        binding.sync_status == "approved" && !binding.detach_pending
                    })
                    .map(|binding| binding.local_id.clone())
                    .collect();
                selected.retain(|binding| active_local_ids.contains(&binding.local_id));
            } else {
                selected.clear();
            }
            let map = approved_bindings(selected.clone());
            let mut current = self.bindings.lock().await;
            let unchanged = binding_selection_unchanged(&current, &map);
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
            (unchanged, pull_task_space_ids)
        };
        if unchanged {
            return;
        }
        self.ownership_projection_epoch.fetch_add(
            1,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.head_tree_cache.lock().await.clear();
        self.ownership_projection_cache.lock().await.clear();
        self.baseline_owned.lock().await.clear();
        for task_space_id in pull_task_space_ids {
            self.pull_and_report(&task_space_id).await;
        }
        let watched: Vec<AgentBinding> = selected
            .into_iter()
            .filter(|binding| !binding.read_only)
            .collect();
        self.rebuild_watchers(watched).await;
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
                match self.assert_binding_branch(&binding).await {
                    Ok(_) => selected.push(binding),
                    Err(error) => self.report_binding_error(&binding, &error),
                }
                continue;
            }
            let mut matches = Vec::new();
            for binding in &items {
                match self.assert_binding_branch(binding).await {
                    Ok(_) => matches.push(binding.clone()),
                    Err(error) => {
                        self.report_binding_error(binding, &error);
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
        let hooks_dir = self.binding_hooks_dir(binding);
        let repo = Path::new(&binding.repo_path);
        {
            let mut cache = self.head_tree_cache.lock().await;
            if let Some(entry) = cache.get_mut(&binding.task_space_id) {
                if entry.branch_name == branch && entry.head_commit == head {
                    entry.validated_at = Instant::now();
                    return Ok((entry.head_commit.clone(), entry.tracked_paths.clone()));
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
                branch_name: branch,
                head_commit: head.clone(),
                tracked_paths: tracked_paths.clone(),
                validated_at: Instant::now(),
            },
        );
        Ok((head, tracked_paths))
    }

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
        self.ownership_projection_epoch.fetch_add(
            1,
            std::sync::atomic::Ordering::SeqCst,
        );
        self.ownership_projection_cache
            .lock()
            .await
            .remove(task_space_id);
    }

    async fn cache_ownership_projection(
        &self,
        task_space_id: String,
        projection_epoch: u64,
        entry: OwnershipProjectionCache,
    ) {
        let mut cache = self.ownership_projection_cache.lock().await;
        if self
            .ownership_projection_epoch
            .load(std::sync::atomic::Ordering::SeqCst)
            == projection_epoch
        {
            cache.insert(task_space_id, entry);
        }
    }

    /// ProjectRail 轮询只复用展示投影；真正上传前仍由同步门禁重新校验。
    pub(crate) async fn ownership_projection(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
        let projection_epoch = self
            .ownership_projection_epoch
            .load(std::sync::atomic::Ordering::SeqCst);
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
                    )
                })
        };
        if let Some((_, paused, local_dirs, validated_at)) = &cached {
            if validated_at.elapsed() < OWNERSHIP_PROJECTION_CACHE_TTL {
                return Ok((paused.clone(), local_dirs.clone()));
            }
        }

        // TTL 到期后先确认完整 HEAD；同一 HEAD 下只续期，不重新枚举任务目录。
        let (branch_name, head_commit) = self.binding_head(binding).await?;
        {
            let mut cache = self.head_tree_cache.lock().await;
            if cache
                .get(&binding.task_space_id)
                .is_some_and(|entry| {
                    entry.branch_name != branch_name || entry.head_commit != head_commit
                })
            {
                cache.remove(&binding.task_space_id);
            }
        }
        if let Some((cached_head, _, _, _)) = &cached {
            if cached_head == &head_commit {
                let mut cache = self.ownership_projection_cache.lock().await;
                if let Some(entry) = cache.get_mut(&binding.task_space_id) {
                    if self
                        .ownership_projection_epoch
                        .load(std::sync::atomic::Ordering::SeqCst)
                        == projection_epoch
                        && ownership_projection_cache_matches(entry, binding)
                        && entry.head_commit == head_commit
                    {
                        entry.validated_at = Instant::now();
                        return Ok((entry.paused.clone(), entry.local_dirs.clone()));
                    }
                }
            }
        }

        let groups = read_local_task_ownership_groups(Path::new(&binding.repo_path)).await?;
        let paused = Arc::new(self.ownership_paused_task_dirs(binding, &groups).await);
        let local_dirs = Arc::new(
            groups
                .iter()
                .map(|group| group.task_dir.clone())
                .collect::<HashSet<_>>(),
        );
        self.cache_ownership_projection(
            binding.task_space_id.clone(),
            projection_epoch,
            OwnershipProjectionCache {
                local_id: binding.local_id.clone(),
                branch_name,
                baseline_branch: binding.baseline_branch.clone(),
                repo_path: binding.repo_path.clone(),
                head_commit,
                paused: paused.clone(),
                local_dirs: local_dirs.clone(),
                validated_at: Instant::now(),
            },
        )
        .await;
        Ok((paused, local_dirs))
    }

    /// 本地关联展示与同步门禁共用同一套基线错分支判定和 HEAD tree 缓存。
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
        let result = self
            .store
            .update_config(false, |current| {
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
                Ok(if changed { Some(next) } else { None })
            })
            .await;
        if let Err(error) = result {
            crate::logging::warn(&format!(
                "保存任务同步状态失败：{}",
                protocol::safe_error_message(&error.message)
            ));
        }
    }

    async fn clear_branch_guard_error(&self, binding: &AgentBinding) {
        let local_id = binding.local_id.clone();
        let result = self
            .store
            .update_config(false, |current| {
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
                Ok(if changed { Some(next) } else { None })
            })
            .await;
        if let Err(error) = result {
            crate::logging::warn(&format!(
                "保存分支恢复状态失败：{}",
                protocol::safe_error_message(&error.message)
            ));
        }
    }

    /// 拉取、补收敛基线任务，并对失败写日志和 `task_sync_error` 控制事件。
    pub async fn pull_and_report(&self, task_space_id: &str) {
        let mut reconciled_deferred = HashSet::new();
        match self
            .pull_task_space_tracking(task_space_id, &mut reconciled_deferred)
            .await
        {
            Ok(result) if result.get("pendingReview").and_then(Value::as_bool) != Some(true) => {
                if let Err(error) = self
                    .reconcile_baseline_tasks(task_space_id, &reconciled_deferred)
                    .await
                {
                    self.report_error(task_space_id, &error).await;
                }
            }
            Ok(_) => {}
            Err(error) => self.report_error(task_space_id, &error).await,
        }
    }

    pub async fn pull_and_report_for_event(
        &self,
        task_space_id: &str,
        event_revision: Option<u64>,
    ) {
        if let Err(error) = self
            .pull_task_space_for_event(task_space_id, event_revision)
            .await
        {
            self.report_error(task_space_id, &error).await;
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
        for binding in bindings {
            let root = Path::new(&binding.repo_path).join(".trellis");
            if !root.is_dir() {
                continue;
            }
            let task_space_id = binding.task_space_id.clone();
            let watch_root = root.clone();
            let sender = tx.clone();
            let mut watcher =
                match notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                    let Ok(event) = result else {
                        return;
                    };
                    for path in event.paths {
                        let Ok(relative) = path.strip_prefix(&watch_root) else {
                            continue;
                        };
                        let relative = relative.to_string_lossy().replace('\\', "/");
                        if !is_watched_trellis_path(&relative) {
                            continue;
                        }
                        let _ = sender.send(WatchEvent {
                            task_space_id: task_space_id.clone(),
                            relative_path: format!(".trellis/{relative}"),
                        });
                    }
                }) {
                    Ok(watcher) => watcher,
                    Err(error) => {
                        crate::logging::warn(&format!("任务目录监听失败：{error}"));
                        continue;
                    }
                };
            if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
                crate::logging::warn(&format!("任务目录监听失败：{error}"));
                continue;
            }
            state.watchers.push(watcher);
        }
    }

    async fn watch_loop(self: Arc<Self>, mut receiver: mpsc::UnboundedReceiver<WatchEvent>) {
        let mut pending: HashMap<String, HashSet<String>> = HashMap::new();
        loop {
            let Some(first) = receiver.recv().await else {
                break;
            };
            pending
                .entry(first.task_space_id)
                .or_default()
                .insert(first.relative_path);
            loop {
                match tokio::time::timeout(WATCH_DEBOUNCE, receiver.recv()).await {
                    Ok(Some(event)) => {
                        pending
                            .entry(event.task_space_id)
                            .or_default()
                            .insert(event.relative_path);
                    }
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
            for (task_space_id, paths) in std::mem::take(&mut pending) {
                self.invalidate_ownership_projection(&task_space_id).await;
                let paths: Vec<String> = paths.into_iter().collect();
                // 首次同步未完成时 watcher 仍在监听，但上传必须等 bootstrap 拉取落地，
                // 否则会用本地旧内容抢在服务端快照之前写入（对照 JS `_uploadDirty` 的守卫）。
                let ready = self
                    .bindings
                    .lock()
                    .await
                    .get(&task_space_id)
                    .is_some_and(|binding| !binding.read_only && binding.initial_sync_completed);
                if !ready {
                    continue;
                }
                if let Err(error) = self.upload_dirty(&task_space_id, &paths).await {
                    self.report_error(&task_space_id, &error).await;
                }
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
        let mut bindings: Vec<AgentBinding> =
            self.bindings.lock().await.values().cloned().collect();
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
            .and_then(|entry| entry.get("pending"))
            .and_then(parse_pending_batch)
            .is_some();
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
        if !apply_cursor_patch(&mut cursor, &next) {
            *self.cursor_state.lock().await = Some(state);
            return Ok(());
        }
        entry.insert("revision".into(), json!(cursor.revision));
        entry.insert("sequence".into(), json!(cursor.sequence));
        if next.baselines.is_some() {
            entry.insert("baselines".into(), baselines_to_value(&cursor.baselines));
        }
        if next.deferred.is_some() {
            entry.insert("deferred".into(), deferred_to_value(&cursor.deferred));
        }
        if next.ownership_pending.is_some() {
            entry.insert(
                "ownershipPending".into(),
                ownership_pending_to_value(&cursor.ownership_pending),
            );
        }
        if next.conflict_blocked.is_some() {
            entry.insert(
                "conflictBlocked".into(),
                conflict_blocked_to_value(&cursor.conflict_blocked),
            );
        }
        if next.pending.is_some() {
            match cursor.pending {
                Some(batch) => {
                    entry.insert(
                        "pending".into(),
                        json!({
                            "batchId": batch.batch_id,
                            "clientSequence": batch.client_sequence,
                            "files": batch.files,
                            "mergeEvidence": batch.merge_evidence,
                        }),
                    );
                }
                None => {
                    entry.remove("pending");
                }
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
        Ok(())
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
                    .and_then(task_directory_from_relative)
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
            self.assert_binding_branch(binding).await?;
            if group
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
        let source = resolve_task_directory(binding, task_dir).await?;
        if !source.exists() {
            return Ok(None);
        }
        let backup_id = uuid::Uuid::new_v4().to_string();
        let target = self
            .store
            .paths
            .live_backups_dir
            .join(&binding.task_space_id)
            .join(&backup_id);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AgentError::new(code::INVALID_RESPONSE, format!("无法创建备份目录: {error}"))
            })?;
        }
        copy_directory(&source, &target).await?;
        Ok(Some(backup_id))
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
        let groups = self.local_groups(binding, None).await?;
        Ok(local_sync_state_from_groups(
            cursor,
            &groups,
            server_baselines,
        ))
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
            if !should_pull_for_event(
                binding.initial_sync_completed,
                binding.initial_review_pending,
                cursor_revision,
                event_revision,
                has_pending_upload,
            ) {
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
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let mut cursor = self.read_cursor(&task_space_id).await;
        let initial_sync = !binding.initial_sync_completed;
        if let Some(pending) = cursor.pending.clone() {
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                if result.get("skipped").and_then(Value::as_bool) == Some(true) {
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
        let after_revision = if initial_sync { 0 } else { cursor.revision };
        let snapshot = self.fetch_snapshot(&task_space_id, after_revision).await?;
        if initial_sync {
            return self.pull_initial_sync(binding, &snapshot).await;
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

        let (dirty_dirs, deferred, exact_reconciled) = self
            .local_sync_state(binding, &cursor, &snapshot_baselines)
            .await?;
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
            let differences = classify_task_snapshots(&local_groups, &server_groups);
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
                latest_revision = latest_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
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
        Ok(json!({ "conflicts": [], "revision": latest_revision }))
    }

    async fn pull_initial_sync(
        &self,
        binding: &AgentBinding,
        snapshot: &Value,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let local_groups = self.local_groups(binding, None).await?;
        let snapshot_files = parse_snapshot_files(snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_binding(binding, &mut server_groups);
        let server_baselines = baselines_from_snapshot(&snapshot_files);
        let differences = classify_task_snapshots(&local_groups, &server_groups);
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
            let local_only: Vec<String> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::LocalOnly)
                .filter_map(|item| item.local.as_ref().map(|group| group.task_dir.clone()))
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
                latest_revision = latest_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
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
            let verified_local = self.local_groups(binding, None).await?;
            let verified_files = parse_snapshot_files(&verified)?;
            let verified_server_files: Vec<SnapshotFile> = verified_files
                .iter()
                .filter(|file| !file.deleted)
                .cloned()
                .collect();
            let verified_server = groups_from_structs(&verified_server_files)?;
            let verified_differences = classify_task_snapshots(&verified_local, &verified_server);
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
            let Some(task_dir) = task_directory_from_relative(dirty_path) else {
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
        let groups = self.local_groups(&binding, None).await?;
        let cursor = self.read_cursor(task_space_id).await;
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
        self.upload_directories(&binding, &task_dirs, false, None)
            .await
    }

    pub async fn sync_task_directories(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
        reconcile: bool,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
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
            if task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
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
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let mut cursor = self.read_cursor(&task_space_id).await;
        let mut latest_revision = cursor.revision;
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        if let Some(pending) = cursor.pending.clone() {
            let retry_files = pending.files.clone();
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                if result.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(result);
                }
                if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(result);
                }
                latest_revision = latest_revision
                    .max(result.get("revision").and_then(Value::as_u64).unwrap_or(0));
                baseline_files.extend(parse_snapshot_files_from_values(&retry_files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        let requested: HashSet<String> = task_dirs.iter().cloned().collect();
        let local_groups = self
            .local_groups(binding, Some(&requested))
            .await?;
        let ownership = self.resolve_task_ownership(binding, &local_groups).await?;
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
        let all_local = self.local_groups(binding, None).await?;
        let local_by_dir: HashMap<String, SnapshotGroup> = all_local
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut entries: Vec<(String, Option<SnapshotGroup>, Vec<SnapshotFile>)> = Vec::new();
        let unique: HashSet<String> = allowed.into_iter().collect();
        for task_dir in unique {
            let server = self.fetch_directory(&task_space_id, &task_dir).await?;
            let server_files = parse_directory_files(&server, &task_dir)?;
            entries.push((
                task_dir.clone(),
                local_by_dir.get(&task_dir).cloned(),
                server_files,
            ));
        }

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
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                handled.insert(source.0.clone());
                handled.insert(target.0.clone());
                latest_revision = latest_revision.max(
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
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                latest_revision = latest_revision.max(
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

        if reconcile {
            Box::pin(self.pull(binding)).await?;
        }
        Ok(json!({
            "revision": latest_revision,
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
        Ok(Some(self.upload_batch(binding, batch).await?))
    }

    async fn retry_pending_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
    ) -> AgentResult<Option<Value>> {
        validate_upload_batch(&batch.files)?;
        Ok(Some(self.upload_batch(binding, batch).await?))
    }

    async fn upload_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let task_dirs: HashSet<String> = batch
            .files
            .iter()
            .filter_map(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .and_then(task_directory_from_relative)
            })
            .collect();
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
        let mut active_sequence = batch.client_sequence;
        let mut sequence_recovered = false;
        let mut retry_delay = Duration::ZERO;
        let mut attempt = 0u32;
        let result = loop {
            // 每次尝试都重新校验分支，并把实际分支名带给服务端。
            let observed = self.assert_binding_branch(binding).await?;
            let mut request = json!({
                "batchId": batch.batch_id,
                "clientSequence": active_sequence,
                "files": batch.files,
                "observedBranchName": observed,
            });
            if let Some(evidence) = &batch.merge_evidence {
                request["mergeEvidence"] = evidence.clone();
            }
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

        let cursor = self.read_cursor(&task_space_id).await;
        if result.get("reason").and_then(Value::as_str) == Some("TASK_OWNED_BY_BASELINE") {
            self.write_cursor(
                &task_space_id,
                CursorPatch {
                    pending: Some(None),
                    ..Default::default()
                },
            )
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
        let revision = cursor
            .revision
            .max(result.get("revision").and_then(Value::as_u64).unwrap_or(0));
        let baselines = merge_baselines(&cursor.baselines, &files);
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(revision),
                sequence: Some(active_sequence),
                baselines: Some(baselines),
                deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                pending: Some(None),
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
        let local_groups = self.local_groups(&binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_binding(&binding, &mut server_groups);
        let snapshot_baselines = baselines_from_snapshot(&snapshot_files);
        let differences = classify_task_snapshots(&local_groups, &server_groups);

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
                latest_revision = latest_revision
                    .max(result.get("revision").and_then(Value::as_u64).unwrap_or(0));
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
                "safe",
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
            .filter_map(|file| task_directory_from_relative(&file.path))
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
            let next_revision = cursor
                .revision
                .max(result.get("revision").and_then(Value::as_u64).unwrap_or(0));
            let uploaded_files = parse_snapshot_files_from_values(&values)?;
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(next_revision),
                    sequence: Some(next_sequence),
                    baselines: Some(merge_baselines(&cursor.baselines, &uploaded_files)),
                    pending: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            self.write_server_cursor(task_space_id, next_revision)
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
                    paths.insert(path_name.to_string());
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
            .unwrap_or_default())
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
        let mut candidates: Vec<String> = Vec::new();
        for candidate in [local.clone(), server.clone()].into_iter().flatten() {
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
        if let Some(items) = conflict.get("files").and_then(Value::as_array) {
            for item in items {
                if let Some(path_name) = item.get("path").and_then(Value::as_str) {
                    if let Some(candidate) = task_directory_from_relative(path_name) {
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

struct ConflictDirectories {
    local: Option<String>,
    server: Option<String>,
    server_files: Vec<SnapshotFile>,
}

#[derive(Default)]
struct CursorPatch {
    revision: Option<u64>,
    sequence: Option<u64>,
    pending: Option<Option<PendingBatch>>,
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
    if let Some(sequence) = next.sequence {
        cursor.sequence = cursor.sequence.max(sequence);
    }
    if let Some(pending) = &next.pending {
        cursor.pending = pending.clone();
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
        group
            .task_branch
            .as_deref()
            .map(|branch| branch == binding.branch_name)
            .unwrap_or(true)
    });
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

fn parse_snapshot_files_from_values(values: &[Value]) -> AgentResult<Vec<SnapshotFile>> {
    values.iter().map(validate_snapshot_file).collect()
}

pub(crate) fn parse_directory_files(
    directory: &Value,
    task_dir: &str,
) -> AgentResult<Vec<SnapshotFile>> {
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
        let belongs = task_directory_from_relative(&path_name).as_deref() == Some(task_dir);
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
        if let Some(task_dir) = task_directory_from_relative(&file.path) {
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
        if is_sha256(sha256) && normalize_snapshot_path(path_name).is_ok() {
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
        if files.keys().all(|path_name| {
            task_directory_from_relative(path_name).as_deref() == Some(task_dir.as_str())
        }) {
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

fn parse_ownership_pending(value: &Value) -> BTreeMap<String, String> {
    let mut pending = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return pending;
    };
    for (task_dir, state) in object {
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
    })
}

/// 只关心任务目录：`upload_dirty` 对其它路径无能为力，少转发少唤醒。
fn is_watched_trellis_path(relative: &str) -> bool {
    relative == "tasks" || relative.starts_with("tasks/")
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
    tokio::fs::create_dir_all(target).await.map_err(io_error)?;
    let mut stack = vec![source.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let path = entry.path();
            let relative = path.strip_prefix(source).unwrap_or(&path).to_path_buf();
            let destination = target.join(&relative);
            let metadata = entry.metadata().await.map_err(io_error)?;
            if metadata.is_dir() {
                tokio::fs::create_dir_all(&destination)
                    .await
                    .map_err(io_error)?;
                stack.push(path);
            } else if metadata.is_file() {
                if let Some(parent) = destination.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(io_error)?;
                }
                tokio::fs::copy(&path, &destination)
                    .await
                    .map_err(io_error)?;
            }
        }
    }
    Ok(())
}

fn previous_values_paths(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.get("path").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// ProjectRail 投影只依赖任务目录和 task.json.branch，不读取其他任务文件内容。
async fn read_local_task_ownership_groups(repo_path: &Path) -> AgentResult<Vec<SnapshotGroup>> {
    let tasks_root = repo_path.join(".trellis").join("tasks");
    let Ok(metadata) = tokio::fs::symlink_metadata(&tasks_root).await else {
        return Ok(Vec::new());
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return protocol::err(code::MISSING_TRELLIS, ".trellis/tasks 必须是真实目录");
    }
    let mut groups: HashMap<String, SnapshotGroup> = HashMap::new();
    let mut stack = vec![tasks_root.clone()];
    while let Some(directory) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let path = entry.path();
            let metadata = entry.metadata().await.map_err(io_error)?;
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
            let relative = path
                .strip_prefix(repo_path)
                .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            let Ok(parts) = task_directory_from_path(&relative) else {
                continue;
            };
            let group = groups
                .entry(parts.task_dir.clone())
                .or_insert_with(|| SnapshotGroup {
                    task_dir: parts.task_dir.clone(),
                    archived: parts.archived,
                    archive_month: parts.archive_month.clone(),
                    files: Vec::new(),
                    task_id: None,
                    task_branch: None,
                });
            if parts.file_path == "task.json" {
                let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
                let text = String::from_utf8(bytes).map_err(|_| {
                    AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本")
                })?;
                group.task_branch = parse_task_metadata(&normalize_snapshot_text(&text)).1;
            }
        }
    }
    Ok(groups.into_values().collect())
}

pub async fn read_local_task_snapshot_files(
    repo_path: &Path,
    task_dirs: Option<&HashSet<String>>,
) -> AgentResult<Vec<Value>> {
    let tasks_root = repo_path.join(".trellis").join("tasks");
    let Ok(metadata) = tokio::fs::symlink_metadata(&tasks_root).await else {
        return Ok(Vec::new());
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return protocol::err(code::MISSING_TRELLIS, ".trellis/tasks 必须是真实目录");
    }
    let mut files = Vec::new();
    let mut stack = vec![tasks_root.clone()];
    while let Some(directory) = stack.pop() {
        let mut entries = tokio::fs::read_dir(&directory).await.map_err(io_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
            let path = entry.path();
            let metadata = entry.metadata().await.map_err(io_error)?;
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
            let relative = path
                .strip_prefix(repo_path)
                .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            let task_dir = match task_directory_from_relative(&relative) {
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
        let snapshot_payload = Arc::new(snapshot_payload);
        let captured_changes = changes.clone();
        let captured_requests = requests.clone();
        let captured_snapshot_payload = snapshot_payload.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let changes = captured_changes.clone();
                let requests = captured_requests.clone();
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
                    let (status, payload) = if path.contains("/snapshot?") {
                        ("200 OK", snapshot_payload.as_ref().clone())
                    } else if path.contains("/files?") {
                        (
                            "200 OK",
                            json!({
                                "files": snapshot_payload
                                    .get("files")
                                    .cloned()
                                    .unwrap_or_else(|| Value::Array(Vec::new()))
                            }),
                        )
                    } else if method == "PUT" && path.ends_with("/cursor") {
                        ("200 OK", json!({}))
                    } else if method == "POST" && path.ends_with("/changes") {
                        changes.lock().await.push(body);
                        ("200 OK", json!({ "revision": 2 }))
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
                &format!(".trellis/tasks/archive/2026-11/tracked-{index}"),
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
        let projection_epoch = sync
            .ownership_projection_epoch
            .load(std::sync::atomic::Ordering::SeqCst);

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
        let sync = Arc::new(TaskSync::new(store.clone(), api, sink));

        sync.update_bindings(vec![binding]).await;

        let changes = changes.lock().await;
        assert_eq!(changes.len(), 1, "启动时应自动补交一次任务快照");
        assert_eq!(changes[0]["mergeEvidence"]["taskId"], "merged-task");
        assert_eq!(changes[0]["mergeEvidence"]["taskDir"], task_dir);
        assert_eq!(changes[0]["mergeEvidence"]["sourceBranch"], "dev1");
        assert_eq!(changes[0]["mergeEvidence"]["baselineBranch"], "main");
        assert_eq!(changes[0]["files"][0]["path"], task_json);
        assert_eq!(changes[0]["observedBranchName"], "main");
        assert!(sync
            .read_cursor("space-1")
            .await
            .pending
            .is_none());
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
    async fn resolves_active_and_archived_task_directories_under_temp_repo() {
        let (root, _store, _sync, binding) = test_task_sync_fixture("trellis-task-path").await;
        let tasks_root = Path::new(&binding.repo_path).join(".trellis").join("tasks");

        assert_eq!(
            resolve_task_directory(&binding, ".trellis/tasks/active-task")
                .await
                .expect("active task"),
            tasks_root.join("active-task")
        );
        assert_eq!(
            resolve_task_directory(
                &binding,
                ".trellis/tasks/archive/2026-11/archived-task",
            )
            .await
            .expect("archived task"),
            tasks_root
                .join("archive")
                .join("2026-11")
                .join("archived-task")
        );

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
    fn group_rejects_duplicate_snapshot_paths() {
        let files = vec![
            snapshot_file_value(".trellis/tasks/a/prd.md", "one"),
            snapshot_file_value(".trellis/tasks/a/prd.md", "two"),
        ];

        let error = group_task_snapshot_files(&files).expect_err("重复路径应失败");
        assert!(error.message.contains("不能重复"));
    }

    #[test]
    fn groups_active_and_archived_task_directories_separately() {
        let files = vec![
            snapshot_file_value(".trellis/tasks/a/prd.md", ""),
            snapshot_file_value(".trellis/tasks/archive/2026-11/b/prd.md", ""),
        ];

        let groups = group_task_snapshot_files(&files).expect("活动与归档目录应分别分组");
        assert_eq!(groups.len(), 2);
        assert_eq!(groups.iter().filter(|group| group.archived).count(), 1);
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

        let pending = PendingBatch {
            batch_id: "batch-1".to_string(),
            client_sequence: 3,
            files: vec![json!({ "path": ".trellis/tasks/a/prd.md" })],
            merge_evidence: None,
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
        let sync = TaskSync::new(store.clone(), api, sink);
        sync.remove_task_cursor("space-1").await.expect("remove");
        let state = store.read_task_cursors().await;
        assert!(state["taskSpaces"].get("space-1").is_none());
        assert_eq!(state["taskSpaces"]["space-2"]["revision"], 2);
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
        let sync = TaskSync::new(store.clone(), api, sink);
        sync.set_bindings(vec![binding]).await;

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
    fn watcher_only_tracks_task_paths() {
        assert!(is_watched_trellis_path("tasks"));
        assert!(is_watched_trellis_path("tasks/11-12-demo/task.json"));
        assert!(is_watched_trellis_path(
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
            task_directory_from_relative(".trellis/workspace/a.md"),
            None
        );
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

    #[tokio::test]
    async fn reads_local_task_snapshot_files() {
        let root = std::env::temp_dir().join(format!("trellis-snap-{}", uuid::Uuid::new_v4()));
        let task_dir = root.join(".trellis").join("tasks").join("01-x");
        tokio::fs::create_dir_all(&task_dir).await.expect("mkdir");
        tokio::fs::write(task_dir.join("prd.md"), "# hi\r\n")
            .await
            .expect("write");
        let files = read_local_task_snapshot_files(&root, None)
            .await
            .expect("read");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["content"], "# hi\n");
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
