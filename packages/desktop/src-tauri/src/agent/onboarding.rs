//! 项目接入（onboarding）：`inspect` / `initialize` / `checkInitialPush` / `preflight` / `attach`。
//! 来源 JS：desktop/sidecar/agent/project-onboarding.js（全文），
//! 以及 agent/git-sync.js 中的 inspectGitProject / normalizeRemoteIdentity / normalizeLocalRepoKey /
//! readRepositoryState / compareRemoteBranch。
//! 只复用 git / trellis_cli / process / protocol 的既有能力，不新增 Git 调用方式。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::agent::company_spec::{
    self, CompanySpecChoice, CompanySpecInit, CompanySpecOutcome, CompanySpecRequest,
    CompanySpecSelection, SelectionResult,
};
use crate::agent::git::{self, GitStatusEntry};
use crate::agent::http::ApiClient;
use crate::agent::process::{run_process, ProcessOptions};
use crate::agent::protocol::{code, err, now_iso8601, safe_error_message, AgentError, AgentResult};
use crate::agent::store::{AgentBinding, AgentConfig, ConfigStore};
use crate::agent::task_command::recorded_python;
use crate::agent::trellis_cli::{self, TrellisRuntime};

/// 与 JS 的 TASK_SNAPSHOT_REQUEST_TIMEOUT_MS 不同：attach 走默认 30s 请求超时。
const ATTACH_TIMEOUT: Duration = Duration::from_secs(30);
/// 服务端任务空间预检（JS 为 120s）。
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_DIRTY_SUMMARY_CHARS: usize = 500;
const MAX_REMOTE_LENGTH: usize = 4096;
const MAX_REPO_PATH_LENGTH: usize = 4096;
const DEFAULT_INITIAL_SYNC_MODE: &str = "review";
const INITIAL_SYNC_MODES: [&str; 3] = ["bootstrap", "safe", "review"];
const INITIAL_COMMIT_MESSAGE: &str = "初始化trellis";
const GITIGNORE_TITLE: &str = "# Trellis local agent configs (local only)";
const SHARED_GITIGNORE_TITLE: &str = "# Trellis shared initialization files (tracked by Board)";
/// `trellis init` 写入的模板基线：只描述本机磁盘状态，不随仓库共享
/// （见 `.trellis/spec/backend/desktop-agent-runtime.md` 第 6 节）。
const TEMPLATE_HASHES_PATH: &str = ".trellis/.template-hashes.json";
const TEMPLATE_HASHES_RULE: &str = "/.trellis/.template-hashes.json";
const LOCAL_STATE_TITLE: &str = "# Trellis local state (local only)";
const MAX_DEVELOPER_NAME_CHARS: usize = 120;

/// 一键初始化提交包含的固定路径；`.trellis` 必需，其余存在时才提交。
const INITIAL_COMMIT_PATHS: [&str; 5] = [
    ".trellis",
    ".gitignore",
    "AGENTS.md",
    ".gitattributes",
    ".agents",
];

/// 暂存路径是否属于本次初始化提交范围（顶层目录下的文件或固定的根文件）。
fn is_initial_commit_path(path: &str) -> bool {
    INITIAL_COMMIT_PATHS.iter().any(|entry| {
        path == *entry
            || path
                .strip_prefix(*entry)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// checkInitialPush 的状态取值（对照 JS 的 `state`）。
pub const PUSH_WAITING_COMMIT: &str = "waiting_commit";
pub const PUSH_BRANCH_MISSING: &str = "branch_missing";
pub const PUSH_UNABLE_TO_VERIFY: &str = "unable_to_verify";
/// 初始化提交已推送（任务描述里的 "pushed"，JS 原文为 ready）。
pub const PUSH_READY: &str = "ready";
pub const PUSH_WAITING_PUSH: &str = "waiting_push";
pub const PUSH_REMOTE_AHEAD: &str = "remote_ahead";
pub const PUSH_DIVERGED: &str = "diverged";

/// inspectProject 的返回值（字段与 JS 展开后的对象一一对应）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInspection {
    pub root: String,
    pub local_repo_key: String,
    pub branch_name: String,
    pub current_branch: String,
    #[serde(default)]
    pub head: Option<String>,
    pub clean: bool,
    pub dirty_summary: String,
    pub remote_url: String,
    pub remote_identity_key: String,
    pub has_trellis: bool,
    pub has_tasks: bool,
    pub has_committed_trellis: bool,
    pub requires_initialization: bool,
    pub existing_agent_tools: Vec<String>,
    pub repository_name: String,
    #[serde(default)]
    pub developer_name: Option<String>,
}

/// normalizeRemoteIdentity 的结果；`identity_hash` 用于远端身份比对。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteIdentity {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub identity_hash: String,
}

/// checkInitialPush 的返回值。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialPushState {
    pub state: String,
    pub message: String,
    pub local_head: Option<String>,
    pub remote_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dirty_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_ahead: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ahead: Option<u32>,
}

impl InitialPushState {
    fn new(
        state: &str,
        message: impl Into<String>,
        local_head: Option<String>,
        remote_head: Option<String>,
    ) -> Self {
        Self {
            state: state.to_string(),
            message: message.into(),
            local_head,
            remote_head,
            dirty_summary: None,
            local_ahead: None,
            remote_ahead: None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.state == PUSH_READY
    }

    /// 状态是否意味着本地分支还不存在（远端没有该分支）。
    #[cfg(test)]
    pub fn is_branch_missing(&self) -> bool {
        self.state == PUSH_BRANCH_MISSING
    }
}

/// 本地预检结果：服务端预检（preflightTaskSpaceAccess）与快照比对由调用方补齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub inspected: ProjectInspection,
    pub team_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<InitialPushState>,
}

/// initializeProject 的入参。
/// ponytail: 不注入 process runner —— trellis init 的执行由 trellis_cli 独占，
/// 需要替换进程执行时改 trellis_cli，而不是在这里再开一条路径。
pub struct InitializeOptions<'a> {
    pub repo_path: &'a Path,
    pub hooks_dir: &'a Path,
    pub developer_id: &'a str,
    pub agent_tools: &'a [String],
    pub runtime: &'a TrellisRuntime,
    pub allow_file_remote: bool,
    /// Bundled/development `trellis-kit` directory; initialization fails if absent.
    pub kit_root: Option<&'a Path>,
    /// 公司开发规范套用请求；None 表示 feature 不可用或未启用。
    pub company_spec: Option<CompanySpecRequest>,
}

/// `initialize_project` 的返回：项目预检结果 + 本次公司规范套用结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeProjectResult {
    pub project: ProjectInspection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub company_spec: Option<CompanySpecOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InitializationMode {
    FullInit,
    AgentsOnly,
    None,
}

fn initialization_mode(
    has_trellis: bool,
    has_tasks: bool,
    tools_missing: bool,
) -> InitializationMode {
    if !has_trellis || !has_tasks {
        InitializationMode::FullInit
    } else if tools_missing {
        InitializationMode::AgentsOnly
    } else {
        InitializationMode::None
    }
}

pub struct AttachOptions<'a> {
    pub repo_path: &'a Path,
    pub hooks_dir: &'a Path,
    pub team_id: &'a str,
    pub developer_id: &'a str,
    pub expected_branch: Option<&'a str>,
    pub display_name: Option<&'a str>,
    pub allow_file_remote: bool,
    pub require_pushed: bool,
    pub is_worktree: bool,
    /// bootstrap / safe / review；None 视为 review（对照 JS 默认值）。
    pub initial_sync_mode: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedProject {
    pub id: String,
    #[serde(default)]
    pub owner_team_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub baseline_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedTaskSpace {
    pub id: String,
    #[serde(default)]
    pub is_worktree: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBinding {
    id: String,
    #[serde(default)]
    read_only: Option<bool>,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachedPayload {
    project: AttachedProject,
    task_space: AttachedTaskSpace,
    binding: ServerBinding,
}

/// attachProject 的返回值：`status` + 服务端 project/taskSpace + 本地绑定 + 复检结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachResult {
    pub status: String,
    pub project: AttachedProject,
    pub task_space: AttachedTaskSpace,
    pub binding: AgentBinding,
    pub inspected: ProjectInspection,
}

struct RepositorySnapshot {
    root: PathBuf,
    local_repo_key: String,
    current_branch: String,
    head: Option<String>,
    clean: bool,
    dirty_summary: String,
    remote_url: String,
    remote_identity_key: String,
}

/// 对照 JS inspectProject。
pub async fn inspect_project(
    repo_path: &Path,
    hooks_dir: &Path,
    allow_file_remote: bool,
) -> AgentResult<ProjectInspection> {
    inspect_project_with(repo_path, hooks_dir, allow_file_remote, None).await
}

pub async fn inspect_project_with(
    repo_path: &Path,
    hooks_dir: &Path,
    allow_file_remote: bool,
    expected_branch: Option<&str>,
) -> AgentResult<ProjectInspection> {
    let snapshot =
        inspect_git_project(repo_path, hooks_dir, allow_file_remote, expected_branch).await?;
    let trellis_dir = snapshot.root.join(".trellis");
    let tasks_dir = trellis_dir.join("tasks");
    let has_trellis = path_exists(&trellis_dir).await;
    let has_tasks = path_exists(&tasks_dir).await;
    // JS 把 ls-tree 失败视为空列表；这里同样降级为空。
    let head_paths = git::ls_tree(&snapshot.root, hooks_dir, None)
        .await
        .unwrap_or_default();
    // ponytail: JS 会把 HEAD 树路径并入 detectTrellisAgentTools。sparse checkout 已被拒绝，
    // 工作区与 HEAD 一致，因此直接检测工作区，避免在 onboarding 里重复维护 22 条工具表。
    let existing_agent_tools = trellis_cli::detect_agent_tools(&snapshot.root).await;
    let repository_name = snapshot
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let developer_name = read_developer_name(&snapshot.root).await;
    Ok(ProjectInspection {
        root: snapshot.root.to_string_lossy().into_owned(),
        local_repo_key: snapshot.local_repo_key,
        branch_name: snapshot.current_branch.clone(),
        current_branch: snapshot.current_branch,
        head: snapshot.head,
        clean: snapshot.clean,
        dirty_summary: snapshot.dirty_summary,
        remote_url: snapshot.remote_url,
        remote_identity_key: snapshot.remote_identity_key,
        has_trellis,
        has_tasks,
        has_committed_trellis: !head_paths.is_empty(),
        requires_initialization: !has_trellis || !has_tasks,
        existing_agent_tools,
        repository_name,
        developer_name,
    })
}

/// 读取 `.trellis/.developer` 的首个 `name=`；文件缺失、不可读或名称为空时返回 None。
async fn read_developer_name(repo_path: &Path) -> Option<String> {
    let text = tokio::fs::read_to_string(repo_path.join(".trellis").join(".developer"))
        .await
        .ok()?;
    for line in text.lines() {
        let Some(value) = line.strip_prefix("name=") else {
            continue;
        };
        let name = value.trim();
        if name.is_empty() || name.chars().count() > MAX_DEVELOPER_NAME_CHARS {
            return None;
        }
        return Some(name.to_string());
    }
    None
}

/// 把所选 Agent 工具的本机配置路径、共享初始化文件与本机模板基线写入项目根 `.gitignore`。
/// 保留原内容与换行风格；等价规则（忽略首尾 `/` 与空白）不重复添加；无新增时不写文件。
async fn ensure_agent_gitignore(repo_path: &Path, agent_tools: &[String]) -> AgentResult<()> {
    let rules = trellis_cli::agent_gitignore_paths(agent_tools);
    if !rules.is_empty() {
        append_gitignore_rules(repo_path, GITIGNORE_TITLE, &rules).await?;
    }
    ensure_shared_gitignore_rules(repo_path).await?;
    ensure_template_hashes_ignored(repo_path).await
}

/// `.template-hashes.json` 只描述本机磁盘状态，忽略后不再随仓库共享。
async fn ensure_template_hashes_ignored(repo_path: &Path) -> AgentResult<()> {
    let rules = [TEMPLATE_HASHES_RULE.to_string()];
    append_gitignore_rules_at_end(repo_path, LOCAL_STATE_TITLE, &rules, true).await
}

/// 用一键提交已有的固定路径生成反忽略规则，避免维护第二份共享路径清单。
fn shared_gitignore_rules() -> Vec<String> {
    let mut rules = Vec::with_capacity(INITIAL_COMMIT_PATHS.len() + 2);
    for path in INITIAL_COMMIT_PATHS {
        if path == ".trellis" || path == ".agents" {
            rules.push(format!("!/{path}/"));
            rules.push(format!("!/{path}/**"));
        } else {
            rules.push(format!("!/{path}"));
        }
    }
    rules
}

async fn ensure_shared_gitignore_rules(repo_path: &Path) -> AgentResult<()> {
    let rules = shared_gitignore_rules();
    append_gitignore_rules_at_end(repo_path, SHARED_GITIGNORE_TITLE, &rules, false).await
}

/// 生成的规则必须位于用户规则之后；`replace_equivalents` 用于本机状态规则的全局去重。
async fn append_gitignore_rules_at_end(
    repo_path: &Path,
    title: &str,
    rules: &[String],
    replace_equivalents: bool,
) -> AgentResult<()> {
    let path = repo_path.join(".gitignore");
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return err(
                code::GIT_FAILED,
                format!("无法读取项目 .gitignore：{error}"),
            )
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| {
        AgentError::new(
            code::GIT_FAILED,
            "项目 .gitignore 不是 UTF-8 编码，无法安全追加忽略规则",
        )
    })?;
    let normalized_rules = rules
        .iter()
        .map(|rule| normalize_gitignore_rule(rule))
        .collect::<HashSet<_>>();
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let kept = if replace_equivalents {
        text.lines()
            .filter(|line| {
                line.trim() != title && !normalized_rules.contains(&normalize_gitignore_rule(line))
            })
            .collect()
    } else {
        without_managed_gitignore_section(&text, title, &normalized_rules)
    };
    let mut next = kept.join(newline);
    if !next.is_empty() && !next.ends_with('\n') {
        next.push_str(newline);
    }
    next.push_str(title);
    next.push_str(newline);
    for rule in rules {
        next.push_str(rule);
        next.push_str(newline);
    }
    if next == text {
        return Ok(());
    }
    tokio::fs::write(&path, next.as_bytes())
        .await
        .map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法写入项目 .gitignore：{error}"),
            )
        })
}

/// 只移除本客户端专用标题下的连续生成块，保留用户在其它位置写的等价规则。
fn without_managed_gitignore_section<'a>(
    text: &'a str,
    title: &str,
    managed_rules: &HashSet<String>,
) -> Vec<&'a str> {
    let mut kept = Vec::new();
    let mut in_managed_section = false;
    for line in text.lines() {
        if line.trim() == title {
            in_managed_section = true;
            continue;
        }
        if in_managed_section {
            let trimmed = line.trim();
            if trimmed.is_empty() || managed_rules.contains(&normalize_gitignore_rule(line)) {
                continue;
            }
            in_managed_section = false;
        }
        kept.push(line);
    }
    kept
}

/// 按小节追加规则：标题与已存在的等价规则都不重复写，无新增时不动文件。
async fn append_gitignore_rules(repo_path: &Path, title: &str, rules: &[&str]) -> AgentResult<()> {
    let path = repo_path.join(".gitignore");
    let bytes = match tokio::fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => {
            return err(
                code::GIT_FAILED,
                format!("无法读取项目 .gitignore：{error}"),
            )
        }
    };
    let text = String::from_utf8(bytes).map_err(|_| {
        AgentError::new(
            code::GIT_FAILED,
            "项目 .gitignore 不是 UTF-8 编码，无法安全追加忽略规则",
        )
    })?;
    let existing: HashSet<String> = text.lines().map(normalize_gitignore_rule).collect();
    let missing: Vec<&str> = rules
        .iter()
        .copied()
        .filter(|rule| !existing.contains(&normalize_gitignore_rule(rule)))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut next = text;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push_str(newline);
    }
    if !next.lines().any(|line| line.trim() == title) {
        next.push_str(title);
        next.push_str(newline);
    }
    for rule in missing {
        next.push_str(rule);
        next.push_str(newline);
    }
    tokio::fs::write(&path, next.as_bytes())
        .await
        .map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法写入项目 .gitignore：{error}"),
            )
        })
}

/// `trim` 后去掉首尾 `/`，让 `.codex`、`.codex/`、`/.codex/` 视为同一规则。
fn normalize_gitignore_rule(line: &str) -> String {
    line.trim()
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_string()
}

/// Apply the bundled Trellis Board workflow after `trellis init`/agent-only init.
/// Missing kit is a hard error: a project initialized by the board must not
/// silently fall back to the upstream workflow.
async fn apply_kit_overlay(
    repo_path: &Path,
    kit_root: Option<&Path>,
    agent_tools: &[String],
    features: &[String],
) -> AgentResult<()> {
    let kit_root = kit_root.ok_or_else(|| {
        AgentError::new(
            code::KIT_APPLY_FAILED,
            "找不到 trellis-kit，项目未按 Trellis Board 流程初始化。请重新安装/升级客户端，或设置 TRELLIS_KIT_ROOT。",
        )
    })?;
    let script = kit_root.join("apply.py");
    if !script.is_file() {
        return Err(AgentError::new(
            code::KIT_APPLY_FAILED,
            format!(
                "trellis-kit 缺少 apply.py（{}），项目未按 Trellis Board 流程初始化",
                script.display()
            ),
        ));
    }

    let python = recorded_python()
        .or_else(|| {
            std::env::var("TRELLIS_PYTHON")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "python".to_string());
    let repo = repo_path.to_string_lossy().to_string();
    let mut args = vec![
        script.to_string_lossy().to_string(),
        "--target".to_string(),
        repo.clone(),
        "--force".to_string(),
    ];
    for tool in agent_tools {
        args.push("--platform".to_string());
        args.push(tool.clone());
    }
    for feature in features {
        args.push("--feature".to_string());
        args.push(feature.clone());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut env = BTreeMap::new();
    env.insert("PYTHONUTF8".to_string(), "1".to_string());
    let output = run_process(
        Path::new(&python),
        &arg_refs,
        &ProcessOptions {
            cwd: Some(repo_path.to_path_buf()),
            env: Some(env),
            timeout: Some(Duration::from_secs(120)),
            max_output_bytes: 256 * 1024,
            ..Default::default()
        },
    )
    .await
    .map_err(|error| {
        AgentError::new(
            code::KIT_APPLY_FAILED,
            format!("trellis-kit 执行失败：{}", error.message),
        )
    })?;

    if output.exit_code != 0 {
        let detail = output.stderr_tail(400);
        return Err(AgentError::new(
            code::KIT_APPLY_FAILED,
            format!(
                "trellis-kit apply 失败（exit {}）：{}",
                output.exit_code,
                detail.trim()
            ),
        ));
    }
    Ok(())
}

/// 按请求的选项解析出模板；返回选择结果和要返回给前端的套用状态。
fn resolve_company_spec(
    request: &CompanySpecRequest,
    repo_path: &Path,
) -> (Option<CompanySpecSelection>, Option<CompanySpecOutcome>) {
    let result = match &request.choice {
        CompanySpecChoice::Skip => {
            return (
                None,
                request.warning.as_ref().map(|warning| CompanySpecOutcome {
                    attempted: false,
                    applied: false,
                    project_type: None,
                    template: None,
                    warning: Some(warning.clone()),
                    evidence: Vec::new(),
                }),
            );
        }
        CompanySpecChoice::Auto => {
            let detection = company_spec::detect(repo_path);
            company_spec::select_template(&detection, &request.config.templates)
        }
        CompanySpecChoice::Template(template) => {
            let detection = company_spec::detect(repo_path);
            company_spec::resolve_manual(template, &request.config, &detection)
        }
    };
    match result {
        SelectionResult::Selected(selection) => {
            let outcome = CompanySpecOutcome {
                attempted: true,
                applied: false,
                project_type: selection.project_type.clone(),
                template: Some(selection.template.clone()),
                warning: None,
                evidence: selection.evidence.clone(),
            };
            (Some(selection), Some(outcome))
        }
        SelectionResult::Skipped {
            project_type,
            reason,
            evidence,
        } => (
            None,
            Some(CompanySpecOutcome {
                attempted: true,
                applied: false,
                project_type: Some(project_type),
                template: None,
                warning: Some(reason),
                evidence,
            }),
        ),
    }
}

/// 缺 trellis/tasks 时完整初始化；已有任务树且缺 Agent 时只补平台配置。
pub async fn initialize_project(
    options: &InitializeOptions<'_>,
) -> AgentResult<InitializeProjectResult> {
    let inspected = inspect_project(
        options.repo_path,
        options.hooks_dir,
        options.allow_file_remote,
    )
    .await?;
    let root = PathBuf::from(&inspected.root);
    let selected_tools = normalize_agent_tools(options.agent_tools)?;
    let tools_missing = selected_tools
        .iter()
        .any(|id| !inspected.existing_agent_tools.contains(id));
    let mut company_spec_outcome: Option<CompanySpecOutcome> = None;
    let mut selected_spec: Option<CompanySpecSelection> = None;
    match initialization_mode(inspected.has_trellis, inspected.has_tasks, tools_missing) {
        InitializationMode::FullInit => {
            if let Some(request) = options.company_spec.as_ref() {
                let (selection, outcome) = resolve_company_spec(request, &root);
                selected_spec = selection;
                company_spec_outcome = outcome;
            }
            let spec_init = match (options.company_spec.as_ref(), selected_spec.as_ref()) {
                (Some(request), Some(selection)) => Some(CompanySpecInit {
                    registry_url: &request.config.registry,
                    template: &selection.template,
                }),
                _ => None,
            };
            trellis_cli::initialize_trellis(
                options.runtime,
                &root,
                options.developer_id,
                &selected_tools,
                spec_init.as_ref(),
            )
            .await?;
            if let (Some(selection), Some(outcome)) =
                (selected_spec.as_ref(), company_spec_outcome.as_mut())
            {
                match company_spec::verify(&root, selection) {
                    Ok(()) => outcome.applied = true,
                    Err(reason) => {
                        outcome.warning = Some(format!("公司规范模板已下载但校验失败：{reason}"));
                    }
                }
            }
        }
        InitializationMode::AgentsOnly => {
            trellis_cli::initialize_agents(
                options.runtime,
                &root,
                options.developer_id,
                &selected_tools,
            )
            .await?;
        }
        InitializationMode::None => {}
    }
    // 初始化与 Board workflow 是同一条流程：即使本次无需 trellis init，
    // 也要在 attach 前把 kit 应用到项目，避免新项目只拿到上游默认流程。
    let features: Vec<String> = company_spec_outcome
        .as_ref()
        .filter(|outcome| outcome.applied)
        .map(|_| vec!["company-spec".to_string()])
        .unwrap_or_default();
    apply_kit_overlay(&root, options.kit_root, &selected_tools, &features).await?;
    // 即使本次无需初始化也要执行：失败或旧的半成品可以靠重试补齐忽略规则。
    if let Err(error) = ensure_agent_gitignore(&root, &selected_tools).await {
        return Err(AgentError::new(
            &error.code,
            format!(
                "Trellis 初始化文件可能已生成，但更新项目 .gitignore 失败：{}",
                error.message
            ),
        ));
    }
    let project = inspect_project(&root, options.hooks_dir, options.allow_file_remote).await?;
    Ok(InitializeProjectResult {
        project,
        company_spec: company_spec_outcome,
    })
}

pub async fn check_initial_push_with(
    repo_path: &Path,
    hooks_dir: &Path,
    branch: &str,
    allow_file_remote: bool,
) -> AgentResult<InitialPushState> {
    let snapshot =
        inspect_git_project(repo_path, hooks_dir, allow_file_remote, Some(branch)).await?;
    let head = snapshot.head.clone();
    let committed = match (&head, git::ls_tree(&snapshot.root, hooks_dir, None).await) {
        (Some(_), Ok(paths)) => contains_trellis_entry(&paths),
        _ => false,
    };
    if !committed {
        return Ok(InitialPushState::new(
            PUSH_WAITING_COMMIT,
            "请先提交 .trellis 初始化文件",
            head,
            None,
        ));
    }

    let dirty = git::status_paths(&snapshot.root, hooks_dir, &[".trellis".to_string()]).await;
    match dirty {
        Err(_) => {
            return Ok(InitialPushState::new(
                PUSH_WAITING_COMMIT,
                "无法确认 .trellis 是否已全部提交",
                head,
                None,
            ))
        }
        Ok(entries) if !entries.is_empty() => {
            let mut state = InitialPushState::new(
                PUSH_WAITING_COMMIT,
                ".trellis 仍有未提交文件，请提交后再推送",
                head,
                None,
            );
            state.dirty_summary = Some(dirty_summary(&entries));
            return Ok(state);
        }
        Ok(_) => {}
    }

    let remote = match git::ls_remote(&snapshot.root, hooks_dir, branch).await {
        Ok(Some(output)) => output,
        Ok(None) => {
            return Ok(InitialPushState::new(
                PUSH_BRANCH_MISSING,
                format!("远端分支 {branch} 还不存在，请推送本地分支"),
                head,
                None,
            ))
        }
        // 对照 JS classifyRemoteFailure：远端拒绝 ref 与网络故障要区分开。
        Err(error) => {
            let text = error.message.to_lowercase();
            let missing = text.contains("couldn't find remote ref")
                || text.contains("remote ref does not exist");
            return Ok(if missing {
                InitialPushState::new(
                    PUSH_BRANCH_MISSING,
                    format!("远端分支 {branch} 还不存在，请推送本地分支"),
                    head,
                    None,
                )
            } else {
                InitialPushState::new(
                    PUSH_UNABLE_TO_VERIFY,
                    "暂时无法连接远端，不能确认是否已推送",
                    head,
                    None,
                )
            });
        }
    };

    let Some(remote_head) = remote_branch_sha(&remote, branch) else {
        return Ok(InitialPushState::new(
            PUSH_UNABLE_TO_VERIFY,
            "远端没有返回目标分支，无法确认推送结果",
            head,
            None,
        ));
    };

    if head.as_deref() == Some(remote_head.as_str()) {
        return Ok(InitialPushState::new(
            PUSH_READY,
            "初始化文件已提交并推送到远端",
            head,
            Some(remote_head),
        ));
    }

    let counts = match git::fetch(&snapshot.root, hooks_dir, branch).await {
        Ok(()) => git::rev_list(&snapshot.root, hooks_dir).await.ok(),
        Err(_) => None,
    };
    let Some((local_ahead, remote_ahead)) = counts else {
        return Ok(InitialPushState::new(
            PUSH_UNABLE_TO_VERIFY,
            "已读取远端分支，但无法比较本地与远端提交",
            head,
            Some(remote_head),
        ));
    };

    let (state, message) = if local_ahead > 0 && remote_ahead == 0 {
        (PUSH_WAITING_PUSH, "本地有新提交尚未推送")
    } else if remote_ahead > 0 && local_ahead == 0 {
        (PUSH_REMOTE_AHEAD, "远端分支比本地更新，请先拉取并处理")
    } else {
        (PUSH_DIVERGED, "本地与远端已经分叉，请先处理 Git 历史")
    };
    let mut result = InitialPushState::new(state, message, head, Some(remote_head));
    result.local_ahead = Some(local_ahead);
    result.remote_ahead = Some(remote_ahead);
    Ok(result)
}

/// 一次点击完成初始化提交与推送：只暂存并提交初始化生成的固定路径
/// （`.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents`），
/// commit message 固定，push 当前分支到 origin 同名分支，最后复用推送状态检查。
pub async fn commit_and_push_initial(
    repo_path: &Path,
    hooks_dir: &Path,
    allow_file_remote: bool,
) -> AgentResult<InitialPushState> {
    let snapshot = inspect_git_project(repo_path, hooks_dir, allow_file_remote, None).await?;
    let root = snapshot.root;
    // pathspec 提交按工作区重建这些路径，已跟踪但仍在工作区的 manifest 会被写回提交；
    // 只有索引里没有其它暂存改动时才改走索引提交，让脱管的删除真正落进提交；
    // 读不到索引状态时退回 pathspec 提交，宁可本次不脱管也不卷进未知改动。
    let index_is_scoped = match git::staged_paths(&root, hooks_dir).await {
        Ok(staged) => staged.iter().all(|path| is_initial_commit_path(path)),
        Err(_) => false,
    };
    // 先放行共享初始化文件并重新忽略本机 manifest，再把已跟踪的旧文件从索引移除，
    // 避免本次提交把它带上远端；重试时各步都幂等。没有 .trellis 时不产生副作用。
    if root.join(".trellis").is_dir() {
        ensure_shared_gitignore_rules(&root).await?;
        ensure_template_hashes_ignored(&root).await?;
        if index_is_scoped && git::is_tracked(&root, hooks_dir, TEMPLATE_HASHES_PATH).await? {
            git::untrack_path(&root, hooks_dir, TEMPLATE_HASHES_PATH).await?;
        }
    }
    // 规则修复可能新建 .gitignore，因此路径清单必须在修复完成后再生成。
    let paths = initial_commit_paths(&root);
    git::add_paths(&root, hooks_dir, &paths).await?;
    if git::has_staged_changes(&root, hooks_dir, &paths).await? {
        if index_is_scoped {
            git::commit_index(&root, hooks_dir, INITIAL_COMMIT_MESSAGE).await?;
        } else {
            git::commit_paths(&root, hooks_dir, INITIAL_COMMIT_MESSAGE, &paths).await?;
        }
    } else {
        // 无暂存差异时仍可推送；但 HEAD 里从未出现过 .trellis 说明初始化文件没被纳入 Git。
        let committed = git::ls_tree(&root, hooks_dir, None)
            .await
            .unwrap_or_default();
        if !contains_trellis_entry(&committed) {
            return err(
                code::MISSING_TRELLIS,
                "没有可提交的 .trellis 初始化文件，请检查 .trellis 是否被 .gitignore 忽略",
            );
        }
    }
    git::push_branch(&root, hooks_dir, &snapshot.current_branch).await?;
    check_initial_push_with(
        &root,
        hooks_dir,
        &snapshot.current_branch,
        allow_file_remote,
    )
    .await
}

/// `.trellis` 必需；其余初始化文件只在存在时加入，避免 Git pathspec 报错。
fn initial_commit_paths(repo_path: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    for path in INITIAL_COMMIT_PATHS {
        if path == ".trellis" || repo_path.join(path).exists() {
            paths.push(path.to_string());
        }
    }
    paths
}

/// HEAD 树里是否已有 `.trellis` 文件（ls-tree 只查询 `.trellis` 路径）。
fn contains_trellis_entry(paths: &[String]) -> bool {
    paths.iter().any(|path| path.contains(".trellis/"))
}

pub async fn preflight_project_with(
    repo_path: &Path,
    hooks_dir: &Path,
    team_id: &str,
    allow_file_remote: bool,
    require_pushed: bool,
) -> AgentResult<PreflightResult> {
    let inspected = inspect_project(repo_path, hooks_dir, allow_file_remote).await?;
    ensure_trellis_ready(&inspected)?;
    let push =
        check_required_push(&inspected, hooks_dir, allow_file_remote, require_pushed).await?;
    Ok(PreflightResult {
        inspected,
        team_id: team_id.to_string(),
        push,
    })
}

/// 服务端任务空间预检（对照 JS preflightTaskSpaceAccess）；响应必须是带 status 的对象。
/// ponytail: 本地/远端任务快照差异分组由 task_sync 负责，这里只保证请求与响应形状对齐。
pub async fn preflight_task_space(
    api: &ApiClient,
    inspected: &ProjectInspection,
    team_id: &str,
) -> AgentResult<Value> {
    let body = json!({
        "remoteUrl": inspected.remote_url,
        "branchName": inspected.branch_name,
        "teamId": team_id,
    });
    let payload = api
        .request_json(
            Method::POST,
            "/api/agent/task-spaces/preflight",
            Some(&body),
            PREFLIGHT_TIMEOUT,
        )
        .await?;
    if payload.get("status").and_then(Value::as_str).is_none() {
        return err(code::INVALID_RESPONSE, "服务端返回了无效的任务预检结果");
    }
    Ok(payload)
}

/// 对照 JS attachProject：本地校验 → 服务端 attach → 写入 binding。
pub async fn attach_project(
    api: &ApiClient,
    store: &ConfigStore,
    options: &AttachOptions<'_>,
) -> AgentResult<AttachResult> {
    let mode = normalize_initial_sync_mode(options.initial_sync_mode)?;
    let inspected = inspect_project_with(
        options.repo_path,
        options.hooks_dir,
        options.allow_file_remote,
        options.expected_branch,
    )
    .await?;
    ensure_trellis_ready(&inspected)?;
    check_required_push(
        &inspected,
        options.hooks_dir,
        options.allow_file_remote,
        options.require_pushed,
    )
    .await?;

    let display_name: &str = match options.display_name {
        Some(value) if !value.trim().is_empty() => value,
        _ => &inspected.repository_name,
    };
    let body = json!({
        "remoteUrl": inspected.remote_url,
        "branchName": inspected.branch_name,
        "teamId": options.team_id,
        "developerId": options.developer_id,
        "displayName": display_name,
        "localRepoKey": inspected.local_repo_key,
        "isWorktree": options.is_worktree,
    });
    let payload = api
        .request_json(
            Method::POST,
            "/api/agent/task-spaces/attach",
            Some(&body),
            ATTACH_TIMEOUT,
        )
        .await?;
    let attached: AttachedPayload = serde_json::from_value(payload)
        .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "服务端返回了无效的项目绑定信息"))?;

    let binding = AgentBinding {
        local_id: uuid::Uuid::new_v4().to_string(),
        server_binding_id: Some(attached.binding.id.clone()),
        task_space_id: attached.task_space.id.clone(),
        project_id: attached.project.id.clone(),
        repo_path: inspected.root.clone(),
        branch_name: inspected.branch_name.clone(),
        baseline_branch: attached
            .project
            .baseline_branch
            .clone()
            .filter(|value| !value.is_empty()),
        team_id: attached
            .project
            .owner_team_id
            .clone()
            .filter(|value| !value.is_empty())
            .or_else(|| Some(options.team_id.to_string())),
        remote_identity_key: inspected.remote_identity_key.clone(),
        local_repo_key: inspected.local_repo_key.clone(),
        display_name: attached
            .project
            .name
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| inspected.repository_name.clone()),
        created_at: now_iso8601(),
        allow_file_remote: options.allow_file_remote,
        is_worktree: options.is_worktree || attached.task_space.is_worktree,
        read_only: attached.binding.read_only == Some(true),
        sync_status: attached
            .binding
            .status
            .clone()
            .unwrap_or_else(|| "approved".to_string()),
        detach_pending: false,
        initial_sync_mode: mode.to_string(),
        initial_sync_completed: false,
        initial_review_pending: mode == "review",
        tracked_task_dirs: Vec::new(),
        live_sync_status: "syncing".to_string(),
        live_sync_error: None,
        last_synced_at: None,
        last_head: inspected.head.clone(),
        last_error: None,
        last_error_code: None,
    };

    let next_binding = binding.clone();
    store
        .update_config(false, move |config| {
            let Some(config) = config else {
                return err(code::CONFIG_MISSING, "Agent 配置不存在");
            };
            let mut next: AgentConfig = config.clone();
            // 同一本地仓库只保留一个绑定（对照 JS attachProject 的 localRepoKey 去重）。
            next.bindings.retain(|item| {
                item.task_space_id != next_binding.task_space_id
                    && item.local_repo_key != next_binding.local_repo_key
            });
            next.bindings.push(next_binding.clone());
            Ok(Some(next))
        })
        .await?;

    Ok(AttachResult {
        status: "attached".to_string(),
        project: attached.project,
        task_space: attached.task_space,
        binding,
        inspected,
    })
}

/// 为存量已绑定的 worktree 幂等补标 `isWorktree: true`，不重置 `initial_sync_completed` 与 `tracked_task_dirs`。
pub async fn mark_binding_worktree(
    api: &ApiClient,
    store: &ConfigStore,
    binding: &AgentBinding,
    hooks_dir: &Path,
    team_id: &str,
    developer_id: &str,
    allow_file_remote: bool,
) -> AgentResult<()> {
    let inspected = inspect_project_with(
        Path::new(&binding.repo_path),
        hooks_dir,
        allow_file_remote,
        Some(&binding.branch_name),
    )
    .await?;
    let body = json!({
        "remoteUrl": inspected.remote_url,
        "branchName": inspected.branch_name,
        "teamId": team_id,
        "developerId": developer_id,
        "displayName": binding.display_name,
        "localRepoKey": binding.local_repo_key,
        "isWorktree": true,
    });
    api.request_json(
        Method::POST,
        "/api/agent/task-spaces/attach",
        Some(&body),
        ATTACH_TIMEOUT,
    )
    .await?;
    let task_space_id = binding.task_space_id.clone();
    store
        .update_config(false, move |config| {
            let Some(current) = config else {
                return err(code::CONFIG_MISSING, "Agent 配置不存在");
            };
            let mut next = current.clone();
            if let Some(target) = next
                .bindings
                .iter_mut()
                .find(|item| item.task_space_id == task_space_id)
            {
                target.is_worktree = true;
            }
            Ok(Some(next))
        })
        .await?;
    Ok(())
}

/// 对照 JS normalizeRemoteIdentity。
pub fn normalize_remote_identity(
    raw_value: &str,
    allow_file_remote: bool,
) -> AgentResult<RemoteIdentity> {
    let raw = raw_value.trim();
    if raw.is_empty() || raw.chars().count() > MAX_REMOTE_LENGTH || raw.starts_with('-') {
        return err(code::REMOTE_INVALID, "Git 远端地址无效");
    }
    if is_windows_drive_path(raw) {
        if !allow_file_remote {
            return err(
                code::REMOTE_INVALID,
                "Git origin 不能直接使用本地文件系统路径",
            );
        }
        return build_remote_identity("file", 0, raw, 0);
    }
    if let Some(identity) = parse_scp_remote(raw, allow_file_remote)? {
        return Ok(identity);
    }

    let url = Url::parse(raw)
        .map_err(|_| AgentError::new(code::REMOTE_INVALID, "Git 远端地址格式无效"))?;
    if url.query().is_some() || url.fragment().is_some() {
        return err(code::REMOTE_INVALID, "Git 远端不能包含查询或片段");
    }
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "https" => {
            let has_password = url.password().is_some_and(|value| !value.is_empty());
            if !url.username().is_empty() || has_password {
                return err(code::REMOTE_INVALID, "HTTPS Git 远端不能包含账号或令牌");
            }
            build_remote_identity(host, url.port().unwrap_or(443), url.path(), 443)
        }
        "ssh" => {
            if url.password().is_some_and(|value| !value.is_empty()) {
                return err(code::REMOTE_INVALID, "SSH Git 远端不能包含密码");
            }
            build_remote_identity(host, url.port().unwrap_or(22), url.path(), 22)
        }
        "file" if allow_file_remote => {
            let path = url
                .to_file_path()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| url.path().to_string());
            build_remote_identity("file", 0, &path, 0)
        }
        _ => err(
            code::REMOTE_INVALID,
            "Git 远端只允许 HTTPS、SSH 或受控测试的 file URL",
        ),
    }
}

fn ensure_trellis_ready(inspected: &ProjectInspection) -> AgentResult<()> {
    if !inspected.has_trellis || !inspected.has_tasks {
        return err(
            code::MISSING_TRELLIS,
            "项目还没有初始化 Trellis，请先选择编码 Agent 并完成初始化",
        );
    }
    Ok(())
}

async fn check_required_push(
    inspected: &ProjectInspection,
    hooks_dir: &Path,
    allow_file_remote: bool,
    require_pushed: bool,
) -> AgentResult<Option<InitialPushState>> {
    if !require_pushed {
        return Ok(None);
    }
    let push = check_initial_push_with(
        Path::new(&inspected.root),
        hooks_dir,
        &inspected.branch_name,
        allow_file_remote,
    )
    .await?;
    if !push.is_ready() {
        return Err(AgentError::new(code::LOCAL_AHEAD, push.message.clone()));
    }
    Ok(Some(push))
}

fn normalize_initial_sync_mode(value: Option<&str>) -> AgentResult<&str> {
    let mode = value.unwrap_or(DEFAULT_INITIAL_SYNC_MODE);
    if INITIAL_SYNC_MODES.contains(&mode) {
        return Ok(mode);
    }
    err(code::COMMAND_INVALID, "首次同步处理方式无效")
}

/// 对照 JS normalizeTrellisAgentTools：非空、去空白、去重、必须是已知工具。
/// 已知工具白名单复用 trellis_cli 的映射表（未知 ID 不产生 init 参数）。
fn normalize_agent_tools(agent_tools: &[String]) -> AgentResult<Vec<String>> {
    if agent_tools.is_empty() {
        return err(code::COMMAND_INVALID, "Agent 工具必须至少选择一项");
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut selected = Vec::with_capacity(agent_tools.len());
    for tool in agent_tools {
        let id = tool.trim();
        if !seen.insert(id) {
            return err(
                code::COMMAND_INVALID,
                format!("Agent 工具不能重复选择: {id}"),
            );
        }
        if trellis_cli::trellis_agent_tool_flags(&[id.to_string()]).is_empty() {
            let label = if id.is_empty() { "空值" } else { id };
            return err(
                code::COMMAND_INVALID,
                format!("不支持的 Agent 工具: {label}"),
            );
        }
        if !trellis_cli::is_supported_agent_tool(id) {
            return err(
                code::COMMAND_INVALID,
                format!("暂不支持的 Agent 工具: {id}"),
            );
        }
        selected.push(id.to_string());
    }
    Ok(selected)
}

async fn inspect_git_project(
    repo_path: &Path,
    hooks_dir: &Path,
    allow_file_remote: bool,
    expected_branch: Option<&str>,
) -> AgentResult<RepositorySnapshot> {
    let (root, local_repo_key) = validate_repository_root(repo_path, hooks_dir).await?;
    let entries = git::status(&root, hooks_dir).await?;
    let current_branch = git::current_branch(&root, hooks_dir).await?;
    if git::config_sparse(&root, hooks_dir).await? {
        return err(
            code::SPARSE_CHECKOUT,
            "本地仓库启用了 sparse checkout，Agent 拒绝同步",
        );
    }
    // inspectProject 一律 allowUnborn=true。
    let head = git::head_commit(&root, hooks_dir, true).await?;
    let remote_url = git::remote_url(&root, hooks_dir).await?;
    let remote = normalize_remote_identity(&remote_url, allow_file_remote)?;

    if let Some(branch) = expected_branch {
        git::check_ref(&root, hooks_dir, branch).await?;
        if current_branch != branch {
            return err(
                code::BRANCH_MISMATCH,
                format!("本地当前分支为 {current_branch}，期望 {branch}"),
            );
        }
    }

    Ok(RepositorySnapshot {
        root,
        local_repo_key,
        current_branch,
        head,
        clean: entries.is_empty(),
        dirty_summary: dirty_summary(&entries),
        remote_url,
        remote_identity_key: remote.identity_hash,
    })
}

async fn validate_repository_root(
    repo_path: &Path,
    hooks_dir: &Path,
) -> AgentResult<(PathBuf, String)> {
    let selected_text = repo_path.to_string_lossy();
    if selected_text.trim().is_empty() || selected_text.chars().count() > MAX_REPO_PATH_LENGTH {
        return err(code::REPO_PATH_INVALID, "本地仓库路径无效");
    }
    let selected_real = tokio::fs::canonicalize(repo_path)
        .await
        .map_err(|_| AgentError::new(code::REPO_NOT_FOUND, "本地仓库目录不存在"))?;
    let top_level = git::show_toplevel(&selected_real, hooks_dir).await?;
    let top_level = tokio::fs::canonicalize(&top_level)
        .await
        .map_err(|_| AgentError::new(code::NOT_GIT_REPOSITORY, "无法解析 Git 仓库根"))?;
    if !paths_equal(&selected_real, &top_level) {
        return err(
            code::REPO_PATH_INVALID,
            "请选择 Git 仓库根目录，而不是子目录",
        );
    }
    let local_repo_key = local_repo_key(&top_level);
    Ok((top_level, local_repo_key))
}

/// 对照 JS normalizeLocalRepoKey：路径规范化（正斜杠、Windows 盘符小写、去尾斜杠）后取 sha256。
fn local_repo_key(real_repo_path: &Path) -> String {
    sha256_hex(normalize_repo_key_text(real_repo_path).as_bytes())
}

fn normalize_repo_key_text(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('\\', "/");
    // std::fs::canonicalize 在 Windows 上返回 `\\?\C:\...`，JS 的 path.resolve 没有该前缀。
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let lower = text[..1].to_ascii_lowercase();
        text.replace_range(..1, &lower);
    }
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    text
}

fn dirty_summary(entries: &[GitStatusEntry]) -> String {
    let text = entries
        .iter()
        .map(GitStatusEntry::line)
        .collect::<Vec<String>>()
        .join("\n");
    safe_error_message(&text)
        .chars()
        .take(MAX_DIRTY_SUMMARY_CHARS)
        .collect()
}

fn remote_branch_sha(output: &str, branch: &str) -> Option<String> {
    let suffix = format!("refs/heads/{branch}");
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let sha = parts.next()?;
        let reference = parts.next()?;
        if reference == suffix && is_git_oid(sha) {
            Some(sha.to_string())
        } else {
            None
        }
    })
}

fn is_git_oid(value: &str) -> bool {
    (40..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn split_user(value: &str) -> (&str, &str) {
    match value.find('@') {
        Some(index) if index > 0 && !value[..index].chars().any(char::is_whitespace) => {
            (&value[..index], &value[index + 1..])
        }
        _ => ("", value),
    }
}

fn parse_scp_remote(raw: &str, allow_file_remote: bool) -> AgentResult<Option<RemoteIdentity>> {
    if raw.contains("://") {
        return Ok(None);
    }
    if allow_file_remote && !raw.contains('@') {
        return Ok(None);
    }
    let (_, rest) = split_user(raw);
    if let Some(inner) = rest.strip_prefix('[') {
        let Some(end) = inner.find("]:") else {
            return Ok(None);
        };
        let host = &inner[..end];
        let repo_path = &inner[end + 2..];
        if repo_path.is_empty() || repo_path.starts_with('-') {
            return err(code::REMOTE_INVALID, "Git SSH 远端路径无效");
        }
        return build_remote_identity(host, 22, repo_path, 22).map(Some);
    }
    let Some(colon) = rest.find(':') else {
        return Ok(None);
    };
    let host = &rest[..colon];
    let repo_path = &rest[colon + 1..];
    if host.is_empty()
        || host.contains('/')
        || host.chars().any(char::is_whitespace)
        || repo_path.is_empty()
    {
        return Ok(None);
    }
    if repo_path.starts_with('-') {
        return err(code::REMOTE_INVALID, "Git SSH 远端路径无效");
    }
    build_remote_identity(host, 22, repo_path, 22).map(Some)
}

fn build_remote_identity(
    host: &str,
    port: u16,
    repo_path: &str,
    default_port: u16,
) -> AgentResult<RemoteIdentity> {
    let host = normalize_host(host);
    let path = normalize_repo_path(repo_path);
    if host.is_empty() || path.is_empty() {
        return err(code::REMOTE_INVALID, "Git 远端格式无效");
    }
    let port = if port == default_port { 0 } else { port };
    let identity_hash = remote_identity_hash(&host, port, &path);
    Ok(RemoteIdentity {
        host,
        port,
        path,
        identity_hash,
    })
}

fn normalize_host(value: &str) -> String {
    let mut host = value.trim().to_lowercase();
    if host.starts_with('[') {
        host.remove(0);
    }
    if host.ends_with(']') {
        host.pop();
    }
    host
}

fn normalize_repo_path(value: &str) -> String {
    let replaced = value.replace('\\', "/");
    let mut collapsed = String::with_capacity(replaced.len());
    let mut previous_slash = false;
    for character in replaced.chars() {
        if character == '/' {
            if previous_slash {
                continue;
            }
            previous_slash = true;
        } else {
            previous_slash = false;
        }
        collapsed.push(character);
    }
    let trimmed = collapsed.trim_matches('/');
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".git") {
        return trimmed[..trimmed.len() - 4].to_string();
    }
    trimmed.to_string()
}

/// JS 用 JSON.stringify({ host, port, path }) 作为哈希输入，键顺序固定为 host→port→path。
fn remote_identity_hash(host: &str, port: u16, path: &str) -> String {
    let canonical = format!(
        "{{\"host\":{},\"port\":{},\"path\":{}}}",
        Value::String(host.to_string()),
        port,
        Value::String(path.to_string())
    );
    sha256_hex(canonical.as_bytes())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn path_exists(target: &Path) -> bool {
    tokio::fs::try_exists(target).await.unwrap_or(false)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    let left = left.to_string_lossy();
    let right = right.to_string_lossy();
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

#[cfg(test)]
mod tests;
