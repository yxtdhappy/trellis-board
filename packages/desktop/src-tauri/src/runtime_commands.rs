use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::agent::env::{self, RuntimeInstallResult, RuntimeStatus};
use crate::config;

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
    config::ensure_directories()?;
    let path = client_document_path();
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(document)
        .map_err(|error| format!("无法序列化运行时配置: {error}"))?;
    std::fs::write(&temp, payload).map_err(|error| format!("无法写入运行时配置: {error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换运行时配置 {}: {error}", path.display())
    })
}

pub async fn runtime_status() -> Result<RuntimeStatus, String> {
    let data_dir = config::data_dir();
    let mut document = load_client_document();
    let before = document.clone();
    let status = env::check(&data_dir, &mut document)
        .await
        .map_err(|error| error.message)?;
    if document != before {
        let _ = save_client_document(&document);
    }
    Ok(status)
}

pub async fn runtime_install(app: AppHandle) -> Result<RuntimeInstallResult, String> {
    let data_dir = config::data_dir();
    let emitter = app.clone();
    let result = env::install(&data_dir, move |stage, message| {
        let _ = emitter.emit(
            "runtime-progress",
            json!({ "stage": stage, "message": message }),
        );
    })
    .await
    .map_err(|error| error.message)?;
    let mut document = load_client_document();
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
