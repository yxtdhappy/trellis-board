#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// AgentError 携带服务端错误细节（code/message/details），按值传递比封箱更清晰；
// 所有命令层都用 `?` 立即转换，不构成实测热点。
#![allow(clippy::result_large_err)]

mod agent;
mod agent_service;
mod appearance;
mod config;
mod logging;
mod navigation;
mod runtime_commands;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use cookie::{Cookie, SameSite};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const SESSION_COOKIE: &str = "trellis_team_session";
// 与 packages/shared/trellis-agent-tools.js 当前目录数量保持一致。
const MAX_AGENT_TOOLS: usize = 22;

#[derive(Clone, Default)]
struct DesktopAuthState {
    board_url: Arc<RwLock<Option<Url>>>,
    session_token: Arc<Mutex<Option<String>>>,
    local_url: Arc<Mutex<Option<Url>>>,
    pending_project_path: Arc<Mutex<Option<PathBuf>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    version: String,
    server_url: Option<String>,
    username: Option<String>,
    password: Option<String>,
    config_path: String,
    logs_dir: String,
    sidecar_running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopLoginResult {
    server_url: String,
    username: String,
    must_change_password: bool,
    device_ready: bool,
}

fn ensure_local_caller(window: &WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|error| format!("无法确认调用页面来源：{error}"))?;
    if navigation::is_local_page(&url) || navigation::is_dev_page(window.app_handle(), &url) {
        Ok(())
    } else {
        Err("该命令仅允许本地登录页调用".to_string())
    }
}

fn ensure_board_caller(app: &AppHandle, window: &WebviewWindow) -> Result<Url, String> {
    let current = window
        .url()
        .map_err(|error| format!("无法确认 Board 页面来源：{error}"))?;
    let state = app.state::<DesktopAuthState>();
    let board = state
        .board_url
        .read()
        .map_err(|_| "无法读取 Board 地址".to_string())?
        .clone()
        .ok_or_else(|| "尚未登录 Board".to_string())?;
    if navigation::same_origin(&current, &board) {
        Ok(board)
    } else {
        Err("该命令只允许当前登录的 Board 页面调用".to_string())
    }
}

fn validate_username(value: &str) -> Result<String, String> {
    let username = value.trim().to_ascii_lowercase();
    let valid = (3..=64).contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if valid {
        Ok(username)
    } else {
        Err("登录名必须是 3 到 64 位 ASCII 字母、数字、点、下划线或中划线".to_string())
    }
}

fn validate_password(value: &str) -> Result<(), String> {
    if value.chars().count() < 6 {
        return Err("密码至少需要 6 个字符".to_string());
    }
    if value.len() > 1024 {
        return Err("密码不能超过 1024 字节".to_string());
    }
    Ok(())
}

fn validate_session_token(value: &str) -> Result<String, String> {
    let token = value.trim();
    if !(16..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Board 登录响应包含无效会话令牌".to_string());
    }
    Ok(token.to_string())
}

fn validate_developer_id(value: &str) -> Result<String, String> {
    let developer_id = value.trim().to_string();
    if developer_id.is_empty() || developer_id.chars().count() > 120 {
        return Err("请填写有效的 Trellis developer ID".to_string());
    }
    Ok(developer_id)
}

fn validate_agent_tools(agent_tools: &[String]) -> Result<Vec<String>, String> {
    if agent_tools.is_empty() || agent_tools.len() > MAX_AGENT_TOOLS {
        return Err(format!(
            "请至少选择一个、且不超过 {MAX_AGENT_TOOLS} 个编码 Agent 工具"
        ));
    }
    let agent_tools = agent_tools
        .iter()
        .map(|tool| tool.trim().to_string())
        .collect::<Vec<_>>();
    if agent_tools.iter().any(|tool| {
        tool.is_empty()
            || tool.len() > 40
            || !tool
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err("编码 Agent 工具列表格式无效".to_string());
    }
    Ok(agent_tools)
}

fn approved_association_for_task_space<'a>(
    associations: &'a [agent_service::LocalAssociation],
    task_space_id: &str,
) -> Result<&'a agent_service::LocalAssociation, String> {
    associations
        .iter()
        .find(|association| {
            association.task_space_id == task_space_id && association.status == "approved"
        })
        .ok_or_else(|| "请先关联本地 Git 项目，并确认关联状态为 approved".to_string())
}

fn validate_project_id(value: String) -> Result<String, String> {
    let project_id = value.trim().to_string();
    let valid = (1..=128).contains(&project_id.len())
        && project_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        });
    if valid {
        Ok(project_id)
    } else {
        Err("项目 ID 格式无效".to_string())
    }
}

fn server_root(board: &Url) -> String {
    let host = board.host_str().unwrap_or_default();
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    format!(
        "{}://{}{}",
        board.scheme(),
        host,
        board
            .port()
            .map(|port| format!(":{port}"))
            .unwrap_or_default()
    )
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= 80)
        .unwrap_or_else(|| "Windows 桌面".to_string())
}

fn initial_server_url() -> Option<String> {
    config::server_url_from_args()
        .or_else(|| std::env::var("TRELLIS_DESKTOP_SERVER_URL").ok())
        .or_else(|| config::load().ok().flatten().map(|value| value.server_url))
}

fn cookie_for(board: &Url, value: &str) -> Result<Cookie<'static>, String> {
    let host = board
        .host_str()
        .ok_or_else(|| "Board 地址缺少主机".to_string())?
        .to_string();
    Ok(Cookie::build((SESSION_COOKIE, value.to_string()))
        .domain(host)
        .path("/")
        .http_only(true)
        .same_site(SameSite::Strict)
        .secure(board.scheme() == "https")
        .build())
}

fn write_session_cookie(window: &WebviewWindow, board: &Url, token: &str) -> Result<(), String> {
    if token.is_empty() || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("无法校准 Board 会话 Cookie".to_string());
    }
    window
        .set_cookie(cookie_for(board, token)?)
        .map_err(|error| format!("无法写入 Board 会话 Cookie：{error}"))
}

fn delete_session_cookie(window: &WebviewWindow, board: &Url) -> Result<(), String> {
    window
        .delete_cookie(cookie_for(board, "")?)
        .map_err(|error| format!("无法删除 Board 会话 Cookie：{error}"))
}

fn navigate_local_login(app: &AppHandle, state: &DesktopAuthState) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let url = state.local_url.lock().ok().and_then(|value| value.clone());
    if let Some(url) = url {
        let _ = window.navigate(url);
    }
}

fn forget_saved_password() {
    let mut config = match config::load() {
        Ok(Some(config)) => config,
        Ok(None) => return,
        Err(error) => {
            logging::warn(&format!("退出登录时读取本地配置失败：{error}"));
            return;
        }
    };
    if config.password.take().is_none() {
        return;
    }
    if let Err(error) = config::save(&config) {
        logging::warn(&format!("退出登录时清除已保存密码失败：{error}"));
    }
}

async fn clear_desktop_session(app: &AppHandle, state: &DesktopAuthState, revoke_session: bool) {
    agent_service::stop(app);
    let board = state.board_url.read().ok().and_then(|value| value.clone());
    let token = state
        .session_token
        .lock()
        .ok()
        .and_then(|mut value| value.take());
    if let (Some(window), Some(board)) = (app.get_webview_window("main"), board.as_ref()) {
        let _ = delete_session_cookie(&window, board);
    }
    if let Ok(mut value) = state.board_url.write() {
        *value = None;
    }
    forget_saved_password();
    navigate_local_login(app, state);
    if revoke_session {
        if let (Some(board), Some(token)) = (board.as_ref(), token.as_deref()) {
            let _ = agent_service::logout(app, &server_root(board), token).await;
        }
    }
}

#[tauri::command]
async fn desktop_logout(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_board_caller(&app, &window)?;
    let auth = app.state::<DesktopAuthState>().inner().clone();
    clear_desktop_session(&app, &auth, true).await;
    Ok(())
}

/// 只读、无敏感数据：客户端自带页面（登录页/控制窗口）也要跟随设备偏好。
#[tauri::command]
fn appearance_load() -> appearance::Appearance {
    appearance::load()
}

#[tauri::command]
fn appearance_save(
    app: AppHandle,
    window: WebviewWindow,
    theme: String,
    font_size: String,
) -> Result<(), String> {
    ensure_board_caller(&app, &window)?;
    appearance::save(&appearance::Appearance { theme, font_size })
}

#[tauri::command]
async fn app_status(app: AppHandle, window: WebviewWindow) -> Result<AppStatus, String> {
    ensure_local_caller(&window)?;
    let config = config::load()?;
    Ok(AppStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        server_url: config
            .as_ref()
            .map(|value| value.server_url.clone())
            .or_else(initial_server_url),
        username: config.as_ref().and_then(|value| value.username.clone()),
        password: config.as_ref().and_then(|value| value.password.clone()),
        config_path: config::config_path().display().to_string(),
        logs_dir: config::logs_dir().display().to_string(),
        sidecar_running: agent_service::is_running(&app),
    })
}

#[tauri::command]
async fn runtime_status(window: WebviewWindow) -> Result<agent::env::RuntimeStatus, String> {
    ensure_local_caller(&window)?;
    runtime_commands::runtime_status().await
}

#[tauri::command]
async fn runtime_install(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<agent::env::RuntimeInstallResult, String> {
    ensure_local_caller(&window)?;
    runtime_commands::runtime_install(app).await
}

#[tauri::command]
async fn desktop_login(
    app: AppHandle,
    window: WebviewWindow,
    server_url: String,
    username: String,
    password: String,
) -> Result<DesktopLoginResult, String> {
    ensure_local_caller(&window)?;
    let board = navigation::validate_board_url(&server_url)?;
    let remembered_username = username.trim().to_string();
    let username = validate_username(&remembered_username)?;
    validate_password(&password)?;
    // 登录页出现时旧会话已结束，先停止旧账号的后台同步，成功后再按新配置重启。
    agent_service::stop(&app);
    let server_url = server_root(&board);
    let previous = config::load().unwrap_or(None);
    let force_new = previous
        .as_ref()
        .map(|value| value.server_url != server_url)
        .unwrap_or(true);
    let device_name = default_device_name();
    let summary = agent_service::login(
        &app,
        &server_url,
        &username,
        &password,
        &device_name,
        force_new,
    )
    .await?;
    let token = validate_session_token(
        summary
            .session_token
            .as_deref()
            .ok_or_else(|| "登录结果缺少会话令牌".to_string())?,
    )?;
    if let Err(error) = write_session_cookie(&window, &board, &token) {
        let _ = agent_service::logout(&app, &server_url, &token).await;
        return Err(error);
    }
    let previous_config = config::load().ok().flatten();
    if let Err(error) = config::save(&config::ClientConfig {
        schema_version: config::SCHEMA_VERSION,
        server_url: server_url.clone(),
        username: Some(remembered_username),
        password: Some(password),
        node_runtime: previous_config
            .as_ref()
            .and_then(|value| value.node_runtime.clone()),
        trellis_runtime: previous_config
            .as_ref()
            .and_then(|value| value.trellis_runtime.clone()),
    }) {
        let _ = delete_session_cookie(&window, &board);
        let _ = agent_service::logout(&app, &server_url, &token).await;
        return Err(error);
    }
    let state = app.state::<DesktopAuthState>();
    let auth = state.inner().clone();
    *state
        .board_url
        .write()
        .map_err(|_| "无法保存 Board 地址".to_string())? = Some(board.clone());
    *state
        .session_token
        .lock()
        .map_err(|_| "无法保存登录会话".to_string())? = Some(token);
    let device_ready = summary.device_ready == Some(true);
    if device_ready {
        agent_service::restart(&app);
    } else {
        logging::warn(&format!(
            "设备未就绪，跳过后台同步启动（mustChangePassword={}）",
            summary.must_change_password == Some(true)
        ));
        agent_service::stop(&app);
    }
    if let Err(error) = window.navigate(board) {
        clear_desktop_session(&app, &auth, true).await;
        return Err(format!("无法打开 Board：{error}"));
    }
    Ok(DesktopLoginResult {
        server_url,
        username: summary.username.unwrap_or(username),
        must_change_password: summary.must_change_password == Some(true),
        device_ready,
    })
}

#[tauri::command]
async fn pick_local_project_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    ensure_board_caller(&app, &window)?;
    *app.state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法清除旧的待接入项目路径".to_string())? = None;
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(path) = folder else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| format!("无法读取所选目录：{error}"))?;
    if !path.is_dir() {
        return Err("所选路径不是目录，请重新选择项目根目录".to_string());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn inspect_local_project(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let path = PathBuf::from(path.trim());
    if !path.is_dir() {
        return Err("所选路径不是目录，请重新选择项目根目录".to_string());
    }
    *app.state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法清除旧的待接入项目路径".to_string())? = None;
    let inspected = agent_service::inspect_project(&app, &path.to_string_lossy()).await?;
    let state = app.state::<DesktopAuthState>();
    *state
        .pending_project_path
        .lock()
        .map_err(|_| "无法保存待接入项目路径".to_string())? = Some(path);
    Ok(inspected)
}

#[tauri::command]
async fn initialize_pending_project(
    app: AppHandle,
    window: WebviewWindow,
    developer_id: String,
    agent_tools: Vec<String>,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let developer_id = validate_developer_id(&developer_id)?;
    let agent_tools = validate_agent_tools(&agent_tools)?;
    let path = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    agent_service::initialize_project(&app, &path.to_string_lossy(), &developer_id, &agent_tools)
        .await
}

#[tauri::command]
async fn check_pending_project_push(
    app: AppHandle,
    window: WebviewWindow,
    branch_name: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let path = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    agent_service::check_initial_push(&app, &path.to_string_lossy(), branch_name.trim()).await
}

#[tauri::command]
async fn preflight_pending_project(
    app: AppHandle,
    window: WebviewWindow,
    team_id: String,
    developer_id: String,
    require_pushed: bool,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let team_id = validate_project_id(team_id)?;
    validate_developer_id(&developer_id)?;
    let path = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    agent_service::preflight_project(&app, &path.to_string_lossy(), &team_id, require_pushed).await
}

#[tauri::command]
async fn cancel_pending_project(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_board_caller(&app, &window)?;
    *app.state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法清除待接入项目路径".to_string())? = None;
    Ok(())
}

#[tauri::command]
async fn associate_pending_project(
    app: AppHandle,
    window: WebviewWindow,
    team_id: String,
    developer_id: String,
    require_pushed: bool,
    initial_mode: String,
) -> Result<agent_service::LocalAssociation, String> {
    ensure_board_caller(&app, &window)?;
    let team_id = validate_project_id(team_id)?;
    let developer_id = validate_developer_id(&developer_id)?;
    if !matches!(initial_mode.as_str(), "bootstrap" | "safe" | "review") {
        return Err("首次同步处理方式无效".to_string());
    }
    let inspected = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    let check = agent_service::inspect_project(&app, &inspected.to_string_lossy()).await?;
    let branch_name = check
        .pointer("/project/branchName")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "无法确认本地项目分支".to_string())?
        .to_string();
    let association = agent_service::associate(
        &app,
        &inspected.to_string_lossy(),
        &branch_name,
        &team_id,
        &developer_id,
        require_pushed,
        &initial_mode,
    )
    .await?;
    *app.state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法清除待接入项目路径".to_string())? = None;
    agent_service::restart(&app);
    Ok(association)
}

#[tauri::command]
async fn list_local_associations(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<agent_service::LocalAssociation>, String> {
    ensure_board_caller(&app, &window)?;
    agent_service::list_associations(&app).await
}

#[tauri::command]
async fn detach_local_association(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let associations = agent_service::list_associations(&app).await?;
    approved_association_for_task_space(&associations, &task_space_id)?;
    agent_service::detach_local_association(&app, &task_space_id).await
}

#[tauri::command]
async fn inspect_associated_project_agents(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let associations = agent_service::list_associations(&app).await?;
    let repo_path = approved_association_for_task_space(&associations, &task_space_id)?
        .repo_path
        .clone();
    agent_service::inspect_project(&app, &repo_path).await
}

#[tauri::command]
async fn initialize_associated_project_agents(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    developer_id: String,
    agent_tools: Vec<String>,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let developer_id = validate_developer_id(&developer_id)?;
    let agent_tools = validate_agent_tools(&agent_tools)?;
    let associations = agent_service::list_associations(&app).await?;
    let repo_path = approved_association_for_task_space(&associations, &task_space_id)?
        .repo_path
        .clone();
    agent_service::initialize_project(&app, &repo_path, &developer_id, &agent_tools).await
}

#[tauri::command]
async fn sync_deferred_tasks(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    agent_service::sync_deferred_tasks(&app, &task_space_id).await
}

#[tauri::command]
async fn list_task_ownership(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    agent_service::list_task_ownership(&app, &task_space_id).await
}

#[tauri::command]
async fn set_task_ownership(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    decisions: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if window.label() == "live-control" {
        ensure_local_caller(&window)?;
    } else {
        ensure_board_caller(&app, &window)?;
    }
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let count = decisions
        .as_array()
        .map(Vec::len)
        .ok_or_else(|| "任务归属决定必须是数组".to_string())?;
    if !(1..=200).contains(&count) {
        return Err("任务归属决定必须包含 1 到 200 个任务".to_string());
    }
    let result = agent_service::set_task_ownership(&app, &task_space_id, decisions).await?;
    agent_service::clear_control(&app);
    Ok(result)
}

#[tauri::command]
async fn desktop_sidecar_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<agent_service::SidecarStatus, String> {
    ensure_board_caller(&app, &window)?;
    Ok(agent_service::status(&app))
}

#[tauri::command]
async fn live_control_pending(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    ensure_local_caller(&window)?;
    Ok(agent_service::pending_control(&app))
}

#[tauri::command]
async fn live_control_show(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    ensure_local_caller(&window)?;
    Ok(agent_service::show_pending_control(&app))
}

#[tauri::command]
async fn live_control_decide(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    conflict_id: String,
    action: String,
) -> Result<(), String> {
    ensure_local_caller(&window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let conflict_id = validate_live_id(&conflict_id, "冲突 ID")?;
    if !matches!(
        action.as_str(),
        "use-server" | "overwrite-server" | "save-local-copy"
    ) {
        return Err("实时同步确认动作无效".to_string());
    }
    agent_service::decide_live_change(&app, &task_space_id, &conflict_id, &action).await?;
    agent_service::clear_control(&app);
    Ok(())
}

#[tauri::command]
async fn live_control_diff(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    conflict_id: String,
) -> Result<serde_json::Value, String> {
    ensure_local_caller(&window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let conflict_id = validate_live_id(&conflict_id, "冲突 ID")?;
    agent_service::live_conflict_details(&app, &task_space_id, &conflict_id).await
}

#[tauri::command]
async fn live_control_initial(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    mode: String,
    decisions: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    ensure_local_caller(&window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    if !matches!(mode.as_str(), "safe" | "review") {
        return Err("首次同步处理方式无效".to_string());
    }
    let result =
        agent_service::resolve_initial_sync(&app, &task_space_id, &mode, decisions).await?;
    agent_service::clear_control(&app);
    Ok(result)
}

#[tauri::command]
async fn live_control_dismiss(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_local_caller(&window)?;
    agent_service::dismiss_control(&app)
}

#[tauri::command]
async fn live_control_resize(window: WebviewWindow, height: f64) -> Result<(), String> {
    ensure_local_caller(&window)?;
    agent_service::resize_control(&window, height)
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn validate_live_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if !(8..=128).contains(&value.len())
        || !value
            .as_bytes()
            .first()
            .map(|byte| byte.is_ascii_alphanumeric())
            .unwrap_or(false)
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-'))
    {
        return Err(format!("{label}格式无效"));
    }
    Ok(value.to_string())
}

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let live_control = MenuItem::with_id(app, "review-live", "处理实时确认", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "恢复同步", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "打开日志目录", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启",
        true,
        autostart_enabled(app),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &live_control, &sync, &logs, &autostart, &quit],
    )?;
    let Some(icon) = app.default_window_icon().cloned() else {
        logging::warn("客户端缺少窗口图标，托盘不可用");
        return Ok(());
    };
    TrayIconBuilder::with_id("main")
        .tooltip("Trellis Board")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => focus_main_window(app),
            "review-live" => {
                agent_service::show_pending_control(app);
            }
            "pause" => agent_service::toggle_pause(app),
            "sync" => agent_service::sync_action(app),
            "logs" => {
                let directory = config::logs_dir();
                let _ = std::fs::create_dir_all(&directory);
                let _ = app
                    .opener()
                    .open_path(directory.to_string_lossy(), None::<&str>);
            }
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if let Err(error) = result {
                    logging::warn(&format!("无法切换开机自启：{error}"));
                }
            }
            "quit" => {
                agent_service::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    agent_service::set_sync_menu_item(app, sync);
    Ok(())
}

fn build_main_window(
    app: &AppHandle,
    minimized: bool,
    auth: DesktopAuthState,
) -> tauri::Result<()> {
    let navigation_auth = auth.clone();
    let shell_app = app.clone();
    let load_app = app.clone();
    let builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App(PathBuf::from("index.html")))
            .title("Trellis Board")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 640.0)
            .visible(!minimized)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_navigation(move |candidate| {
                let state = shell_app.state::<DesktopAuthState>();
                let board = state.board_url.read().ok().and_then(|value| value.clone());
                if let Some(board) = board.as_ref() {
                    if navigation::same_origin(candidate, board)
                        && matches!(candidate.path(), "/login" | "/login.html")
                    {
                        let app = shell_app.clone();
                        let auth = state.inner().clone();
                        tauri::async_runtime::spawn(async move {
                            clear_desktop_session(&app, &auth, true).await;
                        });
                        return false;
                    }
                }
                navigation::handle_navigation(&shell_app, candidate, board.as_ref())
            })
            .on_page_load(move |_, payload| {
                if payload.event() == PageLoadEvent::Started
                    && payload.url().scheme() != "about"
                    && (navigation::is_local_page(payload.url())
                        || navigation::is_dev_page(&load_app, payload.url()))
                {
                    if let Ok(mut local_url) = navigation_auth.local_url.lock() {
                        *local_url = Some(payload.url().clone());
                    }
                }
            });
    builder.build()?;
    Ok(())
}

fn main() {
    let minimized = config::minimized_from_args();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[agent_service::CONTROL_WINDOW])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_status,
            desktop_logout,
            desktop_login,
            appearance_load,
            appearance_save,
            pick_local_project_folder,
            inspect_local_project,
            initialize_pending_project,
            check_pending_project_push,
            preflight_pending_project,
            cancel_pending_project,
            associate_pending_project,
            list_local_associations,
            detach_local_association,
            inspect_associated_project_agents,
            initialize_associated_project_agents,
            sync_deferred_tasks,
            list_task_ownership,
            set_task_ownership,
            desktop_sidecar_status,
            runtime_status,
            runtime_install,
            live_control_pending,
            live_control_show,
            live_control_decide,
            live_control_diff,
            live_control_initial,
            live_control_dismiss,
            live_control_resize
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = config::ensure_directories();
            logging::init(&config::logs_dir());
            agent_service::register(&handle);
            let auth = DesktopAuthState::default();
            app.manage(auth.clone());
            build_tray(&handle)?;
            build_main_window(&handle, minimized, auth)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "live-control" {
                    agent_service::close_control_window(window.app_handle());
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Trellis Board desktop client")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                agent_service::shutdown(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn association(task_space_id: &str, status: &str) -> agent_service::LocalAssociation {
        agent_service::LocalAssociation {
            project_id: "project-1".to_string(),
            task_space_id: task_space_id.to_string(),
            repo_path: format!("C:/work/{task_space_id}"),
            display_name: "repo".to_string(),
            branch_name: "main".to_string(),
            team_id: Some("team-1".to_string()),
            status: status.to_string(),
            detach_pending: false,
            initial_review_pending: false,
            read_only: false,
            live_sync_status: "idle".to_string(),
            live_sync_error: None,
            deferred_count: 0,
            deferred_task_dirs: Vec::new(),
            last_error_code: None,
            last_error: None,
            ownership_paused_count: 0,
            ownership_paused_task_dirs: Vec::new(),
            ownership_pending_count: 0,
            ownership_pending_task_dirs: Vec::new(),
        }
    }

    #[test]
    fn approved_association_requires_approved_status() {
        let associations = vec![
            association("space-1", "pending"),
            association("space-1", "approved"),
            association("space-2", "revoked"),
        ];
        let selected = approved_association_for_task_space(&associations, "space-1").unwrap();
        assert_eq!(selected.repo_path, "C:/work/space-1");
    }

    #[test]
    fn approved_association_rejects_missing_or_unapproved() {
        let associations = vec![
            association("space-1", "pending"),
            association("space-2", "revoked"),
        ];
        for task_space_id in ["space-1", "space-2", "space-3"] {
            assert!(approved_association_for_task_space(&associations, task_space_id).is_err());
        }
    }

    #[test]
    fn agent_tool_validation_caps_catalog_size() {
        let tools = (0..MAX_AGENT_TOOLS)
            .map(|index| format!("agent-{index}"))
            .collect::<Vec<_>>();
        assert_eq!(validate_agent_tools(&tools).unwrap().len(), MAX_AGENT_TOOLS);
        let too_many = (0..=MAX_AGENT_TOOLS)
            .map(|index| format!("agent-{index}"))
            .collect::<Vec<_>>();
        assert!(validate_agent_tools(&too_many).is_err());
        assert!(validate_agent_tools(&[]).is_err());
        assert!(validate_agent_tools(&["Claude Code".to_string()]).is_err());
    }
}
