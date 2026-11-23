use super::*;

impl TaskSync {
    pub(super) async fn fetch_snapshot(
        &self,
        task_space_id: &str,
        after_revision: u64,
    ) -> AgentResult<Value> {
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
}
impl TaskSync {
    pub(crate) async fn fetch_directory(
        &self,
        task_space_id: &str,
        task_dir: &str,
    ) -> AgentResult<Value> {
        if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
            != Some(task_dir)
        {
            return protocol::err(code::INVALID_RESPONSE, "任务目录无效或已由服务端 Git 归档");
        }
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
}
impl TaskSync {
    pub(super) async fn write_server_cursor(
        &self,
        task_space_id: &str,
        revision: u64,
    ) -> AgentResult<()> {
        let known = self.bindings.lock().await.contains_key(task_space_id);
        if !known || !self.task_space_is_active(task_space_id).await {
            return Ok(());
        }
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
}
impl TaskSync {
    pub(super) async fn apply_server_groups(
        &self,
        binding: &AgentBinding,
        revision: u64,
        groups: &[SnapshotGroup],
        mode: &str,
        persist_cursor: bool,
    ) -> AgentResult<bool> {
        let mut changed = false;
        for group in groups {
            if group.archived
                || is_archive_task_dir(&group.task_dir)
                || group.files.iter().any(|file| file.archived)
            {
                continue;
            }
            self.assert_binding_branch(binding).await?;
            let allow_cross_branch = allows_cross_source_server_group(binding, mode);
            if !allow_cross_branch
                && group
                    .task_branch
                    .as_deref()
                    .is_some_and(|branch| branch != binding.branch_name)
            {
                continue;
            }
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
}
impl TaskSync {
    pub(super) async fn remove_task_directory(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<()> {
        if is_archive_task_dir(task_dir) {
            return protocol::err(
                code::INVALID_RESPONSE,
                "客户端不能修改服务端 Git 管理的归档目录",
            );
        }
        let target = resolve_task_directory(binding, task_dir).await?;
        match tokio::fs::remove_dir_all(&target).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AgentError::new(
                code::INVALID_RESPONSE,
                format!("无法删除任务目录: {error}"),
            )),
        }
    }
}
impl TaskSync {
    pub(super) async fn backup_directory(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<Option<String>> {
        let backup_id = uuid::Uuid::new_v4().to_string();
        Ok(self
            .backup_directory_with_id(binding, task_dir, &backup_id)
            .await?
            .then_some(backup_id))
    }
}
impl TaskSync {
    pub(super) async fn backup_directory_with_id(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
        backup_id: &str,
    ) -> AgentResult<bool> {
        if is_archive_task_dir(task_dir) {
            return protocol::err(
                code::INVALID_RESPONSE,
                "客户端不能修改服务端 Git 管理的归档目录",
            );
        }
        let source = resolve_task_directory(binding, task_dir).await?;
        if !source.exists() {
            return Ok(false);
        }
        let target = self
            .store
            .paths
            .live_backups_dir
            .join(&binding.task_space_id)
            .join(backup_id);
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                AgentError::new(code::INVALID_RESPONSE, format!("无法创建备份目录: {error}"))
            })?;
        }
        copy_directory(&source, &target).await?;
        Ok(true)
    }
}
impl TaskSync {
    pub(super) async fn suppressed_event(
        &self,
        binding: &AgentBinding,
        relative_path: &str,
    ) -> bool {
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
}
impl TaskSync {
    pub(super) async fn local_sync_state(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        server_baselines: &BTreeMap<String, String>,
    ) -> AgentResult<(
        Vec<String>,
        BTreeMap<String, BTreeMap<String, String>>,
        HashSet<String>,
    )> {
        let groups = self.local_metadata_groups(binding).await?;
        Ok(local_sync_state_from_groups(
            cursor,
            &groups,
            server_baselines,
        ))
    }
}
impl TaskSync {
    pub(super) async fn local_metadata_groups(
        &self,
        binding: &AgentBinding,
    ) -> AgentResult<Vec<SnapshotGroup>> {
        let projection_epoch = self.projection_epoch(&binding.task_space_id).await;
        self.refresh_ownership_index_binding_with_scan(binding, projection_epoch, true)
            .await?;
        let epoch_ok = self
            .projection_epoch_matches(&binding.task_space_id, projection_epoch)
            .await;
        if !epoch_ok {
            return protocol::err(code::BINDING_UNKNOWN, "本地任务文件索引已失效");
        }
        self.ensure_ownership_index_loaded().await;
        let groups = {
            let index = self.ownership_index.lock().await;
            let entry = index
                .bindings
                .get(&binding.local_id)
                .filter(|entry| {
                    entry.task_space_id == binding.task_space_id
                        && entry.repo_path == binding.repo_path
                        && entry.branch_name == binding.branch_name
                        && entry.baseline_branch == binding.baseline_branch
                })
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "本地任务文件索引缺少当前绑定")
                })?;
            if !entry.files_complete {
                return protocol::err(code::INVALID_RESPONSE, "本地任务文件索引尚未完整");
            }
            indexed_local_groups(entry)?
        };
        Ok(self.retain_owned_groups(binding, groups).await)
    }
}
impl TaskSync {
    pub async fn pull_task_space(&self, task_space_id: &str) -> AgentResult<Value> {
        let mut reconciled_deferred = HashSet::new();
        self.pull_task_space_tracking(task_space_id, &mut reconciled_deferred)
            .await
    }
}
impl TaskSync {
    pub(super) async fn pull_task_space_tracking(
        &self,
        task_space_id: &str,
        reconciled_deferred: &mut HashSet<String>,
    ) -> AgentResult<Value> {
        let binding = match self.binding(task_space_id).await {
            Ok(binding) => binding,
            Err(error) if error.code == code::BINDING_UNKNOWN => {
                return Ok(json!({
                    "skipped": true,
                    "reason": "BINDING_INACTIVE",
                }))
            }
            Err(error) => return Err(error),
        };
        self.pull_tracking(&binding, reconciled_deferred).await
    }
}
impl TaskSync {
    pub(super) async fn pull_task_space_for_event(
        &self,
        task_space_id: &str,
        event_revision: Option<u64>,
    ) -> AgentResult<Value> {
        if let Ok(binding) = self.binding(task_space_id).await {
            let (cursor_revision, has_pending_upload) =
                self.read_cursor_event_state(task_space_id).await;
            let guard_due = binding.initial_sync_completed
                && self.read_cursor(task_space_id).await.revision_guard_version
                    < REVISION_GUARD_VERSION;
            if !guard_due
                && !should_pull_for_event(
                    binding.initial_sync_completed,
                    binding.initial_review_pending,
                    cursor_revision,
                    event_revision,
                    has_pending_upload,
                )
            {
                self.retry_pending_handoff_acks(&binding).await?;
                return Ok(json!({
                    "skipped": true,
                    "reason": "REVISION_CURRENT",
                    "revision": cursor_revision,
                }));
            }
        }
        self.pull_task_space(task_space_id).await
    }
}
impl TaskSync {
    pub(super) async fn pull(&self, binding: &AgentBinding) -> AgentResult<Value> {
        let mut reconciled_deferred = HashSet::new();
        self.pull_tracking(binding, &mut reconciled_deferred).await
    }
}
impl TaskSync {
    pub(super) async fn pull_tracking(
        &self,
        binding: &AgentBinding,
        reconciled_deferred: &mut HashSet<String>,
    ) -> AgentResult<Value> {
        let started = Instant::now();
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let cursor_started = Instant::now();
        self.migrate_cursor_archive_state(&task_space_id).await?;
        let mut cursor = self.read_cursor(&task_space_id).await;
        sync_trace(
            &task_space_id,
            "pull-cursor",
            cursor_started,
            json!({
                "trigger": "pull",
                "revision": cursor.revision,
                "hasPending": cursor.pending.is_some(),
            }),
        );
        let initial_sync = !binding.initial_sync_completed;
        if let Some(pending) = cursor.pending.clone() {
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                let pending_after = self.read_cursor(&task_space_id).await.pending;
                if pending_after.is_some()
                    && result.get("skipped").and_then(Value::as_bool) == Some(true)
                {
                    return Ok(json!({
                        "skipped": true,
                        "reason": result.get("reason").cloned().unwrap_or(Value::Null),
                        "blocked": result.get("blocked").cloned().unwrap_or(Value::Null),
                        "conflicts": [],
                        "revision": cursor.revision,
                        "pendingReview": true,
                    }));
                }
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
        if !initial_sync && cursor.revision_guard_version < REVISION_GUARD_VERSION {
            return Box::pin(self.repair_revision_guard(binding)).await;
        }
        let after_revision = if initial_sync { 0 } else { cursor.revision };
        let http_started = Instant::now();
        let snapshot = self.fetch_snapshot(&task_space_id, after_revision).await?;
        sync_trace(
            &task_space_id,
            "pull-http",
            http_started,
            json!({
                "trigger": "pull",
                "afterRevision": after_revision,
            }),
        );
        let snapshot_controls = parse_snapshot_controls(&snapshot)?;
        if initial_sync {
            return self
                .pull_initial_sync(binding, &snapshot, snapshot_controls.as_deref())
                .await;
        }
        if let Some(controls) = &snapshot_controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
            self.cleanup_archived_controls(binding, controls).await;
            self.prune_readonly_dirs(binding, Some(controls)).await?;
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
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_binding(binding, &mut server_groups);
        self.prepare_controlled_server_groups(
            binding,
            snapshot_controls.as_deref(),
            &mut server_groups,
        )
        .await?;
        let mut snapshot_baselines = if after_revision == 0 {
            baselines_from_snapshot(&snapshot_files)
        } else {
            merge_baselines(&cursor.baselines, &snapshot_files)
        };
        let latest_revision = snapshot
            .get("revision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();

        let local_started = Instant::now();
        let (dirty_dirs, deferred, exact_reconciled) = self
            .local_sync_state(binding, &cursor, &snapshot_baselines)
            .await?;
        let inactive_dirs = inactive_control_dirs(snapshot_controls.as_deref());
        let readonly_dirs: HashSet<String> = cursor.readonly_task_dirs.keys().cloned().collect();
        let dirty_dirs: Vec<String> = dirty_dirs
            .into_iter()
            .filter(|task_dir| !inactive_dirs.contains(task_dir))
            .filter(|task_dir| !readonly_dirs.contains(task_dir))
            .collect();
        let deferred: BTreeMap<String, BTreeMap<String, String>> = deferred
            .into_iter()
            .filter(|(task_dir, _)| !inactive_dirs.contains(task_dir))
            .filter(|(task_dir, _)| !readonly_dirs.contains(task_dir))
            .collect();
        sync_trace(
            &task_space_id,
            "pull-local",
            local_started,
            json!({
                "trigger": "pull",
                "dirtyDirs": dirty_dirs.len(),
                "deferredDirs": deferred.len(),
            }),
        );
        reconciled_deferred.extend(exact_reconciled);
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
            if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                return Ok(json!({
                    "skipped": true,
                    "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
                    "blocked": uploaded.get("blocked").cloned().unwrap_or(Value::Null),
                    "conflicts": [],
                    "revision": cursor.revision,
                    "pendingReview": true,
                }));
            }
            if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                return Ok(json!({
                    "conflicts": [uploaded],
                    "revision": cursor.revision,
                    "pendingReview": true,
                }));
            }
            // 上传后需要再拉一次才能看到新 revision；但如果本轮没有提交任何内容
            // （典型：dirty 目录本地已无文件、build_directory_files 产出空差异），
            // 继续尾递归不会改变任何状态，只会无限加深调用栈直至 stack overflow。
            // 2026-11-20 实测：dirtyDirs=2、localGroups=0、committedRevision=0 时
            // 每秒递归多次，约 50s 后 tokio worker 栈溢出 abort。
            // 停止递归，但不能直接返回：服务端可能已在当前快照中推进 revision
            // （例如归档目录 409 清理后仍需应用快照），必须继续应用手中的快照才能收敛。
            let committed = uploaded
                .get("committedRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            if committed == 0 {
                crate::logging::warn(&format!(
                    "上传未产生提交，继续应用当前快照：dirtyDirs={dirty_dirs:?}"
                ));
                // 上传可能已清理归档目录的本地 cursor 状态，必须用最新 cursor 重算基线，
                // 否则旧基线会在末尾 merge 时被写回。
                cursor = self.read_cursor(&task_space_id).await;
                snapshot_baselines = if after_revision == 0 {
                    baselines_from_snapshot(&snapshot_files)
                } else {
                    merge_baselines(&cursor.baselines, &snapshot_files)
                };
            } else {
                return Box::pin(self.pull_tracking(binding, reconciled_deferred)).await;
            }
        }

        if after_revision == 0 {
            let local_groups = self.local_groups(binding, None).await?;
            let differences = hide_control_tombstone_local_only(
                classify_task_snapshots(&local_groups, &server_groups),
                snapshot_controls.as_deref(),
            );
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
                .filter(|task_dir| !inactive_dirs.contains(task_dir))
                .collect();
            if !local_only.is_empty() {
                let uploaded = self
                    .upload_directories(binding, &local_only, false, None)
                    .await?;
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(json!({
                        "skipped": true,
                        "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
                        "conflicts": [],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(&snapshot),
                        "pendingReview": true,
                    }));
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(json!({
                        "conflicts": [uploaded],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(&snapshot),
                        "pendingReview": true,
                    }));
                }
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
                let directory = match self.fetch_directory(&task_space_id, &task_dir).await {
                    Ok(directory) => directory,
                    Err(error) if error.status == Some(404) || is_archived_task_error(&error) => {
                        continue
                    }
                    Err(error) if is_foreign_task_error(&error) => {
                        let assignee = self.control_assignee(&task_space_id, &task_dir).await;
                        self.mark_readonly_dir(
                            &task_space_id,
                            &task_dir,
                            &readonly_reason("FOREIGN_OWNER", &assignee),
                        )
                        .await?;
                        continue;
                    }
                    Err(error) => return Err(with_task_dir(error, &task_dir)),
                };
                let files = parse_directory_files(&directory, &task_dir)?;
                by_dir.push(SnapshotGroup {
                    task_dir: task_dir.clone(),
                    archived: files.first().map(|file| file.archived).unwrap_or(false),
                    archive_month: files.first().and_then(|file| file.archive_month.clone()),
                    task_id: files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_id(&file.content)),
                    task_branch: files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_metadata(&file.content).1),
                    files,
                });
            }
            retain_server_groups_for_binding(binding, &mut by_dir);
            self.prepare_controlled_server_groups(
                binding,
                snapshot_controls.as_deref(),
                &mut by_dir,
            )
            .await?;
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
        sync_trace(
            &task_space_id,
            "pull-total",
            started,
            json!({
                "trigger": "pull",
                "revision": latest_revision,
            }),
        );
        Ok(json!({ "conflicts": [], "revision": latest_revision }))
    }
}
