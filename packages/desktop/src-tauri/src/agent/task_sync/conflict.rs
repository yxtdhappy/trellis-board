use super::*;

impl TaskSync {
    pub async fn decide_conflict(
        &self,
        task_space_id: &str,
        conflict_id: &str,
        action: &str,
        files: Option<&[String]>,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let observed = self.assert_binding_branch(&binding).await?;
        let conflicts = self.fetch_conflicts(task_space_id).await?;
        let conflict = conflicts
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(conflict_id))
            .cloned()
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突不存在或已处理"))?;
        let directories = self.conflict_directories(&binding, &conflict).await?;
        if action == "use-server" {
            let server_dir = directories
                .server
                .clone()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突缺少服务端任务目录"))?;
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    self.backup_directory(&binding, local).await?;
                }
            }
            let revision = conflict
                .get("serverRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            self.apply_server_groups(
                &binding,
                revision,
                &[SnapshotGroup {
                    task_dir: server_dir.clone(),
                    archived: false,
                    archive_month: None,
                    task_id: None,
                    task_branch: directories
                        .server_files
                        .iter()
                        .find(|file| file.file_path == "task.json" && !file.deleted)
                        .and_then(|file| parse_task_metadata(&file.content).1),
                    files: directories.server_files.clone(),
                }],
                CONFLICT_SYNC_MODE,
                true,
            )
            .await?;
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    self.remove_task_directory(&binding, local).await?;
                }
            }
            let cursor = self.read_cursor(task_space_id).await;
            let mut baselines = cursor.baselines.clone();
            if let Some(local) = &directories.local {
                if local != &server_dir {
                    baselines.retain(|path_name, _| !path_name.starts_with(&format!("{local}/")));
                }
            }
            baselines.extend(baselines_from_snapshot(&directories.server_files));
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision.max(revision)),
                    baselines: Some(baselines),
                    ..Default::default()
                },
            )
            .await?;
            let resolved = self
                .resolve_conflict(task_space_id, conflict_id, &json!({ "action": action }))
                .await?;
            let task_dirs: Vec<String> = [directories.local.clone(), directories.server.clone()]
                .into_iter()
                .flatten()
                .collect();
            self.clear_conflict_blocked(task_space_id, Some(conflict_id), &task_dirs)
                .await?;
            return Ok(resolved);
        }
        if action == "save-local-copy" {
            let local = directories
                .local
                .clone()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突缺少本地任务目录"))?;
            let backup = self.backup_directory(&binding, &local).await?;
            return Ok(json!({
                "conflictId": conflict_id,
                "action": action,
                "resolved": false,
                "backup": backup,
            }));
        }
        if action != "overwrite-server" {
            return protocol::err(code::COMMAND_INVALID, "冲突处理动作无效");
        }
        let mut selected: Vec<SnapshotFile> = Vec::new();
        if let Some(requested) = files {
            let group = self
                .local_groups(
                    &binding,
                    Some(&HashSet::from([directories
                        .local
                        .clone()
                        .unwrap_or_default()])),
                )
                .await?;
            for group in group {
                for file in group.files {
                    if requested.iter().any(|path_name| path_name == &file.path) {
                        selected.push(file);
                    }
                }
            }
        }
        if selected.is_empty() {
            if let Some(local_dir) = &directories.local {
                let groups = self
                    .local_groups(&binding, Some(&HashSet::from([local_dir.clone()])))
                    .await?;
                selected = groups
                    .into_iter()
                    .find(|group| &group.task_dir == local_dir)
                    .map(|group| group.files)
                    .unwrap_or_default();
            }
        }
        if selected.is_empty() {
            return protocol::err(code::COMMAND_INVALID, "覆盖服务端时必须提供本地任务文件");
        }
        let selected_paths: HashSet<String> =
            selected.iter().map(|file| file.path.clone()).collect();
        let mut values: Vec<Value> = selected
            .iter()
            .map(|file| {
                json!({
                    "path": file.path,
                    "content": file.content,
                    "sha256": file.sha256,
                    "deleted": file.deleted,
                })
            })
            .collect();
        for file in &directories.server_files {
            if selected_paths.contains(&file.path) {
                continue;
            }
            values.push(json!({
                "path": file.path,
                "content": "",
                "sha256": snapshot_sha256(""),
                "deleted": true,
                "baseSha256": file.sha256,
            }));
        }
        let selected_dirs: HashSet<String> = selected
            .iter()
            .filter_map(|file| active_task_directory_from_relative(&file.path))
            .collect();
        let local_groups = self.local_groups(&binding, Some(&selected_dirs)).await?;
        let ownership = self.resolve_task_ownership(&binding, &local_groups).await?;
        if local_groups
            .iter()
            .any(|group| !ownership.syncable.contains_key(&group.task_dir))
        {
            return Ok(json!({
                "skipped": true,
                "reason": if ownership.paused.is_empty() { "TASK_OWNERSHIP_REQUIRED" } else { "TASK_BRANCH_OTHER" },
                "conflictId": conflict_id,
                "action": action,
                "resolved": false,
                "paused": ownership.paused.iter().map(|group| group.task_dir.clone()).collect::<Vec<_>>(),
                "reviews": ownership.reviews.iter().map(|review| review.group.task_dir.clone()).collect::<Vec<_>>(),
            }));
        }
        let merge_evidence = local_groups
            .iter()
            .find_map(|group| ownership.merge_evidence.get(&group.task_dir))
            .cloned();
        let (fence, upload_execution_task_key) =
            match self.acquire_upload_fence(&binding, &values, false).await? {
                UploadFenceOutcome::Ready {
                    fence,
                    execution_task_key,
                } => (fence, execution_task_key),
                UploadFenceOutcome::Skipped(mut skipped) => {
                    skipped["conflictId"] = json!(conflict_id);
                    skipped["action"] = json!(action);
                    skipped["resolved"] = json!(false);
                    return Ok(skipped);
                }
            };
        let cursor = self.read_cursor(task_space_id).await;
        let backup = match &directories.local {
            Some(local_dir) => self.backup_directory(&binding, local_dir).await?,
            None => None,
        };
        let next_sequence = next_client_sequence(cursor.sequence);
        let mut resolve_payload = json!({
            "action": action,
            "batchId": uuid::Uuid::new_v4().to_string(),
            "clientSequence": next_sequence,
            "files": values,
            "observedBranchName": observed,
            "mergeEvidence": merge_evidence,
        });
        if let Some(fence) = fence.as_ref() {
            fence.apply(&mut resolve_payload);
        }
        let result = self
            .resolve_conflict(task_space_id, conflict_id, &resolve_payload)
            .await?;
        self.persist_upload_control_response(
            &binding,
            upload_execution_task_key.as_deref(),
            &result,
        )
        .await?;
        if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
            self.mark_conflict_blocked(task_space_id, &result, &values)
                .await?;
        } else {
            let uploaded_files = parse_snapshot_files_from_values(&values)?;
            self.mark_files_suppressed(&binding, &uploaded_files).await;
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    revision: Some(cursor.revision),
                    sequence: Some(next_sequence),
                    baselines: Some(merge_baselines(&cursor.baselines, &uploaded_files)),
                    pending: Some(None),
                    ..Default::default()
                },
            )
            .await?;
            let task_dirs: Vec<String> = [directories.local.clone(), directories.server.clone()]
                .into_iter()
                .flatten()
                .collect();
            self.clear_conflict_blocked(task_space_id, Some(conflict_id), &task_dirs)
                .await?;
        }
        let mut payload = result;
        payload["backup"] = json!(backup);
        Ok(payload)
    }
}
impl TaskSync {
    pub async fn conflict_details(
        &self,
        task_space_id: &str,
        conflict_id: &str,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let conflicts = self.fetch_conflicts(task_space_id).await?;
        let conflict = conflicts
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(conflict_id))
            .cloned()
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "冲突不存在或已处理"))?;
        let directories = self.conflict_directories(&binding, &conflict).await?;
        let local_files = match &directories.local {
            Some(local_dir) => {
                let groups = self
                    .local_groups(&binding, Some(&HashSet::from([local_dir.clone()])))
                    .await?;
                groups
                    .into_iter()
                    .find(|group| &group.task_dir == local_dir)
                    .map(|group| group.files)
                    .unwrap_or_default()
            }
            None => Vec::new(),
        };
        let mut paths: HashSet<String> = local_files.iter().map(|file| file.path.clone()).collect();
        paths.extend(
            directories
                .server_files
                .iter()
                .map(|file| file.path.clone()),
        );
        if let Some(items) = conflict.get("files").and_then(Value::as_array) {
            for item in items {
                if let Some(path_name) = item.get("path").and_then(Value::as_str) {
                    if !is_archive_snapshot_path(path_name) {
                        paths.insert(path_name.to_string());
                    }
                }
            }
        }
        let mut sorted: Vec<String> = paths.into_iter().collect();
        sorted.sort();
        let files: Vec<Value> = sorted
            .into_iter()
            .map(|path_name| {
                let local = local_files.iter().find(|file| file.path == path_name);
                let remote = directories
                    .server_files
                    .iter()
                    .find(|file| file.path == path_name);
                let detail = conflict
                    .get("files")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("path").and_then(Value::as_str) == Some(&path_name)
                        })
                    });
                json!({
                    "path": path_name,
                    "localContent": local.map(|file| file.content.clone()),
                    "serverContent": remote.map(|file| file.content.clone()),
                    "changedBy": detail.and_then(|item| item.get("changedBy")).cloned()
                        .or_else(|| remote.map(|file| json!(file.sha256))),
                })
            })
            .collect();
        Ok(json!({
            "taskSpaceId": task_space_id,
            "conflictId": conflict_id,
            "taskId": conflict.get("taskId"),
            "taskTitle": conflict.get("taskTitle").or_else(|| conflict.get("taskId")).or_else(|| conflict.get("taskDir")).unwrap_or(&Value::String("任务".into())),
            "taskDir": conflict.get("taskDir"),
            "localTaskDir": directories.local,
            "serverTaskDir": directories.server,
            "files": files,
        }))
    }
}
impl TaskSync {
    pub(super) async fn fetch_conflicts(&self, task_space_id: &str) -> AgentResult<Vec<Value>> {
        let value = self
            .api
            .request_json(
                Method::GET,
                &format!("/api/agent/task-spaces/{task_space_id}/conflicts"),
                None,
                Duration::from_secs(60),
            )
            .await?;
        Ok(value
            .get("conflicts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|conflict| !conflict_is_archive_only(conflict))
            .collect())
    }
}
impl TaskSync {
    pub(super) async fn resolve_conflict(
        &self,
        task_space_id: &str,
        conflict_id: &str,
        body: &Value,
    ) -> AgentResult<Value> {
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/conflicts/{conflict_id}/resolve"),
                Some(body),
                Duration::from_secs(120),
            )
            .await
    }
}
impl TaskSync {
    pub(super) async fn conflict_directories(
        &self,
        binding: &AgentBinding,
        conflict: &Value,
    ) -> AgentResult<ConflictDirectories> {
        let task_dir = conflict
            .get("taskDir")
            .and_then(Value::as_str)
            .unwrap_or("");
        let (mut local, mut server) = conflict_task_directories(task_dir);
        local = local.filter(|task_dir| !is_archive_task_dir(task_dir));
        server = server.filter(|task_dir| !is_archive_task_dir(task_dir));
        let mut candidates: Vec<String> = Vec::new();
        for candidate in [local.clone(), server.clone()].into_iter().flatten() {
            if !is_archive_task_dir(&candidate) && !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
        if let Some(items) = conflict.get("files").and_then(Value::as_array) {
            for item in items {
                if let Some(path_name) = item.get("path").and_then(Value::as_str) {
                    if let Some(candidate) = active_task_directory_from_relative(path_name) {
                        if !candidates.contains(&candidate) {
                            candidates.push(candidate);
                        }
                    }
                }
            }
        }
        for candidate in &candidates {
            let groups = self
                .local_groups(binding, Some(&HashSet::from([candidate.clone()])))
                .await?;
            if !groups.is_empty() {
                local = Some(candidate.clone());
                break;
            }
        }
        let mut server_files = Vec::new();
        for candidate in &candidates {
            let directory = match self
                .fetch_directory(&binding.task_space_id, candidate)
                .await
            {
                Ok(directory) => directory,
                Err(error) if error.status == Some(404) || is_archived_task_error(&error) => {
                    continue
                }
                Err(error) => return Err(with_task_dir(error, candidate)),
            };
            let files = parse_directory_files(&directory, candidate)?;
            if !files.is_empty() {
                server = Some(candidate.clone());
                server_files = files;
                break;
            }
        }
        Ok(ConflictDirectories {
            local,
            server,
            server_files,
        })
    }
}
pub(super) struct ConflictDirectories {
    pub(super) local: Option<String>,
    pub(super) server: Option<String>,
    pub(super) server_files: Vec<SnapshotFile>,
}
pub(super) fn conflict_task_directories(value: &str) -> (Option<String>, Option<String>) {
    let parts: Vec<&str> = value
        .split(" -> ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let local = parts.first().map(|part| part.to_string());
    let server = parts.last().map(|part| part.to_string());
    (local, server)
}
pub(super) fn conflict_is_archive_only(conflict: &Value) -> bool {
    let (local, server) = conflict
        .get("taskDir")
        .and_then(Value::as_str)
        .map(conflict_task_directories)
        .unwrap_or((None, None));
    let mut recognized = false;
    for task_dir in [local, server].into_iter().flatten() {
        recognized = true;
        if !is_archive_task_dir(&task_dir) {
            return false;
        }
    }
    if let Some(files) = conflict.get("files").and_then(Value::as_array) {
        for file in files {
            if let Some(task_dir) = file
                .get("path")
                .and_then(Value::as_str)
                .and_then(task_directory_from_relative)
            {
                recognized = true;
                if !is_archive_task_dir(&task_dir) {
                    return false;
                }
            }
        }
    }
    recognized
}
pub(super) fn conflict_summary(result: &Value) -> Value {
    let details = result.get("details").cloned().unwrap_or(Value::Null);
    let task_id = details
        .get("taskId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let task_title = details
        .get("taskTitle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(task_id)
        .unwrap_or("任务");
    json!({
        "conflictId": result.get("conflictId"),
        "taskId": details.get("taskId"),
        "taskTitle": task_title,
        "files": details.get("files").cloned().unwrap_or(Value::Array(Vec::new())),
        "message": result.get("message").and_then(Value::as_str).unwrap_or("任务文件已被其他成员修改"),
        "suggestion": details.get("suggestion").cloned().unwrap_or(Value::String("先查看差异，再选择保留哪一份".into())),
    })
}
