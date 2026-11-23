use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::agent::env::{self, RuntimeInstallResult, RuntimeStatus};
use crate::config;
use crate::logging;

fn client_document_path() -> std::path::PathBuf {
    config::config_path()
}

fn load_client_document() -> Value {
    let path = client_document_path();
    let text = std::fs::read_to_string(&path).ok();
    text.as_deref()
        .and_then(|text| {
            serde_json::from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(text)).ok()
        })
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "schemaVersion": config::SCHEMA_VERSION }))
}

fn save_client_document(document: &Value) -> Result<(), String> {
    config::ensure_directories().inspect_err(|error| logging::warn(error))?;
    let path = client_document_path();
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(document).map_err(|error| {
        let message = format!("无法序列化运行时配置: {error}");
        logging::warn(&message);
        message
    })?;
    std::fs::write(&temp, payload).map_err(|error| {
        let message = format!("无法写入运行时配置 {}: {error}", temp.display());
        logging::warn(&message);
        message
    })?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        let message = format!("无法替换运行时配置 {}: {error}", path.display());
        logging::warn(&message);
        message
    })
}

fn component_summary(
    ok: bool,
    version: &Option<String>,
    source: &Option<String>,
    found_version: &Option<String>,
) -> String {
    if ok {
        format!(
            "{}/{}",
            version.as_deref().unwrap_or("?"),
            source.as_deref().unwrap_or("?")
        )
    } else if let Some(found) = found_version {
        format!("found={found}")
    } else {
        "missing".to_string()
    }
}

fn log_runtime_status(status: &RuntimeStatus) {
    let node = component_summary(
        status.node.ok,
        &status.node.version,
        &status.node.source,
        &status.node.found_version,
    );
    let trellis = component_summary(
        status.trellis.ok,
        &status.trellis.version,
        &status.trellis.source,
        &status.trellis.found_version,
    );
    let python = component_summary(
        status.python.ok,
        &status.python.version,
        &status.python.source,
        &status.python.found_version,
    );
    logging::info(&format!(
        "运行环境检查 state={:?} node={node} trellis={trellis} python={python}",
        status.state
    ));
}

fn log_error(scope: &str, error: &crate::agent::protocol::AgentError) {
    logging::warn(&format!(
        "{scope}失败 code={} message={} details={}",
        error.code,
        error.message,
        error
            .details
            .as_ref()
            .map(Value::to_string)
            .unwrap_or_else(|| "-".to_string())
    ));
}

pub async fn runtime_status() -> Result<RuntimeStatus, String> {
    let data_dir = config::data_dir();
    let mut document = load_client_document();
    let before = document.clone();
    let status = env::check(&data_dir, &mut document)
        .await
        .map_err(|error| {
            log_error("运行环境检查", &error);
            error.message
        })?;
    log_runtime_status(&status);
    document["schemaVersion"] = json!(config::SCHEMA_VERSION);
    if document != before {
        let _ = save_client_document(&document);
    }
    Ok(status)
}

/// 先写 flag 再 `check`：`check` 会直接复用刚验证过的 flag，不重复跑版本探测。
pub async fn runtime_set_node_path(path: String) -> Result<RuntimeStatus, String> {
    let data_dir = config::data_dir();
    let mut document = load_client_document();
    env::set_node_path(&mut document, &path)
        .await
        .map_err(|error| {
            log_error("设置 Node.js 路径", &error);
            error.message
        })?;
    let status = env::check(&data_dir, &mut document)
        .await
        .map_err(|error| {
            log_error("运行环境检查", &error);
            error.message
        })?;
    save_client_document(&document)?;
    Ok(status)
}

pub async fn runtime_install(app: AppHandle) -> Result<RuntimeInstallResult, String> {
    let data_dir = config::data_dir();
    let emitter = app.clone();
    let mut document = load_client_document();
    let result = env::install(&data_dir, &mut document, move |stage, message| {
        let _ = emitter.emit(
            "runtime-progress",
            json!({ "stage": stage, "message": message }),
        );
    })
    .await
    .map_err(|error| {
        log_error("运行环境安装", &error);
        error.message
    })?;
    document["schemaVersion"] = json!(config::SCHEMA_VERSION);
    let _ = save_client_document(&document);
    let _ = app.emit(
        "runtime-progress",
        json!({ "stage": "ready", "message": "运行环境已就绪" }),
    );
    Ok(result)
}

#[cfg(test)]
mod tests;
