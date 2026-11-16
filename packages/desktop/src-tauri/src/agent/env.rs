//! 首次启动环境门：Node.js、Trellis CLI 与 Python 的检查、下载与安装。
//!
//! 对应设计文档 `design.md` 第 5 节。纯 Rust + serde_json，不引用 tauri 类型。

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
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

// ---------------------------------------------------------------- PATH 探测

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

fn subdirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// PATH 之外还要找目录：客户端由资源管理器启动时，`PATH` 是机器/用户环境变量，
/// 不含 fnm、nvm、Volta 这类按 shell 注入的目录，但它们的前缀目录就在用户目录里。
fn fallback_dirs_in(
    app_data: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(app_data) = app_data {
        let fnm = app_data.join("fnm");
        // fnm：`aliases/<别名>` 是该版本的前缀目录（node.exe + node_modules 都在里面），
        // `node-versions/<版本>/installation` 是未设别名时的兜底。
        dirs.extend(subdirs(&fnm.join("aliases")));
        dirs.extend(
            subdirs(&fnm.join("node-versions"))
                .into_iter()
                .map(|dir| dir.join("installation")),
        );
        dirs.push(app_data.join("nvm"));
    }
    if let Some(local_app_data) = local_app_data {
        dirs.push(local_app_data.join("Programs").join("nodejs"));
        dirs.push(local_app_data.join("Volta").join("bin"));
    }
    if let Some(program_files) = program_files {
        dirs.push(program_files.join("nodejs"));
    }
    dirs
}

fn fallback_dirs() -> Vec<PathBuf> {
    fallback_dirs_in(
        env_dir("APPDATA").as_deref(),
        env_dir("LOCALAPPDATA").as_deref(),
        env_dir("ProgramFiles").as_deref(),
    )
}

fn probe_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_dirs();
    dirs.extend(fallback_dirs());
    let mut unique: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !dir.as_os_str().is_empty() && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

pub fn find_in_path(dirs: &[PathBuf], executable: &str) -> Option<PathBuf> {
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(executable);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn shell_exe() -> PathBuf {
    std::env::var("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Windows\\System32\\cmd.exe"))
}

/// 读取 `<pkg>/bin/trellis.js` 所在包的 `package.json` 版本。
pub fn read_package_version(cli_path: &Path) -> Option<String> {
    let package_root = cli_path.parent()?.parent()?;
    let text = std::fs::read_to_string(package_root.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let version = value.get("version")?.as_str()?.trim();
    parse_version(version)
}

async fn node_version_at(executable: &Path) -> Option<String> {
    if !executable.is_file() {
        return None;
    }
    let output = run_process(
        executable,
        &["--version"],
        &ProcessOptions {
            timeout: Some(NODE_VALIDATE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    parse_version(&output.stdout)
}

/// 前缀目录里的全局 Trellis CLI：优先全局包，其次 `trellis.cmd` 里的真实路径。
fn trellis_cli_in(dir: &Path) -> Option<(PathBuf, &'static str)> {
    let cli = dir
        .join("node_modules")
        .join("@mindfoldhq")
        .join("trellis")
        .join("bin")
        .join("trellis.js");
    if cli.is_file() {
        return Some((cli, "global"));
    }
    trellis_from_cmd(&dir.join("trellis.cmd")).map(|cli| (cli, "path"))
}

fn trellis_from_cmd(cmd: &Path) -> Option<PathBuf> {
    if let Ok(text) = std::fs::read_to_string(cmd) {
        for token in text.split(|character: char| character == '"' || character.is_whitespace()) {
            let lower = token.to_ascii_lowercase();
            if !lower.ends_with("trellis.js") {
                continue;
            }
            let mut candidate = PathBuf::from(token.replace('\\', "/"));
            if candidate.is_relative() {
                if let Some(parent) = cmd.parent() {
                    candidate = parent.join(candidate);
                }
            }
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let sibling = cmd
        .parent()?
        .join("node_modules")
        .join("@mindfoldhq")
        .join("trellis")
        .join("bin")
        .join("trellis.js");
    sibling.is_file().then_some(sibling)
}

// ---------------------------------------------------------------- check

pub async fn check<C: ClientConfigLike>(
    data_dir: &Path,
    config: &mut C,
) -> AgentResult<RuntimeStatus> {
    let node = resolve_node(config).await;
    let trellis = resolve_trellis(data_dir, config).await;
    let python = resolve_python(config).await;
    let state = if node.ok && trellis.ok && python.ok {
        RuntimeState::Ready
    } else {
        RuntimeState::NeedsSetup
    };
    let zip = download_dir(data_dir).join("node.zip");
    let part = download_dir(data_dir).join("node.zip.part");
    let bytes = [&zip, &part]
        .into_iter()
        .find_map(|path| std::fs::metadata(path).ok().map(|meta| meta.len()));
    Ok(RuntimeStatus {
        state,
        node,
        trellis,
        python,
        download: DownloadInfo {
            version: NODE_DOWNLOAD_VERSION.to_string(),
            bytes,
        },
    })
}

async fn resolve_node<C: ClientConfigLike>(config: &mut C) -> NodeStatus {
    if let Some(flag) = config.node_runtime() {
        if Path::new(&flag.path).is_file() {
            let version = parse_version(&flag.version);
            let ok = version
                .as_deref()
                .map(|value| is_version_at_least(value, NODE_MIN_VERSION))
                .unwrap_or(false);
            return NodeStatus {
                ok,
                version: if ok { version.clone() } else { None },
                path: Some(flag.path),
                source: Some("client".to_string()),
                min_version: NODE_MIN_VERSION.to_string(),
                found_version: if ok { None } else { version },
            };
        }
        // flag 失效（文件被删）→ 清空后重新探测，自愈。
        config.set_node_runtime(None);
    }

    let missing = NodeStatus {
        ok: false,
        version: None,
        path: None,
        source: None,
        min_version: NODE_MIN_VERSION.to_string(),
        found_version: None,
    };

    // 逐个候选目录试 `node --version`：有的候选是旧版本或缺依赖，只在全部不合格时
    // 用第一个找到的报「版本过低」。
    let mut outdated: Option<NodeStatus> = None;
    for dir in probe_dirs() {
        let executable = dir.join("node.exe");
        if !executable.is_file() {
            continue;
        }
        let Some(version) = node_version_at(&executable).await else {
            continue;
        };
        if !is_version_at_least(&version, NODE_MIN_VERSION) {
            outdated.get_or_insert(NodeStatus {
                ok: false,
                version: None,
                path: Some(executable.display().to_string()),
                source: Some("path".to_string()),
                min_version: NODE_MIN_VERSION.to_string(),
                found_version: Some(version),
            });
            continue;
        }
        // 探测到的路径同时写回 flag：Agent 侧只认 flag，不重新探测。
        config.set_node_runtime(Some(NodeRuntimeFlag {
            version: version.clone(),
            path: executable.display().to_string(),
            source: "path".to_string(),
            installed_at: protocol::now_iso8601(),
        }));
        return NodeStatus {
            ok: true,
            version: Some(version),
            path: Some(executable.display().to_string()),
            source: Some("path".to_string()),
            min_version: NODE_MIN_VERSION.to_string(),
            found_version: None,
        };
    }
    outdated.unwrap_or(missing)
}

fn trellis_status(cli_path: &Path, source: &str) -> TrellisStatus {
    let version = read_package_version(cli_path);
    let ok = version
        .as_deref()
        .map(|value| is_version_at_least(value, TRELLIS_VERSION))
        .unwrap_or(false);
    TrellisStatus {
        ok,
        version: if ok { version.clone() } else { None },
        cli_path: Some(cli_path.display().to_string()),
        source: Some(source.to_string()),
        required_version: TRELLIS_VERSION.to_string(),
        found_version: if ok { None } else { version },
    }
}

async fn resolve_trellis<C: ClientConfigLike>(data_dir: &Path, config: &mut C) -> TrellisStatus {
    if let Some(flag) = config.trellis_runtime() {
        let cli = PathBuf::from(&flag.cli_path);
        if cli.is_file() {
            let source = if flag.source.is_empty() {
                "client-prefix"
            } else {
                flag.source.as_str()
            };
            return trellis_status(&cli, source);
        }
        config.set_trellis_runtime(None);
    }

    let client_prefix = trellis_cli_path(data_dir);
    if client_prefix.is_file() {
        return trellis_status(&client_prefix, "client-prefix");
    }

    // 全局包就挂在 node.exe 同级（`npm root -g` 的前缀目录），逐个候选目录看一遍；
    // 不跑 `npm root -g`：npm.cmd 内部的 `node` 同样依赖 PATH，解析不出来时只会更糟。
    let mut outdated: Option<TrellisStatus> = None;
    for dir in probe_dirs() {
        let Some((cli, source)) = trellis_cli_in(&dir) else {
            continue;
        };
        let status = trellis_status(&cli, source);
        if !status.ok {
            outdated.get_or_insert(status);
            continue;
        }
        config.set_trellis_runtime(Some(TrellisRuntimeFlag {
            version: status.version.clone().unwrap_or_default(),
            cli_path: cli.display().to_string(),
            source: source.to_string(),
            installed_at: protocol::now_iso8601(),
        }));
        return status;
    }

    outdated.unwrap_or(TrellisStatus {
        ok: false,
        version: None,
        cli_path: None,
        source: None,
        required_version: TRELLIS_VERSION.to_string(),
        found_version: None,
    })
}

// ---------------------------------------------------------------- Python

async fn python_version_at(program: &Path, args: &[&str]) -> Option<String> {
    let mut argv: Vec<&str> = args.to_vec();
    argv.push("--version");
    let output = run_process(
        program,
        &argv,
        &ProcessOptions {
            timeout: Some(PYTHON_PROBE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    // 3.9 及更早写 stderr，3.10 起写 stdout。
    parse_python_version(&output.stdout).or_else(|| parse_python_version(&output.stderr))
}

fn python_status(version: &str, path: &Path, source: &str) -> PythonStatus {
    let ok = is_version_at_least(version, PYTHON_MIN_VERSION);
    PythonStatus {
        ok,
        version: ok.then(|| version.to_string()),
        path: Some(path.display().to_string()),
        source: Some(source.to_string()),
        min_version: PYTHON_MIN_VERSION.to_string(),
        found_version: if ok { None } else { Some(version.to_string()) },
    }
}

/// `py -3` 只代表启动器的默认解释器；解析成真实的 `python.exe`，客户端才能直接调用。
async fn py_launcher_target() -> Option<(PathBuf, String)> {
    let output = run_process(
        Path::new("py"),
        &[
            "-3",
            "-c",
            "import sys; print(sys.executable); print(sys.version.split()[0])",
        ],
        &ProcessOptions {
            timeout: Some(PYTHON_PROBE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    let mut lines = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let executable = PathBuf::from(lines.next()?);
    let version = parse_python_version(lines.next()?)?;
    Some((executable, version))
}

async fn resolve_python<C: ClientConfigLike>(config: &mut C) -> PythonStatus {
    let mut outdated: Option<PythonStatus> = None;
    if let Some(flag) = config.python_runtime() {
        let executable = PathBuf::from(&flag.path);
        if executable.is_file() {
            match python_version_at(&executable, &[]).await {
                Some(version) if is_version_at_least(&version, PYTHON_MIN_VERSION) => {
                    return python_status(&version, &executable, "client");
                }
                Some(version) => outdated = Some(python_status(&version, &executable, "client")),
                None => {}
            }
        } else {
            // flag 失效（文件被删/换机器）→ 清空后重新探测，自愈。
            config.set_python_runtime(None);
        }
    }

    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(value) = std::env::var_os("TRELLIS_PYTHON") {
        candidates.push((PathBuf::from(value), "env"));
    }
    if let Some(found) = find_in_path(&path_dirs(), "python.exe") {
        candidates.push((found, "path"));
    }

    let mut found: Option<(PathBuf, String, &'static str)> = None;
    for (program, source) in candidates {
        let Some(version) = python_version_at(&program, &[]).await else {
            continue;
        };
        if is_version_at_least(&version, PYTHON_MIN_VERSION) {
            found = Some((program, version, source));
            break;
        }
        outdated.get_or_insert(python_status(&version, &program, source));
    }
    if found.is_none() {
        if let Some((executable, version)) = py_launcher_target().await {
            if is_version_at_least(&version, PYTHON_MIN_VERSION) {
                found = Some((executable, version, "py-launcher"));
            } else {
                outdated.get_or_insert(python_status(&version, &executable, "py-launcher"));
            }
        }
    }

    match found {
        Some((executable, version, source)) => {
            // 探测到的解释器写回 flag：客户端执行 task.py 时只认 flag。
            config.set_python_runtime(Some(PythonRuntimeFlag {
                version: version.clone(),
                path: executable.display().to_string(),
                source: source.to_string(),
                installed_at: protocol::now_iso8601(),
            }));
            python_status(&version, &executable, source)
        }
        None => outdated.unwrap_or(PythonStatus {
            ok: false,
            version: None,
            path: None,
            source: None,
            min_version: PYTHON_MIN_VERSION.to_string(),
            found_version: None,
        }),
    }
}

// ---------------------------------------------------------------- install

pub async fn install(
    data_dir: &Path,
    mut on_progress: impl FnMut(&str, &str) + Send,
) -> AgentResult<RuntimeInstallResult> {
    let node_path = node_exe_path(data_dir);
    let node_version = match node_version_at(&node_path).await {
        Some(version) => {
            on_progress("node:validate", &format!("Node.js {version} 已就绪"));
            version
        }
        None => install_node(data_dir, &mut on_progress).await?,
    };
    if !is_version_at_least(&node_version, NODE_MIN_VERSION) {
        return Err(AgentError::new(
            CODE_NODE_INVALID,
            format!("Node.js 版本过低: {node_version}"),
        )
        .with_details(Some(json!({ "stage": "node:validate" }))));
    }

    let cli_path = trellis_cli_path(data_dir);
    let existing = read_package_version(&cli_path)
        .filter(|version| is_version_at_least(version, TRELLIS_VERSION));
    let trellis_version = match existing {
        Some(version) => {
            on_progress("trellis:validate", &format!("Trellis CLI {version} 已就绪"));
            version
        }
        None => {
            on_progress("trellis:install", "正在安装 Trellis CLI");
            install_trellis(data_dir, &node_path, &mut on_progress).await?;
            on_progress("trellis:validate", "正在校验 Trellis CLI");
            let version = read_package_version(&cli_path).ok_or_else(|| {
                AgentError::new(code::MISSING_TRELLIS, "Trellis CLI 安装后未找到")
                    .with_details(Some(json!({ "stage": "trellis:validate" })))
            })?;
            if !is_version_at_least(&version, TRELLIS_VERSION) {
                return Err(AgentError::new(
                    code::MISSING_TRELLIS,
                    format!("Trellis CLI 版本过低: {version}"),
                )
                .with_details(Some(json!({ "stage": "trellis:validate" }))));
            }
            version
        }
    };

    let (python_path, python_version) = match installed_python().await {
        Some((path, version)) => {
            on_progress("python:validate", &format!("Python {version} 已就绪"));
            (path, version)
        }
        None => install_python(data_dir, &mut on_progress).await?,
    };

    on_progress("write-flag", "正在保存运行时配置");
    let installed_at = protocol::now_iso8601();
    write_runtime_flags(
        data_dir,
        &NodeRuntimeFlag {
            version: node_version.clone(),
            path: node_path.display().to_string(),
            source: "downloaded".to_string(),
            installed_at: installed_at.clone(),
        },
        &TrellisRuntimeFlag {
            version: trellis_version.clone(),
            cli_path: cli_path.display().to_string(),
            source: "client-prefix".to_string(),
            installed_at: installed_at.clone(),
        },
        &PythonRuntimeFlag {
            version: python_version.clone(),
            path: python_path.display().to_string(),
            source: "installed".to_string(),
            installed_at,
        },
    )?;

    on_progress(
        "ready",
        &format!("Node.js {node_version} · Trellis CLI {trellis_version} · Python {python_version} 已就绪"),
    );
    Ok(RuntimeInstallResult {
        node_version,
        trellis_version,
        python_version,
    })
}

async fn install_node(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<String> {
    let zip = download_node(data_dir, &mut *on_progress).await?;
    let staged = runtime_dir(data_dir).join("node.new");
    on_progress("node:extract", "正在解压 Node.js");
    let extraction = {
        let zip = zip.clone();
        let staged = staged.clone();
        tokio::task::spawn_blocking(move || extract_node(&zip, &staged))
            .await
            .map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("解压任务失败: {error}"))
            })?
    };
    if let Err(error) = extraction {
        cleanup_partial(data_dir).await;
        return Err(error);
    }

    on_progress("node:validate", "正在校验 Node.js");
    let version = match node_version_at(&staged.join("node.exe")).await {
        Some(version) if is_version_at_least(&version, NODE_MIN_VERSION) => version,
        Some(version) => {
            cleanup_partial(data_dir).await;
            return Err(
                AgentError::new(CODE_NODE_INVALID, format!("Node.js 版本过低: {version}"))
                    .with_details(Some(json!({ "stage": "node:validate" }))),
            );
        }
        None => {
            cleanup_partial(data_dir).await;
            return Err(AgentError::new(CODE_NODE_INVALID, "Node.js 校验失败")
                .with_details(Some(json!({ "stage": "node:validate" }))));
        }
    };

    let node_dir = runtime_dir(data_dir).join("node");
    if node_dir.exists() {
        std::fs::remove_dir_all(&node_dir).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法清理旧 Node.js: {error}"))
        })?;
    }
    std::fs::rename(&staged, &node_dir).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("Node.js 安装失败: {error}"))
    })?;
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_file(download_dir(data_dir).join("node.zip.part"));
    Ok(version)
}

struct DownloadSpec {
    url: &'static str,
    sha256: &'static str,
    file_name: &'static str,
    label: &'static str,
    download_stage: &'static str,
    verify_stage: &'static str,
}

async fn download_file(
    data_dir: &Path,
    spec: &DownloadSpec,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<PathBuf> {
    let directory = download_dir(data_dir);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("无法创建下载目录: {error}"))
        })?;
    let target = directory.join(spec.file_name);
    let part_path = directory.join(format!("{}.part", spec.file_name));
    let _ = tokio::fs::remove_file(&part_path).await;
    let label = spec.label;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| {
            AgentError::new(
                CODE_DOWNLOAD_FAILED,
                format!("下载客户端初始化失败: {error}"),
            )
        })?;
    let response = client.get(spec.url).send().await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("下载 {label} 失败: {error}"))
            .retryable(true)
            .with_details(Some(
                json!({ "stage": spec.download_stage, "url": spec.url }),
            ))
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AgentError::new(
            CODE_DOWNLOAD_FAILED,
            format!("下载 {label} 失败: HTTP {}", status.as_u16()),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": spec.download_stage,
            "url": spec.url,
            "status": status.as_u16(),
        }))));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&part_path).await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("无法写入下载文件: {error}"))
    })?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_percent: i64 = -1;
    on_progress(spec.download_stage, &format!("开始下载 {label}"));

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("下载 {label} 中断: {error}"))
                .retryable(true)
                .with_details(Some(
                    json!({ "stage": spec.download_stage, "url": spec.url }),
                ))
        })?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("写入下载文件失败: {error}"))
        })?;
        received += chunk.len() as u64;
        if received > MAX_ZIP_BYTES {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(AgentError::new(
                CODE_DOWNLOAD_FAILED,
                format!("{label} 下载超出大小限制"),
            ));
        }
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| ((received.saturating_mul(100) / total).min(100)) as i64);
        let percent_changed = percent != Some(last_percent);
        if (percent_changed || percent.is_none()) && last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_percent = percent.unwrap_or_default();
            last_emit = Instant::now();
            let megabytes = received as f64 / 1_048_576.0;
            let message = match (percent, total) {
                (Some(percent), Some(total)) => format!(
                    "正在下载 {label} {percent}% ({megabytes:.1} MB / {:.1} MB)",
                    total as f64 / 1_048_576.0
                ),
                _ => format!("正在下载 {label} {megabytes:.1} MB"),
            };
            on_progress(spec.download_stage, &message);
        }
    }

    file.flush().await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("写入下载文件失败: {error}"))
    })?;
    drop(file);

    on_progress(spec.verify_stage, "正在校验下载文件");
    verify_hash(&hex(&hasher.finalize()), spec.sha256, spec.verify_stage).inspect_err(|_| {
        let _ = std::fs::remove_file(&part_path);
    })?;
    let _ = std::fs::remove_file(&target);
    tokio::fs::rename(&part_path, &target)
        .await
        .map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("保存下载文件失败: {error}"))
        })?;
    Ok(target)
}

async fn download_node(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<PathBuf> {
    download_file(
        data_dir,
        &DownloadSpec {
            url: NODE_ZIP_URL,
            sha256: NODE_ZIP_SHA256,
            file_name: "node.zip",
            label: "Node.js",
            download_stage: "node:download",
            verify_stage: "node:verify",
        },
        &mut *on_progress,
    )
    .await
}

/// 已装好的 >=3.9 解释器：per-user 安装目录 → PATH → `py -3`，取第一个可用者。
async fn installed_python() -> Option<(PathBuf, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut parts = PYTHON_INSTALL_VERSION.split('.');
    let directory = format!(
        "Python{}{}",
        parts.next().unwrap_or("3"),
        parts.next().unwrap_or("12")
    );
    if let Some(local) = env_dir("LOCALAPPDATA") {
        candidates.push(
            local
                .join("Programs")
                .join("Python")
                .join(directory)
                .join("python.exe"),
        );
    }
    if let Some(found) = find_in_path(&path_dirs(), "python.exe") {
        candidates.push(found);
    }
    for program in candidates {
        let Some(version) = python_version_at(&program, &[]).await else {
            continue;
        };
        if is_version_at_least(&version, PYTHON_MIN_VERSION) {
            return Some((program, version));
        }
    }
    py_launcher_target()
        .await
        .filter(|(_, version)| is_version_at_least(version, PYTHON_MIN_VERSION))
}

async fn run_with_heartbeat(
    program: PathBuf,
    args: Vec<String>,
    stage: &'static str,
    message: String,
    timeout: Duration,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<ProcessOutput> {
    let options = ProcessOptions {
        timeout: Some(timeout),
        max_output_bytes: 1_048_576,
        ..Default::default()
    };
    let mut task = tokio::spawn(async move {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        run_process(&program, &argv, &options).await
    });
    let started = Instant::now();
    loop {
        tokio::select! {
            joined = &mut task => {
                // 安装器静默执行时没有输出，只能靠心跳让前端知道还在装。
                return joined.map_err(|error| {
                    AgentError::new(CODE_PYTHON_INVALID, format!("Python 安装任务失败: {error}"))
                })?;
            }
            _ = tokio::time::sleep(PYTHON_INSTALL_HEARTBEAT) => {
                let seconds = started.elapsed().as_secs();
                on_progress(stage, &format!("{message}（已用 {seconds} 秒）"));
            }
        }
    }
}

async fn install_python(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<(PathBuf, String)> {
    let installer = download_file(
        data_dir,
        &DownloadSpec {
            url: PYTHON_INSTALLER_URL,
            sha256: PYTHON_INSTALLER_SHA256,
            file_name: PYTHON_INSTALLER_FILE,
            label: "Python",
            download_stage: "python:download",
            verify_stage: "python:verify",
        },
        &mut *on_progress,
    )
    .await?;

    on_progress(
        "python:install",
        &format!("正在静默安装 Python {PYTHON_INSTALL_VERSION}"),
    );
    let args: Vec<String> = PYTHON_INSTALLER_ARGS
        .iter()
        .map(|value| value.to_string())
        .collect();
    let outcome = run_with_heartbeat(
        installer.clone(),
        args,
        "python:install",
        format!("正在静默安装 Python {PYTHON_INSTALL_VERSION}"),
        PYTHON_INSTALL_TIMEOUT,
        &mut *on_progress,
    )
    .await;
    // 成功或失败都删掉安装包；失败文案里给官方下载页。
    let _ = std::fs::remove_file(&installer);
    let output = outcome?;
    let exit_code = output.exit_code;
    if exit_code != 0 && exit_code != PYTHON_EXIT_REBOOT_REQUIRED {
        return Err(AgentError::new(
            CODE_PYTHON_INVALID,
            format!("Python 安装失败: 退出码 {exit_code}，可从 {PYTHON_PAGE_URL} 手动安装"),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": "python:install",
            "exitCode": exit_code,
            "url": PYTHON_PAGE_URL,
        }))));
    }

    on_progress("python:validate", "正在校验 Python");
    installed_python().await.ok_or_else(|| {
        AgentError::new(
            CODE_PYTHON_INVALID,
            format!("Python 安装后未找到 {PYTHON_MIN_VERSION} 及以上的解释器"),
        )
        .with_details(Some(json!({
            "stage": "python:validate",
            "minVersion": PYTHON_MIN_VERSION,
        })))
    })
}

fn node_entry_allowed(relative: &str) -> bool {
    relative == "node.exe"
        || relative == "npm.cmd"
        || relative == "npx.cmd"
        || relative == "npm"
        || relative == "npx"
        || relative.starts_with("node_modules/npm/")
        || Path::new(relative)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_ascii_uppercase().starts_with("LICENSE"))
            .unwrap_or(false)
}

fn extract_node(zip_path: &Path, target: &Path) -> AgentResult<()> {
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法清理临时目录: {error}"))
        })?;
    }
    std::fs::create_dir_all(target).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建解压目录: {error}"))
    })?;

    let file = std::fs::File::open(zip_path).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("无法打开压缩包: {error}"))
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("压缩包无法解析: {error}"))
    })?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("压缩包条目读取失败: {error}"))
        })?;
        let name = entry.name().to_string();
        let Some(relative) = name.strip_prefix(NODE_ZIP_ROOT) else {
            continue;
        };
        if relative.is_empty() || !node_entry_allowed(relative) {
            continue;
        }
        let mut destination = target.to_path_buf();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => destination.push(part),
                _ => {
                    return Err(AgentError::new(CODE_EXTRACT_FAILED, "压缩包包含非法路径"));
                }
            }
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&destination).map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建目录: {error}"))
            })?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建目录: {error}"))
            })?;
        }
        let mut output = std::fs::File::create(&destination).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法写入文件: {error}"))
        })?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| AgentError::new(CODE_EXTRACT_FAILED, format!("解压失败: {error}")))?;
        output.flush().ok();
    }
    Ok(())
}

async fn cleanup_partial(data_dir: &Path) {
    let staged = runtime_dir(data_dir).join("node.new");
    if staged.exists() {
        let _ = tokio::fs::remove_dir_all(&staged).await;
    }
    let _ = tokio::fs::remove_file(download_dir(data_dir).join("node.zip.part")).await;
}

async fn install_trellis(
    data_dir: &Path,
    node_path: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<()> {
    let prefix = npm_global_dir(data_dir);
    tokio::fs::create_dir_all(&prefix).await.map_err(|error| {
        AgentError::new(
            CODE_TRELLIS_INSTALL_FAILED,
            format!("无法创建安装目录: {error}"),
        )
    })?;
    let prefix_text = prefix.display().to_string();
    let package = format!("{TRELLIS_PACKAGE}@{TRELLIS_VERSION}");
    let options = ProcessOptions {
        timeout: Some(NPM_INSTALL_TIMEOUT),
        max_output_bytes: 1_048_576,
        ..Default::default()
    };

    let npm_cli = node_path
        .parent()
        .map(|directory| {
            directory
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js")
        })
        .filter(|path| path.is_file());

    let output = if let Some(npm_cli) = npm_cli {
        let npm_cli_text = npm_cli.display().to_string();
        on_progress("trellis:install", "正在安装 Trellis CLI");
        run_process(
            node_path,
            &[
                npm_cli_text.as_str(),
                "install",
                "-g",
                "--prefix",
                prefix_text.as_str(),
                package.as_str(),
            ],
            &options,
        )
        .await?
    } else if let Some(npm) = find_in_path(&path_dirs(), "npm.cmd") {
        on_progress("trellis:install", "正在安装 Trellis CLI");
        let line = format!(
            "\"{}\" install -g --prefix \"{prefix_text}\" {package}",
            npm.display()
        );
        run_process(&shell_exe(), &["/C", line.as_str()], &options).await?
    } else {
        return Err(
            AgentError::new(code::MISSING_TRELLIS, "未找到 npm，无法安装 Trellis CLI")
                .with_details(Some(json!({ "stage": "trellis:install" }))),
        );
    };

    if !output.success() {
        return Err(AgentError::new(
            CODE_TRELLIS_INSTALL_FAILED,
            format!(
                "安装 Trellis CLI 失败: {}",
                output.stderr_tail(ERROR_TAIL_CHARS)
            ),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": "trellis:install",
            "exitCode": output.exit_code,
        }))));
    }
    Ok(())
}

/// 把三个运行时 flag 合并写入 `<data_dir>/client.json`（schema 3）。
pub fn write_runtime_flags(
    data_dir: &Path,
    node: &NodeRuntimeFlag,
    trellis: &TrellisRuntimeFlag,
    python: &PythonRuntimeFlag,
) -> AgentResult<()> {
    let path = data_dir.join("client.json");
    let mut document: Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    document.insert("schema_version".to_string(), json!(3));
    document.insert(
        "node_runtime".to_string(),
        serde_json::to_value(node).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    document.insert(
        "trellis_runtime".to_string(),
        serde_json::to_value(trellis).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    document.insert(
        "python_runtime".to_string(),
        serde_json::to_value(python).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    let payload = serde_json::to_vec_pretty(&Value::Object(document)).map_err(|error| {
        AgentError::new(
            code::CONFIG_INVALID,
            format!("运行时配置序列化失败: {error}"),
        )
    })?;

    std::fs::create_dir_all(data_dir).map_err(|error| {
        AgentError::new(code::CONFIG_INVALID, format!("无法创建配置目录: {error}"))
    })?;
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, payload).map_err(|error| {
        AgentError::new(code::CONFIG_INVALID, format!("无法写入运行时配置: {error}"))
    })?;
    if std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&temp, &path).map_err(|error| {
            AgentError::new(code::CONFIG_INVALID, format!("无法写入运行时配置: {error}"))
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("trellis-env-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("temp dir");
        directory
    }

    #[test]
    fn parses_and_compares_versions() {
        assert_eq!(parse_version("v24.22.3\r\n").as_deref(), Some("24.22.3"));
        assert_eq!(parse_version("0.6.17").as_deref(), Some("0.6.17"));
        assert_eq!(parse_version("not-a-version"), None);
        assert_eq!(parse_version("24.22"), None);
        assert!(is_version_at_least("24.22.3", NODE_MIN_VERSION));
        assert!(is_version_at_least("v18.17.0", NODE_MIN_VERSION));
        assert!(!is_version_at_least("16.20.2", NODE_MIN_VERSION));
        assert!(!is_version_at_least("0.6.16", TRELLIS_VERSION));
        assert!(is_version_at_least("0.6.17", TRELLIS_VERSION));
    }

    #[test]
    fn parses_python_version_output() {
        assert_eq!(
            parse_python_version("Python 3.12.8\r\n").as_deref(),
            Some("3.12.8")
        );
        assert_eq!(parse_python_version("3.12").as_deref(), Some("3.12.0"));
        assert_eq!(
            parse_python_version("Python 2.7.18").as_deref(),
            Some("2.7.18")
        );
        assert_eq!(parse_python_version("command not found"), None);
        assert_eq!(parse_python_version(""), None);
        assert!(!is_version_at_least("3.8.10", PYTHON_MIN_VERSION));
        assert!(is_version_at_least("3.9.0", PYTHON_MIN_VERSION));
        assert!(is_version_at_least("3.12.8", PYTHON_MIN_VERSION));
    }

    #[test]
    fn rejects_corrupt_downloads() {
        let actual = hex(&Sha256::digest(b"not the node archive"));
        let error = verify_hash(&actual, NODE_ZIP_SHA256, "node:verify").expect_err("hash mismatch");
        assert_eq!(error.code, CODE_DOWNLOAD_CORRUPT);
        assert!(verify_hash(NODE_ZIP_SHA256, NODE_ZIP_SHA256, "node:verify").is_ok());
        assert_eq!(
            hex(&Sha256::digest(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn finds_executables_on_provided_path() {
        let directory = temp_dir("path");
        let executable = directory.join("node.exe");
        std::fs::write(&executable, b"").expect("write");
        let dirs = vec![directory.join("missing"), directory.clone()];
        assert_eq!(
            find_in_path(&dirs, "node.exe").as_deref(),
            Some(executable.as_path())
        );
        assert_eq!(find_in_path(&dirs, "npm.cmd"), None);
        assert_eq!(find_in_path(&[], "node.exe"), None);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn fallback_dirs_cover_version_manager_prefixes() {
        let app_data = temp_dir("fallback");
        let alias = app_data.join("fnm/aliases/default");
        std::fs::create_dir_all(&alias).expect("alias dir");
        let version = app_data.join("fnm/node-versions/v24.12.0/installation");
        std::fs::create_dir_all(&version).expect("version dir");
        let dirs = fallback_dirs_in(
            Some(&app_data),
            Some(Path::new("C:\\local")),
            Some(Path::new("C:\\pf")),
        );
        assert!(dirs.contains(&alias));
        assert!(dirs.contains(&version));
        assert!(dirs.contains(&PathBuf::from("C:\\local\\Programs\\nodejs")));
        assert!(dirs.contains(&PathBuf::from("C:\\pf\\nodejs")));
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn finds_global_trellis_cli_in_prefix_dir() {
        let prefix = temp_dir("prefix");
        let package = prefix.join("node_modules/@mindfoldhq/trellis");
        std::fs::create_dir_all(package.join("bin")).expect("bin dir");
        std::fs::write(package.join("package.json"), r#"{"version":"0.6.17"}"#).expect("pkg");
        std::fs::write(package.join("bin/trellis.js"), b"").expect("cli");
        let (cli, source) = trellis_cli_in(&prefix).expect("cli in prefix");
        assert_eq!(source, "global");
        assert_eq!(read_package_version(&cli).as_deref(), Some("0.6.17"));
        assert!(trellis_cli_in(&prefix.join("missing")).is_none());
        let _ = std::fs::remove_dir_all(&prefix);
    }

    #[test]
    fn reads_package_version_of_trellis_cli() {
        let directory = temp_dir("pkg");
        let package_root = directory.join("node_modules/@mindfoldhq/trellis");
        std::fs::create_dir_all(package_root.join("bin")).expect("bin dir");
        std::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@mindfoldhq/trellis","version":"0.6.17"}"#,
        )
        .expect("write package");
        let cli = package_root.join("bin/trellis.js");
        std::fs::write(&cli, b"").expect("write cli");
        assert_eq!(read_package_version(&cli).as_deref(), Some("0.6.17"));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn status_paths_live_under_data_dir() {
        let data_dir = Path::new("C:\\data");
        assert_eq!(
            node_exe_path(data_dir),
            PathBuf::from("C:\\data\\runtime\\node\\node.exe")
        );
        assert_eq!(
            download_dir(data_dir),
            PathBuf::from("C:\\data\\runtime\\download")
        );
        assert_eq!(
            trellis_cli_path(data_dir),
            PathBuf::from(
                "C:\\data\\npm-global\\node_modules\\@mindfoldhq\\trellis\\bin\\trellis.js"
            )
        );
        assert_eq!(
            npm_global_dir(data_dir),
            PathBuf::from("C:\\data\\npm-global")
        );
    }

    #[test]
    fn runtime_state_serializes_to_expected_strings() {
        assert_eq!(
            serde_json::to_value(RuntimeState::NeedsSetup).expect("serialize"),
            json!("needs_setup")
        );
        assert_eq!(
            serde_json::to_value(RuntimeState::Ready).expect("serialize"),
            json!("ready")
        );
        let status = RuntimeStatus {
            state: RuntimeState::NeedsSetup,
            node: NodeStatus {
                ok: false,
                version: None,
                path: None,
                source: None,
                min_version: NODE_MIN_VERSION.to_string(),
                found_version: Some("16.20.2".to_string()),
            },
            trellis: TrellisStatus {
                ok: false,
                version: None,
                cli_path: None,
                source: None,
                required_version: TRELLIS_VERSION.to_string(),
                found_version: None,
            },
            download: DownloadInfo {
                version: NODE_DOWNLOAD_VERSION.to_string(),
                bytes: None,
            },
            python: PythonStatus {
                ok: false,
                version: None,
                path: None,
                source: None,
                min_version: PYTHON_MIN_VERSION.to_string(),
                found_version: Some("3.8.10".to_string()),
            },
        };
        let payload = serde_json::to_value(&status).expect("serialize status");
        assert_eq!(payload["state"], json!("needs_setup"));
        assert_eq!(payload["node"]["minVersion"], json!(NODE_MIN_VERSION));
        assert_eq!(payload["node"]["foundVersion"], json!("16.20.2"));
        assert_eq!(
            payload["trellis"]["requiredVersion"],
            json!(TRELLIS_VERSION)
        );
        assert_eq!(payload["python"]["minVersion"], json!(PYTHON_MIN_VERSION));
        assert_eq!(payload["python"]["foundVersion"], json!("3.8.10"));
        assert_eq!(payload["download"]["version"], json!(NODE_DOWNLOAD_VERSION));
    }

    #[test]
    fn value_config_reads_and_clears_flags() {
        let mut config = json!({
            "schema_version": 3,
            "node_runtime": {
                "version": "24.22.3",
                "path": "C:\\data\\runtime\\node\\node.exe",
                "source": "downloaded",
                "installed_at": "2026-11-12T08:00:00Z"
            }
        });
        let node = config.node_runtime().expect("node flag");
        assert_eq!(node.version, "24.22.3");
        assert!(config.trellis_runtime().is_none());
        assert!(config.python_runtime().is_none());
        config.set_python_runtime(Some(PythonRuntimeFlag {
            version: "3.12.8".to_string(),
            path: "C:\\Python312\\python.exe".to_string(),
            source: "installed".to_string(),
            installed_at: "2026-11-13T08:00:00Z".to_string(),
        }));
        assert_eq!(
            config.python_runtime().expect("python flag").path,
            "C:\\Python312\\python.exe"
        );
        config.set_node_runtime(None);
        assert!(config.node_runtime().is_none());
        assert!(config.get("node_runtime").is_none());
        config.set_python_runtime(None);
        assert!(config.get("python_runtime").is_none());
    }
}
