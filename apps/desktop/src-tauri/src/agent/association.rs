//! 桌面端「关联项目 / 预检项目」命令。
//! 来源 JS：`desktop/sidecar/desktop-association.js`（全文），
//! 依赖 `desktop/sidecar/agent/project-onboarding.js` 的 preflight/attach 与
//! `shared/task-snapshot.js` 的快照差异结构；这些能力由 `agent::onboarding` 与
//! `agent::task_sync` 提供，本模块只做桌面侧编排与响应整形。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::credential::CredentialStore;
use crate::agent::http::ApiClient;
use crate::agent::onboarding::{self, AttachOptions};
use crate::agent::protocol::{self, code, err, AgentError, AgentResult};
use crate::agent::store::ConfigStore;
use crate::agent::task_sync::{self, DiffKind, Difference, SnapshotFile, SnapshotGroup};

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
        Path::new(repo_path.trim()),
        &hooks_dir,
        &team_id,
        config.allow_local_git_remotes,
        require_pushed,
    )
    .await;
    let _ = tokio::fs::remove_dir_all(&hooks_dir).await;
    result
}

async fn run_preflight(
    api: &ApiClient,
    repo_path: &Path,
    hooks_dir: &Path,
    team_id: &str,
    allow_file_remote: bool,
    require_pushed: bool,
) -> AgentResult<Value> {
    let local = onboarding::preflight_project_with(
        repo_path,
        hooks_dir,
        team_id,
        allow_file_remote,
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

    // 没有任务空间访问权限时服务端不会给出任务快照，差异按空集合返回。
    if payload.get("status").and_then(Value::as_str) == Some("access_required") {
        payload.insert("differences".to_string(), json!([]));
        payload.insert("counts".to_string(), snapshot_counts(&[]));
        return Ok(Value::Object(payload));
    }

    let local_files =
        task_sync::read_local_task_snapshot_files(Path::new(&local.inspected.root), None).await?;
    let local_groups = task_sync::group_task_snapshot_files(&local_files)?;
    let server_groups = normalize_server_task_groups(payload.get("tasks"))?;
    let differences = task_sync::classify_task_snapshots(&local_groups, &server_groups);
    payload.insert(
        "differences".to_string(),
        Value::Array(differences.iter().map(difference_to_json).collect()),
    );
    payload.insert("counts".to_string(), snapshot_counts(&differences));
    Ok(Value::Object(payload))
}

/// 对照 JS normalizeServerTaskGroups。
fn normalize_server_task_groups(value: Option<&Value>) -> AgentResult<Vec<SnapshotGroup>> {
    let Some(Value::Array(groups)) = value else {
        return Ok(Vec::new());
    };
    let mut normalized = Vec::with_capacity(groups.len());
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
        });
    }
    Ok(normalized)
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
fn difference_to_json(difference: &Difference) -> Value {
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
mod tests {
    use super::*;

    fn server_group(task_dir: &str, task_id: &str, relative: &str, sha256: &str) -> Value {
        json!({
            "taskDir": task_dir,
            "taskId": task_id,
            "files": [{ "path": relative, "sha256": sha256 }],
        })
    }

    fn local_group(task_dir: &str, task_id: &str, relative: &str, content: &str) -> SnapshotGroup {
        let parts = task_sync::task_directory_from_path(relative).expect("path");
        SnapshotGroup {
            task_dir: task_dir.to_string(),
            archived: parts.archived,
            archive_month: parts.archive_month.clone(),
            task_id: Some(task_id.to_string()),
            files: vec![SnapshotFile {
                path: relative.to_string(),
                task_dir: task_dir.to_string(),
                file_path: parts.file_path,
                archived: parts.archived,
                archive_month: parts.archive_month,
                content: content.to_string(),
                sha256: task_sync::snapshot_sha256(content),
                deleted: false,
                base_sha256: None,
            }],
        }
    }

    #[test]
    fn normalizes_server_task_groups() {
        let sha = "a".repeat(64);
        let tasks = json!([server_group(
            ".trellis/tasks/a",
            "a",
            ".trellis/tasks/a/prd.md",
            &sha
        )]);
        let groups = normalize_server_task_groups(Some(&tasks)).expect("groups");
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].task_dir, ".trellis/tasks/a");
        assert_eq!(groups[0].task_id.as_deref(), Some("a"));
        assert_eq!(groups[0].files[0].file_path, "prd.md");
        assert_eq!(groups[0].files[0].sha256, sha);

        assert!(normalize_server_task_groups(None)
            .expect("empty")
            .is_empty());
    }

    #[test]
    fn rejects_invalid_server_task_metadata() {
        let sha = "a".repeat(64);
        let wrong_dir = json!([server_group(
            ".trellis/tasks/a",
            "a",
            ".trellis/tasks/b/prd.md",
            &sha
        )]);
        assert_eq!(
            normalize_server_task_groups(Some(&wrong_dir))
                .unwrap_err()
                .message,
            "服务端任务文件不属于目标目录"
        );

        let bad_sha = json!([server_group(
            ".trellis/tasks/a",
            "a",
            ".trellis/tasks/a/prd.md",
            "not-a-sha"
        )]);
        assert_eq!(
            normalize_server_task_groups(Some(&bad_sha))
                .unwrap_err()
                .message,
            "服务端任务文件摘要无效"
        );

        let missing_files = json!([{ "taskDir": ".trellis/tasks/a" }]);
        assert_eq!(
            normalize_server_task_groups(Some(&missing_files))
                .unwrap_err()
                .message,
            "服务端任务快照第 1 组无效"
        );
    }

    #[test]
    fn classifies_differences_and_counts() {
        let local = vec![
            local_group(".trellis/tasks/a", "a", ".trellis/tasks/a/prd.md", "one"),
            local_group(".trellis/tasks/b", "b", ".trellis/tasks/b/prd.md", "local"),
        ];
        let server_value = json!([
            server_group(
                ".trellis/tasks/a",
                "a",
                ".trellis/tasks/a/prd.md",
                &task_sync::snapshot_sha256("one")
            ),
            server_group(
                ".trellis/tasks/b",
                "b",
                ".trellis/tasks/b/prd.md",
                &task_sync::snapshot_sha256("remote")
            ),
            server_group(
                ".trellis/tasks/c",
                "c",
                ".trellis/tasks/c/prd.md",
                &task_sync::snapshot_sha256("only")
            ),
        ]);
        let server = normalize_server_task_groups(Some(&server_value)).expect("groups");
        let differences = task_sync::classify_task_snapshots(&local, &server);
        let counts = snapshot_counts(&differences);
        assert_eq!(counts["same"], 1);
        assert_eq!(counts["conflicts"], 1);
        assert_eq!(counts["serverOnly"], 1);
        assert_eq!(counts["localOnly"], 0);
        assert_eq!(counts["invalid"], 0);
    }

    #[test]
    fn difference_json_matches_snapshot_shape() {
        let local = vec![local_group(
            ".trellis/tasks/a",
            "a",
            ".trellis/tasks/a/prd.md",
            "one",
        )];
        let differences = task_sync::classify_task_snapshots(&local, &[]);
        let value = difference_to_json(&differences[0]);
        assert_eq!(value["type"], "local-only");
        assert_eq!(value["taskId"], "a");
        assert_eq!(value["taskDir"], ".trellis/tasks/a");
        assert_eq!(value["local"]["taskDir"], ".trellis/tasks/a");
        assert_eq!(
            value["local"]["files"][0]["path"],
            ".trellis/tasks/a/prd.md"
        );
        assert_eq!(value["local"]["files"][0]["content"], "one");
        assert!(value["server"].is_null());
    }

    #[test]
    fn association_summary_serializes_camel_case() {
        let summary = AssociationSummary {
            ok: true,
            project_id: Some("project-1".to_string()),
            task_space_id: Some("space-1".to_string()),
            repo_path: Some("C:/repo".to_string()),
            display_name: Some("Repo".to_string()),
            branch_name: Some("main".to_string()),
            team_id: Some("team-1".to_string()),
            status: Some("attached".to_string()),
            read_only: Some(false),
            live_sync_status: Some("syncing".to_string()),
            live_sync_error: None,
            error: None,
            code: None,
        };
        let value = serde_json::to_value(&summary).expect("serialize");
        assert_eq!(value["projectId"], "project-1");
        assert_eq!(value["taskSpaceId"], "space-1");
        assert_eq!(value["repoPath"], "C:/repo");
        assert_eq!(value["displayName"], "Repo");
        assert_eq!(value["readOnly"], false);
        assert_eq!(value["liveSyncStatus"], "syncing");
        assert!(value.get("error").is_none());
        assert!(value.get("code").is_none());
    }
}
