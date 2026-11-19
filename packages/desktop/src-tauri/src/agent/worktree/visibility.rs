use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use crate::agent::http::ApiClient;
use crate::agent::protocol::{code, AgentError, AgentResult};

const VISIBILITY_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn server_active_task_count(api: &ApiClient, task_space_id: &str) -> AgentResult<usize> {
    let value = api
        .request_json(
            Method::GET,
            &format!("/api/agent/task-spaces/{task_space_id}/tasks"),
            None,
            VISIBILITY_QUERY_TIMEOUT,
        )
        .await?;
    let tasks = value
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "任务列表响应缺少 tasks 数组"))?;
    Ok(tasks
        .iter()
        .filter(|task| {
            task.get("archived")
                .and_then(Value::as_bool)
                .map(|archived| !archived)
                .unwrap_or(true)
        })
        .count())
}
