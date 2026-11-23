use super::*;

pub(super) fn baselines_from_snapshot(files: &[SnapshotFile]) -> BTreeMap<String, String> {
    files
        .iter()
        .filter(|file| !file.deleted && !file.archived && is_sha256(&file.sha256))
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}
pub(super) fn merge_baselines(
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
pub(super) fn normalize_baselines(value: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    value
        .iter()
        .filter(|(path_name, sha256)| {
            is_sha256(sha256)
                && normalize_snapshot_path(path_name).is_ok()
                && active_task_directory_from_path(path_name).is_some()
        })
        .map(|(path_name, sha256)| (path_name.clone(), sha256.clone()))
        .collect()
}
pub(super) fn file_state_from_group(group: &SnapshotGroup) -> BTreeMap<String, String> {
    group
        .files
        .iter()
        .filter(|file| !file.deleted && !file.archived)
        .map(|file| (file.path.clone(), file.sha256.clone()))
        .collect()
}
pub(super) fn baselines_by_task_dir(
    baselines: &BTreeMap<String, String>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut grouped = BTreeMap::new();
    for (path_name, sha256) in normalize_baselines(baselines) {
        if let Some(task_dir) = active_task_directory_from_relative(&path_name) {
            grouped
                .entry(task_dir)
                .or_insert_with(BTreeMap::new)
                .insert(path_name, sha256);
        }
    }
    grouped
}
pub(super) type LocalSyncState = (
    Vec<String>,
    BTreeMap<String, BTreeMap<String, String>>,
    HashSet<String>,
);

pub(super) fn local_sync_state_from_groups(
    cursor: &Cursor,
    local_groups: &[SnapshotGroup],
    server_baselines: &BTreeMap<String, String>,
) -> LocalSyncState {
    let by_dir: HashMap<&str, &SnapshotGroup> = local_groups
        .iter()
        .map(|group| (group.task_dir.as_str(), group))
        .collect();
    let mut next_deferred = cursor.deferred.clone();
    let mut task_dirs: HashSet<String> = by_dir
        .keys()
        .map(|task_dir| (*task_dir).to_string())
        .collect();
    let cursor_baselines = baselines_by_task_dir(&cursor.baselines);
    let server_baselines = baselines_by_task_dir(server_baselines);
    task_dirs.extend(cursor.deferred.keys().cloned());
    task_dirs.extend(cursor_baselines.keys().cloned());
    task_dirs.extend(server_baselines.keys().cloned());
    let mut dirty = Vec::new();
    let mut reconciled_deferred = HashSet::new();
    for task_dir in task_dirs {
        let local_state = by_dir
            .get(task_dir.as_str())
            .map(|group| file_state_from_group(group))
            .unwrap_or_default();
        // cursor 基线只判 dirty；只有合并服务端基线完全一致时才记录为精确收敛。
        if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
            if local_state.is_empty() {
                continue;
            }
            if deferred_state == &local_state {
                if server_baselines
                    .get(task_dir.as_str())
                    .is_some_and(|baseline| baseline == &local_state)
                {
                    next_deferred.remove(&task_dir);
                    reconciled_deferred.insert(task_dir.clone());
                }
                continue;
            }
            next_deferred.remove(&task_dir);
        }
        let cursor_matches = cursor_baselines
            .get(task_dir.as_str())
            .map_or(local_state.is_empty(), |baseline| baseline == &local_state);
        if !cursor_matches {
            dirty.push(task_dir);
        }
    }
    (dirty, next_deferred, reconciled_deferred)
}
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Cursor {
    pub revision: u64,
    pub revision_guard_version: u64,
    pub sequence: u64,
    pub baseline_reconciled_head: String,
    pub pending: Option<PendingBatch>,
    pub pending_rejected: BTreeMap<String, PendingRejection>,
    pub baselines: BTreeMap<String, String>,
    pub deferred: BTreeMap<String, BTreeMap<String, String>>,
    pub ownership_pending: BTreeMap<String, String>,
    pub conflict_blocked: BTreeMap<String, String>,
    /// 只读镜像目录（他人任务/本机下载副本），值为 FOREIGN_OWNER 或 DOWNLOADED。
    pub readonly_task_dirs: BTreeMap<String, String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingBatch {
    pub batch_id: String,
    pub client_sequence: u64,
    pub files: Vec<Value>,
    pub merge_evidence: Option<Value>,
    pub created_at: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRejection {
    pub batch_id: String,
    pub client_sequence: u64,
    pub reason: String,
    pub created_at: String,
    pub blocked_at: String,
}
pub(super) fn cursor_from_entry(entry: &Value) -> Cursor {
    let mut cursor = Cursor {
        revision: entry.get("revision").and_then(Value::as_u64).unwrap_or(0),
        revision_guard_version: entry
            .get("revisionGuardVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        sequence: entry.get("sequence").and_then(Value::as_u64).unwrap_or(0),
        baseline_reconciled_head: entry
            .get("baselineReconciledHead")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        pending: entry.get("pending").and_then(parse_pending_batch),
        pending_rejected: entry
            .get("pendingRejected")
            .map(parse_pending_rejected)
            .unwrap_or_default(),
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
        readonly_task_dirs: entry
            .get("readonlyTaskDirs")
            .map(parse_readonly_task_dirs)
            .unwrap_or_default(),
    };
    cursor.baselines = normalize_baselines(&cursor.baselines);
    cursor.deferred.retain(|task_dir, files| {
        !is_archive_task_dir(task_dir)
            && files
                .keys()
                .all(|path| active_task_directory_from_path(path).is_some())
    });
    cursor
        .ownership_pending
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    cursor
        .conflict_blocked
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    cursor
        .readonly_task_dirs
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    cursor
        .pending_rejected
        .retain(|task_dir, _| !is_archive_task_dir(task_dir));
    trim_pending_rejections(&mut cursor.pending_rejected);
    cursor.pending = cursor
        .pending
        .and_then(|batch| migrate_archive_pending_batch(batch, cursor.sequence));
    cursor
}
pub(super) fn migrate_archive_pending_batch(
    batch: PendingBatch,
    cursor_sequence: u64,
) -> Option<PendingBatch> {
    let mut kept = Vec::with_capacity(batch.files.len());
    let mut changed = false;
    for file in &batch.files {
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            kept.push(file.clone());
            continue;
        };
        if is_archive_snapshot_path(path) {
            changed = true;
            continue;
        }
        kept.push(file.clone());
    }
    if kept.is_empty() {
        return None;
    }
    if !changed {
        return Some(batch);
    }
    pub(super) const SUFFIX: &str = ".archive-filtered.v1";
    let prefix_len = 127usize.saturating_sub(SUFFIX.len());
    let prefix: String = batch.batch_id.chars().take(prefix_len).collect();
    Some(PendingBatch {
        batch_id: format!("{prefix}{SUFFIX}"),
        client_sequence: next_client_sequence(cursor_sequence),
        files: kept,
        merge_evidence: None,
        created_at: batch.created_at,
    })
}
pub(super) fn cursor_entry_needs_archive_migration(entry: &Value) -> bool {
    entry
        .get("pending")
        .and_then(|pending| pending.get("files"))
        .and_then(Value::as_array)
        .is_some_and(|files| {
            files.iter().any(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(is_archive_snapshot_path)
            })
        })
        || entry
            .get("baselines")
            .and_then(Value::as_object)
            .is_some_and(|values| values.keys().any(|path| is_archive_snapshot_path(path)))
        || entry
            .get("deferred")
            .and_then(Value::as_object)
            .is_some_and(|values| {
                values.iter().any(|(task_dir, files)| {
                    is_archive_task_dir(task_dir)
                        || files.as_object().is_some_and(|values| {
                            values.keys().any(|path| is_archive_snapshot_path(path))
                        })
                })
            })
        || ["ownershipPending", "conflictBlocked", "pendingRejected"]
            .iter()
            .any(|field| {
                entry
                    .get(*field)
                    .and_then(Value::as_object)
                    .is_some_and(|values| {
                        values.keys().any(|task_dir| is_archive_task_dir(task_dir))
                    })
            })
}
impl TaskSync {
    pub(super) async fn load_cursor_state(&self) -> Value {
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
}
impl TaskSync {
    pub(super) async fn read_cursor_state(&self) -> Value {
        let mut guard = self.cursor_state.lock().await;
        if let Some(state) = guard.as_ref() {
            return state.clone();
        }
        let state = self.load_cursor_state().await;
        *guard = Some(state.clone());
        state
    }
}
impl TaskSync {
    pub(super) async fn read_cursor_event_state(&self, task_space_id: &str) -> (u64, bool) {
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
            .cloned()
            .is_some_and(|entry| cursor_from_entry(&entry).pending.is_some());
        (revision, has_pending)
    }
}
impl TaskSync {
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
}
impl TaskSync {
    pub(super) async fn write_cursor(
        &self,
        task_space_id: &str,
        next: CursorPatch,
    ) -> AgentResult<()> {
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
        let patch_changed = apply_cursor_patch(&mut cursor, &next);
        let archive_migration = cursor_entry_needs_archive_migration(&Value::Object(entry.clone()));
        if !patch_changed && !archive_migration {
            *self.cursor_state.lock().await = Some(state);
            return Ok(());
        }
        entry.insert("revision".into(), json!(cursor.revision));
        entry.insert(
            "revisionGuardVersion".into(),
            json!(cursor.revision_guard_version),
        );
        entry.insert("sequence".into(), json!(cursor.sequence));
        if next.baseline_reconciled_head.is_some() {
            entry.insert(
                "baselineReconciledHead".into(),
                json!(cursor.baseline_reconciled_head),
            );
        }
        entry.insert("baselines".into(), baselines_to_value(&cursor.baselines));
        entry.insert("deferred".into(), deferred_to_value(&cursor.deferred));
        entry.insert(
            "ownershipPending".into(),
            ownership_pending_to_value(&cursor.ownership_pending),
        );
        entry.insert(
            "conflictBlocked".into(),
            conflict_blocked_to_value(&cursor.conflict_blocked),
        );
        entry.insert(
            "readonlyTaskDirs".into(),
            readonly_task_dirs_to_value(&cursor.readonly_task_dirs),
        );
        entry.insert(
            "pendingRejected".into(),
            pending_rejected_to_value(&cursor.pending_rejected),
        );
        match cursor.pending {
            Some(batch) => {
                entry.insert(
                    "pending".into(),
                    json!({
                        "batchId": batch.batch_id,
                        "clientSequence": batch.client_sequence,
                        "files": batch.files,
                        "mergeEvidence": batch.merge_evidence,
                        "createdAt": batch.created_at,
                    }),
                );
            }
            None => {
                entry.remove("pending");
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
        self.notify_state_changed();
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn migrate_cursor_archive_state(
        &self,
        task_space_id: &str,
    ) -> AgentResult<()> {
        self.write_cursor(task_space_id, CursorPatch::default())
            .await
    }
}
impl TaskSync {
    /// 服务端明确归档任务目录后，一次性丢弃这些目录的本地同步基线与 deferred。
    /// 必须在 upload 返回前持久化；否则同一批目录会一直被判定为 dirty，`pull_tracking` 无法收敛。
    pub(super) async fn remove_task_dir_cursor_state(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        if task_dirs.is_empty() {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                task_dir_removals: Some(task_dirs.iter().cloned().collect()),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
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
        self.notify_state_changed();
        Ok(())
    }
}
impl TaskSync {
    /// 按服务端要求抬高待上传批次的 clientSequence（仅同一批次、且序号确实变大）。
    pub(super) async fn update_pending_client_sequence(
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
}
#[derive(Default)]
pub(super) struct CursorPatch {
    pub(super) revision: Option<u64>,
    pub(super) revision_guard_version: Option<u64>,
    pub(super) sequence: Option<u64>,
    pub(super) baseline_reconciled_head: Option<String>,
    pub(super) pending: Option<Option<PendingBatch>>,
    pub(super) pending_rejected: Option<BTreeMap<String, PendingRejection>>,
    pub(super) baselines: Option<BTreeMap<String, String>>,
    pub(super) deferred: Option<BTreeMap<String, BTreeMap<String, String>>>,
    pub(super) ownership_pending: Option<BTreeMap<String, String>>,
    pub(super) ownership_ledger_removals: Option<BTreeSet<String>>,
    /// 需要整体丢弃本地同步状态的活跃任务目录（例如服务端已明确归档）。
    /// 只移除 baselines/deferred，服务端待归属账本另由 `cleanup_missing_ownership_inbox` 负责。
    pub(super) task_dir_removals: Option<BTreeSet<String>>,
    pub(super) conflict_blocked: Option<BTreeMap<String, String>>,
    pub(super) readonly_task_dirs: Option<BTreeMap<String, String>>,
}
pub(super) fn apply_cursor_patch(cursor: &mut Cursor, next: &CursorPatch) -> bool {
    let before = cursor.clone();
    if let Some(revision) = next.revision {
        cursor.revision = cursor.revision.max(revision);
    }
    if let Some(revision_guard_version) = next.revision_guard_version {
        cursor.revision_guard_version = cursor.revision_guard_version.max(revision_guard_version);
    }
    if let Some(sequence) = next.sequence {
        cursor.sequence = cursor.sequence.max(sequence);
    }
    if let Some(head) = &next.baseline_reconciled_head {
        cursor.baseline_reconciled_head = head.clone();
    }
    if let Some(pending) = &next.pending {
        cursor.pending = pending.clone();
    }
    if let Some(pending_rejected) = &next.pending_rejected {
        cursor.pending_rejected = pending_rejected.clone();
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
    if let Some(task_dirs) = &next.ownership_ledger_removals {
        for task_dir in task_dirs {
            cursor.ownership_pending.remove(task_dir);
            cursor.pending_rejected.remove(task_dir);
        }
    }
    if let Some(task_dirs) = &next.task_dir_removals {
        for task_dir in task_dirs {
            // baselines 以文件路径为键；只按 `{task_dir}/` 前缀移除，不能误伤同前缀的兄弟目录。
            let prefix = format!("{task_dir}/");
            cursor
                .baselines
                .retain(|path_name, _| path_name != task_dir && !path_name.starts_with(&prefix));
            cursor.deferred.remove(task_dir);
        }
    }
    if let Some(conflict_blocked) = &next.conflict_blocked {
        cursor.conflict_blocked = conflict_blocked.clone();
    }
    if let Some(readonly_task_dirs) = &next.readonly_task_dirs {
        cursor.readonly_task_dirs = readonly_task_dirs.clone();
    }
    *cursor != before
}
/// 服务端按 taskSpace 要求 `clientSequence` 严格递增，且历史值来自旧版 JS 客户端的
/// `Date.now()`。因此始终取「本地 cursor + 1」与当前毫秒时间的较大值，避免重装/换实现后
/// 从 1 开始被服务端拒绝。
pub(super) fn next_client_sequence(cursor_sequence: u64) -> u64 {
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    cursor_sequence.saturating_add(1).max(wall)
}
pub(super) fn clear_deferred_for_files(
    deferred: &BTreeMap<String, BTreeMap<String, String>>,
    files: &[SnapshotFile],
) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut next = deferred.clone();
    for file in files {
        if let Some(task_dir) = active_task_directory_from_relative(&file.path) {
            next.remove(&task_dir);
        }
    }
    next
}
pub(super) fn baselines_to_value(baselines: &BTreeMap<String, String>) -> Value {
    Value::Object(
        baselines
            .iter()
            .map(|(path_name, sha256)| (path_name.clone(), Value::String(sha256.clone())))
            .collect(),
    )
}
pub(super) fn deferred_to_value(deferred: &BTreeMap<String, BTreeMap<String, String>>) -> Value {
    Value::Object(
        deferred
            .iter()
            .map(|(task_dir, files)| (task_dir.clone(), baselines_to_value(files)))
            .collect(),
    )
}
pub(super) fn parse_baselines(value: &Value) -> Option<BTreeMap<String, String>> {
    let object = value.as_object()?;
    let mut baselines = BTreeMap::new();
    for (path_name, sha256) in object {
        let Some(sha256) = sha256.as_str() else {
            continue;
        };
        if is_sha256(sha256)
            && normalize_snapshot_path(path_name).is_ok()
            && active_task_directory_from_path(path_name).is_some()
        {
            baselines.insert(path_name.clone(), sha256.to_string());
        }
    }
    Some(baselines)
}
pub(super) fn parse_deferred(value: &Value) -> Option<BTreeMap<String, BTreeMap<String, String>>> {
    let object = value.as_object()?;
    let mut deferred = BTreeMap::new();
    for (task_dir, files) in object {
        let Some(files) = parse_baselines(files) else {
            continue;
        };
        if files.is_empty() {
            continue;
        }
        if !is_archive_task_dir(task_dir)
            && files.keys().all(|path_name| {
                active_task_directory_from_relative(path_name).as_deref() == Some(task_dir.as_str())
            })
        {
            deferred.insert(task_dir.clone(), files);
        }
    }
    Some(deferred)
}
pub(super) fn ownership_pending_to_value(pending: &BTreeMap<String, String>) -> Value {
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
pub(super) fn conflict_blocked_to_value(blocked: &BTreeMap<String, String>) -> Value {
    Value::Object(
        blocked
            .iter()
            .map(|(task_dir, conflict_id)| (task_dir.clone(), json!({ "conflictId": conflict_id })))
            .collect(),
    )
}
pub(super) fn readonly_task_dirs_to_value(dirs: &BTreeMap<String, String>) -> Value {
    Value::Object(
        dirs.iter()
            .map(|(task_dir, reason)| (task_dir.clone(), json!(reason)))
            .collect(),
    )
}
pub(super) fn readonly_reason(kind: &str, assignee: &str) -> String {
    if assignee.is_empty() {
        kind.to_string()
    } else {
        format!("{kind}:{assignee}")
    }
}
pub(super) fn readonly_reason_assignee(reason: &str) -> Option<&str> {
    reason.split_once(':').map(|(_, assignee)| assignee)
}
pub(super) fn parse_readonly_task_dirs(value: &Value) -> BTreeMap<String, String> {
    let mut dirs = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return dirs;
    };
    for (task_dir, reason) in object {
        if is_archive_task_dir(task_dir)
            || task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
                != Some(task_dir.as_str())
        {
            continue;
        }
        let reason = reason
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .unwrap_or("FOREIGN_OWNER");
        dirs.insert(task_dir.clone(), reason.to_string());
    }
    dirs
}
pub(super) fn pending_rejected_to_value(rejected: &BTreeMap<String, PendingRejection>) -> Value {
    Value::Object(
        rejected
            .iter()
            .map(|(task_dir, item)| {
                (
                    task_dir.clone(),
                    json!({
                        "batchId": item.batch_id,
                        "clientSequence": item.client_sequence,
                        "reason": item.reason,
                        "createdAt": item.created_at,
                        "blockedAt": item.blocked_at,
                    }),
                )
            })
            .collect(),
    )
}
pub(super) fn parse_pending_rejected(value: &Value) -> BTreeMap<String, PendingRejection> {
    let mut rejected = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return rejected;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir)
            || task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
                != Some(task_dir.as_str())
        {
            continue;
        }
        let Some(batch_id) = state
            .get("batchId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(client_sequence) = state
            .get("clientSequence")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
        else {
            continue;
        };
        let Some(reason) = state
            .get("reason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(blocked_at) = state
            .get("blockedAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let created_at = state
            .get("createdAt")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(blocked_at);
        rejected.insert(
            task_dir.clone(),
            PendingRejection {
                batch_id: batch_id.to_string(),
                client_sequence,
                reason: reason.to_string(),
                created_at: created_at.to_string(),
                blocked_at: blocked_at.to_string(),
            },
        );
    }
    trim_pending_rejections(&mut rejected);
    rejected
}
pub(super) fn trim_pending_rejections(rejected: &mut BTreeMap<String, PendingRejection>) {
    if rejected.len() <= PENDING_REJECTED_LIMIT {
        return;
    }
    let mut entries: Vec<(String, String)> = rejected
        .iter()
        .map(|(task_dir, item)| (task_dir.clone(), item.blocked_at.clone()))
        .collect();
    entries.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)));
    let keep: HashSet<String> = entries
        .into_iter()
        .take(PENDING_REJECTED_LIMIT)
        .map(|(task_dir, _)| task_dir)
        .collect();
    rejected.retain(|task_dir, _| keep.contains(task_dir));
}
pub(super) fn parse_ownership_pending(value: &Value) -> BTreeMap<String, String> {
    let mut pending = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return pending;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir) {
            continue;
        }
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
pub(super) fn parse_conflict_blocked(value: &Value) -> BTreeMap<String, String> {
    let mut blocked = BTreeMap::new();
    let Some(object) = value.as_object() else {
        return blocked;
    };
    for (task_dir, state) in object {
        if is_archive_task_dir(task_dir) {
            continue;
        }
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
pub(super) fn parse_pending_batch(value: &Value) -> Option<PendingBatch> {
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
        created_at: value
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}
