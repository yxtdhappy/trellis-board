use super::*;

pub(super) fn approved_bindings(bindings: Vec<AgentBinding>) -> HashMap<String, AgentBinding> {
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
pub(super) fn binding_selection_unchanged(
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
pub(super) fn binding_entry_unchanged(existing: &AgentBinding, next: &AgentBinding) -> bool {
    existing.local_id == next.local_id
        && existing.repo_path == next.repo_path
        && existing.branch_name == next.branch_name
        && existing.baseline_branch == next.baseline_branch
        && existing.initial_sync_completed == next.initial_sync_completed
        && existing.read_only == next.read_only
}
pub(super) fn association_state_unchanged(existing: &AgentBinding, next: &AgentBinding) -> bool {
    let mut existing = existing.clone();
    let mut next = next.clone();
    existing.last_synced_at = None;
    next.last_synced_at = None;
    existing.last_head = None;
    next.last_head = None;
    existing == next
}
pub(super) fn association_map_unchanged(
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
impl TaskSync {
    pub(super) async fn task_space_sync_lock(&self, task_space_id: &str) -> Arc<Mutex<()>> {
        self.binding_sync_locks
            .lock()
            .await
            .entry(task_space_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}
impl TaskSync {
    pub(super) fn notify_state_changed(&self) {
        if let Some(sink) = &self.state_sink {
            sink();
        }
    }
}
impl TaskSync {
    pub(crate) fn notify_bindings_changed(&self) {
        self.notify_state_changed();
    }
}
impl TaskSync {
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
        self.ownership_projection_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.head_tree_cache.lock().await.clear();
        self.ownership_projection_cache.lock().await.clear();
        self.baseline_owned.lock().await.clear();
        self.binding_sync_locks
            .lock()
            .await
            .retain(|task_space_id, _| active_ids.contains(task_space_id));
    }
}
impl TaskSync {
    pub async fn update_bindings(self: &Arc<Self>, bindings: Vec<AgentBinding>) {
        let task_space_ids = self.prepare_bindings(bindings).await;
        self.sync_task_spaces(task_space_ids).await;
    }
}
impl TaskSync {
    pub(crate) async fn prepare_startup_bindings(
        self: &Arc<Self>,
        bindings: Vec<AgentBinding>,
    ) -> Vec<String> {
        self.prepare_bindings(bindings).await
    }
}
impl TaskSync {
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
}
impl TaskSync {
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
}
impl TaskSync {
    pub(super) async fn finish_binding_sync(self: &Arc<Self>, task_space_id: &str) {
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
}
impl TaskSync {
    pub(super) async fn prepare_bindings(
        self: &Arc<Self>,
        bindings: Vec<AgentBinding>,
    ) -> Vec<String> {
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
                    && (Path::new(&binding.repo_path).is_dir()
                        || binding.tracked_task_dirs.is_empty())
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
        self.ownership_projection_epoch
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
}
impl TaskSync {
    /// 同一本地仓库多绑定时按真实分支挑唯一可用的绑定（对照 JS `_selectBindingsForRepositories`）。
    pub(super) async fn select_bindings(&self, bindings: Vec<AgentBinding>) -> Vec<AgentBinding> {
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
                    self.forget_branch_guard_notice(&binding).await;
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
                    self.forget_branch_guard_notice(binding).await;
                    matches.push(binding.clone());
                } else {
                    match self.assert_binding_branch(binding).await {
                        Ok(_) => matches.push(binding.clone()),
                        Err(error) => self.report_binding_error(binding, &error),
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
}
impl TaskSync {
    /// 分支守卫的 notice 已在 `assert_binding_branch` 的进入边沿发出，这里只过滤模态事件；
    /// 其他错误保持原有 `task_sync_error` 行为。
    pub(super) fn report_binding_error(&self, binding: &AgentBinding, error: &AgentError) {
        if is_branch_guard_error(error) {
            return;
        }
        (self.emit)(task_sync_error_event(
            Some(binding),
            &binding.task_space_id,
            error,
            protocol::safe_error_message(&error.message),
        ));
    }
}
impl TaskSync {
    /// 校验 binding 仍处于 approved，并返回持久化的 `last_error_code`，
    /// 供分支守卫判断是否真的从正常状态进入暂停，而不是使用可能滞后的内存副本。
    pub(super) async fn assert_binding_active(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<Option<String>> {
        let config =
            self.store.read_config(false).await?.ok_or_else(|| {
                AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录")
            })?;
        let current = config
            .bindings
            .iter()
            .find(|item| item.local_id == binding.local_id)
            .filter(|item| item.sync_status == "approved" && !item.detach_pending);
        match current {
            Some(item) => Ok(item.last_error_code.clone()),
            None => protocol::err(code::BINDING_UNKNOWN, "本地任务空间关联已停用或正在解除"),
        }
    }
}
impl TaskSync {
    pub(super) async fn task_space_is_active(&self, task_space_id: &str) -> bool {
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
}
impl TaskSync {
    pub(super) fn binding_hooks_dir(&self, binding: &AgentBinding) -> PathBuf {
        self.store.paths.hooks_base_dir.join(&binding.local_id)
    }
}
impl TaskSync {
    pub(super) async fn persist_binding_sync_error(
        &self,
        binding: &AgentBinding,
        error: &AgentError,
    ) -> bool {
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
                self.notify_state_changed();
                true
            }
            Ok(_) => false,
            Err(error) => {
                crate::logging::warn(&format!(
                    "保存任务同步状态失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
                false
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn clear_branch_guard_error(&self, binding: &AgentBinding) {
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
}
impl TaskSync {
    /// 拉取、补收敛基线任务，并对失败写日志和 `task_sync_error` 控制事件。
    pub async fn pull_and_report(&self, task_space_id: &str) -> bool {
        let cursor_before = self.read_cursor(task_space_id).await;
        let revision_before = cursor_before.revision;
        // 离线失败留下的账本不能依赖服务端 revision 变化，启动时仍要对账一次。
        let ownership_retry = !cursor_before.ownership_pending.is_empty()
            || !cursor_before.pending_rejected.is_empty();
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
        revalidate
            || ownership_retry
            || self.read_cursor(task_space_id).await.revision != revision_before
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
}
impl TaskSync {
    pub(super) async fn report_error(&self, task_space_id: &str, error: &AgentError) {
        let binding = self.bindings.lock().await.get(task_space_id).cloned();
        let message = protocol::safe_error_message(&error.to_string());
        let task_dir = error
            .details
            .as_ref()
            .and_then(|details| details.get("taskDir"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let server_code = error
            .server_code
            .as_deref()
            .map(|code| format!(",\"serverCode\":\"{code}\""))
            .unwrap_or_default();
        crate::logging::warn(&format!(
            "任务空间同步失败 {{\"taskSpaceId\":\"{task_space_id}\",\"code\":\"{code}\",\"taskDir\":\"{task_dir}\"{server_code},\"error\":\"{message}\"}}",
            code = error.code
        ));
        if is_branch_guard_error(error) {
            // notice 已在 assert_binding_branch 的进入边沿发出，避免重复提示。
            return;
        }
        (self.emit)(task_sync_error_event(
            binding.as_ref(),
            task_space_id,
            error,
            message,
        ));
    }
}
impl TaskSync {
    pub(super) async fn binding(&self, task_space_id: &str) -> AgentResult<AgentBinding> {
        self.bindings
            .lock()
            .await
            .get(task_space_id)
            .cloned()
            .filter(|binding| !binding.detach_pending)
            .ok_or_else(|| AgentError::new(code::BINDING_UNKNOWN, "任务空间尚未关联到本地仓库"))
    }
}

impl TaskSync {
    pub async fn set_tracked_task_dirs(&self, task_space_id: &str, task_dirs: Vec<String>) {
        if let Some(binding) = self.bindings.lock().await.get_mut(task_space_id) {
            binding.tracked_task_dirs = task_dirs.clone();
        }
        let task_space_id = task_space_id.to_string();
        let _ = self
            .store
            .update_config(false, move |config| {
                let Some(config) = config else {
                    return Ok(None);
                };
                let mut next = config.clone();
                for binding in &mut next.bindings {
                    if binding.task_space_id == task_space_id {
                        binding.tracked_task_dirs = task_dirs.clone();
                    }
                }
                Ok(Some(next))
            })
            .await;
    }
}
impl TaskSync {
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
}
