use super::*;

pub(super) enum WatchEvent {
    TaskPath {
        task_space_id: String,
        relative_path: String,
    },
    GitChanged {
        task_space_id: String,
    },
}
#[derive(Default)]
pub(super) struct WatchState {
    pub(super) watchers: Vec<RecommendedWatcher>,
    pub(super) tx: Option<mpsc::UnboundedSender<WatchEvent>>,
}
impl TaskSync {
    /// 监听各绑定仓库的 `.trellis`，把本地改动按任务目录合并后上传。
    pub(super) async fn rebuild_watchers(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
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
                crate::agent::rt::spawn(async move { this.watch_loop(rx).await });
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
}
impl TaskSync {
    pub(super) async fn watch_loop(self: Arc<Self>, mut receiver: mpsc::UnboundedReceiver<WatchEvent>) {
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
                    Ok(Some(event)) => match event {
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
                    },
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
                let target_dirs: HashSet<String> = paths
                    .iter()
                    .filter_map(|path| active_task_directory_from_relative(path))
                    .collect();
                let target_count = target_dirs.len();
                // 首次同步未完成时 watcher 仍在监听，但上传必须等 bootstrap 拉取落地，
                // 否则会用本地旧内容抢在服务端快照之前写入（对照 JS `_uploadDirty` 的守卫）。
                let binding = self
                    .bindings
                    .lock()
                    .await
                    .get(&task_space_id)
                    .cloned()
                    .filter(|binding| {
                        !binding.read_only && binding.initial_sync_completed
                    });
                if let Some(binding) = binding {
                    let serial = self.task_space_sync_lock(&task_space_id).await;
                    let _serial = serial.lock().await;
                    if let Err(error) = self
                        .cleanup_missing_ownership_inbox(&binding, Some(&target_dirs))
                        .await
                    {
                        self.report_error(&task_space_id, &error).await;
                    }
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
}
/// 只关心任务目录：`upload_dirty` 对其它路径无能为力，少转发少唤醒。
pub(super) fn is_watched_trellis_path(relative: &str) -> bool {
    relative == "tasks"
        || (relative.starts_with("tasks/")
            && relative != "tasks/archive"
            && !relative.starts_with("tasks/archive/"))
}
pub(super) fn is_relevant_watch_event(event: &notify::Event) -> bool {
    !event.kind.is_access()
}
pub(super) async fn git_head_branch_name(repo_path: &Path) -> Option<Option<String>> {
    let git_dir = resolve_git_dir(repo_path).await?;
    let head = tokio::fs::read_to_string(git_dir.join("HEAD")).await.ok()?;
    Some(
        head.trim()
            .strip_prefix("ref: refs/heads/")
            .map(str::to_string),
    )
}
/// 只读取 HEAD 指向的引用；ownership 投影未变化时无需启动 Git 子进程。
pub(super) async fn git_head_fingerprint(repo_path: &Path) -> Option<String> {
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
pub(super) async fn git_index_fingerprint(repo_path: &Path) -> Option<String> {
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
pub(super) async fn git_watch_paths(repo_path: &Path) -> Vec<(PathBuf, RecursiveMode)> {
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
pub(super) async fn resolve_git_dir(repo_path: &Path) -> Option<PathBuf> {
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
