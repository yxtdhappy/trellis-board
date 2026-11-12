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
    pub fn push(&self, control: Value) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.suppressed {
            return false;
        }
        let key = control_key(&control);
        if let Some(existing) = inner.queue.iter_mut().find(|item| control_key(item) == key) {
            *existing = control;
            return false;
        }
        if inner.queue.len() >= MAX_PENDING_CONTROLS {
            inner.queue.pop_front();
        }
        let was_empty = inner.queue.is_empty();
        inner.queue.push_back(control);
        was_empty
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

    pub fn dismiss(&self) -> AgentResult<()> {
        let Ok(mut inner) = self.inner.lock() else {
            return Err(AgentError::new(code::LOCKED, "无法访问控制事件队列"));
        };
        if inner.queue.pop_front().is_none() {
            return Err(AgentError::new(
                code::COMMAND_INVALID,
                "没有待处理的实时确认",
            ));
        }
        Ok(())
    }

    pub fn suppress(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.suppressed = true;
        }
    }

    pub fn resume(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.suppressed = false;
        }
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.queue.len())
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hub() -> ControlHub {
        ControlHub::new()
    }

    fn review(revision: i64, message: &str) -> Value {
        json!({
            "type": "initial_sync_review",
            "taskSpaceId": "ts-1",
            "revision": revision,
            "message": message
        })
    }

    #[test]
    fn dedupes_by_key_and_keeps_latest() {
        let hub = hub();
        assert!(hub.push(review(3, "first")));
        assert!(!hub.push(review(3, "second")));
        assert_eq!(hub.len(), 1);
        let front = hub.pending().expect("pending");
        assert_eq!(front["message"], json!("second"));
    }

    #[test]
    fn separates_revisions() {
        let hub = hub();
        hub.push(review(3, "a"));
        hub.push(review(4, "b"));
        assert_eq!(hub.len(), 2);
    }

    #[test]
    fn drops_expired_and_queues_in_order() {
        let hub = hub();
        hub.push(json!({
            "type": "task_sync_error",
            "error": "old",
            "expiresAtEpochMs": 1
        }));
        hub.push(json!({ "type": "task_sync_error", "error": "new" }));
        let front = hub.pending().expect("pending");
        assert_eq!(front["error"], json!("new"));
    }

    #[test]
    fn caps_queue_at_limit() {
        let hub = hub();
        for index in 0..40 {
            hub.push(json!({
                "type": "task_file_conflict",
                "taskSpaceId": "ts-1",
                "conflict": { "conflictId": format!("c-{index}") }
            }));
        }
        assert_eq!(hub.len(), MAX_PENDING_CONTROLS);
    }

    #[test]
    fn suppression_blocks_new_events_until_resumed() {
        let hub = hub();
        hub.suppress();
        hub.push(review(1, "blocked"));
        assert!(hub.is_empty());
        hub.resume();
        hub.push(review(2, "allowed"));
        assert_eq!(hub.len(), 1);
    }

    #[test]
    fn dismiss_requires_pending_event() {
        let hub = hub();
        assert!(hub.dismiss().is_err());
        hub.push(review(1, "one"));
        assert!(hub.dismiss().is_ok());
        assert!(hub.is_empty());
    }
}
