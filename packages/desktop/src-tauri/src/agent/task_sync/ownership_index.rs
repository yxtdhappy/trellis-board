use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnershipIndex {
    pub version: u32,
    #[serde(default)]
    pub bindings: BTreeMap<String, OwnershipIndexBinding>,
}
impl OwnershipIndex {
    pub(super) fn empty() -> Self {
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
pub(super) fn normalize_index(mut index: OwnershipIndex) -> Option<OwnershipIndex> {
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
                task_directory_from_path(path)
                    .is_ok_and(|parts| !parts.archived && parts.file_path == "task.json")
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
            let file = binding.files.get(&format!("{task_dir}/task.json"))?;
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
pub(crate) type IndexedOwnershipProjection =
    (Arc<HashSet<String>>, Arc<HashSet<String>>, String, String);
pub(crate) fn indexed_ownership_projection(
    index: &OwnershipIndex,
    binding: &AgentBinding,
) -> Option<IndexedOwnershipProjection> {
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
pub(super) fn indexed_local_groups(
    entry: &OwnershipIndexBinding,
) -> AgentResult<Vec<SnapshotGroup>> {
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
        group
            .files
            .sort_by(|left, right| left.path.cmp(&right.path));
    }
    Ok(groups)
}
pub(super) struct HeadTreeCache {
    pub(super) branch_name: String,
    pub(super) head_commit: String,
    pub(super) tracked_paths: Arc<HashSet<String>>,
    pub(super) validated_at: Instant,
}
pub(super) struct OwnershipProjectionCache {
    pub(super) local_id: String,
    pub(super) branch_name: String,
    pub(super) baseline_branch: Option<String>,
    pub(super) repo_path: String,
    pub(super) head_commit: String,
    pub(super) head_fingerprint: String,
    pub(super) paused: Arc<HashSet<String>>,
    pub(super) local_dirs: Arc<HashSet<String>>,
    pub(super) validated_at: Instant,
}
#[derive(Clone, Copy)]
pub(super) struct ProjectionEpoch {
    pub(super) global: u64,
    pub(super) local: u64,
}
#[derive(Default)]
pub(super) struct OwnershipValidationState {
    pub(super) pending: Mutex<HashSet<String>>,
    pub(super) notify: Notify,
}
pub(super) fn ownership_projection_cache_matches(
    entry: &OwnershipProjectionCache,
    binding: &AgentBinding,
) -> bool {
    entry.local_id == binding.local_id
        && entry.branch_name == binding.branch_name
        && entry.baseline_branch == binding.baseline_branch
        && entry.repo_path == binding.repo_path
}
impl TaskSync {
    pub(super) async fn ensure_ownership_index_loaded(&self) {
        self.ownership_index_loaded
            .get_or_init(|| async {
                let loaded = load_ownership_index(&self.store.paths.ownership_index_file)
                    .await
                    .unwrap_or_else(OwnershipIndex::empty);
                *self.ownership_index.lock().await = loaded;
            })
            .await;
    }
}
impl TaskSync {
    pub(super) async fn persist_ownership_index(&self) -> AgentResult<()> {
        if !self
            .ownership_index_writer
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        let index = self.ownership_index.lock().await.clone();
        if index.bindings.len() > OWNERSHIP_INDEX_MAX_BINDINGS
            || index.bindings.values().any(|binding| {
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
}
impl TaskSync {
    pub(super) async fn retain_ownership_index_bindings(&self, active_local_ids: &HashSet<String>) {
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
}
impl TaskSync {
    pub(super) async fn discard_ownership_index_binding(&self, local_id: &str) {
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
}
