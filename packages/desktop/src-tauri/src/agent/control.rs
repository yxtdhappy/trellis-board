use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use serde_json::Value;

use crate::agent::protocol::{code, AgentError, AgentResult};

const MAX_PENDING_CONTROLS: usize = 32;

/// `initial_sync_review` 的内容指纹：不含 revision，差异没变就不该再次弹出。
fn review_signature(control: &Value) -> Option<(String, String)> {
    if control.get("type").and_then(Value::as_str) != Some("initial_sync_review") {
        return None;
    }
    let task_space_id = control_text(control, "/taskSpaceId").to_string();
    let differences = serde_json::to_string(control.get("differences").unwrap_or(&Value::Null))
        .unwrap_or_default();
    Some((task_space_id, differences))
}

fn control_text<'a>(control: &'a Value, pointer: &str) -> &'a str {
    control
        .pointer(pointer)
        .and_then(Value::as_str)
        .unwrap_or("")
}

pub fn control_key(control: &Value) -> String {
    match control.get("type").and_then(Value::as_str) {
        Some("initial_sync_review") => format!(
            "initial_sync_review\0{}\0{}",
            control_text(control, "/taskSpaceId"),
            control.get("revision").and_then(Value::as_i64).unwrap_or(0)
        ),
        Some("task_file_conflict") => format!(
            "task_file_conflict\0{}\0{}",
            control_text(control, "/taskSpaceId"),
            control_text(control, "/conflict/conflictId")
        ),
        _ => {
            if let Some(kind) = control.get("type").and_then(Value::as_str) {
                let id = [
                    control_text(control, "/taskSpaceId"),
                    control_text(control, "/conflict/conflictId"),
                    control_text(control, "/error"),
                ]
                .into_iter()
                .find(|value| !value.is_empty())
                .unwrap_or("");
                format!("{kind}\0{id}")
            } else {
                format!("control\0{control}")
            }
        }
    }
}

pub fn control_is_stale(control: &Value, now_ms: u128) -> bool {
    control
        .get("expiresAtEpochMs")
        .and_then(Value::as_u64)
        .is_some_and(|expires_at| u128::from(expires_at) <= now_ms)
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Value>,
    suppressed: bool,
    /// 「稍后处理」过的差异审查：同内容不再自动入队，直到内容变化或用户主动唤回。
    dismissed_reviews: HashMap<String, (String, Value)>,
}

/// 进程内控制事件队列：替代原先 sidecar stdout 的 `{"control":...}` 行协议。
pub struct ControlHub {
    inner: Mutex<Inner>,
}

impl ControlHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::default(),
        }
    }

    /// 入队并去重（同 key 覆盖旧值），返回是否成为队首。
    #[cfg(test)]
    pub fn push(&self, control: Value) -> bool {
        self.push_with_change(control).0
    }

    /// 返回（是否成为队首，队列内容是否实际变化）。
    pub fn push_with_change(&self, control: Value) -> (bool, bool) {
        let Ok(mut inner) = self.inner.lock() else {
            return (false, false);
        };
        if inner.suppressed {
            return (false, false);
        }
        if let Some((task_space_id, signature)) = review_signature(&control) {
            if inner
                .dismissed_reviews
                .get(&task_space_id)
                .is_some_and(|(dismissed, _)| *dismissed == signature)
            {
                return (false, false);
            }
        }
        let key = control_key(&control);
        if let Some(existing) = inner.queue.iter_mut().find(|item| control_key(item) == key) {
            let changed = *existing != control;
            *existing = control;
            return (false, changed);
        }
        if inner.queue.len() >= MAX_PENDING_CONTROLS {
            inner.queue.pop_front();
        }
        let was_empty = inner.queue.is_empty();
        inner.queue.push_back(control);
        (was_empty, true)
    }

    pub fn pending(&self) -> Option<Value> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0);
        let Ok(mut inner) = self.inner.lock() else {
            return None;
        };
        while let Some(front) = inner.queue.front() {
            if control_is_stale(front, now_ms) {
                inner.queue.pop_front();
                continue;
            }
            return Some(front.clone());
        }
        None
    }

    #[cfg(test)]
    pub fn dismiss(&self) -> AgentResult<()> {
        self.dismiss_with_change().map(|_| ())
    }

    pub fn dismiss_with_change(&self) -> AgentResult<bool> {
        let Ok(mut inner) = self.inner.lock() else {
            return Err(AgentError::new(code::LOCKED, "无法访问控制事件队列"));
        };
        let Some(control) = inner.queue.pop_front() else {
            return Err(AgentError::new(
                code::COMMAND_INVALID,
                "没有待处理的实时确认",
            ));
        };
        if let Some((task_space_id, signature)) = review_signature(&control) {
            inner
                .dismissed_reviews
                .insert(task_space_id, (signature, control));
        }
        Ok(true)
    }

    /// 用户主动要求查看差异：把「稍后处理」过的事件放回队首，立即重新露出。
    pub fn reveal_dismissed(&self) -> usize {
        let Ok(mut inner) = self.inner.lock() else {
            return 0;
        };
        let dismissed: Vec<Value> = inner
            .dismissed_reviews
            .drain()
            .map(|(_, (_, control))| control)
            .collect();
        for control in &dismissed {
            inner.queue.push_front(control.clone());
        }
        dismissed.len()
    }

    /// 差异已经处理完（首同步完成）：忘掉忽略记忆，后续同内容也应重新提示。
    pub fn clear_dismissed(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.dismissed_reviews.clear();
        }
    }

    #[cfg(test)]
    pub fn suppress(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.suppressed = true;
        }
    }

    pub fn resume(&self) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            let changed = inner.suppressed;
            inner.suppressed = false;
            return changed;
        }
        false
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.queue.len())
            .unwrap_or(0)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests;
