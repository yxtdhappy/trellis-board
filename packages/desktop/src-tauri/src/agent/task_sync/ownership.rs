use super::*;

impl TaskSync {
    /// 校验仓库当前分支与绑定分支一致；失败时把错误写入绑定状态并保留。
    pub(super) async fn assert_binding_branch(&self, binding: &AgentBinding) -> AgentResult<String> {
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
}
impl TaskSync {
    pub(super) async fn binding_head(&self, binding: &AgentBinding) -> AgentResult<(String, String)> {
        let branch = self.assert_binding_branch(binding).await?;
        let hooks_dir = self.binding_hooks_dir(binding);
        let head = crate::agent::git::head_commit(Path::new(&binding.repo_path), &hooks_dir, false)
            .await?
            .ok_or_else(|| AgentError::new(code::DETACHED_HEAD, "本地仓库没有可用 HEAD"))?;
        Ok((branch, head))
    }
}
impl TaskSync {
    pub(super) async fn head_tree_paths(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<(String, Arc<HashSet<String>>)> {
        let (branch, head) = self.binding_head(binding).await?;
        let tracked_paths = self
            .head_tree_paths_for_commit(binding, &branch, &head)
            .await?;
        Ok((head, tracked_paths))
    }
}
impl TaskSync {
    pub(super) async fn head_tree_paths_for_commit(
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
}
impl TaskSync {
    #[cfg(test)]
    pub(super) async fn projected_head_tree_paths(
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
}
impl TaskSync {
    pub(super) async fn invalidate_ownership_projection(&self, task_space_id: &str) {
        let mut cache = self.ownership_projection_cache.lock().await;
        let mut epochs = self.ownership_projection_local_epoch.lock().await;
        *epochs.entry(task_space_id.to_string()).or_default() += 1;
        cache.remove(task_space_id);
    }
}
impl TaskSync {
    pub(super) async fn projection_epoch(&self, task_space_id: &str) -> ProjectionEpoch {
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
}
impl TaskSync {
    pub(super) async fn projection_epoch_matches(
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
}
impl TaskSync {
    pub(super) async fn cache_ownership_projection(
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
}
impl TaskSync {
    pub(super) async fn task_worktree_dirty_dirs(
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
}
impl TaskSync {
    pub(super) async fn task_head_changed_dirs(
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
}
impl TaskSync {
    pub(super) async fn scan_ownership_index_files(
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
                Ok(_) => return protocol::err(code::INVALID_RESPONSE, "任务目录不允许符号链接"),
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
}
impl TaskSync {
    pub(super) async fn refresh_ownership_index_binding(
        &self,
        binding: &AgentBinding,
        projection_epoch: ProjectionEpoch,
    ) -> AgentResult<(Arc<HashSet<String>>, Arc<HashSet<String>>)> {
        self.refresh_ownership_index_binding_with_scan(binding, projection_epoch, false)
            .await
    }
}
impl TaskSync {
    pub(super) async fn refresh_ownership_index_binding_with_scan(
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
        let (head_commit, head_changed_dirs, previous_tracked_paths, previous_tracked_loaded) =
            if head_cache_matches {
                let entry = previous.as_ref().ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "ownership 索引状态无效")
                })?;
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
}
impl TaskSync {
    pub(super) async fn validate_ownership_binding(self: &Arc<Self>, task_space_id: &str) {
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
                if let Err(error) = self
                    .cleanup_missing_ownership_inbox(&binding, None)
                    .await
                {
                    crate::logging::warn(&format!(
                        "清理已删除待归属任务失败：{}",
                        protocol::safe_error_message(&error.message)
                    ));
                }
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
}
impl TaskSync {
    pub(super) async fn enqueue_ownership_validation(&self, task_space_id: &str) {
        self.ownership_validation_state
            .pending
            .lock()
            .await
            .insert(task_space_id.to_string());
        self.ownership_validation_state.notify.notify_one();
    }
}
impl TaskSync {
    pub(crate) fn ensure_ownership_validation_worker(self: &Arc<Self>) {
        if self
            .ownership_validation_started
            .swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let this = Arc::downgrade(self);
        let state = self.ownership_validation_state.clone();
        crate::agent::rt::spawn(async move {
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
}
impl TaskSync {
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
}
impl TaskSync {
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
}
impl TaskSync {
    pub(super) fn baseline_owned_key(task_space_id: &str, task_id: &str) -> String {
        format!("{task_space_id}\0{task_id}")
    }
}
impl TaskSync {
    pub(super) async fn baseline_owned(&self, task_space_id: &str, task_id: &str) -> bool {
        self.baseline_owned
            .lock()
            .await
            .contains(&Self::baseline_owned_key(task_space_id, task_id))
    }
}
impl TaskSync {
    pub(super) async fn mark_baseline_owned(&self, task_space_id: &str, task_id: &str) {
        self.baseline_owned
            .lock()
            .await
            .insert(Self::baseline_owned_key(task_space_id, task_id));
    }
}
