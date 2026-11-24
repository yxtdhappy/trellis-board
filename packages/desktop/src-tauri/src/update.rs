use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use tauri::menu::MenuItem;
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_notification::NotificationExt;

use crate::config;
use crate::logging;

use self::manifest::{Release, MAX_MANIFEST_BYTES};

mod manifest;
mod package;

pub const UPDATE_SERVER: Option<&str> = option_env!("TRELLIS_UPDATE_SERVER");
const STARTUP_DELAY: Duration = Duration::from_secs(5);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestInfo {
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub enabled: bool,
    pub current_version: String,
    pub server: Option<String>,
    pub latest: Option<LatestInfo>,
    pub update_available: bool,
    pub checked_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateApplyResult {
    pub applied: bool,
}

pub struct UpdateManager {
    compile_base: Option<String>,
    runtime_base: Mutex<Option<String>>,
    tray_item: Mutex<Option<MenuItem<Wry>>>,
    current: String,
    status: Mutex<UpdateStatus>,
    latest_release: Mutex<Option<Release>>,
    check_lock: tokio::sync::Mutex<()>,
    client: reqwest::Client,
}

impl UpdateManager {
    fn new(initial_server_url: Option<&str>) -> Self {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let compile_base = configured_base();
        let runtime_base = if compile_base.is_some() {
            None
        } else {
            initial_server_url.and_then(normalize_server_base)
        };
        let base = resolve_effective_base(compile_base.as_deref(), runtime_base.as_deref());
        let status = UpdateStatus {
            enabled: base.is_some(),
            current_version: current.clone(),
            server: base,
            latest: None,
            update_available: false,
            checked_at: None,
            error: None,
        };
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent(format!("TrellisBoard/{current}"))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            compile_base,
            runtime_base: Mutex::new(runtime_base),
            tray_item: Mutex::new(None),
            current,
            status: Mutex::new(status),
            latest_release: Mutex::new(None),
            check_lock: tokio::sync::Mutex::new(()),
            client,
        }
    }

    fn effective_base(&self) -> Option<String> {
        if let Some(base) = &self.compile_base {
            return Some(base.clone());
        }
        self.runtime_base
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|error| error.into_inner().clone())
    }

    fn is_enabled(&self) -> bool {
        self.effective_base().is_some()
    }

    fn snapshot(&self) -> UpdateStatus {
        self.status
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|error| error.into_inner().clone())
    }

    fn store(&self, status: UpdateStatus) {
        let mut guard = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *guard = status;
    }

    fn sync_tray(&self, enabled: bool) {
        let item = self
            .tray_item
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|error| error.into_inner().clone());
        if let Some(item) = item {
            let _ = item.set_enabled(enabled);
        }
    }
}

pub fn enabled(app: &AppHandle) -> bool {
    app.try_state::<UpdateManager>()
        .map(|manager| manager.is_enabled())
        .unwrap_or_else(|| configured_base().is_some())
}

pub fn set_tray_item(app: &AppHandle, item: MenuItem<Wry>) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    let enabled = manager.is_enabled();
    let _ = item.set_enabled(enabled);
    let mut guard = manager
        .tray_item
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *guard = Some(item);
}

pub(crate) fn normalize_server_base(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if crate::url_path::raw_path_has_dot_segments(raw) {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let raw_path = url.path();
    if raw_path.contains('\\') || raw_path.contains("//") {
        return None;
    }
    let trimmed = raw_path.trim_end_matches('/');
    let mut segments: Vec<&str> = if trimmed.is_empty() || trimmed == "/" {
        Vec::new()
    } else {
        trimmed
            .strip_prefix('/')
            .unwrap_or(trimmed)
            .split('/')
            .collect()
    };
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return None;
    }
    if let Some(last) = segments.last() {
        if matches!(
            last.to_ascii_lowercase().as_str(),
            "login.html" | "admin.html" | "index.html" | "share.html" | "login"
        ) {
            segments.pop();
        }
    }
    let prefix = if segments.is_empty() {
        String::new()
    } else {
        format!("/{}", segments.join("/"))
    };
    Some(format!(
        "{}://{host}{port}{prefix}/client-updates",
        url.scheme()
    ))
}

pub(crate) fn resolve_effective_base(
    compile_base: Option<&str>,
    runtime_base: Option<&str>,
) -> Option<String> {
    compile_base.or(runtime_base).map(str::to_string)
}

fn configured_base() -> Option<String> {
    let raw = UPDATE_SERVER?.trim();
    if raw.is_empty() {
        return None;
    }
    let url = url::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(raw.trim_end_matches('/').to_string())
}

pub fn register(app: &AppHandle, initial_server_url: Option<&str>) {
    let manager = UpdateManager::new(initial_server_url);
    let initial_base = manager.effective_base();
    let current = manager.current.clone();
    app.manage(manager);
    package::cleanup_stale();

    let handle = app.clone();
    if let Err(error) = app.notification().on_action(move |action| {
        if action.action_id() != "tap" {
            return;
        }
        crate::focus_main_window(&handle);
        // 同一个 tap 也服务于同步通知：只有确实存在新版本时才打开更新对话框。
        let available = handle
            .try_state::<UpdateManager>()
            .map(|manager| manager.snapshot().update_available)
            .unwrap_or(false);
        if available {
            let _ = handle.emit("update-open-dialog", ());
        }
    }) {
        logging::warn(&format!("无法注册系统通知点击处理：{error}"));
    }

    if let Some(base) = initial_base {
        logging::info(&format!("自动更新已启用：{base}，当前版本 {current}"));
    } else {
        logging::info("未配置构建期更新服务器，将在连接 Team 服务端后自动启用更新检查");
    }

    let loop_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            if loop_app
                .try_state::<UpdateManager>()
                .map(|manager| manager.is_enabled())
                .unwrap_or(false)
            {
                check(&loop_app).await;
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

pub fn set_server_url(app: &AppHandle, board_url: Option<&str>) {
    let Some(manager) = app.try_state::<UpdateManager>() else {
        return;
    };
    if manager.compile_base.is_some() {
        return;
    }
    let next = board_url.and_then(normalize_server_base);
    {
        let mut guard = manager
            .runtime_base
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *guard == next {
            return;
        }
        *guard = next.clone();
    }
    if let Ok(mut guard) = manager.latest_release.lock() {
        *guard = None;
    }
    let next_status = UpdateStatus {
        enabled: next.is_some(),
        current_version: manager.current.clone(),
        server: next.clone(),
        latest: None,
        update_available: false,
        checked_at: None,
        error: None,
    };
    manager.store(next_status.clone());
    manager.sync_tray(next.is_some());
    let _ = app.emit("update-status-changed", next_status);
    if let Some(base) = next {
        logging::info(&format!(
            "自动更新源已切换：{base}，当前版本 {}",
            manager.current
        ));
        let check_app = app.clone();
        tauri::async_runtime::spawn(async move {
            check(&check_app).await;
        });
    } else {
        logging::info("已清除运行时更新服务器回退地址");
    }
}

pub fn status(app: &AppHandle) -> UpdateStatus {
    app.state::<UpdateManager>().snapshot()
}

pub async fn check(app: &AppHandle) -> UpdateStatus {
    let manager = app.state::<UpdateManager>();
    let Some(base) = manager.effective_base() else {
        return manager.snapshot();
    };
    let client = manager.client.clone();
    let _guard = manager.check_lock.lock().await;
    let Some(active_base) = manager.effective_base() else {
        return manager.snapshot();
    };
    let base = if active_base == base {
        base
    } else {
        active_base
    };
    let result = fetch_release(&client, &base).await;
    if manager.effective_base().as_deref() != Some(base.as_str()) {
        return manager.snapshot();
    }
    let mut status = manager.snapshot();
    status.checked_at = Some(now());
    match result {
        Ok(release) => {
            let update_available = manifest::is_newer(&release.version, &manager.current);
            status.update_available = update_available;
            status.error = None;
            status.latest = Some(LatestInfo {
                version: release.version.clone(),
                notes: release.notes.clone(),
                published_at: release.published_at.clone(),
                size: release.size,
            });
            if let Ok(mut guard) = manager.latest_release.lock() {
                *guard = Some(release.clone());
            }
            manager.store(status.clone());
            let _ = app.emit("update-status-changed", status.clone());
            if update_available && last_notified_version().as_deref() != Some(&release.version) {
                notify(app, &manager.current, &release);
            }
            status
        }
        Err(error) => {
            status.error = Some(error.clone());
            manager.store(status.clone());
            let _ = app.emit("update-status-changed", status.clone());
            logging::warn(&format!("检查客户端更新失败：{error}"));
            status
        }
    }
}

fn notify(app: &AppHandle, current: &str, release: &Release) {
    let result = app
        .notification()
        .builder()
        .title("Trellis Board 有新版本")
        .body(format!(
            "v{current} → v{}，点击查看更新内容",
            release.version
        ))
        .show();
    match result {
        Ok(()) => {
            if let Err(error) = save_last_notified(&release.version) {
                logging::warn(&format!("无法写入更新通知去重状态：{error}"));
            }
        }
        Err(error) => logging::warn(&format!("发送更新通知失败：{error}")),
    }
}

pub async fn apply(app: &AppHandle) -> Result<UpdateApplyResult, String> {
    if cfg!(debug_assertions) {
        return Err("开发构建不支持自动更新，请使用正式打包版本".to_string());
    }
    let manager = app.state::<UpdateManager>();
    let Some(base) = manager.effective_base() else {
        return Err("未配置更新服务器".to_string());
    };
    let status = manager.snapshot();
    if !status.update_available {
        return Err("当前已是最新版本".to_string());
    }
    let release = manager
        .latest_release
        .lock()
        .map_err(|_| "无法读取更新信息".to_string())?
        .clone()
        .ok_or_else(|| "尚未获取更新信息".to_string())?;
    let client = manager.client.clone();

    let staging = config::data_dir().join("updates").join(&release.version);
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|error| format!("无法清理旧的更新目录：{error}"))?;
    }
    std::fs::create_dir_all(&staging).map_err(|error| format!("无法创建更新目录：{error}"))?;
    let zip_path = staging.join(&release.file);

    emit_progress(app, "downloading", Some(0), Some(release.size));
    let progress_app = app.clone();
    package::download(
        &client,
        &release.zip_url(&base),
        &zip_path,
        &release,
        move |downloaded, total| {
            emit_progress(&progress_app, "downloading", Some(downloaded), Some(total));
        },
    )
    .await?;

    emit_progress(app, "verifying", None, None);
    let staged = {
        let zip_path = zip_path.clone();
        let destination = staging.join("staged");
        tokio::task::spawn_blocking(move || package::extract_executable(&zip_path, &destination))
            .await
            .map_err(|error| format!("解压更新包失败：{error}"))??
    };

    emit_progress(app, "installing", None, None);
    let exe = tokio::task::spawn_blocking(move || package::replace_executable(&staged))
        .await
        .map_err(|error| format!("安装更新失败：{error}"))??;
    let _ = std::fs::remove_dir_all(&staging);

    emit_progress(app, "restarting", None, None);
    package::spawn_relaunch(&exe)?;
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        handle.exit(0);
    });
    Ok(UpdateApplyResult { applied: true })
}

fn emit_progress(app: &AppHandle, stage: &str, downloaded: Option<u64>, total: Option<u64>) {
    let _ = app.emit(
        "update-progress",
        json!({ "stage": stage, "downloaded": downloaded, "total": total }),
    );
}

async fn fetch_release(client: &reqwest::Client, base: &str) -> Result<Release, String> {
    let response = client
        .get(format!("{base}/latest.json"))
        .send()
        .await
        .map_err(|error| format!("无法连接更新服务器：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("更新服务器返回 HTTP {}", response.status()));
    }
    let mut payload = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("读取更新清单失败：{error}"))?;
        if payload.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err("更新清单超过 64 KiB".to_string());
        }
        payload.extend_from_slice(&chunk);
    }
    manifest::parse(&payload)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn state_path() -> PathBuf {
    config::data_dir().join("update-state.json")
}

fn last_notified_version() -> Option<String> {
    let text = std::fs::read_to_string(state_path()).ok()?;
    let value: serde_json::Value =
        serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()?;
    value
        .get("lastNotifiedVersion")
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

fn save_last_notified(version: &str) -> Result<(), String> {
    config::ensure_directories()?;
    let target = state_path();
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(&json!({ "lastNotifiedVersion": version }))
        .map_err(|error| format!("无法序列化更新通知状态：{error}"))?;
    std::fs::write(&temp, payload).map_err(|error| format!("无法写入更新通知状态：{error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换更新通知状态：{error}")
    })
}

#[cfg(test)]
mod tests;
