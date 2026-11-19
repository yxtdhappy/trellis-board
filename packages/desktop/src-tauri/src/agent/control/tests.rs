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
    assert_eq!(hub.push_with_change(review(3, "first")), (true, true));
    assert_eq!(hub.push_with_change(review(3, "second")), (false, true));
    assert_eq!(hub.push_with_change(review(3, "second")), (false, false));
    assert_eq!(hub.len(), 1);
    let front = hub.pending().expect("pending");
    assert_eq!(front["message"], json!("second"));
}

#[test]
fn reports_actual_queue_changes() {
    let hub = hub();
    assert!(hub.dismiss_with_change().is_err());
    hub.push(review(1, "one"));
    assert!(hub.dismiss_with_change().expect("dismiss"));
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
    assert!(hub.resume());
    assert!(!hub.resume());
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

fn review_with_diff(revision: i64, task_dir: &str) -> Value {
    json!({
        "type": "initial_sync_review",
        "taskSpaceId": "ts-1",
        "revision": revision,
        "differences": [{ "type": "local-only", "taskDir": task_dir }]
    })
}

#[test]
fn dismissed_review_stays_hidden_until_its_content_changes() {
    let hub = hub();
    hub.push(review_with_diff(3, ".trellis/tasks/a"));
    assert!(hub.dismiss_with_change().expect("dismiss"));
    // 同一批差异换了个 revision：仍然不打扰，这正是「稍后处理」要的效果。
    assert_eq!(
        hub.push_with_change(review_with_diff(4, ".trellis/tasks/a")),
        (false, false)
    );
    assert!(hub.is_empty());
    // 差异内容变了：重新提示。
    assert_eq!(
        hub.push_with_change(review_with_diff(5, ".trellis/tasks/b")),
        (true, true)
    );
    let front = hub.pending().expect("pending");
    assert_eq!(front["revision"], json!(5));
}

#[test]
fn reveal_puts_the_dismissed_review_back() {
    let hub = hub();
    hub.push(review_with_diff(3, ".trellis/tasks/a"));
    assert!(hub.dismiss_with_change().expect("dismiss"));
    assert_eq!(hub.reveal_dismissed(), 1);
    let front = hub.pending().expect("pending");
    assert_eq!(front["revision"], json!(3));
    // 已经放回队列，再唤回一次不应重复入队。
    assert_eq!(hub.reveal_dismissed(), 0);
    assert_eq!(hub.len(), 1);
}

#[test]
fn cleared_memory_stops_suppressing_repeats() {
    let hub = hub();
    hub.push(review_with_diff(3, ".trellis/tasks/a"));
    assert!(hub.dismiss_with_change().expect("dismiss"));
    hub.clear_dismissed();
    assert_eq!(
        hub.push_with_change(review_with_diff(3, ".trellis/tasks/a")),
        (true, true)
    );
}
