use super::*;

pub(super) fn handoff_manifest(
    files: &[Value],
    task_dir: &str,
) -> AgentResult<(String, u64, u64, Value)> {
    let prefix = format!("{task_dir}/");
    let mut entries = Vec::with_capacity(files.len());
    let mut total_bytes = 0u64;
    for file in files {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少路径"))?;
        let relative = path.strip_prefix(&prefix).ok_or_else(|| {
            AgentError::new(code::INVALID_RESPONSE, "任务文件不属于 handoff 目录")
        })?;
        let content = file
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少正文"))?;
        let sha256 = file
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件缺少摘要"))?;
        if !is_sha256(sha256) || sha256 != snapshot_sha256(content) {
            return protocol::err(code::INVALID_RESPONSE, "任务文件摘要不一致");
        }
        let size = u64::try_from(normalize_snapshot_text(content).as_bytes().len())
            .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件大小超出范围"))?;
        total_bytes = total_bytes
            .checked_add(size)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务文件总大小溢出"))?;
        entries.push(json!({
            "path": relative,
            "sha256": sha256,
            "sizeBytes": size,
        }));
    }
    entries.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .cmp(&right.get("path").and_then(Value::as_str))
    });
    let manifest = json!({
        "version": 1,
        "taskDir": task_dir,
        "files": entries,
    });
    let bytes = serde_json::to_vec(&manifest).map_err(|error| {
        AgentError::new(
            code::INVALID_RESPONSE,
            format!("handoff manifest 序列化失败: {error}"),
        )
    })?;
    let manifest_sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((
        manifest_sha256,
        files.len() as u64,
        total_bytes,
        manifest,
    ))
}
pub(super) fn handoff_ack_request(handoff: &StoredTaskHandoff) -> AgentResult<Value> {
    let mut request = json!({
        "outcome": handoff.outcome,
        "fileCount": handoff.file_count,
        "totalBytes": handoff.total_bytes,
    });
    match handoff.outcome.as_str() {
        "cleaned" => {
            let backup_id = handoff
                .backup_id
                .as_deref()
                .filter(|value| is_handoff_backup_id(value))
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "handoff 清理状态缺少备份 ID")
                })?;
            let manifest = handoff
                .manifest_sha256
                .as_deref()
                .filter(|value| is_sha256(value))
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "handoff 清理状态缺少 manifest 摘要")
                })?;
            request["backupId"] = Value::String(backup_id.to_string());
            request["manifestSha256"] = Value::String(manifest.to_string());
        }
        "conflict" => {
            let reason = handoff
                .reason
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or("unknown");
            request["reason"] = Value::String(reason.to_string());
        }
        _ => {
            return protocol::err(code::INVALID_RESPONSE, "handoff ACK 结果尚未确定");
        }
    }
    // 服务端按物化轮次 fencing：旧轮次 ACK 必须被识别为陈旧，不能推进新一轮清理状态。
    if let Some(materialized_at) = handoff.materialized_at.as_deref() {
        request["materializedAt"] = Value::String(materialized_at.to_string());
    }
    if let Some(materialized_revision) = handoff.materialized_revision {
        request["materializedRevision"] = json!(materialized_revision);
    }
    Ok(request)
}
pub(super) fn handoff_notice(binding: &AgentBinding, handoff: &StoredTaskHandoff) -> Value {
    let handoff_state = if handoff.outcome == "conflict" {
        "source_cleanup_conflict"
    } else {
        handoff.server_handoff_state.as_str()
    };
    json!({
        "type": "task_handoff",
        "taskSpaceId": binding.task_space_id,
        "executionTaskKey": handoff.execution_task_key,
        "taskId": handoff.task_id,
        "taskDir": handoff.relative_dir,
        "handoffState": handoff_state,
        "outcome": handoff.outcome,
        "reason": handoff.reason,
        "backupId": handoff.backup_id,
    })
}
pub(super) fn git_entries_all_untracked(entries: &[crate::agent::git::GitStatusEntry]) -> bool {
    !entries.is_empty() && entries.iter().all(|entry| entry.status == "??")
}
pub(super) struct HandoffSource {
    pub(super) files: Vec<Value>,
    pub(super) backup_id: String,
    pub(super) manifest_sha256: String,
    pub(super) manifest: Value,
    pub(super) file_count: u64,
    pub(super) total_bytes: u64,
}
pub(super) enum HandoffSourceState {
    Ready(HandoffSource),
    Conflict(&'static str),
}
impl TaskSync {
    pub(super) async fn handoff_task_directory_exists(
        &self,
        binding: &AgentBinding,
        task_dir: &str,
    ) -> AgentResult<bool> {
        let source = resolve_task_directory(binding, task_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
            Ok(_) => protocol::err(code::INVALID_RESPONSE, "handoff 任务目录不是真实目录"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_error(error)),
        }
    }
}
impl TaskSync {
    pub(super) async fn handoff_backup_target(
        &self,
        binding: &AgentBinding,
        backup_id: &str,
    ) -> AgentResult<PathBuf> {
        if !is_handoff_backup_id(backup_id) {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份 ID 格式无效");
        }
        let task_space_id =
            protocol::assert_safe_id_default(Some(&binding.task_space_id), "任务空间 ID")?;
        self.store.ensure_directories().await?;
        let metadata = tokio::fs::symlink_metadata(&self.store.paths.live_backups_dir)
            .await
            .map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份根目录必须是真实目录");
        }
        let root = self
            .store
            .paths
            .live_backups_dir
            .join(task_space_id);
        match tokio::fs::symlink_metadata(&root).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return protocol::err(code::INVALID_RESPONSE, "handoff 任务空间备份目录无效"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::create_dir(&root).await.map_err(io_error)?;
            }
            Err(error) => return Err(io_error(error)),
        }
        let target = root.join(backup_id);
        if !protocol::is_path_inside(&root, &target) {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份目录越界");
        }
        Ok(target)
    }
}
impl TaskSync {
    pub(super) async fn handoff_backup_is_valid(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<bool> {
        let (Some(backup_id), Some(expected_manifest_sha256)) =
            (handoff.backup_id.as_deref(), handoff.manifest_sha256.as_deref())
        else {
            return Ok(false);
        };
        if !is_sha256(expected_manifest_sha256) {
            return Ok(false);
        }
        let target = match self.handoff_backup_target(binding, backup_id).await {
            Ok(target) => target,
            Err(_) => return Ok(false),
        };
        match tokio::fs::symlink_metadata(&target).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        }
        cleanup_handoff_backup_temps(&target).await?;
        let canonical_root = tokio::fs::canonicalize(target.parent().unwrap_or(&target))
            .await
            .map_err(io_error)?;
        let canonical_target = tokio::fs::canonicalize(&target).await.map_err(io_error)?;
        if !protocol::is_path_inside(&canonical_root, &canonical_target) {
            return Ok(false);
        }
        let manifest_bytes = match tokio::fs::read(target.join(HANDOFF_MANIFEST_FILE)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        if sha256_bytes(&manifest_bytes) != expected_manifest_sha256 {
            return Ok(false);
        }
        let manifest: Value = match serde_json::from_slice(&manifest_bytes) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        if manifest.get("version").and_then(Value::as_u64) != Some(1)
            || manifest.get("taskDir").and_then(Value::as_str) != Some(handoff.relative_dir.as_str())
            || !handoff_manifest_files_match(
                &target,
                &manifest,
                handoff.file_count,
                handoff.total_bytes,
            )
            .await?
        {
            return Ok(false);
        }
        let meta_bytes = match tokio::fs::read(target.join(HANDOFF_META_FILE)).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        let meta: Value = match serde_json::from_slice(&meta_bytes) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        Ok(
            meta.get("version").and_then(Value::as_u64) == Some(1)
                && meta.get("backupId").and_then(Value::as_str) == Some(backup_id)
                && meta.get("taskSpaceId").and_then(Value::as_str)
                    == Some(binding.task_space_id.as_str())
                && meta.get("executionTaskKey").and_then(Value::as_str)
                    == Some(handoff.execution_task_key.as_str())
                && meta.get("taskId").and_then(Value::as_str) == Some(handoff.task_id.as_str())
                && meta.get("taskDir").and_then(Value::as_str)
                    == Some(handoff.relative_dir.as_str())
                && meta.get("manifestSha256").and_then(Value::as_str)
                    == Some(expected_manifest_sha256)
                && meta.get("fileCount").and_then(Value::as_u64) == Some(handoff.file_count)
                && meta.get("totalBytes").and_then(Value::as_u64) == Some(handoff.total_bytes),
        )
    }
}
impl TaskSync {
    pub(super) async fn write_handoff_backup_metadata(
        &self,
        binding: &AgentBinding,
        target: &Path,
        handoff: &StoredTaskHandoff,
        control: &TaskControl,
        source: &HandoffSource,
    ) -> AgentResult<()> {
        let manifest_bytes = serde_json::to_vec(&source.manifest).map_err(|error| {
            AgentError::new(
                code::INVALID_RESPONSE,
                format!("handoff manifest 序列化失败: {error}"),
            )
        })?;
        if sha256_bytes(&manifest_bytes) != source.manifest_sha256 {
            return protocol::err(code::INVALID_RESPONSE, "handoff manifest 摘要不稳定");
        }
        self.store
            .write_atomic(&target.join(HANDOFF_MANIFEST_FILE), &manifest_bytes)
            .await?;
        let meta = json!({
            "version": 1,
            "backupId": source.backup_id,
            "taskSpaceId": binding.task_space_id,
            "executionTaskKey": handoff.execution_task_key,
            "taskId": handoff.task_id,
            "taskDir": handoff.relative_dir,
            "materializedRevision": control.materialized_revision,
            "manifestSha256": source.manifest_sha256,
            "fileCount": source.file_count,
            "totalBytes": source.total_bytes,
            "createdAt": protocol::now_iso8601(),
        });
        let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(|error| {
            AgentError::new(
                code::INVALID_RESPONSE,
                format!("handoff 元数据序列化失败: {error}"),
            )
        })?;
        self.store
            .write_atomic(&target.join(HANDOFF_META_FILE), &meta_bytes)
            .await?;
        let mut expected = handoff.clone();
        expected.backup_id = Some(source.backup_id.clone());
        expected.manifest_sha256 = Some(source.manifest_sha256.clone());
        expected.file_count = source.file_count;
        expected.total_bytes = source.total_bytes;
        if !self.handoff_backup_is_valid(binding, &expected).await? {
            return protocol::err(code::INVALID_RESPONSE, "handoff 备份内容校验失败");
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn ensure_handoff_backup(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
        control: &TaskControl,
        source: &HandoffSource,
    ) -> AgentResult<bool> {
        let mut expected = handoff.clone();
        expected.backup_id = Some(source.backup_id.clone());
        expected.manifest_sha256 = Some(source.manifest_sha256.clone());
        expected.file_count = source.file_count;
        expected.total_bytes = source.total_bytes;
        if self.handoff_backup_is_valid(binding, &expected).await? {
            return Ok(true);
        }
        let target = self
            .handoff_backup_target(binding, &source.backup_id)
            .await?;
        let mut created_target = false;
        match tokio::fs::symlink_metadata(&target).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                cleanup_handoff_backup_temps(&target).await?;
                if !handoff_manifest_files_match(
                    &target,
                    &source.manifest,
                    source.file_count,
                    source.total_bytes,
                )
                .await?
                {
                    return protocol::err(code::INVALID_RESPONSE, "已有 handoff 备份内容不一致");
                }
            }
            Ok(_) => return protocol::err(code::INVALID_RESPONSE, "handoff 备份目标不是真实目录"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let source_dir = resolve_task_directory(binding, &handoff.relative_dir).await?;
                copy_directory(&source_dir, &target).await?;
                created_target = true;
            }
            Err(error) => return Err(io_error(error)),
        }
        if let Err(error) = self
            .write_handoff_backup_metadata(binding, &target, handoff, control, source)
            .await
        {
            if created_target {
                if let Err(cleanup_error) = tokio::fs::remove_dir_all(&target).await {
                    crate::logging::warn(&format!(
                        "handoff 无效备份清理失败：{}",
                        protocol::safe_error_message(&cleanup_error.to_string())
                    ));
                }
            }
            return Err(error);
        }
        Ok(true)
    }
}
impl TaskSync {
    pub(super) async fn cleanup_handoff_trash(&self, binding: &AgentBinding) {
        let trash_root = Path::new(&binding.repo_path).join(".trellis");
        let Ok(mut entries) = tokio::fs::read_dir(&trash_root).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            if !name
                .to_string_lossy()
                .starts_with(".agent-handoff-cleanup-")
            {
                continue;
            }
            let Ok(metadata) = tokio::fs::symlink_metadata(entry.path()).await else {
                continue;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                continue;
            }
            if let Err(error) = tokio::fs::remove_dir_all(entry.path()).await {
                crate::logging::warn(&format!(
                    "handoff 遗留暂存目录清理失败：{}",
                    protocol::safe_error_message(&error.to_string())
                ));
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn remove_handoff_source(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
        files: &[Value],
    ) -> AgentResult<()> {
        {
            let mut suppressed = self.suppressed.lock().await;
            for file in files {
                if let Some(path) = file.get("path").and_then(Value::as_str) {
                    suppressed.insert(absolute_task_path(binding, path), None);
                }
            }
        }
        let source = resolve_task_directory(binding, &handoff.relative_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return protocol::err(code::INVALID_RESPONSE, "handoff 任务源不是真实目录"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
        }
        let branch_matches = matches!(
            git_head_branch_name(Path::new(&binding.repo_path)).await,
            Some(Some(branch)) if branch == binding.branch_name
        );
        if !branch_matches {
            return protocol::err(code::INVALID_RESPONSE, "当前分支已变化，拒绝清理 handoff");
        }
        let trash = Path::new(&binding.repo_path)
            .join(".trellis")
            .join(format!(".agent-handoff-cleanup-{}", uuid::Uuid::new_v4()));
        match tokio::fs::rename(&source, &trash).await {
            Ok(()) => {
                match tokio::fs::symlink_metadata(&trash).await {
                    Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                    _ => {
                        let _ = tokio::fs::rename(&trash, &source).await;
                        return protocol::err(code::INVALID_RESPONSE, "handoff 清理目标不是真实目录");
                    }
                }
                if let Err(error) = tokio::fs::remove_dir_all(&trash).await {
                    crate::logging::warn(&format!(
                        "handoff 暂存目录清理失败 {}：{}",
                        handoff.task_id,
                        protocol::safe_error_message(&error.to_string())
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let prefix = format!("{}/", handoff.relative_dir);
        let baselines = cursor
            .baselines
            .iter()
            .filter(|(path, _)| !path.starts_with(&prefix))
            .map(|(path, sha256)| (path.clone(), sha256.clone()))
            .collect();
        let deferred = cursor
            .deferred
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, files)| (task_dir.clone(), files.clone()))
            .collect();
        let ownership_pending = cursor
            .ownership_pending
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, reason)| (task_dir.clone(), reason.clone()))
            .collect();
        let pending_rejected = cursor
            .pending_rejected
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, item)| (task_dir.clone(), item.clone()))
            .collect();
        let conflict_blocked = cursor
            .conflict_blocked
            .iter()
            .filter(|(task_dir, _)| task_dir.as_str() != handoff.relative_dir)
            .map(|(task_dir, conflict_id)| (task_dir.clone(), conflict_id.clone()))
            .collect();
        if let Err(error) = self
            .write_cursor(
                &binding.task_space_id,
                CursorPatch {
                    baselines: Some(baselines),
                    deferred: Some(deferred),
                    ownership_pending: Some(ownership_pending),
                    pending_rejected: Some(pending_rejected),
                    conflict_blocked: Some(conflict_blocked),
                    ..Default::default()
                },
            )
            .await
        {
            crate::logging::warn(&format!(
                "handoff 后清理本地 cursor 失败 {}：{}",
                handoff.task_id,
                protocol::safe_error_message(&error.message)
            ));
        }
        self.invalidate_ownership_projection(&binding.task_space_id)
            .await;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn retry_pending_handoff_acks(&self, binding: &AgentBinding) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let pending = {
            let state = self.task_control_state.lock().await;
            state.pending_handoff_acks(&binding.local_id)
        };
        for (key, mut handoff) in pending {
            if handoff.lease_held_by_other_user {
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some("lease_active"),
                    handoff.backup_id.as_deref(),
                    handoff.manifest_sha256.as_deref(),
                    handoff.file_count,
                    handoff.total_bytes,
                )
                .await?;
                handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
                continue;
            }
            if handoff.outcome == "cleaned" {
                let backup_valid = match self.handoff_backup_is_valid(binding, &handoff).await {
                    Ok(valid) => valid,
                    Err(error) => {
                        crate::logging::warn(&format!(
                            "handoff 备份复核失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("unknown"),
                            handoff.backup_id.as_deref(),
                            handoff.manifest_sha256.as_deref(),
                            handoff.file_count,
                            handoff.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        if let Some(current) = self.stored_task_handoff(&key).await {
                            self.emit_handoff_notice(binding, &key, &current).await?;
                        }
                        continue;
                    }
                };
                if !backup_valid {
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("missing"),
                        handoff.backup_id.as_deref(),
                        handoff.manifest_sha256.as_deref(),
                        handoff.file_count,
                        handoff.total_bytes,
                    )
                    .await?;
                    handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                } else {
                    let exists =
                        match self
                            .handoff_task_directory_exists(binding, &handoff.relative_dir)
                            .await
                        {
                            Ok(exists) => exists,
                            Err(error) => {
                                crate::logging::warn(&format!(
                                    "handoff 本地目录复核失败 {}：{}",
                                    handoff.task_id,
                                    protocol::safe_error_message(&error.message)
                                ));
                                self.mark_handoff_ack_pending(
                                    &key,
                                    "conflict",
                                    Some("unknown"),
                                    handoff.backup_id.as_deref(),
                                    handoff.manifest_sha256.as_deref(),
                                    handoff.file_count,
                                    handoff.total_bytes,
                                )
                                .await?;
                                let _ = self.attempt_handoff_ack(&key).await?;
                                if let Some(current) = self.stored_task_handoff(&key).await {
                                    self.emit_handoff_notice(binding, &key, &current).await?;
                                }
                                continue;
                            }
                        };
                    if exists {
                        let branch_matches = matches!(
                            git_head_branch_name(Path::new(&binding.repo_path)).await,
                            Some(Some(branch)) if branch == binding.branch_name
                        );
                        let (reason, files) = if branch_matches {
                            match self.handoff_source_state(binding, &handoff).await {
                                Err(error) => {
                                    crate::logging::warn(&format!(
                                        "handoff 恢复清理状态检查失败 {}：{}",
                                        handoff.task_id,
                                        protocol::safe_error_message(&error.message)
                                    ));
                                    self.mark_handoff_ack_pending(
                                        &key,
                                        "conflict",
                                        Some("unknown"),
                                        handoff.backup_id.as_deref(),
                                        handoff.manifest_sha256.as_deref(),
                                        handoff.file_count,
                                        handoff.total_bytes,
                                    )
                                    .await?;
                                    let _ = self.attempt_handoff_ack(&key).await?;
                                    if let Some(current) = self.stored_task_handoff(&key).await {
                                        self.emit_handoff_notice(binding, &key, &current).await?;
                                    }
                                    continue;
                                }
                                Ok(HandoffSourceState::Ready(source))
                                    if handoff.manifest_sha256.as_deref()
                                        == Some(source.manifest_sha256.as_str()) =>
                                {
                                    (None, Some(source.files))
                                }
                                Ok(HandoffSourceState::Ready(_)) => {
                                    (Some("baseline_mismatch"), None)
                                }
                                Ok(HandoffSourceState::Conflict(reason)) => (Some(reason), None),
                            }
                        } else {
                            (Some("branch_mismatch"), None)
                        };
                        let cleanup_failed = if let Some(files) = files {
                            match self.remove_handoff_source(binding, &handoff, &files).await {
                                Ok(()) => false,
                                Err(error) => {
                                    crate::logging::warn(&format!(
                                        "handoff 恢复清理本地目录失败 {}：{}",
                                        handoff.task_id,
                                        protocol::safe_error_message(&error.message)
                                    ));
                                    true
                                }
                            }
                        } else {
                            false
                        };
                        let conflict_reason = if cleanup_failed {
                            Some("cleanup_failed")
                        } else {
                            reason
                        };
                        if let Some(reason) = conflict_reason {
                            self.mark_handoff_ack_pending(
                                &key,
                                "conflict",
                                Some(reason),
                                handoff.backup_id.as_deref(),
                                handoff.manifest_sha256.as_deref(),
                                handoff.file_count,
                                handoff.total_bytes,
                            )
                            .await?;
                        }
                        handoff = self.stored_task_handoff(&key).await.unwrap_or(handoff);
                    }
                }
            }
            let _ = self.attempt_handoff_ack(&key).await?;
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn handoff_source_state(
        &self,
        binding: &AgentBinding,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<HandoffSourceState> {
        let source = resolve_task_directory(binding, &handoff.relative_dir).await?;
        match tokio::fs::symlink_metadata(&source).await {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Ok(HandoffSourceState::Conflict("git_modified")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(HandoffSourceState::Conflict("missing"))
            }
            Err(error) => return Err(io_error(error)),
        }
        let selected = HashSet::from([handoff.relative_dir.clone()]);
        let files = self.local_files(binding, Some(&selected)).await?;
        if files.is_empty() {
            return Ok(HandoffSourceState::Conflict("no_files"));
        }
        let task_json_path = format!("{}/task.json", handoff.relative_dir);
        let task_id_matches = files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some(task_json_path.as_str())
                && file
                    .get("content")
                    .and_then(Value::as_str)
                    .and_then(parse_task_id)
                    .as_deref()
                    == Some(handoff.task_id.as_str())
        });
        if !task_id_matches {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let directory_paths = task_directory_file_paths(&source).await?;
        let canonical_paths: BTreeSet<String> = files
            .iter()
            .filter_map(|file| file.get("path").and_then(Value::as_str))
            .filter_map(|path| {
                path.strip_prefix(&format!("{}/", handoff.relative_dir))
                    .map(str::to_string)
            })
            .collect();
        if directory_paths != canonical_paths {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let baseline: BTreeMap<String, String> = cursor
            .baselines
            .iter()
            .filter_map(|(path, sha256)| {
                path.strip_prefix(&format!("{}/", handoff.relative_dir))
                    .map(|relative| (relative.to_string(), sha256.clone()))
            })
            .collect();
        let local: BTreeMap<String, String> = files
            .iter()
            .filter_map(|file| {
                Some((
                    file.get("path")?
                        .as_str()?
                        .strip_prefix(&format!("{}/", handoff.relative_dir))?
                        .to_string(),
                    file.get("sha256")?.as_str()?.to_string(),
                ))
            })
            .collect();
        if baseline.is_empty() || baseline != local {
            return Ok(HandoffSourceState::Conflict("baseline_mismatch"));
        }
        let branch_matches = matches!(
            git_head_branch_name(Path::new(&binding.repo_path)).await,
            Some(Some(branch)) if branch == binding.branch_name
        );
        if !branch_matches {
            return Ok(HandoffSourceState::Conflict("branch_mismatch"));
        }
        let git_entries = match crate::agent::git::status_paths(
            Path::new(&binding.repo_path),
            &self.binding_hooks_dir(binding),
            &[handoff.relative_dir.clone()],
        )
        .await
        {
            Ok(entries) => entries,
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff 前检查 Git 状态失败 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                return Ok(HandoffSourceState::Conflict("git_modified"));
            }
        };
        if git_entries.is_empty() {
            return Ok(HandoffSourceState::Conflict("git_tracked"));
        }
        if !git_entries_all_untracked(&git_entries) {
            return Ok(HandoffSourceState::Conflict("git_modified"));
        }
        let (manifest_sha256, file_count, total_bytes, manifest) =
            handoff_manifest(&files, &handoff.relative_dir)?;
        if file_count > HANDOFF_MAX_FILES || total_bytes > HANDOFF_MAX_BYTES {
            return Ok(HandoffSourceState::Conflict("backup_too_large"));
        }
        let backup_id = format!("handoff-{}", &manifest_sha256[..16]);
        Ok(HandoffSourceState::Ready(HandoffSource {
            files,
            backup_id,
            manifest_sha256,
            manifest,
            file_count,
            total_bytes,
        }))
    }
}
impl TaskSync {
    pub(super) async fn process_handoff_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<()> {
        let key = self
            .upsert_task_handoff_control(binding, control)
            .await?;
        let Some(handoff) = self.stored_task_handoff(&key).await else {
            return Ok(());
        };
        if handoff.lease_held_by_other_user && handoff.ack_state != "done" {
            self.mark_handoff_ack_pending(
                &key,
                "conflict",
                Some("lease_active"),
                handoff.backup_id.as_deref(),
                handoff.manifest_sha256.as_deref(),
                handoff.file_count,
                handoff.total_bytes,
            )
            .await?;
            let _ = self.attempt_handoff_ack(&key).await?;
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
            return Ok(());
        }
        if control.handoff_state == "source_cleanup_conflict" || !handoff.outcome.is_empty() {
            if handoff.ack_state == "pending" {
                let _ = self.attempt_handoff_ack(&key).await?;
            }
            if let Some(current) = self.stored_task_handoff(&key).await {
                self.emit_handoff_notice(binding, &key, &current).await?;
            }
            return Ok(());
        }

        let source_state = match self.handoff_source_state(binding, &handoff).await {
            Ok(state) => state,
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff 本地状态检查失败 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some("unknown"),
                    None,
                    None,
                    0,
                    0,
                )
                .await?;
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
                return Ok(());
            }
        };
        match source_state {
            HandoffSourceState::Conflict(reason) => {
                self.mark_handoff_ack_pending(
                    &key,
                    "conflict",
                    Some(reason),
                    None,
                    None,
                    0,
                    0,
                )
                .await?;
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
            }
            HandoffSourceState::Ready(source) => {
                let backed_up = self
                    .ensure_handoff_backup(binding, &handoff, control, &source)
                    .await;
                if !matches!(&backed_up, Ok(true)) {
                    if let Err(error) = backed_up {
                        crate::logging::warn(&format!(
                            "handoff 备份失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                    }
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("backup_failed"),
                        None,
                        None,
                        source.file_count,
                        source.total_bytes,
                    )
                    .await?;
                    let _ = self.attempt_handoff_ack(&key).await?;
                    return Ok(());
                }
                self.mark_handoff_ack_pending(
                    &key,
                    "cleaned",
                    None,
                    Some(&source.backup_id),
                    Some(&source.manifest_sha256),
                    source.file_count,
                    source.total_bytes,
                )
                .await?;
                let latest_state = match self.handoff_source_state(binding, &handoff).await {
                    Ok(state) => state,
                    Err(error) => {
                        crate::logging::warn(&format!(
                            "handoff 删除前复核失败 {}：{}",
                            handoff.task_id,
                            protocol::safe_error_message(&error.message)
                        ));
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("unknown"),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                };
                match latest_state {
                    HandoffSourceState::Ready(latest)
                        if latest.manifest_sha256.as_str() == source.manifest_sha256.as_str() => {}
                    HandoffSourceState::Ready(_) => {
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some("baseline_mismatch"),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                    HandoffSourceState::Conflict(reason) => {
                        self.mark_handoff_ack_pending(
                            &key,
                            "conflict",
                            Some(reason),
                            Some(&source.backup_id),
                            Some(&source.manifest_sha256),
                            source.file_count,
                            source.total_bytes,
                        )
                        .await?;
                        let _ = self.attempt_handoff_ack(&key).await?;
                        return Ok(());
                    }
                }
                if let Err(error) = self
                    .remove_handoff_source(binding, &handoff, &source.files)
                    .await
                {
                    crate::logging::warn(&format!(
                        "handoff 清理本地目录失败 {}：{}",
                        handoff.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                    self.mark_handoff_ack_pending(
                        &key,
                        "conflict",
                        Some("cleanup_failed"),
                        Some(&source.backup_id),
                        Some(&source.manifest_sha256),
                        source.file_count,
                        source.total_bytes,
                    )
                    .await?;
                    let _ = self.attempt_handoff_ack(&key).await?;
                    return Ok(());
                }
                let _ = self.attempt_handoff_ack(&key).await?;
                if let Some(current) = self.stored_task_handoff(&key).await {
                    self.emit_handoff_notice(binding, &key, &current).await?;
                }
            }
        }
        Ok(())
    }
}
pub(super) fn safe_handoff_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\\')
        && !path.contains('\0')
        && !path.contains(':')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
pub(super) fn is_handoff_metadata_temp(name: &str) -> bool {
    name.ends_with(".tmp")
        && (name.starts_with(&format!(".{HANDOFF_MANIFEST_FILE}."))
            || name.starts_with(&format!(".{HANDOFF_META_FILE}.")))
}
pub(super) async fn cleanup_handoff_backup_temps(target: &Path) -> AgentResult<()> {
    let mut entries = tokio::fs::read_dir(target).await.map_err(io_error)?;
    while let Some(entry) = entries.next_entry().await.map_err(io_error)? {
        if !is_handoff_metadata_temp(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let metadata = tokio::fs::symlink_metadata(entry.path())
            .await
            .map_err(io_error)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return protocol::err(code::INVALID_RESPONSE, "handoff 元数据临时文件状态异常");
        }
        tokio::fs::remove_file(entry.path()).await.map_err(io_error)?;
    }
    Ok(())
}
pub(super) async fn handoff_manifest_files_match(
    target: &Path,
    manifest: &Value,
    expected_count: u64,
    expected_total_bytes: u64,
) -> AgentResult<bool> {
    let Some(entries) = manifest.get("files").and_then(Value::as_array) else {
        return Ok(false);
    };
    if entries.len() as u64 != expected_count {
        return Ok(false);
    }
    let mut expected = BTreeMap::new();
    for entry in entries {
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(sha256) = entry.get("sha256").and_then(Value::as_str) else {
            return Ok(false);
        };
        let Some(size) = entry.get("sizeBytes").and_then(Value::as_u64) else {
            return Ok(false);
        };
        if !safe_handoff_relative_path(path) || !is_sha256(sha256) {
            return Ok(false);
        }
        if expected.insert(path.to_string(), (sha256.to_string(), size)).is_some() {
            return Ok(false);
        }
    }
    let mut actual_paths = task_directory_file_paths(target).await?;
    actual_paths.remove(HANDOFF_MANIFEST_FILE);
    actual_paths.remove(HANDOFF_META_FILE);
    let expected_paths: BTreeSet<String> = expected.keys().cloned().collect();
    if actual_paths != expected_paths {
        return Ok(false);
    }
    let mut actual_total_bytes = 0u64;
    for (path, (expected_sha256, expected_size)) in expected {
        let absolute = target.join(&path);
        if !protocol::is_path_inside(target, &absolute) {
            return Ok(false);
        }
        let bytes = match tokio::fs::read(&absolute).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(io_error(error)),
        };
        let Ok(content) = String::from_utf8(bytes) else {
            return Ok(false);
        };
        let normalized = normalize_snapshot_text(&content);
        let size = u64::try_from(normalized.as_bytes().len())
            .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "备份文件大小超出范围"))?;
        if size != expected_size || snapshot_sha256(&content) != expected_sha256 {
            return Ok(false);
        }
        actual_total_bytes = actual_total_bytes
            .checked_add(size)
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "备份文件大小溢出"))?;
    }
    Ok(actual_total_bytes == expected_total_bytes)
}
pub(super) fn previous_values_paths(values: &[Value]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| value.get("path").and_then(Value::as_str))
        .filter(|path| !is_archive_snapshot_path(path))
        .map(str::to_string)
        .collect()
}
