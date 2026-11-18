use super::*;

pub(crate) fn is_branch_guard_code(value: &str) -> bool {
    BRANCH_GUARD_CODES.contains(&value)
}
pub(super) fn is_branch_guard_error(error: &AgentError) -> bool {
    is_branch_guard_code(&error.code)
}
pub(super) fn task_sync_error_event(
    binding: Option<&AgentBinding>,
    task_space_id: &str,
    error: &AgentError,
    message: String,
) -> Value {
    let mut event = json!({
        "type": "task_sync_error",
        "taskSpaceId": task_space_id,
        "code": error.code.clone(),
        "message": message,
    });
    if let Some(binding) = binding {
        event["projectName"] = Value::String(binding.display_name.clone());
        event["branchName"] = Value::String(binding.branch_name.clone());
    }
    if let Some(task_dir) = error
        .details
        .as_ref()
        .and_then(|details| details.get("taskDir"))
        .and_then(Value::as_str)
    {
        event["taskDir"] = Value::String(task_dir.to_string());
    }
    event["errorCode"] = Value::String(error.code.clone());
    if let Some(server_code) = &error.server_code {
        event["serverCode"] = Value::String(server_code.clone());
    }
    event
}
/// 只补 taskDir，保留服务端错误码/状态，便于上层按目录定位失败原因。
pub(super) fn with_task_dir(mut error: AgentError, task_dir: &str) -> AgentError {
    match &mut error.details {
        Some(details) => {
            if details.get("taskDir").is_none() && details.is_object() {
                details["taskDir"] = Value::String(task_dir.to_string());
            }
        }
        None => {
            error.details = Some(json!({ "taskDir": task_dir }));
        }
    }
    error
}
/// 服务端 409 会给出可用的最小 clientSequence；只在 CONFLICT 且为正整数时采纳。
pub(super) fn required_client_sequence(error: &AgentError) -> Option<u64> {
    if error.server_code.as_deref() != Some("CONFLICT") {
        return None;
    }
    error
        .details
        .as_ref()?
        .get("requiredClientSequence")?
        .as_u64()
        .filter(|value| *value > 0)
}
pub(super) fn is_explicit_pending_rejection(value: &str) -> bool {
    matches!(
        value,
        "TASK_OWNERSHIP_REQUIRED"
            | "TASK_OWNERSHIP_MISMATCH"
            | "TASK_MERGE_EVIDENCE_REQUIRED"
            | "TASK_MERGE_EVIDENCE_INVALID"
            | "TASK_OWNED_BY_BASELINE"
    )
}
pub(super) fn skipped_for_explicit_pending_rejection(uploaded: &Value) -> bool {
    uploaded.get("skipped").and_then(Value::as_bool) == Some(true)
        && uploaded
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(is_explicit_pending_rejection)
}
pub(super) fn sync_trace(task_space_id: &str, phase: &str, started: Instant, details: Value) {
    if std::env::var_os(SYNC_TRACE_ENV).is_none()
        && std::env::var_os("TRELLIS_DESKTOP_HTTP_TRACE").is_none()
    {
        return;
    }
    crate::logging::warn(&format!(
        "任务同步阶段 {{\"taskSpaceId\":\"{}\",\"phase\":\"{}\",\"elapsedMs\":{},\"details\":{}}}",
        task_space_id,
        phase,
        started.elapsed().as_millis(),
        details
    ));
}
pub(super) fn is_foreign_task_error(error: &AgentError) -> bool {
    if matches!(
        error.code.as_str(),
        code::AUTH_REVOKED | code::DESKTOP_TOKEN_INVALID
    ) {
        return false;
    }
    matches!(
        error.server_code.as_deref(),
        Some("TASK_WRITE_FORBIDDEN") | Some("FORBIDDEN")
    ) || error.status == Some(403)
}
pub(super) fn is_archived_task_error(error: &AgentError) -> bool {
    matches!(
        error.server_code.as_deref(),
        Some("TASK_ARCHIVED") | Some("ARCHIVE_SYNC_SERVER_MANAGED")
    )
}
pub(super) fn io_error(error: std::io::Error) -> AgentError {
    AgentError::new(code::INVALID_RESPONSE, format!("任务文件写入失败: {error}"))
}
