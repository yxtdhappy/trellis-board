use super::*;
use serde_json::json;

fn scoped(kind: &str) -> Value {
    json!({
        "type": kind,
        "projectName": "trellis-board",
        "branchName": "main",
    })
}

#[test]
fn handoff_notification_only_covers_terminal_outcomes() {
    assert_eq!(handoff_notification(&json!({ "outcome": "", "taskId": "task-a" })), None);
    assert_eq!(
        handoff_notification(&json!({
            "outcome": "cleaned",
            "taskId": "e2e-handoff-1",
            "reason": null
        })),
        Some((
            "任务已被认领，本地副本已清理",
            "e2e-handoff-1".to_string()
        ))
    );
    assert_eq!(
        handoff_notification(&json!({
            "outcome": "conflict",
            "taskId": "e2e-handoff-2",
            "reason": "lease_active"
        })),
        Some((
            "任务已被认领，本地副本需保留",
            "e2e-handoff-2 · 任务仍有其他客户端持有写租约，暂未清理".to_string()
        ))
    );
}

#[test]
fn review_notification_counts_differences() {
    let mut control = scoped("initial_sync_review");
    control["differences"] = json!([{ "type": "local-only" }, { "type": "content-conflict" }]);
    assert_eq!(
        control_notification(&control),
        (
            "有任务差异需要确认".to_string(),
            "trellis-board（main）：2 个任务存在差异，打开客户端逐项处理。".to_string()
        )
    );
}

#[test]
fn conflict_notification_names_the_task_dir() {
    let mut control = scoped("task_file_conflict");
    control["conflict"] = json!({ "taskDir": ".trellis/tasks/11-19-a" });
    assert_eq!(
        control_notification(&control),
        (
            "任务文件冲突".to_string(),
            "trellis-board（main）：.trellis/tasks/11-19-a 被同时修改，打开客户端选择保留哪一份。"
                .to_string()
        )
    );
}

#[test]
fn ownership_notification_counts_items() {
    let mut control = scoped("task_ownership_review");
    control["items"] = json!([{ "taskDir": "a" }]);
    assert_eq!(
        control_notification(&control).1,
        "trellis-board（main）：1 个任务需要确认开发分支。"
    );
}

#[test]
fn sync_error_notification_prefers_message_over_error() {
    let mut control = scoped("task_sync_error");
    control["message"] = json!("上传失败");
    control["error"] = json!("UPLOAD_FAILED");
    assert_eq!(
        control_notification(&control),
        (
            "任务同步失败".to_string(),
            "trellis-board（main）：上传失败".to_string()
        )
    );
    control.as_object_mut().unwrap().remove("message");
    assert_eq!(
        control_notification(&control).1,
        "trellis-board（main）：UPLOAD_FAILED"
    );
}

#[test]
fn unknown_type_falls_back_to_generic_body() {
    let control = scoped("something_new");
    assert_eq!(
        control_notification(&control),
        (
            "Trellis Board 有新的同步事件".to_string(),
            "trellis-board（main）：打开客户端查看任务同步情况。".to_string()
        )
    );
}

#[test]
fn missing_project_omits_the_scope_prefix() {
    let control = json!({
        "type": "initial_sync_review",
        "differences": [{ "type": "local-only" }],
    });
    let (_, body) = control_notification(&control);
    assert_eq!(body, "1 个任务存在差异，打开客户端逐项处理。");
    assert!(!body.contains('：'));
    assert!(!body.starts_with('（'));
}
