//! 项目接入（onboarding）：`inspect` / `initialize` / `checkInitialPush` / `preflight` / `attach`。
//! 来源 JS：desktop/sidecar/agent/project-onboarding.js（全文），
//! 以及 agent/git-sync.js 中的 inspectGitProject / normalizeRemoteIdentity / normalizeLocalRepoKey /
//! readRepositoryState / compareRemoteBranch。
//! 只复用 git / trellis_cli / process / protocol 的既有能力，不新增 Git 调用方式。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::agent::git::{self, GitStatusEntry};
use crate::agent::http::ApiClient;
use crate::agent::protocol::{code, err, now_iso8601, safe_error_message, AgentError, AgentResult};
use crate::agent::store::{AgentBinding, AgentConfig, ConfigStore};
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedTaskSpace {
    pub id: String,
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
    })
}

/// 对照 JS initializeProject：缺 trellis/tasks 或所选工具缺失时才调用 trellis init。
pub async fn initialize_project(options: &InitializeOptions<'_>) -> AgentResult<ProjectInspection> {
    let inspected = inspect_project(
        options.repo_path,
        options.hooks_dir,
        options.allow_file_remote,
    )
    .await?;
    let selected_tools = normalize_agent_tools(options.agent_tools)?;
    let tools_missing = selected_tools
        .iter()
        .any(|id| !inspected.existing_agent_tools.contains(id));
    if !inspected.has_trellis || !inspected.has_tasks || tools_missing {
        trellis_cli::initialize_trellis(
            options.runtime,
            Path::new(&inspected.root),
            options.developer_id,
            &selected_tools,
        )
        .await?;
    }
    inspect_project(
        Path::new(&inspected.root),
        options.hooks_dir,
        options.allow_file_remote,
    )
    .await
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
        (Some(_), Ok(paths)) => paths.iter().any(|path| path.contains(".trellis/")),
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
        read_only: attached.binding.read_only == Some(true),
        sync_status: attached
            .binding
            .status
            .clone()
            .unwrap_or_else(|| "approved".to_string()),
        initial_sync_mode: mode.to_string(),
        initial_sync_completed: false,
        initial_review_pending: mode == "review",
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
            next.bindings
                .retain(|item| item.task_space_id != next_binding.task_space_id);
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
mod tests {
    use super::*;
    use std::process::Command;

    struct TempRepo {
        root: PathBuf,
        hooks: PathBuf,
    }

    impl TempRepo {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir()
                .join(format!("trellis-onboarding-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&base).expect("create temp dir");
            Self {
                root: base.join("repo"),
                hooks: base.join("hooks"),
            }
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            if let Some(base) = self.root.parent() {
                let _ = std::fs::remove_dir_all(base);
            }
        }
    }

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn init_repo(tag: &str, origin: Option<&str>) -> TempRepo {
        let repo = TempRepo::new(tag);
        std::fs::create_dir_all(&repo.root).expect("create repo dir");
        git(&repo.root, &["init", "-b", "main"]);
        if let Some(origin) = origin {
            git(&repo.root, &["remote", "add", "origin", origin]);
        }
        repo
    }

    fn commit_all(repo: &Path) {
        git(repo, &["add", "."]);
        git(
            repo,
            &[
                "-c",
                "user.name=Trellis Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "init",
            ],
        );
    }

    #[tokio::test]
    async fn rejects_non_git_directory() {
        let repo = TempRepo::new("non-git");
        std::fs::create_dir_all(&repo.root).expect("create dir");
        let error = inspect_project(&repo.root, &repo.hooks, false)
            .await
            .expect_err("non git dir");
        assert_eq!(error.code, code::NOT_GIT_REPOSITORY);
    }

    #[tokio::test]
    async fn reports_missing_trellis_as_requires_initialization() {
        if !git_available() {
            return;
        }
        let repo = init_repo("missing-trellis", Some("https://example.com/team/repo.git"));
        let inspected = inspect_project(&repo.root, &repo.hooks, false)
            .await
            .expect("inspect repo");
        assert!(!inspected.has_trellis);
        assert!(!inspected.has_tasks);
        assert!(!inspected.has_committed_trellis);
        assert!(inspected.requires_initialization);
        assert_eq!(inspected.branch_name, "main");
        assert_eq!(inspected.head, None);
        assert!(inspected.clean);
        assert_eq!(inspected.repository_name, "repo");
        assert_eq!(inspected.remote_url, "https://example.com/team/repo.git");
        assert_eq!(inspected.local_repo_key.len(), 64);
        assert_eq!(inspected.remote_identity_key.len(), 64);
    }

    #[tokio::test]
    async fn reports_existing_agent_tools_from_worktree() {
        if !git_available() {
            return;
        }
        let repo = init_repo("agent-tools", Some("https://example.com/team/repo.git"));
        std::fs::create_dir_all(repo.root.join(".cursor")).expect("create cursor dir");
        std::fs::write(repo.root.join(".cursor/mcp.json"), "{}").expect("write cursor config");
        let inspected = inspect_project(&repo.root, &repo.hooks, false)
            .await
            .expect("inspect repo");
        assert_eq!(inspected.existing_agent_tools, vec!["cursor".to_string()]);
        // 工作区出现未跟踪目录 → 不再 clean：校验 status 结果被如实透传。
        assert!(!inspected.clean);
        assert!(inspected.dirty_summary.contains(".cursor"));
    }

    #[tokio::test]
    async fn maps_git_failures_to_agent_codes() {
        if !git_available() {
            return;
        }
        let missing_origin = init_repo("no-origin", None);
        let error = inspect_project(&missing_origin.root, &missing_origin.hooks, false)
            .await
            .expect_err("missing origin");
        assert_eq!(error.code, code::REMOTE_MISSING);

        let local_origin = init_repo("local-origin", Some("C:/tmp/repo"));
        let error = inspect_project(&local_origin.root, &local_origin.hooks, false)
            .await
            .expect_err("local path origin");
        assert_eq!(error.code, code::REMOTE_INVALID);

        let subdir = init_repo("subdir", Some("https://example.com/team/repo.git"));
        let nested = subdir.root.join("nested");
        std::fs::create_dir_all(&nested).expect("create nested dir");
        let error = inspect_project(&nested, &subdir.hooks, false)
            .await
            .expect_err("sub directory");
        assert_eq!(error.code, code::REPO_PATH_INVALID);
    }

    #[test]
    fn normalizes_https_remote_identity_with_stable_hash() {
        let identity = normalize_remote_identity("https://GitHub.com/Team/Repo.git", false)
            .expect("https identity");
        assert_eq!(identity.host, "github.com");
        assert_eq!(identity.port, 0);
        assert_eq!(identity.path, "Team/Repo");
        let expected = sha256_hex(br#"{"host":"github.com","port":0,"path":"Team/Repo"}"#);
        assert_eq!(identity.identity_hash, expected);

        let custom_port =
            normalize_remote_identity("ssh://git@example.com:2222/team/repo.git", false)
                .expect("ssh identity");
        assert_eq!(custom_port.port, 2222);
        assert_eq!(custom_port.host, "example.com");
        assert_eq!(custom_port.path, "team/repo");
    }

    #[test]
    fn rejects_invalid_remote_shapes() {
        assert_eq!(
            normalize_remote_identity("https://user:token@example.com/repo.git", false)
                .expect_err("credentials")
                .code,
            code::REMOTE_INVALID
        );
        assert_eq!(
            normalize_remote_identity("", false)
                .expect_err("empty")
                .code,
            code::REMOTE_INVALID
        );
        assert_eq!(
            normalize_remote_identity("ftp://example.com/repo.git", false)
                .expect_err("protocol")
                .code,
            code::REMOTE_INVALID
        );
        assert_eq!(
            normalize_remote_identity("file:///C:/repos/demo.git", false)
                .expect_err("file remote without opt in")
                .code,
            code::REMOTE_INVALID
        );
        let file =
            normalize_remote_identity("file:///C:/repos/demo.git", true).expect("file remote");
        assert_eq!(file.host, "file");
        assert_eq!(file.path, "C:/repos/demo");
    }

    #[test]
    fn parses_scp_style_remote() {
        let identity = normalize_remote_identity("git@example.com:team/repo.git", false)
            .expect("scp identity");
        assert_eq!(identity.host, "example.com");
        assert_eq!(identity.port, 0);
        assert_eq!(identity.path, "team/repo");

        let ipv6 =
            normalize_remote_identity("git@[::1]:team/repo.git", false).expect("ipv6 identity");
        assert_eq!(ipv6.host, "::1");
        assert_eq!(ipv6.path, "team/repo");
    }

    #[tokio::test]
    async fn reports_initial_push_state_for_missing_remote_branch() {
        if !git_available() {
            return;
        }
        let bare = TempRepo::new("bare-remote");
        std::fs::create_dir_all(&bare.root).expect("create bare dir");
        git(&bare.root, &["init", "--bare"]);
        let origin = bare.root.to_string_lossy().replace('\\', "/");
        let repo = init_repo("initial-push", Some(origin.as_str()));
        std::fs::create_dir_all(repo.root.join(".trellis").join("tasks")).expect("create tasks");
        std::fs::write(
            repo.root.join(".trellis").join("tasks").join("t1.md"),
            "task",
        )
        .expect("write task");
        commit_all(&repo.root);

        let pushed = check_initial_push_with(&repo.root, &repo.hooks, "main", true)
            .await
            .expect("check push");
        assert!(pushed.is_branch_missing());
        assert!(pushed.message.contains("main"));
        assert!(pushed.local_head.is_some());

        git(&repo.root, &["push", "origin", "main"]);
        let ready = check_initial_push_with(&repo.root, &repo.hooks, "main", true)
            .await
            .expect("check push after push");
        assert!(ready.is_ready());
        assert_eq!(ready.local_head, ready.remote_head);

        let preflight = preflight_project_with(&repo.root, &repo.hooks, "team-1", true, true)
            .await
            .expect("preflight after push");
        assert!(preflight.push.is_some_and(|push| push.is_ready()));
        assert!(!preflight.inspected.requires_initialization);
    }

    #[tokio::test]
    async fn requires_pushed_commit_rejects_waiting_state() {
        if !git_available() {
            return;
        }
        let repo = init_repo("waiting-commit", Some("https://example.com/team/repo.git"));
        std::fs::create_dir_all(repo.root.join(".trellis").join("tasks")).expect("create tasks");
        let error = preflight_project_with(&repo.root, &repo.hooks, "team-1", false, true)
            .await
            .expect_err("uncommitted trellis");
        assert_eq!(error.code, code::LOCAL_AHEAD);
        assert!(error.message.contains(".trellis"));
    }

    #[test]
    fn normalizes_agent_tool_selection() {
        assert_eq!(
            normalize_agent_tools(&[" cursor ".to_string(), "pi".to_string()])
                .expect("known tools"),
            vec!["cursor".to_string(), "pi".to_string()]
        );
        assert_eq!(
            normalize_agent_tools(&[]).expect_err("empty").code,
            code::COMMAND_INVALID
        );
        assert_eq!(
            normalize_agent_tools(&["cursor".to_string(), "cursor".to_string()])
                .expect_err("duplicate")
                .code,
            code::COMMAND_INVALID
        );
        assert_eq!(
            normalize_agent_tools(&["nope".to_string()])
                .expect_err("unknown")
                .code,
            code::COMMAND_INVALID
        );
    }

    #[test]
    fn validates_initial_sync_mode() {
        assert_eq!(
            normalize_initial_sync_mode(None).expect("default"),
            "review"
        );
        assert_eq!(
            normalize_initial_sync_mode(Some("bootstrap")).expect("bootstrap"),
            "bootstrap"
        );
        assert_eq!(
            normalize_initial_sync_mode(Some("unsafe"))
                .expect_err("invalid mode")
                .code,
            code::COMMAND_INVALID
        );
    }
}
