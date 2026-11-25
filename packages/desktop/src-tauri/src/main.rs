#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// AgentError 携带服务端错误细节（code/message/details），按值传递比封箱更清晰；
// 所有命令层都用 `?` 立即转换，不构成实测热点。
#![allow(clippy::result_large_err)]

mod agent;
mod agent_service;
mod appearance;
mod config;
mod kit_assets;
mod logging;
mod navigation;
mod plugin_host;
mod runtime_commands;
mod share_link;
mod tray;
mod update;
mod url_path;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use cookie::{Cookie, SameSite};
use serde::Serialize;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

const SESSION_COOKIE: &str = "trellis_team_session";
const DEFAULT_APP_NAME: &str = "Board";
const BUILD_APP_NAME: Option<&str> = option_env!("TRELLIS_BOARD_APP_NAME");
// 与 packages/shared/trellis-agent-tools.js 当前目录数量保持一致。
const MAX_AGENT_TOOLS: usize = 22;

#[derive(Clone, Default)]
pub(crate) struct DesktopAuthState {
    board_url: Arc<RwLock<Option<Url>>>,
    session_token: Arc<Mutex<Option<String>>>,
    local_url: Arc<Mutex<Option<Url>>>,
    pending_project_path: Arc<Mutex<Option<PathBuf>>>,
    /// 分享链接只暂存在内存里，等已登录的 Board 取走；退出登录即作废。
    pub(crate) pending_share: Arc<Mutex<Option<share_link::PendingShare>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    app_name: String,
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
struct ClientIdentity {
    name: String,
    version: String,
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

pub(crate) fn ensure_board_caller(app: &AppHandle, window: &WebviewWindow) -> Result<Url, String> {
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
    if navigation::same_board_scope(&current, &board) {
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

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= 80)
        .unwrap_or_else(|| "Windows 桌面".to_string())
}

pub(crate) fn resolve_app_name(
    runtime_env: Option<&str>,
    build_env: Option<&str>,
    product_name: Option<&str>,
) -> String {
    [runtime_env, build_env, product_name]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or(DEFAULT_APP_NAME)
        .to_string()
}

pub(crate) fn app_display_name(product_name: Option<&str>) -> String {
    let runtime_env = std::env::var("TRELLIS_BOARD_APP_NAME").ok();
    resolve_app_name(runtime_env.as_deref(), BUILD_APP_NAME, product_name)
}

fn initial_server_url() -> Option<String> {
    config::server_url_from_args()
        .or_else(|| std::env::var("TRELLIS_DESKTOP_SERVER_URL").ok())
        .or_else(|| config::load().ok().flatten().map(|value| value.server_url))
        .filter(|value| !value.trim().is_empty())
}

fn cookie_for(board: &Url, value: &str) -> Result<Cookie<'static>, String> {
    let host = board
        .host_str()
        .ok_or_else(|| "Board 地址缺少主机".to_string())?
        .to_string();
    Ok(Cookie::build((SESSION_COOKIE, value.to_string()))
        .domain(host)
        .path(navigation::board_cookie_path(board))
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
    plugin_host::stop(app).await;
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
    update::set_server_url(app, None);
    if let Ok(mut value) = state.pending_share.lock() {
        share_link::clear(&mut value);
    }
    forget_saved_password();
    navigate_local_login(app, state);
    if revoke_session {
        if let (Some(board), Some(token)) = (board.as_ref(), token.as_deref()) {
            let _ = agent_service::logout(app, &navigation::board_server_url(board), token).await;
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

/// 只读、无敏感数据：客户端自带页面（登录页/主窗口）也要跟随设备偏好。
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
    notify_mode: Option<String>,
) -> Result<(), String> {
    ensure_board_caller(&app, &window)?;
    // 旧 Web 包不带 notifyMode：保留设备上已有的档位，避免顺手把它重置。
    let notify_mode = notify_mode.unwrap_or_else(|| appearance::load().notify_mode);
    appearance::save(&appearance::Appearance {
        theme,
        font_size,
        notify_mode,
    })
}

#[tauri::command]
async fn app_status(app: AppHandle, window: WebviewWindow) -> Result<AppStatus, String> {
    ensure_local_caller(&window)?;
    let config = config::load()?;
    Ok(AppStatus {
        app_name: app_display_name(app.config().product_name.as_deref()),
        version: env!("CARGO_PKG_VERSION").to_string(),
        server_url: config
            .as_ref()
            .map(|value| value.server_url.clone())
            .filter(|value| !value.trim().is_empty())
            .or_else(initial_server_url),
        username: config.as_ref().and_then(|value| value.username.clone()),
        password: config.as_ref().and_then(|value| value.password.clone()),
        config_path: config::config_path().display().to_string(),
        logs_dir: config::logs_dir().display().to_string(),
        sidecar_running: agent_service::is_running(&app),
    })
}

#[tauri::command]
fn client_identity(app: AppHandle, window: WebviewWindow) -> Result<ClientIdentity, String> {
    ensure_board_caller(&app, &window)?;
    Ok(ClientIdentity {
        name: app_display_name(app.config().product_name.as_deref()),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

#[tauri::command]
fn update_status(app: AppHandle, window: WebviewWindow) -> Result<update::UpdateStatus, String> {
    ensure_board_caller(&app, &window)?;
    Ok(update::status(&app))
}

#[tauri::command]
async fn update_check(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<update::UpdateStatus, String> {
    ensure_board_caller(&app, &window)?;
    Ok(update::check(&app).await)
}

#[tauri::command]
async fn update_apply(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<update::UpdateApplyResult, String> {
    ensure_board_caller(&app, &window)?;
    update::apply(&app).await
}

#[tauri::command]
async fn runtime_status(window: WebviewWindow) -> Result<agent::env::RuntimeStatus, String> {
    ensure_local_caller(&window)?;
    runtime_commands::runtime_status().await
}

#[tauri::command]
async fn runtime_set_node_path(
    window: WebviewWindow,
    path: String,
) -> Result<agent::env::RuntimeStatus, String> {
    ensure_local_caller(&window)?;
    runtime_commands::runtime_set_node_path(path).await
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
    let server_url = navigation::board_server_url(&board);
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
        python_runtime: previous_config
            .as_ref()
            .and_then(|value| value.python_runtime.clone()),
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
    update::set_server_url(&app, Some(&server_url));
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
async fn commit_and_push_pending_project(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let path = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    agent_service::commit_and_push_initial_project(&app, &path.to_string_lossy()).await
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
    let developer_id = validate_developer_id(&developer_id)?;
    let path = app
        .state::<DesktopAuthState>()
        .pending_project_path
        .lock()
        .map_err(|_| "无法读取待接入项目路径".to_string())?
        .clone()
        .ok_or_else(|| "请先选择本地 Git 项目目录".to_string())?;
    agent_service::preflight_project(
        &app,
        &path.to_string_lossy(),
        &team_id,
        &developer_id,
        require_pushed,
    )
    .await
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
async fn list_worktree_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<crate::agent::worktree::WorktreeStatusView>, String> {
    ensure_board_caller(&app, &window)?;
    agent_service::list_worktree_status(&app).await
}

#[tauri::command]
async fn refresh_worktree_discovery(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<crate::agent::worktree::WorktreeStatusView>, String> {
    ensure_board_caller(&app, &window)?;
    agent_service::refresh_worktree_discovery(&app).await
}

#[tauri::command]
async fn retry_worktree_auto_attach(
    app: AppHandle,
    window: WebviewWindow,
    key: String,
) -> Result<Vec<crate::agent::worktree::WorktreeStatusView>, String> {
    ensure_board_caller(&app, &window)?;
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 {
        return Err("worktree 标识无效".to_string());
    }
    agent_service::retry_worktree_auto_attach(&app, key).await
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
    ensure_board_caller(&app, &window)?;
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
async fn live_task_download(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
    task_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let task_id = validate_live_id(&task_id, "任务 ID")?;
    agent_service::download_task(&app, &task_space_id, &task_id).await
}

#[tauri::command]
async fn live_local_task_state(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    agent_service::local_task_state(&app, &task_space_id).await
}

#[tauri::command]
async fn live_conflicts_show(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: Option<String>,
) -> Result<bool, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = task_space_id
        .map(|value| validate_live_id(&value, "任务空间 ID"))
        .transpose()?;
    agent_service::reopen_conflicts(&app, task_space_id).await
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
    ensure_board_caller(&app, &window)?;
    Ok(agent_service::pending_control(&app))
}

#[tauri::command]
async fn handoff_notice_pending(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<agent::task_control::HandoffNotice>, String> {
    ensure_board_caller(&app, &window)?;
    agent_service::pending_handoff_notices(&app).await
}

#[tauri::command]
async fn live_control_show(app: AppHandle, window: WebviewWindow) -> Result<bool, String> {
    ensure_board_caller(&app, &window)?;
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
    ensure_board_caller(&app, &window)?;
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
    ensure_board_caller(&app, &window)?;
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
    ensure_board_caller(&app, &window)?;
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
    ensure_board_caller(&app, &window)?;
    agent_service::dismiss_control(&app)
}

pub(crate) fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 任务分享协议：注册 `spec-board` 并接管运行期唤起的链接。
/// 冷启动时插件在自己的 setup 里已解析过 argv，事件早于本监听，因此还要读一次 `current`。
fn register_share_link(app: &AppHandle) {
    let deep_link = app.deep_link();
    if let Err(error) = deep_link.register_all() {
        logging::warn(&format!("注册任务分享协议失败：{error}"));
    }
    let handle = app.clone();
    deep_link.on_open_url(move |event| {
        for url in event.urls() {
            share_link::handle(&handle, url.as_str());
        }
    });
    if let Ok(Some(urls)) = deep_link.get_current() {
        for url in urls {
            share_link::handle(app, url.as_str());
        }
    }
}

/// 同步通知的点击入口：只把窗口带回前台。更新对话框由 `update::register` 自己的回调判断，
/// 插件允许多个 handler 并存，因此未配置更新服务器时这里仍然生效。
fn register_notification_tap(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.notification().on_action(move |action| {
        if action.action_id() == "tap" {
            focus_main_window(&handle);
        }
    }) {
        logging::warn(&format!("无法注册系统通知点击处理：{error}"));
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
            .title(app_display_name(app.config().product_name.as_deref()))
            // 本窗口始终是客户端：插件由本机宿主提供，与服务端是否 Team 模式无关。
            .initialization_script("window.__TRELLIS_ROLE__ = 'client';")
            .inner_size(1280.0, 800.0)
            .min_inner_size(960.0, 640.0)
            .visible(!minimized)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_navigation(move |candidate| {
                let state = shell_app.state::<DesktopAuthState>();
                let board = state.board_url.read().ok().and_then(|value| value.clone());
                if let Some(board) = board.as_ref() {
                    if navigation::is_board_login_path(candidate, board) {
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            app_status,
            client_identity,
            desktop_logout,
            desktop_login,
            appearance_load,
            appearance_save,
            pick_local_project_folder,
            inspect_local_project,
            initialize_pending_project,
            check_pending_project_push,
            commit_and_push_pending_project,
            preflight_pending_project,
            cancel_pending_project,
            associate_pending_project,
            list_local_associations,
            list_worktree_status,
            refresh_worktree_discovery,
            retry_worktree_auto_attach,
            detach_local_association,
            inspect_associated_project_agents,
            initialize_associated_project_agents,
            sync_deferred_tasks,
            list_task_ownership,
            set_task_ownership,
            live_task_download,
            live_local_task_state,
            live_conflicts_show,
            desktop_sidecar_status,
            runtime_status,
            runtime_set_node_path,
            runtime_install,
            live_control_pending,
            handoff_notice_pending,
            live_control_show,
            live_control_decide,
            live_control_diff,
            live_control_initial,
            live_control_dismiss,
            update_status,
            update_check,
            update_apply,
            plugin_host::desktop_plugins_list,
            plugin_host::desktop_plugin_set_enabled,
            plugin_host::desktop_plugin_reorder,
            plugin_host::desktop_plugin_logs,
            plugin_host::desktop_plugin_panels,
            plugin_host::desktop_plugin_request,
            plugin_host::desktop_plugin_asset,
            share_link::take_pending_share_link
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = config::ensure_directories();
            logging::init(&config::logs_dir());
            agent_service::register(&handle);
            plugin_host::register(&handle);
            register_notification_tap(&handle);
            let auth = DesktopAuthState::default();
            app.manage(auth.clone());
            register_share_link(&handle);
            update::register(&handle, initial_server_url().as_deref());
            tray::build(&handle)?;
            build_main_window(&handle, minimized, auth)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Trellis Board desktop client")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                plugin_host::shutdown(app);
                agent_service::shutdown(app);
            }
        });
}

#[cfg(test)]
#[path = "main/tests.rs"]
mod tests;
