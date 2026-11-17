//! 固定 Trellis 运行环境的 CLI 执行层：负责完整 `init` 和已有任务树的 Agent-only 配置，
//! 不负责安装运行环境（见 env.rs），也不下载模板。
//! 工具映射对照 shared/trellis-agent-tools.js；行为对照 desktop/sidecar/trellis-runtime.js。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::agent::process::{run_process, ProcessOptions, ProcessOutput};
use crate::agent::protocol::{code, AgentError, AgentResult};

const INIT_TIMEOUT: Duration = Duration::from_secs(210);
const INIT_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const ERROR_TAIL_CHARS: usize = 2 * 1024;
const AGENT_ONLY_INIT_HELPER: &str = include_str!("agent_only_init.mjs");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrellisRuntime {
    pub node_exe: PathBuf,
    pub cli_path: PathBuf,
}

struct AgentTool {
    id: &'static str,
    flag: &'static str,
    presence_paths: &'static [&'static str],
    /// 是否要求全部 presencePaths 命中（对照 JS 的 presenceMode: 'all'）。
    all_presence: bool,
}

const AGENT_TOOLS: [AgentTool; 22] = [
    AgentTool {
        id: "cursor",
        flag: "--cursor",
        presence_paths: &[".cursor"],
        all_presence: false,
    },
    AgentTool {
        id: "claude-code",
        flag: "--claude",
        presence_paths: &[".claude"],
        all_presence: false,
    },
    AgentTool {
        id: "opencode",
        flag: "--opencode",
        presence_paths: &[".opencode"],
        all_presence: false,
    },
    AgentTool {
        id: "codex",
        flag: "--codex",
        presence_paths: &[".codex"],
        all_presence: false,
    },
    AgentTool {
        id: "kilo",
        flag: "--kilo",
        presence_paths: &[".kilocode"],
        all_presence: false,
    },
    AgentTool {
        id: "kiro",
        flag: "--kiro",
        presence_paths: &[".kiro/skills", ".kiro/agents", ".kiro/hooks"],
        all_presence: false,
    },
    AgentTool {
        id: "gemini",
        flag: "--gemini",
        presence_paths: &[".gemini"],
        all_presence: false,
    },
    AgentTool {
        id: "antigravity",
        flag: "--antigravity",
        presence_paths: &[".agent/workflows", ".agent/skills"],
        all_presence: false,
    },
    AgentTool {
        id: "devin",
        flag: "--devin",
        presence_paths: &[".devin/workflows", ".devin/skills"],
        all_presence: false,
    },
    AgentTool {
        id: "qoder",
        flag: "--qoder",
        presence_paths: &[".qoder"],
        all_presence: false,
    },
    AgentTool {
        id: "codebuddy",
        flag: "--codebuddy",
        presence_paths: &[".codebuddy"],
        all_presence: false,
    },
    AgentTool {
        id: "copilot",
        flag: "--copilot",
        presence_paths: &[".github/copilot", ".github/copilot-instructions.md"],
        all_presence: false,
    },
    AgentTool {
        id: "droid",
        flag: "--droid",
        presence_paths: &[".factory"],
        all_presence: false,
    },
    AgentTool {
        id: "dsh",
        flag: "--dsh",
        presence_paths: &[".dsh"],
        all_presence: false,
    },
    AgentTool {
        id: "pi",
        flag: "--pi",
        presence_paths: &[".pi/extensions/trellis/index.ts", ".pi/settings.json"],
        all_presence: true,
    },
    AgentTool {
        id: "reasonix",
        flag: "--reasonix",
        presence_paths: &[".reasonix"],
        all_presence: false,
    },
    AgentTool {
        id: "zcode",
        flag: "--zcode",
        presence_paths: &[".zcode"],
        all_presence: false,
    },
    AgentTool {
        id: "omp",
        flag: "--omp",
        presence_paths: &[".omp"],
        all_presence: false,
    },
    AgentTool {
        id: "trae",
        flag: "--trae",
        presence_paths: &[".trae"],
        all_presence: false,
    },
    AgentTool {
        id: "grok",
        flag: "--grok",
        presence_paths: &[".grok"],
        all_presence: false,
    },
    AgentTool {
        id: "kimi",
        flag: "--kimi",
        presence_paths: &[".kimi-code"],
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
        flags.push(entry.flag.to_string());
        if entry.id == "pi" {
            flags.push("--pi-presence".to_string());
            flags.push("all".to_string());
        }
    }
    flags
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
pub async fn initialize_trellis(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    developer_id: &str,
    agent_tools: &[String],
) -> AgentResult<()> {
    let args = init_args(&runtime.cli_path, developer_id, agent_tools);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        timeout: Some(INIT_TIMEOUT),
        max_output_bytes: INIT_MAX_OUTPUT_BYTES,
        ..ProcessOptions::default()
    };
    let output = run_process(&runtime.node_exe, &args, &options).await?;
    if output.success() {
        return Ok(());
    }
    Err(trellis_failure(
        repo_path,
        agent_tools,
        &output,
        "Trellis 初始化失败",
    ))
}

/// 已有 Trellis 任务树时只通过 stdin 执行内嵌 helper，复用 Trellis 包的平台配置器和模板哈希。
pub async fn initialize_agents(
    runtime: &TrellisRuntime,
    repo_path: &Path,
    agent_tools: &[String],
) -> AgentResult<()> {
    let args = agent_only_args(&runtime.cli_path, repo_path, agent_tools);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        stdin: Some(AGENT_ONLY_INIT_HELPER.as_bytes().to_vec()),
        timeout: Some(INIT_TIMEOUT),
        max_output_bytes: INIT_MAX_OUTPUT_BYTES,
        ..ProcessOptions::default()
    };
    let output = run_process(&runtime.node_exe, &args, &options).await?;
    if output.success() {
        return Ok(());
    }
    Err(trellis_failure(
        repo_path,
        agent_tools,
        &output,
        "Trellis Agent 配置失败",
    ))
}

/// JS 侧的 Pi 修复依赖打包的 trellis-pi-repair.mjs，Rust 运行环境没有该脚本，
/// 因此不伪造修复成功：保留原始 init 错误并附带 stderr 末 2 KiB，交由界面提示重装/重试。
fn trellis_failure(
    repo_path: &Path,
    agent_tools: &[String],
    output: &ProcessOutput,
    fallback_prefix: &str,
) -> AgentError {
    let combined = format!("{}\n{}", output.stderr, output.stdout);
    let pi_repair_required = agent_tools.iter().any(|tool| tool.trim() == "pi")
        && combined.contains("EXDEV")
        && repo_path
            .join(".pi")
            .join("extensions")
            .join("trellis")
            .exists();
    let message = if pi_repair_required {
        format!("Pi 模板补齐失败：{}", error_tail(output))
    } else {
        format!("{fallback_prefix}：{}", error_tail(output))
    };
    AgentError::new(code::GIT_FAILED, message).with_details(Some(json!({
        "exitCode": output.exit_code,
        "agentTools": agent_tools,
        "piRepairRequired": pi_repair_required,
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
mod tests {
    use super::*;

    #[test]
    fn maps_tool_ids_to_init_flags() {
        let tools = vec![
            "cursor".to_string(),
            "pi".to_string(),
            "unknown-tool".to_string(),
        ];
        assert_eq!(
            trellis_agent_tool_flags(&tools),
            vec!["--cursor", "--pi", "--pi-presence", "all"]
        );
        assert!(trellis_agent_tool_flags(&[]).is_empty());
        assert_eq!(
            trellis_agent_tool_flags(&["claude-code".to_string()]),
            vec!["--claude"]
        );
    }

    #[test]
    fn builds_init_arguments_in_order() {
        let tools = vec!["codex".to_string(), "snow".to_string()];
        assert_eq!(
            init_args(Path::new(r"C:\runtime\trellis.js"), "dev-1", &tools),
            vec![
                r"C:\runtime\trellis.js".to_string(),
                "init".to_string(),
                "-y".to_string(),
                "--skip-existing".to_string(),
                "-u".to_string(),
                "dev-1".to_string(),
                "--codex".to_string(),
                "--snow".to_string(),
            ]
        );
    }

    #[test]
    fn builds_agent_only_helper_arguments() {
        let tools = vec!["codex".to_string(), "snow".to_string()];
        assert_eq!(
            agent_only_args(
                Path::new(r"C:\runtime\trellis.js"),
                Path::new(r"C:\repo"),
                &tools
            ),
            vec![
                "--input-type=module".to_string(),
                "-".to_string(),
                r"C:\runtime\trellis.js".to_string(),
                r"C:\repo".to_string(),
                "codex".to_string(),
                "snow".to_string(),
            ]
        );
    }

    #[test]
    fn agent_only_helper_uses_trellis_configurators() {
        assert!(AGENT_ONLY_INIT_HELPER.contains("resolveSupportedPython"));
        assert!(AGENT_ONLY_INIT_HELPER.contains("PLATFORM_IDS"));
        assert!(AGENT_ONLY_INIT_HELPER.contains("configurePlatform"));
        assert!(AGENT_ONLY_INIT_HELPER.contains("setWriteMode(\"skip\")"));
        assert!(AGENT_ONLY_INIT_HELPER.contains("initializeHashes"));
        assert!(!AGENT_ONLY_INIT_HELPER.contains(".trellis/spec"));
    }

    #[test]
    fn maps_agent_only_pi_exdev_failure() {
        let root =
            std::env::temp_dir().join(format!("trellis-cli-failure-{}", uuid::Uuid::new_v4()));
        let output = ProcessOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "configure failed".to_string(),
        };
        let error = trellis_failure(
            &root,
            &["codex".to_string()],
            &output,
            "Trellis Agent 配置失败",
        );
        assert!(error.message.starts_with("Trellis Agent 配置失败："));

        std::fs::create_dir_all(root.join(".pi").join("extensions").join("trellis")).unwrap();
        let output = ProcessOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "EXDEV: cross-device link not permitted".to_string(),
        };
        let error = trellis_failure(
            &root,
            &["pi".to_string()],
            &output,
            "Trellis Agent 配置失败",
        );
        assert!(error.message.starts_with("Pi 模板补齐失败："));
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("piRepairRequired"))
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn detects_tools_from_repository_markers() {
        let root =
            std::env::temp_dir().join(format!("trellis-cli-detect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".cursor")).unwrap();
        std::fs::create_dir_all(root.join(".pi").join("extensions").join("trellis")).unwrap();
        std::fs::write(
            root.join(".pi")
                .join("extensions")
                .join("trellis")
                .join("index.ts"),
            "",
        )
        .unwrap();
        assert_eq!(detect_agent_tools(&root).await, vec!["cursor".to_string()]);
        std::fs::write(root.join(".pi").join("settings.json"), "{}").unwrap();
        assert_eq!(
            detect_agent_tools(&root).await,
            vec!["cursor".to_string(), "pi".to_string()]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
