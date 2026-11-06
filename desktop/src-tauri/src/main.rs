#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod logging;
mod navigation;
mod sidecar;

use std::path::PathBuf;

use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_shell::ShellExt;

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
struct EnrollResult {
    agent_id: String,
    server_url: String,
    device_name: String,
}

fn ensure_local_caller(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|error| format!("无法确认调用页面来源：{error}"))?;
    if navigation::is_local_page(&url) {
        Ok(())
    } else {
        Err("该命令仅允许本地页面调用".to_string())
    }
}

#[tauri::command]
async fn app_status(app: AppHandle, window: tauri::WebviewWindow) -> Result<AppStatus, String> {
    ensure_local_caller(&window)?;
    let config = config::load()?;
    Ok(AppStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        server_url: config.map(|value| value.server_url),
        config_path: config::config_path().display().to_string(),
        logs_dir: config::logs_dir().display().to_string(),
        sidecar_running: sidecar::is_running(&app),
    })
}

fn validate_device_name(value: &str) -> Result<String, String> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("设备名格式无效".to_string());
    }
    Ok(name.to_string())
}

fn validate_enroll_token(value: &str) -> Result<String, String> {
    let token = value.trim();
    if !navigation::is_enroll_token(token) {
        return Err("设备令牌格式无效".to_string());
    }
    Ok(token.to_string())
}

/// 注册成功后写入 Board 地址并重启 sidecar；令牌/配对码不进 argv 或日志。
async fn perform_enroll(
    app: &AppHandle,
    board: Url,
    secret: &str,
    device_name: &str,
    pairing_code: bool,
) -> Result<EnrollResult, String> {
    let agent_root = config::agent_root();
    let output = sidecar::enroll(
        app,
        board.as_str(),
        secret,
        device_name,
        &agent_root,
        pairing_code,
    )
    .await?;
    let summary: sidecar::EnrollSummary = output
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line.trim()).ok())
        .ok_or_else(|| "sidecar 返回了无效的注册结果".to_string())?;
    if !summary.ok {
        return Err(summary
            .error
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| "设备注册失败".to_string()));
    }
    let agent_id = summary
        .agent_id
        .ok_or_else(|| "设备注册结果缺少 agentId".to_string())?;
    config::save(&config::ClientConfig {
        schema_version: config::SCHEMA_VERSION,
        server_url: board.as_str().to_string(),
    })?;
    sidecar::restart(app);
    Ok(EnrollResult {
        agent_id,
        server_url: board.as_str().to_string(),
        device_name: device_name.to_string(),
    })
}

#[tauri::command]
async fn enroll_with_token(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server_url: String,
    token: String,
    device_name: String,
) -> Result<EnrollResult, String> {
    ensure_local_caller(&window)?;
    let board = navigation::validate_board_url(&server_url)?;
    let token = validate_enroll_token(&token)?;
    let name = validate_device_name(&device_name)?;
    perform_enroll(&app, board, &token, &name, false).await
}

#[tauri::command]
async fn enroll_device(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server_url: String,
    pairing_code: String,
    device_name: String,
) -> Result<EnrollResult, String> {
    ensure_local_caller(&window)?;
    let board = navigation::validate_board_url(&server_url)?;
    let code = pairing_code.trim();
    if code.len() < 16 || code.len() > 512 {
        return Err("配对码格式无效".to_string());
    }
    let name = validate_device_name(&device_name)?;
    perform_enroll(&app, board, code, &name, true).await
}

#[tauri::command]
async fn open_board_login(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server_url: String,
) -> Result<(), String> {
    ensure_local_caller(&window)?;
    let board = navigation::validate_board_url(&server_url)?;
    app.shell()
        .open(board.as_str(), None)
        .map_err(|error| format!("无法打开系统浏览器：{error}"))
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
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

fn initial_board_url() -> Option<Url> {
    let configured = config::server_url_from_args()
        .or_else(|| std::env::var("TRELLIS_DESKTOP_SERVER_URL").ok())
        .or_else(|| config::load().ok().flatten().map(|item| item.server_url));
    configured.and_then(|value| navigation::validate_board_url(&value).ok())
}

fn default_device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= 80)
        .unwrap_or_else(|| "Windows 桌面".to_string())
}

/// 处理启动参数与单实例转发：`trellisboard://enroll?token=...&server=...`。
fn handle_enroll_links(app: &AppHandle, args: &[String]) {
    for argument in args {
        let Some(link) = navigation::parse_enroll_link(argument) else {
            continue;
        };
        // 本地注册页据此预填令牌；远程页面没有该事件的监听权限。
        let _ = app.emit("enroll-token", &link.token);
        focus_main_window(app);
        let board = link
            .server_url
            .as_deref()
            .and_then(|value| navigation::validate_board_url(value).ok())
            .or_else(initial_board_url);
        let Some(board) = board else {
            logging::warn("已收到设备令牌，但尚未配置 Board 地址；请在本地页面粘贴令牌");
            return;
        };
        let handle = app.clone();
        let token = link.token;
        tauri::async_runtime::spawn(async move {
            let name = default_device_name();
            match perform_enroll(&handle, board, &token, &name, false).await {
                Ok(result) => {
                    logging::line(&format!("桌面设备已注册：{}", result.device_name));
                    let _ = handle.emit("enroll-complete", ());
                    focus_main_window(&handle);
                }
                Err(error) => {
                    logging::warn(&format!("深链注册失败：{error}"));
                    let _ = handle.emit("enroll-failed", error);
                }
            }
        });
        return;
    }
}

fn build_main_window(app: &AppHandle, minimized: bool) -> tauri::Result<()> {
    let board = initial_board_url();
    let url = match &board {
        Some(board) => WebviewUrl::External(board.clone()),
        None => WebviewUrl::App(PathBuf::from("index.html")),
    };
    let mut builder = WebviewWindowBuilder::new(app, "main", url)
        .title("Trellis Board")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 640.0)
        .visible(!minimized)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    let shell_app = app.clone();
    let board_for_navigation = board.clone();
    builder = builder.on_navigation(move |candidate| {
        navigation::handle_navigation(&shell_app, &candidate, board_for_navigation.as_ref())
    });
    builder.build()?;
    Ok(())
}

fn main() {
    let minimized = config::minimized_from_args();
    let launch_args: Vec<String> = std::env::args().skip(1).collect();
    tauri::Builder::default()
        // 单实例必须最先注册，重复启动只聚焦已有窗口。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main_window(app);
            handle_enroll_links(app, &argv);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            app_status,
            enroll_with_token,
            enroll_device,
            open_board_login
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let _ = config::ensure_directories();
            logging::init(&config::logs_dir());
            sidecar::register(&handle);
            build_tray(&handle)?;
            build_main_window(&handle, minimized)?;
            if config::load()?.is_some() {
                sidecar::start(&handle);
            }
            handle_enroll_links(&handle, &launch_args);
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
