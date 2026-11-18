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
