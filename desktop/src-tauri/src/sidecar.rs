use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const MAX_RESTARTS: u32 = 5;
const STABLE_RUN: Duration = Duration::from_secs(60);
const SIDECAR_NAME: &str = "trellis-agent";

#[derive(Default)]
pub struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    paused: AtomicBool,
    quitting: AtomicBool,
    running: AtomicBool,
    restarts: AtomicU32,
    last_start: Mutex<Option<Instant>>,
}

#[derive(Debug, Deserialize)]
pub struct EnrollSummary {
    pub ok: bool,
    #[serde(rename = "agentId")]
    pub agent_id: Option<String>,
    pub error: Option<String>,
}

pub fn register(app: &AppHandle) {
    app.manage(SidecarState::default());
}

pub fn is_running(app: &AppHandle) -> bool {
    let state = app.state::<SidecarState>();
    state.running.load(Ordering::SeqCst) && state.child.lock().map(|guard| guard.is_some()).unwrap_or(false)
}

pub fn start(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    if state.quitting.load(Ordering::SeqCst) || state.paused.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut guard) = state.child.lock() else {
        return;
    };
    if guard.is_some() {
        return;
    }
    if !crate::config::config_path().exists() {
        return;
    }
    let agent_root = crate::config::agent_root();
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
            if let Ok(mut started) = state.last_start.lock() {
                *started = Some(Instant::now());
            }
            state.running.store(true, Ordering::SeqCst);
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = receiver.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            crate::logging::line(&String::from_utf8_lossy(&line));
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
                            on_exit(&handle);
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

fn on_exit(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    state.running.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        *guard = None;
    }
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
    state.running.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
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

/// 运行 sidecar 的 `enroll` 子命令：配对码只经 stdin 传递，不进入命令行或日志。
pub async fn enroll(
    app: &AppHandle,
    server_url: &str,
    pairing_code: &str,
    device_name: &str,
    agent_root: &Path,
) -> Result<String, String> {
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("sidecar 未随安装包提供：{error}"))?
        .args(["enroll", "--server", server_url, "--name", device_name])
        .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string());
    let (mut receiver, child) = command
        .spawn()
        .map_err(|error| format!("无法启动设备注册进程：{error}"))?;
    child
        .write(format!("{pairing_code}\n").as_bytes())
        .map_err(|error| format!("无法写入配对码：{error}"))?;
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
                    let message = crate::logging::redact(stderr.trim());
                    return Err(if message.is_empty() {
                        "设备注册失败".to_string()
                    } else {
                        message
                    });
                }
                break;
            }
            CommandEvent::Error(error) => {
                return Err(format!("设备注册进程错误：{error}"));
            }
            _ => {}
        }
    }
    Ok(stdout)
}

/// 运行 sidecar 的 `workspace-init` 子命令；初始化逻辑与备份/回滚都在 Node 侧。
pub async fn workspace_init(
    app: &AppHandle,
    workspace_path: &str,
    tools: Option<Vec<String>>,
    agent_root: &Path,
) -> Result<String, String> {
    let mut args = vec![
        "workspace-init".to_string(),
        "--path".to_string(),
        workspace_path.to_string(),
    ];
    if let Some(tools) = tools.filter(|items| !items.is_empty()) {
        args.push("--tools".to_string());
        args.push(tools.join(","));
    }
    let command = app
        .shell()
        .sidecar(SIDECAR_NAME)
        .map_err(|error| format!("sidecar 未随安装包提供：{error}"))?
        .args(args)
        .env("TRELLIS_AGENT_ROOT", agent_root.to_string_lossy().to_string());
    let (mut receiver, _child) = command
        .spawn()
        .map_err(|error| format!("无法启动 workspace 初始化进程：{error}"))?;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = None;
    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                stdout.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Stderr(line) => {
                stderr.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
                break;
            }
            CommandEvent::Error(error) => {
                return Err(format!("workspace 初始化进程错误：{error}"));
            }
            _ => {}
        }
    }
    if exit_code != Some(0)
        && !stdout.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line.trim()).is_ok()
        })
    {
        let message = crate::logging::redact(stderr.trim());
        return Err(if message.is_empty() {
            "workspace 初始化失败".to_string()
        } else {
            message
        });
    }
    Ok(stdout)
}
