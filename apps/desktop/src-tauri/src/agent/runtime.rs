use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{watch, Notify};

use crate::agent::control::ControlHub;
use crate::agent::credential::CredentialStore;
use crate::agent::http::{ApiClient, SseFrame};
use crate::agent::protocol::{
    self, code, safe_error_message, AgentCommand, AgentError, AgentResult, AGENT_PROTOCOL_VERSION,
    AGENT_VERSION,
};
use crate::agent::store::{AgentBinding, ConfigStore};
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
    shutdown: watch::Sender<bool>,
    stopped: AtomicBool,
    agent_id: String,
}

impl AgentRuntime {
    pub async fn start(
        store: Arc<ConfigStore>,
        emit: ControlSink,
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
        let task_sync = Arc::new(TaskSync::new(store.clone(), api.clone(), emit.clone()));
        let (shutdown, _) = watch::channel(false);
        let runtime = Arc::new(Self {
            store,
            api,
            paused,
            task_sync,
            shutdown,
            stopped: AtomicBool::new(false),
            agent_id: config.agent_id.clone(),
        });
        runtime.write_state("running", None, None).await;
        runtime.apply_bindings(config.bindings.clone()).await;
        runtime.spawn_event_loop();
        runtime.spawn_heartbeat_loop(config.bindings.clone());
        hub.resume();
        Ok(runtime)
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.shutdown.send(true);
        self.write_state_blocking("stopped", None, None);
    }

    fn spawn_heartbeat_loop(self: &Arc<Self>, mut bindings: Vec<AgentBinding>) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut shutdown = runtime.shutdown.subscribe();
            let mut delay = RETRY_BASE;
            loop {
                tokio::select! {
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            break;
                        }
                    }
                    _ = tokio::time::sleep(HEARTBEAT_INTERVAL) => {}
                }
                if runtime.is_paused() {
                    continue;
                }
                match runtime.heartbeat(&bindings).await {
                    Ok(updated) => {
                        delay = RETRY_BASE;
                        if updated != bindings {
                            bindings = updated.clone();
                            runtime.apply_bindings(bindings.clone()).await;
                        }
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
                    }
                }
            }
        });
    }

    async fn heartbeat(&self, bindings: &[AgentBinding]) -> AgentResult<Vec<AgentBinding>> {
        let mut config =
            self.store.read_config(false).await?.ok_or_else(|| {
                AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录")
            })?;
        let public_bindings: Vec<Value> = bindings
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
        let body = json!({
            "agentId": config.agent_id,
            "deviceId": config.agent_id,
            "deviceName": config.device_name,
            "protocolVersion": AGENT_PROTOCOL_VERSION,
            "agentVersion": AGENT_VERSION,
            "bindings": public_bindings,
        });
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
        let mut merged = bindings.to_vec();
        for server_binding in heartbeat.bindings {
            let Some(local) = merged.iter_mut().find(|binding| {
                binding.task_space_id == server_binding.task_space_id
                    && binding.local_repo_key == server_binding.local_repo_key
            }) else {
                continue;
            };
            local.server_binding_id = Some(server_binding.id.clone());
            if let Some(team_id) = server_binding.team_id.clone() {
                local.team_id = Some(team_id);
            }
            local.read_only = server_binding.read_only;
            if !server_binding.status.is_empty() {
                local.sync_status = server_binding.status.clone();
            }
            // 分支守卫类错误由本机决定，心跳不能把它覆盖成服务端的通用错误。
            let guarded = local
                .last_error_code
                .as_deref()
                .is_some_and(crate::agent::task_sync::is_branch_guard_code);
            if !guarded {
                if server_binding.error_code.is_some() {
                    local.last_error_code = server_binding.error_code.clone();
                }
                if server_binding.error.is_some() {
                    local.last_error = server_binding.error.clone();
                }
            }
            if let Some(server_branch) = server_binding.branch_name.as_deref() {
                if !server_branch.is_empty() && local.branch_name != server_branch {
                    local.last_error_code = Some("BINDING_BRANCH_MISMATCH".to_string());
                    local.last_error = Some("本地分支与服务端绑定分支不一致".to_string());
                }
            }
        }
        if merged != bindings {
            config.bindings = merged.clone();
            self.store.save_config(config).await?;
        }
        Ok(merged)
    }

    async fn apply_bindings(&self, bindings: Vec<AgentBinding>) {
        self.task_sync.update_bindings(bindings).await;
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
                    self.task_sync.pull_and_report(task_space_id).await;
                }
                Ok(())
            }
            "command" => {
                let raw = data.get("command").cloned().unwrap_or(Value::Null);
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
