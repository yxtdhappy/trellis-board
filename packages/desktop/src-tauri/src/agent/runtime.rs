use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{watch, Mutex as AsyncMutex, Notify};

use crate::agent::control::ControlHub;
use crate::agent::credential::CredentialStore;
use crate::agent::detach::{self, DetachOutcome};
use crate::agent::http::{ApiClient, SseFrame};
use crate::agent::protocol::{
    self, code, safe_error_message, AgentCommand, AgentError, AgentResult, HeartbeatResponse,
    ServerBinding, AGENT_PROTOCOL_VERSION, AGENT_VERSION, LISTENER_REPORT_VERSION,
};
use crate::agent::state_events::StateSink;
use crate::agent::store::{AgentBinding, AgentConfig, ConfigStore};
use crate::agent::task_sync::{ControlSink, TaskSync};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const RETRY_BASE: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(60);
const COMMAND_MAX_RETRIES_WAITING_INDEX: usize = 8;
const COMMAND_MAX_RETRIES_OTHER: usize = 2;

pub struct AgentRuntime {
    store: Arc<ConfigStore>,
    api: Arc<ApiClient>,
    paused: Arc<AtomicBool>,
    task_sync: Arc<TaskSync>,
    heartbeat_wake: Arc<Notify>,
    shutdown: watch::Sender<bool>,
    stopped: AtomicBool,
    agent_id: String,
    detach_lock: AsyncMutex<()>,
}

impl AgentRuntime {
    pub async fn start(
        store: Arc<ConfigStore>,
        emit: ControlSink,
        state_sink: StateSink,
        paused: Arc<AtomicBool>,
        hub: &ControlHub,
    ) -> AgentResult<Arc<Self>> {
        store.ensure_directories().await?;
        let config = store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?;
        let credentials = CredentialStore::new(&store);
        let credential = credentials.load_credential().await?;
        let ca_file = config
            .ca_file
            .as_ref()
            .map(std::path::PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty());
        let api = Arc::new(ApiClient::new(
            &config.server_url,
            Some(credential),
            ca_file.as_deref(),
        )?);
        let heartbeat_wake = Arc::new(Notify::new());
        let task_sync = Arc::new(
            TaskSync::new(store.clone(), api.clone(), emit.clone())
                .with_state_sink(state_sink)
                .with_heartbeat_wake(heartbeat_wake.clone())
                .with_ownership_index_writer(),
        );
        task_sync.ensure_ownership_validation_worker();
        let (shutdown, _) = watch::channel(false);
        let runtime = Arc::new(Self {
            store,
            api,
            paused,
            task_sync,
            heartbeat_wake,
            shutdown,
            stopped: AtomicBool::new(false),
            agent_id: config.agent_id.clone(),
            detach_lock: AsyncMutex::new(()),
        });
        runtime.write_state("running", None, None).await;
        let startup_task_space_ids = runtime
            .task_sync
            .prepare_startup_bindings(config.bindings.clone())
            .await;
        let startup = runtime.clone();
        tauri::async_runtime::spawn(async move {
            let mut shutdown = startup.shutdown.subscribe();
            if *shutdown.borrow() {
                return;
            }
            tokio::select! {
                _ = startup.task_sync.sync_task_spaces(startup_task_space_ids) => {}
                _ = shutdown.changed() => {}
            }
        });
        runtime.spawn_event_loop();
        runtime.spawn_heartbeat_loop();
        hub.resume();
        Ok(runtime)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub(crate) fn task_sync(&self) -> &TaskSync {
        &self.task_sync
    }

    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.shutdown.send(true);
        self.write_state_blocking("stopped", None, None);
    }

    fn spawn_heartbeat_loop(self: &Arc<Self>) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut shutdown = runtime.shutdown.subscribe();
            let mut delay = RETRY_BASE;
            let mut next_delay = Duration::ZERO;
            loop {
                tokio::select! {
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            break;
                        }
                    }
                    _ = runtime.heartbeat_wake.notified() => {}
                    _ = tokio::time::sleep(next_delay) => {}
                }
                if runtime.is_paused() {
                    next_delay = HEARTBEAT_INTERVAL;
                    continue;
                }
                match runtime.heartbeat_once().await {
                    Ok(()) => {
                        delay = RETRY_BASE;
                        next_delay = HEARTBEAT_INTERVAL;
                    }
                    Err(error) if protocol::is_authentication_error(&error) => {
                        runtime
                            .write_state("error", Some(&error), Some("AUTH_REVOKED"))
                            .await;
                        runtime.stop();
                        break;
                    }
                    Err(error) => {
                        let message = safe_error_message(&error.to_string());
                        runtime.write_state("error", None, Some(&message)).await;
                        let _ = runtime
                            .api
                            .request_json(
                                reqwest::Method::GET,
                                "/api/health",
                                None,
                                Duration::from_secs(10),
                            )
                            .await;
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(RETRY_MAX);
                        next_delay = Duration::ZERO;
                    }
                }
            }
        });
    }

    async fn heartbeat_once(&self) -> AgentResult<()> {
        if let Err(error) = self.retry_pending_detachments().await {
            crate::logging::warn(&format!(
                "重试服务端解绑失败：{}",
                safe_error_message(&error.to_string())
            ));
        }
        let config = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?;
        self.task_sync
            .update_bindings(config.bindings.clone())
            .await;
        let listening_task_space_ids: Vec<String> = self
            .task_sync
            .active_bindings()
            .await
            .into_iter()
            .map(|binding| binding.task_space_id)
            .collect();
         let body = heartbeat_payload(&config, &listening_task_space_ids);
        let response = self
            .api
            .request_json(
                reqwest::Method::POST,
                "/api/agent/heartbeat",
                Some(&body),
                Duration::from_secs(30),
            )
            .await?;
        let heartbeat = protocol::parse_heartbeat_response(&response)?;
        let merged = self
            .store
            .update_config(false, |current| {
                let Some(config) = current else {
                    return Err(AgentError::new(
                        code::CONFIG_MISSING,
                        "Agent 配置缺失，请重新登录",
                    ));
                };
                let mut next = config.clone();
                if merge_heartbeat_bindings(&mut next, &heartbeat) {
                    Ok(Some(next))
                } else {
                    Ok(None)
                }
            })
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?;
        self.task_sync.update_bindings(merged.bindings).await;
        Ok(())
    }

    async fn apply_bindings(&self, bindings: Vec<AgentBinding>) {
        self.task_sync.update_bindings(bindings).await;
    }

    pub async fn detach_local_association(
        &self,
        task_space_id: &str,
    ) -> AgentResult<DetachOutcome> {
        let _guard = self.detach_lock.lock().await;
        detach::detach_local_association(
            &self.store,
            &self.api,
            &self.task_sync,
            task_space_id,
            true,
        )
        .await
    }

    async fn retry_pending_detachments(&self) -> AgentResult<()> {
        let pending: Vec<String> = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?
            .bindings
            .into_iter()
            .filter(|binding| binding.detach_pending)
            .map(|binding| binding.task_space_id)
            .collect();
        if pending.is_empty() {
            return Ok(());
        }
        let _guard = self.detach_lock.lock().await;
        let pending: Vec<String> = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?
            .bindings
            .into_iter()
            .filter(|binding| binding.detach_pending)
            .map(|binding| binding.task_space_id)
            .collect();
        let mut first_error: Option<AgentError> = None;
        for task_space_id in pending {
            if let Err(error) = detach::detach_local_association(
                &self.store,
                &self.api,
                &self.task_sync,
                &task_space_id,
                true,
            )
            .await
            {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    async fn command_is_active(&self, command: &AgentCommand) -> bool {
        let Ok(Some(config)) = self.store.read_config(false).await else {
            return false;
        };
        command_target_active(&config.bindings, command)
    }

    fn spawn_event_loop(self: &Arc<Self>) {
        let runtime = self.clone();
        let queue: Arc<Mutex<VecDeque<SseFrame>>> = Arc::new(Mutex::new(VecDeque::new()));
        let notify = Arc::new(Notify::new());
        tauri::async_runtime::spawn(async move {
            let mut shutdown = runtime.shutdown.subscribe();
            let mut delay = RETRY_BASE;
            let mut reconnect = false;
            loop {
                if *shutdown.borrow() {
                    break;
                }
                if runtime.is_paused() {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                let last_event_id = runtime
                    .store
                    .read_event_cursors()
                    .await
                    .get("_global")
                    .map(|cursor| cursor.to_string());
                let frame_queue = queue.clone();
                let frame_notify = notify.clone();
                let api = runtime.api.clone();
                let stream = tokio::spawn(async move {
                    api.stream_events(last_event_id.as_deref(), move |frame| {
                        if let Ok(mut guard) = frame_queue.lock() {
                            guard.push_back(frame);
                        }
                        frame_notify.notify_one();
                        Ok(())
                    })
                    .await
                });
                tokio::pin!(stream);
                let outcome: AgentResult<()> = loop {
                    tokio::select! {
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                stream.abort();
                                return;
                            }
                        }
                        _ = notify.notified() => {
                            let frames: Vec<SseFrame> = queue
                                .lock()
                                .map(|mut guard| guard.drain(..).collect())
                                .unwrap_or_default();
                            for frame in frames {
                                if let Err(error) = runtime.handle_frame(frame).await {
                                    if protocol::is_authentication_error(&error) {
                                        stream.abort();
                                        runtime
                                            .write_state("error", Some(&error), Some("AUTH_REVOKED"))
                                            .await;
                                        runtime.stop();
                                        return;
                                    }
                                }
                            }
                        }
                        result = &mut stream => {
                            break match result {
                                Ok(inner) => inner,
                                Err(error) => Err(AgentError::new(
                                    code::NETWORK_ERROR,
                                    format!("事件流读取失败: {error}"),
                                )),
                            };
                        }
                    }
                };
                match outcome {
                    Ok(()) => delay = RETRY_BASE,
                    Err(error) if protocol::is_authentication_error(&error) => {
                        runtime
                            .write_state("error", Some(&error), Some("AUTH_REVOKED"))
                            .await;
                        runtime.stop();
                        break;
                    }
                    Err(error) => {
                        let message = safe_error_message(&error.to_string());
                        runtime.write_state("error", None, Some(&message)).await;
                    }
                }
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {}
                    _ = shutdown.changed() => break,
                }
                if reconnect {
                    // 事件流曾经断开：重连前按最新绑定重新拉取，补齐断线期间的变更。
                    if let Ok(Some(config)) = runtime.store.read_config(false).await {
                        runtime.apply_bindings(config.bindings).await;
                    } else {
                        crate::logging::warn("事件流恢复后同步任务空间失败：无法读取 Agent 配置");
                    }
                }
                reconnect = true;
                delay = (delay * 2).min(RETRY_MAX);
            }
        });
    }

    async fn handle_frame(self: &Arc<Self>, frame: SseFrame) -> AgentResult<()> {
        if let Some(event_id) = frame.id.as_deref().and_then(|id| id.parse::<i64>().ok()) {
            let _ = self.store.write_event_cursor("_global", event_id).await;
        }
        let event_type = frame.event.as_deref().unwrap_or("message");
        let data = frame.data.clone();
        match event_type {
            "agent.revoked" => {
                self.write_state("revoked", None, Some("设备已被服务端吊销"))
                    .await;
                self.stop();
                Ok(())
            }
            "cursor.invalidated" => {
                let _ = self.store.clear_event_cursor("_global").await;
                let config = self.store.read_config(false).await?.ok_or_else(|| {
                    AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录")
                })?;
                self.apply_bindings(config.bindings).await;
                Ok(())
            }
            "task.changed" => {
                if let Some(task_space_id) = data.get("taskSpaceId").and_then(Value::as_str) {
                    let revision = data.get("revision").and_then(Value::as_u64);
                    self.task_sync
                        .pull_and_report_for_event(task_space_id, revision)
                        .await;
                }
                Ok(())
            }
            "control.changed" => {
                if let Some(task_space_id) = data.get("taskSpaceId").and_then(Value::as_str) {
                    self.task_sync
                        .pull_and_report_for_event(task_space_id, None)
                        .await;
                }
                Ok(())
            }
            "command" => {
                let raw = command_from_frame(&data);
                match protocol::validate_command(&raw) {
                    Ok(command) => {
                        let runtime = self.clone();
                        tauri::async_runtime::spawn(async move {
                            runtime.run_command(command).await;
                        });
                        Ok(())
                    }
                    Err(error) => {
                        self.write_state(
                            "running",
                            None,
                            Some(&safe_error_message(&error.to_string())),
                        )
                        .await;
                        Ok(())
                    }
                }
            }
            _ => Ok(()),
        }
    }

    async fn run_command(self: &Arc<Self>, command: AgentCommand) {
        let mut shutdown = self.shutdown.subscribe();
        if *shutdown.borrow() {
            return;
        }
        tokio::select! {
            _ = self.task_sync.wait_for_binding_sync() => {}
            _ = shutdown.changed() => return,
        }
        if *shutdown.borrow() {
            return;
        }
        if !self.command_is_active(&command).await {
            return;
        }
        let started = self
            .api
            .request_json(
                reqwest::Method::POST,
                &format!("/api/agent/commands/{}/start", command.id),
                Some(&json!({})),
                Duration::from_secs(60),
            )
            .await;
        let execute = started
            .as_ref()
            .ok()
            .and_then(|value| value.get("execute").and_then(Value::as_bool))
            .unwrap_or(false);
        if !execute {
            return;
        }
        let mut attempts = 0usize;
        loop {
            let result = self.dispatch(&command).await;
            let payload = match result {
                Ok(value) => value,
                Err(error) => protocol::build_command_result("failed", None, Some(&error))
                    .unwrap_or_else(|_| {
                        json!({
                            "status": "failed",
                            "error": format!(
                                "{}: {}",
                                error.code,
                                safe_error_message(&error.message)
                            ),
                        })
                    }),
            };
            let outcome = self
                .api
                .request_json(
                    reqwest::Method::POST,
                    &format!("/api/agent/commands/{}/result", command.id),
                    Some(&payload),
                    Duration::from_secs(60),
                )
                .await;
            match outcome {
                Ok(_) => return,
                Err(error) => {
                    let waiting_index = error
                        .details
                        .as_ref()
                        .and_then(|details| details.get("waitingIndex"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let limit = if waiting_index {
                        COMMAND_MAX_RETRIES_WAITING_INDEX
                    } else {
                        COMMAND_MAX_RETRIES_OTHER
                    };
                    attempts += 1;
                    if attempts > limit {
                        return;
                    }
                    tokio::time::sleep(RETRY_BASE * attempts as u32).await;
                }
            }
        }
    }

    async fn dispatch(&self, command: &AgentCommand) -> AgentResult<Value> {
        let context = crate::agent::task_command::CommandContext {
            store: &self.store,
            task_sync: &self.task_sync,
        };
        crate::agent::task_command::run_command(&context, command).await
    }

    async fn write_state(&self, status: &str, error: Option<&AgentError>, message: Option<&str>) {
        let payload = json!({
            "schemaVersion": 2,
            "status": status,
            "agentId": self.agent_id,
            "updatedAt": protocol::now_iso8601(),
            "lastErrorCode": error.map(|value| value.code.clone()),
            "lastError": message,
        });
        let _ = self.store.write_state(payload).await;
    }

    fn write_state_blocking(
        &self,
        status: &str,
        error: Option<&AgentError>,
        message: Option<&str>,
    ) {
        let payload = json!({
            "schemaVersion": 2,
            "status": status,
            "agentId": self.agent_id,
            "updatedAt": protocol::now_iso8601(),
            "lastErrorCode": error.map(|value| value.code.clone()),
            "lastError": message,
        });
        let store = self.store.clone();
        tauri::async_runtime::spawn(async move {
            let _ = store.write_state(payload).await;
        });
    }
}

fn command_from_frame(data: &Value) -> Value {
    data.get("payload")
        .and_then(|payload| payload.get("command"))
        .or_else(|| data.get("command"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn heartbeat_payload(config: &AgentConfig, listening_task_space_ids: &[String]) -> Value {
    let public_bindings: Vec<Value> = config
        .bindings
        .iter()
        .map(|binding| {
            json!({
                "taskSpaceId": binding.task_space_id,
                "localRepoKey": binding.local_repo_key,
                "projectId": binding.project_id,
                "branchName": binding.branch_name,
                "teamId": binding.team_id,
            })
        })
        .collect();
    let mut listening_task_space_ids = listening_task_space_ids.to_vec();
    listening_task_space_ids.sort();
    listening_task_space_ids.dedup();
    json!({
        "agentId": config.agent_id,
        "deviceId": config.agent_id,
        "deviceName": config.device_name,
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "agentVersion": AGENT_VERSION,
        "listenerReportVersion": LISTENER_REPORT_VERSION,
        "listeningTaskSpaceIds": listening_task_space_ids,
        "bindings": public_bindings,
    })
}

fn command_target_active(bindings: &[AgentBinding], command: &AgentCommand) -> bool {
    bindings.iter().any(|binding| {
        (binding.server_binding_id.as_deref() == Some(command.binding_id.as_str())
            || command.payload_str("taskSpaceId") == Some(binding.task_space_id.as_str()))
            && binding.sync_status == "approved"
            && !binding.detach_pending
    })
}

fn merge_heartbeat_bindings(
    config: &mut AgentConfig,
    heartbeat: &HeartbeatResponse,
) -> bool {
    let by_task_space: HashMap<&str, &ServerBinding> = heartbeat
        .bindings
        .iter()
        .map(|binding| (binding.task_space_id.as_str(), binding))
        .collect();
    let mut changed = false;
    for binding in &mut config.bindings {
        if binding.detach_pending {
            continue;
        }
        if heartbeat.compatible && heartbeat.bindings.is_empty() {
            if binding.sync_status != "revoked"
                || binding.last_error_code.as_deref() != Some("BINDING_UNKNOWN")
                || binding.last_error.as_deref()
                    != Some("服务端已撤销该任务空间关联，请重新关联")
            {
                binding.sync_status = "revoked".to_string();
                binding.last_error_code = Some("BINDING_UNKNOWN".to_string());
                binding.last_error =
                    Some("服务端已撤销该任务空间关联，请重新关联".to_string());
                changed = true;
            }
            continue;
        }
        let Some(remote) = by_task_space.get(binding.task_space_id.as_str()).copied() else {
            continue;
        };
        if remote.local_repo_key != binding.local_repo_key {
            continue;
        }
        let branch_guarded = binding
            .last_error_code
            .as_deref()
            .is_some_and(crate::agent::task_sync::is_branch_guard_code);
        let mut next_error_code = if branch_guarded {
            binding.last_error_code.clone()
        } else {
            remote.error_code.clone()
        };
        let mut next_error = if branch_guarded {
            binding.last_error.clone()
        } else {
            remote.error.clone()
        };
        if remote
            .branch_name
            .as_deref()
            .is_some_and(|branch| !branch.is_empty() && branch != binding.branch_name)
        {
            next_error_code = Some("BINDING_BRANCH_MISMATCH".to_string());
            next_error = Some("本地分支与服务端绑定分支不一致".to_string());
        }
        let next_server_binding_id = Some(remote.id.clone());
        let next_team_id = remote.team_id.clone().or_else(|| binding.team_id.clone());
        let next_baseline_branch = remote
            .baseline_branch
            .clone()
            .or_else(|| binding.baseline_branch.clone());
        if binding.server_binding_id != next_server_binding_id
            || binding.team_id != next_team_id
            || binding.baseline_branch != next_baseline_branch
            || binding.read_only != remote.read_only
            || binding.sync_status != remote.status
            || binding.last_error_code != next_error_code
            || binding.last_error != next_error
        {
            binding.server_binding_id = next_server_binding_id;
            binding.team_id = next_team_id;
            binding.baseline_branch = next_baseline_branch;
            binding.read_only = remote.read_only;
            binding.sync_status = remote.status.clone();
            binding.last_error_code = next_error_code;
            binding.last_error = next_error;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding(task_space_id: &str) -> AgentBinding {
        AgentBinding {
            local_id: format!("local-{task_space_id}"),
            server_binding_id: Some(format!("binding-{task_space_id}")),
            task_space_id: task_space_id.to_string(),
            project_id: "project-1".to_string(),
            repo_path: format!("C:/repos/{task_space_id}"),
            branch_name: "main".to_string(),
            baseline_branch: None,
            team_id: Some("team-1".to_string()),
            remote_identity_key: "a".repeat(64),
            local_repo_key: "b".repeat(64),
            display_name: "Repo".to_string(),
            created_at: "2026-11-12T00:00:00.000Z".to_string(),
            allow_file_remote: false,
            read_only: false,
            sync_status: "approved".to_string(),
            detach_pending: false,
            initial_sync_mode: "bootstrap".to_string(),
            initial_sync_completed: true,
            initial_review_pending: false,
            live_sync_status: "ready".to_string(),
            live_sync_error: None,
            last_synced_at: None,
            last_head: None,
            last_error: None,
            last_error_code: None,
        }
    }

    fn config() -> AgentConfig {
        AgentConfig {
            schema_version: crate::agent::store::CONFIG_SCHEMA_VERSION,
            revision: "0123456789abcdef0123456789abcdef".to_string(),
            server_url: "http://localhost:4310".to_string(),
            ca_file: None,
            allow_local_git_remotes: false,
            agent_id: "agent-1".to_string(),
            device_name: "PC".to_string(),
            username: Some("dev".to_string()),
            team_id: None,
            teams: Vec::new(),
            protocol_version: 3,
            agent_version: None,
            paired_at: None,
            bindings: vec![binding("space-b"), binding("space-a")],
        }
    }

    #[test]
    fn heartbeat_payload_reports_sorted_listener_snapshot() {
        let payload = heartbeat_payload(
            &config(),
            &[
                "space-b".to_string(),
                "space-a".to_string(),
                "space-a".to_string(),
            ],
        );
        assert_eq!(payload["listenerReportVersion"], LISTENER_REPORT_VERSION);
        assert_eq!(
            payload["listeningTaskSpaceIds"],
            json!(["space-a", "space-b"])
        );
        assert_eq!(payload["bindings"].as_array().expect("bindings").len(), 2);
    }

    #[test]
    fn empty_heartbeat_revokes_bindings_but_keeps_detach_pending() {
        let mut config = config();
        config.bindings[1].detach_pending = true;
        let heartbeat = HeartbeatResponse {
            protocol_version: AGENT_PROTOCOL_VERSION,
            compatible: true,
            minimum_agent_version: None,
            bindings: Vec::new(),
        };
        assert!(merge_heartbeat_bindings(&mut config, &heartbeat));
        assert_eq!(config.bindings[0].sync_status, "revoked");
        assert_eq!(config.bindings[1].sync_status, "approved");
        assert!(config.bindings[1].detach_pending);
    }

    #[test]
    fn heartbeat_updates_server_binding_and_branch_guard() {
        let mut config = config();
        let heartbeat = HeartbeatResponse {
            protocol_version: AGENT_PROTOCOL_VERSION,
            compatible: true,
            minimum_agent_version: None,
            bindings: vec![ServerBinding {
                id: "binding-space-a".to_string(),
                task_space_id: "space-a".to_string(),
                project_id: "project-1".to_string(),
                team_id: Some("team-2".to_string()),
                local_repo_key: "b".repeat(64),
                status: "approved".to_string(),
                branch_name: Some("dev".to_string()),
                baseline_branch: None,
                error_code: None,
                error: None,
                read_only: true,
            }],
        };
        assert!(merge_heartbeat_bindings(&mut config, &heartbeat));
        let updated = config
            .bindings
            .iter()
            .find(|binding| binding.task_space_id == "space-a")
            .expect("space-a");
        assert_eq!(updated.team_id.as_deref(), Some("team-2"));
        assert!(updated.read_only);
        assert_eq!(
            updated.last_error_code.as_deref(),
            Some("BINDING_BRANCH_MISMATCH")
        );
    }

    #[test]
    fn detach_pending_blocks_new_task_commands() {
        let mut binding = binding("space-a");
        binding.detach_pending = true;
        let command = AgentCommand {
            id: "command-1".to_string(),
            binding_id: "binding-space-a".to_string(),
            kind: crate::agent::protocol::COMMAND_CREATE_TASK.to_string(),
            payload: json!({ "taskSpaceId": "space-a" }),
        };
        assert!(!command_target_active(&[binding], &command));
    }

    #[test]
    fn command_frame_supports_nested_and_legacy_shapes() {
        let command = json!({
            "id": "command-1",
            "bindingId": "binding-space-a",
            "type": "assign_task",
            "payload": {
                "taskSpaceId": "space-a",
                "assigneeUserId": "user-a",
                "executionTaskKey": "space-a::task-a"
            }
        });
        assert_eq!(
            command_from_frame(&json!({ "payload": { "command": command.clone() } })),
            command
        );
        assert_eq!(command_from_frame(&json!({ "command": command.clone() })), command);
    }
}
