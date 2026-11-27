//! 桌面端「关联项目 / 预检项目」命令。
//! 来源 JS：`desktop/sidecar/desktop-association.js`（全文），
//! 依赖 `desktop/sidecar/agent/project-onboarding.js` 的 preflight/attach 与
//! `shared/task-snapshot.js` 的快照差异结构；这些能力由 `agent::onboarding` 与
//! `agent::task_sync` 提供，本模块只做桌面侧编排与响应整形。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::credential::CredentialStore;
use crate::agent::http::ApiClient;
use crate::agent::onboarding::{self, AttachOptions};
use crate::agent::protocol::{self, code, err, AgentError, AgentResult};
use crate::agent::store::{AgentConfig, ConfigStore};
use crate::agent::task_sync::{self, DiffKind, Difference, SnapshotFile, SnapshotGroup};
use crate::agent::worktree;

/// associateDesktopProject 的返回值；字段对照 JS，未赋值的项不序列化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationSummary {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_space_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_sync_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_sync_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_review_pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// associateDesktopProject 的入参（对照 JS options）。
#[derive(Debug, Clone, Default)]
pub struct AssociateParams {
    pub repo_path: String,
    pub branch_name: String,
    pub team_id: String,
    pub developer_id: String,
    pub display_name: Option<String>,
    pub require_pushed: bool,
    /// bootstrap / safe / review（JS 在桌面层先校验，错误码为 CONFIG_INVALID）。
    pub initial_sync_mode: String,
}

/// 对照 JS associateDesktopProject：本地校验 → preflight/attach → 写本地配置。
pub async fn associate_desktop_project(
    store: &ConfigStore,
    api: &ApiClient,
    params: AssociateParams,
) -> AgentResult<AssociationSummary> {
    let branch_name = protocol::validate_branch_name_syntax(params.branch_name.trim())?;
    let team_id = params.team_id.trim().to_string();
    let developer_id = params.developer_id.trim().to_string();
    let mode = params.initial_sync_mode.trim().to_string();
    if team_id.is_empty() || developer_id.is_empty() {
        return err(
            code::CONFIG_INVALID,
            "关联项目必须选择团队并填写 developer ID",
        );
    }
    if !matches!(mode.as_str(), "bootstrap" | "safe" | "review") {
        return err(code::CONFIG_INVALID, "首次同步处理方式无效");
    }
    let repo_path = params.repo_path.trim().to_string();

    store.ensure_directories().await?;
    let config = store
        .read_config(false)
        .await?
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"))?;
    // JS 在这里确认设备凭证可用；缺失时应直接失败，而不是等到 attach 才报错。
    CredentialStore::new(store).load_credential().await?;

    let local_id = uuid::Uuid::new_v4().to_string();
    let hooks_dir = store.paths.hooks_base_dir.join(&local_id);
    tokio::fs::create_dir_all(&hooks_dir)
        .await
        .map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法创建 Agent hooks 目录：{error}"),
            )
        })?;

    let result = onboarding::attach_project(
        api,
        store,
        &AttachOptions {
            repo_path: Path::new(&repo_path),
            hooks_dir: &hooks_dir,
            team_id: &team_id,
            developer_id: &developer_id,
            expected_branch: Some(branch_name.as_str()),
            display_name: params.display_name.as_deref(),
            allow_file_remote: config.allow_local_git_remotes,
            require_pushed: params.require_pushed,
            is_worktree: false,
            initial_sync_mode: Some(mode.as_str()),
        },
    )
    .await?;

    let binding = &result.binding;
    Ok(AssociationSummary {
        ok: true,
        project_id: Some(result.project.id.clone()),
        task_space_id: Some(result.task_space.id.clone()),
        repo_path: Some(binding.repo_path.clone()),
        // ponytail: JS 的 bindingFromAttach 未带 displayName（返回 undefined），这里返回真实展示名。
        display_name: Some(binding.display_name.clone()),
        branch_name: Some(binding.branch_name.clone()),
        team_id: binding.team_id.clone(),
        status: Some(binding.sync_status.clone()),
        read_only: Some(binding.read_only),
        live_sync_status: Some(binding.live_sync_status.clone()),
        live_sync_error: None,
        initial_review_pending: Some(binding.initial_review_pending),
        error: None,
        code: None,
    })
}

/// 对照 JS preflightDesktopProject：本地预检 → 服务端预检 → 任务快照差异。
/// 返回服务端响应并补齐 `inspected` / `differences` / `counts`。
pub async fn preflight_desktop_project(
    store: &ConfigStore,
    api: &ApiClient,
    repo_path: &str,
    team_id: &str,
    developer_id: &str,
    require_pushed: bool,
) -> AgentResult<Value> {
    let team_id = team_id.trim().to_string();
    if team_id.is_empty() {
        return err(code::CONFIG_INVALID, "预检项目必须选择团队");
    }
    let config = store
        .read_config(false)
        .await?
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"))?;
    CredentialStore::new(store).load_credential().await?;

    // 预检只是只读检查，用一次性 hooks 目录，结束后删除（对照 JS mkdtemp + rm）。
    let hooks_dir =
        std::env::temp_dir().join(format!("trellis-preflight-hooks-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&hooks_dir)
        .await
        .map_err(|error| {
            AgentError::new(
                code::GIT_FAILED,
                format!("无法创建临时 hooks 目录：{error}"),
            )
        })?;
    let result = run_preflight(
        api,
        &config,
        Path::new(repo_path.trim()),
        &hooks_dir,
        &team_id,
        developer_id,
        require_pushed,
    )
    .await;
    let _ = tokio::fs::remove_dir_all(&hooks_dir).await;
    result
}

async fn run_preflight(
    api: &ApiClient,
    config: &AgentConfig,
    repo_path: &Path,
    hooks_dir: &Path,
    team_id: &str,
    developer_id: &str,
    require_pushed: bool,
) -> AgentResult<Value> {
    let local = onboarding::preflight_project_with(
        repo_path,
        hooks_dir,
        team_id,
        config.allow_local_git_remotes,
        require_pushed,
    )
    .await?;
    let server = onboarding::preflight_task_space(api, &local.inspected, team_id).await?;
    let Value::Object(mut payload) = server else {
        return err(code::INVALID_RESPONSE, "服务端返回了无效的任务预检结果");
    };
    payload.insert(
        "inspected".to_string(),
        serde_json::to_value(&local.inspected).map_err(|_| {
            AgentError::new(code::INVALID_RESPONSE, "服务端返回了无效的任务预检结果")
        })?,
    );

    // 没有任务空间访问权限或任务空间不可用时服务端不会给出任务快照，差异按空集合返回。
    if matches!(
        payload.get("status").and_then(Value::as_str),
        Some("access_required") | Some("unavailable")
    ) {
        payload.insert("differences".to_string(), json!([]));
        payload.insert("counts".to_string(), snapshot_counts(&[]));
        return Ok(Value::Object(payload));
    }

    let trimmed_dev_id = developer_id.trim();
    let effective_owner_id = if !trimmed_dev_id.is_empty() {
        Some(trimmed_dev_id.to_string())
    } else {
        worktree::developer_id(repo_path, config, &local.inspected.remote_identity_key).await
    };

    let local_files =
        task_sync::read_local_task_snapshot_files(Path::new(&local.inspected.root), None).await?;
    let local_groups = task_sync::group_task_snapshot_files(&local_files)?;
    let (differences, server_titles) = build_preflight_differences(
        &local.inspected.branch_name,
        effective_owner_id.as_deref(),
        local_groups,
        &payload,
    )?;
    payload.insert(
        "differences".to_string(),
        Value::Array(
            differences
                .iter()
                .map(|difference| difference_to_json(difference, &server_titles))
                .collect(),
        ),
    );
    payload.insert("counts".to_string(), snapshot_counts(&differences));
    Ok(Value::Object(payload))
}

fn build_preflight_differences(
    branch_name: &str,
    owner_id: Option<&str>,
    mut local_groups: Vec<SnapshotGroup>,
    payload: &serde_json::Map<String, Value>,
) -> AgentResult<(Vec<Difference>, HashMap<String, String>)> {
    if let Some(owner_id) = owner_id.map(str::trim).filter(|value| !value.is_empty()) {
        local_groups.retain(|group| task_sync::group_owned_by_developer(group, owner_id));
    }
    let (mut server_groups, server_titles) =
        normalize_server_task_groups_with_titles(payload.get("tasks"))?;
    task_sync::retain_server_groups_for_branch_initial_sync(
        branch_name,
        &local_groups,
        &mut server_groups,
    );
    let mut differences = task_sync::classify_task_snapshots(&local_groups, &server_groups);
    let hidden_dirs = string_set_from_value(payload.get("hiddenTaskDirs"));
    let archived_basenames = string_set_from_value(payload.get("archivedTaskBasenames"));
    if !hidden_dirs.is_empty() || !archived_basenames.is_empty() {
        differences.retain(|difference| {
            if difference.kind != DiffKind::LocalOnly {
                return true;
            }
            let Some(local) = difference.local.as_ref() else {
                return true;
            };
            if hidden_dirs.contains(&local.task_dir) {
                return false;
            }
            let basename = local.task_dir.rsplit('/').next().unwrap_or("");
            !archived_basenames.contains(basename)
        });
    }
    Ok((differences, server_titles))
}

fn string_set_from_value(value: Option<&Value>) -> HashSet<String> {
    let Some(Value::Array(items)) = value else {
        return HashSet::new();
    };
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

/// 对照 JS normalizeServerTaskGroups。
#[cfg(test)]
fn normalize_server_task_groups(value: Option<&Value>) -> AgentResult<Vec<SnapshotGroup>> {
    normalize_server_task_groups_with_titles(value).map(|(groups, _)| groups)
}

fn normalize_server_task_groups_with_titles(
    value: Option<&Value>,
) -> AgentResult<(Vec<SnapshotGroup>, HashMap<String, String>)> {
    let Some(Value::Array(groups)) = value else {
        return Ok((Vec::new(), HashMap::new()));
    };
    let mut normalized = Vec::with_capacity(groups.len());
    let mut titles = HashMap::new();
    for (index, group) in groups.iter().enumerate() {
        let Some(object) = group.as_object() else {
            return err(
                code::INVALID_RESPONSE,
                format!("服务端任务快照第 {} 组无效", index + 1),
            );
        };
        let Some(Value::Array(files)) = object.get("files") else {
            return err(
                code::INVALID_RESPONSE,
                format!("服务端任务快照第 {} 组无效", index + 1),
            );
        };
        let task_dir = object
            .get("taskDir")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let task_id = object
            .get("taskId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let task_branch = object
            .get("taskBranch")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(title) = object
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !task_dir.is_empty() {
                titles.insert(task_dir.clone(), title.to_string());
            }
        }

        let mut snapshot_files = Vec::with_capacity(files.len());
        let mut archived = false;
        let mut archive_month = None;
        for file in files {
            let Some(file_object) = file.as_object() else {
                return err(code::INVALID_RESPONSE, "服务端任务文件元数据无效");
            };
            let relative = task_sync::normalize_snapshot_path(
                file_object
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
            )?;
            let parts = task_sync::task_directory_from_path(&relative)?;
            if parts.task_dir != task_dir {
                return err(code::INVALID_RESPONSE, "服务端任务文件不属于目标目录");
            }
            let sha256 = file_object
                .get("sha256")
                .and_then(Value::as_str)
                .unwrap_or("");
            if !is_sha256(sha256) {
                return err(code::INVALID_RESPONSE, "服务端任务文件摘要无效");
            }
            if snapshot_files.is_empty() {
                archived = parts.archived;
                archive_month = parts.archive_month.clone();
            }
            snapshot_files.push(SnapshotFile {
                path: relative,
                task_dir: task_dir.clone(),
                file_path: parts.file_path,
                archived: parts.archived,
                archive_month: parts.archive_month,
                // 服务端快照只带摘要，内容留空（JS 为 content: null）。
                content: String::new(),
                sha256: sha256.to_string(),
                deleted: false,
                base_sha256: None,
            });
        }
        normalized.push(SnapshotGroup {
            task_dir,
            archived,
            archive_month,
            files: snapshot_files,
            task_id,
            task_branch,
        });
    }
    Ok((normalized, titles))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 对照 JS snapshotCounts。
fn snapshot_counts(differences: &[Difference]) -> Value {
    let mut same = 0usize;
    let mut local_only = 0usize;
    let mut server_only = 0usize;
    let mut conflicts = 0usize;
    let mut invalid = 0usize;
    for difference in differences {
        match difference.kind {
            DiffKind::Same => same += 1,
            DiffKind::LocalOnly => local_only += 1,
            DiffKind::ServerOnly => server_only += 1,
            DiffKind::ContentConflict | DiffKind::MoveDeleteConflict => conflicts += 1,
            DiffKind::Invalid => invalid += 1,
        }
    }
    json!({
        "same": same,
        "localOnly": local_only,
        "serverOnly": server_only,
        "conflicts": conflicts,
        "invalid": invalid,
    })
}

/// 对照 JS 的差异对象（task_sync 的 to_control 是私有的，这里按同一结构输出完整分组）。
fn difference_to_json(difference: &Difference, server_titles: &HashMap<String, String>) -> Value {
    let title = difference
        .local
        .as_ref()
        .and_then(task_sync::task_title)
        .or_else(|| {
            difference
                .server
                .as_ref()
                .and_then(|group| server_titles.get(&group.task_dir).cloned())
        });
    json!({
        "type": match difference.kind {
            DiffKind::Same => "same",
            DiffKind::ServerOnly => "server-only",
            DiffKind::LocalOnly => "local-only",
            DiffKind::ContentConflict => "content-conflict",
            DiffKind::MoveDeleteConflict => "move-delete-conflict",
            DiffKind::Invalid => "invalid",
        },
        "taskId": difference.task_id,
        "taskDir": difference.task_dir,
        "title": title,
        "local": difference.local.as_ref().map(group_to_json),
        "server": difference.server.as_ref().map(group_to_json),
    })
}

fn group_to_json(group: &SnapshotGroup) -> Value {
    json!({
        "taskDir": group.task_dir,
        "archived": group.archived,
        "archiveMonth": group.archive_month,
        "taskId": group.task_id,
        "files": group.files.iter().map(file_to_json).collect::<Vec<Value>>(),
    })
}

fn file_to_json(file: &SnapshotFile) -> Value {
    json!({
        "taskDir": file.task_dir,
        "filePath": file.file_path,
        "archived": file.archived,
        "archiveMonth": file.archive_month,
        "path": file.path,
        "content": file.content,
        "sha256": file.sha256,
        "deleted": file.deleted,
        "baseSha256": file.base_sha256,
    })
}

#[cfg(test)]
mod tests;
