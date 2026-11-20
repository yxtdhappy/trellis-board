//! 固定 Trellis 运行环境的 CLI 执行层：负责完整 `init` 和已有任务树的 Agent-only 配置，
//! 不负责安装运行环境（见 env.rs），也不下载模板。
//! 工具映射对照 shared/trellis-agent-tools.js；行为对照 desktop/sidecar/trellis-runtime.js。

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;
use tokio::io::AsyncWriteExt;

use crate::agent::process::{run_process, ProcessOptions, ProcessOutput};
use crate::agent::protocol::{code, AgentError, AgentResult};

const INIT_TIMEOUT: Duration = Duration::from_secs(210);
const REPAIR_TIMEOUT: Duration = Duration::from_secs(30);
const INIT_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const ERROR_TAIL_CHARS: usize = 2 * 1024;
const AGENT_ONLY_INIT_HELPER: &str = include_str!("agent_only_init.mjs");
const AGENT_TEMPLATE_REPAIR_HELPER: &str = include_str!("agent_template_repair.mjs");

/// 已知会被 Windows DLP 以 EXDEV 拦截的模板平台与其扩展目录签名。
const REPAIR_PLATFORMS: [(&str, &str); 2] = [
    ("pi", ".pi/extensions/trellis"),
    ("omp", ".omp/extensions/trellis"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrellisRuntime {
    pub node_exe: PathBuf,
    pub cli_path: PathBuf,
}

/// Copilot 写入共享 `.github` 目录，只能忽略 Trellis 生成的精确子路径。
const COPILOT_GITIGNORE_PATHS: &[&str] = &[
    "/.github/copilot/",
    "/.github/copilot-instructions.md",
    "/.github/hooks/trellis.json",
    "/.github/prompts/start.prompt.md",
    "/.github/prompts/continue.prompt.md",
    "/.github/prompts/finish-work.prompt.md",
    "/.github/skills/trellis-*/",
    "/.github/agents/trellis-*.agent.md",
];

struct AgentTool {
    id: &'static str,
    flag: &'static str,
    presence_paths: &'static [&'static str],
    gitignore_paths: &'static [&'static str],
    /// 是否要求全部 presencePaths 命中（对照 JS 的 presenceMode: 'all'）。
    all_presence: bool,
}

const AGENT_TOOLS: [AgentTool; 22] = [
    AgentTool {
        id: "cursor",
        flag: "--cursor",
        presence_paths: &[".cursor"],
        gitignore_paths: &["/.cursor/"],
        all_presence: false,
    },
    AgentTool {
        id: "claude-code",
        flag: "--claude",
        presence_paths: &[".claude"],
        gitignore_paths: &["/.claude/"],
        all_presence: false,
    },
    AgentTool {
        id: "opencode",
        flag: "--opencode",
        presence_paths: &[".opencode"],
        gitignore_paths: &["/.opencode/"],
        all_presence: false,
    },
    AgentTool {
        id: "codex",
        flag: "--codex",
        presence_paths: &[".codex"],
        gitignore_paths: &["/.codex/"],
        all_presence: false,
    },
    AgentTool {
        id: "kilo",
        flag: "--kilo",
        presence_paths: &[".kilocode"],
        gitignore_paths: &["/.kilocode/"],
        all_presence: false,
    },
    AgentTool {
        id: "kiro",
        flag: "--kiro",
        presence_paths: &[".kiro/skills", ".kiro/agents", ".kiro/hooks"],
        gitignore_paths: &["/.kiro/"],
        all_presence: false,
    },
    AgentTool {
        id: "gemini",
        flag: "--gemini",
        presence_paths: &[".gemini"],
        gitignore_paths: &["/.gemini/"],
        all_presence: false,
    },
    AgentTool {
        id: "antigravity",
        flag: "--antigravity",
        presence_paths: &[".agent/workflows", ".agent/skills"],
        gitignore_paths: &["/.agent/"],
        all_presence: false,
    },
    AgentTool {
        id: "devin",
        flag: "--devin",
        presence_paths: &[".devin/workflows", ".devin/skills"],
        gitignore_paths: &["/.devin/"],
        all_presence: false,
    },
    AgentTool {
        id: "qoder",
        flag: "--qoder",
        presence_paths: &[".qoder"],
        gitignore_paths: &["/.qoder/"],
        all_presence: false,
    },
    AgentTool {
        id: "codebuddy",
        flag: "--codebuddy",
        presence_paths: &[".codebuddy"],
        gitignore_paths: &["/.codebuddy/"],
        all_presence: false,
    },
    AgentTool {
        id: "copilot",
        flag: "--copilot",
        presence_paths: &[".github/copilot", ".github/copilot-instructions.md"],
        gitignore_paths: COPILOT_GITIGNORE_PATHS,
        all_presence: false,
    },
    AgentTool {
        id: "droid",
        flag: "--droid",
        presence_paths: &[".factory"],
        gitignore_paths: &["/.factory/"],
        all_presence: false,
    },
    AgentTool {
        id: "dsh",
        flag: "--dsh",
        presence_paths: &[".dsh"],
        gitignore_paths: &["/.dsh/"],
        all_presence: false,
    },
    AgentTool {
        id: "pi",
        flag: "--pi",
        presence_paths: &[".pi/extensions/trellis/index.ts", ".pi/settings.json"],
        gitignore_paths: &["/.pi/"],
        all_presence: true,
    },
    AgentTool {
        id: "reasonix",
        flag: "--reasonix",
        presence_paths: &[".reasonix"],
        gitignore_paths: &["/.reasonix/"],
        all_presence: false,
    },
    AgentTool {
        id: "zcode",
        flag: "--zcode",
        presence_paths: &[".zcode"],
        gitignore_paths: &["/.zcode/"],
        all_presence: false,
    },
    AgentTool {
        id: "omp",
        flag: "--omp",
        presence_paths: &[".omp"],
        gitignore_paths: &["/.omp/"],
        all_presence: false,
    },
    AgentTool {
        id: "trae",
        flag: "--trae",
        presence_paths: &[".trae"],
        gitignore_paths: &["/.trae/"],
        all_presence: false,
    },
    AgentTool {
        id: "grok",
        flag: "--grok",
        presence_paths: &[".grok"],
        gitignore_paths: &["/.grok/"],
        all_presence: false,
    },
    AgentTool {
        id: "kimi",
        flag: "--kimi",
        presence_paths: &[".kimi-code"],
        gitignore_paths: &["/.kimi-code/"],
        all_presence: false,
    },
    AgentTool {
        id: "snow",
        flag: "--snow",
        presence_paths: &[
            ".snow/skills",
            ".snow/commands",
            ".snow/agents",
            ".snow/hooks",
        ],
        gitignore_paths: &["/.snow/"],
        all_presence: false,
    },
];

fn find_tool(id: &str) -> Option<&'static AgentTool> {
    AGENT_TOOLS.iter().find(|tool| tool.id == id)
}

/// 工具 ID 列表 → trellis init 的参数（未知 ID 忽略，保持输入顺序）。
pub fn trellis_agent_tool_flags(tools: &[String]) -> Vec<String> {
    let mut flags = Vec::new();
    for tool in tools {
        let Some(entry) = find_tool(tool.trim()) else {
            continue;
        };
        // presenceMode 只用于客户端完成状态检测，Trellis CLI 没有对应参数。
        flags.push(entry.flag.to_string());
    }
    flags
}

/// 工具 ID 列表 → 需要写入项目 `.gitignore` 的本机配置路径。
/// 按 `AGENT_TOOLS` 顺序展开并去重，保证输出稳定且可重复执行。
pub fn agent_gitignore_paths(tools: &[String]) -> Vec<&'static str> {
    let mut paths: Vec<&'static str> = Vec::new();
    for tool in &AGENT_TOOLS {
        if !tools.iter().any(|id| id.trim() == tool.id) {
            continue;
        }
        for path in tool.gitignore_paths {
            if !paths.contains(path) {
                paths.push(path);
            }
        }
    }
    paths
}

fn init_args(cli_path: &Path, developer_id: &str, agent_tools: &[String]) -> Vec<String> {
    let mut args = vec![
        cli_path.to_string_lossy().into_owned(),
        "init".to_string(),
        "-y".to_string(),
        "--skip-existing".to_string(),
        "-u".to_string(),
        developer_id.to_string(),
    ];
    args.extend(trellis_agent_tool_flags(agent_tools));
    args
}

fn agent_only_args(cli_path: &Path, repo_path: &Path, agent_tools: &[String]) -> Vec<String> {
    let mut args = vec![
        "--input-type=module".to_string(),
        "-".to_string(),
        cli_path.to_string_lossy().into_owned(),
        repo_path.to_string_lossy().into_owned(),
    ];
    args.extend(
        agent_tools
            .iter()
            .map(|tool| tool.trim().to_string())
            .filter(|tool| !tool.is_empty()),
    );
    args
}

/// 仓库内已存在的 Agent 工具痕迹（对照 JS 的 detectTrellisAgentTools，按目录/文件存在性判断）。
pub async fn detect_agent_tools(repo_path: &Path) -> Vec<String> {
    AGENT_TOOLS
        .iter()
        .filter(|tool| {
            let mut hits = tool
                .presence_paths
                .iter()
                .map(|path| repo_path.join(path).exists());
            if tool.all_presence {
                hits.all(|hit| hit)
            } else {
                hits.any(|hit| hit)
            }
        })
        .map(|tool| tool.id.to_string())
        .collect()
}

/// 在 repo_path 内执行 `<node.exe> <cli.js> init -y --skip-existing -u <developerId> <flags>`。
/// 遇到 Pi / OMP 的 EXDEV 模板写入失败时补齐缺失模板并重试一次。
pub async fn initialize_trellis(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    developer_id: &str,
    agent_tools: &[String],
) -> AgentResult<()> {
    initialize_with_repair(
        runtime,
        repo_path,
        agent_tools,
        InitMode::Full { developer_id },
        None,
        "Trellis 初始化失败",
    )
    .await
}

/// 已有 Trellis 任务树时只通过 stdin 执行内嵌 helper，复用 Trellis 包的平台配置器和模板哈希。
/// 与完整 init 共用同一套 EXDEV 识别、模板补齐和单次重试逻辑；Agent-only 不经过
/// `trellis init`，因此需要单独补齐 developer 身份与 workspace。
pub async fn initialize_agents(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    developer_id: &str,
    agent_tools: &[String],
) -> AgentResult<()> {
    initialize_with_repair(
        runtime,
        repo_path,
        agent_tools,
        InitMode::AgentsOnly,
        Some(developer_id),
        "Trellis Agent 配置失败",
    )
    .await
}

/// 初始化方式：完整 `trellis init` 或已有任务树的 Agent-only 配置。
enum InitMode<'a> {
    Full { developer_id: &'a str },
    AgentsOnly,
}

async fn run_init_process(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    agent_tools: &[String],
    mode: &InitMode<'_>,
    suppress_failure_log: bool,
) -> AgentResult<ProcessOutput> {
    let (args, stdin) = match mode {
        InitMode::Full { developer_id } => (
            init_args(&runtime.cli_path, *developer_id, agent_tools),
            None,
        ),
        InitMode::AgentsOnly => (
            agent_only_args(&runtime.cli_path, repo_path, agent_tools),
            Some(AGENT_ONLY_INIT_HELPER.as_bytes().to_vec()),
        ),
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        stdin,
        timeout: Some(INIT_TIMEOUT),
        max_output_bytes: INIT_MAX_OUTPUT_BYTES,
        suppress_failure_log,
        ..ProcessOptions::default()
    };
    run_process(&runtime.node_exe, &args, &options).await
}

fn normalize_repo_root(path: &Path) -> PathBuf {
    // 裸盘符（如 D:）在 Windows 上是「驱动器相对路径」，realpath/lstat 可能被 DLP 或
    // 网络盘重定向后报 EISDIR；用户选择盘符根时统一补成 D:\。
    #[cfg(windows)]
    {
        let raw = path.as_os_str().to_string_lossy();
        if raw.len() == 2 && raw.as_bytes()[1] == b':' {
            return PathBuf::from(format!("{raw}\\"));
        }
    }
    path.to_path_buf()
}

async fn initialize_with_repair(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    agent_tools: &[String],
    mode: InitMode<'_>,
    developer_id: Option<&str>,
    fallback_prefix: &str,
) -> AgentResult<()> {
    let normalized_repo = normalize_repo_root(repo_path);
    let repo_path = normalized_repo.as_path();

    // Agent-only 不执行 `trellis init`，developer 身份必须在配置平台前补齐；
    // 放在首次 init 之前，developer helper 失败时不会留下“Agent 已初始化、无法重试”的半成品。
    if let Some(developer_id) = developer_id {
        let developer = run_repair_helper(
            runtime,
            repo_path,
            "developer",
            &[developer_id.to_string()],
        )
        .await?;
        if !developer.success() {
            return Err(developer_failure(developer_id, &developer));
        }
    }

    // 第一次初始化前记录所选 Pi / OMP 平台尚缺失的模板；仅用于补登记模板哈希。
    let selected_platforms = selected_repair_platforms(agent_tools);
    let missing_before = if selected_platforms.is_empty() {
        Vec::new()
    } else {
        snapshot_missing_paths(runtime, repo_path, &selected_platforms).await
    };

    let output = run_init_process(runtime, repo_path, agent_tools, &mode, true).await?;
    if output.success() {
        return finish_init(repo_path, Ok(())).await;
    }

    let repair_platforms = repair_platforms_for_failure(repo_path, agent_tools, &output);
    if repair_platforms.is_empty() {
        crate::logging::warn(&format!(
            "命令失败(exit={}): {fallback_prefix}\nstdout: {}\nstderr: {}",
            output.exit_code,
            output.stdout_tail(ERROR_TAIL_CHARS),
            output.stderr_tail(ERROR_TAIL_CHARS),
        ));
        return Err(trellis_failure(agent_tools, &output, fallback_prefix));
    }
    crate::logging::info(&format!(
        "首次初始化命中 {} 模板 EXDEV，进入补齐（exit={}）",
        repair_platform_label(&repair_platforms),
        output.exit_code
    ));

    let repair = run_repair_helper(runtime, repo_path, "repair", &repair_platforms).await?;
    if !repair.success() {
        return Err(repair_failure(agent_tools, &repair_platforms, &repair));
    }

    // 只重试一次；补齐或重试失败都必须返回可定位错误，不伪造成功。
    let retry = run_init_process(runtime, repo_path, agent_tools, &mode, false).await?;
    if !retry.success() {
        return Err(retry_failure(agent_tools, &repair_platforms, &retry, fallback_prefix));
    }

    // 哈希补偿是尽力而为：失败不改变已经成功的初始化结果。
    if !missing_before.is_empty() {
        let _ = run_hash_helper(runtime, repo_path, &repair_platforms, &missing_before).await;
    }
    finish_init(repo_path, Ok(())).await
}

/// 所选工具中需要 EXDEV 补齐的 Pi / OMP 平台，固定顺序为 pi、omp。
fn selected_repair_platforms(agent_tools: &[String]) -> Vec<String> {
    REPAIR_PLATFORMS
        .iter()
        .filter(|&&(id, _)| agent_tools.iter().any(|tool| tool.trim() == id))
        .map(|&(id, _)| id.to_string())
        .collect()
}

/// 仅当输出含 EXDEV、所选工具含 Pi / OMP 且扩展目录签名成立时触发补齐。
/// 同时选择 Pi 与 OMP 且任一签名成立时返回全部所选平台，一次补齐覆盖两者。
fn repair_platforms_for_failure(
    repo_path: &Path,
    agent_tools: &[String],
    output: &ProcessOutput,
) -> Vec<String> {
    let combined = format!("{}\n{}", output.stderr, output.stdout);
    if !combined.contains("EXDEV") {
        return Vec::new();
    }
    let selected = selected_repair_platforms(agent_tools);
    if selected.is_empty() {
        return Vec::new();
    }
    let signed = REPAIR_PLATFORMS.iter().any(|&(id, extension_dir)| {
        if !selected.iter().any(|platform| platform.as_str() == id) {
            return false;
        }
        let windows_dir = extension_dir.replace('/', "\\");
        combined.contains(extension_dir)
            || combined.contains(windows_dir.as_str())
            || repo_path.join(extension_dir).exists()
    });
    if signed {
        selected
    } else {
        Vec::new()
    }
}

fn repair_helper_args(
    cli_path: &Path,
    repo_path: &Path,
    mode: &str,
    platforms: &[String],
) -> Vec<String> {
    let mut args = vec![
        "--input-type=module".to_string(),
        "-".to_string(),
        cli_path.to_string_lossy().into_owned(),
        repo_path.to_string_lossy().into_owned(),
        mode.to_string(),
    ];
    args.extend(platforms.iter().cloned());
    args
}

fn hash_helper_args(cli_path: &Path, repo_path: &Path, payload_json: &str) -> Vec<String> {
    vec![
        "--input-type=module".to_string(),
        "-".to_string(),
        cli_path.to_string_lossy().into_owned(),
        repo_path.to_string_lossy().into_owned(),
        "hash".to_string(),
        payload_json.to_string(),
    ]
}

async fn run_repair_helper(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    mode: &str,
    platforms: &[String],
) -> AgentResult<ProcessOutput> {
    let args = repair_helper_args(&runtime.cli_path, repo_path, mode, platforms);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        stdin: Some(AGENT_TEMPLATE_REPAIR_HELPER.as_bytes().to_vec()),
        timeout: Some(REPAIR_TIMEOUT),
        max_output_bytes: INIT_MAX_OUTPUT_BYTES,
        ..ProcessOptions::default()
    };
    run_process(&runtime.node_exe, &args, &options).await
}

async fn run_hash_helper(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    platforms: &[String],
    missing: &[String],
) -> AgentResult<ProcessOutput> {
    let payload = json!({
        "platforms": platforms,
        "missing": missing,
    })
    .to_string();
    let args = hash_helper_args(&runtime.cli_path, repo_path, &payload);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        stdin: Some(AGENT_TEMPLATE_REPAIR_HELPER.as_bytes().to_vec()),
        timeout: Some(REPAIR_TIMEOUT),
        max_output_bytes: INIT_MAX_OUTPUT_BYTES,
        ..ProcessOptions::default()
    };
    run_process(&runtime.node_exe, &args, &options).await
}

/// snapshot 失败静默降级为空列表，不阻塞主初始化流程。
async fn snapshot_missing_paths(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    platforms: &[String],
) -> Vec<String> {
    match run_repair_helper(runtime, repo_path, "snapshot", platforms).await {
        Ok(output) if output.success() => parse_snapshot_missing_paths(&output.stdout),
        _ => Vec::new(),
    }
}

/// 取 stdout 最后一个以 `{` 开头的非空行，解析缺失模板路径。
fn parse_snapshot_missing_paths(stdout: &str) -> Vec<String> {
    let Some(line) = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
    else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    value
        .get("missing")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn repair_platform_label(platforms: &[String]) -> String {
    let mut labels = Vec::new();
    if platforms.iter().any(|platform| platform.as_str() == "pi") {
        labels.push("Pi");
    }
    if platforms.iter().any(|platform| platform.as_str() == "omp") {
        labels.push("OMP");
    }
    if labels.is_empty() {
        labels.push("Pi/OMP");
    }
    labels.join("/")
}

async fn finish_init(repo_path: &Path, result: AgentResult<()>) -> AgentResult<()> {
    if result.is_ok() {
        let _ = cleanup_template_hashes(repo_path).await;
    }
    result
}

async fn cleanup_template_hashes(repo_path: &Path) -> io::Result<()> {
    let path = repo_path.join(".trellis").join(".template-hashes.json");
    let bytes = tokio::fs::read(&path).await?;
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let hashes = manifest
        .get_mut("hashes")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "模板哈希清单缺少 hashes 对象",
            )
        })?;
    let stale_keys: Vec<String> = hashes
        .keys()
        .filter(|key| is_pycache_hash(key))
        .cloned()
        .collect();
    if stale_keys.is_empty() {
        return Ok(());
    }
    for key in stale_keys {
        hashes.remove(&key);
    }

    let mut encoded = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if bytes.ends_with(b"\n") {
        encoded.push(b'\n');
    }
    write_manifest_atomic(&path, &encoded).await
}

fn is_pycache_hash(key: &str) -> bool {
    let normalized = key.replace('\\', "/");
    normalized
        .split('/')
        .any(|segment| segment == "__pycache__")
        || normalized.ends_with(".pyc")
}

async fn write_manifest_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "template-hashes.json".to_string());
    let temp = path.with_file_name(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = async {
        let mut handle = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await?;
        handle.write_all(data).await?;
        handle.sync_all().await?;
        drop(handle);
        tokio::fs::rename(&temp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

/// 非目标错误或补齐未触发时的通用失败：保留原始 init 错误并附带 stderr 末 2 KiB。
fn trellis_failure(
    agent_tools: &[String],
    output: &ProcessOutput,
    fallback_prefix: &str,
) -> AgentError {
    let message = format!("{fallback_prefix}：{}", error_tail(output));
    AgentError::new(code::GIT_FAILED, message).with_details(Some(json!({
        "exitCode": output.exit_code,
        "agentTools": agent_tools,
        "repairPlatforms": [],
    })))
}

/// 补齐 helper 自身失败：不重试，返回可定位的平台与原始输出。
fn repair_failure(
    agent_tools: &[String],
    platforms: &[String],
    output: &ProcessOutput,
) -> AgentError {
    let message = format!(
        "{} 模板补齐失败：{}",
        repair_platform_label(platforms),
        error_tail(output)
    );
    AgentError::new(code::GIT_FAILED, message).with_details(Some(json!({
        "exitCode": output.exit_code,
        "agentTools": agent_tools,
        "repairPlatforms": platforms,
        "repairFailed": true,
    })))
}

/// Agent-only developer helper 失败：返回名称与原始输出，不继续配置平台。
fn developer_failure(developer_id: &str, output: &ProcessOutput) -> AgentError {
    let message = format!("Trellis developer 初始化失败：{}", error_tail(output));
    AgentError::new(code::GIT_FAILED, message).with_details(Some(json!({
        "exitCode": output.exit_code,
        "developer": developer_id,
        "developerFailed": true,
    })))
}

/// 模板已补齐但单次重试仍失败：不循环重试，保留原始重试输出。
fn retry_failure(
    agent_tools: &[String],
    platforms: &[String],
    output: &ProcessOutput,
    fallback_prefix: &str,
) -> AgentError {
    let message = format!(
        "{fallback_prefix}（模板已补齐，重试仍失败）：{}",
        error_tail(output)
    );
    AgentError::new(code::GIT_FAILED, message).with_details(Some(json!({
        "exitCode": output.exit_code,
        "agentTools": agent_tools,
        "repairPlatforms": platforms,
        "retryFailed": true,
    })))
}

fn error_tail(output: &ProcessOutput) -> String {
    let source = if output.stderr.trim().is_empty() {
        &output.stdout
    } else {
        &output.stderr
    };
    let tail: String = source
        .chars()
        .rev()
        .take(ERROR_TAIL_CHARS)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        return format!("退出码 {}", output.exit_code);
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests;
