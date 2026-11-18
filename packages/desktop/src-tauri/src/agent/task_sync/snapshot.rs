use super::*;

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

    pub(super) fn to_control(&self) -> Value {
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
pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_uppercase())
}
pub(super) fn is_handoff_backup_id(value: &str) -> bool {
    value.len() == 24
        && value.strip_prefix("handoff-").is_some_and(|suffix| {
            suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        })
}
pub(super) fn sha256_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
pub(super) fn validate_upload_batch(files: &[Value]) -> AgentResult<()> {
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
pub(super) fn parse_task_id(content: &str) -> Option<String> {
    parse_task_metadata(content).0
}
pub(super) fn parse_task_metadata(content: &str) -> (Option<String>, Option<String>) {
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
pub(super) fn task_title(group: &SnapshotGroup) -> Option<String> {
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
pub(super) fn task_fingerprint(group: &SnapshotGroup) -> String {
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
pub(super) fn file_map(group: &SnapshotGroup) -> BTreeMap<String, String> {
    group
        .files
        .iter()
        .filter(|file| !file.deleted)
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}
pub(super) fn same_files(left: &BTreeMap<String, String>, right: &BTreeMap<String, String>) -> bool {
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
#[derive(Debug, Clone)]
pub struct UploadFile {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub deleted: bool,
    pub base_sha256: Option<String>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UploadMode {
    New,
    Preclassified,
    Replay,
}
impl UploadFile {
    pub(super) fn to_value(&self) -> Value {
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
pub(super) fn parse_snapshot_files(snapshot: &Value) -> AgentResult<Vec<SnapshotFile>> {
    let values = snapshot
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    parse_snapshot_files_from_values(&values)
}
pub(super) fn parse_snapshot_controls(snapshot: &Value) -> AgentResult<Option<Vec<TaskControl>>> {
    let Some(values) = snapshot.get("controls") else {
        return Ok(None);
    };
    let values = values
        .as_array()
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "快照 controls 必须是数组"))?;
    values
        .iter()
        .map(TaskControl::from_control_value)
        .collect::<AgentResult<Vec<_>>>()
        .map(Some)
}
pub(super) fn parse_snapshot_files_from_values(values: &[Value]) -> AgentResult<Vec<SnapshotFile>> {
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
pub(super) fn groups_from_structs(files: &[SnapshotFile]) -> AgentResult<Vec<SnapshotGroup>> {
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
pub(super) fn build_directory_files(
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
pub(super) fn uploads_to_snapshot_files(files: &[UploadFile]) -> AgentResult<Vec<SnapshotFile>> {
    let values: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
    parse_snapshot_files_from_values(&values)
}
pub(super) type DirectoryEntry = (String, Option<SnapshotGroup>, Vec<SnapshotFile>);
pub(super) fn move_pairs(entries: &[DirectoryEntry]) -> Vec<(DirectoryEntry, DirectoryEntry)> {
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
