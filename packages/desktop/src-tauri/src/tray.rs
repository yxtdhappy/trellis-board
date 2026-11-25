use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_opener::OpenerExt;

use crate::{agent_service, config, focus_main_window, logging, plugin_host, update};

fn autostart_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

pub(crate) fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let live_control = MenuItem::with_id(app, "review-live", "处理实时确认", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "恢复同步", true, None::<&str>)?;
    let check_update = MenuItem::with_id(
        app,
        "check-update",
        "检查更新",
        update::enabled(app),
        None::<&str>,
    )?;
    update::set_tray_item(app, check_update.clone());
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
        &[
            &show,
            &live_control,
            &sync,
            &check_update,
            &logs,
            &autostart,
            &quit,
        ],
    )?;
    let Some(icon) = app.default_window_icon().cloned() else {
        logging::warn("客户端缺少窗口图标，托盘不可用");
        return Ok(());
    };
    TrayIconBuilder::with_id("main")
        .tooltip(crate::app_display_name(
            app.config().product_name.as_deref(),
        ))
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
            "check-update" => {
                focus_main_window(app);
                let _ = app.emit("update-open-dialog", ());
            }
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
                plugin_host::shutdown(app);
                agent_service::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    agent_service::set_sync_menu_item(app, sync);
    Ok(())
}
