//! `trellis-agent`：不依赖 Tauri/WebView 的 headless Agent。
//!
//! 与桌面端共用 `agent/` 模块树（登录、关联项目、任务同步、claim/handoff 控制面全部相同），
//! 只是把 UI 相关部分换成了 CLI。Linux 上 `cargo build --no-default-features --bin trellis-agent`
//! 即可产出可执行文件；Windows 桌面端仍走默认 feature，行为不变。

#![allow(clippy::result_large_err)]
// headless 只用 agent/ 的一部分能力（桌面端的窗口、菜单、托盘相关辅助用不到），
// 这里统一放行 dead_code，避免 170 条「未使用」噪音掩盖真正的告警。
#![allow(dead_code)]

#[path = "../agent/mod.rs"]
mod agent;
#[path = "../config.rs"]
mod config;
#[path = "../logging.rs"]
mod logging;
#[path = "../url_path.rs"]
mod url_path;

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::agent::association::{associate_desktop_project, AssociateParams};
use crate::agent::control::ControlHub;
use crate::agent::credential::CredentialStore;
use crate::agent::device;
use crate::agent::http::ApiClient;
use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::runtime::AgentRuntime;
use crate::agent::state_events::StateSink;
use crate::agent::store::ConfigStore;
use crate::agent::task_sync::ControlSink;

const INTERNAL: &str = "INTERNAL";

const USAGE: &str = "\
trellis-agent —— headless Trellis Board Agent

用法:
  trellis-agent login     --server URL --username U [--device NAME] [--password P] [--force-new] [--ca FILE]
  trellis-agent associate --path REPO --branch BRANCH --team TEAM --developer DEV
                          [--display-name N] [--initial-mode safe|bootstrap|review] [--require-pushed]
  trellis-agent run       [--paused]
  trellis-agent status
  trellis-agent logs      [-n 50]

通用:
  --root DIR      Agent 数据目录，默认 $TRELLIS_AGENT_ROOT
                  典型值 <repo>/.worktree/trellis-board-client-agent-data
  -h, --help      显示本帮助
";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "-h" || args[0] == "--help" {
        print!("{USAGE}");
        return;
    }
    let command = args[0].clone();
    let parsed = match Parsed::parse(&args[1..]) {
        Ok(value) => value,
        Err(error) => exit_with(&error),
    };
    let root = match parsed.root() {
        Ok(value) => value,
        Err(error) => exit_with(&error),
    };
    let result = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| AgentError::new(INTERNAL, format!("无法启动异步运行时: {error}")))
        .and_then(|runtime| runtime.block_on(dispatch(&command, &parsed, root)));
    match result {
        Ok(()) => {}
        Err(error) => exit_with(&error),
    }
}

async fn dispatch(command: &str, args: &Parsed, root: PathBuf) -> AgentResult<()> {
    let store = Arc::new(ConfigStore::new(root));
    store.ensure_directories().await?;
    logging::init(&store.paths.logs_dir);
    match command {
        "login" => login(&store, args).await,
        "associate" => associate(&store, args).await,
        "run" => run(store, args).await,
        "status" => status(&store).await,
        "logs" => logs(&store, args),
        other => Err(AgentError::new(
            code::COMMAND_INVALID,
            format!("未知命令 {other}，见 --help"),
        )),
    }
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

async fn login(store: &ConfigStore, args: &Parsed) -> AgentResult<()> {
    let server_url = args.required("--server")?;
    let username = args.required("--username")?;
    let device_name = match args.value("--device") {
        Some(value) => value.to_string(),
        None => default_device_name(),
    };
    let password = match args.value("--password") {
        Some(value) => value.to_string(),
        None => read_password()?,
    };
    let ca_file = args.value("--ca").map(PathBuf::from);
    let api = ApiClient::new(&server_url, None, ca_file.as_deref())?;
    let summary = device::login_desktop(
        store,
        &api,
        &username,
        &password,
        &device_name,
        args.flag("--force-new"),
    )
    .await?;
    print_json(&serde_json::to_value(&summary).unwrap_or(Value::Null))?;
    Ok(())
}

async fn associate(store: &ConfigStore, args: &Parsed) -> AgentResult<()> {
    let (_, api) = agent_context(store).await?;
    let params = AssociateParams {
        repo_path: args.required("--path")?,
        branch_name: args.required("--branch")?,
        team_id: args.required("--team")?,
        developer_id: args.required("--developer")?,
        display_name: args.value("--display-name").map(str::to_string),
        require_pushed: args.flag("--require-pushed"),
        initial_sync_mode: args.value("--initial-mode").unwrap_or("safe").to_string(),
    };
    let summary = associate_desktop_project(store, &api, params).await?;
    print_json(&serde_json::to_value(&summary).unwrap_or(Value::Null))?;
    Ok(())
}

async fn run(store: Arc<ConfigStore>, args: &Parsed) -> AgentResult<()> {
    let (config, _) = agent_context(&store).await?;
    let hub = ControlHub::new();
    let paused = Arc::new(AtomicBool::new(args.flag("--paused")));
    let emit: ControlSink = Arc::new(|control: Value| {
        let line = serde_json::to_string(&control).unwrap_or_else(|_| control.to_string());
        println!("{line}");
        let _ = std::io::stdout().flush();
    });
    let state_sink: StateSink = Arc::new(|| {});
    let runtime =
        AgentRuntime::start(store.clone(), emit, state_sink, paused.clone(), &hub).await?;
    logging::warn(&format!(
        "Agent 已启动：{}（{}），pid={}",
        config.server_url,
        config.agent_id,
        std::process::id()
    ));
    println!(
        "agent 已启动: server={} agentId={} device={}",
        config.server_url, config.agent_id, config.device_name
    );

    let mut last_control: Option<String> = None;
    // Ctrl-C 与 SIGTERM 都走优雅停止：后者是 `scripts/agent.sh stop` 和 systemd 的默认信号。
    let mut terminate = terminate_signal();
    loop {
        tokio::select! {
            signal = tokio::signal::ctrl_c() => {
                let _ = signal;
                break;
            }
            _ = wait_terminate(&mut terminate) => {
                break;
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if let Some(control) = hub.pending() {
                    let text = serde_json::to_string(&control).unwrap_or_default();
                    if last_control.as_deref() != Some(text.as_str()) {
                        logging::warn(&format!("待处理控制事件: {text}"));
                        last_control = Some(text);
                    }
                } else {
                    last_control = None;
                }
            }
        }
    }
    runtime.stop();
    // `AgentRuntime::stop()` 里写 `runtime.json` 是 spawn 出去的异步任务，进程立刻退出会丢掉
    // 这次写入（桌面端常驻进程不会遇到）。这里等它落盘，最多 1s。
    for _ in 0..20 {
        if let Ok(raw) = tokio::fs::read_to_string(&store.paths.state_file).await {
            if raw.contains("\"status\": \"stopped\"") || raw.contains("\"status\":\"stopped\"") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    logging::warn("Agent 已停止");
    println!("agent 已停止");
    Ok(())
}

async fn status(store: &ConfigStore) -> AgentResult<()> {
    let config = store.read_config(true).await?;
    let state = tokio::fs::read_to_string(&store.paths.state_file)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let credential_present = store.paths.credential_file.exists();
    let payload = serde_json::json!({
        "agentRoot": store.paths.root,
        "loggedIn": config.is_some(),
        "credentialPresent": credential_present,
        "config": config.as_ref().map(|config| serde_json::json!({
            "serverUrl": config.server_url,
            "agentId": config.agent_id,
            "deviceName": config.device_name,
            "username": config.username,
            "protocolVersion": config.protocol_version,
            "bindings": config.bindings,
        })),
        "runtime": state,
    });
    print_json(&payload)
}

fn logs(store: &ConfigStore, args: &Parsed) -> AgentResult<()> {
    let count = args
        .value("-n")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(50);
    let path = store.paths.logs_dir.join("desktop.log");
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        AgentError::new(
            code::CONFIG_MISSING,
            format!("无法读取日志 {}: {error}", path.display()),
        )
    })?;
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(count);
    for line in &lines[start..] {
        println!("{line}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

async fn agent_context(
    store: &ConfigStore,
) -> AgentResult<(crate::agent::store::AgentConfig, Arc<ApiClient>)> {
    let config = store
        .read_config(false)
        .await?
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "尚未登录，请先执行 login"))?;
    if config.agent_id.trim().is_empty() {
        return Err(AgentError::new(
            code::CONFIG_MISSING,
            "本地配置缺少 agentId，请重新执行 login",
        ));
    }
    let credential = CredentialStore::new(store).load_credential().await?;
    let ca_file = config.ca_file.clone().map(PathBuf::from);
    let api = ApiClient::new(&config.server_url, Some(credential), ca_file.as_deref())?;
    Ok((config, Arc::new(api)))
}

fn default_device_name() -> String {
    if let Ok(name) = std::env::var("HOSTNAME") {
        if !name.trim().is_empty() {
            return name;
        }
    }
    if let Ok(name) = std::fs::read_to_string("/etc/hostname") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    "trellis-agent".to_string()
}

fn read_password() -> AgentResult<String> {
    eprint!("密码（从 stdin 读取，也可用 --password）: ");
    let _ = std::io::stderr().flush();
    let mut buffer = String::new();
    std::io::stdin()
        .read_to_string(&mut buffer)
        .map_err(|error| AgentError::new(code::CONFIG_INVALID, format!("读取密码失败: {error}")))?;
    let password = buffer.trim().to_string();
    if password.is_empty() {
        return Err(AgentError::new(code::CONFIG_INVALID, "密码不能为空"));
    }
    Ok(password)
}

fn print_json(value: &Value) -> AgentResult<()> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| AgentError::new(INTERNAL, format!("序列化失败: {error}")))?;
    println!("{text}");
    Ok(())
}

fn exit_with(error: &AgentError) -> ! {
    eprintln!("错误 [{}]: {}", error.code, error.message);
    if let Some(details) = error.details.as_ref() {
        eprintln!("详情: {details}");
    }
    std::process::exit(1)
}

/// 极简参数解析：`--key value`、`--flag`、`-n 50`。
struct Parsed {
    values: Vec<(String, String)>,
    flags: Vec<String>,
}

impl Parsed {
    fn parse(args: &[String]) -> Result<Self, AgentError> {
        let mut values = Vec::new();
        let mut flags = Vec::new();
        let mut index = 0;
        while index < args.len() {
            let token = &args[index];
            if !token.starts_with('-') {
                return Err(AgentError::new(
                    code::COMMAND_INVALID,
                    format!("无法识别的参数 {token}"),
                ));
            }
            let has_next = args
                .get(index + 1)
                .map(|next| !next.starts_with("--"))
                .unwrap_or(false);
            if has_next {
                values.push((token.clone(), args[index + 1].clone()));
                index += 2;
            } else {
                flags.push(token.clone());
                index += 1;
            }
        }
        Ok(Self { values, flags })
    }

    fn value(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    fn required(&self, key: &str) -> AgentResult<String> {
        self.value(key)
            .map(str::to_string)
            .ok_or_else(|| AgentError::new(code::COMMAND_INVALID, format!("缺少必需参数 {key}")))
    }

    fn flag(&self, key: &str) -> bool {
        self.flags.iter().any(|name| name == key)
    }

    fn root(&self) -> AgentResult<PathBuf> {
        if let Some(value) = self.value("--root") {
            return Ok(PathBuf::from(value));
        }
        if let Ok(value) = std::env::var("TRELLIS_AGENT_ROOT") {
            if !value.trim().is_empty() {
                return Ok(PathBuf::from(value));
            }
        }
        Err(AgentError::new(
            code::CONFIG_INVALID,
            "未指定 Agent 数据目录：用 --root 或设置 TRELLIS_AGENT_ROOT",
        ))
    }
}

#[cfg(unix)]
fn terminate_signal() -> Option<tokio::signal::unix::Signal> {
    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok()
}

#[cfg(not(unix))]
fn terminate_signal() -> Option<()> {
    None
}

#[cfg(unix)]
async fn wait_terminate(signal: &mut Option<tokio::signal::unix::Signal>) {
    match signal {
        Some(signal) => {
            signal.recv().await;
        }
        None => std::future::pending::<()>().await,
    }
}

#[cfg(not(unix))]
async fn wait_terminate(_signal: &mut Option<()>) {
    std::future::pending::<()>().await
}

/// 保持与 `protocol` 的引用关系，避免 feature 关闭时出现未使用告警。
#[allow(dead_code)]
fn _protocol_marker() -> &'static str {
    protocol::AGENT_VERSION
}
