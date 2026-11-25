use super::*;

impl TaskSync {
    pub(super) async fn repair_revision_guard(&self, binding: &AgentBinding) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let cursor = self.read_cursor(&task_space_id).await;
        if cursor.revision_guard_version >= REVISION_GUARD_VERSION {
            return Ok(json!({
                "skipped": true,
                "reason": "REVISION_GUARD_CURRENT",
                "revision": cursor.revision,
            }));
        }

        let snapshot = self.fetch_snapshot(&task_space_id, 0).await?;
        let controls = parse_snapshot_controls(&snapshot)?;
        if let Some(controls) = &controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let local_groups = self.local_groups(binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_revision_guard(binding, &mut server_groups);
        self.prepare_controlled_server_groups(binding, controls.as_deref(), &mut server_groups)
            .await?;
        let mut differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls.as_deref(),
        );
        self.gate_local_only_differences(binding, &mut differences)
            .await?;
        let server_only: Vec<SnapshotGroup> = differences
            .iter()
            .filter(|item| item.kind == DiffKind::ServerOnly)
            .filter_map(|item| item.server.clone())
            .collect();
        self.apply_server_groups(
            binding,
            snapshot_revision(&snapshot),
            &server_only,
            REVISION_GUARD_SYNC_MODE,
            false,
        )
        .await?;

        let inactive_dirs = inactive_control_dirs(controls.as_deref());
        let mut deferred = cursor.deferred.clone();
        let mut conflicts = Vec::new();
        let mut local_only = Vec::new();
        for difference in &differences {
            match difference.kind {
                DiffKind::Same | DiffKind::ServerOnly => {}
                DiffKind::LocalOnly => {
                    if let Some(local) = difference.local.clone() {
                        if !inactive_dirs.contains(&local.task_dir) {
                            local_only.push(local);
                        }
                    }
                }
                DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid => {
                    conflicts.push(difference.to_control());
                    let task_dir = difference
                        .local
                        .as_ref()
                        .map(|group| group.task_dir.clone())
                        .or_else(|| {
                            difference
                                .server
                                .as_ref()
                                .map(|group| group.task_dir.clone())
                        })
                        .unwrap_or_else(|| difference.task_dir.clone());
                    let state = difference
                        .local
                        .as_ref()
                        .map(file_state_from_group)
                        .or_else(|| difference.server.as_ref().map(file_state_from_group))
                        .unwrap_or_default();
                    deferred.insert(task_dir, state);
                }
            }
        }

        let ownership = if local_only.is_empty() {
            OwnershipResolution::default()
        } else {
            self.resolve_task_ownership(binding, &local_only).await?
        };
        for local in &local_only {
            let Some(syncable) = ownership.syncable.get(&local.task_dir) else {
                deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                continue;
            };
            let files: Vec<Value> = syncable
                .files
                .iter()
                .map(|file| {
                    json!({
                        "path": file.path,
                        "content": file.content,
                        "sha256": file.sha256,
                        "baseSha256": Value::Null,
                    })
                })
                .collect();
            let current = self.read_cursor(&task_space_id).await;
            let uploaded = self
                .upload_preclassified_batch(
                    binding,
                    &current,
                    files,
                    ownership.merge_evidence.get(&local.task_dir).cloned(),
                )
                .await?;
            if uploaded.is_none()
                || uploaded.as_ref().is_some_and(|value| {
                    value.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
                        || value.get("skipped").and_then(Value::as_bool) == Some(true)
                })
            {
                deferred.insert(local.task_dir.clone(), file_state_from_group(local));
            }
        }

        let verified = self.fetch_snapshot(&task_space_id, 0).await?;
        let verified_controls = parse_snapshot_controls(&verified)?;
        if let Some(controls) = &verified_controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let verified_files = parse_snapshot_files(&verified)?;
        let verified_server_files: Vec<SnapshotFile> = verified_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut verified_server = groups_from_structs(&verified_server_files)?;
        retain_server_groups_for_revision_guard(binding, &mut verified_server);
        self.prepare_controlled_server_groups(
            binding,
            verified_controls.as_deref(),
            &mut verified_server,
        )
        .await?;
        let verified_local = self.local_groups(binding, None).await?;
        let mut verified_differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&verified_local, &verified_server),
            verified_controls.as_deref(),
        );
        self.gate_local_only_differences(binding, &mut verified_differences)
            .await?;
        let unresolved: Vec<&Difference> = verified_differences
            .iter()
            .filter(|item| item.kind != DiffKind::Same)
            .filter(|item| {
                !deferred.contains_key(&item.task_dir)
                    && !item
                        .local
                        .as_ref()
                        .is_some_and(|local| deferred.contains_key(&local.task_dir))
                    && !item
                        .server
                        .as_ref()
                        .is_some_and(|server| deferred.contains_key(&server.task_dir))
            })
            .collect();
        if !unresolved.is_empty() {
            return protocol::err(
                code::INVALID_RESPONSE,
                "revision guard 全量对账未收敛，保留本地任务并等待下次重试",
            );
        }

        let mut baselines = baselines_from_snapshot(&verified_files);
        for task_dir in deferred.keys() {
            let prefix = format!("{task_dir}/");
            baselines.retain(|path_name, _| !path_name.starts_with(&prefix));
            for (path_name, sha256) in &cursor.baselines {
                if path_name.starts_with(&prefix) {
                    baselines.insert(path_name.clone(), sha256.clone());
                }
            }
        }
        let verified_revision = snapshot_revision(&verified);
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(verified_revision),
                revision_guard_version: Some(REVISION_GUARD_VERSION),
                baselines: Some(baselines),
                deferred: Some(deferred.clone()),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(&task_space_id, verified_revision)
            .await?;
        let previous_task_dirs =
            ownership_ledger_task_dirs(&self.read_cursor(&task_space_id).await);
        self.sync_ownership_inbox(binding, &previous_task_dirs, &verified_local)
            .await;
        if !conflicts.is_empty() {
            let conflict_differences: Vec<Difference> = verified_differences
                .iter()
                .filter(|item| {
                    deferred.contains_key(&item.task_dir)
                        || item
                            .local
                            .as_ref()
                            .is_some_and(|local| deferred.contains_key(&local.task_dir))
                })
                .cloned()
                .collect();
            self.emit_differences(binding, verified_revision, &conflict_differences);
        }
        Ok(json!({
            "repaired": true,
            "revision": verified_revision,
            "downloaded": server_only.len(),
            "deferred": deferred.keys().cloned().collect::<Vec<_>>(),
            "conflicts": conflicts,
            "pendingReview": !conflicts.is_empty(),
        }))
    }
}
impl TaskSync {
    pub(super) async fn pull_initial_sync(
        &self,
        binding: &AgentBinding,
        snapshot: &Value,
        controls: Option<&[TaskControl]>,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        if let Some(controls) = controls {
            self.merge_task_controls(binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(binding, controls).await?;
        }
        let local_groups = self.local_groups(binding, None).await?;
        let snapshot_files = parse_snapshot_files(snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_initial_sync(binding, &local_groups, &mut server_groups);
        self.prepare_controlled_server_groups(binding, controls, &mut server_groups)
            .await?;
        let server_baselines = baselines_from_snapshot(&snapshot_files);
        let mut differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls,
        );
        self.gate_local_only_differences(binding, &mut differences)
            .await?;
        let actionable: Vec<&Difference> = differences
            .iter()
            .filter(|item| item.kind != DiffKind::Same)
            .collect();
        let mode = initial_sync_mode(binding);

        if mode == "review" && !actionable.is_empty() {
            self.emit_differences(binding, snapshot_revision(snapshot), &differences);
            return Ok(json!({
                "conflicts": actionable.iter()
                    .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                    .map(|item| item.to_control())
                    .collect::<Vec<_>>(),
                "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                "revision": snapshot_revision(snapshot),
                "pendingReview": true,
            }));
        }

        let mut latest_revision = snapshot_revision(snapshot);
        let mut completion_baselines = server_baselines.clone();
        let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();

        if mode == "bootstrap" {
            let blocking: Vec<&Difference> = actionable
                .iter()
                .copied()
                .filter(|item| item.kind != DiffKind::LocalOnly)
                .collect();
            if !blocking.is_empty() {
                self.emit_differences(binding, snapshot_revision(snapshot), &differences);
                return Ok(json!({
                    "conflicts": blocking.iter()
                        .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                        .map(|item| item.to_control())
                        .collect::<Vec<_>>(),
                    "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(snapshot),
                    "pendingReview": true,
                }));
            }
            let inactive_dirs = inactive_control_dirs(controls);
            let local_only: Vec<String> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::LocalOnly)
                .filter_map(|item| item.local.as_ref().map(|group| group.task_dir.clone()))
                .filter(|task_dir| !inactive_dirs.contains(task_dir))
                .collect();
            if !local_only.is_empty() {
                let uploaded = self
                    .upload_directories(binding, &local_only, false, None)
                    .await?;
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(json!({
                        "conflicts": [uploaded],
                        "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                        "revision": snapshot_revision(snapshot),
                        "pendingReview": true,
                    }));
                }
                completion_baselines = merge_baselines(
                    &completion_baselines,
                    &self.last_baseline_files.lock().await.clone(),
                );
            }
        } else if mode == "safe" {
            let server_only: Vec<SnapshotGroup> = differences
                .iter()
                .filter(|item| item.kind == DiffKind::ServerOnly)
                .filter_map(|item| item.server.clone())
                .collect();
            self.apply_server_groups(
                binding,
                snapshot_revision(snapshot),
                &server_only,
                "safe",
                false,
            )
            .await?;
            for difference in &actionable {
                if difference.kind == DiffKind::ServerOnly {
                    continue;
                }
                if let Some(local) = &difference.local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
            }
        }

        if mode == "bootstrap" {
            let verified = self.fetch_snapshot(&task_space_id, 0).await?;
            let verified_controls = parse_snapshot_controls(&verified)?;
            if let Some(controls) = &verified_controls {
                self.merge_task_controls(binding, controls).await?;
                self.release_inactive_task_leases(Some(controls)).await;
                self.process_handoff_controls(binding, controls).await?;
            }
            let verified_local = self.local_groups(binding, None).await?;
            let verified_files = parse_snapshot_files(&verified)?;
            let verified_server_files: Vec<SnapshotFile> = verified_files
                .iter()
                .filter(|file| !file.deleted)
                .cloned()
                .collect();
            let mut verified_server = groups_from_structs(&verified_server_files)?;
            self.prepare_controlled_server_groups(
                binding,
                verified_controls.as_deref(),
                &mut verified_server,
            )
            .await?;
            let mut verified_differences = hide_control_tombstone_local_only(
                classify_task_snapshots(&verified_local, &verified_server),
                verified_controls.as_deref(),
            );
            self.gate_local_only_differences(binding, &mut verified_differences)
                .await?;
            let unresolved = verified_differences
                .iter()
                .filter(|item| item.kind != DiffKind::Same)
                .count();
            if unresolved > 0 {
                self.emit_differences(binding, snapshot_revision(&verified), &verified_differences);
                return Ok(json!({
                    "conflicts": verified_differences.iter()
                        .filter(|item| matches!(item.kind, DiffKind::ContentConflict | DiffKind::MoveDeleteConflict | DiffKind::Invalid))
                        .map(|item| item.to_control())
                        .collect::<Vec<_>>(),
                    "differences": verified_differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
                    "revision": snapshot_revision(&verified),
                    "pendingReview": true,
                }));
            }
            latest_revision = latest_revision.max(snapshot_revision(&verified));
            completion_baselines = baselines_from_snapshot(&verified_files);
        }

        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(latest_revision),
                baselines: Some(completion_baselines),
                deferred: Some(deferred),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(&task_space_id, latest_revision)
            .await?;
        self.complete_initial_sync(&task_space_id, &mode).await?;
        Ok(json!({
            "conflicts": [],
            "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
            "revision": latest_revision,
            "pendingReview": false,
        }))
    }
}
impl TaskSync {
    pub(super) fn emit_differences(
        &self,
        binding: &AgentBinding,
        revision: u64,
        differences: &[Difference],
    ) {
        (self.emit)(json!({
            "type": "initial_sync_review",
            "taskSpaceId": binding.task_space_id,
            "projectName": binding.display_name,
            "branchName": binding.branch_name,
            "revision": revision,
            "differences": differences.iter().map(Difference::to_control).collect::<Vec<_>>(),
        }));
    }
}

impl TaskSync {
    /// 首同步与接入后的同步共用同一归属闸门：服务端快照只下发本人任务，
    /// 同事的任务目录在本地只是 git 里的只读镜像，不能判成「本地独有」。
    /// 目录接口回 403 → 记为只读镜像；回「已归档」→ 直接剔除；404 → 真实的本地新增。
    pub(super) async fn gate_local_only_differences(
        &self,
        binding: &AgentBinding,
        differences: &mut Vec<Difference>,
    ) -> AgentResult<()> {
        let task_space_id = binding.task_space_id.clone();
        let readonly_dirs = self.read_cursor(&task_space_id).await.readonly_task_dirs;
        let mut invisible: HashSet<String> = HashSet::new();
        for difference in differences.iter() {
            if difference.kind != DiffKind::LocalOnly {
                continue;
            }
            let task_dir = difference.task_dir.clone();
            if readonly_dirs.contains_key(&task_dir) {
                invisible.insert(task_dir);
                continue;
            }
            match self.fetch_directory(&task_space_id, &task_dir).await {
                Ok(_) => {}
                Err(error) if is_archived_task_error(&error) => {
                    invisible.insert(task_dir);
                }
                Err(error) if is_foreign_task_error(&error) => {
                    let assignee = self.control_assignee(&task_space_id, &task_dir).await;
                    self.mark_readonly_dir(
                        &task_space_id,
                        &task_dir,
                        &readonly_reason("FOREIGN_OWNER", &assignee),
                    )
                    .await?;
                    invisible.insert(task_dir);
                }
                Err(_) => {}
            }
        }
        if !invisible.is_empty() {
            differences.retain(|difference| {
                !(difference.kind == DiffKind::LocalOnly
                    && invisible.contains(&difference.task_dir))
            });
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn complete_initial_sync(
        &self,
        task_space_id: &str,
        mode: &str,
    ) -> AgentResult<()> {
        self.write_cursor(
            task_space_id,
            CursorPatch {
                revision_guard_version: Some(REVISION_GUARD_VERSION),
                ..Default::default()
            },
        )
        .await?;
        let completed_at = protocol::now_iso8601();
        {
            let mut bindings = self.bindings.lock().await;
            if let Some(binding) = bindings.get_mut(task_space_id) {
                binding.initial_sync_mode = mode.to_string();
                binding.initial_sync_completed = true;
                binding.initial_review_pending = false;
                binding.live_sync_status = "ready".into();
                binding.live_sync_error = None;
                binding.last_synced_at = Some(completed_at.clone());
            }
        }
        self.store
            .update_config(true, |current| {
                let Some(config) = current else {
                    return Ok(None);
                };
                let mut next = config.clone();
                for binding in &mut next.bindings {
                    if binding.task_space_id == task_space_id {
                        binding.initial_sync_mode = mode.to_string();
                        binding.initial_sync_completed = true;
                        binding.initial_review_pending = false;
                        binding.live_sync_status = "ready".into();
                        binding.live_sync_error = None;
                        binding.last_synced_at = Some(completed_at.clone());
                    }
                }
                Ok(Some(next))
            })
            .await?;
        self.notify_state_changed();
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn upload_dirty(
        &self,
        task_space_id: &str,
        dirty_paths: &[String],
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let mut task_dirs: HashSet<String> = HashSet::new();
        for dirty_path in dirty_paths {
            let Some(task_dir) = active_task_directory_from_relative(dirty_path) else {
                continue;
            };
            if self.suppressed_event(&binding, dirty_path).await {
                continue;
            }
            task_dirs.insert(task_dir);
        }
        if task_dirs.is_empty() {
            return Ok(Value::Null);
        }
        if !binding.tracked_task_dirs.is_empty() {
            let tracked: HashSet<&str> = binding
                .tracked_task_dirs
                .iter()
                .map(String::as_str)
                .collect();
            task_dirs.retain(|task_dir| tracked.contains(task_dir.as_str()));
        }
        let dirs: Vec<String> = task_dirs.into_iter().collect();
        self.upload_directories(&binding, &dirs, true, None).await
    }
}
impl TaskSync {
    /// 启动或绑定更新后，为已经存在于基线 HEAD 的错分支任务补一次合入证据。
    pub(super) async fn reconcile_baseline_tasks(
        &self,
        task_space_id: &str,
        reconciled_deferred_dirs: &HashSet<String>,
    ) -> AgentResult<Value> {
        let config = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"))?;
        let Some(binding) = config.bindings.into_iter().find(|binding| {
            binding.task_space_id == task_space_id
                && binding.sync_status == "approved"
                && !binding.detach_pending
        }) else {
            return Ok(json!({
                "skipped": true,
                "reason": "BINDING_INACTIVE",
            }));
        };
        if binding.read_only
            || !binding.initial_sync_completed
            || binding.baseline_branch.as_deref() != Some(binding.branch_name.as_str())
        {
            return Ok(json!({
                "skipped": true,
                "reason": "BASELINE_RECONCILIATION_NOT_REQUIRED",
            }));
        }
        let cursor = self.read_cursor(task_space_id).await;
        let indexed_head = {
            self.ensure_ownership_index_loaded().await;
            let index = self.ownership_index.lock().await;
            index
                .bindings
                .get(&binding.local_id)
                .filter(|entry| {
                    entry.task_space_id == binding.task_space_id
                        && entry.repo_path == binding.repo_path
                        && entry.branch_name == binding.branch_name
                        && entry.baseline_branch == binding.baseline_branch
                })
                .map(|entry| (entry.head_commit.clone(), entry.head_fingerprint.clone()))
        };
        if let Some((head_commit, head_fingerprint)) = &indexed_head {
            if !head_commit.is_empty()
                && !head_fingerprint.is_empty()
                && &cursor.baseline_reconciled_head == head_commit
            {
                if std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some() {
                    crate::logging::warn(&format!(
                        "基线任务补交跳过 taskSpaceId={}",
                        binding.task_space_id
                    ));
                }
                return Ok(json!({
                    "skipped": true,
                    "reason": "BASELINE_RECONCILIATION_CURRENT",
                }));
            }
        }
        let groups = self.local_groups(&binding, None).await?;
        let mut task_dirs: Vec<String> = groups
            .iter()
            .filter(|group| {
                !cursor.deferred.contains_key(&group.task_dir)
                    && !reconciled_deferred_dirs.contains(&group.task_dir)
                    && group
                        .task_branch
                        .as_deref()
                        .is_some_and(|branch| branch != binding.branch_name)
            })
            .map(|group| group.task_dir.clone())
            .collect();
        task_dirs.sort_unstable();
        if task_dirs.is_empty() {
            return Ok(json!({
                "skipped": true,
                "reason": "BASELINE_RECONCILIATION_NOT_REQUIRED",
            }));
        }
        let result = self
            .upload_directories(&binding, &task_dirs, false, None)
            .await?;
        if result.get("skipped").and_then(Value::as_bool) == Some(true)
            || result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
        {
            return Ok(result);
        }
        let Some((head_commit, expected_fingerprint)) = indexed_head else {
            return Ok(result);
        };
        if git_head_fingerprint(Path::new(&binding.repo_path))
            .await
            .as_deref()
            != Some(expected_fingerprint.as_str())
        {
            return Ok(result);
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                baseline_reconciled_head: Some(head_commit),
                ..Default::default()
            },
        )
        .await?;
        if std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some() {
            crate::logging::warn(&format!(
                "基线任务补交完成 taskSpaceId={} candidates={}",
                binding.task_space_id,
                task_dirs.len()
            ));
        }
        Ok(result)
    }
}
impl TaskSync {
    pub async fn resolve_initial_sync(
        &self,
        task_space_id: &str,
        mode: &str,
        decisions: &[Value],
    ) -> AgentResult<Value> {
        if mode != "safe" && mode != "review" {
            return protocol::err(code::COMMAND_INVALID, "首次同步处理方式无效");
        }
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        let snapshot = self.fetch_snapshot(task_space_id, 0).await?;
        let controls = parse_snapshot_controls(&snapshot)?;
        if let Some(controls) = &controls {
            self.merge_task_controls(&binding, controls).await?;
            self.release_inactive_task_leases(Some(controls)).await;
            self.process_handoff_controls(&binding, controls).await?;
        }
        let local_groups = self.local_groups(&binding, None).await?;
        let snapshot_files = parse_snapshot_files(&snapshot)?;
        let server_files: Vec<SnapshotFile> = snapshot_files
            .iter()
            .filter(|file| !file.deleted)
            .cloned()
            .collect();
        let mut server_groups = groups_from_structs(&server_files)?;
        retain_server_groups_for_initial_sync(&binding, &local_groups, &mut server_groups);
        self.prepare_controlled_server_groups(&binding, controls.as_deref(), &mut server_groups)
            .await?;
        let snapshot_baselines = baselines_from_snapshot(&snapshot_files);
        let mut differences = hide_control_tombstone_local_only(
            classify_task_snapshots(&local_groups, &server_groups),
            controls.as_deref(),
        );
        self.gate_local_only_differences(&binding, &mut differences)
            .await?;

        if mode == "safe" {
            let server_only: Vec<SnapshotGroup> = differences
                .iter()
                .filter(|item| {
                    item.kind == DiffKind::ServerOnly
                        && item
                            .server
                            .as_ref()
                            .and_then(|group| group.task_id.as_ref())
                            .is_some()
                })
                .filter_map(|item| item.server.clone())
                .collect();
            self.apply_server_groups(
                &binding,
                snapshot_revision(&snapshot),
                &server_only,
                "safe",
                false,
            )
            .await?;
            let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
            for difference in &differences {
                if matches!(difference.kind, DiffKind::Same | DiffKind::ServerOnly) {
                    continue;
                }
                if let Some(local) = &difference.local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
            }
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(snapshot_revision(&snapshot)),
                    baselines: Some(snapshot_baselines),
                    deferred: Some(deferred),
                    ..Default::default()
                },
            )
            .await?;
            self.write_server_cursor(task_space_id, snapshot_revision(&snapshot))
                .await?;
            self.complete_initial_sync(task_space_id, mode).await?;
            let actionable = differences
                .iter()
                .filter(|item| item.kind != DiffKind::Same)
                .count();
            return Ok(json!({
                "taskSpaceId": task_space_id,
                "mode": mode,
                "revision": snapshot_revision(&snapshot),
                "downloaded": server_only.len(),
                "skipped": actionable.saturating_sub(server_only.len()),
            }));
        }

        let mut decision_map: HashMap<String, String> = HashMap::new();
        for decision in decisions {
            let key = decision
                .get("taskId")
                .and_then(Value::as_str)
                .or_else(|| decision.get("taskDir").and_then(Value::as_str))
                .unwrap_or_default()
                .to_string();
            let action = decision
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("skip")
                .to_string();
            decision_map.insert(key, action);
        }
        let latest_revision = snapshot_revision(&snapshot);
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        let mut deferred: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let (mut downloaded, mut uploaded, mut saved_local, mut skipped) = (0u32, 0u32, 0u32, 0u32);
        for difference in &differences {
            if difference.kind == DiffKind::Same {
                continue;
            }
            let action = decision_map
                .get(&difference.action_key())
                .cloned()
                .unwrap_or_else(|| "skip".into());
            let local = difference.local.clone();
            let server = difference.server.clone();
            if action == "skip" {
                if let Some(local) = &local {
                    deferred.insert(local.task_dir.clone(), file_state_from_group(local));
                }
                skipped += 1;
                continue;
            }
            if difference.kind == DiffKind::ServerOnly || action == "use-server" {
                if let (Some(local), Some(server)) = (&local, &server) {
                    if local.task_dir != server.task_dir {
                        self.backup_directory(&binding, &local.task_dir).await?;
                    }
                }
                let groups: Vec<SnapshotGroup> = server
                    .as_ref()
                    .filter(|group| !group.files.is_empty())
                    .cloned()
                    .into_iter()
                    .collect();
                self.apply_server_groups(
                    &binding,
                    snapshot_revision(&snapshot),
                    &groups,
                    "safe",
                    false,
                )
                .await?;
                if let (Some(local), Some(server)) = (&local, &server) {
                    if local.task_dir != server.task_dir {
                        self.remove_task_directory(&binding, &local.task_dir)
                            .await?;
                    }
                }
                downloaded += 1;
                continue;
            }
            if difference.kind == DiffKind::LocalOnly || action == "use-local" {
                let Some(local) = local.clone() else {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务目录不存在");
                };
                let result = self
                    .upload_reviewed_local_task(&binding, &local, server.as_ref())
                    .await?;
                if result.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(json!({
                        "taskSpaceId": task_space_id,
                        "mode": mode,
                        "revision": latest_revision,
                        "downloaded": downloaded,
                        "uploaded": uploaded,
                        "savedLocal": saved_local,
                        "skipped": skipped + 1,
                        "pendingReview": true,
                        "reason": result.get("reason").cloned().unwrap_or(Value::Null),
                    }));
                }
                baseline_files.extend(self.last_baseline_files.lock().await.clone());
                uploaded += 1;
                continue;
            }
            if action == "save-local" {
                let Some(local) = local.clone() else {
                    return protocol::err(code::INVALID_RESPONSE, "本地任务目录不存在");
                };
                self.backup_directory(&binding, &local.task_dir).await?;
                deferred.insert(local.task_dir.clone(), file_state_from_group(&local));
                saved_local += 1;
            }
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                revision: Some(latest_revision),
                baselines: Some(merge_baselines(&snapshot_baselines, &baseline_files)),
                deferred: Some(deferred),
                ..Default::default()
            },
        )
        .await?;
        self.write_server_cursor(task_space_id, latest_revision)
            .await?;
        self.complete_initial_sync(task_space_id, mode).await?;
        Ok(json!({
            "taskSpaceId": task_space_id,
            "mode": mode,
            "revision": latest_revision,
            "downloaded": downloaded,
            "uploaded": uploaded,
            "savedLocal": saved_local,
            "skipped": skipped,
        }))
    }
}
impl TaskSync {
    pub(super) async fn upload_reviewed_local_task(
        &self,
        binding: &AgentBinding,
        local: &SnapshotGroup,
        server: Option<&SnapshotGroup>,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let reviewed_baselines = server
            .map(|group| baselines_from_snapshot(&group.files))
            .unwrap_or_default();
        if server.is_some_and(|group| group.task_dir == local.task_dir) {
            return self
                .upload_directories(
                    binding,
                    std::slice::from_ref(&local.task_dir),
                    false,
                    Some(&reviewed_baselines),
                )
                .await;
        }
        let ownership = self
            .resolve_task_ownership(binding, std::slice::from_ref(local))
            .await?;
        if !ownership.syncable.contains_key(&local.task_dir) {
            return Ok(json!({
                "skipped": true,
                "reason": if ownership.paused.is_empty() {
                    "TASK_OWNERSHIP_REQUIRED"
                } else {
                    "TASK_BRANCH_OTHER"
                },
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
            }));
        }
        let server_files = match server {
            Some(group) => {
                let directory = self
                    .fetch_directory(&task_space_id, &group.task_dir)
                    .await
                    .map_err(|error| with_task_dir(error, &group.task_dir))?;
                parse_directory_files(&directory, &group.task_dir)?
            }
            None => Vec::new(),
        };
        let cursor = self.read_cursor(&task_space_id).await;
        let mut files: Vec<UploadFile> = local
            .files
            .iter()
            .map(|file| UploadFile {
                path: file.path.clone(),
                content: file.content.clone(),
                sha256: file.sha256.clone(),
                deleted: false,
                base_sha256: None,
            })
            .collect();
        for file in &server_files {
            files.push(UploadFile {
                path: file.path.clone(),
                content: String::new(),
                sha256: snapshot_sha256(""),
                deleted: true,
                base_sha256: Some(file.sha256.clone()),
            });
        }
        let values: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
        Ok(self
            .upload_persisted_batch(
                binding,
                &cursor,
                values,
                ownership.merge_evidence.get(&local.task_dir).cloned(),
            )
            .await?
            .unwrap_or(Value::Null))
    }
}
pub(super) fn should_pull_for_event(
    initial_sync_completed: bool,
    initial_review_pending: bool,
    cursor_revision: u64,
    event_revision: Option<u64>,
    has_pending_upload: bool,
) -> bool {
    let Some(event_revision) = event_revision else {
        return true;
    };
    !initial_sync_completed
        || initial_review_pending
        || has_pending_upload
        || event_revision > cursor_revision
}
pub(super) fn initial_sync_mode(binding: &AgentBinding) -> String {
    if matches!(
        binding.initial_sync_mode.as_str(),
        "bootstrap" | "safe" | "review"
    ) {
        return binding.initial_sync_mode.clone();
    }
    if binding.initial_review_pending {
        "review".into()
    } else {
        "safe".into()
    }
}
pub(super) fn retain_server_groups_for_binding(
    binding: &AgentBinding,
    groups: &mut Vec<SnapshotGroup>,
) {
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && group
                .task_branch
                .as_deref()
                .map(|branch| branch == binding.branch_name)
                .unwrap_or(true)
    });
}
pub(super) fn binding_is_baseline(binding: &AgentBinding) -> bool {
    binding.baseline_branch.as_deref() == Some(binding.branch_name.as_str())
}
pub(super) fn allows_cross_source_server_group(binding: &AgentBinding, mode: &str) -> bool {
    binding_is_baseline(binding) && (mode == REVISION_GUARD_SYNC_MODE || mode == CONFLICT_SYNC_MODE)
}
/// 一次性全量对账必须保住基线任务空间里已由服务端接纳的跨来源任务；
/// 普通增量同步仍按当前绑定分支过滤。
pub(super) fn retain_server_groups_for_revision_guard(
    binding: &AgentBinding,
    groups: &mut Vec<SnapshotGroup>,
) {
    let allow_cross_branch = binding_is_baseline(binding);
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && (allow_cross_branch
                || group
                    .task_branch
                    .as_deref()
                    .map(|branch| branch == binding.branch_name)
                    .unwrap_or(true))
    });
}
/// 首次同步的差异分类：`task.json` 记录的 `branch` 是任务当时的开发分支；
/// 归档任务已退出客户端同步，只有本地存在的同目录活动任务才保留跨分支组。
pub(crate) fn retain_server_groups_for_branch_initial_sync(
    branch_name: &str,
    local_groups: &[SnapshotGroup],
    groups: &mut Vec<SnapshotGroup>,
) {
    groups.retain(|group| {
        !group.archived
            && !is_archive_task_dir(&group.task_dir)
            && (group
                .task_branch
                .as_deref()
                .map(|branch| branch == branch_name)
                .unwrap_or(true)
                || local_groups
                    .iter()
                    .any(|local| local.task_dir == group.task_dir))
    });
}
pub(super) fn retain_server_groups_for_initial_sync(
    binding: &AgentBinding,
    local_groups: &[SnapshotGroup],
    groups: &mut Vec<SnapshotGroup>,
) {
    retain_server_groups_for_branch_initial_sync(&binding.branch_name, local_groups, groups);
}
pub(super) fn hide_control_tombstone_local_only(
    differences: Vec<Difference>,
    controls: Option<&[TaskControl]>,
) -> Vec<Difference> {
    let Some(controls) = controls else {
        return differences;
    };
    let blocked: HashSet<&str> = controls
        .iter()
        .filter(|control| !control.is_writable_local())
        .map(|control| control.relative_dir.as_str())
        .collect();
    differences
        .into_iter()
        .filter(|difference| {
            !(difference.kind == DiffKind::LocalOnly
                && difference
                    .local
                    .as_ref()
                    .is_some_and(|group| blocked.contains(group.task_dir.as_str())))
        })
        .collect()
}
pub(super) fn inactive_control_dirs(controls: Option<&[TaskControl]>) -> HashSet<String> {
    controls
        .unwrap_or_default()
        .iter()
        .filter(|control| !control.is_writable_local())
        .filter(|control| !is_archive_task_dir(&control.relative_dir))
        .map(|control| control.relative_dir.clone())
        .collect()
}
pub(super) fn snapshot_revision(snapshot: &Value) -> u64 {
    snapshot
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0)
}
