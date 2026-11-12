use std::collections::VecDeque;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_RESTARTS: u32 = 5;
const STABLE_RUN: Duration = Duration::from_secs(60);
const LOCK_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_RESTART_TIMEOUT: Duration = Duration::from_secs(15);
const FORCE_RESTART_STABLE: Duration = Duration::from_secs(2);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SIDECAR_NAME: &str = "trellis-agent";
const SHORT_COMMAND_TIMEOUT: Duration = Duration::from_secs(15);
const STANDARD_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const SYNC_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const GIT_CHECK_TIMEOUT: Duration = Duration::from_secs(240);
const GIT_MUTATION_TIMEOUT: Duration = Duration::from_secs(600);

fn default_live_sync_status() -> String {
    "pending".to_string()
}

fn live_id_is_safe(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
}

fn control_text<'a>(control: &'a Value, pointer: &str) -> &'a str {
    control.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}

fn control_from_line(line: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(line.trim()).ok()?;
    let control = value.get("control")?;
    if !control.is_object() {
        return None;
    }
    let event_type = control.get("type").and_then(Value::as_str)?;
    if event_type.is_empty() {
        return None;
    }
    Some(control.clone())
}

fn control_key(control: &Value) -> String {
    match control.get("type").and_then(Value::as_str) {
        Some("assignment_warning") => {
            let assignee = [
                control_text(control, "/assignee/userId"),
                control_text(control, "/assignee/username"),
                control_text(control, "/assignee/displayName"),
            ]
            .into_iter()
            .find(|value| !value.is_empty())
            .unwrap_or("");
            format!(
                "assignment_warning\0{}\0{}\0{}",
                control_text(control, "/projectId"),
                control_text(control, "/task/taskKey"),
                assignee
            )
        }
        Some("remote_overwrite") => {
            format!("remote_overwrite\0{}", control_text(control, "/backupId"))
        }
        Some("assignment_overridden") => format!(
            "assignment_overridden\0{}\0{}\0{}",
            control_text(control, "/projectId"),
            control_text(control, "/taskKey"),
            control.get("revision").and_then(Value::as_i64).unwrap_or(0)
        ),
        Some("initial_sync_review") => format!(
            "initial_sync_review\0{}\0{}",
            control_text(control, "/taskSpaceId"),
            control.get("revision").and_then(Value::as_i64).unwrap_or(0)
        ),
        Some("task_file_conflict") => format!(
            "task_file_conflict\0{}\0{}",
            control_text(control, "/taskSpaceId"),
            control_text(control, "/conflict/conflictId")
        ),
        _ => format!("control\0{}", control),
    }
}

fn enqueue_control(pending: &mut VecDeque<Value>, control: Value) {
    let key = control_key(&control);
    if let Some(existing) = pending
        .iter_mut()
        .find(|item| control_key(item) == key)
    {
        *existing = control;
        return;
    }
    if pending.len() >= 32 {
        pending.pop_front();
    }
    pending.push_back(control);
}

fn control_is_stale(control: &Value, now_ms: u128, pending_dir: &Path) -> bool {
    if control
        .get("expiresAtEpochMs")
        .and_then(Value::as_u64)
        .is_some_and(|expires_at| u128::from(expires_at) <= now_ms)
    {
        return true;
    }
    if control.get("type").and_then(Value::as_str) != Some("assignment_warning") {
        return false;
    }
    let Some(pending_id) = control.get("pendingId").and_then(Value::as_str) else {
        return true;
    };
    !live_id_is_safe(pending_id) || !pending_dir.join(format!("{pending_id}.json")).is_file()
}

#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    paused: AtomicBool,
    quitting: AtomicBool,
    running: AtomicBool,
    restarts: AtomicU32,
    generation: AtomicU64,
    auto_focus_consumed: AtomicBool,
    focus_suppressed: AtomicBool,
    force_restarting: AtomicBool,
    recovery_prompted: AtomicBool,
    last_start: Mutex<Option<Instant>>,
    pending_control: Mutex<VecDeque<Value>>,
    sync_menu_item: Mutex<Option<MenuItem<Wry>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLoginSummary {
    pub ok: bool,
    pub session_token: Option<String>,
    pub expires_at: Option<String>,
    pub username: Option<String>,
    pub must_change_password: Option<bool>,
    pub device_ready: Option<bool>,
    pub error: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAssociation {
    pub project_id: String,
    #[serde(default)]
    pub task_space_id: String,
    pub repo_path: String,
    pub display_name: String,
    pub branch_name: String,
    pub team_id: Option<String>,
    pub status: String,
    pub read_only: bool,
    #[serde(default = "default_live_sync_status")]
    pub live_sync_status: String,
    pub live_sync_error: Option<String>,
    pub last_error_code: Option<String>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub deferred_count: usize,
    #[serde(default)]
    pub deferred_task_dirs: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
    pub running: bool,
    pub paused: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssociationSummary {
    ok: bool,
    project_id: Option<String>,
    task_space_id: Option<String>,
    repo_path: Option<String>,
    display_name: Option<String>,
    branch_name: Option<String>,
    team_id: Option<String>,
    status: Option<String>,
    read_only: Option<bool>,
    live_sync_status: Option<String>,
    live_sync_error: Option<String>,
    error: Option<String>,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssociationsResponse {
    ok: bool,
    associations: Option<Vec<LocalAssociation>>,
    error: Option<String>,
}

pub fn register(app: &AppHandle) {
    app.manage(SidecarState::default());
}

pub fn set_sync_menu_item(app: &AppHandle, item: MenuItem<Wry>) {
    let state = app.state::<SidecarState>();
    if let Ok(mut current) = state.sync_menu_item.lock() {
        *current = Some(item);
    }
    refresh_sync_menu(app);
}

pub fn is_running(app: &AppHandle) -> bool {
    let state = app.state::<SidecarState>();
    state.running.load(Ordering::SeqCst) && state.child.lock().map(|guard| guard.is_some()).unwrap_or(false)
}

pub fn status(app: &AppHandle) -> SidecarStatus {
    let state = app.state::<SidecarState>();
    SidecarStatus {
        running: is_running(app),
        paused: state.paused.load(Ordering::SeqCst),
    }
}

#[derive(Debug, PartialEq, Eq)]
enum SyncMenuMode {
    Pause,
    Resume,
    Restarting,
}

fn sync_menu_mode(running: bool, force_restarting: bool) -> SyncMenuMode {
    if force_restarting {
        SyncMenuMode::Restarting
    } else if running {
        SyncMenuMode::Pause
    } else {
        SyncMenuMode::Resume
    }
}

fn sync_menu_label(mode: &SyncMenuMode) -> (&'static str, bool) {
    match mode {
        SyncMenuMode::Pause => ("暂停同步", true),
        SyncMenuMode::Resume => ("恢复同步", true),
        SyncMenuMode::Restarting => ("正在强制重启", false),
    }
}

fn refresh_sync_menu(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mode = sync_menu_mode(
        is_running(app),
        state.force_restarting.load(Ordering::SeqCst),
    );
    let (label, enabled) = sync_menu_label(&mode);
    if let Ok(current) = state.sync_menu_item.lock() {
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

pub fn start(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.quitting.load(Ordering::SeqCst) || state.paused.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    if guard.is_some()
        || state.quitting.load(Ordering::SeqCst)
        || state.paused.load(Ordering::SeqCst)
    {
        return;
    }
    let agent_root = crate::config::agent_root();
    if !agent_root.join("config.json").exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&agent_root);
    let command = match app.shell().sidecar(SIDECAR_NAME) {
        Ok(command) => command
            .args(["run"])
            .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string())
            .set_process_group(true)
            .kill_on_drop(true),
        Err(error) => {
            crate::logging::warn(&format!(
                "sidecar 未随安装包提供（{error}）；后台同步不可用"
            ));
            return;
        }
    };
    match command.spawn() {
        Ok((mut receiver, child)) => {
            *guard = Some(child);
            let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Ok(mut started) = state.last_start.lock() {
                *started = Some(Instant::now());
            }
            state.running.store(true, Ordering::SeqCst);
            drop(guard);
            refresh_sync_menu(app);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = receiver.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            if let Some(control) = control_from_line(&text) {
                                publish_control(&handle, control);
                            } else {
                                crate::logging::line(&text);
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            crate::logging::line(&String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(error) => {
                            crate::logging::warn(&format!("sidecar 错误：{error}"));
                        }
                        CommandEvent::Terminated(payload) => {
                            crate::logging::warn(&format!(
                                "sidecar 已退出（code={:?}）",
                                payload.code
                            ));
                            on_exit(&handle, generation);
                        }
                        _ => {}
                    }
                }
            });
        }
        Err(error) => {
            crate::logging::warn(&format!("sidecar 启动失败：{error}"));
        }
    }
}

fn publish_control(app: &AppHandle, control: Value) {
    let state = app.state::<SidecarState>();
    let queued = state
        .pending_control
        .lock()
        .map(|mut pending| {
            enqueue_control(&mut pending, control);
            true
        })
        .unwrap_or(false);
    let first_auto_show = queued
        && !state.focus_suppressed.load(Ordering::SeqCst)
        && !state.auto_focus_consumed.swap(true, Ordering::SeqCst);
    if first_auto_show {
        show_control(app);
    }
}

fn show_control(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("live-control") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(
        app,
        "live-control",
        WebviewUrl::App("control.html".into())
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

pub fn pending_control(app: &AppHandle) -> Option<Value> {
    let pending_dir = crate::config::agent_root().join("pending-live");
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let next = app
        .state::<SidecarState>()
        .pending_control
        .lock()
        .ok()
        .and_then(|mut pending| {
            pending.retain(|item| !control_is_stale(item, now_ms, &pending_dir));
            pending.front().cloned()
        });
    if next.is_none() {
        if let Some(window) = app.get_webview_window("live-control") {
            let _ = window.hide();
        }
    }
    next
}

fn pop_control(app: &AppHandle) -> bool {
    let state = app.state::<SidecarState>();
    let has_more = state
        .pending_control
        .lock()
        .map(|mut pending| {
            pending.pop_front();
            !pending.is_empty()
        })
        .unwrap_or(false);
    if !has_more {
        if let Some(window) = app.get_webview_window("live-control") {
            let _ = window.hide();
        }
    }
    has_more
}

pub fn show_pending_control(app: &AppHandle) -> bool {
    if pending_control(app).is_none() {
        return false;
    }
    let state = app.state::<SidecarState>();
    state.focus_suppressed.store(false, Ordering::SeqCst);
    show_control(app);
    true
}

pub fn suppress_and_hide_control(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.focus_suppressed.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("live-control") {
        let _ = window.hide();
    }
}

pub fn close_control_window(app: &AppHandle) {
    suppress_and_hide_control(app);
}

pub fn clear_control(app: &AppHandle) {
    pop_control(app);
}

pub fn dismiss_control(app: &AppHandle) -> Result<(), String> {
    let control = pending_control(app).ok_or_else(|| "当前没有待处理事件".to_string())?;
    if control.get("type").and_then(Value::as_str) == Some("assignment_warning") {
        suppress_and_hide_control(app);
        return Ok(());
    }
    pop_control(app);
    Ok(())
}

pub async fn decide_live_change(
    app: &AppHandle,
    task_space_id: &str,
    conflict_id: &str,
    action: &str,
    agent_root: &Path,
) -> Result<(), String> {
    run_json_command(
        app,
        vec![
            "live-decide".to_string(),
            "--task-space".to_string(),
            task_space_id.to_string(),
            "--conflict".to_string(),
            conflict_id.to_string(),
            "--action".to_string(),
            action.to_string(),
        ],
        None,
        agent_root,
        STANDARD_COMMAND_TIMEOUT,
        "提交实时同步确认失败",
    )
    .await
    .map(|_| ())
}

pub async fn live_conflict_details(
    app: &AppHandle,
    task_space_id: &str,
    conflict_id: &str,
    agent_root: &Path,
) -> Result<Value, String> {
    let output = run_json_command(
        app,
        vec![
            "live-diff".to_string(),
            "--task-space".to_string(),
            task_space_id.to_string(),
            "--conflict".to_string(),
            conflict_id.to_string(),
        ],
        None,
        agent_root,
        STANDARD_COMMAND_TIMEOUT,
        "读取冲突差异失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的冲突差异".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的冲突差异".to_string())
}

pub async fn resolve_initial_sync(
    app: &AppHandle,
    task_space_id: &str,
    mode: &str,
    decisions: Option<Value>,
    agent_root: &Path,
) -> Result<Value, String> {
    let stdin = if mode == "review" {
        Some(
            serde_json::json!({
                "decisions": decisions.unwrap_or_else(|| serde_json::json!([]))
            })
            .to_string(),
        )
    } else {
        None
    };
    let output = run_json_command(
        app,
        vec![
            "live-initial".to_string(),
            "--task-space".to_string(),
            task_space_id.to_string(),
            "--mode".to_string(),
            mode.to_string(),
        ],
        stdin,
        agent_root,
        SYNC_COMMAND_TIMEOUT,
        "处理首次任务同步失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的同步结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的同步结果".to_string())
}

pub async fn sync_deferred_tasks(
    app: &AppHandle,
    task_space_id: &str,
    agent_root: &Path,
) -> Result<Value, String> {
    let output = run_json_command(
        app,
        vec![
            "live-sync-deferred".to_string(),
            "--task-space".to_string(),
            task_space_id.to_string(),
        ],
        None,
        agent_root,
        SYNC_COMMAND_TIMEOUT,
        "同步本地待上传任务失败",
    )
    .await?;
    let line =
        last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的补同步结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的补同步结果".to_string())
}

pub async fn restore_live_backup(
    app: &AppHandle,
    backup_id: &str,
    agent_root: &Path,
) -> Result<(), String> {
    run_json_command(
        app,
        vec![
            "live-restore".to_string(),
            "--backup".to_string(),
            backup_id.to_string(),
        ],
        None,
        agent_root,
        SYNC_COMMAND_TIMEOUT,
        "恢复实时同步备份失败",
    )
    .await
    .map(|_| ())
}

fn restart_delay(attempt: u32) -> Option<Duration> {
    (attempt <= MAX_RESTARTS)
        .then(|| Duration::from_secs(1u64 << (attempt - 1).min(4)))
}

fn agent_process_check_failed(error: std::io::Error) -> String {
    format!("无法确认 trellis-agent 进程状态：{error}")
}

fn begin_exclusive_restart(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::SeqCst)
}

fn on_exit(app: &AppHandle, generation: u64) {
    let state = app.state::<SidecarState>();
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    if state.generation.load(Ordering::SeqCst) != generation {
        return;
    }
    state.running.store(false, Ordering::SeqCst);
    *guard = None;
    drop(guard);
    refresh_sync_menu(app);
    if state.quitting.load(Ordering::SeqCst)
        || state.paused.load(Ordering::SeqCst)
        || state.force_restarting.load(Ordering::SeqCst)
    {
        return;
    }
    let stable = state
        .last_start
        .lock()
        .ok()
        .and_then(|value| *value)
        .map(|started| started.elapsed() >= STABLE_RUN)
        .unwrap_or(false);
    if stable {
        state.restarts.store(0, Ordering::SeqCst);
        state.recovery_prompted.store(false, Ordering::SeqCst);
    }
    let attempt = state.restarts.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(delay) = restart_delay(attempt) else {
        crate::logging::warn("sidecar 连续崩溃，已停止自动重启；请从托盘恢复同步");
        show_recovery_dialog(app);
        return;
    };
    crate::logging::warn(&format!(
        "sidecar 将在 {} 秒后重启（第 {attempt} 次）",
        delay.as_secs()
    ));
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        start(&handle);
    });
}

fn show_recovery_dialog(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.force_restarting.load(Ordering::SeqCst)
        || state.recovery_prompted.swap(true, Ordering::SeqCst)
    {
        return;
    }
    refresh_sync_menu(app);
    let handle = app.clone();
    app.dialog()
        .message("后台同步连续重启 5 次仍未成功。可以尝试强制重启同步；如果仍失败，客户端将自动重启。")
        .title("后台同步连续启动失败")
        .buttons(MessageDialogButtons::OkCustom(
            "强制重启同步".to_string(),
        ))
        .show(move |confirmed| {
            if confirmed {
                force_restart(&handle);
            } else {
                crate::logging::warn("用户暂未执行强制重启同步");
            }
        });
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.paused.store(true, Ordering::SeqCst);
    // 使旧进程稍后到达的 Terminated 事件失效，避免误重启或清理新进程。
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.running.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
    refresh_sync_menu(app);
}

pub fn handle_sync_action(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.force_restarting.load(Ordering::SeqCst) {
        return;
    }
    if is_running(app) {
        stop(app);
        crate::logging::warn("已暂停后台同步");
    } else {
        state.paused.store(false, Ordering::SeqCst);
        state.restarts.store(0, Ordering::SeqCst);
        state.recovery_prompted.store(false, Ordering::SeqCst);
        crate::logging::warn("已恢复后台同步");
        restart(app);
    }
}

pub fn restart(app: &AppHandle) {
    stop(app);
    let state = app.state::<SidecarState>();
    state.paused.store(false, Ordering::SeqCst);
    state.restarts.store(0, Ordering::SeqCst);
    state.recovery_prompted.store(false, Ordering::SeqCst);
    refresh_sync_menu(app);
    let handle = app.clone();
    std::thread::spawn(move || {
        let lock_file = crate::config::agent_root().join("agent.lock");
        let deadline = Instant::now() + LOCK_RELEASE_TIMEOUT;
        while lock_file.exists() && Instant::now() < deadline {
            std::thread::sleep(PROCESS_POLL_INTERVAL);
        }
        start(&handle);
    });
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.quitting.store(true, Ordering::SeqCst);
    stop(app);
}

pub fn force_restart(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if !begin_exclusive_restart(&state.force_restarting) {
        crate::logging::warn("强制重启同步已在进行中");
        return;
    }
    state.paused.store(false, Ordering::SeqCst);
    state.restarts.store(0, Ordering::SeqCst);
    state.recovery_prompted.store(false, Ordering::SeqCst);
    stop(app);
    state.paused.store(false, Ordering::SeqCst);
    refresh_sync_menu(app);
    crate::logging::warn("开始强制重启后台同步");

    let handle = app.clone();
    std::thread::spawn(move || {
        let result = force_restart_agent(&handle);
        let state = handle.state::<SidecarState>();
        match result {
            Ok(()) => {
                state.force_restarting.store(false, Ordering::SeqCst);
                crate::logging::warn("强制重启后台同步成功");
                refresh_sync_menu(&handle);
            }
            Err(error) => {
                crate::logging::warn(&format!("强制重启后台同步失败：{error}；即将重启客户端"));
                shutdown(&handle);
                handle.restart();
            }
        }
    });
}

fn force_restart_agent(app: &AppHandle) -> Result<(), String> {
    let agent_root = crate::config::agent_root();
    let lock_file = agent_root.join("agent.lock");
    let previous_token = read_lock_token(&lock_file);
    terminate_agent_processes()?;
    backup_lock_file(&lock_file)?;
    start(app);

    let deadline = Instant::now() + FORCE_RESTART_TIMEOUT;
    let mut matched_token = None;
    let mut stable_since = None;
    while Instant::now() < deadline {
        if let Some((token, pid)) = read_lock_owner(&lock_file) {
            if token != previous_token && agent_process_is_alive(pid)? {
                if matched_token.as_deref() != Some(token.as_str()) {
                    matched_token = Some(token);
                    stable_since = Some(Instant::now());
                } else if stable_since
                    .map(|started| started.elapsed() >= FORCE_RESTART_STABLE)
                    .unwrap_or(false)
                    && read_lock_owner(&lock_file)
                        .map(|(latest, _)| latest == token)
                        .unwrap_or(false)
                {
                    return Ok(());
                }
            } else {
                matched_token = None;
                stable_since = None;
            }
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
    Err("新 Agent 在限定时间内未建立有效的运行锁".to_string())
}

fn read_lock_owner(lock_file: &Path) -> Option<(String, u32)> {
    let metadata: Value = serde_json::from_str(&std::fs::read_to_string(lock_file).ok()?).ok()?;
    let token = metadata.get("token")?.as_str()?.to_string();
    let pid = u32::try_from(metadata.get("pid")?.as_u64()?).ok()?;
    Some((token, pid))
}

fn read_lock_pid(lock_file: &Path) -> Option<u32> {
    let metadata: Value = serde_json::from_str(&std::fs::read_to_string(lock_file).ok()?).ok()?;
    u32::try_from(metadata.get("pid")?.as_u64()?).ok()
}

fn read_lock_token(lock_file: &Path) -> Option<String> {
    read_lock_owner(lock_file).map(|(token, _)| token)
}

fn backup_lock_file(lock_file: &Path) -> Result<(), String> {
    if !lock_file.exists() {
        return Ok(());
    }
    if let Some(pid) = read_lock_pid(lock_file) {
        if process_is_alive(pid)? {
            return Err(format!("agent.lock 仍被存活进程 PID {pid} 持有"));
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let backup: PathBuf = lock_file.with_file_name(format!("agent.lock.force-restart-{stamp}.bak"));
    std::fs::rename(lock_file, &backup)
        .map_err(|error| format!("无法备份残留锁 {}：{error}", backup.display()))
}

#[cfg(windows)]
fn terminate_agent_processes() -> Result<(), String> {
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/IM", "trellis-agent.exe"])
        .output();
    let deadline = Instant::now() + LOCK_RELEASE_TIMEOUT;
    while Instant::now() < deadline {
        if !agent_processes_running()? {
            return Ok(());
        }
        std::thread::sleep(PROCESS_POLL_INTERVAL);
    }
    Err("仍有 trellis-agent.exe 进程无法结束".to_string())
}

#[cfg(not(windows))]
fn terminate_agent_processes() -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn agent_processes_running() -> Result<bool, String> {
    Command::new("tasklist")
        .args([
            "/FI",
            "IMAGENAME eq trellis-agent.exe",
            "/FO",
            "CSV",
            "/NH",
        ])
        .output()
        .map_err(agent_process_check_failed)
        .and_then(|output| {
            if !output.status.success() {
                return Err(format!(
                    "无法查询 trellis-agent 进程：{}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout)
                .to_ascii_lowercase()
                .contains("trellis-agent.exe"))
        })
}

#[cfg(windows)]
fn tasklist_for_pid(pid: u32) -> Result<String, String> {
    let filter = format!("PID eq {pid}");
    Command::new("tasklist")
        .args(["/FI", &filter, "/FO", "CSV", "/NH"])
        .output()
        .map_err(agent_process_check_failed)
        .and_then(|output| {
            if !output.status.success() {
                return Err(format!(
                    "无法查询进程 {pid}：{}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_ascii_lowercase())
        })
}

#[cfg(windows)]
fn process_is_alive(pid: u32) -> Result<bool, String> {
    Ok(tasklist_for_pid(pid)?.contains(&format!("\"{pid}\"")))
}

#[cfg(not(windows))]
fn process_is_alive(pid: u32) -> Result<bool, String> {
    Ok(Path::new("/proc").join(pid.to_string()).exists())
}

#[cfg(windows)]
fn agent_process_is_alive(pid: u32) -> Result<bool, String> {
    let text = tasklist_for_pid(pid)?;
    Ok(text.contains("trellis-agent.exe") && text.contains(&format!("\"{pid}\"")))
}

#[cfg(not(windows))]
fn agent_process_is_alive(pid: u32) -> Result<bool, String> {
    process_is_alive(pid)
}

fn last_json_line(output: &str) -> Option<&str> {
    output
        .lines()
        .rev()
        .find(|line| serde_json::from_str::<serde_json::Value>(line.trim()).is_ok())
        .map(str::trim)
}

fn sidecar_error(stdout: &str, stderr: &str, fallback: &str) -> String {
    if let Some(line) = last_json_line(stdout) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(message) = value.get("error").and_then(serde_json::Value::as_str) {
                if !message.is_empty() {
                    return message.to_string();
                }
            }
        }
    }
    let message = crate::logging::redact(stderr.trim());
    if message.is_empty() {
        fallback.to_string()
    } else {
        message
    }
}

fn terminate_command_child(child: CommandChild, message: String) -> String {
    match child.kill() {
        Ok(()) => message,
        Err(error) => format!("{message}；终止客户端后台进程失败：{error}"),
    }
}

async fn run_json_command(
    app: &AppHandle,
    args: Vec<String>,
    stdin: Option<String>,
    agent_root: &Path,
    timeout: Duration,
    fallback: &str,
) -> Result<String, String> {
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("sidecar 未随安装包提供：{error}"))?
        .args(args)
        .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string())
        .set_process_group(true)
        .kill_on_drop(true);
    let (mut receiver, mut child) = command
        .spawn()
        .map_err(|error| format!("无法启动客户端后台进程：{error}"))?;
    if let Some(payload) = stdin {
        if let Err(error) = child.write(format!("{payload}\n").as_bytes()) {
            return Err(terminate_command_child(
                child,
                format!("无法写入客户端后台输入：{error}"),
            ));
        }
    }
    let result = tokio::time::timeout(timeout, async {
        let mut stdout = String::new();
        let mut stderr = String::new();
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    stdout.push_str(&String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    stderr.push_str(&String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    if payload.code != Some(0) {
                        return Err(sidecar_error(&stdout, &stderr, fallback));
                    }
                    return Ok(stdout);
                }
                CommandEvent::Error(error) => {
                    return Err(format!("客户端后台进程错误：{error}"));
                }
                _ => {}
            }
        }
        Err(format!("{fallback}：客户端后台进程未返回结果"))
    })
    .await;
    match result {
        Ok(Ok(stdout)) => Ok(stdout),
        Ok(Err(message)) => Err(terminate_command_child(child, message)),
        Err(_) => {
            let message = format!(
                "{fallback}：客户端后台进程超过 {} 秒未完成",
                timeout.as_secs()
            );
            match child.kill() {
                Ok(()) => Err(format!("{message}，已终止")),
                Err(error) => Err(format!("{message}；终止进程树失败：{error}")),
            }
        }
    }
}

pub async fn login(
    app: &AppHandle,
    server_url: &str,
    username: &str,
    password: &str,
    device_name: &str,
    agent_root: &Path,
    force_new: bool,
) -> Result<DesktopLoginSummary, String> {
    let mut args = vec![
        "login".to_string(),
        "--server".to_string(),
        server_url.to_string(),
        "--name".to_string(),
        device_name.to_string(),
    ];
    if force_new {
        args.push("--force-new".to_string());
    }
    let input = serde_json::json!({
        "username": username,
        "password": password,
    })
    .to_string();
    let output = run_json_command(
        app,
        args,
        Some(input),
        agent_root,
        STANDARD_COMMAND_TIMEOUT,
        "登录失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的登录结果".to_string())?;
    let summary: DesktopLoginSummary =
        serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的登录结果".to_string())?;
    if !summary.ok {
        return Err(summary
            .error
            .filter(|message| !message.is_empty())
            .or(summary.code)
            .unwrap_or_else(|| "登录失败".to_string()));
    }
    Ok(summary)
}

pub async fn logout(
    app: &AppHandle,
    server_url: &str,
    session_token: &str,
    agent_root: &Path,
) -> Result<(), String> {
    let input = serde_json::json!({ "sessionToken": session_token }).to_string();
    run_json_command(
        app,
        vec![
            "logout".to_string(),
            "--server".to_string(),
            server_url.to_string(),
        ],
        Some(input),
        agent_root,
        SHORT_COMMAND_TIMEOUT,
        "退出登录失败",
    )
    .await
    .map(|_| ())
}

pub async fn associate(
    app: &AppHandle,
    repo_path: &str,
    branch_name: &str,
    team_id: &str,
    developer_id: &str,
    require_pushed: bool,
    initial_mode: &str,
    agent_root: &Path,
) -> Result<LocalAssociation, String> {
    let mut args = vec![
        "associate".to_string(),
        "--path".to_string(),
        repo_path.to_string(),
        "--branch".to_string(),
        branch_name.to_string(),
        "--team".to_string(),
        team_id.to_string(),
        "--developer".to_string(),
        developer_id.to_string(),
        "--initial-mode".to_string(),
        initial_mode.to_string(),
    ];
    if require_pushed {
        args.push("--require-pushed".to_string());
    }
    let output = run_json_command(
        app,
        args,
        None,
        agent_root,
        GIT_MUTATION_TIMEOUT,
        "本地项目关联失败",
    )
    .await?;
    let line = last_json_line(&output)
        .ok_or_else(|| "sidecar 返回了无效的项目关联结果".to_string())?;
    let summary: AssociationSummary =
        serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的项目关联结果".to_string())?;
    if !summary.ok {
        return Err(summary
            .error
            .filter(|message| !message.is_empty())
            .or(summary.code)
            .unwrap_or_else(|| "本地项目关联失败".to_string()));
    }
    Ok(LocalAssociation {
        project_id: summary
            .project_id
            .ok_or_else(|| "关联结果缺少项目 ID".to_string())?,
        task_space_id: summary
            .task_space_id
            .ok_or_else(|| "关联结果缺少任务空间 ID".to_string())?,
        repo_path: summary
            .repo_path
            .ok_or_else(|| "关联结果缺少本地路径".to_string())?,
        display_name: summary
            .display_name
            .ok_or_else(|| "关联结果缺少仓库名称".to_string())?,
        branch_name: summary
            .branch_name
            .ok_or_else(|| "关联结果缺少同步分支".to_string())?,
        team_id: summary.team_id,
        status: summary
            .status
            .ok_or_else(|| "关联结果缺少状态".to_string())?,
        read_only: summary.read_only.unwrap_or(false),
        live_sync_status: summary
            .live_sync_status
            .filter(|value| !value.is_empty())
            .unwrap_or_else(default_live_sync_status),
        live_sync_error: summary.live_sync_error.filter(|value| !value.is_empty()),
        last_error_code: None,
        last_error: None,
        deferred_count: 0,
        deferred_task_dirs: Vec::new(),
    })
}

pub async fn preflight_project(
    app: &AppHandle,
    repo_path: &str,
    team_id: &str,
    require_pushed: bool,
    agent_root: &Path,
) -> Result<Value, String> {
    let mut args = vec![
        "preflight-project".to_string(),
        "--path".to_string(),
        repo_path.to_string(),
        "--team".to_string(),
        team_id.to_string(),
    ];
    if require_pushed {
        args.push("--require-pushed".to_string());
    }
    let output = run_json_command(
        app,
        args,
        None,
        agent_root,
        GIT_CHECK_TIMEOUT,
        "预检本地项目失败",
    )
    .await?;
    let line =
        last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的项目预检结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的项目预检结果".to_string())
}

pub async fn inspect_project(
    app: &AppHandle,
    repo_path: &str,
    agent_root: &Path,
) -> Result<Value, String> {
    let output = run_json_command(
        app,
        vec![
            "inspect-project".to_string(),
            "--path".to_string(),
            repo_path.to_string(),
        ],
        None,
        agent_root,
        STANDARD_COMMAND_TIMEOUT,
        "检查本地项目失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的项目检查结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的项目检查结果".to_string())
}

pub async fn initialize_project(
    app: &AppHandle,
    repo_path: &str,
    developer_id: &str,
    agent_tools: &[String],
    agent_root: &Path,
) -> Result<Value, String> {
    let output = run_json_command(
        app,
        vec![
            "initialize-project".to_string(),
            "--path".to_string(),
            repo_path.to_string(),
            "--developer".to_string(),
            developer_id.to_string(),
            "--tools".to_string(),
            agent_tools.join(","),
        ],
        None,
        agent_root,
        GIT_MUTATION_TIMEOUT,
        "初始化 Trellis 失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的初始化结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的初始化结果".to_string())
}

pub async fn check_initial_push(
    app: &AppHandle,
    repo_path: &str,
    branch_name: &str,
    agent_root: &Path,
) -> Result<Value, String> {
    let output = run_json_command(
        app,
        vec![
            "check-push".to_string(),
            "--path".to_string(),
            repo_path.to_string(),
            "--branch".to_string(),
            branch_name.to_string(),
        ],
        None,
        agent_root,
        GIT_CHECK_TIMEOUT,
        "检查首次推送失败",
    )
    .await?;
    let line = last_json_line(&output).ok_or_else(|| "sidecar 返回了无效的推送检查结果".to_string())?;
    serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的推送检查结果".to_string())
}

pub async fn list_associations(
    app: &AppHandle,
    agent_root: &Path,
) -> Result<Vec<LocalAssociation>, String> {
    let output = run_json_command(
        app,
        vec!["associations".to_string()],
        None,
        agent_root,
        SHORT_COMMAND_TIMEOUT,
        "无法读取本地项目关联",
    )
    .await?;
    let line = last_json_line(&output)
        .ok_or_else(|| "sidecar 返回了无效的本地关联列表".to_string())?;
    let response: AssociationsResponse =
        serde_json::from_str(line).map_err(|_| "sidecar 返回了无效的本地关联列表".to_string())?;
    if !response.ok {
        return Err(response
            .error
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "无法读取本地项目关联".to_string()));
    }
    Ok(response.associations.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_menu_matches_runtime_state() {
        assert_eq!(
            sync_menu_label(&sync_menu_mode(true, false)),
            ("暂停同步", true)
        );
        assert_eq!(
            sync_menu_label(&sync_menu_mode(false, false)),
            ("恢复同步", true)
        );
        assert_eq!(
            sync_menu_label(&sync_menu_mode(false, true)),
            ("正在强制重启", false)
        );
    }

    #[test]
    fn restart_delay_stops_after_five_retries() {
        assert_eq!(restart_delay(1), Some(Duration::from_secs(1)));
        assert_eq!(restart_delay(5), Some(Duration::from_secs(16)));
        assert_eq!(restart_delay(6), None);
    }

    #[test]
    fn force_restart_is_single_flight() {
        let flag = AtomicBool::new(false);
        assert!(begin_exclusive_restart(&flag));
        assert!(!begin_exclusive_restart(&flag));
    }

    #[test]
    fn force_restart_backs_up_lock_without_deleting_it() {
        let directory = std::env::temp_dir().join(format!(
            "trellis-lock-backup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).expect("创建测试目录");
        let lock_file = directory.join("agent.lock");
        std::fs::write(
            &lock_file,
            "{\"pid\":2000000000,\"token\":\"old\"}\n",
        )
        .expect("写入锁");

        backup_lock_file(&lock_file).expect("备份锁");
        assert!(!lock_file.exists());
        let backup = std::fs::read_dir(&directory)
            .expect("读取测试目录")
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().starts_with("agent.lock.force-restart-"))
            .expect("找到锁备份");
        assert_eq!(
            std::fs::read_to_string(backup.path()).expect("读取锁备份"),
            "{\"pid\":2000000000,\"token\":\"old\"}\n"
        );
        std::fs::remove_dir_all(directory).expect("清理测试目录");
    }

    #[test]
    fn local_association_keeps_old_sidecar_compatibility() {
        let association: LocalAssociation = serde_json::from_value(serde_json::json!({
            "projectId": "project-1",
            "repoPath": "D:\\repo",
            "displayName": "repo",
            "branchName": "main",
            "teamId": "team-1",
            "status": "approved",
            "readOnly": false,
            "lastErrorCode": null,
            "lastError": null
        }))
        .expect("解析旧 sidecar 关联结果");
        assert_eq!(association.live_sync_status, "pending");
        assert_eq!(association.live_sync_error, None);
        assert_eq!(association.deferred_count, 0);
        assert!(association.deferred_task_dirs.is_empty());
    }

    #[test]
    fn expired_control_is_stale() {
        let control = serde_json::json!({
            "type": "assignment_warning",
            "pendingId": "warning-123",
            "expiresAtEpochMs": 100
        });
        assert!(control_is_stale(&control, 100, Path::new("missing")));
    }

    #[test]
    fn missing_pending_file_is_stale() {
        let control = serde_json::json!({
            "type": "assignment_warning",
            "pendingId": "warning-123",
            "expiresAtEpochMs": 200
        });
        assert!(control_is_stale(&control, 100, Path::new("missing")));
    }

    #[test]
    fn current_pending_control_is_kept() {
        let pending_dir = std::env::temp_dir().join(format!(
            "trellis-control-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&pending_dir).expect("创建测试目录");
        std::fs::write(pending_dir.join("warning-123.json"), "{}").expect("写入测试事件");
        let control = serde_json::json!({
            "type": "assignment_warning",
            "pendingId": "warning-123",
            "expiresAtEpochMs": 200
        });
        assert!(!control_is_stale(&control, 100, &pending_dir));
        std::fs::remove_dir_all(pending_dir).expect("清理测试目录");
    }

    #[test]
    fn control_key_is_stable_for_same_assignment_warning() {
        let first = serde_json::json!({
            "type": "assignment_warning",
            "pendingId": "warning-old",
            "projectId": "project-1",
            "task": { "taskKey": "project-1::.trellis/tasks/task-1" },
            "assignee": { "userId": "user-1" }
        });
        let second = serde_json::json!({
            "type": "assignment_warning",
            "pendingId": "warning-new",
            "projectId": "project-1",
            "task": { "taskKey": "project-1::.trellis/tasks/task-1" },
            "assignee": { "userId": "user-1" }
        });
        assert_eq!(control_key(&first), control_key(&second));
    }

    #[test]
    fn control_key_uses_review_revision_and_conflict_id() {
        let review = serde_json::json!({
            "type": "initial_sync_review",
            "taskSpaceId": "space-1",
            "revision": 4
        });
        let conflict = serde_json::json!({
            "type": "task_file_conflict",
            "taskSpaceId": "space-1",
            "conflict": { "conflictId": "conflict-1" }
        });
        assert_eq!(
            control_key(&review),
            format!("initial_sync_review\0space-1\0{}", 4)
        );
        assert_eq!(
            control_key(&conflict),
            "task_file_conflict\0space-1\0conflict-1"
        );
    }

    #[test]
    fn control_envelope_accepts_only_typed_control_events() {
        let control = serde_json::json!({
            "type": "task_sync_error",
            "taskSpaceId": "space-1",
            "message": "同步暂时失败"
        });
        assert_eq!(
            control_from_line(&serde_json::json!({ "control": control }).to_string()),
            Some(control)
        );
        assert_eq!(
            control_from_line(r#"{"type":"trellis-control","taskSpaceId":"space-1"}"#),
            None
        );
        assert_eq!(control_from_line(r#"{"ok":true,"protocolVersion":3}"#), None);
        assert_eq!(control_from_line(r#"{"control":null}"#), None);
        assert_eq!(
            control_from_line(r#"{"control":{"message":"普通日志"}}"#),
            None
        );
    }

    #[test]
    fn control_envelope_preserves_review_conflict_and_error_fields() {
        let events = [
            serde_json::json!({
                "type": "initial_sync_review",
                "taskSpaceId": "space-1",
                "revision": 4,
                "differences": [{ "type": "content-conflict", "taskId": "task-1" }]
            }),
            serde_json::json!({
                "type": "task_file_conflict",
                "taskSpaceId": "space-1",
                "conflict": {
                    "conflictId": "conflict-1",
                    "message": "任务文件已被修改"
                }
            }),
            serde_json::json!({
                "type": "task_sync_error",
                "taskSpaceId": "space-1",
                "message": "同步暂时失败"
            }),
        ];
        for event in events {
            let line = serde_json::json!({ "control": event.clone() }).to_string();
            assert_eq!(control_from_line(&line), Some(event));
        }
    }

    #[test]
    fn duplicate_control_replaces_pending_item_in_place() {
        let mut pending = VecDeque::new();
        enqueue_control(
            &mut pending,
            serde_json::json!({
                "type": "assignment_warning",
                "pendingId": "warning-old",
                "projectId": "project-1",
                "task": { "taskKey": "task-1" },
                "assignee": { "username": "owner" }
            }),
        );
        enqueue_control(
            &mut pending,
            serde_json::json!({
                "type": "assignment_warning",
                "pendingId": "warning-new",
                "projectId": "project-1",
                "task": { "taskKey": "task-1" },
                "assignee": { "username": "owner" }
            }),
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending.front().and_then(|item| item.get("pendingId")),
            Some(&Value::String("warning-new".to_string()))
        );
    }
}
