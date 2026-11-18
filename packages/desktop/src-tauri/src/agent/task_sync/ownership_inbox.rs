use super::*;

pub(super) struct OwnershipReview {
    pub(super) group: SnapshotGroup,
    pub(super) reason: String,
}
pub(super) struct OwnershipDecision {
    pub(super) task_dir: String,
    pub(super) action: String,
    pub(super) branch_name: String,
}
pub(super) fn ownership_ledger_task_dirs(cursor: &Cursor) -> BTreeSet<String> {
    cursor
        .ownership_pending
        .keys()
        .chain(cursor.pending_rejected.keys())
        .cloned()
        .collect()
}
#[derive(Default)]
pub(super) struct OwnershipResolution {
    pub(super) syncable: HashMap<String, SnapshotGroup>,
    pub(super) paused: Vec<SnapshotGroup>,
    pub(super) reviews: Vec<OwnershipReview>,
    pub(super) invalid: Vec<String>,
    pub(super) project_task_spaces: Vec<Value>,
    pub(super) merge_evidence: HashMap<String, Value>,
}
impl TaskSync {
    pub(super) async fn local_files(
        &self,
        binding: &AgentBinding,
        task_dirs: Option<&HashSet<String>>,
    ) -> AgentResult<Vec<Value>> {
        read_local_task_snapshot_files(Path::new(&binding.repo_path), task_dirs).await
    }
}
impl TaskSync {
    pub(super) async fn local_groups(
        &self,
        binding: &AgentBinding,
        task_dirs: Option<&HashSet<String>>,
    ) -> AgentResult<Vec<SnapshotGroup>> {
        let files = self.local_files(binding, task_dirs).await?;
        group_task_snapshot_files(&files)
    }
}
impl TaskSync {
    pub(super) async fn fetch_task_ownership(
        &self,
        task_space_id: &str,
        task_ids: &[String],
    ) -> AgentResult<Value> {
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/task-spaces/{task_space_id}/task-ownership"),
                Some(&json!({ "taskIds": task_ids })),
                Duration::from_secs(60),
            )
            .await
    }
}
impl TaskSync {
    pub(super) async fn remember_ownership_reviews(
        &self,
        task_space_id: &str,
        reviews: &[OwnershipReview],
    ) -> AgentResult<Vec<OwnershipReview>> {
        if reviews.is_empty() {
            return Ok(Vec::new());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut pending = cursor.ownership_pending.clone();
        let mut fresh = Vec::new();
        for review in reviews {
            let fingerprint = task_fingerprint(&review.group);
            if pending.get(&review.group.task_dir) == Some(&fingerprint) {
                continue;
            }
            pending.insert(review.group.task_dir.clone(), fingerprint);
            fresh.push(OwnershipReview {
                group: review.group.clone(),
                reason: review.reason.clone(),
            });
        }
        if pending != cursor.ownership_pending {
            self.write_cursor(
                task_space_id,
                CursorPatch {
                    ownership_pending: Some(pending),
                    ..Default::default()
                },
            )
            .await?;
        }
        Ok(fresh)
    }
}
impl TaskSync {
    pub(super) async fn clear_ownership_pending(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut pending = cursor.ownership_pending.clone();
        let before = pending.len();
        for task_dir in task_dirs {
            pending.remove(task_dir);
        }
        if pending.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                ownership_pending: Some(pending),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    pub(super) async fn settle_rejected_pending(
        &self,
        binding: &AgentBinding,
        pending: &PendingBatch,
        reason: &str,
    ) -> AgentResult<()> {
        let task_dirs = pending_task_dirs(&pending.files);
        if task_dirs.is_empty() {
            return Ok(());
        }
        let groups = group_task_snapshot_files(&pending.files).unwrap_or_default();
        let groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let mut rejected = cursor.pending_rejected.clone();
        let mut ownership = cursor.ownership_pending.clone();
        let blocked_at = protocol::now_iso8601();
        let created_at = if pending.created_at.is_empty() {
            blocked_at.clone()
        } else {
            pending.created_at.clone()
        };
        for task_dir in &task_dirs {
            rejected.insert(
                task_dir.clone(),
                PendingRejection {
                    batch_id: pending.batch_id.clone(),
                    client_sequence: pending.client_sequence,
                    reason: reason.to_string(),
                    created_at: created_at.clone(),
                    blocked_at: blocked_at.clone(),
                },
            );
        }
        if reason == "TASK_OWNERSHIP_REQUIRED" {
            for task_dir in &task_dirs {
                if let Some(group) = groups_by_dir.get(task_dir) {
                    if group.task_id.is_some() {
                        ownership.insert(task_dir.clone(), task_fingerprint(group));
                    }
                }
            }
        } else {
            for task_dir in &task_dirs {
                ownership.remove(task_dir);
            }
        }
        trim_pending_rejections(&mut rejected);
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                pending: Some(None),
                pending_rejected: Some(rejected),
                ownership_pending: Some(ownership),
                ..Default::default()
            },
        )
        .await?;
        let groups: Vec<SnapshotGroup> = groups_by_dir.into_values().collect();
        let previous_task_dirs = ownership_ledger_task_dirs(&cursor);
        self.sync_ownership_inbox(binding, &previous_task_dirs, &groups)
            .await;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn clear_pending_rejections(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut rejected = cursor.pending_rejected.clone();
        let before = rejected.len();
        for task_dir in task_dirs {
            rejected.remove(task_dir);
        }
        if rejected.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                pending_rejected: Some(rejected),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    pub(super) async fn mark_conflict_blocked(
        &self,
        task_space_id: &str,
        result: &Value,
        files: &[Value],
    ) -> AgentResult<()> {
        let Some(conflict_id) = result.get("conflictId").and_then(Value::as_str) else {
            return Ok(());
        };
        let task_dirs: HashSet<String> = files
            .iter()
            .filter_map(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .and_then(active_task_directory_from_relative)
            })
            .collect();
        if task_dirs.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut blocked = cursor.conflict_blocked.clone();
        for task_dir in task_dirs {
            blocked.insert(task_dir, conflict_id.to_string());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                conflict_blocked: Some(blocked),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    pub(super) async fn clear_conflict_blocked(
        &self,
        task_space_id: &str,
        conflict_id: Option<&str>,
        task_dirs: &[String],
    ) -> AgentResult<()> {
        let cursor = self.read_cursor(task_space_id).await;
        let mut blocked = cursor.conflict_blocked.clone();
        let before = blocked.len();
        for task_dir in task_dirs {
            let matched = match conflict_id {
                Some(conflict_id) => blocked.get(task_dir).map(String::as_str) == Some(conflict_id),
                None => true,
            };
            if matched {
                blocked.remove(task_dir);
            }
        }
        if blocked.len() == before {
            return Ok(());
        }
        self.write_cursor(
            task_space_id,
            CursorPatch {
                conflict_blocked: Some(blocked),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    /// 记录只读镜像目录，后续拉取不再把它的本地改动写回服务端。
    pub(super) async fn mark_readonly_dir(
        &self,
        task_space_id: &str,
        task_dir: &str,
        reason: &str,
    ) -> AgentResult<()> {
        if is_archive_task_dir(task_dir) || task_dir.is_empty() {
            return Ok(());
        }
        let cursor = self.read_cursor(task_space_id).await;
        let mut dirs = cursor.readonly_task_dirs.clone();
        if dirs.get(task_dir).map(String::as_str) == Some(reason) {
            return Ok(());
        }
        dirs.insert(task_dir.to_string(), reason.to_string());
        self.write_cursor(
            task_space_id,
            CursorPatch {
                readonly_task_dirs: Some(dirs),
                ..Default::default()
            },
        )
        .await
    }
}
impl TaskSync {
    pub(super) async fn control_assignee(&self, task_space_id: &str, task_dir: &str) -> String {
        self.ensure_task_control_loaded().await;
        let state = self.task_control_state.lock().await;
        let binding = self.bindings.lock().await.get(task_space_id).cloned();
        let Some(binding) = binding else {
            return String::new();
        };
        let assignee = state
            .controls_for_binding(&binding.local_id, task_space_id)
            .find(|(_, control)| control.relative_dir == task_dir)
            .map(|(_, control)| control.assignee_user_id.clone().unwrap_or_default())
            .unwrap_or_default();
        assignee
    }
}
impl TaskSync {
    /// 本机任务目录状态：已落盘、只读镜像、以及已归档但仍留在活跃目录的残留。
    pub(crate) async fn local_task_state(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let files = read_local_task_snapshot_files(Path::new(&binding.repo_path), None).await?;
        let mut local_dirs: BTreeSet<String> = BTreeSet::new();
        for file in &files {
            if let Some(task_dir) = file
                .get("path")
                .and_then(Value::as_str)
                .and_then(active_task_directory_from_relative)
            {
                local_dirs.insert(task_dir);
            }
        }
        let cursor = self.read_cursor(task_space_id).await;
        let copies = archived_task_copies(&binding).await;
        let archived_residue: Vec<String> = local_dirs
            .iter()
            .filter(|task_dir| {
                task_dir
                    .rsplit('/')
                    .next()
                    .is_some_and(|name| copies.contains_key(name))
            })
            .cloned()
            .collect();
        Ok(json!({
            "taskSpaceId": task_space_id,
            "localDirs": local_dirs.into_iter().collect::<Vec<_>>(),
            "readonlyDirs": cursor.readonly_task_dirs.into_keys().collect::<Vec<_>>(),
            "archivedResidue": archived_residue,
        }))
    }
}
impl TaskSync {
    /// 重新露出仍然有效的待处理冲突；服务端已失效的去服务端收敛掉。
    pub(crate) async fn reopen_conflicts(&self, task_space_id: &str) -> AgentResult<Option<Value>> {
        let conflicts = self.fetch_conflicts(task_space_id).await?;
        let mut event: Option<Value> = None;
        // 服务端仍然认得这些目录上的冲突，阻塞标记必须留着。
        let mut live_dirs: HashSet<String> = HashSet::new();
        for conflict in &conflicts {
            let Some(conflict_id) = conflict.get("id").and_then(Value::as_str) else {
                continue;
            };
            let mut candidates: Vec<String> = conflict
                .get("taskDir")
                .and_then(Value::as_str)
                .map(conflict_task_directories)
                .into_iter()
                .flat_map(|(local, server)| [local, server])
                .flatten()
                .filter(|task_dir| !is_archive_task_dir(task_dir))
                .collect();
            if let Some(items) = conflict.get("files").and_then(Value::as_array) {
                for item in items {
                    if let Some(task_dir) = item
                        .get("path")
                        .and_then(Value::as_str)
                        .and_then(active_task_directory_from_relative)
                    {
                        candidates.push(task_dir);
                    }
                }
            }
            candidates.sort();
            candidates.dedup();
            let mut alive: Option<String> = None;
            for task_dir in &candidates {
                match self.fetch_directory(task_space_id, task_dir).await {
                    Ok(directory) => {
                        if !parse_directory_files(&directory, task_dir)?.is_empty() {
                            alive = Some(task_dir.clone());
                            break;
                        }
                    }
                    Err(error) if error.status == Some(404) || is_archived_task_error(&error) => {}
                    Err(error) => return Err(with_task_dir(error, task_dir)),
                }
            }
            if let Some(task_dir) = alive {
                live_dirs.extend(candidates.iter().cloned());
                if event.is_none() {
                    event = Some(json!({
                        "type": "task_file_conflict",
                        "taskSpaceId": task_space_id,
                        "conflict": {
                            "conflictId": conflict_id,
                            "taskId": conflict.get("taskId").cloned().unwrap_or(Value::Null),
                            "taskTitle": conflict.get("taskTitle").cloned().unwrap_or_else(|| json!("任务")),
                            "taskDir": task_dir,
                            "files": conflict.get("files").cloned().unwrap_or_else(|| json!([])),
                            "message": "任务文件已被其他成员修改",
                            "suggestion": "先查看差异，再选择保留哪一份",
                        },
                    }));
                }
                continue;
            }
            if candidates.is_empty() {
                continue;
            }
            if let Err(error) = self
                .resolve_conflict(
                    task_space_id,
                    conflict_id,
                    &json!({ "action": "use-server" }),
                )
                .await
            {
                crate::logging::warn(&format!(
                    "清理失效冲突失败 {conflict_id}：{}",
                    protocol::safe_error_message(&error.message)
                ));
                // 服务端还认它，先留着阻塞标记，等下一轮再收敛。
                live_dirs.extend(candidates);
                continue;
            }
            self.clear_conflict_blocked(task_space_id, Some(conflict_id), &candidates)
                .await?;
        }
        // 服务端列表里已经没有的目录，本地不能再挂着「冲突待处理」。
        let cursor = self.read_cursor(task_space_id).await;
        let stale: Vec<String> = cursor
            .conflict_blocked
            .keys()
            .filter(|task_dir| !live_dirs.contains(*task_dir))
            .cloned()
            .collect();
        if !stale.is_empty() {
            self.clear_conflict_blocked(task_space_id, None, &stale)
                .await?;
        }
        Ok(event)
    }
}
impl TaskSync {
    pub(super) fn ownership_event(
        &self,
        binding: &AgentBinding,
        reviews: &[OwnershipReview],
        project_task_spaces: &[Value],
    ) {
        let items: Vec<Value> = reviews
            .iter()
            .map(|review| {
                json!({
                    "taskId": review.group.task_id,
                    "taskDir": review.group.task_dir,
                    "title": task_title(&review.group).or_else(|| review.group.task_id.clone()),
                    "branchName": review.group.task_branch,
                    "suggestedBranchName": Value::Null,
                    "choices": project_task_spaces,
                })
            })
            .collect();
        if items.is_empty() {
            return;
        }
        (self.emit)(json!({
            "type": "task_ownership_review",
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "items": items,
        }));
    }
}
impl TaskSync {
    pub(super) async fn missing_active_task_dirs(
        &self,
        binding: &AgentBinding,
        task_dirs: &BTreeSet<String>,
    ) -> AgentResult<Vec<String>> {
        let repo = Path::new(&binding.repo_path);
        let trellis_root = repo.join(".trellis");
        let tasks_root = repo.join(ACTIVE_TASKS_ROOT);
        for (path, label) in [(&trellis_root, ".trellis"), (&tasks_root, ACTIVE_TASKS_ROOT)] {
            match tokio::fs::symlink_metadata(path).await {
                Ok(metadata)
                    if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return protocol::err(
                        code::MISSING_TRELLIS,
                        format!("{label} 必须是可访问的真实目录"),
                    )
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return protocol::err(
                        code::MISSING_TRELLIS,
                        format!("{label} 不存在，不能确认任务目录已删除"),
                    )
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        // 能打开任务根才允许把子目录 NotFound 解释成“已删除”。
        let _ = tokio::fs::read_dir(&tasks_root).await.map_err(io_error)?;

        let mut missing = Vec::new();
        for task_dir in task_dirs {
            let relative = protocol::resolve_task_dir_under(
                Path::new(ACTIVE_TASKS_ROOT),
                task_dir,
            )
            .ok_or_else(|| task_directory_error(task_dir, "待清理任务目录格式无效"))?;
            match tokio::fs::symlink_metadata(repo.join(relative)).await {
                Ok(metadata)
                    if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
                Ok(_) => {
                    return Err(task_directory_error(
                        task_dir,
                        "待清理任务路径不是安全的真实目录",
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing.push(task_dir.clone())
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        Ok(missing)
    }
}
impl TaskSync {
    pub(super) async fn cleanup_missing_ownership_inbox(
        &self,
        binding: &AgentBinding,
        candidate_task_dirs: Option<&HashSet<String>>,
    ) -> AgentResult<Vec<String>> {
        if binding.read_only {
            return Ok(Vec::new());
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let candidates: BTreeSet<String> = ownership_ledger_task_dirs(&cursor)
            .into_iter()
            .filter(|task_dir| {
                candidate_task_dirs
                    .map_or(true, |candidates| candidates.contains(task_dir))
            })
            .collect();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        self.assert_binding_branch(binding).await?;
        let missing = self
            .missing_active_task_dirs(binding, &candidates)
            .await?;
        if missing.is_empty() {
            return Ok(Vec::new());
        }
        for chunk in missing.chunks(OWNERSHIP_INBOX_MAX_CHANGES) {
            let deletes: Vec<Value> = chunk
                .iter()
                .map(|task_dir| json!({ "taskDir": task_dir }))
                .collect();
            self.put_ownership_inbox(binding, &[], &deletes).await?;
        }
        self.write_cursor(
            &binding.task_space_id,
            CursorPatch {
                ownership_ledger_removals: Some(missing.iter().cloned().collect()),
                ..Default::default()
            },
        )
        .await?;
        Ok(missing)
    }
}
impl TaskSync {
    pub(super) async fn sync_ownership_inbox(
        &self,
        binding: &AgentBinding,
        previous_task_dirs: &BTreeSet<String>,
        groups: &[SnapshotGroup],
    ) {
        if binding.read_only {
            return;
        }
        if self
            .ownership_inbox_unavailable
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let current = self
            .read_cursor(&binding.task_space_id)
            .await
            .ownership_pending;
        let mut groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .iter()
            .cloned()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let missing: HashSet<String> = current
            .keys()
            .filter(|task_dir| !groups_by_dir.contains_key(*task_dir))
            .cloned()
            .collect();
        if !missing.is_empty() {
            if let Ok(extra) = self.local_groups(binding, Some(&missing)).await {
                for group in extra {
                    groups_by_dir.insert(group.task_dir.clone(), group);
                }
            }
        }

        let mut upserts = Vec::new();
        for (task_dir, fingerprint) in &current {
            let Some(group) = groups_by_dir.get(task_dir) else {
                continue;
            };
            let Some(task_id) = group
                .task_id
                .as_deref()
                .filter(|value| !value.is_empty() && value.len() <= 128)
            else {
                continue;
            };
            if !is_sha256(fingerprint) {
                continue;
            }
            let title: String = task_title(group)
                .or_else(|| Some(task_id.to_string()))
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            upserts.push(json!({
                "taskId": task_id,
                "taskDir": task_dir,
                "title": title,
                "reason": "TASK_OWNERSHIP_REQUIRED",
                "fingerprint": fingerprint,
            }));
        }

        let mut deletes = Vec::new();
        for task_dir in previous_task_dirs
            .iter()
            .filter(|task_dir| !current.contains_key(*task_dir))
        {
            // 只有目录仍存在时，这里才代表“已归属/已解除待归属”。
            // 目录消失产生的删除差集必须走 cleanup_missing_ownership_inbox。
            if !groups_by_dir.contains_key(task_dir) {
                continue;
            }
            deletes.push(json!({ "taskDir": task_dir }));
        }

        for chunk in upserts.chunks(OWNERSHIP_INBOX_MAX_CHANGES) {
            if self.put_ownership_inbox(binding, chunk, &[]).await.is_err() {
                return;
            }
        }
        for chunk in deletes.chunks(OWNERSHIP_INBOX_MAX_CHANGES) {
            if self.put_ownership_inbox(binding, &[], chunk).await.is_err() {
                return;
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn put_ownership_inbox(
        &self,
        binding: &AgentBinding,
        upserts: &[Value],
        deletes: &[Value],
    ) -> AgentResult<()> {
        if upserts.is_empty() && deletes.is_empty() {
            return Ok(());
        }
        if self
            .ownership_inbox_unavailable
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(());
        }
        let observed = self.assert_binding_branch(binding).await?;
        let result = self
            .api
            .request_json(
                Method::PUT,
                &format!(
                    "/api/agent/task-spaces/{}/ownership-inbox",
                    binding.task_space_id
                ),
                Some(&json!({
                    "observedBranchName": observed,
                    "upserts": upserts,
                    "deletes": deletes,
                })),
                Duration::from_secs(60),
            )
            .await;
        match result {
            Ok(_) => Ok(()),
            Err(error) if matches!(error.status, Some(404) | Some(405)) => {
                if !self
                    .ownership_inbox_unavailable
                    .swap(true, std::sync::atomic::Ordering::SeqCst)
                {
                    crate::logging::warn(
                        "服务端不支持待归属摘要接口，继续使用普通任务同步",
                    );
                }
                Ok(())
            }
            Err(error) => {
                crate::logging::warn(&format!(
                    "待归属摘要同步失败：{}",
                    protocol::safe_error_message(&error.message)
                ));
                Err(error)
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn resolve_task_ownership(
        &self,
        binding: &AgentBinding,
        groups: &[SnapshotGroup],
    ) -> AgentResult<OwnershipResolution> {
        let previous_task_dirs =
            ownership_ledger_task_dirs(&self.read_cursor(&binding.task_space_id).await);
        let unresolved_ids: Vec<String> = groups
            .iter()
            .filter(|group| group.task_id.is_some() && group.task_branch.is_none())
            .filter_map(|group| group.task_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut project_task_spaces = vec![json!({
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "isBaseline": binding.baseline_branch.as_deref() == Some(binding.branch_name.as_str()),
        })];
        let mut claims_by_task: HashMap<String, Vec<Value>> = HashMap::new();
        for chunk in unresolved_ids.chunks(TASK_OWNERSHIP_QUERY_LIMIT) {
            let result = self
                .fetch_task_ownership(&binding.task_space_id, chunk)
                .await?;
            if let Some(items) = result
                .get("projectTaskSpaces")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                project_task_spaces = items.clone();
            }
            if let Some(tasks) = result.get("tasks").and_then(Value::as_array) {
                for task in tasks {
                    let Some(task_id) = task.get("taskId").and_then(Value::as_str) else {
                        continue;
                    };
                    let claims = task
                        .get("claims")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    claims_by_task.insert(task_id.to_string(), claims);
                }
            }
        }

        let mut resolution = OwnershipResolution {
            project_task_spaces: project_task_spaces.clone(),
            ..Default::default()
        };
        let mut head_tree: Option<(String, Arc<HashSet<String>>)> = None;
        for group in groups {
            let Some(task_id) = group.task_id.as_deref() else {
                resolution.invalid.push(group.task_dir.clone());
                continue;
            };
            if self.baseline_owned(&binding.task_space_id, task_id).await {
                resolution.paused.push(group.clone());
                continue;
            }
            if let Some(branch_name) = group.task_branch.as_deref() {
                self.resolve_group_ownership(
                    binding,
                    group.clone(),
                    task_id,
                    branch_name,
                    &mut head_tree,
                    &mut resolution,
                )
                .await?;
                continue;
            }
            let claims = claims_by_task.get(task_id).cloned().unwrap_or_default();
            let explicit_branches: HashSet<String> = claims
                .iter()
                .filter_map(|claim| claim.get("taskBranch").and_then(Value::as_str))
                .filter(|branch| !branch.is_empty())
                .map(str::to_string)
                .collect();
            let occurrence_branches: HashSet<String> = claims
                .iter()
                .filter_map(|claim| claim.get("branchName").and_then(Value::as_str))
                .filter(|branch| !branch.is_empty())
                .map(str::to_string)
                .collect();
            let inferred = if explicit_branches.len() > 1 {
                None
            } else if explicit_branches.len() == 1 {
                explicit_branches.iter().next().cloned()
            } else if claims.len() == 1 {
                claims[0]
                    .get("branchName")
                    .and_then(Value::as_str)
                    .filter(|branch| !branch.is_empty())
                    .map(str::to_string)
            } else if occurrence_branches.len() == 1 {
                occurrence_branches.iter().next().cloned()
            } else if claims.is_empty() && project_task_spaces.len() == 1 {
                project_task_spaces[0]
                    .get("branchName")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            } else {
                None
            };
            let Some(inferred) = inferred else {
                resolution.reviews.push(OwnershipReview {
                    group: group.clone(),
                    reason: "TASK_OWNERSHIP_REQUIRED".to_string(),
                });
                continue;
            };
            crate::agent::task_command::set_task_directory_branch(
                Path::new(&binding.repo_path),
                &group.task_dir,
                &inferred,
            )
            .await?;
            let mut selected = HashSet::new();
            selected.insert(group.task_dir.clone());
            let refreshed = self
                .local_groups(binding, Some(&selected))
                .await?
                .into_iter()
                .find(|candidate| candidate.task_dir == group.task_dir)
                .ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "任务分支归属写入后未能读回")
                })?;
            if refreshed.task_branch.as_deref() != Some(inferred.as_str()) {
                return protocol::err(code::INVALID_RESPONSE, "任务分支归属写入后未能读回");
            }
            if let Some(task_json) = refreshed
                .files
                .iter()
                .find(|file| file.file_path == "task.json")
            {
                self.suppressed.lock().await.insert(
                    absolute_task_path(binding, &task_json.path),
                    Some(task_json.sha256.clone()),
                );
            }
            self.resolve_group_ownership(
                binding,
                refreshed,
                task_id,
                &inferred,
                &mut head_tree,
                &mut resolution,
            )
            .await?;
        }

        let fresh = self
            .remember_ownership_reviews(&binding.task_space_id, &resolution.reviews)
            .await?;
        self.clear_ownership_pending(
            &binding.task_space_id,
            &resolution
                .syncable
                .keys()
                .cloned()
                .chain(
                    resolution
                        .paused
                        .iter()
                        .map(|group| group.task_dir.clone()),
                )
                .collect::<Vec<_>>(),
        )
        .await?;
        self.clear_pending_rejections(
            &binding.task_space_id,
            &resolution.syncable.keys().cloned().collect::<Vec<_>>(),
        )
        .await?;
        self.sync_ownership_inbox(binding, &previous_task_dirs, groups)
            .await;
        self.ownership_event(binding, &fresh, &resolution.project_task_spaces);
        Ok(resolution)
    }
}
impl TaskSync {
    pub(super) async fn resolve_group_ownership(
        &self,
        binding: &AgentBinding,
        group: SnapshotGroup,
        task_id: &str,
        branch_name: &str,
        head_tree: &mut Option<(String, Arc<HashSet<String>>)>,
        resolution: &mut OwnershipResolution,
    ) -> AgentResult<()> {
        if branch_name == binding.branch_name {
            resolution
                .syncable
                .insert(group.task_dir.clone(), group);
            return Ok(());
        }
        if binding.baseline_branch.as_deref() != Some(binding.branch_name.as_str()) {
            resolution.paused.push(group);
            return Ok(());
        }
        let (head, paths) = match head_tree.as_ref() {
            Some(value) => value.clone(),
            None => {
                let value = self.head_tree_paths(binding).await?;
                *head_tree = Some(value.clone());
                value
            }
        };
        let tracked_path = format!("{}/task.json", group.task_dir);
        if !paths.contains(&tracked_path) {
            resolution.paused.push(group);
            return Ok(());
        }
        resolution.merge_evidence.insert(
            group.task_dir.clone(),
            json!({
                "version": 1,
                "type": "tracked-in-head",
                "taskId": task_id,
                "taskDir": group.task_dir,
                "trackedPath": tracked_path,
                "sourceBranch": branch_name,
                "baselineBranch": binding.branch_name,
                "headCommit": head,
            }),
        );
        resolution
            .syncable
            .insert(group.task_dir.clone(), group);
        Ok(())
    }
}
