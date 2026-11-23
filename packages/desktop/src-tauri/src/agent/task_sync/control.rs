use super::*;

impl TaskSync {
    pub(super) fn wake_heartbeat(&self) {
        if let Some(wake) = &self.heartbeat_wake {
            wake.notify_one();
        }
    }
}
impl TaskSync {
    pub(super) async fn ensure_task_control_loaded(&self) {
        self.task_control_loaded
            .get_or_init(|| async {
                let state =
                    match tokio::fs::read_to_string(&self.store.paths.task_control_file).await {
                        Ok(raw) => parse_state_file(&raw),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            TaskControlStateFile::empty()
                        }
                        Err(error) => {
                            crate::logging::warn(&format!(
                                "读取任务控制状态失败，按空状态继续：{error}"
                            ));
                            TaskControlStateFile::empty()
                        }
                    };
                *self.task_control_state.lock().await = state;
            })
            .await;
    }
}
impl TaskSync {
    pub(super) async fn merge_task_controls(
        &self,
        binding: &AgentBinding,
        controls: &[TaskControl],
    ) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            let changed = state.merge_binding_controls(
                &binding.local_id,
                &binding.task_space_id,
                controls,
            )?;
            changed.then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn upsert_task_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<()> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            state
                .upsert_control(&binding.local_id, control)?
                .then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn upsert_task_handoff_control(
        &self,
        binding: &AgentBinding,
        control: &TaskControl,
    ) -> AgentResult<String> {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let key = handoff_state_key(&binding.local_id, &control.execution_task_key);
        let next = {
            let mut state = self.task_control_state.lock().await;
            state
                .upsert_handoff_control(&binding.local_id, control)?
                .then(|| state.clone())
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
        }
        Ok(key)
    }
}
impl TaskSync {
    pub(super) async fn stored_task_handoff(&self, key: &str) -> Option<StoredTaskHandoff> {
        self.ensure_task_control_loaded().await;
        self.task_control_state.lock().await.handoff(key).cloned()
    }
}
impl TaskSync {
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn mark_handoff_ack_pending(
        &self,
        key: &str,
        outcome: &str,
        reason: Option<&str>,
        backup_id: Option<&str>,
        manifest_sha256: Option<&str>,
        file_count: u64,
        total_bytes: u64,
    ) -> AgentResult<()> {
        let updated_at = protocol::now_iso8601();
        self.persist_task_control_change(|state| {
            state.mark_handoff_ack_pending(
                key,
                outcome,
                reason.map(str::to_string),
                backup_id.map(str::to_string),
                manifest_sha256.map(str::to_string),
                file_count,
                total_bytes,
                &updated_at,
            )
        })
        .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn mark_handoff_ack_done(&self, key: &str) -> AgentResult<()> {
        let updated_at = protocol::now_iso8601();
        self.persist_task_control_change(|state| state.mark_handoff_ack_done(key, &updated_at))
            .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn emit_handoff_notice(
        &self,
        binding: &AgentBinding,
        key: &str,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<()> {
        let state = if handoff.outcome == "conflict" {
            "source_cleanup_conflict"
        } else {
            handoff.server_handoff_state.as_str()
        };
        if handoff.notified_state == state {
            return Ok(());
        }
        (self.emit)(handoff_notice(binding, handoff));
        self.persist_task_control_change(|controls| controls.mark_handoff_notified(key, state))
            .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn persist_task_control_change<F>(&self, mutator: F) -> AgentResult<bool>
    where
        F: FnOnce(&mut TaskControlStateFile) -> bool,
    {
        self.ensure_task_control_loaded().await;
        let _write = self.task_control_write.lock().await;
        let next = {
            let mut state = self.task_control_state.lock().await;
            if mutator(&mut state) {
                Some(state.clone())
            } else {
                None
            }
        };
        if let Some(next) = next {
            self.store
                .write_json(&self.store.paths.task_control_file, &next)
                .await?;
            return Ok(true);
        }
        Ok(false)
    }
}
impl TaskSync {
    pub(super) async fn save_task_lease(
        &self,
        execution_task_key: &str,
        lease: Value,
    ) -> AgentResult<()> {
        let token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "租约响应缺少 token"))?;
        let expires_at = lease
            .get("expiresAt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let stored = StoredTaskLease {
            token: token.to_string(),
            expires_at: expires_at.to_string(),
            lease_id: lease.get("id").and_then(Value::as_str).map(str::to_string),
            updated_at: protocol::now_iso8601(),
        };
        self.persist_task_control_change(|state| state.set_lease(execution_task_key, stored))
            .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn stored_task_lease(
        &self,
        execution_task_key: &str,
    ) -> Option<StoredTaskLease> {
        self.ensure_task_control_loaded().await;
        self.task_control_state
            .lock()
            .await
            .leases
            .get(execution_task_key)
            .cloned()
    }
}
impl TaskSync {
    pub(super) async fn has_persisted_task_control(&self, execution_task_key: &str) -> bool {
        self.ensure_task_control_loaded().await;
        self.task_control_state
            .lock()
            .await
            .controls
            .contains_key(execution_task_key)
    }
}
impl TaskSync {
    pub(super) async fn remove_task_lease(&self, execution_task_key: &str) -> AgentResult<()> {
        self.persist_task_control_change(|state| state.remove_lease(execution_task_key))
            .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn update_control_task_version(
        &self,
        execution_task_key: &str,
        task_version: u64,
    ) -> AgentResult<()> {
        self.persist_task_control_change(|state| {
            state.update_task_version(execution_task_key, task_version)
        })
        .await?;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn claim_remote_task(
        &self,
        binding: &AgentBinding,
        execution_task_key: &str,
    ) -> AgentResult<(TaskControl, String)> {
        let encoded = urlencode(execution_task_key);
        let response = self
            .api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/claim"),
                None,
                Duration::from_secs(60),
            )
            .await?;
        let task = response
            .get("task")
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 task"))?;
        let control = TaskControl::from_task_value(task)?;
        let lease = response
            .get("lease")
            .filter(|lease| !lease.is_null())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 lease"))?;
        let lease_token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务认领响应缺少 lease.token"))?
            .to_string();
        self.upsert_task_control(binding, &control).await?;
        self.save_task_lease(&control.execution_task_key, lease.clone())
            .await?;
        Ok((control, lease_token))
    }
}
impl TaskSync {
    pub(super) async fn heartbeat_remote_task(
        &self,
        binding: &AgentBinding,
        execution_task_key: &str,
        lease_token: &str,
    ) -> AgentResult<(TaskControl, String)> {
        let encoded = urlencode(execution_task_key);
        let response = self
            .api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/heartbeat"),
                Some(&json!({ "leaseToken": lease_token })),
                Duration::from_secs(60),
            )
            .await?;
        let task = response
            .get("task")
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 task"))?;
        let control = TaskControl::from_task_value(task)?;
        let lease = response
            .get("lease")
            .filter(|lease| !lease.is_null())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 lease"))?;
        let next_token = lease
            .get("token")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务心跳响应缺少 lease.token"))?
            .to_string();
        self.upsert_task_control(binding, &control).await?;
        self.save_task_lease(&control.execution_task_key, lease.clone())
            .await?;
        Ok((control, next_token))
    }
}
impl TaskSync {
    pub(super) async fn release_remote_task(
        &self,
        execution_task_key: &str,
        lease_token: &str,
    ) -> AgentResult<Value> {
        let encoded = urlencode(execution_task_key);
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/release"),
                Some(&json!({ "leaseToken": lease_token })),
                Duration::from_secs(60),
            )
            .await
    }
}
impl TaskSync {
    /// 任务命令完成后主动释放写租约。
    ///
    /// 设计允许“先释放租约”再让创建者清理源副本；目标客户端若继续持有租约，
    /// 创建者的 handoff 清理会一直收敛为 `lease_active` 冲突。释放失败不影响
    /// 命令结果，后续用户编辑时上传路径会重新 claim。
    pub(crate) async fn release_execution_lease(&self, execution_task_key: &str) {
        let Some(lease) = self.stored_task_lease(execution_task_key).await else {
            return;
        };
        match self
            .release_remote_task(execution_task_key, &lease.token)
            .await
        {
            Ok(_) => {}
            Err(error)
                if matches!(
                    error.server_code.as_deref(),
                    Some("TASK_LEASE_INVALID") | Some("TASK_LEASE_REQUIRED") | Some("NOT_FOUND")
                ) => {}
            Err(error) => {
                crate::logging::warn(&format!(
                    "命令完成后释放任务租约失败 {}：{}",
                    execution_task_key,
                    protocol::safe_error_message(&error.message)
                ));
                return;
            }
        }
        if let Err(error) = self.remove_task_lease(execution_task_key).await {
            crate::logging::warn(&format!(
                "删除命令任务租约失败 {}：{}",
                execution_task_key,
                protocol::safe_error_message(&error.message)
            ));
        }
    }
}
impl TaskSync {
    pub(super) async fn ack_remote_handoff(
        &self,
        handoff: &StoredTaskHandoff,
    ) -> AgentResult<Value> {
        let encoded = urlencode(&handoff.execution_task_key);
        let body = handoff_ack_request(handoff)?;
        self.api
            .request_json(
                Method::POST,
                &format!("/api/agent/tasks/{encoded}/handoff-ack"),
                Some(&body),
                Duration::from_secs(60),
            )
            .await
    }
}
impl TaskSync {
    /// 旧版持久记录可能没有轮次字段：发送前用本地最新控制回填请求副本，
    /// 不改写持久记录，避免把回填结果当成新的服务端事实。
    pub(super) async fn handoff_ack_cycle_backfill(
        &self,
        handoff: &StoredTaskHandoff,
    ) -> StoredTaskHandoff {
        let mut effective = handoff.clone();
        if effective.materialized_at.is_none() && effective.materialized_revision.is_none() {
            self.ensure_task_control_loaded().await;
            let state = self.task_control_state.lock().await;
            if let Some(control) = state.controls.get(&handoff.execution_task_key) {
                effective.materialized_at = control.materialized_at.clone();
                effective.materialized_revision = control.materialized_revision;
            }
        }
        effective
    }
}
impl TaskSync {
    pub(super) async fn attempt_handoff_ack(&self, key: &str) -> AgentResult<bool> {
        let Some(handoff) = self.stored_task_handoff(key).await else {
            return Ok(false);
        };
        if handoff.ack_state != "pending" || handoff.outcome.is_empty() {
            return Ok(false);
        }
        let effective = self.handoff_ack_cycle_backfill(&handoff).await;
        match self.ack_remote_handoff(&effective).await {
            Ok(_) => {
                self.mark_handoff_ack_done(key).await?;
                Ok(true)
            }
            Err(error) if error.server_code.as_deref() == Some("HANDOFF_CYCLE_STALE") => {
                // 服务端已进入新一轮物化：保持 pending，由下一次控制同步按新轮次重置后重新清理。
                crate::logging::warn(&format!(
                    "handoff ACK 属于旧物化轮次 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                Ok(false)
            }
            Err(error) if error.server_code.as_deref() == Some("HANDOFF_LEASE_HELD") => {
                self.mark_handoff_ack_pending(
                    key,
                    "conflict",
                    Some("lease_active"),
                    handoff.backup_id.as_deref(),
                    handoff.manifest_sha256.as_deref(),
                    handoff.file_count,
                    handoff.total_bytes,
                )
                .await?;
                crate::logging::warn(&format!(
                    "handoff ACK 被有效租约阻止 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                Ok(false)
            }
            Err(error) => {
                crate::logging::warn(&format!(
                    "handoff ACK 暂未送达 {}：{}",
                    handoff.task_id,
                    protocol::safe_error_message(&error.message)
                ));
                Ok(false)
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn process_handoff_controls(
        &self,
        binding: &AgentBinding,
        controls: &[TaskControl],
    ) -> AgentResult<()> {
        self.cleanup_handoff_trash(binding).await;
        self.retry_pending_handoff_acks(binding).await?;
        for control in controls.iter().filter(|control| {
            control.state == "handoff_materialized"
                && matches!(
                    control.handoff_state.as_str(),
                    "source_cleanup_pending" | "source_cleanup_conflict"
                )
        }) {
            self.process_handoff_control(binding, control).await?;
        }
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn remote_task_control(
        &self,
        _binding: &AgentBinding,
        execution_task_key: &str,
    ) -> AgentResult<Option<TaskControl>> {
        let encoded = urlencode(execution_task_key);
        match self
            .api
            .request_json(
                Method::GET,
                &format!("/api/agent/tasks/{encoded}"),
                None,
                Duration::from_secs(60),
            )
            .await
        {
            Ok(response) => {
                let task = response.get("task").ok_or_else(|| {
                    AgentError::new(code::INVALID_RESPONSE, "任务控制响应缺少 task")
                })?;
                let control = TaskControl::from_task_value(task)?;
                self.update_control_task_version(&control.execution_task_key, control.task_version)
                    .await?;
                Ok(Some(control))
            }
            Err(error)
                if error.status == Some(404)
                    || error.server_code.as_deref() == Some("NOT_FOUND") =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}
impl TaskSync {
    pub(super) async fn prepare_controlled_server_groups(
        &self,
        binding: &AgentBinding,
        controls: Option<&[TaskControl]>,
        groups: &mut Vec<SnapshotGroup>,
    ) -> AgentResult<()> {
        let Some(controls) = controls else {
            return Ok(());
        };
        let selected = selected_server_task_ids(Some(controls)).unwrap_or_default();
        groups.retain(|group| {
            group
                .task_id
                .as_ref()
                .is_some_and(|task_id| selected.contains(task_id))
        });
        let mut allowed = Vec::with_capacity(groups.len());
        for group in groups.drain(..) {
            let Some(task_id) = group.task_id.as_deref() else {
                continue;
            };
            let Some(control) = controls.iter().find(|control| control.task_id == task_id) else {
                continue;
            };
            if !control.is_writable_local() {
                continue;
            }
            match self
                .claim_remote_task(binding, &control.execution_task_key)
                .await
            {
                Ok(_) => allowed.push(group),
                Err(error)
                    if matches!(
                        error.server_code.as_deref(),
                        Some("TASK_ARCHIVED")
                            | Some("TASK_WRITE_FORBIDDEN")
                            | Some("TASK_LEASE_HELD")
                            | Some("TASK_LEASE_INVALID")
                            | Some("FORBIDDEN")
                    ) =>
                {
                    crate::logging::warn(&format!(
                        "跳过不可落地任务 {}：{}",
                        control.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                }
                Err(error) => return Err(error),
            }
        }
        *groups = allowed;
        Ok(())
    }
}
impl TaskSync {
    pub(super) async fn release_inactive_task_leases(&self, controls: Option<&[TaskControl]>) {
        let Some(controls) = controls else {
            return;
        };
        for control in controls
            .iter()
            .filter(|control| !control.is_writable_local())
        {
            crate::logging::warn(&format!(
                "任务进入 {:?} 控制状态，本地数据保留并停止写回：{}",
                control.control_state(),
                control.relative_dir
            ));
            let Some(lease) = self.stored_task_lease(&control.execution_task_key).await else {
                continue;
            };
            match self
                .release_remote_task(&control.execution_task_key, &lease.token)
                .await
            {
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.server_code.as_deref(),
                        Some("TASK_LEASE_INVALID")
                            | Some("TASK_LEASE_REQUIRED")
                            | Some("FORBIDDEN")
                            | Some("NOT_FOUND")
                    ) => {}
                Err(error) => {
                    crate::logging::warn(&format!(
                        "释放失效任务租约失败 {}：{}",
                        control.task_id,
                        protocol::safe_error_message(&error.message)
                    ));
                }
            }
            if let Err(error) = self.remove_task_lease(&control.execution_task_key).await {
                crate::logging::warn(&format!(
                    "删除本地失效任务租约失败 {}：{}",
                    control.task_id,
                    protocol::safe_error_message(&error.message)
                ));
            }
        }
    }
}
impl TaskSync {
    pub(super) async fn persisted_control_key_for_upload(
        &self,
        binding: &AgentBinding,
        files: &[Value],
    ) -> AgentResult<Option<String>> {
        let task_dirs: BTreeSet<String> = files
            .iter()
            .filter_map(|file| {
                file.get("path")
                    .and_then(Value::as_str)
                    .and_then(active_task_directory_from_relative)
            })
            .collect();
        if task_dirs.is_empty() {
            return Ok(None);
        }
        self.ensure_task_control_loaded().await;
        let state = self.task_control_state.lock().await;
        let execution_task_keys: BTreeSet<String> = task_dirs
            .iter()
            .filter_map(|task_dir| {
                state
                    .execution_task_key_for_dir(&binding.local_id, &binding.task_space_id, task_dir)
                    .cloned()
            })
            .collect();
        if execution_task_keys.len() > 1 {
            return protocol::err(
                code::INVALID_RESPONSE,
                "单个上传批次匹配到多个持久化任务控制",
            );
        }
        Ok(execution_task_keys.into_iter().next())
    }
}
