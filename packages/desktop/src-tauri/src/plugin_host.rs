//! 桌面 EXE 本机插件宿主：按 (serverHash, userId) 隔离、按需拉起 Node 进程。
//!
//! Rust 只负责生命周期、隔离目录、DPAPI 凭据与 loopback 代理；
//! 插件协议、supervisor、store、task-service 全部复用服务端 Node 实现。

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::agent::credential::{dpapi_protect, dpapi_unprotect};
use crate::agent::store::ConfigStore;
use crate::config;
use crate::logging;

const READY_TIMEOUT: Duration = Duration::from_secs(45);
const HTTP_TIMEOUT: Duration = Duration::from_secs(120);
const SECRETS_SCHEMA_VERSION: u32 = 1;
const SECRETS_ALGORITHM: &str = "WindowsDPAPI-CurrentUser";
/// 插件宿主依赖 node:sqlite（Node 22.5 起提供）。
const PLUGIN_HOST_NODE_VERSION: &str = "22.5.0";

mod assets;
#[path = "plugin_host/tests.rs"]
#[cfg(test)]
mod tests;

pub struct PluginHostState {
    inner: tokio::sync::Mutex<HostInner>,
    http: reqwest::Client,
}

struct HostInner {
    child: Option<Child>,
    port: Option<u16>,
    token: String,
    secret: String,
    scope: Option<PathBuf>,
}

impl PluginHostState {
    fn new() -> Self {
        Self {
            inner: tokio::sync::Mutex::new(HostInner {
                child: None,
                port: None,
                token: String::new(),
                secret: String::new(),
                scope: None,
            }),
            http: reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }
}

pub fn register(app: &AppHandle) {
    app.manage(PluginHostState::new());
}

fn state(app: &AppHandle) -> Result<tauri::State<'_, PluginHostState>, String> {
    app.try_state::<PluginHostState>()
        .ok_or_else(|| "本机插件宿主尚未初始化".to_string())
}

fn caller(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    crate::ensure_board_caller(app, window)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// 关闭宿主：退出托盘、切号、显式停用时调用；可重复调用。
pub async fn stop(app: &AppHandle) {
    let Some(state) = app.try_state::<PluginHostState>() else {
        return;
    };
    let pid = {
        let mut inner = state.inner.lock().await;
        inner.port = None;
        inner.token.clear();
        inner.secret.clear();
        inner.child.take().and_then(|mut child| {
            let pid = child.id();
            let _ = child.start_kill();
            pid
        })
    };
    if let Some(pid) = pid {
        crate::agent::process::kill_process_tree(Some(pid)).await;
    }
    if let Some(state) = app.try_state::<PluginHostState>() {
        let scope = state.inner.lock().await.scope.clone();
        if let Some(scope) = scope {
            let _ = tokio::fs::remove_file(scope.join("secrets.json")).await;
        }
    }
}

pub fn shutdown(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { stop(&app).await });
}

// ---------------------------------------------------------------- 隔离键与路径

/// serverUrl → 16 位十六进制；不同服务端互不共享插件配置/凭据。
pub fn server_hash(server_url: &str) -> String {
    let normalized = server_url.trim().trim_end_matches('/');
    let digest = Sha256::digest(normalized.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    hex[..16].to_string()
}

/// userId 只保留文件系统安全字符；追加原文哈希避免清洗后撞名。
pub fn user_key(username: &str) -> String {
    let trimmed = username.trim();
    let mut safe: String = trimmed
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        safe.push_str("anonymous");
    }
    if safe.len() > 48 {
        safe.truncate(48);
    }
    let digest = Sha256::digest(trimmed.as_bytes());
    let suffix: String = digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{safe}-{suffix}")
}

pub fn scope_dir(data_dir: &Path, server_url: &str, username: &str) -> PathBuf {
    data_dir
        .join("desktop-plugins")
        .join(server_hash(server_url))
        .join(user_key(username))
}

async fn current_scope() -> Result<(PathBuf, String), String> {
    let store = ConfigStore::new(config::agent_root());
    let agent = store
        .read_config(false)
        .await
        .map_err(|error| error.message)?
        .ok_or_else(|| "尚未登录，无法使用本机插件".to_string())?;
    if agent.server_url.trim().is_empty() {
        return Err("尚未登录，无法使用本机插件".to_string());
    }
    let identity = agent
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&agent.agent_id);
    if identity.trim().is_empty() {
        return Err("缺少本机账号标识，无法隔离插件数据".to_string());
    }
    Ok((
        scope_dir(&config::data_dir(), &agent.server_url, identity),
        agent.server_url,
    ))
}

fn runtime_dir() -> Result<PathBuf, String> {
    assets::ensure_runtime(&config::data_dir())
}

// ---------------------------------------------------------------- 生命周期

async fn ensure_running(app: &AppHandle) -> Result<bool, String> {
    let state = state(app)?;
    let mut inner = state.inner.lock().await;
    if let Some(child) = inner.child.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                inner.child = None;
                inner.port = None;
            }
            Ok(None) if inner.port.is_some() => return Ok(true),
            _ => {}
        }
    }
    let (scope, _server_url) = match current_scope().await {
        Ok(value) => value,
        Err(_) => return Ok(false),
    };
    let runtime = runtime_dir()?;
    let plugins_file = scope.join("plugins").join("plugins.json");
    let entries = merge_plugins_file(&plugins_file, &runtime, &config::data_dir().join("plugins"))?;
    if !entries.any_enabled() {
        return Ok(false);
    }
    let node = resolve_node(app).await?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    prepare_secrets(&scope).await;

    let mut command = Command::new(&node);
    command
        .arg(runtime.join("host.mjs"))
        .arg("--data-dir")
        .arg(&scope)
        .arg("--app-dir")
        .arg(&runtime)
        .arg("--plugins-dir")
        .arg(scope.join("plugins"))
        .arg("--host-version")
        .arg(env!("CARGO_PKG_VERSION"))
        .arg("--token")
        .arg(&token)
        .arg("--secret")
        .arg(&secret)
        .arg("--port")
        .arg("0")
        .env("TRELLIS_BOARD_DATA_DIR", &scope)
        .env("TRELLIS_BOARD_PLUGINS_DIR", scope.join("plugins"))
        .env("TRELLIS_BOARD_SECRETS_FILE", scope.join("secrets.json"))
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动本机插件宿主：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取本机插件宿主输出".to_string())?;
    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                logging::warn(&format!("[plugin-host] {line}"));
            }
        });
    }
    let pid = child.id();
    let port = wait_ready(stdout).await;
    let port = match port {
        Ok(port) => port,
        Err(error) => {
            let _ = child.start_kill();
            crate::agent::process::kill_process_tree(pid).await;
            let _ = tokio::fs::remove_file(scope.join("secrets.json")).await;
            return Err(error);
        }
    };
    let _ = tokio::fs::remove_file(scope.join("secrets.json")).await;
    inner.child = Some(child);
    inner.port = Some(port);
    inner.token = token;
    inner.secret = secret;
    inner.scope = Some(scope);
    logging::info(&format!("本机插件宿主已启动 port={port}"));
    Ok(true)
}

async fn wait_ready(stdout: tokio::process::ChildStdout) -> Result<u16, String> {
    let mut lines = BufReader::new(stdout).lines();
    let read = async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("event").and_then(Value::as_str) != Some("ready") {
                continue;
            }
            if let Some(port) = value.get("port").and_then(Value::as_u64) {
                if port > 0 && port <= u16::MAX as u64 {
                    return Ok(port as u16);
                }
            }
        }
        Err("本机插件宿主未返回就绪端口".to_string())
    };
    match tokio::time::timeout(READY_TIMEOUT, read).await {
        Ok(result) => result,
        Err(_) => Err("本机插件宿主启动超时".to_string()),
    }
}

async fn resolve_node(app: &AppHandle) -> Result<PathBuf, String> {
    let loaded = config::load()?;
    let mut document = json!({
        "nodeRuntime": loaded
            .as_ref()
            .and_then(|config| config.node_runtime.clone())
            .unwrap_or(Value::Null),
    });
    let status = crate::agent::env::check(&config::data_dir(), &mut document)
        .await
        .map_err(|error| error.message)?;
    let detected = status
        .node
        .version
        .clone()
        .or_else(|| status.node.found_version.clone());
    if let Some(version) = detected {
        // 插件宿主复用服务端插件运行时，依赖 node:sqlite（Node 22.5+）。
        if !crate::agent::env::is_version_at_least(&version, PLUGIN_HOST_NODE_VERSION) {
            return Err(format!(
                "本机插件需要 Node.js {PLUGIN_HOST_NODE_VERSION} 或更高，当前 {version}"
            ));
        }
    }
    status
        .node
        .path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            let _ = app;
            "本机插件需要 Node.js 运行环境，请先在环境检查中安装".to_string()
        })
}

async fn prepare_secrets(scope: &Path) {
    let _ = tokio::fs::remove_file(scope.join("secrets.json")).await;
    let Ok(record) = tokio::fs::read_to_string(scope.join("secrets.dpapi")).await else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&record) else {
        return;
    };
    let valid = value.get("schemaVersion").and_then(Value::as_u64)
        == Some(SECRETS_SCHEMA_VERSION as u64)
        && value.get("algorithm").and_then(Value::as_str) == Some(SECRETS_ALGORITHM);
    if !valid {
        logging::warn("本机插件凭据文件格式无效，已忽略");
        return;
    }
    let Some(ciphertext) = value.get("ciphertext").and_then(Value::as_str) else {
        return;
    };
    let Ok(ciphertext) = base64::engine::general_purpose::STANDARD.decode(ciphertext) else {
        logging::warn("本机插件凭据无法解码，已忽略");
        return;
    };
    let plaintext = match dpapi_unprotect(&ciphertext) {
        Ok(value) => value,
        Err(error) => {
            if error.code != "DPAPI_UNAVAILABLE" {
                logging::warn(&format!("本机插件凭据解密失败：{}", error.message));
            }
            return;
        }
    };
    let _ = tokio::fs::create_dir_all(scope.join("plugins")).await;
    let _ = tokio::fs::write(scope.join("secrets.json"), plaintext).await;
}

/// 供后续设置界面写入：DPAPI 保护的凭据 JSON。
#[allow(dead_code)]
pub fn protect_secrets(plaintext: &[u8]) -> Result<Value, String> {
    let ciphertext = dpapi_protect(plaintext).map_err(|error| error.message)?;
    Ok(json!({
        "schemaVersion": SECRETS_SCHEMA_VERSION,
        "algorithm": SECRETS_ALGORITHM,
        "ciphertext": base64::engine::general_purpose::STANDARD.encode(ciphertext),
    }))
}

// ---------------------------------------------------------------- plugins.json

#[derive(Debug, Default, Clone)]
struct PluginEntries {
    enabled: Vec<String>,
}

impl PluginEntries {
    fn any_enabled(&self) -> bool {
        !self.enabled.is_empty()
    }
}

const BUILTIN_PLUGINS: &[(&str, i64)] = &[
    ("acp-dispatch", 10),
    ("witops-core", 20),
    ("accounts-core", 30),
    ("scenario-copilot", 40),
    ("jenkins-ops", 50),
    ("a2a-intake", 60),
];

/// 合并内置清单：保留用户 enable/sort/config，只刷新入口路径与新增插件。
fn merge_plugins_file(
    plugins_file: &Path,
    runtime: &Path,
    user_dir: &Path,
) -> Result<PluginEntries, String> {
    if let Some(parent) = plugins_file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建插件配置目录：{error}"))?;
    }
    let mut document = std::fs::read_to_string(plugins_file)
        .ok()
        .and_then(|text| {
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()
        })
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "version": 1, "plugins": [] }));
    if !document
        .get("plugins")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        document["plugins"] = json!([]);
    }
    let existing = document["plugins"].as_array().cloned().unwrap_or_default();
    let by_id: std::collections::HashMap<String, Value> = existing
        .iter()
        .filter_map(|entry| {
            entry
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_string(), entry.clone()))
        })
        .collect();
    let mut entries: Vec<Value> = Vec::new();
    for (id, sort) in BUILTIN_PLUGINS {
        let mut entry = by_id
            .get(*id)
            .cloned()
            .unwrap_or_else(|| json!({ "id": id, "enabled": false }));
        let override_module = user_dir.join(id).join("index.js");
        let module = if override_module.is_file() && user_dir.join(id).join("plugin.json").is_file()
        {
            override_module
        } else {
            runtime.join("plugins").join(id).join("index.js")
        };
        entry["id"] = json!(id);
        entry["module"] = json!(module.to_string_lossy().to_string());
        if entry.get("sort").and_then(Value::as_i64).is_none() {
            entry["sort"] = json!(sort);
        }
        if let Some(object) = entry.as_object_mut() {
            object.entry("enabled").or_insert(json!(false));
        }
        entries.push(entry);
    }
    // 用户自建插件条目原样保留在末尾，不因内置合并被删。
    for entry in existing {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if BUILTIN_PLUGINS.iter().any(|(builtin, _)| *builtin == id) {
            continue;
        }
        entries.push(entry);
    }
    document["plugins"] = Value::Array(entries.clone());
    let payload = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("无法序列化插件配置：{error}"))?;
    std::fs::write(plugins_file, payload).map_err(|error| format!("无法写入插件配置：{error}"))?;
    let enabled = entries
        .iter()
        .filter(|entry| {
            entry
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    Ok(PluginEntries { enabled })
}

fn read_plugins_file(plugins_file: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(plugins_file)
        .map_err(|error| format!("无法读取插件配置：{error}"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut document: Value =
        serde_json::from_str(text).map_err(|error| format!("插件配置不是合法 JSON：{error}"))?;
    if !document
        .get("plugins")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        document["plugins"] = json!([]);
    }
    Ok(document)
}

fn write_plugins_file(plugins_file: &Path, document: &Value) -> Result<(), String> {
    let payload = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("无法序列化插件配置：{error}"))?;
    let temp = plugins_file.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, payload).map_err(|error| format!("无法写入插件配置：{error}"))?;
    std::fs::rename(&temp, plugins_file).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换插件配置：{error}")
    })
}

// ---------------------------------------------------------------- HTTP 代理

impl HostInner {
    fn base(&self) -> Result<String, String> {
        let port = self.port.ok_or_else(|| "本机插件宿主未运行".to_string())?;
        Ok(format!("http://127.0.0.1:{port}"))
    }
}

async fn request_json(
    state: &PluginHostState,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let (base, token) = {
        let inner = state.inner.lock().await;
        (inner.base()?, inner.token.clone())
    };
    let mut request = state
        .http
        .request(method, format!("{base}{path}"))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("本机插件宿主请求失败：{error}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取本机插件响应失败：{error}"))?;
    let payload: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({ "error": text }));
    if status.is_success() {
        Ok(payload)
    } else {
        let message = payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("本机插件宿主返回错误");
        Err(message.to_string())
    }
}

async fn running_snapshot(state: &PluginHostState) -> Option<(String, String, u16)> {
    let inner = state.inner.lock().await;
    Some((inner.base().ok()?, inner.secret.clone(), inner.port?))
}

async fn push_repositories(app: &AppHandle) -> Result<(), String> {
    let state = state(app)?;
    if running_snapshot(&state).await.is_none() {
        return Ok(());
    }
    let associations = crate::agent_service::list_associations(app).await?;
    let repositories: Vec<Value> = associations
        .iter()
        .filter(|association| {
            association.status == "approved"
                && !association.read_only
                && !association.detach_pending
        })
        .map(|association| {
            json!({
                "id": association.project_id,
                "name": association.display_name,
                "path": association.repo_path,
                "branch": association.branch_name,
            })
        })
        .collect();
    request_json(
        &state,
        reqwest::Method::POST,
        "/internal/repositories",
        Some(json!({ "repositories": repositories })),
    )
    .await
    .map(|_| ())
}

async fn reload_with_secrets(app: &AppHandle) -> Result<Value, String> {
    let state = state(app)?;
    let scope = {
        let inner = state.inner.lock().await;
        inner.scope.clone()
    };
    if let Some(scope) = scope.as_deref() {
        prepare_secrets(scope).await;
    }
    let result = request_json(
        &state,
        reqwest::Method::POST,
        "/internal/reload",
        Some(json!({})),
    )
    .await;
    if let Some(scope) = scope.as_deref() {
        let _ = tokio::fs::remove_file(scope.join("secrets.json")).await;
    }
    let value = result?;
    let _ = push_repositories(app).await;
    Ok(value)
}

// ---------------------------------------------------------------- Tauri 命令

#[tauri::command]
pub async fn desktop_plugins_list(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    caller(&app, &window)?;
    let state = state(&app)?;
    let running = ensure_running(&app).await?;
    if !running {
        let file = current_scope()
            .await
            .ok()
            .map(|(scope, _)| scope.join("plugins").join("plugins.json"));
        let plugins = file
            .as_deref()
            .and_then(|path| read_plugins_file(path).ok())
            .and_then(|document| {
                document
                    .get("plugins")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| {
                                json!({
                                    "id": entry.get("id").cloned().unwrap_or(Value::Null),
                                    "name": entry.get("id").cloned().unwrap_or(Value::Null),
                                    "version": Value::Null,
                                    "apiVersion": Value::Null,
                                    "compatible": true,
                                    "reason": Value::Null,
                                    "enabled": entry.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                                    "sort": entry.get("sort").cloned().unwrap_or(Value::Null),
                                    "status": "stopped",
                                    "pid": Value::Null,
                                    "restarts": 0,
                                    "lastError": Value::Null,
                                })
                            })
                            .collect::<Vec<_>>()
                    })
            })
            .unwrap_or_default();
        return Ok(json!({
            "disabled": false,
            "running": false,
            "hostVersion": env!("CARGO_PKG_VERSION"),
            "plugins": plugins,
        }));
    }
    let list = request_json(&state, reqwest::Method::GET, "/internal/plugins", None).await?;
    let _ = push_repositories(&app).await;
    let mut payload = list;
    payload["running"] = json!(true);
    Ok(payload)
}

#[tauri::command]
pub async fn desktop_plugin_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    enabled: bool,
) -> Result<Value, String> {
    caller(&app, &window)?;
    let (scope, _) = current_scope().await?;
    let plugins_file = scope.join("plugins").join("plugins.json");
    let runtime = runtime_dir()?;
    merge_plugins_file(&plugins_file, &runtime, &config::data_dir().join("plugins"))?;
    let mut document = read_plugins_file(&plugins_file)?;
    let entries = document["plugins"]
        .as_array_mut()
        .ok_or_else(|| "插件配置缺少 plugins 数组".to_string())?;
    let entry = entries
        .iter_mut()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(plugin_id.as_str()))
        .ok_or_else(|| format!("未知插件: {plugin_id}"))?;
    entry["enabled"] = json!(enabled);
    write_plugins_file(&plugins_file, &document)?;

    let any_enabled = document["plugins"]
        .as_array()
        .map(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !any_enabled {
        stop(&app).await;
        return Ok(json!({ "ok": true, "running": false }));
    }
    if !ensure_running(&app).await? {
        return Ok(json!({ "ok": true, "running": false }));
    }
    reload_with_secrets(&app).await?;
    Ok(json!({ "ok": true, "running": true }))
}

#[tauri::command]
pub async fn desktop_plugin_reorder(
    app: AppHandle,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<Value, String> {
    caller(&app, &window)?;
    if !ensure_running(&app).await? {
        return Err("本机插件宿主未运行".to_string());
    }
    let state = state(&app)?;
    request_json(
        &state,
        reqwest::Method::POST,
        "/internal/plugins/order",
        Some(json!({ "ids": ids })),
    )
    .await
}

#[tauri::command]
pub async fn desktop_plugin_logs(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    tail: Option<u32>,
) -> Result<Value, String> {
    caller(&app, &window)?;
    if !ensure_running(&app).await? {
        return Ok(json!({ "entries": [] }));
    }
    let state = state(&app)?;
    let tail = tail.unwrap_or(200).clamp(1, 2000);
    request_json(
        &state,
        reqwest::Method::GET,
        &format!(
            "/internal/plugins/{}/logs?tail={tail}",
            encode_segment(&plugin_id)
        ),
        None,
    )
    .await
}

#[tauri::command]
pub async fn desktop_plugin_panels(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    caller(&app, &window)?;
    if !ensure_running(&app).await? {
        return Ok(json!({ "panels": [], "running": false }));
    }
    let state = state(&app)?;
    let _ = push_repositories(&app).await;
    let payload = request_json(&state, reqwest::Method::GET, "/internal/panels", None).await?;
    let (base, secret, _port) = running_snapshot(&state)
        .await
        .ok_or_else(|| "本机插件宿主未运行".to_string())?;
    let panels = payload
        .get("panels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|mut panel| {
            let plugin_id = panel
                .get("pluginId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let src = panel.get("src").and_then(Value::as_str).unwrap_or_default();
            let rewritten = src.replacen("/api/plugins/", &format!("/s/{secret}/"), 1);
            panel["host"] = json!("desktop");
            panel["src"] = json!(format!("{base}{rewritten}"));
            panel["eventsSrc"] = json!(format!(
                "{base}/s/{secret}/__events?topics={}",
                encode_segment(&plugin_id)
            ));
            panel
        })
        .collect::<Vec<_>>();
    Ok(json!({ "panels": panels, "running": true }))
}

#[tauri::command]
pub async fn desktop_plugin_request(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    caller(&app, &window)?;
    if !path.starts_with('/') {
        return Err("插件请求路径必须以 / 开头".to_string());
    }
    if !ensure_running(&app).await? {
        return Err("本机插件宿主未运行".to_string());
    }
    let state = state(&app)?;
    let (base, token) = {
        let inner = state.inner.lock().await;
        (inner.base()?, inner.token.clone())
    };
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("不支持的请求方法: {method}"))?;
    let mut request = state
        .http
        .request(
            method,
            format!("{base}/api/plugins/{}{path}", encode_segment(&plugin_id)),
        )
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("插件请求失败：{error}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_string();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取插件响应失败：{error}"))?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    let data = if content_type.contains("json") {
        serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))
    } else {
        Value::String(text)
    };
    Ok(json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "contentType": content_type,
        "data": data,
    }))
}

#[tauri::command]
pub async fn desktop_plugin_asset(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    path: String,
) -> Result<Value, String> {
    caller(&app, &window)?;
    if !ensure_running(&app).await? {
        return Err("本机插件宿主未运行".to_string());
    }
    let state = state(&app)?;
    let (base, secret) = {
        let inner = state.inner.lock().await;
        (inner.base()?, inner.secret.clone())
    };
    let clean = path.trim_start_matches('/');
    let url = format!("{base}/s/{secret}/{}/{}", encode_segment(&plugin_id), clean);
    let response = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|error| format!("读取面板资源失败：{error}"))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let text = response
        .text()
        .await
        .map_err(|error| format!("读取面板资源失败：{error}"))?;
    Ok(json!({ "status": status, "contentType": content_type, "content": text }))
}

fn encode_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
