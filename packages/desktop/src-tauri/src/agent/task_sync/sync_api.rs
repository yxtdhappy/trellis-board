use super::*;

impl TaskSync {
    pub(crate) async fn claim_execution_task(
        &self,
        task_space_id: &str,
        execution_task_key: &str,
    ) -> AgentResult<Value> {
        if !execution_task_key.starts_with(&format!("{task_space_id}::")) {
            return protocol::err(code::COMMAND_INVALID, "任务执行身份与当前任务空间不一致");
        }
        let binding = self.binding(task_space_id).await?;
        let (control, _) = self
            .claim_remote_task(&binding, execution_task_key)
            .await?;
        Ok(json!({
            "executionTaskKey": control.execution_task_key,
            "taskId": control.task_id,
            "taskVersion": control.task_version,
            "state": control.state,
            "handoffState": control.handoff_state,
        }))
    }
}
impl TaskSync {
    pub async fn sync_task_directories(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
        reconcile: bool,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let serial = self.task_space_sync_lock(task_space_id).await;
        let _serial = serial.lock().await;
        self.upload_directories(&binding, task_dirs, reconcile, None)
            .await
    }
}
impl TaskSync {
    pub async fn sync_task_directories_with_base(
        &self,
        task_space_id: &str,
        task_dirs: &[String],
        base_sha: Option<&BTreeMap<String, String>>,
    ) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        let serial = self.task_space_sync_lock(task_space_id).await;
        let _serial = serial.lock().await;
        self.upload_directories(&binding, task_dirs, false, base_sha)
            .await
    }
}
impl TaskSync {
    pub async fn list_task_ownership(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        self.cleanup_missing_ownership_inbox(&binding, None).await?;
        let groups = self.local_groups(&binding, None).await?;
        let cursor = self.read_cursor(task_space_id).await;
        let ledger_task_dirs = ownership_ledger_task_dirs(&cursor);
        self.sync_ownership_inbox(&binding, &ledger_task_dirs, &groups)
            .await;
        let candidates: Vec<SnapshotGroup> = groups
            .into_iter()
            .filter(|group| {
                group
                    .task_branch
                    .as_deref()
                    .map(|branch| branch != binding.branch_name)
                    .unwrap_or(false)
                    || cursor.ownership_pending.contains_key(&group.task_dir)
            })
            .collect();
        let resolution = self.resolve_task_ownership(&binding, &candidates).await?;
        let mut project_task_spaces = resolution.project_task_spaces.clone();
        if let Ok(result) = self
            .fetch_task_ownership(&binding.task_space_id, &[])
            .await
        {
            if let Some(items) = result
                .get("projectTaskSpaces")
                .and_then(Value::as_array)
                .filter(|items| !items.is_empty())
            {
                project_task_spaces = items.clone();
            }
        }
        let mut items: Vec<Value> = resolution
            .paused
            .iter()
            .map(|group| {
                json!({
                    "taskId": group.task_id,
                    "taskDir": group.task_dir,
                    "title": task_title(group).or_else(|| group.task_id.clone()),
                    "branchName": group.task_branch,
                    "suggestedBranchName": Value::Null,
                    "choices": project_task_spaces.clone(),
                })
            })
            .collect();
        items.extend(resolution.reviews.iter().map(|review| {
            json!({
                "taskId": review.group.task_id,
                "taskDir": review.group.task_dir,
                "title": task_title(&review.group).or_else(|| review.group.task_id.clone()),
                "branchName": review.group.task_branch,
                "suggestedBranchName": Value::Null,
                "choices": project_task_spaces.clone(),
            })
        }));
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "branchName": binding.branch_name,
            "projectTaskSpaces": project_task_spaces,
            "items": items,
        }))
    }
}
impl TaskSync {
    pub async fn set_task_ownership(
        &self,
        task_space_id: &str,
        decisions: Value,
    ) -> AgentResult<Value> {
        let raw = decisions
            .as_array()
            .cloned()
            .ok_or_else(|| AgentError::new(code::CONFIG_INVALID, "任务归属决定必须是数组"))?;
        if raw.is_empty() || raw.len() > TASK_OWNERSHIP_QUERY_LIMIT {
            return protocol::err(
                code::CONFIG_INVALID,
                "任务归属决定必须包含 1 到 200 个任务",
            );
        }
        let binding = self.binding(task_space_id).await?;
        self.assert_binding_branch(&binding).await?;
        let groups = self.local_groups(&binding, None).await?;
        let groups_by_dir: HashMap<String, SnapshotGroup> = groups
            .into_iter()
            .map(|group| (group.task_dir.clone(), group))
            .collect();
        let mut normalized = Vec::with_capacity(raw.len());
        let mut seen = HashSet::new();
        for item in raw {
            let task_dir = item
                .get("taskDir")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if active_task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref()
                != Some(task_dir.as_str())
                || !groups_by_dir.contains_key(&task_dir)
            {
                return protocol::err(code::CONFIG_INVALID, "任务归属决定包含无效的任务目录");
            }
            if !seen.insert(task_dir.clone()) {
                return protocol::err(code::CONFIG_INVALID, "同一任务不能重复提交归属决定");
            }
            let action = item
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if action != "use-branch" && action != "defer" {
                return protocol::err(code::CONFIG_INVALID, "任务归属动作无效");
            }
            let branch_name = item
                .get("branchName")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if action == "use-branch" && branch_name.is_empty() {
                return protocol::err(code::CONFIG_INVALID, "归属任务时必须选择有效分支");
            }
            normalized.push(OwnershipDecision {
                task_dir,
                action,
                branch_name,
            });
        }

        let task_ids: Vec<String> = normalized
            .iter()
            .filter_map(|decision| groups_by_dir.get(&decision.task_dir)?.task_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let ownership = if normalized
            .iter()
            .any(|decision| decision.action == "use-branch")
        {
            self.fetch_task_ownership(&binding.task_space_id, &task_ids)
                .await?
        } else {
            json!({ "projectTaskSpaces": [] })
        };
        let mut allowed_branches: HashSet<String> = ownership
            .get("projectTaskSpaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|space| space.get("branchName").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        allowed_branches.insert(binding.branch_name.clone());
        for decision in &normalized {
            if decision.action == "use-branch"
                && !allowed_branches.contains(&decision.branch_name)
            {
                return protocol::err(
                    code::CONFIG_INVALID,
                    "只能把任务归属到当前项目可见的有效分支",
                );
            }
        }

        let cursor = self.read_cursor(task_space_id).await;
        let ledger_task_dirs = ownership_ledger_task_dirs(&cursor);
        let mut pending = cursor.ownership_pending.clone();
        let mut current_branch = Vec::new();
        let mut applied = 0usize;
        let mut deferred = 0usize;
        for decision in &normalized {
            if decision.action == "defer" {
                let group = groups_by_dir
                    .get(&decision.task_dir)
                    .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "本地任务不存在"))?;
                pending.insert(decision.task_dir.clone(), task_fingerprint(group));
                deferred += 1;
                continue;
            }
            crate::agent::task_command::set_task_directory_branch(
                Path::new(&binding.repo_path),
                &decision.task_dir,
                &decision.branch_name,
            )
            .await?;
            pending.remove(&decision.task_dir);
            applied += 1;
            if decision.branch_name == binding.branch_name {
                current_branch.push(decision.task_dir.clone());
            }
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
        self.clear_pending_rejections(
            task_space_id,
            &normalized
                .iter()
                .map(|decision| decision.task_dir.clone())
                .collect::<Vec<_>>(),
        )
        .await?;
        let ownership_groups: Vec<SnapshotGroup> =
            groups_by_dir.values().cloned().collect();
        self.sync_ownership_inbox(&binding, &ledger_task_dirs, &ownership_groups)
            .await;
        let sync = if current_branch.is_empty() {
            Value::Null
        } else {
            self.sync_task_directories(task_space_id, &current_branch, true)
                .await?
        };
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "appliedCount": applied,
            "deferredCount": deferred,
            "currentBranchCount": current_branch.len(),
            "sync": sync,
        }))
    }
}
impl TaskSync {
    /// 显式补同步首次同步时暂缓的本地任务目录（对照 JS `syncDeferredTasks`）。
    pub async fn sync_deferred_tasks(&self, task_space_id: &str) -> AgentResult<Value> {
        let binding = self.binding(task_space_id).await?;
        if binding.read_only {
            return protocol::err(code::COMMAND_INVALID, "只读关联不能上传本地任务");
        }
        let cursor = self.read_cursor(&binding.task_space_id).await;
        let readonly: HashSet<String> = cursor.readonly_task_dirs.keys().cloned().collect();
        if cursor.deferred.keys().any(|task_dir| readonly.contains(task_dir)) {
            let mut deferred = cursor.deferred.clone();
            deferred.retain(|task_dir, _| !readonly.contains(task_dir));
            self.write_cursor(
                &binding.task_space_id,
                CursorPatch {
                    deferred: Some(deferred),
                    ..Default::default()
                },
            )
            .await?;
        }
        let mut task_dirs: Vec<String> = cursor
            .deferred
            .keys()
            .filter(|task_dir| !readonly.contains(*task_dir))
            .cloned()
            .collect();
        if task_dirs.is_empty() {
            return Ok(json!({
                "taskSpaceId": binding.task_space_id,
                "syncedCount": 0,
                "remainingCount": 0,
                "remainingTaskDirs": [],
                "conflict": false,
                "conflictId": Value::Null,
            }));
        }
        task_dirs.sort_unstable();
        let uploaded = self
            .upload_directories(&binding, &task_dirs, true, None)
            .await?;
        let next = self.read_cursor(&binding.task_space_id).await;
        let mut remaining: Vec<String> = next.deferred.keys().cloned().collect();
        remaining.sort_unstable();
        let skipped = uploaded.get("skipped").and_then(Value::as_bool) == Some(true);
        let conflict = uploaded.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT");
        Ok(json!({
            "taskSpaceId": binding.task_space_id,
            "syncedCount": if conflict || skipped { 0 } else { task_dirs.len().saturating_sub(remaining.len()) },
            "remainingCount": remaining.len(),
            "remainingTaskDirs": remaining,
            "skipped": skipped,
            "reason": uploaded.get("reason").cloned().unwrap_or(Value::Null),
            "conflict": conflict,
            "conflictId": if conflict {
                uploaded.get("conflictId").cloned().unwrap_or(Value::Null)
            } else {
                Value::Null
            },
        }))
    }
}
