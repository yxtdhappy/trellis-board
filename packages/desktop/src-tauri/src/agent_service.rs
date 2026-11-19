//! 进程内 Agent 服务：替代旧的 sidecar 子进程桥。
//!
//! `main.rs` 只与本模块交互；所有同步/控制事件都在客户端进程内完成。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

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
use crate::agent::state_events::{DesktopStateEvents, StateSink};
use crate::agent::store::{AgentBinding, AgentConfig, ConfigStore};
use crate::agent::task_control::{parse_state_file, HandoffNotice};
use crate::agent::task_sync::{ControlSink, TaskSync};
use crate::agent::trellis_cli::TrellisRuntime;
use crate::agent::worktree::WorktreeStatusView;

pub use crate::agent::device::LocalAssociation;

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
    state_events: Arc<DesktopStateEvents>,
    paused: Arc<AtomicBool>,
    runtime: Arc<Mutex<Option<Arc<AgentRuntime>>>>,
    starting: Arc<AtomicBool>,
    auto_notify_consumed: Arc<AtomicBool>,
    sync_menu_item: Arc<Mutex<Option<MenuItem<Wry>>>>,
}

pub fn register(app: &AppHandle) {
    let store = ConfigStore::new(crate::config::agent_root());
    let hub = ControlHub::new();
    let state_events = DesktopStateEvents::new(Arc::new({
        let app = app.clone();
        move |topics| {
            let _ = app.emit("desktop-state-changed", json!({ "topics": topics }));
        }
    }));
    let state_runner = state_events.clone();
    tauri::async_runtime::spawn(async move { state_runner.run().await });
    app.manage(AgentService {
        app: app.clone(),
        store: Arc::new(store),
        hub: Arc::new(hub),
        state_events,
        paused: Arc::new(AtomicBool::new(false)),
        runtime: Arc::new(Mutex::new(None)),
        starting: Arc::new(AtomicBool::new(false)),
        auto_notify_consumed: Arc::new(AtomicBool::new(false)),
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
        let was_paused = service.paused.swap(false, Ordering::SeqCst);
        if was_paused {
            service.notify_sidecar();
        }
        if service.hub.resume() {
            service.notify_live_control();
        }
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
    service.notify_sidecar();
    if paused {
        service.stop_runtime();
        refresh_sync_menu(app);
        return;
    }
    if service.hub.resume() {
        service.notify_live_control();
    }
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

    fn state_sink(&self) -> StateSink {
        self.state_events.associations_sink()
    }

    async fn task_sync(&self, api: Arc<ApiClient>, bindings: Vec<AgentBinding>) -> TaskSync {
        let task_sync = TaskSync::new(self.store.clone(), api, Arc::new(|_control: Value| {}));
        task_sync.set_bindings(bindings).await;
        task_sync.with_state_sink(self.state_sink())
    }

    fn notify_live_control(&self) {
        let _ = self.app.emit("live-control-changed", ());
    }

    fn window_focused(&self) -> bool {
        self.app
            .get_webview_window("main")
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
    }

    fn window_hidden_or_minimized(&self) -> bool {
        let Some(window) = self.app.get_webview_window("main") else {
            return true;
        };
        let visible = window.is_visible().unwrap_or(true);
        let minimized = window.is_minimized().unwrap_or(false);
        !visible || minimized
    }

    /// handoff 终态在窗口隐藏/最小化时用原生通知；可见时由 Board 内 toast 展示。
    fn notify_handoff_terminal(&self, control: &Value) {
        let Some((title, body)) = handoff_notification(control) else {
            return;
        };
        if !self.window_hidden_or_minimized() {
            return;
        }
        show_windows_toast(&self.app.config().identifier, title, &body);
    }

    /// 自动事件只发系统通知，绝不抢焦点；档位由「偏好设置 → 同步通知」决定。
    fn notify_control(&self, control: &Value) {
        match crate::appearance::load().notify_mode.as_str() {
            "never" => return,
            "unfocused" if self.window_focused() => return,
            _ => {}
        }
        let (title, body) = control_notification(control);
        if let Err(error) = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            crate::logging::warn(&format!("发送同步通知失败：{error}"));
        }
    }

    fn notify_sidecar(&self) {
        self.state_events.notify_sidecar();
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
            self.state_sink(),
            self.paused.clone(),
            &self.hub,
        )
        .await?;
        if let Ok(mut guard) = self.runtime.lock() {
            *guard = Some(runtime);
        }
        self.notify_sidecar();
        Ok(())
    }

    fn stop_runtime(&self) {
        let taken = self.runtime.lock().ok().and_then(|mut guard| guard.take());
        if let Some(runtime) = taken {
            runtime.stop();
            self.notify_sidecar();
        }
    }

    fn publish_control(&self, control: Value) {
        if control.get("type").and_then(Value::as_str) == Some("task_handoff") {
            self.notify_handoff_terminal(&control);
            let _ = self.app.emit("handoff-control-changed", control);
            self.notify_live_control();
            return;
        }
        let review = control.get("type").and_then(Value::as_str) == Some("initial_sync_review");
        let (became_front, changed) = self.hub.push_with_change(control.clone());
        if changed {
            self.notify_live_control();
        }
        if review {
            // 差异审查是首次接入的必经步骤：被关闭过也要重新露出，但只发通知不抢焦点。
            if changed {
                self.notify_control(&control);
            }
            return;
        }
        if !became_front {
            return;
        }
        if !self.auto_notify_consumed.swap(true, Ordering::SeqCst) {
            self.notify_control(&control);
        }
    }

    fn pending_control(&self) -> Option<Value> {
        self.hub.pending()
    }

    async fn pending_handoff_notices(&self) -> AgentResult<Vec<HandoffNotice>> {
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

/// 系统通知文案：纯函数便于单测。缺项目信息时不拼空括号。
fn handoff_notification(control: &Value) -> Option<(&'static str, String)> {
    let title = match control.get("outcome").and_then(Value::as_str) {
        Some("cleaned") => "任务已被认领，本地副本已清理",
        Some("conflict") => "任务已被认领，本地副本需保留",
        _ => return None,
    };
    let task_id = control
        .get("taskId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let reason = handoff_reason_label(control.get("reason").and_then(Value::as_str));
    let body = if reason.is_empty() {
        task_id.to_string()
    } else {
        format!("{task_id} · {reason}")
    };
    Some((title, body))
}

fn handoff_reason_label(reason: Option<&str>) -> &'static str {
    match reason {
        Some("missing") => "本地活动副本已不存在",
        Some("git_tracked") => "任务目录已进入 Git 跟踪，保留本地副本",
        Some("git_modified") => "任务目录包含修改，保留本地副本",
        Some("not_untracked") => "任务目录不是纯未跟踪副本，保留本地文件",
        Some("no_files") => "任务目录没有可清理文件",
        Some("baseline_mismatch") => "本地内容与已同步基线不一致，保留本地副本",
        Some("branch_mismatch") => "当前 Git 分支与任务空间不一致",
        Some("backup_failed") => "本地备份失败，未删除任何任务文件",
        Some("backup_too_large") => "本地任务副本超过安全备份上限，已保留",
        Some("cleanup_failed") => "本地备份已完成，但目录清理失败",
        Some("lease_active") => "任务仍有其他客户端持有写租约，暂未清理",
        Some(_) => "本地副本状态需要人工确认",
        None => "",
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 便携版应用的 AUMID 没有 Start Menu 注册，Windows 会静默丢弃插件默认的
/// ToastGeneric 通知；传统 ToastText02 模板可以正常显示。这里用
/// PowerShell WinRT 直接发 ToastText02，避免依赖插件模板。
fn show_windows_toast(app_id: &str, title: &str, body: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let xml = format!(
            "<toast><visual><binding template=\"ToastText02\"><text id=\"1\">{}</text><text id=\"2\">{}</text></binding></visual></toast>",
            xml_escape(title),
            xml_escape(body),
        );
        let xml_base64 = base64::engine::general_purpose::STANDARD.encode(xml.as_bytes());
        let app_id = app_id.replace('\'', "''");
        let script = format!(
            "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]\n\
             $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]\n\
             $xmlText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{xml_base64}'))\n\
             $xml = New-Object Windows.Data.Xml.Dom.XmlDocument\n\
             $xml.LoadXml($xmlText)\n\
             $toast = New-Object Windows.UI.Notifications.ToastNotification $xml\n\
             [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{app_id}').Show($toast)\n"
        );
        let encoded =
            base64::engine::general_purpose::STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<u8>>());
        match std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded.as_str()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        {
            Ok(mut child) => {
                std::thread::spawn(move || match child.wait() {
                    Ok(status) if status.success() => {}
                    Ok(status) => crate::logging::warn(&format!(
                        "发送任务认领系统通知失败：PowerShell 退出码 {status}"
                    )),
                    Err(error) => crate::logging::warn(&format!(
                        "等待任务认领系统通知进程失败：{error}"
                    )),
                });
            }
            Err(error) => crate::logging::warn(&format!(
                "启动任务认领系统通知失败：{error}"
            )),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app_id, title, body);
    }
}

fn control_notification(control: &Value) -> (String, String) {
    let text = |pointer: &str| {
        control
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
    };
    let scope = match (text("/projectName"), text("/branchName")) {
        ("", "") => String::new(),
        (project, "") => format!("{project}："),
        (project, branch) => format!("{project}（{branch}）："),
    };
    let count = |key: &str| {
        control
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
    };
    match control
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "initial_sync_review" => (
            "有任务差异需要确认".to_string(),
            format!(
                "{scope}{} 个任务存在差异，打开客户端逐项处理。",
                count("differences")
            ),
        ),
        "task_file_conflict" => {
            let target = match text("/conflict/taskDir") {
                "" => "任务文件",
                task_dir => task_dir,
            };
            (
                "任务文件冲突".to_string(),
                format!("{scope}{target} 被同时修改，打开客户端选择保留哪一份。"),
            )
        }
        "task_ownership_review" => (
            "任务归属需要确认".to_string(),
            format!("{scope}{} 个任务需要确认开发分支。", count("items")),
        ),
        "task_sync_error" => {
            let detail = match text("/message") {
                "" => text("/error"),
                message => message,
            };
            ("任务同步失败".to_string(), format!("{scope}{detail}"))
        }
        _ => (
            "Trellis Board 有新的同步事件".to_string(),
            format!("{scope}打开客户端查看任务同步情况。"),
        ),
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
    // 用户主动要求查看：把「稍后处理」过的事件放回队列，否则同内容不会再自动出现。
    service.hub.reveal_dismissed();
    if service.pending_control().is_none() {
        return false;
    }
    crate::focus_main_window(app);
    service.notify_live_control();
    true
}

pub fn clear_control(app: &AppHandle) {
    if let Ok(service) = service(app) {
        if service.hub.dismiss_with_change().unwrap_or(false) {
            service.hub.clear_dismissed();
            service.notify_live_control();
        }
    }
}

pub fn dismiss_control(app: &AppHandle) -> Result<(), String> {
    let service = service(app).map_err(|error| message(&error))?;
    if service.pending_control().is_none() {
        return Err("当前没有待处理事件".to_string());
    }
    service
        .hub
        .dismiss_with_change()
        .map_err(|error| message(&error))?;
    service.notify_live_control();
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
    let task_sync = service.task_sync(api, config.bindings).await;
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
    let task_sync = service.task_sync(api, config.bindings).await;
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
    let task_sync = service.task_sync(api, config.bindings).await;
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
    let task_sync = service.task_sync(api, config.bindings).await;
    task_sync
        .sync_deferred_tasks(task_space_id)
        .await
        .map_err(|error| message(&error))
}

pub async fn list_task_ownership(app: &AppHandle, task_space_id: &str) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = service.task_sync(api, config.bindings).await;
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
    let task_sync = service.task_sync(api, config.bindings).await;
    task_sync
        .set_task_ownership(task_space_id, decisions)
        .await
        .map_err(|error| message(&error))
}

/// 对照 JS `live-task-download`：把服务端上的任务目录拉到本地，作为只读镜像。
pub async fn download_task(
    app: &AppHandle,
    task_space_id: &str,
    task_id: &str,
) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = service.task_sync(api, config.bindings).await;
    task_sync
        .download_task(task_space_id, task_id)
        .await
        .map_err(|error| message(&error))
}

pub async fn local_task_state(app: &AppHandle, task_space_id: &str) -> Result<Value, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let task_sync = service.task_sync(api, config.bindings).await;
    task_sync
        .local_task_state(task_space_id)
        .await
        .map_err(|error| message(&error))
}

/// 重新露出仍然成立的冲突审查；返回是否真的推了一条冲突控制事件。
pub async fn reopen_conflicts(
    app: &AppHandle,
    task_space_id: Option<String>,
) -> Result<bool, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let (config, api) = service
        .agent_context()
        .await
        .map_err(|error| message(&error))?;
    let space_ids: Vec<String> = match task_space_id {
        Some(id) => vec![id],
        None => {
            let mut ids: Vec<String> = Vec::new();
            for binding in &config.bindings {
                if !ids.contains(&binding.task_space_id) {
                    ids.push(binding.task_space_id.clone());
                }
            }
            ids
        }
    };
    let task_sync = service.task_sync(api, config.bindings).await;
    let mut shown = false;
    for space_id in space_ids {
        if let Some(event) = task_sync
            .reopen_conflicts(&space_id)
            .await
            .map_err(|error| message(&error))?
        {
            service.publish_control(event);
            shown = true;
        }
    }
    Ok(shown)
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
    service.state_events.notify_associations();
    Ok(LocalAssociation {
        project_id: summary.project_id.unwrap_or_default(),
        task_space_id: summary.task_space_id.unwrap_or_default(),
        repo_path: summary.repo_path.unwrap_or_default(),
        display_name: summary.display_name.unwrap_or_default(),
        branch_name: summary.branch_name.unwrap_or_default(),
        team_id: summary.team_id,
        status: summary.status.unwrap_or_default(),
        detach_pending: false,
        initial_review_pending: summary.initial_review_pending.unwrap_or(false),
        read_only: summary.read_only.unwrap_or(false),
        live_sync_status: summary
            .live_sync_status
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "pending".to_string()),
        live_sync_error: summary.live_sync_error.filter(|value| !value.is_empty()),
        deferred_count: 0,
        deferred_task_dirs: Vec::new(),
        deferred_tasks: Vec::new(),
        ownership_paused_count: 0,
        ownership_paused_task_dirs: Vec::new(),
        ownership_pending_count: 0,
        ownership_pending_task_dirs: Vec::new(),
        pending_upload_count: 0,
        pending_upload_task_dirs: Vec::new(),
        pending_rejected_count: 0,
        pending_rejected_task_dirs: Vec::new(),
        conflict_pending_count: 0,
        conflict_pending_task_dirs: Vec::new(),
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
    let mut payload = crate::agent::association::preflight_desktop_project(
        &service.store,
        &api,
        repo_path,
        team_id,
        require_pushed,
    )
    .await
    .map_err(|error| message(&error))?;
    if let Some(object) = payload.as_object_mut() {
        object.insert("ok".to_string(), Value::Bool(true));
    }
    Ok(payload)
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
    let trace = std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_some();
    let started = std::time::Instant::now();
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = service
        .runtime
        .lock()
        .map_err(|_| "无法读取 Agent 运行状态".to_string())?
        .clone();
    let associations = device::read_local_associations(
        &service.store,
        runtime.as_ref().map(|runtime| runtime.task_sync()),
    )
    .await
    .map_err(|error| message(&error))?;
    if trace {
        crate::logging::warn(&format!(
            "本地关联查询 count={} elapsedMs={}",
            associations.len(),
            started.elapsed().as_millis()
        ));
    }
    Ok(associations)
}

pub async fn list_worktree_status(app: &AppHandle) -> Result<Vec<WorktreeStatusView>, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = service
        .runtime
        .lock()
        .map_err(|_| "无法读取 Agent 运行状态".to_string())?
        .clone();
    Ok(runtime
        .map(|runtime| runtime.worktree().list())
        .unwrap_or_default())
}

pub async fn refresh_worktree_discovery(
    app: &AppHandle,
) -> Result<Vec<WorktreeStatusView>, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = service
        .runtime
        .lock()
        .map_err(|_| "无法读取 Agent 运行状态".to_string())?
        .clone()
        .ok_or_else(|| "Agent 尚未运行".to_string())?;
    runtime
        .worktree()
        .refresh()
        .await
        .map_err(|error| message(&error))
}

pub async fn retry_worktree_auto_attach(
    app: &AppHandle,
    key: &str,
) -> Result<Vec<WorktreeStatusView>, String> {
    let service = service(app).map_err(|error| message(&error))?;
    let runtime = service
        .runtime
        .lock()
        .map_err(|_| "无法读取 Agent 运行状态".to_string())?
        .clone()
        .ok_or_else(|| "Agent 尚未运行".to_string())?;
    runtime
        .worktree()
        .retry(key)
        .await
        .map_err(|error| message(&error))
}

pub async fn pending_handoff_notices(app: &AppHandle) -> Result<Vec<HandoffNotice>, String> {
    let service = service(app).map_err(|error| message(&error))?;
    service
        .pending_handoff_notices()
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
        let (config, api) = service
            .agent_context()
            .await
            .map_err(|error| message(&error))?;
        let task_sync = Arc::new(service.task_sync(api.clone(), config.bindings).await);
        detach::detach_local_association(&service.store, &api, &task_sync, task_space_id, false)
            .await
    }
    .map_err(|error| message(&error))?;
    service.state_events.notify_associations();
    serde_json::to_value(outcome).map_err(|error| format!("无法序列化解绑结果：{error}"))
}

/// 与 `sidecar.rs` 的 `SidecarStatus` 同形，前端 `ProjectRail` 继续读取。
pub type SidecarStatus = AgentStatus;

#[cfg(test)]
mod tests;
