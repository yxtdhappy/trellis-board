use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::protocol::{code, AgentError, AgentResult};
use crate::agent::store::ConfigStore;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeStatus {
    #[default]
    Discovered,
    WaitingBranch,
    Attaching,
    PendingUpload,
    Attached,
    Error,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeVisibility {
    #[default]
    Hidden,
    Visible,
    HiddenEmpty,
    HiddenMissing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    pub path: String,
    pub branch_name: String,
    #[serde(default)]
    pub common_dir: String,
    #[serde(default)]
    pub baseline_head: Option<String>,
    #[serde(default)]
    pub baseline_task_dirs: Vec<String>,
    #[serde(default)]
    pub baseline_initialized: bool,
    #[serde(default)]
    pub status: WorktreeStatus,
    #[serde(default)]
    pub auto_managed: bool,
    #[serde(default)]
    pub visibility: WorktreeVisibility,
    #[serde(default)]
    pub archive_sync_pending: bool,
    #[serde(default)]
    pub active_task_count: usize,
    #[serde(default)]
    pub server_active_task_count: usize,
    #[serde(default)]
    pub task_space_id: Option<String>,
    #[serde(default)]
    pub tracked_task_dirs: Vec<String>,
    #[serde(default)]
    pub pending_task_dirs: Vec<String>,
    #[serde(default)]
    pub first_upload_completed: bool,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_visibility_error: Option<String>,
    #[serde(default)]
    pub last_visibility_at: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub next_retry_at: i64,
}

impl WorktreeEntry {
    pub fn new(path: String, branch_name: String) -> Self {
        Self {
            path,
            branch_name,
            common_dir: String::new(),
            baseline_head: None,
            baseline_task_dirs: Vec::new(),
            baseline_initialized: false,
            status: WorktreeStatus::Discovered,
            auto_managed: false,
            visibility: WorktreeVisibility::Hidden,
            archive_sync_pending: false,
            active_task_count: 0,
            server_active_task_count: 0,
            task_space_id: None,
            tracked_task_dirs: Vec::new(),
            pending_task_dirs: Vec::new(),
            first_upload_completed: false,
            last_error: None,
            last_visibility_error: None,
            last_visibility_at: None,
            attempts: 0,
            next_retry_at: 0,
        }
    }

    pub fn signature(&self) -> String {
        format!(
            "{:?}|{:?}|{:?}|{:?}|{:?}|{}|{:?}|{}|{:?}|{}|{}|{}|{:?}|{:?}|{:?}|{}|{:?}|{:?}",
            self.path,
            self.branch_name,
            self.common_dir,
            self.baseline_head,
            self.baseline_task_dirs,
            self.baseline_initialized,
            self.status,
            self.auto_managed,
            self.visibility,
            self.archive_sync_pending,
            self.active_task_count,
            self.server_active_task_count,
            self.task_space_id,
            self.tracked_task_dirs,
            self.pending_task_dirs,
            self.first_upload_completed,
            self.last_error,
            self.last_visibility_error,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRegistry {
    pub schema_version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, WorktreeEntry>,
}

impl Default for WorktreeRegistry {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            entries: BTreeMap::new(),
        }
    }
}

pub async fn load(store: &ConfigStore) -> AgentResult<WorktreeRegistry> {
    let path = store.paths.root.join("worktree-registry.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorktreeRegistry::default());
        }
        Err(error) => {
            return Err(AgentError::new(
                code::CONFIG_INVALID,
                format!("无法读取 worktree 注册表：{error}"),
            ));
        }
    };
    serde_json::from_str(&raw).map_err(|error| {
        AgentError::new(
            code::CONFIG_INVALID,
            format!("worktree 注册表格式无效：{error}"),
        )
    })
}

pub async fn save(store: &ConfigStore, registry: &WorktreeRegistry) -> AgentResult<()> {
    let path = store.paths.root.join("worktree-registry.json");
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("无法创建 worktree 注册表目录：{error}"),
            )
        })?;
    }
    store.write_json(Path::new(&path), registry).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_defaults_unknown_fields_and_round_trips() {
        let raw = r#"{
            "schemaVersion": 1,
            "entries": {
                "C:/repo": { "path": "C:/repo", "branchName": "main" }
            }
        }"#;
        let registry: WorktreeRegistry = serde_json::from_str(raw).expect("registry");
        let entry = registry.entries.get("C:/repo").expect("entry");
        assert_eq!(entry.status, WorktreeStatus::Discovered);
        assert_eq!(entry.visibility, WorktreeVisibility::Hidden);
        assert!(!entry.auto_managed);
        assert!(entry.tracked_task_dirs.is_empty());
    }

    #[test]
    fn signature_ignores_visibility_timestamp_and_retry_counters() {
        let entry = WorktreeEntry::new("C:/repo/worktree".into(), "feature".into());
        let mut changed = entry.clone();
        changed.last_visibility_at = Some("2026-11-19T00:00:00Z".into());
        changed.attempts = 3;
        changed.next_retry_at = 42;
        assert_eq!(entry.signature(), changed.signature());
    }
}
