use super::*;

impl TaskSync {
    /// 服务端已归档的任务若本地还留着活跃副本，按内容一致性清理。
    pub(super) async fn cleanup_archived_controls(
        &self,
        binding: &AgentBinding,
        controls: &[TaskControl],
    ) {
        for control in controls {
            if control.control_state() == TaskControlState::Archived {
                self.cleanup_archived_residue(binding, &control.relative_dir)
                    .await;
            }
        }
    }
}
impl TaskSync {
    /// 清理不再成立的只读标记：本地目录消失，或任务分配人变化（可能已改派给本机用户）。
    pub(super) async fn prune_readonly_dirs(
        &self,
        binding: &AgentBinding,
        controls: Option<&[TaskControl]>,
    ) -> AgentResult<()> {
        let cursor = self.read_cursor(&binding.task_space_id).await;
        if cursor.readonly_task_dirs.is_empty() {
            return Ok(());
        }
        let by_dir: HashMap<&str, &TaskControl> = controls
            .unwrap_or_default()
            .iter()
            .map(|control| (control.relative_dir.as_str(), control))
            .collect();
        let mut dirs = cursor.readonly_task_dirs.clone();
        let before = dirs.len();
        for (task_dir, reason) in &cursor.readonly_task_dirs {
            let reassigned = by_dir.get(task_dir.as_str()).is_some_and(|control| {
                control.is_writable_local()
                    && control.assignee_user_id.as_deref() != readonly_reason_assignee(reason)
            });
            if reassigned {
                dirs.remove(task_dir);
                continue;
            }
            match resolve_task_directory(binding, task_dir).await {
                Ok(path) if tokio::fs::metadata(&path).await.is_ok() => {}
                _ => {
                    dirs.remove(task_dir);
                }
            }
        }
        if dirs.len() == before {
            return Ok(());
        }
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                readonly_task_dirs: Some(dirs),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    /// 本地是否仍存在该活跃任务目录；用于区分“归档移出后的残留基线”和“仍有本地内容的目录”。
    pub(super) async fn active_task_directory_exists(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> bool {
        match resolve_task_directory(binding, task_dir).await {
            Ok(path) => tokio::fs::metadata(&path).await.is_ok(),
            Err(_) => false,
        }
    }
}
impl TaskSync {
    /// 处理 state=archived 控件时清理本地残留活跃副本：只有归档副本存在且内容一致才删除。
    pub(super) async fn cleanup_archived_residue(&self, binding: &AgentBinding, task_dir: &str) {
        let Some(name) = task_dir.rsplit('/').next().filter(|name| !name.is_empty()) else {
            return;
        };
        let Some(active) =
            active_task_directory_from_relative(&format!("{ACTIVE_TASKS_ROOT}/{name}/task.json"))
        else {
            return;
        };
        let tasks_root = Path::new(&binding.repo_path).join(ACTIVE_TASKS_ROOT);
        let Some(active_path) = protocol::resolve_task_dir_under(&tasks_root, &active) else {
            return;
        };
        if tokio::fs::metadata(&active_path).await.is_err() {
            return;
        }
        let copies = archived_task_copies(binding).await;
        let Some(archive_dir) = copies.get(name) else {
            crate::logging::warn(&format!(
                "本地残留已归档任务副本 {active}：未找到归档副本，已跳过清理"
            ));
            return;
        };
        let Some(archive_path) = protocol::resolve_task_dir_under(&tasks_root, archive_dir) else {
            return;
        };
        let identical = match (
            task_directory_digest(&active_path).await,
            task_directory_digest(&archive_path).await,
        ) {
            (Ok(active_digest), Ok(archive_digest)) => {
                !active_digest.is_empty() && active_digest == archive_digest
            }
            _ => false,
        };
        if !identical {
            crate::logging::warn(&format!(
                "本地残留已归档任务副本 {active}：存在未同步改动，已跳过清理"
            ));
            return;
        }
        match self.remove_task_directory(binding, &active).await {
            Ok(()) => crate::logging::warn(&format!("清理残留活跃副本 {active}")),
            Err(error) => crate::logging::warn(&format!(
                "清理残留活跃副本 {active} 失败：{}",
                protocol::safe_error_message(&error.message)
            )),
        }
    }
}
impl TaskSync {
    /// 下载服务端任务为本地只读副本，避免交叉任务空间无法同步。
    pub(crate) async fn download_task(
        &self,
        task_space_id: &str,
        task_id: &str,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let tasks = self
            .api
            .request_json(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/tasks"),
                None,
                Duration::from_secs(60),
            )
            .await?;
        let task = tasks
            .get("tasks")
            .and_then(Value::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("taskId").and_then(Value::as_str) == Some(task_id))
            })
            .cloned()
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "服务端不存在该任务，可能已归档")
            })?;
        let task_dir = task
            .get("taskDir")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
            != Some(task_dir.as_str())
        {
            return protocol::err(code::INVALID_RESPONSE, "任务目录无效或已由服务端 Git 归档");
        }
        let target = resolve_task_directory(&binding, &task_dir).await?;
        if tokio::fs::metadata(&target).await.is_ok() {
            return protocol::err(
                code::INVALID_RESPONSE,
                "本机已存在该任务目录，请先处理本地副本",
            );
        }
        let directory = self
            .api
            .request_json_limited(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/tasks/{task_id}/files"),
                None,
                Duration::from_secs(120),
                MAX_SNAPSHOT_RESPONSE_BYTES,
            )
            .await
            .map_err(|error| with_task_dir(error, &task_dir))?;
        let files = parse_directory_files(&directory, &task_dir)?;
        if files.is_empty() {
            return protocol::err(code::INVALID_RESPONSE, "服务端任务文件为空");
        }
        let file_count = files.len();
        let assignee = self.control_assignee(task_space_id, &task_dir).await;
        let previous_cursor = self.read_cursor(task_space_id).await;
        let previous_readonly = previous_cursor.readonly_task_dirs.get(&task_dir).cloned();
        let previous_deferred = previous_cursor.deferred.get(&task_dir).cloned();
        self.mark_readonly_dir(
            task_space_id,
            &task_dir,
            &readonly_reason("DOWNLOADED", &assignee),
        )
        .await?;
        self.mark_files_suppressed(&binding, &files).await;
        if let Err(error) = write_task_directory(
            &binding,
            &SnapshotGroup {
                task_dir: task_dir.clone(),
                archived: false,
                archive_month: None,
                files: files.clone(),
                task_id: Some(task_id.to_string()),
                task_branch: None,
            },
        )
        .await
        {
            self.rollback_download_guards(
                &binding,
                &task_dir,
                &files,
                previous_readonly.as_deref(),
                previous_deferred.as_ref(),
            )
            .await;
            return Err(error);
        }
        Ok(json!({
            "taskId": task_id,
            "taskDir": task_dir,
            "fileCount": file_count,
        }))
    }

    async fn rollback_download_guards(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
        files: &[SnapshotFile],
        previous_readonly: Option<&str>,
        previous_deferred: Option<&BTreeMap<String, String>>,
    ) {
        {
            let mut suppressed = self.suppressed.lock().await;
            for file in files {
                suppressed.remove(&absolute_task_path(binding, &file.path));
            }
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let mut dirs = cursor.readonly_task_dirs.clone();
        match previous_readonly {
            Some(reason) => {
                dirs.insert(task_dir.to_string(), reason.to_string());
            }
            None => {
                dirs.remove(task_dir);
            }
        }
        let mut deferred = cursor.deferred.clone();
        if let Some(prev) = previous_deferred {
            deferred.insert(task_dir.to_string(), prev.clone());
        }
        let _ = self
            .write_cursor(
                &binding.task_space_id,
                CursorPatch {
                    readonly_task_dirs: Some(dirs),
                    deferred: previous_deferred.map(|_| deferred),
                    ..Default::default()
                },
            )
            .await;
    }
}
impl TaskSync {
    /// 改派命令的本地物化：目标目录不存在时，从服务端快照原子写入完整任务目录。
    /// 返回写入的服务端文件集合，供命令层复用 task.json 摘要和基线。
    pub(crate) async fn materialize_task_directory(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<Vec<SnapshotFile>> {
        let target = resolve_task_directory(binding, task_dir).await?;
        if tokio::fs::metadata(&target).await.is_ok() {
            return protocol::err(code::INVALID_RESPONSE, "本地任务目录已存在，不能重复物化");
        }
        let directory = self
            .fetch_directory(&binding.task_space_id, task_dir)
            .await?;
        let files = parse_directory_files(&directory, task_dir)?;
        if files.is_empty() {
            return protocol::err(code::INVALID_RESPONSE, "服务端任务文件为空");
        }
        if files.iter().any(|file| file.archived) {
            return protocol::err(code::INVALID_RESPONSE, "归档任务不能物化为本地工作副本");
        }
        let task_json = files
            .iter()
            .find(|file| file.file_path == "task.json")
            .ok_or_else(|| {
                AgentError::new(code::INVALID_RESPONSE, "服务端缺少目标任务的 task.json")
            })?;
        let task_id = parse_task_id(&task_json.content).ok_or_else(|| {
            AgentError::new(code::INVALID_RESPONSE, "服务端 task.json 缺少任务 id")
        })?;
        let task_branch = parse_task_metadata(&task_json.content).1;
        write_task_directory(
            binding,
            &SnapshotGroup {
                task_dir: task_dir.to_string(),
                archived: false,
                archive_month: None,
                files: files.clone(),
                task_id: Some(task_id),
                task_branch,
            },
        )
        .await?;
        Ok(files)
    }
}
pub(super) async fn resolve_task_directory(
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
                return Err(task_directory_error(
                    task_dir,
                    "任务目录路径不能经过符号链接",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(target)
}
/// 扫描 `.trellis/tasks/archive/<month>/<name>`，返回任务名到归档目录的映射。
pub(super) async fn archived_task_copies(binding: &AgentBinding) -> BTreeMap<String, String> {
    let root = Path::new(&binding.repo_path).join(ARCHIVE_TASKS_ROOT);
    let mut copies = BTreeMap::new();
    let mut months = match tokio::fs::read_dir(&root).await {
        Ok(months) => months,
        Err(_) => return copies,
    };
    let mut month_dirs: Vec<(String, PathBuf)> = Vec::new();
    while let Ok(Some(entry)) = months.next_entry().await {
        if !entry
            .file_type()
            .await
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        month_dirs.push((
            entry.file_name().to_string_lossy().to_string(),
            entry.path(),
        ));
    }
    for (month, path) in month_dirs {
        let mut entries = match tokio::fs::read_dir(&path).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            if !entry
                .file_type()
                .await
                .map(|kind| kind.is_dir())
                .unwrap_or(false)
            {
                continue;
            }
            copies.insert(
                entry.file_name().to_string_lossy().to_string(),
                format!(
                    "{ARCHIVE_TASKS_ROOT}/{month}/{}",
                    entry.file_name().to_string_lossy()
                ),
            );
        }
    }
    copies
}
/// 目录内快照文件的内容摘要，用于比较活跃副本与归档副本是否一致。
pub(super) async fn task_directory_digest(root: &Path) -> AgentResult<BTreeMap<String, String>> {
    let mut digest = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(BTreeMap::new())
            }
            Err(error) => return Err(io_error(error)),
        };
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
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if !SNAPSHOT_EXTENSIONS.iter().any(|ext| name.ends_with(ext)) {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = tokio::fs::read(&path).await.map_err(io_error)?;
            let text = String::from_utf8(bytes).map_err(|_| {
                AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本")
            })?;
            digest.insert(relative, snapshot_sha256(&normalize_snapshot_text(&text)));
        }
    }
    Ok(digest)
}
pub(super) async fn write_task_directory(
    binding: &AgentBinding,
    group: &SnapshotGroup,
) -> AgentResult<()> {
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
pub(super) async fn copy_directory(source: &Path, target: &Path) -> AgentResult<()> {
    let source_metadata = tokio::fs::symlink_metadata(source)
        .await
        .map_err(io_error)?;
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
                    tokio::fs::create_dir(&destination)
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
pub(super) async fn task_directory_file_paths(source: &Path) -> AgentResult<BTreeSet<String>> {
    let metadata = tokio::fs::symlink_metadata(source)
        .await
        .map_err(io_error)?;
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
                return protocol::err(code::MISSING_TRELLIS, format!("{label} 必须是真实目录"))
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
            Err(error) if task_dirs.is_some() && error.kind() == std::io::ErrorKind::NotFound => {
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
                AgentError::new(
                    code::INVALID_RESPONSE,
                    format!("任务文件不是有效的 UTF-8 文本：{relative}"),
                )
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
