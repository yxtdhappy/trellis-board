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
const UPLOAD_MIN_INTERVAL: Duration = Duration::from_millis(260);
const RATE_LIMIT_RETRY_DELAY: Duration = Duration::from_millis(1000);
const RATE_LIMIT_RETRY_MAX_DELAY: Duration = Duration::from_millis(5000);
const MAX_RATE_LIMIT_RETRIES: u32 = 2;
const SNAPSHOT_EXTENSIONS: [&str; 6] = [".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"];
const WATCH_DEBOUNCE: Duration = Duration::from_millis(250);

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
    if files.len() > TASK_SNAPSHOT_MAX_FILES {
        return protocol::err(
            code::INVALID_RESPONSE,
            format!("单批任务文件不能超过 {TASK_SNAPSHOT_MAX_FILES} 个"),
        );
    }
    let mut groups: Vec<SnapshotGroup> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut seen = HashSet::new();
    let mut total_bytes = 0usize;
    for value in files {
        let file = validate_snapshot_file(value)?;
        if !seen.insert(file.path.clone()) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件路径不能重复");
        }
        total_bytes += file.content.len();
        if total_bytes > TASK_SNAPSHOT_MAX_BATCH_BYTES {
            return protocol::err(code::INVALID_RESPONSE, "任务文件批次超过 64 MiB");
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
                });
                index.insert(file.task_dir.clone(), groups.len() - 1);
                groups.len() - 1
            }
        };
        let group = &mut groups[position];
        if group.archived != file.archived {
            return protocol::err(code::INVALID_RESPONSE, "同一批次不能混合活动与归档任务路径");
        }
        if file.file_path == "task.json" && !file.deleted && group.task_id.is_none() {
            group.task_id = parse_task_id(&file.content);
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

fn parse_task_id(content: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(content).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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

#[derive(Debug, Clone, Default)]
pub struct Cursor {
    pub revision: u64,
    pub sequence: u64,
    pub pending: Option<PendingBatch>,
    pub baselines: BTreeMap<String, String>,
    pub deferred: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct PendingBatch {
    pub batch_id: String,
    pub client_sequence: u64,
    pub files: Vec<Value>,
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
            watch: Mutex::new(WatchState::default()),
        }
    }

    pub async fn set_bindings(&self, bindings: Vec<AgentBinding>) {
        let mut map = HashMap::new();
        for binding in bindings {
            if binding.sync_status == "approved" && !binding.task_space_id.is_empty() {
                map.insert(binding.task_space_id.clone(), binding);
            }
        }
        *self.bindings.lock().await = map;
    }

    pub async fn update_bindings(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
        let mut map = HashMap::new();
        for binding in bindings {
            if binding.sync_status == "approved" && !binding.task_space_id.is_empty() {
                map.insert(binding.task_space_id.clone(), binding);
            }
        }
        let watched: Vec<AgentBinding> = map
            .values()
            .filter(|binding| !binding.read_only)
            .cloned()
            .collect();
        let task_space_ids: Vec<String> = map.keys().cloned().collect();
        *self.bindings.lock().await = map;
        for task_space_id in task_space_ids {
            self.pull_and_report(&task_space_id).await;
        }
        self.rebuild_watchers(watched).await;
    }

    /// 拉取并对失败做可观测上报：写日志 + 触发 `task_sync_error` 控制事件。
    pub async fn pull_and_report(&self, task_space_id: &str) {
        if let Err(error) = self.pull_task_space(task_space_id).await {
            self.report_error(task_space_id, &error);
        }
    }

    fn report_error(&self, task_space_id: &str, error: &AgentError) {
        let message = protocol::safe_error_message(&error.to_string());
        crate::logging::warn(&format!(
            "任务空间同步失败 {{\"taskSpaceId\":\"{task_space_id}\",\"error\":\"{message}\"}}"
        ));
        (self.emit)(json!({
            "type": "task_sync_error",
            "taskSpaceId": task_space_id,
            "message": message,
        }));
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
                let paths: Vec<String> = paths.into_iter().collect();
                if let Err(error) = self.upload_dirty(&task_space_id, &paths).await {
                    self.report_error(&task_space_id, &error);
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
            .ok_or_else(|| AgentError::new(code::BINDING_UNKNOWN, "任务空间尚未关联到本地仓库"))
    }

    async fn read_cursor_state(&self) -> Value {
        let mut guard = self.cursor_state.lock().await;
        if let Some(state) = guard.as_ref() {
            return state.clone();
        }
        let state = tokio::fs::read_to_string(&self.store.paths.task_cursors_file)
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .filter(|value| {
                value.get("version").and_then(Value::as_u64) == Some(CURSOR_VERSION)
                    && value.get("taskSpaces").is_some_and(Value::is_object)
            })
            .unwrap_or_else(|| json!({ "version": CURSOR_VERSION, "taskSpaces": {} }));
        *guard = Some(state.clone());
        state
    }

    pub async fn read_cursor(&self, task_space_id: &str) -> Cursor {
        let state = self.read_cursor_state().await;
        let Some(entry) = state
            .get("taskSpaces")
            .and_then(|spaces| spaces.get(task_space_id))
        else {
            return Cursor::default();
        };
        let pending = entry.get("pending").and_then(parse_pending_batch);
        Cursor {
            revision: entry.get("revision").and_then(Value::as_u64).unwrap_or(0),
            sequence: entry.get("sequence").and_then(Value::as_u64).unwrap_or(0),
            pending,
            baselines: entry
                .get("baselines")
                .and_then(parse_baselines)
                .unwrap_or_default(),
            deferred: entry
                .get("deferred")
                .and_then(parse_deferred)
                .unwrap_or_default(),
        }
    }

    async fn write_cursor(&self, task_space_id: &str, next: CursorPatch) -> AgentResult<()> {
        let _guard = self.cursor_write.lock().await;
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
        let current_revision = entry.get("revision").and_then(Value::as_u64).unwrap_or(0);
        let current_sequence = entry.get("sequence").and_then(Value::as_u64).unwrap_or(0);
        entry.insert(
            "revision".into(),
            json!(current_revision.max(next.revision.unwrap_or(0))),
        );
        entry.insert(
            "sequence".into(),
            json!(current_sequence.max(next.sequence.unwrap_or(0))),
        );
        entry.insert("updatedAt".into(), Value::String(protocol::now_iso8601()));
        if let Some(baselines) = next.baselines {
            entry.insert("baselines".into(), baselines_to_value(&baselines));
        }
        if let Some(deferred) = next.deferred {
            entry.insert("deferred".into(), deferred_to_value(&deferred));
        }
        if let Some(pending) = next.pending {
            match pending {
                Some(batch) => {
                    entry.insert(
                        "pending".into(),
                        json!({
                            "batchId": batch.batch_id,
                            "clientSequence": batch.client_sequence,
                            "files": batch.files,
                        }),
                    );
                }
                None => {
                    entry.remove("pending");
                }
            }
        }
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
        let Some(target) = task_directory_absolute(binding, task_dir) else {
            return Ok(());
        };
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
        let Some(source) = task_directory_absolute(binding, task_dir) else {
            return Ok(None);
        };
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
    ) -> AgentResult<(Vec<String>, BTreeMap<String, BTreeMap<String, String>>)> {
        let groups = self.local_groups(binding, None).await?;
        let by_dir: HashMap<String, SnapshotGroup> = groups
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut next_deferred = cursor.deferred.clone();
        let mut task_dirs: HashSet<String> = by_dir.keys().cloned().collect();
        task_dirs.extend(cursor.deferred.keys().cloned());
        for path_name in normalize_baselines(&cursor.baselines).keys() {
            if let Some(task_dir) = task_directory_from_relative(path_name) {
                task_dirs.insert(task_dir);
            }
        }
        let mut dirty = Vec::new();
        for task_dir in task_dirs {
            let local_state = by_dir
                .get(&task_dir)
                .map(file_state_from_group)
                .unwrap_or_default();
            if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
                if deferred_state == &local_state {
                    continue;
                }
                next_deferred.remove(&task_dir);
            }
            if baselines_for_task_dir(&cursor.baselines, &task_dir) != local_state {
                dirty.push(task_dir);
            }
        }
        Ok((dirty, next_deferred))
    }

    pub async fn pull_task_space(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        self.pull(&binding).await
    }

    async fn pull(&self, binding: &AgentBinding) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let mut cursor = self.read_cursor(&task_space_id).await;
        let initial_sync = !binding.initial_sync_completed;
        if let Some(pending) = cursor.pending.clone() {
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
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
        let server_groups = groups_from_structs(&server_files)?;
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

        let (dirty_dirs, deferred) = self.local_sync_state(binding, &cursor).await?;
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
            if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                return Ok(json!({
                    "conflicts": [uploaded],
                    "revision": cursor.revision,
                    "pendingReview": true,
                }));
            }
            return Box::pin(self.pull(binding)).await;
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
                    files,
                });
            }
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
        let server_groups = groups_from_structs(&server_files)?;
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

    async fn upload_directories(
        &self,
        binding: &AgentBinding,
        task_dirs: &[String],
        reconcile: bool,
        base_sha: Option<&BTreeMap<String, String>>,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let mut cursor = self.read_cursor(&task_space_id).await;
        let mut latest_revision = cursor.revision;
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        if let Some(pending) = cursor.pending.clone() {
            let retry_files = pending.files.clone();
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(result);
                }
                latest_revision = latest_revision
                    .max(result.get("revision").and_then(Value::as_u64).unwrap_or(0));
                baseline_files.extend(parse_snapshot_files_from_values(&retry_files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        let all_local = self.local_groups(binding, None).await?;
        let local_by_dir: HashMap<String, SnapshotGroup> = all_local
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut entries: Vec<(String, Option<SnapshotGroup>, Vec<SnapshotFile>)> = Vec::new();
        let unique: HashSet<String> = task_dirs.iter().cloned().collect();
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
            if let Some(uploaded) = self.upload_persisted_batch(binding, &cursor, value).await? {
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
            if let Some(uploaded) = self.upload_persisted_batch(binding, &cursor, value).await? {
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
    ) -> AgentResult<Option<Value>> {
        if files.is_empty() {
            return Ok(None);
        }
        let batch = PendingBatch {
            batch_id: uuid::Uuid::new_v4().to_string(),
            client_sequence: next_client_sequence(cursor.sequence),
            files,
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
        Ok(Some(self.upload_batch(binding, batch).await?))
    }

    async fn upload_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let request = json!({
            "batchId": batch.batch_id,
            "clientSequence": batch.client_sequence,
            "files": batch.files,
        });
        let mut retry_delay = Duration::ZERO;
        let mut attempt = 0u32;
        let result = loop {
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
                Err(error) => return Err(error),
            }
        };

        let cursor = self.read_cursor(&task_space_id).await;
        if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
            let files = parse_snapshot_files_from_values(&batch.files)?;
            self.write_cursor(
                &task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision),
                    sequence: Some(batch.client_sequence),
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
                sequence: Some(batch.client_sequence),
                baselines: Some(baselines),
                deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                pending: Some(None),
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
        let snapshot = self.fetch_snapshot(task_space_id, 0).await?;
        let local_groups = self.local_groups(&binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let server_groups = groups_from_structs(&server_files)?;
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
            .upload_persisted_batch(binding, &cursor, values)
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
            return self
                .resolve_conflict(task_space_id, conflict_id, &json!({ "action": action }))
                .await;
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
                }),
            )
            .await?;
        if result.get("code").and_then(Value::as_str) != Some("TASK_FILE_CONFLICT") {
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

fn task_directory_absolute(binding: &AgentBinding, task_dir: &str) -> Option<PathBuf> {
    let tasks_root = Path::new(&binding.repo_path).join(".trellis").join("tasks");
    let target =
        Path::new(&binding.repo_path).join(task_dir.replace('/', std::path::MAIN_SEPARATOR_STR));
    let resolved_root = dunce_canonical(&tasks_root).unwrap_or_else(|| tasks_root.clone());
    let resolved_target = target.clone();
    if !protocol::is_path_inside(&resolved_root, &resolved_target)
        || resolved_target == resolved_root
    {
        return None;
    }
    Some(target)
}

fn dunce_canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

async fn write_task_directory(binding: &AgentBinding, group: &SnapshotGroup) -> AgentResult<()> {
    let Some(target) = task_directory_absolute(binding, &group.task_dir) else {
        return protocol::err(code::INVALID_RESPONSE, "服务端任务目录越界");
    };
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
