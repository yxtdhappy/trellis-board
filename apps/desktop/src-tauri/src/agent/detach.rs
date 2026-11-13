//! 本地关联主动解绑：先停止监听，再等待服务端权威确认。

use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agent::http::ApiClient;
use crate::agent::protocol::{self, code, safe_error_message, AgentError, AgentResult};
use crate::agent::store::{AgentBinding, ConfigStore};
use crate::agent::task_sync::{self, TaskSync};

const DETACH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachOutcome {
    pub status: String,
    pub detached: bool,
    pub already_detached: bool,
    pub retryable: bool,
    pub task_space_id: String,
    pub project_id: String,
    pub binding_id: Option<String>,
    pub code: Option<String>,
    pub server_code: Option<String>,
    pub error: Option<String>,
}

async fn mark_pending(store: &ConfigStore, task_space_id: &str) -> AgentResult<AgentBinding> {
    let mut selected = None;
    store
        .update_config(false, |current| {
            let config = current.ok_or_else(|| {
                AgentError::new(code::CONFIG_MISSING, "Agent 配置缺失，请重新登录")
            })?;
            let binding = config
                .bindings
                .iter()
                .find(|binding| binding.task_space_id == task_space_id)
                .cloned()
                .ok_or_else(|| {
                    AgentError::new(code::CONFIG_INVALID, "未找到指定本地任务空间关联")
                })?;
            selected = Some(binding.clone());
            if binding.detach_pending {
                return Ok(None);
            }
            let mut next = config.clone();
            if let Some(item) = next
                .bindings
                .iter_mut()
                .find(|item| item.local_id == binding.local_id)
            {
                item.detach_pending = true;
                item.last_error_code = Some("DETACH_PENDING".to_string());
                item.last_error = Some("服务端解绑待确认".to_string());
            }
            Ok(Some(next))
        })
        .await?;
    selected.ok_or_else(|| AgentError::new(code::CONFIG_INVALID, "未找到指定本地任务空间关联"))
}

async fn record_failure(
    store: &ConfigStore,
    binding: &AgentBinding,
    error: &AgentError,
) -> AgentResult<()> {
    let error_code = error
        .server_code
        .clone()
        .unwrap_or_else(|| error.code.clone());
    let error_message = safe_error_message(&error.message);
    store
        .update_config(false, |current| {
            let Some(config) = current else {
                return Ok(None);
            };
            let mut next = config.clone();
            let Some(item) = next
                .bindings
                .iter_mut()
                .find(|item| item.local_id == binding.local_id && item.detach_pending)
            else {
                return Ok(None);
            };
            if item.last_error_code.as_deref() == Some(error_code.as_str())
                && item.last_error.as_deref() == Some(error_message.as_str())
            {
                return Ok(None);
            }
            item.last_error_code = Some(error_code);
            item.last_error = Some(error_message);
            Ok(Some(next))
        })
        .await?;
    Ok(())
}

async fn remove_local_binding(store: &ConfigStore, binding: &AgentBinding) -> AgentResult<()> {
    store
        .update_config(false, |current| {
            let Some(config) = current else {
                return Ok(None);
            };
            if !config
                .bindings
                .iter()
                .any(|item| item.local_id == binding.local_id)
            {
                return Ok(None);
            }
            let mut next = config.clone();
            next.bindings
                .retain(|item| item.local_id != binding.local_id);
            Ok(Some(next))
        })
        .await?;
    Ok(())
}

fn terminal_detach_error(error: &AgentError) -> bool {
    error.status == Some(404)
        || matches!(
            error.server_code.as_deref(),
            Some("BINDING_UNKNOWN") | Some("BINDING_ALREADY_DETACHED")
        )
}

fn pending_outcome(binding: &AgentBinding, error: &AgentError) -> DetachOutcome {
    DetachOutcome {
        status: "pending".to_string(),
        detached: false,
        already_detached: false,
        retryable: error.retryable || error.code == code::NETWORK_ERROR,
        task_space_id: binding.task_space_id.clone(),
        project_id: binding.project_id.clone(),
        binding_id: binding.server_binding_id.clone(),
        code: Some(error.code.clone()),
        server_code: error.server_code.clone(),
        error: Some(safe_error_message(&error.message)),
    }
}

fn detached_outcome(binding: &AgentBinding, already_detached: bool) -> DetachOutcome {
    DetachOutcome {
        status: "detached".to_string(),
        detached: true,
        already_detached,
        retryable: false,
        task_space_id: binding.task_space_id.clone(),
        project_id: binding.project_id.clone(),
        binding_id: binding.server_binding_id.clone(),
        code: None,
        server_code: None,
        error: None,
    }
}

async fn detach_request(api: &ApiClient, binding: &AgentBinding) -> AgentResult<Value> {
    let path = format!(
        "/api/agent/task-spaces/{}/detach",
        task_sync::urlencode(&binding.task_space_id)
    );
    api.request_json(
        Method::POST,
        &path,
        Some(&json!({ "localRepoKey": binding.local_repo_key.clone() })),
        DETACH_TIMEOUT,
    )
    .await
}

/// 由运行时或桌面命令复用；`refresh_listeners` 仅在实际控制 watcher 的运行时中为真。
pub async fn detach_local_association(
    store: &Arc<ConfigStore>,
    api: &Arc<ApiClient>,
    task_sync: &Arc<TaskSync>,
    task_space_id: &str,
    refresh_listeners: bool,
) -> AgentResult<DetachOutcome> {
    let task_space_id =
        protocol::assert_safe_id(Some(task_space_id), "任务空间 ID", code::CONFIG_INVALID)?;
    let binding = mark_pending(store, &task_space_id).await?;
    if refresh_listeners {
        if let Some(config) = store.read_config(false).await? {
            task_sync.update_bindings(config.bindings).await;
        }
    }

    match detach_request(api, &binding).await {
        Ok(response) => {
            if let Err(error) = task_sync.remove_task_cursor(&binding.task_space_id).await {
                let _ = record_failure(store, &binding, &error).await;
                return Ok(pending_outcome(&binding, &error));
            }
            if let Err(error) = remove_local_binding(store, &binding).await {
                let _ = record_failure(store, &binding, &error).await;
                return Ok(pending_outcome(&binding, &error));
            }
            let already_detached = response
                .get("alreadyDetached")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Ok(detached_outcome(&binding, already_detached))
        }
        Err(error) if terminal_detach_error(&error) => {
            if let Err(cleanup_error) = task_sync.remove_task_cursor(&binding.task_space_id).await {
                let _ = record_failure(store, &binding, &cleanup_error).await;
                return Ok(pending_outcome(&binding, &cleanup_error));
            }
            if let Err(cleanup_error) = remove_local_binding(store, &binding).await {
                let _ = record_failure(store, &binding, &cleanup_error).await;
                return Ok(pending_outcome(&binding, &cleanup_error));
            }
            Ok(detached_outcome(&binding, true))
        }
        Err(error) => {
            let _ = record_failure(store, &binding, &error).await;
            Ok(pending_outcome(&binding, &error))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::store::AgentConfig;

    fn binding() -> AgentBinding {
        AgentBinding {
            local_id: "local-1".to_string(),
            server_binding_id: Some("binding-1".to_string()),
            task_space_id: "space-1".to_string(),
            project_id: "project-1".to_string(),
            repo_path: "C:/repo".to_string(),
            branch_name: "main".to_string(),
            baseline_branch: None,
            team_id: Some("team-1".to_string()),
            remote_identity_key: "a".repeat(64),
            local_repo_key: "b".repeat(64),
            display_name: "Repo".to_string(),
            created_at: "2026-11-12T00:00:00.000Z".to_string(),
            allow_file_remote: false,
            read_only: false,
            sync_status: "approved".to_string(),
            detach_pending: false,
            initial_sync_mode: "bootstrap".to_string(),
            initial_sync_completed: true,
            initial_review_pending: false,
            live_sync_status: "ready".to_string(),
            live_sync_error: None,
            last_synced_at: None,
            last_head: None,
            last_error: None,
            last_error_code: None,
        }
    }

    fn config() -> AgentConfig {
        AgentConfig {
            schema_version: crate::agent::store::CONFIG_SCHEMA_VERSION,
            revision: "0123456789abcdef0123456789abcdef".to_string(),
            server_url: "http://localhost:4310".to_string(),
            ca_file: None,
            allow_local_git_remotes: false,
            agent_id: "agent-1".to_string(),
            device_name: "PC".to_string(),
            username: Some("dev".to_string()),
            team_id: None,
            teams: Vec::new(),
            protocol_version: 3,
            agent_version: None,
            paired_at: None,
            bindings: vec![binding()],
        }
    }

    #[test]
    fn terminal_errors_cover_404_and_known_binding_states() {
        let mut error = AgentError::new(code::HTTP_ERROR, "not found");
        error.status = Some(404);
        assert!(terminal_detach_error(&error));
        error.status = None;
        error.server_code = Some("BINDING_ALREADY_DETACHED".to_string());
        assert!(terminal_detach_error(&error));
        error.server_code = Some("REMOTE_MISMATCH".to_string());
        assert!(!terminal_detach_error(&error));
    }

    #[tokio::test]
    async fn mark_pending_updates_only_the_selected_binding() {
        let root =
            std::env::temp_dir().join(format!("trellis-detach-{}", uuid::Uuid::new_v4()));
        let store = ConfigStore::new_unsecured_for_test(root);
        store.ensure_directories().await.expect("directories");
        let mut seeded = config();
        let mut other = binding();
        other.local_id = "local-2".to_string();
        other.task_space_id = "space-2".to_string();
        other.local_repo_key = "c".repeat(64);
        seeded.bindings.push(other);
        store.save_config(seeded).await.expect("config");

        let selected = mark_pending(&store, "space-1").await.expect("pending");
        assert_eq!(selected.task_space_id, "space-1");
        assert!(!selected.detach_pending);
        let saved = store.read_config(false).await.expect("read").expect("config");
        assert!(saved.bindings[0].detach_pending);
        assert!(!saved.bindings[1].detach_pending);
        assert_eq!(saved.bindings[0].last_error.as_deref(), Some("服务端解绑待确认"));
    }
}
