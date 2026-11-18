//! 首次启动环境门：Node.js、Trellis CLI 与 Python 的检查、下载与安装。
//!
//! 对应设计文档 `design.md` 第 5 节。纯 Rust + serde_json，不引用 tauri 类型。

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::agent::process::{run_process, ProcessOptions, ProcessOutput};
use crate::agent::protocol::{self, code, AgentError, AgentResult};

pub const NODE_DOWNLOAD_VERSION: &str = "24.22.3";
pub const NODE_MIN_VERSION: &str = "18.17.0";
pub const TRELLIS_VERSION: &str = "0.6.17";
pub const TRELLIS_PACKAGE: &str = "@mindfoldhq/trellis";
pub const NODE_ZIP_URL: &str =
    "https://registry.npmmirror.com/-/binary/node/v24.22.3/node-v24.22.3-win-x64.zip";
pub const NODE_ZIP_SHA256: &str =
    "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f";

pub const CODE_DOWNLOAD_FAILED: &str = "NODE_DOWNLOAD_FAILED";
pub const CODE_DOWNLOAD_CORRUPT: &str = "NODE_DOWNLOAD_CORRUPT";
pub const CODE_EXTRACT_FAILED: &str = "NODE_EXTRACT_FAILED";
pub const CODE_NODE_INVALID: &str = "NODE_INVALID";
pub const CODE_TRELLIS_INSTALL_FAILED: &str = "TRELLIS_INSTALL_FAILED";

pub const PYTHON_MIN_VERSION: &str = "3.9.0";
pub const PYTHON_INSTALL_VERSION: &str = "3.12.8";
pub const PYTHON_INSTALLER_URL: &str =
    "https://www.python.org/ftp/python/3.12.8/python-3.12.8-amd64.exe";
pub const PYTHON_INSTALLER_SHA256: &str =
    "71bd44e6b0e91c17558963557e4cdb80b483de9b0a0a9717f06cf896f95ab598";
pub const PYTHON_INSTALLER_ARGS: &[&str] = &[
    "/quiet",
    "InstallAllUsers=0",
    "PrependPath=1",
    "Include_launcher=1",
    "InstallLauncherAllUsers=0",
    "Include_test=0",
    "Include_doc=0",
    "Shortcuts=0",
];
pub const PYTHON_INSTALLER_FILE: &str = "python-3.12.8-amd64.exe";
pub const CODE_PYTHON_INVALID: &str = "PYTHON_INVALID";
pub const PYTHON_PAGE_URL: &str = "https://www.python.org/downloads/";

const PYTHON_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PYTHON_INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const PYTHON_INSTALL_HEARTBEAT: Duration = Duration::from_secs(5);
const PYTHON_EXIT_REBOOT_REQUIRED: i32 = 3010;

const NODE_ZIP_ROOT: &str = "node-v24.22.3-win-x64/";
const MAX_ZIP_BYTES: u64 = 134_217_728;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const NODE_VALIDATE_TIMEOUT: Duration = Duration::from_secs(10);
const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const ERROR_TAIL_CHARS: usize = 2048;

// ---------------------------------------------------------------- 路径

pub fn runtime_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("runtime")
}

pub fn node_exe_path(data_dir: &Path) -> PathBuf {
    runtime_dir(data_dir).join("node").join("node.exe")
}

pub fn npm_global_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("npm-global")
}

pub fn trellis_cli_path(data_dir: &Path) -> PathBuf {
    npm_global_dir(data_dir)
        .join("node_modules")
        .join("@mindfoldhq")
        .join("trellis")
        .join("bin")
        .join("trellis.js")
}

pub fn download_dir(data_dir: &Path) -> PathBuf {
    runtime_dir(data_dir).join("download")
}

// ---------------------------------------------------------------- 状态模型

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeState {
    Checking,
    Ready,
    NeedsSetup,
    Installing,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatus {
    pub ok: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: Option<String>,
    pub min_version: String,
    pub found_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrellisStatus {
    pub ok: bool,
    pub version: Option<String>,
    pub cli_path: Option<String>,
    pub source: Option<String>,
    pub required_version: String,
    pub found_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonStatus {
    pub ok: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub source: Option<String>,
    pub min_version: String,
    pub found_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInfo {
    pub version: String,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub node: NodeStatus,
    pub trellis: TrellisStatus,
    pub python: PythonStatus,
    pub download: DownloadInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInstallResult {
    pub node_version: String,
    pub trellis_version: String,
    pub python_version: String,
}

// `client.json` 中的 flag（schema 3，snake_case 字段名）。

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRuntimeFlag {
    pub version: String,
    pub path: String,
    pub source: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrellisRuntimeFlag {
    pub version: String,
    pub cli_path: String,
    pub source: String,
    pub installed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonRuntimeFlag {
    pub version: String,
    pub path: String,
    pub source: String,
    pub installed_at: String,
}

/// `client.json` 的最小抽象：只关心三个运行时 flag。
///
/// 已为 [`Value`]（整份 client.json 解析结果）实现；tauri 侧的结构体可在
/// `config.rs` 内实现同一 trait（本模块不允许修改其它文件）。
pub trait ClientConfigLike {
    fn node_runtime(&self) -> Option<NodeRuntimeFlag>;
    fn trellis_runtime(&self) -> Option<TrellisRuntimeFlag>;
    fn python_runtime(&self) -> Option<PythonRuntimeFlag>;
    fn set_node_runtime(&mut self, value: Option<NodeRuntimeFlag>);
    fn set_trellis_runtime(&mut self, value: Option<TrellisRuntimeFlag>);
    fn set_python_runtime(&mut self, value: Option<PythonRuntimeFlag>);
}

impl ClientConfigLike for Value {
    fn node_runtime(&self) -> Option<NodeRuntimeFlag> {
        serde_json::from_value(self.get("node_runtime")?.clone()).ok()
    }

    fn trellis_runtime(&self) -> Option<TrellisRuntimeFlag> {
        serde_json::from_value(self.get("trellis_runtime")?.clone()).ok()
    }

    fn python_runtime(&self) -> Option<PythonRuntimeFlag> {
        serde_json::from_value(self.get("python_runtime")?.clone()).ok()
    }

    fn set_node_runtime(&mut self, value: Option<NodeRuntimeFlag>) {
        set_flag(self, "node_runtime", value);
    }

    fn set_trellis_runtime(&mut self, value: Option<TrellisRuntimeFlag>) {
        set_flag(self, "trellis_runtime", value);
    }

    fn set_python_runtime(&mut self, value: Option<PythonRuntimeFlag>) {
        set_flag(self, "python_runtime", value);
    }
}

fn set_flag<T: Serialize>(document: &mut Value, key: &str, value: Option<T>) {
    let Some(object) = document.as_object_mut() else {
        return;
    };
    match value {
        Some(flag) => {
            if let Ok(payload) = serde_json::to_value(&flag) {
                object.insert(key.to_string(), payload);
            }
        }
        None => {
            object.remove(key);
        }
    }
}

// ---------------------------------------------------------------- 版本

pub fn parse_version(value: &str) -> Option<String> {
    let line = value.lines().next()?.trim();
    let trimmed = line
        .strip_prefix('v')
        .or_else(|| line.strip_prefix('V'))
        .unwrap_or(line)
        .trim();
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    Some(trimmed.to_string())
}

pub fn parse_python_version(value: &str) -> Option<String> {
    let line = value.lines().next()?.trim();
    let trimmed = line.strip_prefix("Python ").unwrap_or(line).trim();
    // `python --version` 可能输出 `3.12`，补 `.0` 后再走通用解析。
    let normalized = if trimmed.split('.').count() == 2 {
        format!("{trimmed}.0")
    } else {
        trimmed.to_string()
    };
    parse_version(&normalized)
}

pub fn is_version_at_least(found: &str, minimum: &str) -> bool {
    matches!(
        protocol::compare_versions(found.trim_start_matches(['v', 'V']), minimum,),
        Some(0) | Some(1)
    )
}

pub fn verify_hash(actual: &str, expected: &str, stage: &str) -> AgentResult<()> {
    if actual.eq_ignore_ascii_case(expected) {
        return Ok(());
    }
    Err(AgentError::new(CODE_DOWNLOAD_CORRUPT, "下载文件校验失败")
        .retryable(true)
        .with_details(Some(json!({
            "stage": stage,
            "expected": expected,
            "actual": actual,
        }))))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

mod install;
mod probe;

pub use install::*;
pub use probe::*;

#[cfg(test)]
mod tests;
