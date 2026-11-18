mod discovery;
mod registry;
mod visibility;
mod watch;

pub(crate) use discovery::developer_id;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use notify::RecommendedWatcher;
use serde::Serialize;
use tokio::sync::{mpsc, Mutex as AsyncMutex};

use crate::agent::http::ApiClient;
use crate::agent::onboarding::{self, AttachOptions};
use crate::agent::protocol::{code, AgentError, AgentResult};
use crate::agent::state_events::StateSink;
use crate::agent::store::{AgentBinding, AgentConfig, ConfigStore};
use crate::agent::task_sync::TaskSync;

pub use registry::{WorktreeStatus, WorktreeVisibility};

use discovery::{DiscoveredWorktree, LocalTask};
use registry::{WorktreeEntry, WorktreeRegistry};

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(15);
const RETRY_BASE: i64 = 30;
const RETRY_MAX: i64 = 300;
const INITIAL_SYNC_TIMEOUT: Duration = Duration::from_secs(60);
const INITIAL_SYNC_PENDING_ERROR: &str = "首次同步尚未完成";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatusView {
    pub path: String,
    pub branch_name: String,
    pub task_space_id: Option<String>,
    pub auto_managed: bool,
    pub status: WorktreeStatus,
    pub visibility: WorktreeVisibility,
    pub archive_sync_pending: bool,
    pub active_task_count: usize,
    pub server_active_task_count: usize,
    pub last_error: Option<String>,
    pub last_visibility_error: Option<String>,
    pub last_visibility_at: Option<String>,
}

pub struct WorktreeService {
    store: Arc<ConfigStore>,
    api: Arc<ApiClient>,
    task_sync: Arc<TaskSync>,
    state_sink: StateSink,
    paused: Arc<AtomicBool>,
    registry: Mutex<WorktreeRegistry>,
    refresh_lock: AsyncMutex<()>,
    running: AtomicBool,
    watchers: Mutex<Vec<RecommendedWatcher>>,
    watch_signature: Mutex<String>,
    watch_tx: Mutex<Option<mpsc::UnboundedSender<()>>>,
}

impl WorktreeService {
    pub fn new(
        store: Arc<ConfigStore>,
        api: Arc<ApiClient>,
        task_sync: Arc<TaskSync>,
        state_sink: StateSink,
        paused: Arc<AtomicBool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            api,
            task_sync,
            state_sink,
            paused,
            registry: Mutex::new(WorktreeRegistry::default()),
            refresh_lock: AsyncMutex::new(()),
            running: AtomicBool::new(false),
            watchers: Mutex::new(Vec::new()),
            watch_signature: Mutex::new(String::new()),
            watch_tx: Mutex::new(None),
        })
    }

    pub async fn start(self: &Arc<Self>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(loaded) = registry::load(&self.store).await {
            let entries: Vec<WorktreeEntry> = loaded.entries.values().cloned().collect();
            *self.lock_registry() = loaded;
            for entry in entries {
                if entry.auto_managed && !entry.tracked_task_dirs.is_empty() {
                    if let Some(task_space_id) = entry.task_space_id.as_deref() {
                        self.task_sync
                            .set_tracked_task_dirs(task_space_id, entry.tracked_task_dirs.clone())
                            .await;
                    }
                }
            }
        }
        if let Ok(Some(config)) = self.store.read_config(false).await {
            self.sync_active_bindings(&config).await;
        }
        let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
        *self
            .watch_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(watch_tx);
        let mut watch_shutdown = shutdown.clone();
        let watcher_service = self.clone();
        crate::agent::rt::spawn(async move {
            loop {
                tokio::select! {
                    changed = watch_shutdown.changed() => {
                        if changed.is_err() || *watch_shutdown.borrow() {
                            break;
                        }
                    }
                    event = watch_rx.recv() => {
                        if event.is_none() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        while watch_rx.try_recv().is_ok() {}
                        if watcher_service.paused.load(Ordering::SeqCst) {
                            continue;
                        }
                        if let Err(error) = watcher_service.reconcile().await {
                            crate::logging::warn(&format!(
                                "worktree 变更触发接入失败: {}",
                                error.message
                            ));
                        }
                    }
                }
            }
        });
        let service = self.clone();
        crate::agent::rt::spawn(async move {
            let mut delay = Duration::from_secs(1);
            loop {
                if !service.running.load(Ordering::SeqCst) {
                    break;
                }
                if !service.paused.load(Ordering::SeqCst) {
                    if let Err(error) = service.reconcile().await {
                        crate::logging::warn(&format!("worktree 自动接入失败: {}", error.message));
                        delay = (delay * 2).min(Duration::from_secs(60));
                    } else {
                        delay = DISCOVERY_INTERVAL;
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    async fn sync_active_bindings(&self, config: &AgentConfig) {
        let bindings: Vec<AgentBinding> = {
            let registry = self.lock_registry();
            config
                .bindings
                .iter()
                .filter(|binding| {
                    !registry.entries.values().any(|entry| {
                        entry.visibility == WorktreeVisibility::HiddenMissing
                            && same_path(&entry.path, &binding.repo_path)
                    })
                })
                .cloned()
                .collect()
        };
        self.task_sync.update_bindings(bindings).await;
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.watchers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.watch_signature
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        *self
            .watch_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    pub async fn refresh(&self) -> AgentResult<Vec<WorktreeStatusView>> {
        self.reconcile().await?;
        Ok(self.list())
    }

    pub async fn retry(&self, key: &str) -> AgentResult<Vec<WorktreeStatusView>> {
        {
            let mut registry = self.lock_registry();
            let mut found = false;
            for entry in registry.entries.values_mut() {
                if entry.task_space_id.as_deref() == Some(key) || entry.path == key {
                    entry.next_retry_at = 0;
                    entry.last_error = None;
                    entry.last_visibility_error = None;
                    if entry.status == WorktreeStatus::Error {
                        entry.status = WorktreeStatus::Discovered;
                    }
                    found = true;
                }
            }
            if !found {
                return Err(AgentError::new(
                    code::COMMAND_INVALID,
                    "未找到对应的 worktree",
                ));
            }
        }
        self.reconcile().await?;
        Ok(self.list())
    }

    pub fn list(&self) -> Vec<WorktreeStatusView> {
        self.lock_registry()
            .entries
            .values()
            .map(|entry| WorktreeStatusView {
                path: entry.path.clone(),
                branch_name: entry.branch_name.clone(),
                task_space_id: entry.task_space_id.clone(),
                auto_managed: entry.auto_managed,
                status: entry.status,
                visibility: entry.visibility,
                archive_sync_pending: entry.archive_sync_pending,
                active_task_count: entry.active_task_count,
                server_active_task_count: entry.server_active_task_count,
                last_error: entry.last_error.clone(),
                last_visibility_error: entry.last_visibility_error.clone(),
                last_visibility_at: entry.last_visibility_at.clone(),
            })
            .collect()
    }

    async fn reconcile(&self) -> AgentResult<()> {
        if self.paused.load(Ordering::SeqCst) {
            return Ok(());
        }
        let _guard = self.refresh_lock.lock().await;
        let Some(config) = self.store.read_config(false).await? else {
            return Ok(());
        };
        let hooks = self.ephemeral_hooks().await?;
        let result = self.reconcile_inner(&config, &hooks).await;
        let _ = tokio::fs::remove_dir_all(&hooks).await;
        result
    }

    async fn reconcile_inner(&self, config: &AgentConfig, hooks: &Path) -> AgentResult<()> {
        let (discovered, all_success) = discovery::discover(&config.bindings, hooks).await;
        let mut found = HashSet::new();
        let mut changed = false;
        let mut bindings_dirty = false;
        for info in discovered {
            found.insert(info.path.clone());
            let mut entry = self.entry_for(&info);
            let now = Utc::now().timestamp();
            if entry.baseline_initialized && entry.visibility == WorktreeVisibility::HiddenMissing {
                reset_reappeared_entry(&mut entry);
                changed = true;
                bindings_dirty = true;
            }
            let approved = config.bindings.iter().find(|binding| {
                discovery::is_approved(binding) && same_path(&binding.repo_path, &info.path)
            });
            let initial_sync_completed = approved
                .map(|binding| binding.initial_sync_completed)
                .unwrap_or(false);
            if let Some(binding) = approved {
                let same_space =
                    entry.task_space_id.as_deref() == Some(binding.task_space_id.as_str());
                if entry.auto_managed && same_space {
                    entry.task_space_id = Some(binding.task_space_id.clone());
                } else {
                    entry.auto_managed = false;
                    entry.task_space_id = Some(binding.task_space_id.clone());
                    entry.visibility = WorktreeVisibility::Visible;
                    entry.status = WorktreeStatus::Attached;
                    entry.tracked_task_dirs.clear();
                    entry.pending_task_dirs.clear();
                    entry.archive_sync_pending = false;
                    entry.last_error = None;
                    changed = true;
                    changed |= self.upsert(entry);
                    continue;
                }
            }

            entry.path = info.path.clone();
            entry.branch_name = info.branch_name.clone();
            entry.common_dir = info.common_dir.clone();
            if !entry.baseline_initialized {
                entry.baseline_head = info.baseline_head.clone();
                entry.baseline_task_dirs = info.baseline_task_dirs.clone();
                entry.baseline_initialized = true;
                changed = true;
            }
            let tasks = discovery::scan_active_tasks(Path::new(&entry.path)).await;

            if entry.auto_managed {
                if entry.task_space_id.is_some() {
                    if initial_sync_completed {
                        if entry.last_error.as_deref() == Some(INITIAL_SYNC_PENDING_ERROR) {
                            entry.last_error = None;
                        }
                        self.sync_attached(&mut entry, &tasks, now).await;
                    } else {
                        if now >= entry.next_retry_at {
                            let task_space_id = entry.task_space_id.clone().unwrap_or_default();
                            entry.status = WorktreeStatus::Error;
                            entry.last_error = Some(INITIAL_SYNC_PENDING_ERROR.to_string());
                            entry.next_retry_at = now + retry_delay(entry.attempts.max(1));
                            self.task_sync.sync_task_spaces(vec![task_space_id]).await;
                        } else {
                            entry.status = WorktreeStatus::PendingUpload;
                        }
                    }
                } else if now >= entry.next_retry_at {
                    let candidates = discovery::candidate_task_dirs(
                        &tasks,
                        &entry.branch_name,
                        &entry.baseline_task_dirs,
                        &entry.tracked_task_dirs,
                    );
                    if !candidates.is_empty() {
                        self.attach(&mut entry, &info, candidates, config, hooks)
                            .await;
                    } else if entry.branch_name.is_empty() {
                        entry.status = WorktreeStatus::WaitingBranch;
                    } else if entry.status != WorktreeStatus::Error {
                        entry.status = WorktreeStatus::Discovered;
                        entry.visibility = WorktreeVisibility::Hidden;
                    }
                }
            } else if entry.branch_name.is_empty() {
                entry.status = WorktreeStatus::WaitingBranch;
                entry.visibility = WorktreeVisibility::Hidden;
            } else {
                let candidates = discovery::candidate_task_dirs(
                    &tasks,
                    &entry.branch_name,
                    &entry.baseline_task_dirs,
                    &entry.tracked_task_dirs,
                );
                if !candidates.is_empty() && now >= entry.next_retry_at {
                    self.attach(&mut entry, &info, candidates, config, hooks)
                        .await;
                } else if entry.status != WorktreeStatus::Error {
                    entry.status = WorktreeStatus::Discovered;
                    entry.visibility = WorktreeVisibility::Hidden;
                }
            }

            if entry.auto_managed {
                self.update_visibility(&mut entry, &tasks).await;
            }
            changed |= self.upsert(entry);
        }

        let snapshot = {
            let mut registry = self.lock_registry();
            for entry in registry.entries.values_mut() {
                if entry.auto_managed && !found.contains(&entry.path) {
                    let path_missing = !Path::new(&entry.path).exists();
                    if !all_success && !path_missing {
                        continue;
                    }
                    if entry.visibility != WorktreeVisibility::HiddenMissing {
                        changed = true;
                        bindings_dirty = true;
                    }
                    entry.status = WorktreeStatus::Stale;
                    entry.visibility = WorktreeVisibility::HiddenMissing;
                    entry.archive_sync_pending = false;
                    entry.active_task_count = 0;
                    entry.server_active_task_count = 0;
                    entry.last_error = None;
                }
            }
            if changed {
                Some(registry.clone())
            } else {
                None
            }
        };
        if let Some(snapshot) = snapshot {
            registry::save(&self.store, &snapshot).await?;
        }
        if bindings_dirty {
            self.sync_active_bindings(config).await;
        }
        if let Some(tx) = self
            .watch_tx
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
        {
            watch::rebuild(self, config, &tx);
        }
        if changed {
            (self.state_sink)();
        }
        Ok(())
    }

    async fn attach(
        &self,
        entry: &mut WorktreeEntry,
        info: &DiscoveredWorktree,
        candidates: Vec<String>,
        config: &AgentConfig,
        hooks: &Path,
    ) {
        let now = Utc::now().timestamp();
        let Some(source) = discovery::source_binding(config, &info.remote_identity_key) else {
            self.fail_attach(entry, "没有可用的团队/项目绑定", now);
            return;
        };
        let Some(team_id) = source.team_id.as_deref().or(config.team_id.as_deref()) else {
            self.fail_attach(entry, "绑定缺少团队信息", now);
            return;
        };
        let Some(developer_id) =
            discovery::developer_id(Path::new(&entry.path), config, &info.remote_identity_key)
                .await
        else {
            self.fail_attach(entry, "缺少 Trellis developer 身份", now);
            return;
        };
        entry.status = WorktreeStatus::Attaching;
        entry.last_error = None;
        let options = AttachOptions {
            repo_path: Path::new(&entry.path),
            hooks_dir: hooks,
            team_id,
            developer_id: &developer_id,
            expected_branch: Some(&entry.branch_name),
            display_name: None,
            allow_file_remote: config.allow_local_git_remotes,
            require_pushed: false,
            initial_sync_mode: Some("safe"),
        };
        let result = onboarding::attach_project(&self.api, &self.store, &options).await;
        let attached = match result {
            Ok(value) => value,
            Err(error) => {
                self.fail_attach(entry, &error.message, now);
                return;
            }
        };
        entry.task_space_id = Some(attached.binding.task_space_id.clone());
        entry.auto_managed = true;
        entry.status = WorktreeStatus::PendingUpload;
        entry.tracked_task_dirs.clear();
        entry.pending_task_dirs = candidates;
        entry.attempts = 0;
        entry.next_retry_at = 0;
        entry.last_error = None;

        let task_space_id = attached.binding.task_space_id.clone();
        let pending = entry.pending_task_dirs.clone();
        if self
            .store
            .update_config(false, move |config| {
                let Some(current) = config else {
                    return Err(AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"));
                };
                let mut config = current.clone();
                let Some(binding) = config
                    .bindings
                    .iter_mut()
                    .find(|binding| binding.task_space_id == task_space_id)
                else {
                    return Err(AgentError::new(
                        code::CONFIG_INVALID,
                        "接入后找不到本地绑定",
                    ));
                };
                binding.tracked_task_dirs = pending;
                Ok(Some(config))
            })
            .await
            .is_err()
        {
            entry.task_space_id = None;
            self.fail_attach(entry, "接入后无法保存本地绑定", now);
            return;
        }
        let Ok(Some(updated)) = self.store.read_config(false).await else {
            entry.task_space_id = None;
            self.fail_attach(entry, "接入后无法读取 Agent 配置", now);
            return;
        };
        self.task_sync.update_bindings(updated.bindings).await;
        if !self
            .wait_for_initial_sync(&attached.binding.task_space_id)
            .await
        {
            self.fail_attach(entry, INITIAL_SYNC_PENDING_ERROR, now);
            return;
        }
        let Ok(Some(latest)) = self.store.read_config(false).await else {
            self.fail_attach(entry, "首次同步后无法读取 Agent 配置", now);
            return;
        };
        self.task_sync.update_bindings(latest.bindings).await;
        let tasks = discovery::scan_active_tasks(Path::new(&entry.path)).await;
        retain_active_pending(entry, &tasks);
        if entry.pending_task_dirs.is_empty() {
            entry.status = WorktreeStatus::PendingUpload;
            return;
        }
        self.sync_pending(entry, Utc::now().timestamp()).await;
    }

    async fn sync_attached(&self, entry: &mut WorktreeEntry, tasks: &[LocalTask], now: i64) {
        let Some(_task_space_id) = entry.task_space_id.as_deref() else {
            return;
        };
        let candidates = discovery::candidate_task_dirs(
            tasks,
            &entry.branch_name,
            &entry.baseline_task_dirs,
            &entry.tracked_task_dirs,
        );
        for task_dir in candidates {
            if !entry.pending_task_dirs.contains(&task_dir) {
                entry.pending_task_dirs.push(task_dir);
            }
        }
        retain_active_pending(entry, tasks);
        if entry.pending_task_dirs.is_empty() {
            if entry.first_upload_completed {
                entry.status = WorktreeStatus::Attached;
                entry.last_error = None;
                entry.next_retry_at = 0;
            } else {
                entry.status = WorktreeStatus::PendingUpload;
            }
            return;
        }
        self.sync_pending(entry, now).await;
    }

    async fn sync_pending(&self, entry: &mut WorktreeEntry, now: i64) {
        if entry.pending_task_dirs.is_empty() || now < entry.next_retry_at {
            return;
        }
        let Some(task_space_id) = entry.task_space_id.as_deref() else {
            return;
        };
        let pending = entry.pending_task_dirs.clone();
        match self
            .task_sync
            .sync_task_directories(task_space_id, &pending, true)
            .await
        {
            Ok(value) if upload_succeeded(&value) => {
                for task_dir in pending {
                    if !entry.tracked_task_dirs.contains(&task_dir) {
                        entry.tracked_task_dirs.push(task_dir);
                    }
                }
                entry.pending_task_dirs.clear();
                entry.status = WorktreeStatus::Attached;
                entry.first_upload_completed = true;
                entry.attempts = 0;
                entry.next_retry_at = 0;
                entry.last_error = None;
                self.task_sync
                    .set_tracked_task_dirs(task_space_id, entry.tracked_task_dirs.clone())
                    .await;
            }
            Ok(value) => {
                let message = upload_error(&value);
                self.fail_upload(entry, &message, now);
            }
            Err(error) => self.fail_upload(entry, &error.message, now),
        }
    }

    async fn update_visibility(&self, entry: &mut WorktreeEntry, tasks: &[LocalTask]) {
        if !entry.auto_managed {
            return;
        }
        entry.last_visibility_at = Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        if !entry.first_upload_completed || entry.tracked_task_dirs.is_empty() {
            entry.visibility = WorktreeVisibility::Hidden;
            entry.archive_sync_pending = false;
            entry.active_task_count = 0;
            entry.server_active_task_count = 0;
            entry.last_visibility_error = None;
            return;
        }
        entry.active_task_count = local_active_count(tasks, &entry.branch_name);
        if entry.active_task_count > 0 {
            entry.visibility = WorktreeVisibility::Visible;
            entry.archive_sync_pending = false;
            entry.last_visibility_error = None;
            return;
        }
        let Some(task_space_id) = entry.task_space_id.as_deref() else {
            entry.visibility = WorktreeVisibility::Hidden;
            return;
        };
        match visibility::server_active_task_count(&self.api, task_space_id).await {
            Ok(count) => {
                entry.server_active_task_count = count;
                entry.last_visibility_error = None;
                let (visibility, pending) = resolved_visibility(entry.active_task_count, count);
                entry.visibility = visibility;
                entry.archive_sync_pending = pending;
            }
            Err(error) => {
                entry.last_visibility_error = Some(error.message);
            }
        }
    }

    fn fail_attach(&self, entry: &mut WorktreeEntry, message: &str, now: i64) {
        entry.status = WorktreeStatus::Error;
        entry.auto_managed = true;
        entry.last_error = Some(message.to_string());
        entry.attempts = entry.attempts.saturating_add(1);
        entry.next_retry_at = now + retry_delay(entry.attempts);
    }

    fn fail_upload(&self, entry: &mut WorktreeEntry, message: &str, now: i64) {
        entry.status = WorktreeStatus::Error;
        entry.last_error = Some(message.to_string());
        entry.attempts = entry.attempts.saturating_add(1);
        entry.next_retry_at = now + retry_delay(entry.attempts);
    }

    async fn wait_for_initial_sync(&self, task_space_id: &str) -> bool {
        let deadline = tokio::time::Instant::now() + INITIAL_SYNC_TIMEOUT;
        loop {
            if !self.running.load(Ordering::SeqCst) {
                return false;
            }
            let Ok(Some(config)) = self.store.read_config(false).await else {
                return false;
            };
            if config.bindings.iter().any(|binding| {
                binding.task_space_id == task_space_id && binding.initial_sync_completed
            }) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    async fn ephemeral_hooks(&self) -> AgentResult<PathBuf> {
        let path = self
            .store
            .paths
            .hooks_base_dir
            .join(format!("tmp-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&path).await.map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("无法创建临时 hooks 目录：{error}"),
            )
        })?;
        Ok(path)
    }

    fn entry_for(&self, info: &DiscoveredWorktree) -> WorktreeEntry {
        let registry = self.lock_registry();
        registry
            .entries
            .get(&info.path)
            .cloned()
            .unwrap_or_else(|| WorktreeEntry::new(info.path.clone(), info.branch_name.clone()))
    }

    fn upsert(&self, entry: WorktreeEntry) -> bool {
        let mut registry = self.lock_registry();
        match registry.entries.get(&entry.path) {
            Some(previous) if previous.signature() == entry.signature() => false,
            _ => {
                registry.entries.insert(entry.path.clone(), entry);
                true
            }
        }
    }

    fn lock_registry(&self) -> std::sync::MutexGuard<'_, WorktreeRegistry> {
        self.registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn retain_active_pending(entry: &mut WorktreeEntry, tasks: &[discovery::LocalTask]) {
    let active: HashSet<&str> = tasks
        .iter()
        .filter(|task| task.branch == entry.branch_name)
        .map(|task| task.task_dir.as_str())
        .collect();
    entry
        .pending_task_dirs
        .retain(|task_dir| active.contains(task_dir.as_str()));
}

fn local_active_count(tasks: &[discovery::LocalTask], branch: &str) -> usize {
    tasks.iter().filter(|task| task.branch == branch).count()
}

fn resolved_visibility(active: usize, server_active: usize) -> (WorktreeVisibility, bool) {
    if active > 0 {
        (WorktreeVisibility::Visible, false)
    } else if server_active > 0 {
        (WorktreeVisibility::Visible, true)
    } else {
        (WorktreeVisibility::HiddenEmpty, false)
    }
}

fn retry_delay(attempts: u32) -> i64 {
    (RETRY_BASE.saturating_mul(1_i64 << attempts.min(4))).min(RETRY_MAX)
}

fn reset_reappeared_entry(entry: &mut WorktreeEntry) {
    entry.baseline_initialized = false;
    entry.baseline_head = None;
    entry.baseline_task_dirs.clear();
    entry.tracked_task_dirs.clear();
    entry.pending_task_dirs.clear();
    entry.first_upload_completed = false;
    entry.archive_sync_pending = false;
    entry.last_error = None;
    entry.status = WorktreeStatus::Discovered;
    entry.visibility = WorktreeVisibility::Hidden;
    entry.attempts = 0;
    entry.next_retry_at = 0;
}

fn same_path(left: &str, right: &str) -> bool {
    normalize_path(left) == normalize_path(right)
}

fn normalize_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.strip_prefix("//?/").unwrap_or(&path);
    path.trim_end_matches('/').to_ascii_lowercase()
}

fn upload_succeeded(value: &serde_json::Value) -> bool {
    value.is_object()
        && value.get("code").is_none()
        && value.get("skipped") != Some(&serde_json::Value::Bool(true))
}

fn upload_error(value: &serde_json::Value) -> String {
    value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.get("code").and_then(serde_json::Value::as_str))
        .unwrap_or("任务上传失败")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_path_ignores_windows_extended_prefix_and_separators() {
        assert!(same_path(
            r"\\?\C:\Users\Fenglei\projects\trellis-board-wt-accept",
            "C:/Users/Fenglei/projects/trellis-board-wt-accept"
        ));
        assert!(same_path(
            r"C:\Users\Fenglei\projects\trellis-board-wt-accept\",
            r"c:\users\fenglei\projects\trellis-board-wt-accept"
        ));
        assert!(!same_path(
            r"C:\Users\Fenglei\projects\trellis-board",
            r"C:\Users\Fenglei\projects\trellis-board-wt-accept"
        ));
    }

    #[test]
    fn visibility_waits_for_server_purge_after_local_archive() {
        assert_eq!(
            resolved_visibility(0, 0),
            (WorktreeVisibility::HiddenEmpty, false)
        );
        assert_eq!(
            resolved_visibility(0, 1),
            (WorktreeVisibility::Visible, true)
        );
        assert_eq!(
            resolved_visibility(1, 0),
            (WorktreeVisibility::Visible, false)
        );
    }

    #[test]
    fn visibility_counts_inherited_tasks_on_the_same_branch() {
        let tasks = vec![
            discovery::LocalTask {
                task_dir: "tracked".into(),
                id: "tracked".into(),
                branch: "feature".into(),
            },
            discovery::LocalTask {
                task_dir: "inherited".into(),
                id: "inherited".into(),
                branch: "feature".into(),
            },
            discovery::LocalTask {
                task_dir: "other".into(),
                id: "other".into(),
                branch: "main".into(),
            },
        ];
        assert_eq!(local_active_count(&tasks, "feature"), 2);
        assert_eq!(local_active_count(&tasks, "main"), 1);
    }

    #[test]
    fn reappeared_worktree_resets_baseline_and_upload_gate() {
        let mut entry = WorktreeEntry::new("/tmp/feature".into(), "feature".into());
        entry.baseline_initialized = true;
        entry.baseline_task_dirs = vec![".trellis/tasks/old".into()];
        entry.tracked_task_dirs = vec![".trellis/tasks/old".into()];
        entry.pending_task_dirs = vec![".trellis/tasks/new".into()];
        entry.first_upload_completed = true;
        entry.visibility = WorktreeVisibility::HiddenMissing;

        reset_reappeared_entry(&mut entry);

        assert!(!entry.baseline_initialized);
        assert!(entry.baseline_task_dirs.is_empty());
        assert!(entry.tracked_task_dirs.is_empty());
        assert!(entry.pending_task_dirs.is_empty());
        assert!(!entry.first_upload_completed);
        assert_eq!(entry.status, WorktreeStatus::Discovered);
        assert_eq!(entry.visibility, WorktreeVisibility::Hidden);
    }

    #[test]
    fn pending_upload_drops_archived_and_other_branch_tasks() {
        let mut entry = WorktreeEntry::new("/tmp/feature".into(), "feature".into());
        entry.pending_task_dirs = vec![
            ".trellis/tasks/active".into(),
            ".trellis/tasks/archived".into(),
            ".trellis/tasks/other".into(),
        ];
        let tasks = vec![discovery::LocalTask {
            task_dir: ".trellis/tasks/active".into(),
            id: "active".into(),
            branch: "feature".into(),
        }];
        retain_active_pending(&mut entry, &tasks);
        assert_eq!(entry.pending_task_dirs, vec![".trellis/tasks/active"]);
    }
}
