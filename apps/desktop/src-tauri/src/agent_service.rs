//! 进程内 Agent 服务：替代旧的 sidecar 子进程桥。
//!
//! `main.rs` 只与本模块交互；所有同步/控制事件都在客户端进程内完成。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::agent::association::{associate_desktop_project, AssociateParams};
use crate::agent::control::ControlHub;
use crate::agent::credential::CredentialStore;
use crate::agent::detach;
use crate::agent::device::{self, DesktopLoginSummary};
use crate::agent::env;
use crate::agent::http::ApiClient;
use crate::agent::onboarding;
use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::runtime::AgentRuntime;
use crate::agent::store::{AgentConfig, ConfigStore};
use crate::agent::task_sync::{ControlSink, TaskSync};
use crate::agent::trellis_cli::TrellisRuntime;

pub use crate::agent::device::LocalAssociation;

const CONTROL_WINDOW: &str = "live-control";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub running: bool,
    pub paused: bool,
}

#[derive(Clone)]
pub struct AgentService {
    app: AppHandle,
    store: Arc<ConfigStore>,
    hub: Arc<ControlHub>,
    paused: Arc<AtomicBool>,
    runtime: Arc<Mutex<Option<Arc<AgentRuntime>>>>,
    starting: Arc<AtomicBool>,
    focus_suppressed: Arc<AtomicBool>,
    auto_focus_consumed: Arc<AtomicBool>,
    sync_menu_item: Arc<Mutex<Option<MenuItem<Wry>>>>,
}

pub fn register(app: &AppHandle) {
    let store = ConfigStore::new(crate::config::agent_root());
    let hub = ControlHub::new();
    app.manage(AgentService {
        app: app.clone(),
        store: Arc::new(store),
        hub: Arc::new(hub),
        paused: Arc::new(AtomicBool::new(false)),
        runtime: Arc::new(Mutex::new(None)),
        starting: Arc::new(AtomicBool::new(false)),
        focus_suppressed: Arc::new(AtomicBool::new(false)),
        auto_focus_consumed: Arc::new(AtomicBool::new(false)),
        sync_menu_item: Arc::new(Mutex::new(None)),
    });
}

/// 托盘「同步」菜单项由 main.rs 创建后交给本模块维护文案与可用状态。
pub fn set_sync_menu_item(app: &AppHandle, item: MenuItem<Wry>) {
    let Ok(service) = service(app) else {
        return;
    };
    if let Ok(mut current) = service.sync_menu_item.lock() {
        *current = Some(item);
    }
    refresh_sync_menu(app);
}

fn sync_menu_label(running: bool) -> (&'static str, bool) {
    if running {
        ("暂停同步", true)
    } else {
        ("恢复同步", true)
    }
}

fn refresh_sync_menu(app: &AppHandle) {
    let Ok(service) = service(app) else {
        return;
    };
    let (label, enabled) = sync_menu_label(is_running(app));
    let current = service.sync_menu_item.lock();
    if let Ok(current) = current {
        if let Some(item) = current.as_ref() {
            if let Err(error) = item.set_text(label) {
                crate::logging::warn(&format!("无法更新同步菜单文案：{error}"));
            }
            if let Err(error) = item.set_enabled(enabled) {
                crate::logging::warn(&format!("无法更新同步菜单状态：{error}"));
            }
        }
    }
}

/// 对照 JS `handleSyncAction`：运行中则暂停，已停止则恢复。
pub fn sync_action(app: &AppHandle) {
    let Ok(service) = service(app) else {
        return;
    };
    if is_running(app) {
        stop(app);
        crate::logging::warn("已暂停后台同步");
    } else {
        service.paused.store(false, Ordering::SeqCst);
        service.hub.resume();
        start(app);
        crate::logging::warn("已恢复后台同步");
    }
    refresh_sync_menu(app);
}

fn service(app: &AppHandle) -> AgentResult<AgentService> {
    app.try_state::<AgentService>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 服务尚未初始化"))
}

fn message(error: &AgentError) -> String {
    let text = protocol::safe_error_message(&error.message);
    if text.trim().is_empty() {
        error.code.clone()
    } else {
        text
    }
}

pub fn is_running(app: &AppHandle) -> bool {
    let Some(service) = app
        .try_state::<AgentService>()
        .map(|state| state.inner().clone())
    else {
        return false;
    };
    service
        .runtime
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

pub fn status(app: &AppHandle) -> AgentStatus {
    let paused = app
        .try_state::<AgentService>()
        .map(|state| state.inner().paused.load(Ordering::SeqCst))
        .unwrap_or(false);
    AgentStatus {
        running: is_running(app),
        paused,
    }
}

pub fn start(app: &AppHandle) {
    let Ok(service) = service(app) else {
        return;
    };
    if service.paused.load(Ordering::SeqCst) {
        return;
    }
    if service
        .starting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(error) = service.start_runtime().await {
            crate::logging::warn(&format!("后台同步启动失败：{}", message(&error)));
        }
        service.starting.store(false, Ordering::SeqCst);
    });
    refresh_sync_menu(app);
}

pub fn restart(app: &AppHandle) {
    stop(app);
    start(app);
}

pub fn stop(app: &AppHandle) {
    let Some(service) = app
        .try_state::<AgentService>()
        .map(|state| state.inner().clone())
    else {
        return;
    };
    service.stop_runtime();
    refresh_sync_menu(app);
}

pub fn toggle_pause(app: &AppHandle) {
    let Ok(service) = service(app) else {
        return;
    };
    let paused = !service.paused.load(Ordering::SeqCst);
    service.paused.store(paused, Ordering::SeqCst);
    if paused {
        service.stop_runtime();
        refresh_sync_menu(app);
        return;
    }
    service.hub.resume();
    start(app);
}

pub fn shutdown(app: &AppHandle) {
    stop(app);
}

impl AgentService {
    fn sink(&self) -> ControlSink {
        let service = self.clone();
        Arc::new(move |control: Value| service.publish_control(control))
    }

    async fn start_runtime(&self) -> AgentResult<()> {
        if self
            .runtime
            .lock()
            .map(|guard| guard.is_some())
            .unwrap_or(true)
        {
            return Ok(());
        }
        let Some(config) = self.store.read_config(true).await? else {
            return Ok(());
        };
        if config.agent_id.trim().is_empty() {
            return Ok(());
        }
        let runtime = AgentRuntime::start(
            self.store.clone(),
            self.sink(),
            self.paused.clone(),
            &self.hub,
        )
        .await?;
        if let Ok(mut guard) = self.runtime.lock() {
            *guard = Some(runtime);
        }
        Ok(())
    }

    fn stop_runtime(&self) {
        let taken = self.runtime.lock().ok().and_then(|mut guard| guard.take());
        if let Some(runtime) = taken {
            runtime.stop();
        }
    }

    fn publish_control(&self, control: Value) {
        if !self.hub.push(control) {
            return;
        }
        let first = !self.focus_suppressed.load(Ordering::SeqCst)
            && !self.auto_focus_consumed.swap(true, Ordering::SeqCst);
        if first {
            self.show_control();
        }
    }

    fn show_control(&self) {
        if let Some(window) = self.app.get_webview_window(CONTROL_WINDOW) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            return;
        }
        let built = WebviewWindowBuilder::new(
            &self.app,
            CONTROL_WINDOW,
            WebviewUrl::App(PathBuf::from("control.html")),
        )
        .title("Trellis Board 实时同步确认")
        .inner_size(560.0, 420.0)
        .min_inner_size(480.0, 360.0)
        .build();
        if let Ok(window) = built {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    fn hide_control(&self) {
        if let Some(window) = self.app.get_webview_window(CONTROL_WINDOW) {
            let _ = window.hide();
        }
    }

    fn pending_control(&self) -> Option<Value> {
        let next = self.hub.pending();
        if next.is_none() {
            self.hide_control();
        }
        next
    }

    fn suppress_and_hide(&self) {
        self.focus_suppressed.store(true, Ordering::SeqCst);
        self.hide_control();
    }

    async fn agent_context(&self) -> AgentResult<(AgentConfig, Arc<ApiClient>)> {
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

    fn ephemeral_hooks(&self) -> AgentResult<PathBuf> {
        let dir = self
            .store
            .paths
            .hooks_base_dir
            .join(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法创建临时 hooks 目录：{error}"),
            )
        })?;
        Ok(dir)
    }

    fn allow_file_remote(&self) -> bool {
        std::fs::read_to_string(&self.store.paths.config_file)
            .ok()
            .and_then(|text| serde_json::from_str::<AgentConfig>(&text).ok())
            .map(|config| config.allow_local_git_remotes)
            .unwrap_or(false)
    }
}

pub fn pending_control(app: &AppHandle) -> Option<Value> {
    service(app)
        .ok()
        .and_then(|service| service.pending_control())
}

pub fn show_pending_control(app: &AppHandle) -> bool {
    let Ok(service) = service(app) else {
        return false;
    };
    if service.pending_control().is_none() {
        return false;
    }
    service.focus_suppressed.store(false, Ordering::SeqCst);
    service.show_control();
    true
}

pub fn close_control_window(app: &AppHandle) {
    if let Ok(service) = service(app) {
        service.suppress_and_hide();
    }
}

pub fn clear_control(app: &AppHandle) {
    if let Ok(service) = service(app) {
        let _ = service.hub.dismiss();
        if service.hub.is_empty() {
            service.hide_control();
        }
    }
}

pub fn dismiss_control(app: &AppHandle) -> Result<(), String> {
    let service = service(app).map_err(|error| message(&error))?;
    let Some(control) = service.pending_control() else {
        return Err("当前没有待处理事件".to_string());
    };
    if control.get("type").and_then(Value::as_str) == Some("assignment_warning") {
        service.suppress_and_hide();
        return Ok(());
    }
    service.hub.dismiss().map_err(|error| message(&error))?;
    if service.hub.is_empty() {
        service.hide_control();
    }
    Ok(())
}

pub async fn decide_live_change(
    app: &AppHandle,
    task_space_id: &str,
    conflict_id: &str,
    action: &str,
) -> Result<(), String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    task_sync
        .decide_conflict(task_space_id, conflict_id, action, None)
        .await
        .map(|_| ())
        .map_err(|error| message(&error))
}

pub async fn live_conflict_details(
    app: &AppHandle,
    task_space_id: &str,
    conflict_id: &str,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    task_sync
        .conflict_details(task_space_id, conflict_id)
        .await
        .map_err(|error| message(&error))
}

pub async fn resolve_initial_sync(
    app: &AppHandle,
    task_space_id: &str,
    mode: &str,
    decisions: Option<Value>,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    let decisions: Vec<Value> = match decisions {
        Some(Value::Array(items)) => items,
        _ => Vec::new(),
    };
    task_sync
        .resolve_initial_sync(task_space_id, mode, &decisions)
        .await
        .map_err(|error| message(&error))
}

/// 对照 JS `live-sync-deferred` 一次性命令：补传首次同步时暂缓的本地任务目录。
pub async fn sync_deferred_tasks(app: &AppHandle, task_space_id: &str) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    task_sync
        .sync_deferred_tasks(task_space_id)
        .await
        .map_err(|error| message(&error))
}

pub async fn list_task_ownership(
    app: &AppHandle,
    task_space_id: &str,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    task_sync
        .list_task_ownership(task_space_id)
        .await
        .map_err(|error| message(&error))
}

pub async fn set_task_ownership(
    app: &AppHandle,
    task_space_id: &str,
    decisions: Value,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = TaskSync::new(service.store.clone(), api, Arc::new(|_control: Value| {}));
    task_sync.set_bindings(config.bindings).await;
    task_sync
        .set_task_ownership(task_space_id, decisions)
        .await
        .map_err(|error| message(&error))
}

pub async fn login(
    app: &AppHandle,
    server_url: &str,
    username: &str,
    password: &str,
    device_name: &str,
    force_new: bool,
) -> Result<DesktopLoginSummary, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let ca_file = service
        .store
        .read_config(true)
        .await
        .ok()
        .flatten()
        .and_then(|config| config.ca_file)
        .map(PathBuf::from);
    let api =
        ApiClient::new(server_url, None, ca_file.as_deref()).map_err(|error| message(&error))?;
    device::login_desktop(
        &service.store,
        &api,
        username,
        password,
        device_name,
        force_new,
    )
    .await
    .map_err(|error| message(&error))
}

pub async fn logout(_app: &AppHandle, server_url: &str, session_token: &str) -> Result<(), String> {
    let api = ApiClient::new(server_url, None, None).map_err(|error| message(&error))?;
    device::logout_desktop_session(&api, session_token)
        .await
        .map(|_| ())
        .map_err(|error| message(&error))
}

pub async fn associate(
    app: &AppHandle,
    repo_path: &str,
    branch_name: &str,
    team_id: &str,
    developer_id: &str,
    require_pushed: bool,
    initial_mode: &str,
) -> Result<LocalAssociation, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (_config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let summary = associate_desktop_project(
        &service.store,
        &api,
        AssociateParams {
            repo_path: repo_path.to_string(),
            branch_name: branch_name.to_string(),
            team_id: team_id.to_string(),
            developer_id: developer_id.to_string(),
            display_name: None,
            require_pushed,
            initial_sync_mode: initial_mode.to_string(),
        },
    )
    .await
    .map_err(|error| message(&error))?;
    Ok(LocalAssociation {
        project_id: summary.project_id.unwrap_or_default(),
        task_space_id: summary.task_space_id.unwrap_or_default(),
        repo_path: summary.repo_path.unwrap_or_default(),
        display_name: summary.display_name.unwrap_or_default(),
        branch_name: summary.branch_name.unwrap_or_default(),
        team_id: summary.team_id,
        status: summary.status.unwrap_or_default(),
        detach_pending: false,
        read_only: summary.read_only.unwrap_or(false),
        live_sync_status: summary
            .live_sync_status
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "pending".to_string()),
        live_sync_error: summary.live_sync_error.filter(|value| !value.is_empty()),
        deferred_count: 0,
        deferred_task_dirs: Vec::new(),
        ownership_paused_count: 0,
        ownership_paused_task_dirs: Vec::new(),
        ownership_pending_count: 0,
        ownership_pending_task_dirs: Vec::new(),
        last_error_code: None,
        last_error: None,
    })
}

pub async fn preflight_project(
    app: &AppHandle,
    repo_path: &str,
    team_id: &str,
    require_pushed: bool,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (_config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let result = crate::agent::association::preflight_desktop_project(
        &service.store,
        &api,
        repo_path,
        team_id,
        require_pushed,
    )
    .await
    .map_err(|error| message(&error))?;
    Ok(json!({ "ok": true, "result": result }))
}

pub async fn inspect_project(app: &AppHandle, repo_path: &str) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let allow_file_remote = service.allow_file_remote();
    let hooks = service.ephemeral_hooks().map_err(|error| message(&error))?;
    let inspected =
        onboarding::inspect_project(Path::new(repo_path), &hooks, allow_file_remote).await;
    let _ = std::fs::remove_dir_all(&hooks);
    let inspected = inspected.map_err(|error| message(&error))?;
    Ok(json!({ "ok": true, "project": inspected }))
}

fn trellis_runtime() -> AgentResult<TrellisRuntime> {
    let config = crate::config::load()
        .ok()
        .flatten()
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "桌面配置缺失，请重新登录"))?;
    let node: env::NodeRuntimeFlag = config
        .node_runtime
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| {
            AgentError::new(
                code::CONFIG_MISSING,
                "Node.js 运行环境未就绪，请先在登录页完成环境检查",
            )
        })?;
    let trellis: env::TrellisRuntimeFlag = config
        .trellis_runtime
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or_else(|| {
            AgentError::new(
                code::CONFIG_MISSING,
                "Trellis CLI 未就绪，请先在登录页完成环境检查",
            )
        })?;
    Ok(TrellisRuntime {
        node_exe: PathBuf::from(node.path),
        cli_path: PathBuf::from(trellis.cli_path),
    })
}

pub async fn initialize_project(
    app: &AppHandle,
    repo_path: &str,
    developer_id: &str,
    agent_tools: &[String],
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = trellis_runtime().map_err(|error| message(&error))?;
    let allow_file_remote = service.allow_file_remote();
    let hooks = service.ephemeral_hooks().map_err(|error| message(&error))?;
    let result = onboarding::initialize_project(&onboarding::InitializeOptions {
        repo_path: Path::new(repo_path),
        hooks_dir: &hooks,
        developer_id,
        agent_tools,
        runtime: &runtime,
        allow_file_remote,
    })
    .await;
    let _ = std::fs::remove_dir_all(&hooks);
    let project = result.map_err(|error| message(&error))?;
    Ok(json!({ "ok": true, "project": project }))
}

pub async fn check_initial_push(
    app: &AppHandle,
    repo_path: &str,
    branch_name: &str,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let allow_file_remote = service.allow_file_remote();
    let hooks = service.ephemeral_hooks().map_err(|error| message(&error))?;
    let result = onboarding::check_initial_push_with(
        Path::new(repo_path),
        &hooks,
        branch_name,
        allow_file_remote,
    )
    .await;
    let _ = std::fs::remove_dir_all(&hooks);
    let state = result.map_err(|error| message(&error))?;
    let mut payload =
        serde_json::to_value(state).map_err(|error| format!("无法序列化推送检查结果：{error}"))?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    Ok(payload)
}

pub async fn list_associations(app: &AppHandle) -> Result<Vec<LocalAssociation>, String> {
    let service = service(app).map_err(|error| message(&error))?;
    device::read_local_associations(&service.store)
        .await
        .map_err(|error| message(&error))
}

pub async fn detach_local_association(
    app: &AppHandle,
    task_space_id: &str,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = service
        .runtime
        .lock()
        .map_err(|_| "无法读取 Agent 运行状态".to_string())?
        .clone();
    let outcome = if let Some(runtime) = runtime {
        runtime.detach_local_association(task_space_id).await
    } else {
        let (_config, api) = service
            .agent_context()
            .await
            .map_err(|error| message(&error))?;
        let task_sync = Arc::new(TaskSync::new(
            service.store.clone(),
            api.clone(),
            Arc::new(|_control: Value| {}),
        ));
        detach::detach_local_association(
            &service.store,
            &api,
            &task_sync,
            task_space_id,
            false,
        )
        .await
    }
    .map_err(|error| message(&error))?;
    serde_json::to_value(outcome).map_err(|error| format!("无法序列化解绑结果：{error}"))
}

/// 与 `sidecar.rs` 的 `SidecarStatus` 同形，前端 `ProjectRail` 继续读取。
pub type SidecarStatus = AgentStatus;
