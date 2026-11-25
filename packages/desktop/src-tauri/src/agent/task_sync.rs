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
    StoredTaskLease, TaskControl, TaskControlState, TaskControlStateFile, UploadFence,
};

mod bindings;
mod conflict;
mod control;
mod cursor;
mod errors;
mod handoff;
mod initial_sync;
mod local_files;
mod ownership;
mod ownership_filter;
mod ownership_inbox;
mod ownership_index;
mod paths;
mod pull;
mod snapshot;
mod sync_api;
mod upload;
mod watch;

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
    branch_guard_notified: Mutex<HashSet<String>>,
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
    watch: std::sync::Mutex<WatchState>,
    watch_shutdown: tokio::sync::watch::Sender<bool>,
}

impl TaskSync {
    pub fn new(store: Arc<ConfigStore>, api: Arc<ApiClient>, emit: ControlSink) -> Self {
        let (watch_shutdown, _) = tokio::sync::watch::channel(false);
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
            branch_guard_notified: Mutex::new(HashSet::new()),
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
            watch: std::sync::Mutex::new(WatchState::default()),
            watch_shutdown,
        }
    }
    pub fn stop(&self) {
        let _ = self.watch_shutdown.send(true);
        if let Ok(mut state) = self.watch.lock() {
            state.watchers.clear();
            state.tx = None;
        }
        self.ownership_validation_state.notify.notify_one();
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
}

impl Drop for TaskSync {
    fn drop(&mut self) {
        self.stop();
    }
}

// 拆分后的重导出：保持 `crate::agent::task_sync::<符号>` 引用路径与可见性不变。
// `allow(unused_imports)`：同一批重导出被不同编译目标（bin / test）分别使用，单目标分析会误报未使用。
#[allow(unused_imports)]
use bindings::{
    approved_bindings, association_map_unchanged, association_state_unchanged,
    binding_entry_unchanged, binding_selection_unchanged,
};
#[allow(unused_imports)]
use conflict::{
    conflict_is_archive_only, conflict_summary, conflict_task_directories, ConflictDirectories,
};
#[allow(unused_imports)]
use cursor::{
    apply_cursor_patch, baselines_by_task_dir, baselines_from_snapshot, baselines_to_value,
    clear_deferred_for_files, conflict_blocked_to_value, cursor_entry_needs_archive_migration,
    cursor_from_entry, deferred_to_value, file_state_from_group, local_sync_state_from_groups,
    merge_baselines, migrate_archive_pending_batch, next_client_sequence, normalize_baselines,
    ownership_pending_to_value, parse_baselines, parse_conflict_blocked, parse_deferred,
    parse_ownership_pending, parse_pending_batch, parse_pending_rejected, parse_readonly_task_dirs,
    pending_rejected_to_value, readonly_reason, readonly_reason_assignee,
    readonly_task_dirs_to_value, trim_pending_rejections, CursorPatch,
};
#[allow(unused_imports)]
pub use cursor::{Cursor, PendingBatch, PendingRejection};
#[allow(unused_imports)]
pub(crate) use errors::is_branch_guard_code;
#[allow(unused_imports)]
use errors::{
    io_error, is_archived_task_error, is_branch_guard_error, is_explicit_pending_rejection,
    is_foreign_task_error, is_paused_state_code, required_client_sequence,
    skipped_for_explicit_pending_rejection, sync_trace, task_sync_error_event,
    task_sync_notice_event, with_task_dir,
};
#[allow(unused_imports)]
use handoff::{
    cleanup_handoff_backup_temps, git_entries_all_untracked, handoff_ack_request, handoff_manifest,
    handoff_manifest_files_match, handoff_notice, is_handoff_metadata_temp, previous_values_paths,
    safe_handoff_relative_path, HandoffSource, HandoffSourceState,
};
#[allow(unused_imports)]
pub(crate) use initial_sync::retain_server_groups_for_branch_initial_sync;
#[allow(unused_imports)]
use initial_sync::{
    allows_cross_source_server_group, binding_is_baseline, hide_control_tombstone_local_only,
    inactive_control_dirs, initial_sync_mode, retain_server_groups_for_binding,
    retain_server_groups_for_initial_sync, retain_server_groups_for_revision_guard,
    should_pull_for_event, snapshot_revision,
};
#[allow(unused_imports)]
pub use local_files::read_local_task_snapshot_files;
#[allow(unused_imports)]
pub(crate) use local_files::urlencode;
#[allow(unused_imports)]
use local_files::{
    archived_task_copies, copy_directory, resolve_task_directory, task_directory_digest,
    task_directory_file_paths, write_task_directory,
};
#[allow(unused_imports)]
pub(crate) use ownership_filter::group_owned_by_developer;
#[allow(unused_imports)]
use ownership_inbox::{
    ownership_ledger_task_dirs, OwnershipDecision, OwnershipResolution, OwnershipReview,
};
#[allow(unused_imports)]
use ownership_index::{
    indexed_local_groups, normalize_index, ownership_projection_cache_matches, HeadTreeCache,
    OwnershipProjectionCache, OwnershipValidationState, ProjectionEpoch,
};
#[allow(unused_imports)]
pub(crate) use ownership_index::{
    indexed_ownership_projection, load_ownership_index, ownership_tasks_root_is_safe,
    OwnershipFileIndex, OwnershipIndex, OwnershipIndexBinding, OwnershipTaskIndex,
};
#[allow(unused_imports)]
use paths::{
    absolute_task_path, active_task_directory_from_relative, is_archive_month,
    is_archive_snapshot_path, normalize_cached_dirs, task_directory_error,
    valid_cached_snapshot_path, valid_cached_task_dir,
};
#[allow(unused_imports)]
pub(crate) use paths::{active_task_directory_from_path, is_archive_task_dir};
#[allow(unused_imports)]
pub use paths::{
    normalize_snapshot_path, task_directory_from_path, task_directory_from_relative, TaskPathParts,
};
#[allow(unused_imports)]
use snapshot::{
    build_directory_files, file_map, groups_from_structs, is_handoff_backup_id, is_sha256,
    move_pairs, parse_snapshot_controls, parse_snapshot_files, parse_snapshot_files_from_values,
    parse_task_id, parse_task_metadata, parse_task_title, same_files, sha256_bytes,
    task_fingerprint, task_owner, uploads_to_snapshot_files, validate_upload_batch, DirectoryEntry,
    UploadMode,
};
#[allow(unused_imports)]
pub use snapshot::{
    classify_task_snapshots, group_task_snapshot_files, normalize_snapshot_text, snapshot_sha256,
    validate_snapshot_file, ControlSink, DiffKind, Difference, SnapshotFile, SnapshotGroup,
    UploadFile,
};
#[allow(unused_imports)]
pub(crate) use snapshot::{parse_directory_files, task_title};
#[allow(unused_imports)]
use upload::{
    build_upload_request, execution_task_keys_from_upload, pending_task_dirs,
    response_control_execution_task_key, UploadFenceOutcome,
};
#[allow(unused_imports)]
use watch::{
    git_head_branch_name, git_head_fingerprint, git_index_fingerprint, git_watch_paths,
    is_relevant_watch_event, is_watched_trellis_path, resolve_git_dir, WatchEvent, WatchState,
};

#[cfg(test)]
mod tests;
