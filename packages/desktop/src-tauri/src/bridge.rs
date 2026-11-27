//! headless 本地桥：把桌面端 Tauri 命令面暴露成 `127.0.0.1` 上的 HTTP/JSON。
//!
//! 桌面 EXE 用 Tauri IPC；浏览器里的客户端页面通过 Vite 代理 `/local-agent`
//! 打到这个桥，从而拿到同一套「本地文件系统」能力：关联项目、工作树状态、任务所有权、
//! 实时同步控制面、外观偏好。
//!
//! 安全边界：
//! - 只绑 `127.0.0.1`，不对外暴露；
//! - 每个请求都要 `Authorization: Bearer <token>`（token 由启动参数注入，dev 脚本生成）；
//! - `Origin` 命中白名单才放行，避免任意网页借浏览器调用本机能力。
//!
//! 事件：`GET /invoke/events`（SSE）推送桌面端同名事件，页面里的 `listen()` 走它。
//!
//! 这里的命令实现与 `agent_service.rs` 一一对应，只是把 `AppHandle` 换成本进程的
//! `ConfigStore` / `ControlHub` / `AgentRuntime`，不复制业务逻辑（都落在 `agent/` 里）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

use crate::agent::association::{
    associate_desktop_project, preflight_desktop_project, AssociateParams,
};
use crate::agent::branch_inspect;
use crate::agent::company_spec;
use crate::agent::company_spec::lifecycle::{self, CompanySpecError};
use crate::agent::company_spec::CompanySpecRequest;
use crate::agent::control::ControlHub;
use crate::agent::credential::CredentialStore;
use crate::agent::detach;
use crate::agent::device;
use crate::agent::env;
use crate::agent::http::ApiClient;
use crate::agent::onboarding;
use crate::agent::onboarding::InitializeOptions;
use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::runtime::AgentRuntime;
use crate::agent::state_events::StateSink;
use crate::agent::store::{AgentConfig, ConfigStore};
use crate::agent::task_control::parse_state_file;
use crate::agent::task_sync::{ControlSink, TaskSync};
use crate::agent::trellis_cli::TrellisRuntime;
use crate::config;

const MAX_BODY: usize = 8 * 1024 * 1024;

/// 桥自身状态：与桌面端 `AgentService` 同构，但只依赖 `agent/` 模块。
pub struct Bridge {
    store: Arc<ConfigStore>,
    hub: Arc<ControlHub>,
    paused: Arc<AtomicBool>,
    runtime: Mutex<Option<Arc<AgentRuntime>>>,
    pending: Mutex<Option<PathBuf>>,
    events: broadcast::Sender<(String, Value)>,
    token: String,
    origins: Vec<String>,
}

impl Bridge {
    pub fn new(
        store: Arc<ConfigStore>,
        hub: Arc<ControlHub>,
        paused: Arc<AtomicBool>,
        token: String,
        origins: Vec<String>,
    ) -> Arc<Self> {
        let (events, _) = broadcast::channel(256);
        Arc::new(Self {
            store,
            hub,
            paused,
            runtime: Mutex::new(None),
            pending: Mutex::new(None),
            events,
            token,
            origins,
        })
    }

    pub fn set_runtime(&self, runtime: Arc<AgentRuntime>) {
        if let Ok(mut guard) = self.runtime.lock() {
            *guard = Some(runtime);
        }
    }

    fn running(&self) -> Option<Arc<AgentRuntime>> {
        self.runtime.lock().ok().and_then(|guard| guard.clone())
    }

    fn publish(&self, event: &str, payload: Value) {
        let _ = self.events.send((event.to_string(), payload));
    }

    fn notify_state(&self, topics: Vec<&'static str>) {
        self.publish("desktop-state-changed", json!({ "topics": topics }));
    }

    pub fn control_sink(self: &Arc<Self>) -> ControlSink {
        let bridge = self.clone();
        Arc::new(move |control: Value| {
            bridge.hub.push_with_change(control);
            bridge.publish("live-control-changed", json!({}));
            bridge.notify_state(vec!["associations", "sidecar"]);
        })
    }

    pub fn state_sink(self: &Arc<Self>) -> StateSink {
        let bridge = self.clone();
        Arc::new(move || {
            bridge.publish("desktop-state-changed", json!({ "topics": ["sidecar"] }));
        })
    }

    async fn context(&self) -> AgentResult<(AgentConfig, Arc<ApiClient>)> {
        let config = self
            .store
            .read_config(false)
            .await?
            .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "尚未登录桌面设备"))?;
        let credential = CredentialStore::new(&self.store).load_credential().await?;
        let ca_file = config.ca_file.clone().map(PathBuf::from);
        let api = ApiClient::new(&config.server_url, Some(credential), ca_file.as_deref())?;
        Ok((config, Arc::new(api)))
    }

    async fn task_sync(&self) -> AgentResult<Arc<TaskSync>> {
        if let Some(runtime) = self.running() {
            return Ok(runtime.task_sync_arc());
        }
        let (config, api) = self.context().await?;
        let task_sync = TaskSync::new(self.store.clone(), api, Arc::new(|_control: Value| {}));
        task_sync.set_bindings(config.bindings).await;
        Ok(Arc::new(task_sync))
    }

    fn pending_path(&self) -> Result<PathBuf, String> {
        self.pending
            .lock()
            .map_err(|_| "无法读取待接入项目路径".to_string())?
            .clone()
            .ok_or_else(|| "请先选择一个本地项目目录".to_string())
    }

    fn set_pending(&self, path: Option<PathBuf>) -> Result<(), String> {
        let mut guard = self
            .pending
            .lock()
            .map_err(|_| "无法记录待接入项目路径".to_string())?;
        *guard = path;
        Ok(())
    }

    async fn allow_file_remote(&self) -> bool {
        self.store
            .read_config(true)
            .await
            .ok()
            .flatten()
            .map(|config| config.allow_local_git_remotes)
            .unwrap_or(false)
    }

    fn ephemeral_hooks(&self) -> Result<PathBuf, String> {
        let dir = self
            .store
            .paths
            .hooks_base_dir
            .join(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("无法创建临时 hooks 目录：{error}"))?;
        Ok(dir)
    }

    async fn pending_handoff_notices(
        &self,
    ) -> AgentResult<Vec<crate::agent::task_control::HandoffNotice>> {
        let raw = match tokio::fs::read_to_string(&self.store.paths.task_control_file).await {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return protocol::err(
                    code::CONFIG_INVALID,
                    format!("读取 handoff 状态失败: {error}"),
                )
            }
        };
        Ok(parse_state_file(&raw).pending_handoff_notices())
    }

    // -----------------------------------------------------------------------
    // 命令分发：名字与 `main.rs` 的 `#[tauri::command]` 保持一致
    // -----------------------------------------------------------------------

    pub async fn dispatch(&self, command: &str, args: Value) -> Result<Value, String> {
        let arg = |key: &str| -> Option<Value> { args.get(key).cloned() };
        let text = |key: &str| -> String {
            args.get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match command {
            "app_status" => self.app_status().await,
            "client_identity" => Ok(json!({
                "name": "Trellis Board",
                "version": env!("CARGO_PKG_VERSION"),
            })),
            "desktop_sidecar_status" => Ok(json!({
                "running": self.is_running(),
                "paused": self.paused.load(Ordering::SeqCst),
            })),
            "appearance_load" => Ok(
                serde_json::to_value(appearance_load(&self.store.paths.root))
                    .unwrap_or(Value::Null),
            ),
            "appearance_save" => {
                let theme = text("theme");
                let font_size = args
                    .get("fontSize")
                    .and_then(Value::as_str)
                    .unwrap_or("md")
                    .to_string();
                let notify_mode = args
                    .get("notifyMode")
                    .and_then(Value::as_str)
                    .unwrap_or("always")
                    .to_string();
                appearance_save(&self.store.paths.root, &theme, &font_size, &notify_mode)?;
                Ok(
                    serde_json::to_value(appearance_load(&self.store.paths.root))
                        .unwrap_or(Value::Null),
                )
            }

            // ---- 关联项目 ---------------------------------------------------
            "list_local_associations" => {
                let runtime = self.running();
                let task_sync = runtime.as_ref().map(|runtime| runtime.task_sync_arc());
                let associations =
                    device::read_local_associations(&self.store, task_sync.as_deref())
                        .await
                        .map_err(message)?;
                serde_json::to_value(associations).map_err(|error| error.to_string())
            }
            "pick_local_project_folder" => {
                // 浏览器没有原生目录选择框：允许前端把路径直接带过来（dev 专用），
                // 没带就返回 null，由页面提示用户手工输入。
                let _ = self.set_pending(None);
                match text("path").trim() {
                    "" => Ok(Value::Null),
                    path => {
                        let path = PathBuf::from(path);
                        if !path.is_dir() {
                            return Err("所选路径不是目录，请重新选择项目根目录".to_string());
                        }
                        Ok(Value::String(path.to_string_lossy().into_owned()))
                    }
                }
            }
            "inspect_local_project" => {
                let path = PathBuf::from(text("path").trim().to_string());
                if !path.is_dir() {
                    return Err("所选路径不是目录，请重新选择项目根目录".to_string());
                }
                let _ = self.set_pending(None);
                let hooks = self.ephemeral_hooks()?;
                let allow_file_remote = self.allow_file_remote().await;
                let inspected = onboarding::inspect_project(&path, &hooks, allow_file_remote).await;
                let _ = std::fs::remove_dir_all(&hooks);
                let inspected = inspected.map_err(message)?;
                self.set_pending(Some(path.clone()))?;
                let company_spec = company_spec::availability(kit_root().as_deref(), &path);
                Ok(json!({
                    "ok": true,
                    "project": inspected,
                    "companySpec": company_spec,
                }))
            }
            "preflight_pending_project" => {
                let path = self.pending_path()?;
                let (_, api) = self.context().await.map_err(message)?;
                let mut payload = preflight_desktop_project(
                    &self.store,
                    &api,
                    &path.to_string_lossy(),
                    &text("teamId"),
                    &text("developerId"),
                    args.get("requirePushed")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await
                .map_err(message)?;
                if let Some(object) = payload.as_object_mut() {
                    object.insert("ok".to_string(), Value::Bool(true));
                }
                Ok(payload)
            }
            "associate_pending_project" => {
                let path = self.pending_path()?;
                let inspected = self.inspect_project(&path).await?;
                let branch_name = inspected
                    .pointer("/project/branchName")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "无法确认本地项目分支".to_string())?
                    .to_string();
                let (_, api) = self.context().await.map_err(message)?;
                let summary = associate_desktop_project(
                    &self.store,
                    &api,
                    AssociateParams {
                        repo_path: path.to_string_lossy().into_owned(),
                        branch_name,
                        team_id: text("teamId"),
                        developer_id: text("developerId"),
                        display_name: None,
                        require_pushed: args
                            .get("requirePushed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        initial_sync_mode: args
                            .get("initialMode")
                            .and_then(Value::as_str)
                            .unwrap_or("safe")
                            .to_string(),
                    },
                )
                .await
                .map_err(message)?;
                let _ = self.set_pending(None);
                self.notify_state(vec!["associations", "sidecar"]);
                self.push_repositories().await;
                serde_json::to_value(summary).map_err(|error| error.to_string())
            }
            "cancel_pending_project" => {
                let _ = self.set_pending(None);
                Ok(Value::Null)
            }

            // ---- 工作树 -----------------------------------------------------
            "list_worktree_status" => {
                let runtime = self.running();
                let list = runtime
                    .map(|runtime| runtime.worktree().list())
                    .unwrap_or_default();
                serde_json::to_value(list).map_err(|error| error.to_string())
            }
            "refresh_worktree_discovery" => {
                let runtime = self.running().ok_or_else(|| "Agent 尚未运行".to_string())?;
                let list = runtime.worktree().refresh().await.map_err(message)?;
                serde_json::to_value(list).map_err(|error| error.to_string())
            }
            "retry_worktree_auto_attach" => {
                let runtime = self.running().ok_or_else(|| "Agent 尚未运行".to_string())?;
                let list = runtime
                    .worktree()
                    .retry(&text("key"))
                    .await
                    .map_err(message)?;
                serde_json::to_value(list).map_err(|error| error.to_string())
            }
            "detach_local_association" => {
                let task_space_id = text("taskSpaceId");
                let outcome = if let Some(runtime) = self.running() {
                    runtime
                        .detach_local_association(&task_space_id)
                        .await
                        .map_err(message)?
                } else {
                    let (config, api) = self.context().await.map_err(message)?;
                    let task_sync = Arc::new({
                        let sync = TaskSync::new(
                            self.store.clone(),
                            api.clone(),
                            Arc::new(|_control: Value| {}),
                        );
                        sync.set_bindings(config.bindings).await;
                        sync
                    });
                    detach::detach_local_association(
                        &self.store,
                        &api,
                        &task_sync,
                        &task_space_id,
                        false,
                    )
                    .await
                    .map_err(message)?
                };
                self.notify_state(vec!["associations", "sidecar"]);
                self.push_repositories().await;
                serde_json::to_value(outcome).map_err(|error| error.to_string())
            }

            // ---- 任务同步 / 控制面 ------------------------------------------
            "sync_deferred_tasks" => {
                let task_space_id = text("taskSpaceId");
                let task_sync = self.task_sync().await.map_err(message)?;
                let value = task_sync
                    .sync_deferred_tasks(&task_space_id)
                    .await
                    .map_err(message)?;
                self.notify_state(vec!["associations", "sidecar"]);
                Ok(value)
            }
            "list_task_ownership" => {
                let task_space_id = text("taskSpaceId");
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .list_task_ownership(&task_space_id)
                    .await
                    .map_err(message)
            }
            "set_task_ownership" => {
                let task_space_id = text("taskSpaceId");
                let decisions = arg("decisions").unwrap_or(Value::Null);
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .set_task_ownership(&task_space_id, decisions)
                    .await
                    .map_err(message)
            }
            "live_task_download" => {
                let task_space_id = text("taskSpaceId");
                let task_id = text("taskId");
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .download_task(&task_space_id, &task_id)
                    .await
                    .map_err(message)
            }
            "live_local_task_state" => {
                let task_space_id = text("taskSpaceId");
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .local_task_state(&task_space_id)
                    .await
                    .map_err(message)
            }
            "live_conflicts_show" => {
                let task_space_id = arg("taskSpaceId").and_then(|value| match value {
                    Value::String(text) if !text.trim().is_empty() => Some(text),
                    _ => None,
                });
                let space_ids = match task_space_id {
                    Some(id) => vec![id],
                    None => {
                        let (config, _) = self.context().await.map_err(message)?;
                        let mut ids: Vec<String> = Vec::new();
                        for binding in &config.bindings {
                            if !ids.contains(&binding.task_space_id) {
                                ids.push(binding.task_space_id.clone());
                            }
                        }
                        ids
                    }
                };
                let mut shown = false;
                for space_id in space_ids {
                    let task_sync = self.task_sync().await.map_err(message)?;
                    if let Some(event) = task_sync
                        .reopen_conflicts(&space_id)
                        .await
                        .map_err(message)?
                    {
                        self.hub.push_with_change(event);
                        self.publish("live-control-changed", json!({}));
                        shown = true;
                    }
                }
                Ok(Value::Bool(shown))
            }
            "live_control_pending" => Ok(self.hub.pending().unwrap_or(Value::Null)),
            "live_control_show" => {
                self.hub.reveal_dismissed();
                if self.hub.pending().is_none() {
                    return Ok(Value::Bool(false));
                }
                self.publish("live-control-changed", json!({}));
                Ok(Value::Bool(true))
            }
            "live_control_dismiss" => {
                if self.hub.pending().is_none() {
                    return Err("当前没有待处理事件".to_string());
                }
                self.hub.dismiss_with_change().map_err(message)?;
                self.publish("live-control-changed", json!({}));
                Ok(Value::Null)
            }
            "live_control_diff" => {
                let task_space_id = text("taskSpaceId");
                let conflict_id = text("conflictId");
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .conflict_details(&task_space_id, &conflict_id)
                    .await
                    .map_err(message)
            }
            "live_control_decide" => {
                let task_space_id = text("taskSpaceId");
                let conflict_id = text("conflictId");
                let action = text("action");
                let task_sync = self.task_sync().await.map_err(message)?;
                task_sync
                    .decide_conflict(&task_space_id, &conflict_id, &action, None)
                    .await
                    .map_err(message)?;
                self.publish("live-control-changed", json!({}));
                Ok(Value::Null)
            }
            "live_control_initial" => {
                let task_space_id = text("taskSpaceId");
                let mode = args
                    .get("mode")
                    .and_then(Value::as_str)
                    .unwrap_or("safe")
                    .to_string();
                let decisions: Vec<Value> = match arg("decisions") {
                    Some(Value::Array(items)) => items,
                    _ => Vec::new(),
                };
                let task_sync = self.task_sync().await.map_err(message)?;
                let value = task_sync
                    .resolve_initial_sync(&task_space_id, &mode, &decisions)
                    .await
                    .map_err(message)?;
                self.notify_state(vec!["associations", "sidecar"]);
                Ok(value)
            }
            "handoff_notice_pending" => {
                let notices = self.pending_handoff_notices().await.map_err(message)?;
                serde_json::to_value(notices).map_err(|error| error.to_string())
            }

            // ---- 登录 / 环境 ------------------------------------------------
            "desktop_login_preflight" => {
                let server_url = text("serverUrl");
                let previous = config::load()
                    .ok()
                    .flatten()
                    .map(|config| config.server_url);
                let requires_reset = previous
                    .as_deref()
                    .map(|value| !value.trim().is_empty() && value != server_url)
                    .unwrap_or(false);
                Ok(json!({
                    "requiresReset": requires_reset,
                    "previousServerUrl": previous,
                    "backupRoot": config::data_dir().join("client-backups").to_string_lossy(),
                }))
            }
            "desktop_login" => {
                self.desktop_login(&text("serverUrl"), &text("username"), &text("password"))
                    .await
            }
            "desktop_logout" => {
                if let Some(runtime) = self.running() {
                    runtime.stop("用户在页面上退出登录");
                }
                let _ = tokio::fs::remove_file(&self.store.paths.config_file).await;
                let _ = tokio::fs::remove_file(&self.store.paths.credential_file).await;
                self.notify_state(vec!["associations", "sidecar"]);
                Ok(Value::Null)
            }

            // ---- 首次接入：初始化 / 推送 -------------------------------------
            "initialize_pending_project" => {
                let path = self.pending_path()?;
                let tools = string_list(args.get("agentTools").cloned());
                let selection = args
                    .get("companySpecSelection")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.initialize_repo(&path, &text("developerId"), &tools, selection.as_deref())
                    .await
            }
            "check_pending_project_push" => {
                let path = self.pending_path()?;
                self.check_initial_push(&path, &text("branchName")).await
            }
            "commit_and_push_pending_project" => {
                let path = self.pending_path()?;
                self.commit_and_push_initial(&path).await
            }

            // ---- 已关联项目的规范 / Agent ------------------------------------
            "inspect_company_spec" => {
                let path = self.approved_repo_path(&text("repoPath")).await?;
                let kit_root = kit_root().ok_or_else(|| "找不到 trellis-kit".to_string())?;
                let status = lifecycle::status(Some(&kit_root), &path);
                Ok(json!({ "ok": true, "status": status }))
            }
            "plan_company_spec" => {
                let path = self.approved_repo_path(&text("repoPath")).await?;
                let runtime = trellis_runtime()?;
                let kit_root = kit_root().ok_or_else(|| "找不到 trellis-kit".to_string())?;
                let feature = company_spec::load_feature(Some(&kit_root))
                    .ok_or_else(|| "当前客户端未启用公司规范能力".to_string())?;
                let selection = args.get("selection").and_then(Value::as_str);
                let plan = lifecycle::plan(
                    &runtime,
                    &kit_root,
                    &path,
                    &feature,
                    selection,
                    "keep-local",
                )
                .await
                .map_err(lifecycle_error)?;
                Ok(json!({ "ok": true, "plan": plan }))
            }
            "apply_company_spec" => {
                let path = self.approved_repo_path(&text("repoPath")).await?;
                let runtime = trellis_runtime()?;
                let kit_root = kit_root().ok_or_else(|| "找不到 trellis-kit".to_string())?;
                let feature = company_spec::load_feature(Some(&kit_root))
                    .ok_or_else(|| "当前客户端未启用公司规范能力".to_string())?;
                let selection = args.get("selection").and_then(Value::as_str);
                let strategy = args
                    .get("strategy")
                    .and_then(Value::as_str)
                    .unwrap_or("keep-local");
                let result =
                    lifecycle::apply(&runtime, &kit_root, &path, &feature, selection, strategy)
                        .await
                        .map_err(lifecycle_error)?;
                Ok(json!({ "ok": true, "result": result }))
            }
            "inspect_associated_project_agents" => {
                let path = self.associated_repo_path(&text("taskSpaceId")).await?;
                self.inspect_project(&path).await
            }
            "inspect_associated_project_branches" => {
                let path = self.associated_repo_path(&text("taskSpaceId")).await?;
                let hooks = self.ephemeral_hooks()?;
                let result = branch_inspect::inspect_associated_project_branches(
                    &path.to_string_lossy(),
                    &hooks,
                )
                .await;
                let _ = std::fs::remove_dir_all(&hooks);
                result
            }
            "initialize_associated_project_agents" => {
                let path = self.associated_repo_path(&text("taskSpaceId")).await?;
                let tools = string_list(args.get("agentTools").cloned());
                self.initialize_repo(&path, &text("developerId"), &tools, None)
                    .await
            }

            // ---- 桌面壳独有能力：headless 明确不出报表成功 --------------------
            "take_pending_share_link" => Ok(Value::Null),
            "runtime_status" | "runtime_set_node_path" | "runtime_install" => Err(
                "headless 模式不管理 Node.js 运行时：请用 TRELLIS_NODE_EXE/TRELLIS_CLI_PATH 指定"
                    .to_string(),
            ),
            "update_status" | "update_check" | "update_apply" => {
                Err("headless 模式不提供自动更新".to_string())
            }
            other => Err(format!(
                "headless 桥尚未实现命令 {other}（桌面端 Tauri 独有能力）"
            )),
        }
    }

    async fn desktop_login(
        &self,
        server_url: &str,
        username: &str,
        password: &str,
    ) -> Result<Value, String> {
        let api = ApiClient::new(server_url, None, None).map_err(|error| message(error))?;
        let summary = device::login_desktop(
            &self.store,
            &api,
            username,
            password,
            &default_device_name(),
            false,
        )
        .await
        .map_err(message)?;
        self.notify_state(vec!["associations", "sidecar"]);
        serde_json::to_value(summary).map_err(|error| error.to_string())
    }

    async fn inspect_project(&self, path: &Path) -> Result<Value, String> {
        let hooks = self.ephemeral_hooks()?;
        let allow_file_remote = self.allow_file_remote().await;
        let inspected = onboarding::inspect_project(path, &hooks, allow_file_remote).await;
        let _ = std::fs::remove_dir_all(&hooks);
        let inspected = inspected.map_err(message)?;
        let company_spec = company_spec::availability(kit_root().as_deref(), path);
        Ok(json!({
            "ok": true,
            "project": inspected,
            "companySpec": company_spec,
        }))
    }

    async fn initialize_repo(
        &self,
        path: &Path,
        developer_id: &str,
        agent_tools: &[String],
        company_spec_selection: Option<&str>,
    ) -> Result<Value, String> {
        let runtime = trellis_runtime()?;
        let allow_file_remote = self.allow_file_remote().await;
        let hooks = self.ephemeral_hooks()?;
        let kit = kit_root();
        let company_spec = kit.as_deref().and_then(|kit_root| {
            let feature = company_spec::load_feature(Some(kit_root))?;
            let (choice, warning) =
                company_spec::parse_choice(company_spec_selection, feature.enabled_by_default);
            Some(CompanySpecRequest {
                config: company_spec::config(&feature),
                choice,
                warning,
            })
        });
        let result = onboarding::initialize_project(&InitializeOptions {
            repo_path: path,
            hooks_dir: &hooks,
            developer_id,
            agent_tools,
            runtime: &runtime,
            allow_file_remote,
            kit_root: kit.as_deref(),
            company_spec,
        })
        .await;
        let _ = std::fs::remove_dir_all(&hooks);
        let result = result.map_err(message)?;
        Ok(json!({
            "ok": true,
            "project": result.project,
            "companySpec": result.company_spec,
        }))
    }

    async fn check_initial_push(&self, path: &Path, branch_name: &str) -> Result<Value, String> {
        let allow_file_remote = self.allow_file_remote().await;
        let hooks = self.ephemeral_hooks()?;
        let result =
            onboarding::check_initial_push_with(path, &hooks, branch_name, allow_file_remote).await;
        let _ = std::fs::remove_dir_all(&hooks);
        let state = result.map_err(message)?;
        let mut payload = serde_json::to_value(state)
            .map_err(|error| format!("无法序列化推送检查结果：{error}"))?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("ok".to_string(), Value::Bool(true));
        }
        Ok(payload)
    }

    async fn commit_and_push_initial(&self, path: &Path) -> Result<Value, String> {
        let allow_file_remote = self.allow_file_remote().await;
        let hooks = self.ephemeral_hooks()?;
        let result = onboarding::commit_and_push_initial(path, &hooks, allow_file_remote).await;
        let _ = std::fs::remove_dir_all(&hooks);
        let state = result.map_err(message)?;
        let mut payload = serde_json::to_value(state)
            .map_err(|error| format!("无法序列化提交推送结果：{error}"))?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("ok".to_string(), Value::Bool(true));
        }
        Ok(payload)
    }

    async fn associations(&self) -> Result<Vec<device::LocalAssociation>, String> {
        let runtime = self.running();
        let task_sync = runtime.as_ref().map(|runtime| runtime.task_sync_arc());
        device::read_local_associations(&self.store, task_sync.as_deref())
            .await
            .map_err(message)
    }

    /// 把本地关联推给插件宿主，插件面板的「项目」下拉才和桌面端一致。
    /// 宿主没起或未配置 token 时静默跳过（dev 环境下常见）。
    pub async fn push_repositories(&self) {
        let base = std::env::var("TRELLIS_PLUGIN_HOST")
            .unwrap_or_else(|_| "http://127.0.0.1:4517".to_string());
        let token = std::env::var("TRELLIS_PLUGIN_HOST_TOKEN")
            .unwrap_or_else(|_| "dev-local-plugin-token".to_string());
        let Ok(associations) = self.associations().await else {
            return;
        };
        let repositories: Vec<Value> = associations
            .iter()
            .filter(|association| {
                association.status == "approved"
                    && !association.read_only
                    && !association.detach_pending
            })
            .map(|association| {
                json!({
                    "id": association.project_id,
                    "name": association.display_name,
                    "path": association.repo_path,
                    "branch": association.branch_name,
                })
            })
            .collect();
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };
        let response = client
            .post(format!("{base}/internal/repositories"))
            .bearer_auth(token)
            .json(&json!({ "repositories": repositories }))
            .send()
            .await;
        if let Err(error) = response {
            crate::logging::warn(&format!("推送本地关联到插件宿主失败: {error}"));
        }
    }

    async fn approved_repo_path(&self, repo_path: &str) -> Result<PathBuf, String> {
        let path =
            std::fs::canonicalize(repo_path).map_err(|_| "项目目录不存在或不可访问".to_string())?;
        if !path.is_dir() {
            return Err("项目路径不是目录".to_string());
        }
        let associations = self.associations().await?;
        let approved = associations.iter().any(|association| {
            association.status == "approved"
                && std::fs::canonicalize(&association.repo_path)
                    .map(|candidate| candidate == path)
                    .unwrap_or(false)
        });
        if approved {
            Ok(path)
        } else {
            Err("该路径未关联当前 Board".to_string())
        }
    }

    async fn associated_repo_path(&self, task_space_id: &str) -> Result<PathBuf, String> {
        let associations = self.associations().await?;
        let matched = associations.iter().find(|association| {
            association.task_space_id == task_space_id && association.status == "approved"
        });
        matched
            .map(|association| PathBuf::from(&association.repo_path))
            .ok_or_else(|| "该分支没有已关联的本地仓库".to_string())
    }

    fn is_running(&self) -> bool {
        match self.runtime.lock() {
            Ok(guard) => guard
                .as_ref()
                .map(|runtime| !runtime.is_stopped())
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    async fn app_status(&self) -> Result<Value, String> {
        let config = self.store.read_config(true).await.ok().flatten();
        Ok(json!({
            "appName": "Trellis Board",
            "version": env!("CARGO_PKG_VERSION"),
            "serverUrl": config.as_ref().map(|config| config.server_url.clone()),
            "username": config.as_ref().map(|config| config.username.clone()),
            "password": Value::Null,
            "configPath": self.store.paths.config_file.to_string_lossy(),
            "logsDir": self.store.paths.logs_dir.to_string_lossy(),
            "sidecarRunning": self.is_running(),
        }))
    }
}

// ---------------------------------------------------------------------------
// 外观偏好：与 `appearance.rs` 相同的文件与校验规则
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Appearance {
    theme: String,
    font_size: String,
    #[serde(default)]
    notify_mode: String,
}

/// 外观偏好落在 Agent 数据目录内，避免 headless 进程往桌面端目录写文件。
fn appearance_path(root: &Path) -> PathBuf {
    root.join("appearance.json")
}

fn appearance_load(root: &Path) -> Appearance {
    let fallback = || Appearance {
        theme: "system".to_string(),
        font_size: "md".to_string(),
        notify_mode: "always".to_string(),
    };
    let Ok(raw) = std::fs::read_to_string(appearance_path(root)) else {
        return fallback();
    };
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
    let mut value = serde_json::from_str::<Appearance>(raw).unwrap_or_else(|_| fallback());
    if !matches!(value.theme.as_str(), "light" | "dark" | "system") {
        value.theme = "system".to_string();
    }
    if !matches!(value.font_size.as_str(), "sm" | "md" | "lg" | "xl") {
        value.font_size = "md".to_string();
    }
    if !matches!(value.notify_mode.as_str(), "never" | "unfocused" | "always") {
        value.notify_mode = "always".to_string();
    }
    value
}

fn appearance_save(
    root: &Path,
    theme: &str,
    font_size: &str,
    notify_mode: &str,
) -> Result<(), String> {
    let parent = appearance_path(root);
    let temp = parent.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(&json!({
        "theme": theme,
        "fontSize": font_size,
        "notifyMode": notify_mode,
    }))
    .map_err(|error| format!("无法序列化外观偏好: {error}"))?;
    std::fs::write(&temp, payload).map_err(|error| format!("无法写入外观偏好: {error}"))?;
    std::fs::rename(&temp, &parent).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换外观偏好 {}: {error}", parent.display())
    })
}

fn string_list(value: Option<Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn default_device_name() -> String {
    if let Ok(name) = std::env::var("HOSTNAME") {
        if !name.trim().is_empty() {
            return name;
        }
    }
    if let Ok(name) = std::fs::read_to_string("/etc/hostname") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    "trellis-agent".to_string()
}

/// headless 没有 Tauri 资源目录：优先环境变量，其次仓库内的 trellis-kit。
fn kit_root() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("TRELLIS_KIT_ROOT") {
        let path = PathBuf::from(value);
        if path.is_dir() {
            return Some(path);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../trellis-kit");
    dev.is_dir().then_some(dev)
}

fn trellis_runtime() -> Result<TrellisRuntime, String> {
    if let Ok(Some(config)) = config::load() {
        if let (Some(node), Some(trellis)) = (config.node_runtime, config.trellis_runtime) {
            let node = serde_json::from_value::<env::NodeRuntimeFlag>(node);
            let trellis = serde_json::from_value::<env::TrellisRuntimeFlag>(trellis);
            if let (Ok(node), Ok(trellis)) = (node, trellis) {
                return Ok(TrellisRuntime {
                    node_exe: PathBuf::from(node.path),
                    cli_path: PathBuf::from(trellis.cli_path),
                });
            }
        }
    }
    match (
        std::env::var("TRELLIS_NODE_EXE"),
        std::env::var("TRELLIS_CLI_PATH"),
    ) {
        (Ok(node), Ok(cli)) if !node.trim().is_empty() && !cli.trim().is_empty() => {
            Ok(TrellisRuntime {
                node_exe: PathBuf::from(node),
                cli_path: PathBuf::from(cli),
            })
        }
        _ => Err(
            "Node.js / Trellis CLI 未就绪：请设置 TRELLIS_NODE_EXE 与 TRELLIS_CLI_PATH，或在桌面客户端完成环境检查"
                .to_string(),
        ),
    }
}

fn lifecycle_error(error: CompanySpecError) -> String {
    serde_json::to_string(&error).unwrap_or(error.message)
}

fn message(error: AgentError) -> String {
    format!("[{}] {}", error.code, error.message)
}

// ---------------------------------------------------------------------------
// HTTP / SSE
// ---------------------------------------------------------------------------

pub async fn listen(bridge: Arc<Bridge>, port: u16) -> AgentResult<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("无法监听 127.0.0.1:{port}: {error}"),
            )
        })?;
    crate::logging::warn(&format!("本地桥已监听 http://127.0.0.1:{port}"));
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(error) => {
                crate::logging::warn(&format!("本地桥 accept 失败: {error}"));
                continue;
            }
        };
        let bridge = bridge.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_connection(bridge, stream).await {
                crate::logging::warn(&format!("本地桥请求失败: {error}"));
            }
        });
    }
}

struct Request {
    method: String,
    path: String,
    query: String,
    token: Option<String>,
    origin: Option<String>,
    body: Vec<u8>,
}

async fn handle_connection(bridge: Arc<Bridge>, stream: TcpStream) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    loop {
        let request = match read_request(&mut reader).await? {
            Some(request) => request,
            None => return Ok(()),
        };
        // 事件流是长连接，读完就转交出去，不再复用这个 socket。
        if request.path.starts_with("/invoke/events") {
            return stream_events(bridge, write_half, request).await;
        }
        let (status, payload) = route(&bridge, request).await;
        write_response(&mut write_half, status, &payload).await?;
    }
}

async fn read_request(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> std::io::Result<Option<Request>> {
    let mut line = String::new();
    let read = reader.read_line(&mut line).await?;
    if read == 0 {
        return Ok(None);
    }
    let mut parts = line.trim_end().split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or("/").to_string();
    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path.to_string(), query.to_string()),
        None => (target, String::new()),
    };
    let mut token = None;
    let mut origin = None;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "authorization" => {
                    token = Some(value.trim_start_matches("Bearer ").trim().to_string())
                }
                "origin" => origin = Some(value.to_string()),
                "content-length" => length = value.parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    if length > MAX_BODY {
        return Ok(Some(Request {
            method,
            path,
            query,
            token,
            origin,
            body: Vec::new(),
        }));
    }
    let mut body = vec![0u8; length];
    if length > 0 {
        reader.read_exact(&mut body).await?;
    }
    Ok(Some(Request {
        method,
        path,
        query,
        token,
        origin,
        body,
    }))
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| percent_decode(value))
    })
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 回环来源（`localhost` / `127.0.0.1` / `[::1]`，任意端口）默认放行；
/// 其它来源必须由启动参数显式列出。
fn origin_allowed(allowed: &[String], origin: &str) -> bool {
    if allowed.iter().any(|item| item == origin) {
        return true;
    }
    let rest = match origin.split_once("://") {
        Some((scheme, rest)) if scheme == "http" || scheme == "https" => rest,
        _ => return false,
    };
    let host = rest.rsplit_once(':').map(|(host, _)| host).unwrap_or(rest);
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

fn authorized(bridge: &Bridge, request: &Request) -> bool {
    if let Some(origin) = request.origin.as_deref() {
        if !origin_allowed(&bridge.origins, origin) {
            return false;
        }
    }
    let token = request
        .token
        .clone()
        .or_else(|| query_value(&request.query, "token"));
    match token {
        Some(token) => !bridge.token.is_empty() && token == bridge.token,
        None => false,
    }
}

async fn route(bridge: &Bridge, request: Request) -> (u16, Value) {
    if request.method == "OPTIONS" {
        return (204, Value::Null);
    }
    if !authorized(bridge, &request) {
        return (401, json!({ "error": "本地桥鉴权失败" }));
    }
    if request.path == "/health" {
        return (200, json!({ "ok": true }));
    }
    if request.path != "/invoke" {
        return (404, json!({ "error": "未知接口" }));
    }
    let payload: Value = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(error) => {
            return (
                400,
                json!({ "error": format!("请求体不是合法 JSON: {error}") }),
            )
        }
    };
    let command = payload
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if command.is_empty() {
        return (400, json!({ "error": "缺少 command" }));
    }
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    match bridge.dispatch(&command, args).await {
        Ok(value) => (200, value),
        Err(error) => (400, json!({ "error": error })),
    }
}

async fn write_response(
    write: &mut tokio::net::tcp::OwnedWriteHalf,
    status: u16,
    payload: &Value,
) -> std::io::Result<()> {
    let body = if payload.is_null() {
        String::new()
    } else {
        serde_json::to_string(payload).unwrap_or_else(|_| "null".to_string())
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {length}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n\r\n",
        reason = reason(status),
        length = body.len(),
    );
    write.write_all(head.as_bytes()).await?;
    write.write_all(body.as_bytes()).await?;
    write.flush().await
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "OK",
    }
}

async fn stream_events(
    bridge: Arc<Bridge>,
    mut write: tokio::net::tcp::OwnedWriteHalf,
    request: Request,
) -> std::io::Result<()> {
    if !authorized(&bridge, &request) {
        return write_response(&mut write, 401, &json!({ "error": "本地桥鉴权失败" })).await;
    }
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    write.write_all(head.as_bytes()).await?;
    write
        .write_all(b"event: hello\ndata: {\"ok\":true}\n\n")
        .await?;
    write.flush().await?;
    let mut receiver = bridge.events.subscribe();
    loop {
        tokio::select! {
            received = receiver.recv() => {
                match received {
                    Ok((event, payload)) => {
                        let data = serde_json::to_string(&payload).unwrap_or_else(|_| "null".to_string());
                        let frame = format!("event: {event}\ndata: {data}\n\n");
                        if write.write_all(frame.as_bytes()).await.is_err() {
                            return Ok(());
                        }
                        if write.flush().await.is_err() {
                            return Ok(());
                        }
                    }
                    Err(_) => return Ok(()),
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(20)) => {
                // 心跳，避免代理按空闲超时掐掉长连接。
                if write.write_all(b": ping\n\n").await.is_err() {
                    return Ok(());
                }
                if write.flush().await.is_err() {
                    return Ok(());
                }
            }
        }
    }
}
