use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_RESTARTS: u32 = 5;
const STABLE_RUN: Duration = Duration::from_secs(60);
const SIDECAR_NAME: &str = "trellis-agent";

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
    last_start: Mutex<Option<Instant>>,
    pending_control: Mutex<VecDeque<Value>>,
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
            .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string()),
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
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = receiver.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            let trimmed = text.trim();
                            let control = serde_json::from_str::<Value>(trimmed)
                                .ok()
                                .and_then(|value| value.get("control").cloned());
                            if let Some(control) = control {
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
    if let Ok(mut pending) = state.pending_control.lock() {
        if !pending.iter().any(|item| item == &control) {
            if pending.len() >= 32 {
                pending.pop_front();
            }
            pending.push_back(control);
        }
    }
    show_control(app);
}

fn show_control(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("live-control") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(
        app,
        "live-control",
        WebviewUrl::App("control.html".into())
    )
    .title("Trellis Board 实时同步确认")
    .inner_size(560.0, 420.0)
    .min_inner_size(480.0, 360.0)
    .build();
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
    if has_more {
        show_control(app);
    } else if let Some(window) = app.get_webview_window("live-control") {
        let _ = window.hide();
    }
    has_more
}

pub fn clear_control(app: &AppHandle) {
    pop_control(app);
}

pub fn dismiss_control(app: &AppHandle) -> Result<(), String> {
    let control = pending_control(app).ok_or_else(|| "当前没有待处理事件".to_string())?;
    if control.get("type").and_then(Value::as_str) == Some("assignment_warning") {
        return Err("责任人确认必须选择取消、继续推进或接管任务".to_string());
    }
    pop_control(app);
    Ok(())
}

pub async fn decide_live_change(
    app: &AppHandle,
    pending_id: &str,
    action: &str,
    agent_root: &Path,
) -> Result<(), String> {
    run_json_command(
        app,
        vec![
            "live-decide".to_string(),
            "--pending".to_string(),
            pending_id.to_string(),
            "--action".to_string(),
            action.to_string(),
        ],
        None,
        agent_root,
        "提交实时同步确认失败",
    )
    .await
    .map(|_| ())
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
        "恢复实时同步备份失败",
    )
    .await
    .map(|_| ())
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
    if state.quitting.load(Ordering::SeqCst) || state.paused.load(Ordering::SeqCst) {
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
    }
    let attempt = state.restarts.fetch_add(1, Ordering::SeqCst) + 1;
    if attempt > MAX_RESTARTS {
        crate::logging::warn("sidecar 连续崩溃，已停止自动重启；请从托盘恢复同步");
        return;
    }
    let delay = 1u64 << (attempt - 1).min(4);
    crate::logging::warn(&format!("sidecar 将在 {delay} 秒后重启（第 {attempt} 次）"));
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(delay));
        start(&handle);
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
    };
}

pub fn toggle_pause(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let paused = !state.paused.load(Ordering::SeqCst);
    state.paused.store(paused, Ordering::SeqCst);
    if paused {
        stop(app);
        crate::logging::warn("已暂停后台同步");
    } else {
        state.restarts.store(0, Ordering::SeqCst);
        crate::logging::warn("已恢复后台同步");
        start(app);
    }
}

pub fn restart(app: &AppHandle) {
    stop(app);
    let state = app.state::<SidecarState>();
    state.paused.store(false, Ordering::SeqCst);
    state.restarts.store(0, Ordering::SeqCst);
    start(app);
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.quitting.store(true, Ordering::SeqCst);
    stop(app);
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

async fn run_json_command(
    app: &AppHandle,
    args: Vec<String>,
    stdin: Option<String>,
    agent_root: &Path,
    fallback: &str,
) -> Result<String, String> {
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("sidecar 未随安装包提供：{error}"))?
        .args(args)
        .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string());
    let (mut receiver, mut child) = command
        .spawn()
        .map_err(|error| format!("无法启动客户端后台进程：{error}"))?;
    if let Some(payload) = stdin {
        child
            .write(format!("{payload}\n").as_bytes())
            .map_err(|error| format!("无法写入客户端后台输入：{error}"))?;
    }
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
                break;
            }
            CommandEvent::Error(error) => {
                return Err(format!("客户端后台进程错误：{error}"));
            }
            _ => {}
        }
    }
    Ok(stdout)
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
    let output = run_json_command(app, args, Some(input), agent_root, "登录失败").await?;
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
        "退出登录失败",
    )
    .await
    .map(|_| ())
}

pub async fn associate(
    app: &AppHandle,
    project_id: &str,
    repo_path: &str,
    branch_name: &str,
    agent_root: &Path,
) -> Result<LocalAssociation, String> {
    let output = run_json_command(
        app,
        vec![
            "associate".to_string(),
            "--project".to_string(),
            project_id.to_string(),
            "--path".to_string(),
            repo_path.to_string(),
            "--branch".to_string(),
            branch_name.to_string(),
        ],
        None,
        agent_root,
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
    })
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
}
