use std::collections::VecDeque;
use std::sync::Mutex;

use serde_json::Value;

use crate::agent::protocol::{code, AgentError, AgentResult};

const MAX_PENDING_CONTROLS: usize = 32;

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
        if inner.queue.pop_front().is_none() {
            return Err(AgentError::new(
                code::COMMAND_INVALID,
                "没有待处理的实时确认",
            ));
        }
        Ok(true)
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
