#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod logging;
mod navigation;
mod sidecar;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use cookie::{Cookie, SameSite};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

const SESSION_COOKIE: &str = "trellis_team_session";

#[derive(Clone, Default)]
struct DesktopAuthState {
    board_url: Arc<RwLock<Option<Url>>>,
    session_token: Arc<Mutex<Option<String>>>,
    local_url: Arc<Mutex<Option<Url>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStatus {
    version: String,
    server_url: Option<String>,
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
    if navigation::is_local_page(&url) {
        Ok(())
    } else {
        Err("该命令仅允许本地登录页调用".to_string())
    }
}

fn ensure_board_caller(
    app: &AppHandle,
    window: &WebviewWindow,
) -> Result<Url, String> {
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

fn validate_project_id(value: String) -> Result<String, String> {
    let project_id = value.trim().to_string();
    let valid = (1..=128).contains(&project_id.len())
        && project_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric()
                || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
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
        .or_else(|| {
            config::load()
                .ok()
                .flatten()
                .map(|value| value.server_url)
        })
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

fn write_session_cookie(
    window: &WebviewWindow,
    board: &Url,
    token: &str,
) -> Result<(), String> {
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
    let url = state
        .local_url
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let Some(url) = url {
        let _ = window.navigate(url);
    }
}

async fn clear_desktop_session(
    app: &AppHandle,
    state: &DesktopAuthState,
    revoke_session: bool,
) {
    sidecar::stop(app);
    let board = state
        .board_url
        .read()
        .ok()
        .and_then(|value| value.clone());
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
    navigate_local_login(app, state);
    if revoke_session {
        if let (Some(board), Some(token)) = (board.as_ref(), token.as_deref()) {
            let _ = sidecar::logout(
                app,
                &server_root(board),
                token,
                &config::agent_root(),
            )
            .await;
        }
    }
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
        config_path: config::config_path().display().to_string(),
        logs_dir: config::logs_dir().display().to_string(),
        sidecar_running: sidecar::is_running(&app),
    })
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
    let username = validate_username(&username)?;
    validate_password(&password)?;
    // 登录页出现时旧会话已结束，先停止旧账号 sidecar，成功后再按新配置重启。
    sidecar::stop(&app);
    let server_url = server_root(&board);
    let previous = config::load().unwrap_or(None);
    let force_new = previous
        .as_ref()
        .map(|value| value.server_url != server_url)
        .unwrap_or(true);
    let device_name = default_device_name();
    let summary = sidecar::login(
        &app,
        &server_url,
        &username,
        &password,
        &device_name,
        &config::agent_root(),
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
        let _ = sidecar::logout(
            &app,
            &server_url,
            &token,
            &config::agent_root(),
        )
        .await;
        return Err(error);
    }
    if let Err(error) = config::save(&config::ClientConfig {
        schema_version: config::SCHEMA_VERSION,
        server_url: server_url.clone(),
    }) {
        let _ = delete_session_cookie(&window, &board);
        let _ = sidecar::logout(
            &app,
            &server_url,
            &token,
            &config::agent_root(),
        )
        .await;
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
        sidecar::restart(&app);
    } else {
        sidecar::stop(&app);
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
async fn associate_local_project(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    sync_branch: String,
) -> Result<Option<sidecar::LocalAssociation>, String> {
    ensure_board_caller(&app, &window)?;
    let project_id = validate_project_id(project_id)?;
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(path) = folder else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|error| format!("无法读取所选目录：{error}"))?;
    let association = sidecar::associate(
        &app,
        &project_id,
        &path.to_string_lossy(),
        sync_branch.trim(),
        &config::agent_root(),
    )
    .await?;
    Ok(Some(association))
}

#[tauri::command]
async fn list_local_associations(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Vec<sidecar::LocalAssociation>, String> {
    ensure_board_caller(&app, &window)?;
    sidecar::list_associations(&app, &config::agent_root()).await
}

#[tauri::command]
async fn desktop_sidecar_status(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<sidecar::SidecarStatus, String> {
    ensure_board_caller(&app, &window)?;
    Ok(sidecar::status(&app))
}

#[tauri::command]
async fn live_control_pending(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<serde_json::Value>, String> {
    ensure_local_caller(&window)?;
    Ok(sidecar::pending_control(&app))
}

#[tauri::command]
async fn live_control_decide(
    app: AppHandle,
    window: WebviewWindow,
    pending_id: String,
    action: String,
) -> Result<(), String> {
    ensure_local_caller(&window)?;
    let pending_id = validate_live_id(&pending_id, "待确认 ID")?;
    if !matches!(action.as_str(), "continue" | "takeover" | "cancel") {
        return Err("实时同步确认动作无效".to_string());
    }
    sidecar::decide_live_change(
        &app,
        &pending_id,
        &action,
        &config::agent_root(),
    )
    .await?;
    sidecar::clear_control(&app);
    Ok(())
}

#[tauri::command]
async fn live_control_restore(
    app: AppHandle,
    window: WebviewWindow,
    backup_id: String,
) -> Result<(), String> {
    ensure_local_caller(&window)?;
    let backup_id = validate_live_id(&backup_id, "备份 ID")?;
    sidecar::restore_live_backup(&app, &backup_id, &config::agent_root()).await?;
    sidecar::clear_control(&app);
    Ok(())
}

#[tauri::command]
async fn live_control_dismiss(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    ensure_local_caller(&window)?;
    sidecar::dismiss_control(&app)
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
    let pause = MenuItem::with_id(app, "pause", "暂停同步", true, None::<&str>)?;
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
    let menu = Menu::with_items(app, &[&show, &pause, &logs, &autostart, &quit])?;
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
            "pause" => sidecar::toggle_pause(app),
            "logs" => {
                let directory = config::logs_dir();
                let _ = std::fs::create_dir_all(&directory);
                let _ = app.shell().open(directory.to_string_lossy(), None);
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
                sidecar::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn build_main_window(
    app: &AppHandle,
    minimized: bool,
    auth: DesktopAuthState,
) -> tauri::Result<()> {
    let navigation_auth = auth.clone();
    let shell_app = app.clone();
    let builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title("Trellis Board")
    .inner_size(1280.0, 800.0)
    .min_inner_size(960.0, 640.0)
    .visible(!minimized)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_navigation(move |candidate| {
        let state = shell_app.state::<DesktopAuthState>();
        let board = state
            .board_url
            .read()
            .ok()
            .and_then(|value| value.clone());
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
    });
    let window = builder.build()?;
    if let Ok(url) = window.url() {
        if let Ok(mut local_url) = navigation_auth.local_url.lock() {
            *local_url = Some(url);
        }
    }
    Ok(())
}

fn main() {
    let minimized = config::minimized_from_args();
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_status,
            desktop_login,
            associate_local_project,
            list_local_associations,
            desktop_sidecar_status,
            live_control_pending,
            live_control_decide,
            live_control_restore,
            live_control_dismiss
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = config::ensure_directories();
            logging::init(&config::logs_dir());
            sidecar::register(&handle);
            let auth = DesktopAuthState::default();
            app.manage(auth.clone());
            build_tray(&handle)?;
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
                sidecar::shutdown(app);
            }
        });
}
