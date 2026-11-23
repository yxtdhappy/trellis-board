use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::protocol::{self, code, AgentResult};

pub const TASK_CONTROL_STATE_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskControlState {
    Materialized,
    Claimed,
    PendingDelivery,
    Reassigned,
    Archived,
    HandoffMaterialized,
    Unknown(String),
}

impl TaskControlState {
    pub fn parse(value: &str) -> Self {
        match value {
            "materialized" => Self::Materialized,
            "claimed" => Self::Claimed,
            "pending_delivery" => Self::PendingDelivery,
            "reassigned" => Self::Reassigned,
            "archived" => Self::Archived,
            "handoff_materialized" => Self::HandoffMaterialized,
            other => Self::Unknown(other.to_string()),
        }
    }

    pub fn is_writable_local(&self) -> bool {
        matches!(
            self,
            Self::Materialized | Self::Claimed | Self::PendingDelivery
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskControl {
    pub execution_task_key: String,
    pub task_id: String,
    pub relative_dir: String,
    #[serde(default)]
    pub title: String,
    pub state: String,
    #[serde(default)]
    pub task_version: u64,
    #[serde(default)]
    pub assignee_user_id: Option<String>,
    #[serde(default)]
    pub handoff_state: String,
    #[serde(default)]
    pub materialized_revision: Option<u64>,
    #[serde(default)]
    pub content_revision: Option<u64>,
    #[serde(default)]
    pub materialized_at: Option<String>,
    #[serde(default)]
    pub lease_held_by_other_user: bool,
    #[serde(default)]
    pub updated_at: String,
}

impl TaskControl {
    pub fn from_control_value(value: &Value) -> AgentResult<Self> {
        let execution_task_key =
            required_text(value, "executionTaskKey", "任务控制缺少 executionTaskKey")?;
        let task_id = required_text(value, "taskId", "任务控制缺少 taskId")?;
        let relative_dir = required_text(value, "relativeDir", "任务控制缺少 relativeDir")?;
        let state = required_text(value, "state", "任务控制缺少 state")?;
        let task_version = value
            .get("taskVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                protocol::AgentError::new(code::INVALID_RESPONSE, "任务控制缺少 taskVersion")
            })?;
        if execution_task_key
            != format!(
                "{}::{task_id}",
                execution_key_task_space_id(&execution_task_key)?
            )
        {
            return protocol::err(code::INVALID_RESPONSE, "任务控制执行身份不一致");
        }
        Ok(Self {
            execution_task_key,
            task_id,
            relative_dir,
            title: optional_text(value, "title"),
            state,
            task_version,
            assignee_user_id: optional_nonempty_text(value, "assigneeUserId"),
            handoff_state: optional_text(value, "handoffState"),
            materialized_revision: value.get("materializedRevision").and_then(Value::as_u64),
            content_revision: value.get("contentRevision").and_then(Value::as_u64),
            materialized_at: optional_nonempty_text(value, "materializedAt"),
            lease_held_by_other_user: value
                .get("leaseHeldByOtherUser")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            updated_at: optional_text(value, "updatedAt"),
        })
    }

    pub fn from_task_value(value: &Value) -> AgentResult<Self> {
        let execution_task_key =
            required_text(value, "executionTaskKey", "任务响应缺少 executionTaskKey")?;
        let task_id = required_text(value, "taskId", "任务响应缺少 taskId")?;
        let relative_dir = required_text(value, "relativeDir", "任务响应缺少 relativeDir")?;
        let task_version = value
            .get("taskVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                protocol::AgentError::new(code::INVALID_RESPONSE, "任务响应缺少 taskVersion")
            })?;
        if execution_task_key
            != format!(
                "{}::{task_id}",
                execution_key_task_space_id(&execution_task_key)?
            )
        {
            return protocol::err(code::INVALID_RESPONSE, "任务响应执行身份不一致");
        }
        let archived = value
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let materialization = value
            .get("materializationState")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        let state = if archived {
            "archived"
        } else {
            match materialization {
                "materialized" => "materialized",
                "pending" => "pending_delivery",
                _ => "claimed",
            }
        };
        Ok(Self {
            execution_task_key,
            task_id,
            relative_dir,
            title: optional_text(value, "title"),
            state: state.to_string(),
            task_version,
            assignee_user_id: optional_nonempty_text(value, "assigneeUserId"),
            handoff_state: optional_text(value, "handoffState"),
            materialized_revision: value.get("materializedRevision").and_then(Value::as_u64),
            content_revision: value.get("contentRevision").and_then(Value::as_u64),
            materialized_at: optional_nonempty_text(value, "materializedAt"),
            lease_held_by_other_user: false,
            updated_at: optional_text(value, "updatedAt"),
        })
    }

    pub fn control_state(&self) -> TaskControlState {
        TaskControlState::parse(&self.state)
    }

    pub fn is_writable_local(&self) -> bool {
        self.control_state().is_writable_local()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadFence {
    pub task_version: u64,
    pub lease_token: String,
}

impl UploadFence {
    pub fn apply(&self, request: &mut Value) {
        request["taskVersion"] = json!(self.task_version);
        request["leaseToken"] = Value::String(self.lease_token.clone());
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskControlStateFile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub controls: BTreeMap<String, StoredTaskControl>,
    #[serde(default)]
    pub leases: BTreeMap<String, StoredTaskLease>,
    #[serde(default)]
    pub handoffs: BTreeMap<String, StoredTaskHandoff>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTaskControl {
    pub local_id: String,
    pub task_space_id: String,
    pub task_id: String,
    pub relative_dir: String,
    pub title: String,
    pub state: String,
    pub task_version: u64,
    #[serde(default)]
    pub assignee_user_id: Option<String>,
    #[serde(default)]
    pub handoff_state: String,
    #[serde(default)]
    pub materialized_revision: Option<u64>,
    #[serde(default)]
    pub materialized_at: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

impl StoredTaskControl {
    pub fn from_control(local_id: &str, control: &TaskControl) -> AgentResult<Self> {
        let task_space_id = execution_key_task_space_id(&control.execution_task_key)?;
        if control.task_id.is_empty()
            || control.relative_dir.is_empty()
            || protocol::resolve_task_dir_under(Path::new(".trellis/tasks"), &control.relative_dir)
                .is_none()
        {
            return protocol::err(code::INVALID_RESPONSE, "任务控制目录无效");
        }
        Ok(Self {
            local_id: local_id.to_string(),
            task_space_id,
            task_id: control.task_id.clone(),
            relative_dir: control.relative_dir.clone(),
            title: control.title.clone(),
            state: control.state.clone(),
            task_version: control.task_version,
            assignee_user_id: control.assignee_user_id.clone(),
            handoff_state: control.handoff_state.clone(),
            materialized_revision: control.materialized_revision,
            materialized_at: control.materialized_at.clone(),
            updated_at: control.updated_at.clone(),
        })
    }

    pub fn control_state(&self) -> TaskControlState {
        TaskControlState::parse(&self.state)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTaskLease {
    pub token: String,
    pub expires_at: String,
    #[serde(default)]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTaskHandoff {
    pub local_id: String,
    pub task_space_id: String,
    pub execution_task_key: String,
    pub task_id: String,
    pub relative_dir: String,
    pub server_handoff_state: String,
    #[serde(default)]
    pub materialized_at: Option<String>,
    #[serde(default)]
    pub materialized_revision: Option<u64>,
    pub ack_state: String,
    pub outcome: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub backup_id: Option<String>,
    #[serde(default)]
    pub manifest_sha256: Option<String>,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub lease_held_by_other_user: bool,
    #[serde(default)]
    pub notified_state: String,
    pub updated_at: String,
}

impl StoredTaskHandoff {
    fn from_control(local_id: &str, control: &TaskControl) -> AgentResult<Self> {
        let stored_control = StoredTaskControl::from_control(local_id, control)?;
        let conflict = control.handoff_state == "source_cleanup_conflict";
        Ok(Self {
            local_id: stored_control.local_id,
            task_space_id: stored_control.task_space_id,
            execution_task_key: control.execution_task_key.clone(),
            task_id: stored_control.task_id,
            relative_dir: stored_control.relative_dir,
            server_handoff_state: control.handoff_state.clone(),
            materialized_at: control.materialized_at.clone(),
            materialized_revision: control.materialized_revision,
            ack_state: if conflict { "done" } else { "pending" }.to_string(),
            outcome: if conflict { "conflict" } else { "" }.to_string(),
            reason: conflict.then(|| "unknown".to_string()),
            backup_id: None,
            manifest_sha256: None,
            file_count: 0,
            total_bytes: 0,
            lease_held_by_other_user: control.lease_held_by_other_user,
            notified_state: String::new(),
            updated_at: control.updated_at.clone(),
        })
    }

    pub fn notice(&self) -> Option<HandoffNotice> {
        let show = self.outcome == "conflict"
            || (self.outcome == "cleaned" && self.ack_state == "done")
            || (self.outcome != "cleaned"
                && !self.server_handoff_state.is_empty()
                && self.server_handoff_state != "completed");
        show.then(|| HandoffNotice {
            execution_task_key: self.execution_task_key.clone(),
            task_id: self.task_id.clone(),
            relative_dir: self.relative_dir.clone(),
            handoff_state: self.server_handoff_state.clone(),
            ack_state: self.ack_state.clone(),
            outcome: self.outcome.clone(),
            reason: self.reason.clone(),
            backup_id: self.backup_id.clone(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffNotice {
    pub execution_task_key: String,
    pub task_id: String,
    pub relative_dir: String,
    pub handoff_state: String,
    pub ack_state: String,
    pub outcome: String,
    pub reason: Option<String>,
    pub backup_id: Option<String>,
}

pub fn handoff_state_key(local_id: &str, execution_task_key: &str) -> String {
    format!("{local_id}::{execution_task_key}")
}

/// ACK 状态属于单次物化轮次：`materializedAt`/`materializedRevision` 变化即代表服务端
/// 重新物化了该任务（例如再次跨用户委派），旧轮次的 done/cleaned 不能吞掉新轮次清理。
/// 旧状态文件缺少轮次标识时，遇到携带标识的新控制按新一轮自愈；两侧都无法判断时保持同轮。
fn same_materialization_cycle(prev: &StoredTaskHandoff, next: &StoredTaskHandoff) -> bool {
    if let (Some(prev_at), Some(next_at)) = (&prev.materialized_at, &next.materialized_at) {
        return prev_at == next_at;
    }
    if let (Some(prev_revision), Some(next_revision)) =
        (prev.materialized_revision, next.materialized_revision)
    {
        return prev_revision == next_revision;
    }
    !(prev.materialized_at.is_none()
        && prev.materialized_revision.is_none()
        && (next.materialized_at.is_some() || next.materialized_revision.is_some()))
}

impl TaskControlStateFile {
    pub fn empty() -> Self {
        Self {
            schema_version: TASK_CONTROL_STATE_VERSION,
            controls: BTreeMap::new(),
            leases: BTreeMap::new(),
            handoffs: BTreeMap::new(),
        }
    }

    pub fn merge_binding_controls(
        &mut self,
        local_id: &str,
        task_space_id: &str,
        controls: &[TaskControl],
    ) -> AgentResult<bool> {
        if self.schema_version != TASK_CONTROL_STATE_VERSION {
            *self = Self::empty();
        }
        for control in controls {
            if execution_key_task_space_id(&control.execution_task_key)? != task_space_id {
                return protocol::err(code::INVALID_RESPONSE, "任务控制与当前任务空间不一致");
            }
        }
        let existing = self.controls.clone();
        let before_controls = self.controls.clone();
        self.controls.retain(|_, control| {
            control.local_id != local_id || control.task_space_id != task_space_id
        });
        for control in controls {
            let mut stored = StoredTaskControl::from_control(local_id, control)?;
            if let Some(previous) = existing.get(&control.execution_task_key) {
                if stored.task_version < previous.task_version {
                    stored = previous.clone();
                }
            }
            self.controls
                .insert(control.execution_task_key.clone(), stored);
        }
        // 控制面是权威：任务已离开 handoff 清理状态后，本地残留的冲突记录必须移除，
        // 否则失效提示会永久驻留；cleaned 成功记录保留既有通知语义。
        let before_handoff_count = self.handoffs.len();
        let merged_controls = &self.controls;
        self.handoffs.retain(|_, handoff| {
            if handoff.local_id != local_id || handoff.task_space_id != task_space_id {
                return true;
            }
            if handoff.outcome == "cleaned" {
                return true;
            }
            merged_controls
                .get(&handoff.execution_task_key)
                .is_some_and(|control| {
                    control.state == "handoff_materialized"
                        && matches!(
                            control.handoff_state.as_str(),
                            "source_cleanup_pending" | "source_cleanup_conflict"
                        )
                })
        });
        let handoffs_changed = self.handoffs.len() != before_handoff_count;
        Ok(before_controls != self.controls || handoffs_changed)
    }

    pub fn upsert_control(&mut self, local_id: &str, control: &TaskControl) -> AgentResult<bool> {
        if self.schema_version != TASK_CONTROL_STATE_VERSION {
            *self = Self::empty();
        }
        let stored = StoredTaskControl::from_control(local_id, control)?;
        if let Some(previous) = self.controls.get(&control.execution_task_key) {
            if stored.task_version < previous.task_version {
                return Ok(false);
            }
        }
        if self.controls.get(&control.execution_task_key) == Some(&stored) {
            return Ok(false);
        }
        self.controls
            .insert(control.execution_task_key.clone(), stored);
        Ok(true)
    }

    pub fn upsert_handoff_control(
        &mut self,
        local_id: &str,
        control: &TaskControl,
    ) -> AgentResult<bool> {
        if self.schema_version != TASK_CONTROL_STATE_VERSION {
            *self = Self::empty();
        }
        let key = handoff_state_key(local_id, &control.execution_task_key);
        let mut next = StoredTaskHandoff::from_control(local_id, control)?;
        if let Some(previous) = self.handoffs.get(&key) {
            if same_materialization_cycle(previous, &next) {
                next.ack_state = previous.ack_state.clone();
                next.outcome = previous.outcome.clone();
                next.reason = previous.reason.clone();
                next.backup_id = previous.backup_id.clone();
                next.manifest_sha256 = previous.manifest_sha256.clone();
                next.file_count = previous.file_count;
                next.total_bytes = previous.total_bytes;
                next.notified_state = previous.notified_state.clone();
                if control.handoff_state == "source_cleanup_conflict" && previous.outcome.is_empty()
                {
                    next.ack_state = "done".to_string();
                    next.outcome = "conflict".to_string();
                    next.reason = Some("unknown".to_string());
                }
            }
        }
        if self.handoffs.get(&key) == Some(&next) {
            return Ok(false);
        }
        self.handoffs.insert(key, next);
        Ok(true)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn mark_handoff_ack_pending(
        &mut self,
        key: &str,
        outcome: &str,
        reason: Option<String>,
        backup_id: Option<String>,
        manifest_sha256: Option<String>,
        file_count: u64,
        total_bytes: u64,
        updated_at: &str,
    ) -> bool {
        let Some(handoff) = self.handoffs.get_mut(key) else {
            return false;
        };
        let next = (
            "pending".to_string(),
            outcome.to_string(),
            reason,
            backup_id,
            manifest_sha256,
            file_count,
            total_bytes,
            updated_at.to_string(),
        );
        let current = (
            handoff.ack_state.clone(),
            handoff.outcome.clone(),
            handoff.reason.clone(),
            handoff.backup_id.clone(),
            handoff.manifest_sha256.clone(),
            handoff.file_count,
            handoff.total_bytes,
            handoff.updated_at.clone(),
        );
        if current == next {
            return false;
        }
        (
            handoff.ack_state,
            handoff.outcome,
            handoff.reason,
            handoff.backup_id,
            handoff.manifest_sha256,
            handoff.file_count,
            handoff.total_bytes,
            handoff.updated_at,
        ) = next;
        true
    }

    pub fn mark_handoff_ack_done(&mut self, key: &str, updated_at: &str) -> bool {
        let Some(handoff) = self.handoffs.get_mut(key) else {
            return false;
        };
        if handoff.ack_state == "done" && handoff.updated_at == updated_at {
            return false;
        }
        handoff.ack_state = "done".to_string();
        handoff.updated_at = updated_at.to_string();
        true
    }

    pub fn mark_handoff_notified(&mut self, key: &str, state: &str) -> bool {
        let Some(handoff) = self.handoffs.get_mut(key) else {
            return false;
        };
        if handoff.notified_state == state {
            return false;
        }
        handoff.notified_state = state.to_string();
        true
    }

    pub fn handoff(&self, key: &str) -> Option<&StoredTaskHandoff> {
        self.handoffs.get(key)
    }

    pub fn pending_handoff_acks(&self, local_id: &str) -> Vec<(String, StoredTaskHandoff)> {
        self.handoffs
            .iter()
            .filter(|(_, handoff)| {
                handoff.local_id == local_id
                    && handoff.ack_state == "pending"
                    && !handoff.outcome.is_empty()
            })
            .map(|(key, handoff)| (key.clone(), handoff.clone()))
            .collect()
    }

    pub fn pending_handoff_notices(&self) -> Vec<HandoffNotice> {
        self.handoffs
            .values()
            .filter_map(StoredTaskHandoff::notice)
            .collect()
    }

    pub fn set_lease(&mut self, execution_task_key: &str, lease: StoredTaskLease) -> bool {
        if self.leases.get(execution_task_key) == Some(&lease) {
            return false;
        }
        self.leases.insert(execution_task_key.to_string(), lease);
        true
    }

    pub fn remove_lease(&mut self, execution_task_key: &str) -> bool {
        self.leases.remove(execution_task_key).is_some()
    }

    pub fn update_task_version(&mut self, execution_task_key: &str, task_version: u64) -> bool {
        let Some(control) = self.controls.get_mut(execution_task_key) else {
            return false;
        };
        if task_version <= control.task_version {
            return false;
        }
        control.task_version = task_version;
        true
    }

    pub fn controls_for_binding<'a>(
        &'a self,
        local_id: &'a str,
        task_space_id: &'a str,
    ) -> impl Iterator<Item = (&'a String, &'a StoredTaskControl)> + 'a {
        self.controls.iter().filter(move |(_, control)| {
            control.local_id == local_id && control.task_space_id == task_space_id
        })
    }

    pub fn execution_task_key_for_dir(
        &self,
        local_id: &str,
        task_space_id: &str,
        relative_dir: &str,
    ) -> Option<&String> {
        self.controls
            .iter()
            .find_map(|(execution_task_key, control)| {
                (control.local_id == local_id
                    && control.task_space_id == task_space_id
                    && control.relative_dir == relative_dir)
                    .then_some(execution_task_key)
            })
    }
}

pub fn parse_state_file(raw: &str) -> TaskControlStateFile {
    let parsed = serde_json::from_str::<TaskControlStateFile>(raw).unwrap_or_else(|_| {
        TaskControlStateFile {
            schema_version: 0,
            ..TaskControlStateFile::empty()
        }
    });
    if parsed.schema_version != TASK_CONTROL_STATE_VERSION {
        // 损坏或未知版本必须回退为空状态，不能让旧 lease/taskVersion 参与写入门禁。
        return TaskControlStateFile::empty();
    }
    parsed
}

pub fn selected_server_task_ids(controls: Option<&[TaskControl]>) -> Option<BTreeSet<String>> {
    controls.map(|items| {
        items
            .iter()
            .filter(|control| control.is_writable_local())
            .map(|control| control.task_id.clone())
            .collect()
    })
}

fn execution_key_task_space_id(execution_task_key: &str) -> AgentResult<String> {
    let Some((task_space_id, task_id)) = execution_task_key.split_once("::") else {
        return protocol::err(code::INVALID_RESPONSE, "任务执行身份格式无效");
    };
    if task_space_id.is_empty() || task_id.is_empty() || task_id.contains("::") {
        return protocol::err(code::INVALID_RESPONSE, "任务执行身份格式无效");
    }
    Ok(task_space_id.to_string())
}

fn required_text(value: &Value, key: &str, message: &str) -> AgentResult<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| protocol::AgentError::new(code::INVALID_RESPONSE, message))
}

fn optional_text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_nonempty_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests;
