//! 对应 agent/task-command.js（create_task / assign_task）与桌面命令入口：
//! `agent/index.js` 的 `_runCommand` / `_syncBinding` / `_updateBindingResult`、
//! `agent/git-sync.js` 的 `inspectRepository` / `syncRepository`（sync_branch / refresh_status）。
//! 仓库检查与远端身份规范化复用 `crate::agent::onboarding`。

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::agent::git;
use crate::agent::onboarding::{self, ProjectInspection};
use crate::agent::process::{build_environment, run_process, ProcessOptions};
use crate::agent::protocol::{
    self, code, safe_error_message, AgentCommand, AgentError, AgentResult,
};
use crate::agent::store::{AgentBinding, ConfigStore};
use crate::agent::task_sync::{self, snapshot_sha256, SnapshotFile, TaskSync};

const PYTHON_TIMEOUT: Duration = Duration::from_secs(150);
const PYTHON_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const STATUS_DETAIL_LIMIT: usize = 500;
const TASK_SLUG_MAX_LENGTH: usize = 100;

/// 任务命令执行上下文，字段与 `runtime.rs` 的构造方式一一对应。
///
/// `store` / `task_sync` 以 `Arc` 的借用传入，命令层不复制配置与游标状态；
/// 每个绑定独立的 hooks 目录按 JS `path.join(hooksBaseDir, binding.localId)`
/// 在需要时从 `store.paths.hooks_base_dir` 派生，因此这里不单独持有。
pub struct CommandContext<'a> {
    pub store: &'a Arc<ConfigStore>,
    pub task_sync: &'a Arc<TaskSync>,
}

pub async fn run_command(
    context: &CommandContext<'_>,
    command: &AgentCommand,
) -> AgentResult<Value> {
    let config = context
        .store
        .read_config(false)
        .await?
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录"))?;
    match command.kind.as_str() {
        protocol::COMMAND_CREATE_TASK | protocol::COMMAND_ASSIGN_TASK => {
            let binding = command_binding(&config.bindings, command)?;
            let inspection =
                inspect_repository(context, binding, "本地仓库 origin 与任务空间不一致").await?;
            let hooks_dir = context.store.paths.hooks_base_dir.join(&binding.local_id);
            let repo_root = PathBuf::from(&inspection.root);
            interrupted_git_state(&repo_root)?;
            if command.kind == protocol::COMMAND_CREATE_TASK {
                create_task(context, command, binding, &hooks_dir, &repo_root).await
            } else {
                assign_task(context, command, binding, &hooks_dir, &repo_root).await
            }
        }
        protocol::COMMAND_SYNC_BRANCH => {
            let binding = server_command_binding(&config.bindings, command)?;
            sync_branch(context, binding).await
        }
        protocol::COMMAND_REFRESH_STATUS => {
            let binding = server_command_binding(&config.bindings, command)?;
            refresh_status(context, binding).await
        }
        _ => protocol::err(code::COMMAND_INVALID, "不支持的服务端命令"),
    }
    .and_then(|result| {
        // 对照 `_processCommand`：成功也要包成 buildCommandResult('succeeded', result)。
        protocol::build_command_result(protocol::COMMAND_RESULT_SUCCEEDED, Some(result), None)
    })
}

/// 对照 `agent/index.js` 的 `_runCommand`：绑定匹配、项目/分支一致性、批准状态。
fn server_command_binding<'a>(
    bindings: &'a [AgentBinding],
    command: &AgentCommand,
) -> AgentResult<&'a AgentBinding> {
    let binding = bindings
        .iter()
        .find(|item| item.server_binding_id.as_deref() == Some(command.binding_id.as_str()))
        .or_else(|| {
            command
                .payload_str("taskSpaceId")
                .and_then(|space| bindings.iter().find(|item| item.task_space_id == space))
        })
        .ok_or_else(|| {
            AgentError::new(code::BINDING_UNKNOWN, "服务端命令引用了未知的本地项目绑定")
        })?;
    let space_matches = command
        .payload_str("taskSpaceId")
        .map(|value| value == binding.task_space_id)
        .unwrap_or(true);
    let server_matches = binding.server_binding_id.as_deref() == Some(command.binding_id.as_str());
    let branch_matches = command
        .payload_str("branchName")
        .map(|value| value == binding.branch_name)
        .unwrap_or(true);
    if !(space_matches && server_matches && branch_matches) {
        return protocol::err(
            code::COMMAND_INVALID,
            "服务端命令的项目或分支与本地绑定不一致",
        );
    }
    if binding.sync_status != "approved" {
        return protocol::err(
            code::BINDING_NOT_APPROVED,
            "本地任务空间绑定尚未获项目负责人批准",
        );
    }
    if binding.detach_pending {
        return protocol::err(
            code::BINDING_UNKNOWN,
            "本地任务空间关联正在解除，不再执行任务命令",
        );
    }
    Ok(binding)
}

/// 对照 `inspectRepository`：仓库/分支校验由 onboarding 完成，这里补远端身份比对。
async fn inspect_repository(
    context: &CommandContext<'_>,
    binding: &AgentBinding,
    remote_message: &str,
) -> AgentResult<ProjectInspection> {
    let hooks_dir = context.store.paths.hooks_base_dir.join(&binding.local_id);
    let inspection = onboarding::inspect_project_with(
        Path::new(&binding.repo_path),
        &hooks_dir,
        binding.allow_file_remote,
        Some(&binding.branch_name),
    )
    .await?;
    if inspection.remote_identity_key != binding.remote_identity_key {
        return protocol::err(code::REMOTE_MISMATCH, remote_message);
    }
    Ok(inspection)
}

fn command_binding<'a>(
    bindings: &'a [AgentBinding],
    command: &AgentCommand,
) -> AgentResult<&'a AgentBinding> {
    let task_space_id = command.payload_str("taskSpaceId");
    let binding = bindings
        .iter()
        .find(|item| {
            Some(item.task_space_id.as_str()) == task_space_id
                && item.server_binding_id.as_deref() == Some(command.binding_id.as_str())
        })
        .ok_or_else(|| {
            AgentError::new(code::BINDING_UNKNOWN, "命令引用了未知的本地任务空间绑定")
        })?;
    if binding.sync_status != "approved" {
        return protocol::err(code::BINDING_NOT_APPROVED, "本地任务空间绑定尚未批准");
    }
    if binding.detach_pending {
        return protocol::err(
            code::BINDING_UNKNOWN,
            "本地任务空间关联正在解除，不再执行任务命令",
        );
    }
    if binding.read_only {
        return protocol::err(code::BINDING_NOT_APPROVED, "只读任务空间不能执行任务命令");
    }
    Ok(binding)
}

/// 对照 `agent/task-command.js` 的 `interruptedGitState`。
fn interrupted_git_state(repo_path: &Path) -> AgentResult<()> {
    let Some(marker) = git::detect_git_state(repo_path) else {
        return Ok(());
    };
    let label = match marker {
        "MERGE_HEAD" => "合并",
        "rebase-merge" | "rebase-apply" => "变基",
        "CHERRY_PICK_HEAD" => "拣选提交",
        "REVERT_HEAD" => "回滚提交",
        _ => "Git",
    };
    protocol::err(
        code::GIT_FAILED,
        format!("仓库存在未完成的{label}操作，请先处理后再执行任务命令"),
    )
}

/// 对照 `agent/index.js` 的 `_syncBinding` + `git-sync.js` 的 `syncRepository`：
/// 工作区干净 → fetch → 本地领先拒绝 → 快进合并 → 复核状态。
async fn sync_branch(context: &CommandContext<'_>, binding: &AgentBinding) -> AgentResult<Value> {
    let hooks_dir = context.store.paths.hooks_base_dir.join(&binding.local_id);
    let before = inspect_repository(context, binding, "本地 origin 与绑定项目远端不一致").await?;
    if !before.clean {
        let detail = if before.dirty_summary.is_empty() {
            "未知变更"
        } else {
            before.dirty_summary.as_str()
        };
        return protocol::err(
            code::LOCAL_DIRTY,
            format!("本地工作区存在未提交或未跟踪文件：{detail}"),
        );
    }
    let repo_root = PathBuf::from(&before.root);
    git::fetch(&repo_root, &hooks_dir, &binding.branch_name).await?;
    let (local_ahead, remote_ahead) = git::rev_list(&repo_root, &hooks_dir).await?;
    if local_ahead > 0 {
        return protocol::err(
            code::LOCAL_AHEAD,
            "本地存在未推送提交或已与远端分叉，Agent 拒绝同步",
        );
    }
    if remote_ahead > 0 {
        git::merge_ff_only(&repo_root, &hooks_dir).await?;
    }
    let after = inspect_repository(context, binding, "本地 origin 与绑定项目远端不一致").await?;
    if !after.clean {
        return protocol::err(
            code::LOCAL_DIRTY,
            "同步后本地工作区出现未提交变化，请检查 Git 配置",
        );
    }
    let report = status_report(binding, &after, &protocol::now_iso8601());
    update_binding_result(context, &binding.local_id, &report).await?;
    Ok(report)
}

/// 对照 `agent/index.js` 的 `refresh_status`：只检查仓库并回报状态。
async fn refresh_status(
    context: &CommandContext<'_>,
    binding: &AgentBinding,
) -> AgentResult<Value> {
    let inspection =
        inspect_repository(context, binding, "本地 origin 与绑定项目远端不一致").await?;
    let report = status_report(binding, &inspection, &protocol::now_iso8601());
    update_binding_result(context, &binding.local_id, &report).await?;
    Ok(report)
}

/// `_syncBinding` / `refresh_status` 共同的服务端回报结构。
fn status_report(binding: &AgentBinding, inspection: &ProjectInspection, synced_at: &str) -> Value {
    json!({
        "bindingId": binding.server_binding_id,
        "taskSpaceId": binding.task_space_id,
        "projectId": binding.project_id,
        "branchName": binding.branch_name,
        "head": inspection.head,
        "clean": inspection.clean,
        "syncedAt": synced_at,
        "localRepoKey": inspection.local_repo_key,
        "remoteIdentityKey": inspection.remote_identity_key,
    })
}

/// 对照 `_updateBindingResult`：成功即 approved，并记录时间/HEAD 与健康状态。
async fn update_binding_result(
    context: &CommandContext<'_>,
    local_id: &str,
    report: &Value,
) -> AgentResult<()> {
    let health = if report.get("clean").and_then(Value::as_bool) == Some(false) {
        Some((
            code::LOCAL_DIRTY.to_string(),
            "本地工作区存在未提交或未跟踪文件".to_string(),
        ))
    } else {
        None
    };
    let synced_at = report
        .get("syncedAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let head = report
        .get("head")
        .and_then(Value::as_str)
        .map(str::to_string);
    let local_id = local_id.to_string();
    let changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let changed_in_update = changed.clone();
    context
        .store
        .update_config(true, move |config| {
            let Some(current) = config else {
                return Ok(None);
            };
            let mut next = current.clone();
            let mut binding_changed = false;
            for item in next.bindings.iter_mut() {
                if item.local_id != local_id {
                    continue;
                }
                if apply_binding_result(item, synced_at.as_deref(), head.as_deref(), &health) {
                    binding_changed = true;
                }
            }
            if binding_changed {
                changed_in_update.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(Some(next))
            } else {
                Ok(None)
            }
        })
        .await?;
    if changed.load(std::sync::atomic::Ordering::SeqCst) {
        context.task_sync.notify_bindings_changed();
    }
    Ok(())
}

fn apply_binding_result(
    binding: &mut AgentBinding,
    synced_at: Option<&str>,
    head: Option<&str>,
    health: &Option<(String, String)>,
) -> bool {
    let mut changed = false;
    if binding.sync_status != "approved" {
        binding.sync_status = "approved".to_string();
        changed = true;
    }
    if let Some(value) = synced_at {
        if binding.last_synced_at.as_deref() != Some(value) {
            binding.last_synced_at = Some(value.to_string());
            changed = true;
        }
    }
    if let Some(value) = head {
        if binding.last_head.as_deref() != Some(value) {
            binding.last_head = Some(value.to_string());
            changed = true;
        }
    }
    match health {
        Some((error_code, message)) => {
            if binding.last_error_code.as_deref() != Some(error_code)
                || binding.last_error.as_deref() != Some(message)
            {
                binding.last_error_code = Some(error_code.clone());
                binding.last_error = Some(message.clone());
                changed = true;
            }
        }
        None => {
            if binding.last_error_code.is_some() || binding.last_error.is_some() {
                binding.last_error_code = None;
                binding.last_error = None;
                changed = true;
            }
        }
    }
    changed
}

async fn create_task(
    context: &CommandContext<'_>,
    command: &AgentCommand,
    binding: &AgentBinding,
    _hooks_dir: &Path,
    repo_path: &Path,
) -> AgentResult<Value> {
    let title = command.requires("title")?.to_string();
    let assignee = command.requires("assigneeDevId")?.to_string();
    let slug = match command
        .payload_str("slug")
        .filter(|value| !value.is_empty())
    {
        Some(value) => normalize_task_slug(value),
        None => slugify_task_title(&title),
    };
    if !is_task_slug(&slug) {
        return protocol::err(
            code::COMMAND_INVALID,
            "任务标题没有可用英文标识，请使用包含英文或数字的标题",
        );
    }
    if slug == "archive" {
        return protocol::err(
            code::COMMAND_INVALID,
            "archive 是保留的归档目录，不能用作任务标识",
        );
    }
    if let Some(execution_task_key) = create_execution_task_key(command, binding) {
        context
            .task_sync
            .claim_execution_task(&binding.task_space_id, &execution_task_key)
            .await?;
    }
    let tasks_root = repo_path.join(".trellis").join("tasks");
    let before = task_directories(&tasks_root).await?;
    let existing = tasks_root.join(&slug);
    match read_task_json_opt(&existing.join("task.json")).await? {
        Some(task) => {
            if task.get("title").and_then(Value::as_str) == Some(title.as_str())
                && task.get("assignee").and_then(Value::as_str) == Some(assignee.as_str())
            {
                let task_dir = format!(".trellis/tasks/{slug}");
                set_task_directory_branch(repo_path, &task_dir, &binding.branch_name).await?;
                let updated = read_task_json_opt(&existing.join("task.json"))
                    .await?
                    .ok_or_else(|| AgentError::new(code::GIT_FAILED, "task.py 未保留任务文件"))?;
                if updated.get("branch").and_then(Value::as_str) != Some(binding.branch_name.as_str())
                {
                    return protocol::err(code::GIT_FAILED, "task.py 未能写入任务的分支归属");
                }
                let task_id = task_id_of(&updated, &task_dir)?;
                return finish_create(context, binding, command, &task_dir, &task_id).await;
            }
            return protocol::err(
                code::COMMAND_INVALID,
                format!("任务目录 {slug} 已存在且内容与本次命令不一致，请更换任务标识"),
            );
        }
        None if existing.is_dir() => {
            return protocol::err(
                code::COMMAND_INVALID,
                format!("任务目录 {slug} 已存在但 task.json 无法读取，请先检查本地任务"),
            )
        }
        None => {}
    }
    run_task_python(
        repo_path,
        &[
            "create".to_string(),
            title.clone(),
            format!(
                "--description={}",
                command.payload_str("description").unwrap_or("")
            ),
            format!("--assignee={assignee}"),
            format!(
                "--priority={}",
                command.payload_str("priority").unwrap_or("P2")
            ),
            format!("--slug={slug}"),
            "--no-start".to_string(),
            format!("--base-branch={}", binding.branch_name),
        ],
    )
    .await?;
    let after = task_directories(&tasks_root).await?;
    let created: Vec<&String> = after.difference(&before).collect();
    if created.len() != 1 {
        return protocol::err(
            code::GIT_FAILED,
            "task.py 没有生成唯一的新任务目录，客户端拒绝继续同步",
        );
    }
    let task_dir = format!(".trellis/tasks/{}", created[0]);
    set_task_directory_branch(repo_path, &task_dir, &binding.branch_name).await?;
    let task = read_task_json_opt(&tasks_root.join(created[0].as_str()).join("task.json"))
        .await?
        .ok_or_else(|| AgentError::new(code::GIT_FAILED, "task.py 未生成可读取的 task.json"))?;
    if task.get("branch").and_then(Value::as_str) != Some(binding.branch_name.as_str()) {
        return protocol::err(code::GIT_FAILED, "task.py 未能写入任务的分支归属");
    }
    let task_id = task_id_of(&task, &task_dir)?;
    finish_create(context, binding, command, &task_dir, &task_id).await
}

/// create_task 的新服务端会在 payload 中带 executionTaskKey；兼容只带
/// taskId/taskVersion 的控制面响应，避免命令刚进入客户端就绕过 claim。
fn create_execution_task_key(command: &AgentCommand, binding: &AgentBinding) -> Option<String> {
    if let Some(value) = command
        .payload_str("executionTaskKey")
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    if command
        .payload
        .get("taskVersion")
        .and_then(Value::as_u64)
        .is_none()
    {
        return None;
    }
    command
        .payload_str("taskId")
        .filter(|value| !value.is_empty())
        .map(|task_id| format!("{}::{task_id}", binding.task_space_id))
}

async fn finish_create(
    context: &CommandContext<'_>,
    binding: &AgentBinding,
    command: &AgentCommand,
    task_dir: &str,
    task_id: &str,
) -> AgentResult<Value> {
    // ponytail: JS 的 `_uploadDirectories` 同时支持 reconcile 与 baseShaByPath；create 无基线，
    // 直接走 reconcile=true 的入口。
    let synced = context
        .task_sync
        .sync_task_directories(&binding.task_space_id, &[task_dir.to_string()], true)
        .await?;
    let revision = require_synced_revision(&synced)?;
    Ok(json!({
        "taskId": task_id,
        "taskKey": format!("{}::{task_dir}", binding.task_space_id),
        "executionTaskKey": format!("{}::{task_id}", binding.task_space_id),
        "relativeDir": task_dir,
        "revision": revision,
        "commandId": command.id,
    }))
}

async fn assign_task(
    context: &CommandContext<'_>,
    command: &AgentCommand,
    binding: &AgentBinding,
    hooks_dir: &Path,
    repo_path: &Path,
) -> AgentResult<Value> {
    let assignee = command.requires("assigneeDevId")?.to_string();
    let task_dir = command.payload_str("relativeDir").unwrap_or("").to_string();
    if task_sync::is_archive_task_dir(&task_dir) {
        return protocol::err(
            code::COMMAND_INVALID,
            "归档任务由服务端 Git 管理，客户端不能改派归档任务",
        );
    }
    let execution_task_key = command
        .payload_str("executionTaskKey")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AgentError::new(code::COMMAND_INVALID, "改派命令缺少任务执行身份"))?;
    context
        .task_sync
        .claim_execution_task(&binding.task_space_id, execution_task_key)
        .await?;
    let tasks_root = repo_path.join(".trellis").join("tasks");
    let target = protocol::resolve_task_dir_under(&tasks_root, &task_dir)
        .ok_or_else(|| AgentError::new(code::COMMAND_INVALID, "改派任务目录越界"))?;
    let task_json_path = target.join("task.json");
    let content = read_utf8(&task_json_path).await?;
    let mut task: Value = serde_json::from_str(&content)
        .map_err(|_| AgentError::new(code::COMMAND_INVALID, "任务 task.json 已损坏"))?;
    if !task.is_object() {
        return protocol::err(code::COMMAND_INVALID, "任务 task.json 已损坏");
    }
    let dirty_paths: Vec<String> =
        git::status_paths(repo_path, hooks_dir, std::slice::from_ref(&task_dir))
            .await
            .map_err(|_| AgentError::new(code::GIT_FAILED, "无法检查目标任务目录状态"))?
            .into_iter()
            .map(|entry| entry.path.replace('\\', "/"))
            .collect();
    let dirty = !dirty_paths.is_empty();
    let task_json_relative = format!("{task_dir}/task.json");
    let directory = context
        .task_sync
        .fetch_directory(&binding.task_space_id, &task_dir)
        .await?;
    let files = task_sync::parse_directory_files(&directory, &task_dir)?;
    let task_json_file = files
        .iter()
        .find(|file| file.path.ends_with("/task.json"))
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "服务端缺少目标任务的 task.json"))?;
    if let Some(base_sha) = command
        .payload_str("baseTaskSha256")
        .filter(|value| !value.is_empty())
    {
        if task_json_file.sha256 != base_sha {
            return protocol::err(code::HTTP_ERROR, "任务文件已被其他成员修改，改派命令已取消");
        }
    }
    let local_matches_server = snapshot_sha256(&content) == task_json_file.sha256;
    let retry_after_upload_failure = !local_matches_server
        && !dirty_paths.is_empty()
        && dirty_paths.iter().all(|path| path == &task_json_relative)
        && retry_shape_matches(&task, task_json_file, &assignee);
    if dirty && !retry_after_upload_failure {
        return protocol::err(
            code::LOCAL_DIRTY,
            format!(
                "目标任务目录有未提交修改，请先处理：{}",
                dirty_paths
                    .join("\n")
                    .chars()
                    .take(STATUS_DETAIL_LIMIT)
                    .collect::<String>()
            ),
        );
    }
    if !local_matches_server && !retry_after_upload_failure {
        return protocol::err(
            code::HTTP_ERROR,
            "本地任务文件与服务端基线不一致，请先同步任务空间后再改派",
        );
    }
    if local_matches_server {
        task["assignee"] = Value::String(assignee.clone());
        atomic_write_json(&task_json_path, &task).await?;
    }
    let base_sha: BTreeMap<String, String> =
        [(task_json_file.path.clone(), task_json_file.sha256.clone())]
            .into_iter()
            .collect();
    let synced = context
        .task_sync
        .sync_task_directories_with_base(
            &binding.task_space_id,
            std::slice::from_ref(&task_dir),
            Some(&base_sha),
        )
        .await?;
    let revision = require_synced_revision(&synced)?;
    let task_id = task_id_of(&task, &task_dir)?;
    Ok(json!({
        "taskId": task_id,
        "taskKey": format!("{}::{task_dir}", binding.task_space_id),
        "executionTaskKey": format!("{}::{task_id}", binding.task_space_id),
        "relativeDir": task_dir,
        "assignee": assignee,
        "revision": revision,
        "commandId": command.id,
    }))
}

fn retry_shape_matches(task: &Value, server_file: &SnapshotFile, assignee: &str) -> bool {
    let Some(server) = serde_json::from_str::<Value>(&server_file.content).ok() else {
        return false;
    };
    let Some(mut expected) = server.as_object().cloned() else {
        return false;
    };
    expected.insert("assignee".to_string(), Value::String(assignee.to_string()));
    task.as_object() == Some(&expected)
}

fn require_synced_revision(result: &Value) -> AgentResult<u64> {
    if result.get("code").and_then(Value::as_str) == Some("TASK_FILE_CONFLICT") {
        let message = result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("任务文件已被其他成员修改，本次命令未保存");
        return protocol::err(code::HTTP_ERROR, message);
    }
    match result.get("revision").and_then(Value::as_u64) {
        Some(revision) if revision >= 1 => Ok(revision),
        _ => protocol::err(
            code::HTTP_ERROR,
            "任务文件尚未成功上传到服务端，请检查同步错误后重试",
        ),
    }
}

fn task_id_of(task: &Value, task_dir: &str) -> AgentResult<String> {
    task.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            AgentError::new(
                code::INVALID_RESPONSE,
                format!("任务 {task_dir} 的 task.json 缺少 id"),
            )
        })
}

async fn task_directories(tasks_root: &Path) -> AgentResult<HashSet<String>> {
    let mut names = HashSet::new();
    let mut entries = match tokio::fs::read_dir(tasks_root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(names),
        Err(error) => {
            return Err(AgentError::new(
                code::GIT_FAILED,
                format!("无法读取任务目录: {error}"),
            ))
        }
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| AgentError::new(code::GIT_FAILED, format!("无法读取任务目录: {error}")))?
    {
        let is_dir = entry
            .file_type()
            .await
            .map(|kind| kind.is_dir())
            .unwrap_or(false);
        if is_dir {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != "archive" {
                names.insert(name);
            }
        }
    }
    Ok(names)
}

async fn read_task_json_opt(path: &Path) -> AgentResult<Option<Value>> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Ok(None),
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| AgentError::new(code::COMMAND_INVALID, "任务 task.json 已损坏"))?;
    Ok(Some(value))
}

// ponytail: JS 让 ENOENT 冒泡成通用错误；这里统一映射为 COMMAND_INVALID，便于界面提示。
async fn read_utf8(path: &Path) -> AgentResult<String> {
    let bytes = tokio::fs::read(path).await.map_err(|_| {
        AgentError::new(
            code::COMMAND_INVALID,
            "目标任务目录不存在或 task.json 无法读取",
        )
    })?;
    String::from_utf8(bytes)
        .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "任务文件不是有效的 UTF-8 文本"))
}

async fn atomic_write_json(target: &Path, value: &Value) -> AgentResult<()> {
    let mut text = serde_json::to_string_pretty(value).map_err(|error| {
        AgentError::new(
            code::COMMAND_INVALID,
            format!("任务内容无法序列化: {error}"),
        )
    })?;
    text.push('\n');
    let temporary = target.with_extension(format!(
        "{}.{}.{}.tmp",
        target
            .extension()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    {
        let mut file = tokio::fs::File::create(&temporary).await.map_err(|error| {
            AgentError::new(code::GIT_FAILED, format!("无法写入任务文件: {error}"))
        })?;
        file.write_all(text.as_bytes()).await.map_err(|error| {
            AgentError::new(code::GIT_FAILED, format!("无法写入任务文件: {error}"))
        })?;
        file.sync_all().await.ok();
    }
    if let Err(error) = tokio::fs::rename(&temporary, target).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return protocol::err(code::GIT_FAILED, format!("无法替换任务文件: {error}"));
    }
    Ok(())
}

fn script_invocation(script: &str, args: &[String]) -> Vec<String> {
    std::iter::once(script.to_string())
        .chain(args.iter().cloned())
        .collect()
}

/// 环境门记录在 `client.json` 的解释器；文件已被删除时跳过该候选。
fn recorded_python() -> Option<String> {
    use crate::agent::env::ClientConfigLike;

    let data_dir = crate::config::data_dir();
    let text = std::fs::read_to_string(data_dir.join("client.json")).ok()?;
    let document: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let flag = document.python_runtime()?;
    Path::new(&flag.path).is_file().then_some(flag.path)
}

async fn run_task_python(repo_path: &Path, args: &[String]) -> AgentResult<()> {
    let script = repo_path.join(".trellis").join("scripts").join("task.py");
    if tokio::fs::metadata(&script).await.is_err() {
        return protocol::err(
            code::MISSING_TRELLIS,
            "项目缺少 .trellis/scripts/task.py，请检查 Trellis 初始化",
        );
    }
    let script_text = script.to_string_lossy().to_string();
    let mut extra = BTreeMap::new();
    extra.insert("PYTHONUTF8".to_string(), "1".to_string());
    let options = ProcessOptions {
        cwd: Some(repo_path.to_path_buf()),
        env: Some(build_environment(Some(&extra))),
        stdin: None,
        timeout: Some(PYTHON_TIMEOUT),
        max_output_bytes: PYTHON_MAX_OUTPUT_BYTES,
    };
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    if let Ok(python) = std::env::var("TRELLIS_PYTHON") {
        if !python.trim().is_empty() {
            candidates.push((python, script_invocation(&script_text, args)));
        }
    }
    if let Some(python) = recorded_python() {
        candidates.push((python, script_invocation(&script_text, args)));
    }
    candidates.push(("python".to_string(), script_invocation(&script_text, args)));
    candidates.push((
        "py".to_string(),
        std::iter::once("-3".to_string())
            .chain(script_invocation(&script_text, args))
            .collect(),
    ));
    let mut last_error: Option<AgentError> = None;
    for (command, command_args) in candidates {
        let borrowed: Vec<&str> = command_args.iter().map(String::as_str).collect();
        match run_process(Path::new(&command), &borrowed, &options).await {
            Ok(output) if output.success() => return Ok(()),
            Ok(output) => {
                let detail = if !output.stderr.trim().is_empty() {
                    output.stderr.trim().to_string()
                } else if !output.stdout.trim().is_empty() {
                    output.stdout.trim().to_string()
                } else {
                    "未知错误".to_string()
                };
                return protocol::err(
                    code::GIT_FAILED,
                    format!("task.py 执行失败：{}", safe_error_message(&detail)),
                );
            }
            Err(error) if is_spawn_failure(&error) => {
                last_error = Some(error);
            }
            Err(error) => {
                return protocol::err(
                    code::GIT_FAILED,
                    format!(
                        "无法启动 Python 执行 task.py: {}",
                        safe_error_message(&error.message)
                    ),
                )
            }
        }
    }
    let _ = last_error;
    protocol::err(
        code::GIT_FAILED,
        "客户端找不到 Python 运行环境，无法执行项目 task.py",
    )
}

pub(crate) async fn set_task_directory_branch(
    repo_path: &Path,
    task_dir: &str,
    branch_name: &str,
) -> AgentResult<()> {
    run_task_python(
        repo_path,
        &[
            "set-branch".to_string(),
            task_dir.to_string(),
            branch_name.to_string(),
        ],
    )
    .await
}

fn is_spawn_failure(error: &AgentError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("spawnFailed"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// 对照 `shared/slug.js` 的 `normalizeTaskSlug`：只做 trim + 小写，不做 slugify。
fn normalize_task_slug(value: &str) -> String {
    value.trim().to_lowercase()
}

// ponytail: 不做 NFKD 分解（省掉 unicode-normalization 依赖），带重音的拉丁字母会被当作分隔符。
/// 对照 `shared/slug.js` 的 `slugifyTaskTitle`：
/// camelCase → kebab、去掉非 [a-z0-9] 字符、长度在最后一个 '-' 处截到 100。
fn slugify_task_title(value: &str) -> String {
    let mut separated = String::with_capacity(value.len() + 4);
    let chars: Vec<char> = value.chars().collect();
    for (index, current) in chars.iter().enumerate() {
        let previous = index.checked_sub(1).and_then(|at| chars.get(at)).copied();
        let next = chars.get(index + 1).copied();
        let camel = current.is_ascii_uppercase()
            && previous
                .map(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
                .unwrap_or(false);
        let acronym = current.is_ascii_uppercase()
            && previous.map(|ch| ch.is_ascii_uppercase()).unwrap_or(false)
            && next.map(|ch| ch.is_ascii_lowercase()).unwrap_or(false);
        if camel || acronym {
            separated.push('-');
        }
        separated.push(*current);
    }
    let mut slug = String::with_capacity(separated.len());
    let mut pending_dash = false;
    for ch in separated.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            pending_dash = false;
        } else if !pending_dash {
            slug.push('-');
            pending_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if !slug.contains(|ch: char| ch.is_ascii_lowercase()) {
        return String::new();
    }
    if slug.chars().count() <= TASK_SLUG_MAX_LENGTH {
        return slug.to_string();
    }
    let clipped: String = slug.chars().take(TASK_SLUG_MAX_LENGTH).collect();
    match clipped.rfind('-') {
        Some(index) if index > 0 => clipped[..index].trim_end_matches('-').to_string(),
        _ => clipped.trim_end_matches('-').to_string(),
    }
}

/// 对照 `shared/slug.js` 的 `TASK_SLUG_PATTERN`（`^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$`）。
fn is_task_slug(value: &str) -> bool {
    !value.is_empty()
        && value.split('-').all(|segment| {
            !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_alphanumeric())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_keeps_ascii_words() {
        assert_eq!(
            slugify_task_title("Fix desktop Sync Race"),
            "fix-desktop-sync-race"
        );
        assert_eq!(slugify_task_title("  RFC822 Headers  "), "rfc822-headers");
        assert_eq!(slugify_task_title("任务标题"), "");
    }

    #[test]
    fn normalize_slug_prefers_existing_pattern() {
        assert_eq!(normalize_task_slug(" Fix-Desk "), "fix-desk");
        assert_eq!(normalize_task_slug("Fix Desk"), "fix desk");
        assert!(!is_task_slug(&normalize_task_slug("Fix Desk")));
    }

    #[test]
    fn create_execution_key_derives_from_task_control_payload() {
        let command = AgentCommand {
            payload: json!({ "taskId": "task-a", "taskVersion": 1 }),
            ..sample_command()
        };
        assert_eq!(
            create_execution_task_key(&command, &sample_binding()).as_deref(),
            Some("space-1::task-a")
        );
    }

    #[test]
    fn resolve_task_dir_rejects_traversal() {
        let root = Path::new("repo").join(".trellis").join("tasks");
        assert_eq!(
            protocol::resolve_task_dir_under(&root, ".trellis/tasks/../evil"),
            None
        );
        assert_eq!(
            protocol::resolve_task_dir_under(&root, ".trellis/tasks"),
            None
        );
        assert_eq!(
            protocol::resolve_task_dir_under(&root, "elsewhere/tasks/x"),
            None
        );
        assert!(protocol::resolve_task_dir_under(&root, ".trellis/tasks/11-12-fix").is_some());
    }

    #[test]
    fn synced_revision_requires_positive_revision() {
        assert!(require_synced_revision(&json!({ "revision": 3 })).is_ok());
        assert!(require_synced_revision(&json!({ "revision": 0 })).is_err());
        let conflict =
            require_synced_revision(&json!({ "code": "TASK_FILE_CONFLICT" })).unwrap_err();
        assert_eq!(conflict.code, code::HTTP_ERROR);
    }

    #[test]
    fn command_binding_enforces_approved_and_writable() {
        let mut binding = sample_binding();
        let command = sample_command();
        assert!(command_binding(&[binding.clone()], &command).is_ok());
        binding.sync_status = "pending".to_string();
        assert_eq!(
            command_binding(&[binding.clone()], &command)
                .unwrap_err()
                .code,
            code::BINDING_NOT_APPROVED
        );
        binding.sync_status = "approved".to_string();
        binding.read_only = true;
        assert_eq!(
            command_binding(&[binding], &command).unwrap_err().code,
            code::BINDING_NOT_APPROVED
        );

        let mut detaching = sample_binding();
        detaching.detach_pending = true;
        assert_eq!(
            command_binding(&[detaching], &command).unwrap_err().code,
            code::BINDING_UNKNOWN
        );
    }

    #[test]
    fn server_command_binding_checks_project_and_branch() {
        let bindings = vec![sample_binding()];
        let matched = AgentCommand {
            payload: json!({ "taskSpaceId": "space-1", "branchName": "main" }),
            ..sample_command()
        };
        assert!(server_command_binding(&bindings, &matched).is_ok());

        let wrong_branch = AgentCommand {
            payload: json!({ "taskSpaceId": "space-1", "branchName": "dev" }),
            ..sample_command()
        };
        assert_eq!(
            server_command_binding(&bindings, &wrong_branch)
                .unwrap_err()
                .code,
            code::COMMAND_INVALID
        );

        let unknown = AgentCommand {
            binding_id: "other".into(),
            payload: json!({}),
            ..sample_command()
        };
        assert_eq!(
            server_command_binding(&bindings, &unknown)
                .unwrap_err()
                .code,
            code::BINDING_UNKNOWN
        );

        let mut pending = sample_binding();
        pending.sync_status = "pending".into();
        assert_eq!(
            server_command_binding(&[pending], &matched)
                .unwrap_err()
                .code,
            code::BINDING_NOT_APPROVED
        );

        let mut detaching = sample_binding();
        detaching.detach_pending = true;
        assert_eq!(
            server_command_binding(&[detaching], &matched)
                .unwrap_err()
                .code,
            code::BINDING_UNKNOWN
        );
    }

    #[test]
    fn interrupted_git_state_uses_chinese_labels() {
        let root =
            std::env::temp_dir().join(format!("trellis-task-command-git-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".git")).expect("git dir");
        assert!(interrupted_git_state(&root).is_ok());
        std::fs::write(root.join(".git").join("MERGE_HEAD"), b"x").expect("merge head");
        let error = interrupted_git_state(&root).expect_err("合并未完成");
        assert_eq!(error.code, code::GIT_FAILED);
        assert_eq!(
            error.message,
            "仓库存在未完成的合并操作，请先处理后再执行任务命令"
        );
        std::fs::remove_file(root.join(".git").join("MERGE_HEAD")).expect("cleanup");
        std::fs::create_dir_all(root.join(".git").join("rebase-apply")).expect("rebase dir");
        assert!(interrupted_git_state(&root)
            .expect_err("变基未完成")
            .message
            .contains("变基"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn status_report_exposes_binding_and_repository_fields() {
        let inspection = ProjectInspection {
            root: "C:/repo".into(),
            local_repo_key: "local-key".into(),
            branch_name: "main".into(),
            current_branch: "main".into(),
            head: Some("abc".into()),
            clean: false,
            dirty_summary: "M a.md".into(),
            remote_url: "https://example.test/repo.git".into(),
            remote_identity_key: "hash".into(),
            has_trellis: true,
            has_tasks: true,
            has_committed_trellis: true,
            requires_initialization: false,
            existing_agent_tools: Vec::new(),
            repository_name: "repo".into(),
        };
        let report = status_report(&sample_binding(), &inspection, "2026-11-12T00:00:00.000Z");
        assert_eq!(report["bindingId"], json!("binding-1"));
        assert_eq!(report["taskSpaceId"], json!("space-1"));
        assert_eq!(report["projectId"], json!("project-1"));
        assert_eq!(report["branchName"], json!("main"));
        assert_eq!(report["head"], json!("abc"));
        assert_eq!(report["clean"], json!(false));
        assert_eq!(report["syncedAt"], json!("2026-11-12T00:00:00.000Z"));
        assert_eq!(report["localRepoKey"], json!("local-key"));
        assert_eq!(report["remoteIdentityKey"], json!("hash"));
    }

    #[tokio::test]
    async fn atomic_write_json_matches_js_format() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-write-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        let target = root.join("task.json");
        let mut task = json!({ "id": "task-1", "assignee": "old" });
        task["assignee"] = json!("dev");
        atomic_write_json(&target, &task).await.expect("写入");
        let text = std::fs::read_to_string(&target).expect("读取");
        assert_eq!(
            text,
            "{\n  \"assignee\": \"dev\",\n  \"id\": \"task-1\"\n}\n"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn identical_binding_result_does_not_emit_again() {
        let mut binding = sample_binding();
        binding.sync_status = "approved".to_string();
        binding.last_synced_at = None;
        binding.last_head = None;
        binding.last_error = None;
        binding.last_error_code = None;
        let health = None;

        assert!(apply_binding_result(
            &mut binding,
            Some("2026-11-14T00:00:00.000Z"),
            Some("abc123"),
            &health
        ));
        assert!(!apply_binding_result(
            &mut binding,
            Some("2026-11-14T00:00:00.000Z"),
            Some("abc123"),
            &health
        ));
    }

    fn test_context(root: &Path) -> (Arc<ConfigStore>, Arc<TaskSync>) {
        let store = Arc::new(ConfigStore::new(root.join("data")));
        let api = Arc::new(
            crate::agent::http::ApiClient::new("http://127.0.0.1:1", None, None)
                .expect("api client"),
        );
        let sink: task_sync::ControlSink = Arc::new(|_| {});
        let task_sync = Arc::new(TaskSync::new(store.clone(), api, sink));
        (store, task_sync)
    }

    #[tokio::test]
    async fn create_task_rejects_title_without_slug() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-slug-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, task_sync) = test_context(&root);
        let context = CommandContext {
            store: &store,
            task_sync: &task_sync,
        };
        let command = AgentCommand {
            payload: json!({ "taskSpaceId": "space-1", "title": "任务标题", "assigneeDevId": "dev" }),
            ..sample_command()
        };
        let error = create_task(
            &context,
            &command,
            &sample_binding(),
            Path::new("hooks"),
            Path::new("repo"),
        )
        .await
        .expect_err("缺少英文标识");
        assert_eq!(error.code, code::COMMAND_INVALID);
        assert_eq!(
            error.message,
            "任务标题没有可用英文标识，请使用包含英文或数字的标题"
        );
    }

    #[tokio::test]
    async fn create_task_rejects_reserved_archive_slug() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-reserved-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, task_sync) = test_context(&root);
        let context = CommandContext {
            store: &store,
            task_sync: &task_sync,
        };
        let command = AgentCommand {
            payload: json!({
                "taskSpaceId": "space-1",
                "title": "archive",
                "assigneeDevId": "dev"
            }),
            ..sample_command()
        };
        let error = create_task(
            &context,
            &command,
            &sample_binding(),
            Path::new("hooks"),
            Path::new("repo"),
        )
        .await
        .expect_err("归档目录是保留标识");
        assert_eq!(error.code, code::COMMAND_INVALID);
        assert!(error.message.contains("保留"));
    }

    #[tokio::test]
    async fn assign_task_rejects_directory_escape() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-escape-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, task_sync) = test_context(&root);
        let context = CommandContext {
            store: &store,
            task_sync: &task_sync,
        };
        let command = AgentCommand {
            payload: json!({
                "taskSpaceId": "space-1",
                "assigneeDevId": "dev",
                "relativeDir": ".trellis/tasks/../evil"
            }),
            ..sample_command()
        };
        let error = assign_task(
            &context,
            &command,
            &sample_binding(),
            Path::new("hooks"),
            Path::new("repo"),
        )
        .await
        .expect_err("目录越界");
        assert_eq!(error.code, code::COMMAND_INVALID);
        assert_eq!(error.message, "改派任务目录越界");
    }

    #[tokio::test]
    async fn assign_task_rejects_archived_target() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-archive-{}",
            uuid::Uuid::new_v4()
        ));
        let (store, task_sync) = test_context(&root);
        let context = CommandContext {
            store: &store,
            task_sync: &task_sync,
        };
        let command = AgentCommand {
            payload: json!({
                "taskSpaceId": "space-1",
                "assigneeDevId": "dev",
                "relativeDir": ".trellis/tasks/archive/2026-11/old"
            }),
            ..sample_command()
        };
        let error = assign_task(
            &context,
            &command,
            &sample_binding(),
            Path::new("hooks"),
            Path::new("repo"),
        )
        .await
        .expect_err("归档任务不能改派");
        assert_eq!(error.code, code::COMMAND_INVALID);
        assert!(error.message.contains("服务端 Git"));
    }

    #[tokio::test]
    async fn refresh_status_and_sync_branch_map_missing_repository() {
        let root = std::env::temp_dir().join(format!(
            "trellis-task-command-repo-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("temp root");
        let (store, task_sync) = test_context(&root);
        let context = CommandContext {
            store: &store,
            task_sync: &task_sync,
        };
        let mut binding = sample_binding();
        binding.repo_path = root.join("missing").to_string_lossy().to_string();
        assert_eq!(
            refresh_status(&context, &binding)
                .await
                .expect_err("仓库不存在")
                .code,
            code::REPO_NOT_FOUND
        );
        assert_eq!(
            sync_branch(&context, &binding)
                .await
                .expect_err("仓库不存在")
                .code,
            code::REPO_NOT_FOUND
        );
        let plain = root.join("plain");
        std::fs::create_dir_all(&plain).expect("plain dir");
        binding.repo_path = plain.to_string_lossy().to_string();
        let error = refresh_status(&context, &binding)
            .await
            .expect_err("非 Git 仓库");
        assert!(
            error.code == code::NOT_GIT_REPOSITORY || error.code == code::REPO_PATH_INVALID,
            "意外的错误码: {}",
            error.code
        );
        std::fs::remove_dir_all(&root).ok();
    }

    fn sample_binding() -> AgentBinding {
        AgentBinding {
            local_id: "local-1".into(),
            server_binding_id: Some("binding-1".into()),
            task_space_id: "space-1".into(),
            project_id: "project-1".into(),
            repo_path: "C:/repo".into(),
            branch_name: "main".into(),
            baseline_branch: None,
            team_id: Some("team-1".into()),
            remote_identity_key: "remote".into(),
            local_repo_key: "local".into(),
            display_name: "repo".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            allow_file_remote: false,
            read_only: false,
            sync_status: "approved".into(),
            detach_pending: false,
            initial_sync_mode: "review".into(),
            initial_sync_completed: true,
            initial_review_pending: false,
            live_sync_status: "synced".into(),
            live_sync_error: None,
            last_synced_at: None,
            last_head: None,
            last_error: None,
            last_error_code: None,
        }
    }

    fn sample_command() -> AgentCommand {
        AgentCommand {
            id: "command-1".into(),
            binding_id: "binding-1".into(),
            kind: protocol::COMMAND_CREATE_TASK.into(),
            payload: json!({ "taskSpaceId": "space-1", "title": "Fix it", "assigneeDevId": "dev" }),
        }
    }
}
