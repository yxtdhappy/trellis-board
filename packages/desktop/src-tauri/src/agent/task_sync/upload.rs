use super::*;

impl TaskSync {
    pub(super) async fn upload_directories(
        &self,
        binding: &AgentBinding,
        task_dirs: &[String],
        reconcile: bool,
        base_sha: Option<&BTreeMap<String, String>>,
    ) -> AgentResult<Value> {
        let started = Instant::now();
        self.assert_binding_branch(binding).await?;
        let task_space_id = binding.task_space_id.clone();
        let cursor_started = Instant::now();
        self.migrate_cursor_archive_state(&task_space_id).await?;
        let mut cursor = self.read_cursor(&task_space_id).await;
        sync_trace(
            &task_space_id,
            "upload-cursor",
            cursor_started,
            json!({
                "trigger": "upload",
                "revision": cursor.revision,
                "hasPending": cursor.pending.is_some(),
            }),
        );
        let mut applied_revision = cursor.revision;
        let mut committed_revision = 0u64;
        let mut baseline_files: Vec<SnapshotFile> = Vec::new();
        let mut prehandled_dirs = HashSet::new();
        let mut pending_outcome = None;
        let mut last_nonblocking_skip = None;
        let mut uploaded_any = false;
        if let Some(pending) = cursor.pending.clone() {
            let retry_files = pending.files.clone();
            let retry_dirs = pending_task_dirs(&retry_files);
            if let Some(result) = self.retry_pending_batch(binding, pending).await? {
                let pending_after = self.read_cursor(&task_space_id).await.pending;
                if pending_after.is_some()
                    || result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT")
                {
                    return Ok(result);
                }
                if result.get("skipped").and_then(Value::as_bool) != Some(true) {
                    committed_revision = committed_revision.max(
                        result
                            .get("revision")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                    );
                    baseline_files.extend(parse_snapshot_files_from_values(&retry_files)?);
                }
                prehandled_dirs.extend(retry_dirs);
                pending_outcome = Some(result);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }
        if cursor.revision_guard_version < REVISION_GUARD_VERSION
            && binding.initial_sync_completed
        {
            return Box::pin(self.repair_revision_guard(binding)).await;
        }

        self.ensure_task_control_loaded().await;
        let inactive_control_dirs: HashSet<String> = {
            let state = self.task_control_state.lock().await;
            state
                .controls_for_binding(&binding.local_id, &binding.task_space_id)
                .filter(|(_, control)| !control.control_state().is_writable_local())
                .map(|(_, control)| control.relative_dir.clone())
                .collect()
        };
        let readonly_dirs: HashSet<String> = cursor.readonly_task_dirs.keys().cloned().collect();
        let requested: HashSet<String> = task_dirs
            .iter()
            .filter(|task_dir| !is_archive_task_dir(task_dir))
            .filter(|task_dir| !inactive_control_dirs.contains(*task_dir))
            .filter(|task_dir| !readonly_dirs.contains(*task_dir))
            .filter(|task_dir| !prehandled_dirs.contains(*task_dir))
            .cloned()
            .collect();
        if requested.is_empty() {
            if let Some(result) = pending_outcome {
                return Ok(result);
            }
            return Ok(json!({
                "skipped": true,
                "reason": if task_dirs.iter().all(|task_dir| {
                    is_archive_task_dir(task_dir) || inactive_control_dirs.contains(task_dir)
                }) {
                    "TASK_CONTROL_INACTIVE"
                } else {
                    "ARCHIVE_SYNC_SERVER_MANAGED"
                },
            }));
        }
        let local_started = Instant::now();
        let local_groups = self
            .local_groups(binding, Some(&requested))
            .await?;
        sync_trace(
            &task_space_id,
            "upload-local",
            local_started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "localGroups": local_groups.len(),
            }),
        );
        let ownership_started = Instant::now();
        let ownership = self.resolve_task_ownership(binding, &local_groups).await?;
        sync_trace(
            &task_space_id,
            "upload-ownership",
            ownership_started,
            json!({
                "trigger": "upload",
                "syncable": ownership.syncable.len(),
                "paused": ownership.paused.len(),
                "reviews": ownership.reviews.len(),
            }),
        );
        let blocked_dirs: HashSet<String> = cursor.conflict_blocked.keys().cloned().collect();
        let allowed: Vec<String> = requested
            .iter()
            .filter(|task_dir| {
                if blocked_dirs.contains(*task_dir) {
                    return false;
                }
                !local_groups
                    .iter()
                    .any(|group| &group.task_dir == *task_dir)
                    || ownership.syncable.contains_key(*task_dir)
            })
            .cloned()
            .collect();
        if allowed.is_empty() {
            let reason = if !ownership.reviews.is_empty() || !ownership.invalid.is_empty() {
                "TASK_OWNERSHIP_REQUIRED"
            } else if !ownership.paused.is_empty() {
                "TASK_BRANCH_OTHER"
            } else {
                "TASK_CONFLICT_PENDING"
            };
            return Ok(json!({
                "skipped": true,
                "reason": reason,
                "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                "invalid": ownership.invalid,
            }));
        }
        let local_by_dir: HashMap<String, SnapshotGroup> = local_groups
            .iter()
            .cloned()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut entries: Vec<(String, Option<SnapshotGroup>, Vec<SnapshotFile>)> = Vec::new();
        let unique: HashSet<String> = allowed.into_iter().collect();
        let http_started = Instant::now();
        let mut archived_dirs: Vec<String> = Vec::new();
        for task_dir in unique {
            let server_files = match self.fetch_directory(&task_space_id, &task_dir).await {
                Ok(server) => parse_directory_files(&server, &task_dir)?,
                Err(error) if error.status == Some(404) => Vec::new(),
                Err(error) if is_foreign_task_error(&error) => {
                    let assignee = self.control_assignee(&task_space_id, &task_dir).await;
                    self.mark_readonly_dir(
                        &task_space_id,
                        &task_dir,
                        &readonly_reason("FOREIGN_OWNER", &assignee),
                    )
                    .await?;
                    crate::logging::warn(&format!(
                        "跳过他人任务目录（只读镜像）：{task_dir} {}",
                        protocol::safe_error_message(&error.message)
                    ));
                    continue;
                }
                Err(error) if is_archived_task_error(&error) => {
                    archived_dirs.push(task_dir.clone());
                    continue;
                }
                Err(error) => return Err(with_task_dir(error, &task_dir)),
            };
            entries.push((
                task_dir.clone(),
                local_by_dir.get(&task_dir).cloned(),
                server_files,
            ));
        }
        for task_dir in &archived_dirs {
            self.cleanup_archived_residue(binding, task_dir).await;
        }
        sync_trace(
            &task_space_id,
            "upload-http",
            http_started,
            json!({
                "trigger": "upload",
                "directories": entries.len(),
            }),
        );

        let mut handled: HashSet<String> = HashSet::new();
        for (source, target) in move_pairs(&entries) {
            let mut files = build_directory_files(
                &source.0,
                None,
                &source.2,
                base_sha.unwrap_or(&cursor.baselines),
            );
            files.extend(build_directory_files(
                &target.0,
                target.1.as_ref(),
                &target.2,
                base_sha.unwrap_or(&cursor.baselines),
            ));
            let value: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
            let evidence = ownership
                .merge_evidence
                .get(&target.0)
                .or_else(|| ownership.merge_evidence.get(&source.0))
                .cloned();
            if let Some(uploaded) = self
                .upload_persisted_batch(binding, &cursor, value, evidence)
                .await?
            {
                if skipped_for_explicit_pending_rejection(&uploaded) {
                    if self.read_cursor(&task_space_id).await.pending.is_none() {
                        handled.insert(source.0.clone());
                        handled.insert(target.0.clone());
                        last_nonblocking_skip = Some(uploaded);
                        continue;
                    }
                }
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                uploaded_any = true;
                handled.insert(source.0.clone());
                handled.insert(target.0.clone());
                committed_revision = committed_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
                baseline_files.extend(uploads_to_snapshot_files(&files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        for (task_dir, local, server_files) in &entries {
            if handled.contains(task_dir) {
                continue;
            }
            let files = build_directory_files(
                task_dir,
                local.as_ref(),
                server_files,
                base_sha.unwrap_or(&cursor.baselines),
            );
            let value: Vec<Value> = files.iter().map(UploadFile::to_value).collect();
            let evidence = ownership.merge_evidence.get(task_dir).cloned();
            if let Some(uploaded) = self
                .upload_persisted_batch(binding, &cursor, value, evidence)
                .await?
            {
                if skipped_for_explicit_pending_rejection(&uploaded) {
                    if self.read_cursor(&task_space_id).await.pending.is_none() {
                        last_nonblocking_skip = Some(uploaded);
                        continue;
                    }
                }
                if uploaded.get("skipped").and_then(Value::as_bool) == Some(true) {
                    return Ok(uploaded);
                }
                if uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
                    return Ok(uploaded);
                }
                uploaded_any = true;
                committed_revision = committed_revision.max(
                    uploaded
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                );
                baseline_files.extend(uploads_to_snapshot_files(&files)?);
                cursor = self.read_cursor(&task_space_id).await;
            }
        }

        self.last_baseline_files
            .lock()
            .await
            .clone_from(&baseline_files);
        sync_trace(
            &task_space_id,
            "upload",
            started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "baselineFiles": baseline_files.len(),
                "revision": applied_revision,
                "committedRevision": committed_revision,
            }),
        );

        if reconcile {
            Box::pin(self.pull(binding)).await?;
            applied_revision = self.read_cursor(&task_space_id).await.revision;
        }
        if !uploaded_any {
            if let Some(result) = last_nonblocking_skip {
                return Ok(result);
            }
        }
        sync_trace(
            &task_space_id,
            "upload-total",
            started,
            json!({
                "trigger": "upload",
                "targetDirs": requested.len(),
                "reconcile": reconcile,
                "revision": applied_revision,
                "committedRevision": committed_revision,
            }),
        );
        Ok(json!({
            "revision": applied_revision,
            "committedRevision": committed_revision,
            "sequence": cursor.sequence,
            "baselineFiles": baseline_files.iter().map(|file| json!({
                "path": file.path,
                "sha256": file.sha256,
            })).collect::<Vec<_>>(),
        }))
    }
}
impl TaskSync {
    pub(super) async fn upload_persisted_batch(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        files: Vec<Value>,
        merge_evidence: Option<Value>,
    ) -> AgentResult<Option<Value>> {
        if files.is_empty() {
            return Ok(None);
        }
        validate_upload_batch(&files)?;
        let batch = PendingBatch {
            batch_id: uuid::Uuid::new_v4().to_string(),
            client_sequence: next_client_sequence(cursor.sequence),
            files,
            merge_evidence,
            created_at: protocol::now_iso8601(),
        };
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                revision: Some(cursor.revision),
                sequence: Some(cursor.sequence),
                pending: Some(Some(batch.clone())),
                ..Default::default()
            },
        )
        .await?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::New).await?,
        ))
    }
}
impl TaskSync {
    pub(super) async fn upload_preclassified_batch(
        &self,
        binding: &AgentBinding,
        cursor: &Cursor,
        files: Vec<Value>,
        merge_evidence: Option<Value>,
    ) -> AgentResult<Option<Value>> {
        if files.is_empty() {
            return Ok(None);
        }
        validate_upload_batch(&files)?;
        let batch = PendingBatch {
            batch_id: uuid::Uuid::new_v4().to_string(),
            client_sequence: next_client_sequence(cursor.sequence),
            files,
            merge_evidence,
            created_at: protocol::now_iso8601(),
        };
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                pending: Some(Some(batch.clone())),
                ..Default::default()
            },
        )
        .await?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::Preclassified)
                .await?,
        ))
    }
}
impl TaskSync {
    pub(super) async fn retry_pending_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
    ) -> AgentResult<Option<Value>> {
        validate_upload_batch(&batch.files)?;
        Ok(Some(
            self.upload_batch(binding, batch, UploadMode::Replay)
                .await?,
        ))
    }
}
impl TaskSync {
    pub(super) async fn upload_batch(
        &self,
        binding: &AgentBinding,
        batch: PendingBatch,
        mode: UploadMode,
    ) -> AgentResult<Value> {
        let task_space_id = binding.task_space_id.clone();
        let mut execution_task_keys =
            execution_task_keys_from_upload(&task_space_id, &batch.files)?;
        if execution_task_keys.is_empty() {
            if let Some(execution_task_key) = self
                .persisted_control_key_for_upload(binding, &batch.files)
                .await?
            {
                execution_task_keys.insert(execution_task_key);
            }
        }
        if execution_task_keys.len() > 1 {
            return protocol::err(
                code::INVALID_RESPONSE,
                "单个上传批次不能包含多个执行任务身份",
            );
        }
        let upload_execution_task_key = execution_task_keys.iter().next().cloned();
        let mut fence = None;
        if let Some(execution_task_key) = upload_execution_task_key.as_ref() {
            if let Some(control) = self
                .remote_task_control(binding, execution_task_key)
                .await?
            {
                if !control.is_writable_local() {
                    self.write_cursor(
                        &task_space_id,
                        CursorPatch {
                            pending: Some(None),
                            ..Default::default()
                        },
                    )
                    .await?;
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_CONTROL_INACTIVE",
                        "controlState": control.state,
                    }));
                }
                let fenced = if let Some(stored_lease) = self
                    .stored_task_lease(execution_task_key)
                    .await
                {
                    match self
                        .heartbeat_remote_task(
                            binding,
                            execution_task_key,
                            &stored_lease.token,
                        )
                        .await
                    {
                        Ok(value) => Ok(value),
                        Err(error)
                            if matches!(
                                error.server_code.as_deref(),
                                Some("TASK_LEASE_INVALID")
                                    | Some("TASK_LEASE_REQUIRED")
                            ) =>
                        {
                            self.claim_remote_task(binding, execution_task_key)
                                .await
                        }
                        Err(error) => Err(error),
                    }
                } else {
                    self.claim_remote_task(binding, execution_task_key)
                        .await
                };
                match fenced {
                    Ok((claimed, lease_token)) => {
                        fence = Some(UploadFence {
                            task_version: claimed.task_version,
                            lease_token,
                        });
                    }
                    Err(error)
                        if matches!(
                            error.server_code.as_deref(),
                            Some("TASK_ARCHIVED")
                                | Some("TASK_WRITE_FORBIDDEN")
                                | Some("FORBIDDEN")
                        ) =>
                    {
                        self.write_cursor(
                            &task_space_id,
                            CursorPatch {
                                pending: Some(None),
                                ..Default::default()
                            },
                        )
                        .await?;
                        return Ok(json!({
                            "skipped": true,
                            "reason": error.server_code,
                            "message": error.message,
                        }));
                    }
                    Err(error)
                        if matches!(
                            error.server_code.as_deref(),
                            Some("TASK_LEASE_HELD") | Some("TASK_LEASE_INVALID")
                        ) =>
                    {
                        return Ok(json!({
                            "skipped": true,
                            "reason": error.server_code,
                            "message": error.message,
                        }));
                    }
                    Err(error) => return Err(error),
                }
            } else if self.has_persisted_task_control(execution_task_key).await {
                self.write_cursor(
                    &task_space_id,
                    CursorPatch {
                        pending: Some(None),
                        ..Default::default()
                    },
                )
                .await?;
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_CONTROL_MISSING",
                    "message": "服务端已没有该任务控制记录，本地任务保留并停止自动上传",
                }));
            }
        }
        let task_dirs = pending_task_dirs(&batch.files);
        let cursor = self.read_cursor(&task_space_id).await;
        let blocked: Vec<Value> = task_dirs
            .iter()
            .filter_map(|task_dir| {
                cursor
                    .conflict_blocked
                    .get(task_dir)
                    .map(|conflict_id| json!({ "taskDir": task_dir, "conflictId": conflict_id }))
            })
            .collect();
        if !blocked.is_empty() {
            return Ok(json!({
                "skipped": true,
                "reason": "TASK_CONFLICT_PENDING",
                "blocked": blocked,
            }));
        }
        if mode == UploadMode::New {
            let local_groups = self.local_groups(binding, Some(&task_dirs)).await?;
            for group in &local_groups {
                let Some(current_task_json) = group
                    .files
                    .iter()
                    .find(|file| file.file_path == "task.json" && !file.deleted)
                else {
                    continue;
                };
                let Some(pending_task_json) = batch.files.iter().find(|file| {
                    file.get("path").and_then(Value::as_str)
                        == Some(current_task_json.path.as_str())
                }) else {
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_OWNERSHIP_PENDING_MISMATCH",
                        "taskDir": group.task_dir,
                    }));
                };
                let pending_branch = pending_task_json
                    .get("content")
                    .and_then(Value::as_str)
                    .map(parse_task_metadata)
                    .and_then(|metadata| metadata.1);
                let current_branch = parse_task_metadata(&current_task_json.content).1;
                if pending_branch != current_branch {
                    return Ok(json!({
                        "skipped": true,
                        "reason": "TASK_OWNERSHIP_PENDING_MISMATCH",
                        "taskDir": group.task_dir,
                    }));
                }
            }
            let ownership = self.resolve_task_ownership(binding, &local_groups).await?;
            if local_groups.iter().any(|group| {
                !ownership.syncable.contains_key(&group.task_dir)
                    && !ownership
                        .paused
                        .iter()
                        .any(|paused| paused.task_dir == group.task_dir)
            }) {
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_OWNERSHIP_REQUIRED",
                    "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
                    "invalid": ownership.invalid,
                }));
            }
            if !ownership.paused.is_empty() {
                return Ok(json!({
                    "skipped": true,
                    "reason": "TASK_BRANCH_OTHER",
                    "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                }));
            }
        }
        let mut active_sequence = batch.client_sequence;
        let mut sequence_recovered = false;
        let mut retry_delay = Duration::ZERO;
        let mut attempt = 0u32;
        let result = loop {
            // 每次尝试都重新校验分支，并把实际分支名带给服务端。
            let observed = self.assert_binding_branch(binding).await?;
            let request =
                build_upload_request(&batch, active_sequence, &observed, fence.as_ref());
            match self
                .upload_with_slot(&task_space_id, retry_delay, &request)
                .await
            {
                Ok(value) => break value,
                Err(error) if error.server_code.as_deref() == Some("TASK_FILE_CONFLICT") => {
                    break json!({
                        "code": "TASK_FILE_CONFLICT",
                        "conflictId": error.conflict_id,
                        "message": error.message,
                        "details": error.details,
                    });
                }
                Err(error) if error.server_code.as_deref() == Some("TASK_OWNED_BY_BASELINE") => {
                    if let Some(task_id) = error
                        .details
                        .as_ref()
                        .and_then(|details| details.get("taskId"))
                        .and_then(Value::as_str)
                    {
                        self.mark_baseline_owned(&task_space_id, task_id).await;
                    }
                    break json!({
                        "skipped": true,
                        "reason": "TASK_OWNED_BY_BASELINE",
                        "details": error.details,
                    });
                }
                Err(error)
                    if error
                        .server_code
                        .as_deref()
                        .is_some_and(is_explicit_pending_rejection) =>
                {
                    break json!({
                        "skipped": true,
                        "rejected": true,
                        "reason": error.server_code,
                        "message": error.message,
                        "details": error.details,
                    });
                }
                Err(error) if error.status == Some(429) && error.retryable => {
                    if attempt >= MAX_RATE_LIMIT_RETRIES {
                        return Err(error);
                    }
                    attempt += 1;
                    retry_delay = error
                        .retry_after_ms
                        .map(|value| {
                            Duration::from_millis(
                                value.min(RATE_LIMIT_RETRY_MAX_DELAY.as_millis() as u64),
                            )
                        })
                        .unwrap_or(RATE_LIMIT_RETRY_DELAY);
                }
                Err(error) => {
                    // 游标落后于服务端时，按服务端给出的最小序号改写待上传批次后重试一次。
                    let required = required_client_sequence(&error);
                    match required {
                        Some(required) if !sequence_recovered && required > active_sequence => {
                            crate::logging::warn(&format!(
                                "上传序号落后于服务端，改用 {required} 重试 {}",
                                batch.batch_id
                            ));
                            self.update_pending_client_sequence(
                                &task_space_id,
                                &batch.batch_id,
                                required,
                            )
                            .await?;
                            active_sequence = required;
                            sequence_recovered = true;
                            let _ = self.read_cursor(&task_space_id).await;
                            retry_delay = Duration::ZERO;
                        }
                        _ => return Err(error),
                    }
                }
            }
        };

        let mut persisted_execution_task_key = upload_execution_task_key.clone();
        if let Some(task) = result
            .get("control")
            .and_then(|control| control.get("task"))
            .filter(|task| !task.is_null())
        {
            let control = TaskControl::from_task_value(task)?;
            persisted_execution_task_key = Some(response_control_execution_task_key(
                upload_execution_task_key.as_deref(),
                &control,
            )?);
            self.upsert_task_control(binding, &control).await?;
        }
        if let Some(execution_task_key) = persisted_execution_task_key.as_deref() {
            if let Some(lease) = result.get("lease").filter(|lease| !lease.is_null()) {
                self.save_task_lease(execution_task_key, lease.clone()).await?;
            }
            if let Some(task_version) = result.get("taskVersion").and_then(Value::as_u64) {
                self.update_control_task_version(execution_task_key, task_version)
                    .await?;
            }
        }
        let cursor = self.read_cursor(&task_space_id).await;
        if let Some(reason) = result
            .get("reason")
            .and_then(Value::as_str)
            .filter(|value| is_explicit_pending_rejection(value))
        {
            let rejected_batch = PendingBatch {
                client_sequence: active_sequence,
                ..batch.clone()
            };
            self.settle_rejected_pending(binding, &rejected_batch, reason)
                .await?;
            return Ok(result);
        }
        if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
            self.mark_conflict_blocked(&task_space_id, &result, &batch.files)
                .await?;
            let files = parse_snapshot_files_from_values(&batch.files)?;
            self.write_cursor(
                &task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision),
                    sequence: Some(active_sequence),
                    deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                    pending: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            (self.emit)(json!({
                "type": "task_file_conflict",
                "taskSpaceId": task_space_id,
                "conflict": conflict_summary(&result),
            }));
            return Ok(result);
        }

        let files = parse_snapshot_files_from_values(&batch.files)?;
        {
            let mut suppressed = self.suppressed.lock().await;
            for file in &files {
                suppressed.insert(
                    absolute_task_path(binding, &file.path),
                    if file.deleted {
                        None
                    } else {
                        Some(file.sha256.clone())
                    },
                );
            }
        }
        let baselines = merge_baselines(&cursor.baselines, &files);
        let mut ownership_pending = cursor.ownership_pending.clone();
        let mut pending_rejected = cursor.pending_rejected.clone();
        for task_dir in &task_dirs {
            ownership_pending.remove(task_dir);
            pending_rejected.remove(task_dir);
        }
        self.write_cursor(
            &task_space_id,
            CursorPatch {
                revision: Some(cursor.revision),
                sequence: Some(active_sequence),
                baselines: Some(baselines),
                deferred: Some(clear_deferred_for_files(&cursor.deferred, &files)),
                pending: Some(None),
                pending_rejected: Some(pending_rejected),
                ownership_pending: Some(ownership_pending),
                ..Default::default()
            },
        )
        .await?;
        self.last_baseline_files.lock().await.clone_from(&files);
        Ok(result)
    }
}
impl TaskSync {
    pub(super) async fn upload_with_slot(
        &self,
        task_space_id: &str,
        delay: Duration,
        request: &Value,
    ) -> AgentResult<Value> {
        loop {
            let wait_for = {
                let gate = self.upload_gate.lock().await;
                let now = Instant::now();
                let ready_at = gate
                    .get(task_space_id)
                    .copied()
                    .map(|next| next.max(now + delay))
                    .unwrap_or(now + delay);
                if ready_at > now {
                    Some(ready_at - now)
                } else {
                    None
                }
            };
            match wait_for {
                Some(duration) => tokio::time::sleep(duration).await,
                None => {
                    let mut gate = self.upload_gate.lock().await;
                    let now = Instant::now();
                    let ready = gate
                        .get(task_space_id)
                        .copied()
                        .map(|next| next <= now)
                        .unwrap_or(true);
                    if !ready {
                        continue;
                    }
                    gate.insert(task_space_id.to_string(), now + UPLOAD_MIN_INTERVAL);
                    break;
                }
            }
        }
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/changes"),
                Some(request),
                Duration::from_secs(120),
            )
            .await
    }
}
pub(super) fn execution_task_keys_from_upload(
    task_space_id: &str,
    files: &[Value],
) -> AgentResult<BTreeSet<String>> {
    let mut task_ids = BTreeSet::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str) else {
            continue;
        };
        if file.get("deleted").and_then(Value::as_bool) == Some(true)
            || !path.ends_with("/task.json")
        {
            continue;
        }
        let Some(content) = file.get("content").and_then(Value::as_str) else {
            continue;
        };
        let document: Value = serde_json::from_str(content)
            .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "task.json 不是合法 JSON"))?;
        let task_id = document
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "task.json 缺少 id"))?;
        task_ids.insert(format!("{task_space_id}::{task_id}"));
    }
    Ok(task_ids)
}
pub(super) fn response_control_execution_task_key(
    requested: Option<&str>,
    control: &TaskControl,
) -> AgentResult<String> {
    if let Some(requested) = requested {
        if requested != control.execution_task_key {
            return protocol::err(code::INVALID_RESPONSE, "任务上传响应的执行身份不一致");
        }
        return Ok(requested.to_string());
    }
    Ok(control.execution_task_key.clone())
}
pub(super) fn build_upload_request(
    batch: &PendingBatch,
    client_sequence: u64,
    observed_branch_name: &str,
    fence: Option<&UploadFence>,
) -> Value {
    let mut request = json!({
        "batchId": batch.batch_id,
        "clientSequence": client_sequence,
        "files": batch.files,
        "observedBranchName": observed_branch_name,
    });
    if let Some(evidence) = &batch.merge_evidence {
        request["mergeEvidence"] = evidence.clone();
    }
    if let Some(fence) = fence {
        fence.apply(&mut request);
    }
    request
}
pub(super) fn pending_task_dirs(files: &[Value]) -> HashSet<String> {
    files
        .iter()
        .filter_map(|file| {
            file.get("path")
                .and_then(Value::as_str)
                .and_then(active_task_directory_from_relative)
        })
        .collect()
}
