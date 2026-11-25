use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

pub const AGENT_PROTOCOL_VERSION: u32 = 3;
pub const LISTENER_REPORT_VERSION: u32 = 1;
pub const AGENT_VERSION: &str = "0.1.0";

pub mod code {
    pub const AUTH_REVOKED: &str = "AUTH_REVOKED";
    pub const DESKTOP_TOKEN_INVALID: &str = "DESKTOP_TOKEN_INVALID";
    pub const PROTOCOL_INCOMPATIBLE: &str = "PROTOCOL_INCOMPATIBLE";
    pub const NETWORK_ERROR: &str = "NETWORK_ERROR";
    pub const HTTP_ERROR: &str = "HTTP_ERROR";
    pub const INVALID_RESPONSE: &str = "INVALID_RESPONSE";
    pub const CONFIG_MISSING: &str = "CONFIG_MISSING";
    pub const CONFIG_INVALID: &str = "CONFIG_INVALID";
    pub const CREDENTIAL_MISSING: &str = "CREDENTIAL_MISSING";
    pub const CREDENTIAL_CORRUPT: &str = "CREDENTIAL_CORRUPT";
    pub const DPAPI_UNAVAILABLE: &str = "DPAPI_UNAVAILABLE";
    pub const DPAPI_FAILED: &str = "DPAPI_FAILED";
    pub const LOCKED: &str = "LOCKED";
    pub const CA_FILE_INVALID: &str = "CA_FILE_INVALID";
    pub const REPO_NOT_FOUND: &str = "REPO_NOT_FOUND";
    pub const REPO_PATH_INVALID: &str = "REPO_PATH_INVALID";
    pub const NOT_GIT_REPOSITORY: &str = "NOT_GIT_REPOSITORY";
    pub const MISSING_TRELLIS: &str = "MISSING_TRELLIS";
    pub const KIT_APPLY_FAILED: &str = "TRELLIS_KIT_APPLY_FAILED";
    pub const SPARSE_CHECKOUT: &str = "SPARSE_CHECKOUT";
    pub const REMOTE_MISSING: &str = "REMOTE_MISSING";
    pub const REMOTE_INVALID: &str = "REMOTE_INVALID";
    pub const REMOTE_MISMATCH: &str = "REMOTE_MISMATCH";
    pub const BRANCH_INVALID: &str = "BRANCH_INVALID";
    pub const BRANCH_MISMATCH: &str = "BRANCH_MISMATCH";
    pub const DETACHED_HEAD: &str = "DETACHED_HEAD";
    pub const LOCAL_DIRTY: &str = "LOCAL_DIRTY";
    pub const LOCAL_AHEAD: &str = "LOCAL_AHEAD";
    pub const NO_FAST_FORWARD: &str = "NO_FAST_FORWARD";
    pub const REMOTE_UNREACHABLE: &str = "REMOTE_UNREACHABLE";
    pub const FETCH_FAILED: &str = "FETCH_FAILED";
    pub const MERGE_FAILED: &str = "MERGE_FAILED";
    pub const IGNORED_FILE_CONFLICT: &str = "IGNORED_FILE_CONFLICT";
    pub const GIT_TIMEOUT: &str = "GIT_TIMEOUT";
    pub const GIT_FAILED: &str = "GIT_FAILED";
    pub const COMMAND_INVALID: &str = "COMMAND_INVALID";
    pub const BINDING_UNKNOWN: &str = "BINDING_UNKNOWN";
    pub const BINDING_NOT_APPROVED: &str = "BINDING_NOT_APPROVED";
}

#[derive(Debug, Clone)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub terminal: bool,
    pub status: Option<u16>,
    pub server_code: Option<String>,
    pub retry_after_ms: Option<u64>,
    pub conflict_id: Option<String>,
    pub details: Option<Value>,
}

impl AgentError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable: false,
            terminal: false,
            status: None,
            server_code: None,
            retry_after_ms: None,
            conflict_id: None,
            details: None,
        }
    }

    pub fn retryable(mut self, value: bool) -> Self {
        self.retryable = value;
        self
    }

    pub fn terminal(mut self, value: bool) -> Self {
        self.terminal = value;
        self
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn with_server_code(mut self, value: Option<String>) -> Self {
        self.server_code = value;
        self
    }

    pub fn with_conflict(mut self, value: Option<String>) -> Self {
        self.conflict_id = value;
        self
    }

    pub fn with_details(mut self, value: Option<Value>) -> Self {
        self.details = value;
        self
    }
}

impl fmt::Display for AgentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AgentError {}

pub type AgentResult<T> = Result<T, AgentError>;

pub fn err<T>(code: &str, message: impl Into<String>) -> AgentResult<T> {
    Err(AgentError::new(code, message))
}

pub(crate) fn is_safe_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_alphanumeric()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn assert_safe_id(value: Option<&str>, field: &str, code: &str) -> AgentResult<String> {
    match value {
        Some(text) if is_safe_id(text) => Ok(text.to_string()),
        _ => err(code, format!("{field} 格式无效")),
    }
}

pub fn assert_safe_id_default(value: Option<&str>, field: &str) -> AgentResult<String> {
    assert_safe_id(value, field, code::INVALID_RESPONSE)
}

const RESERVED_FIRST_SEGMENTS: [&str; 4] = ["api", "client-updates", "plugin-ui", "assets"];
const RESERVED_PAGE_ENDINGS: [&str; 5] = [
    "login",
    "login.html",
    "admin.html",
    "index.html",
    "share.html",
];

fn normalize_agent_subpath(raw_path: &str) -> AgentResult<String> {
    if raw_path.is_empty() || raw_path == "/" {
        return Ok(String::new());
    }
    if raw_path.contains("//")
        || raw_path.contains('\\')
        || raw_path
            .chars()
            .any(|ch| (ch as u32) <= 0x20 || ch == '\u{7f}')
    {
        return err(code::CONFIG_INVALID, "Agent 服务地址路径包含非法字符");
    }
    let trimmed = raw_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let body = trimmed.strip_prefix('/').unwrap_or(trimmed);
    let segments: Vec<&str> = body.split('/').collect();
    for segment in &segments {
        let valid = !segment.is_empty()
            && *segment != "."
            && *segment != ".."
            && segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'~')
            });
        if !valid {
            return err(code::CONFIG_INVALID, "Agent 服务地址路径段格式无效");
        }
    }
    if RESERVED_FIRST_SEGMENTS
        .iter()
        .any(|reserved| segments[0].eq_ignore_ascii_case(reserved))
    {
        return err(code::CONFIG_INVALID, "Agent 服务地址不能使用保留路径前缀");
    }
    if let Some(last) = segments.last() {
        if RESERVED_PAGE_ENDINGS
            .iter()
            .any(|ending| last.eq_ignore_ascii_case(ending))
        {
            return err(
                code::CONFIG_INVALID,
                "Agent 服务地址请填写服务根路径，不要包含页面文件名",
            );
        }
    }
    Ok(format!("/{}", segments.join("/")))
}

fn format_origin(parsed: &url::Url) -> AgentResult<String> {
    let host = parsed
        .host_str()
        .ok_or_else(|| AgentError::new(code::CONFIG_INVALID, "Agent 服务地址缺少主机"))?;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Ok(match parsed.port() {
        Some(port) => format!("{}://{}:{}", parsed.scheme(), host, port),
        None => format!("{}://{}", parsed.scheme(), host),
    })
}

pub fn normalize_server_url(input: &str) -> AgentResult<String> {
    let trimmed = input.trim();
    if crate::url_path::raw_path_has_dot_segments(trimmed) {
        return err(code::CONFIG_INVALID, "Agent 服务地址路径段格式无效");
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| AgentError::new(code::CONFIG_INVALID, "Agent 服务地址不是合法 URL"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return err(
            code::CONFIG_INVALID,
            "Agent 服务地址不能包含账号、查询或片段",
        );
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return err(
            code::CONFIG_INVALID,
            "Agent 服务地址不能包含账号、查询或片段",
        );
    }
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return err(code::CONFIG_INVALID, "Agent 服务地址只支持 HTTP 或 HTTPS"),
    }
    let origin = format_origin(&parsed)?;
    let subpath = normalize_agent_subpath(parsed.path())?;
    Ok(format!("{origin}{subpath}"))
}

pub fn server_origin(server_url: &str) -> AgentResult<String> {
    let normalized = normalize_server_url(server_url)?;
    let parsed = url::Url::parse(&normalized)
        .map_err(|_| AgentError::new(code::CONFIG_INVALID, "Agent 服务地址不是合法 URL"))?;
    format_origin(&parsed)
}

const RESERVED_BRANCH_NAMES: [&str; 5] = ["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "@"];

pub fn validate_branch_name_syntax(value: &str) -> AgentResult<String> {
    let branch = value;
    let invalid = branch.is_empty()
        || branch.len() > 255
        || branch.starts_with('-')
        || branch.starts_with("refs/")
        || RESERVED_BRANCH_NAMES.contains(&branch)
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("@{")
        || branch.contains("//")
        || branch.chars().any(|ch| {
            (ch as u32) <= 0x20
                || ch == '\u{7f}'
                || matches!(ch, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        });
    if invalid {
        return err(code::BRANCH_INVALID, "同步分支格式无效");
    }
    Ok(branch.to_string())
}

pub fn compare_versions(left: &str, right: &str) -> Option<i32> {
    fn parse(value: &str) -> Option<[u64; 3]> {
        let mut parts = value.split('.');
        let major = parts.next()?.parse::<u64>().ok()?;
        let minor = parts.next()?.parse::<u64>().ok()?;
        let patch = parts.next()?.parse::<u64>().ok()?;
        if parts.next().is_some() {
            return None;
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        {
            return None;
        }
        Some([major, minor, patch])
    }
    let a = parse(left)?;
    let b = parse(right)?;
    for index in 0..3 {
        if a[index] != b[index] {
            return Some(if a[index] < b[index] { -1 } else { 1 });
        }
    }
    Some(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollTeam {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollResponse {
    pub agent_id: String,
    pub credential: String,
    pub protocol_version: u32,
    pub username: Option<String>,
    pub team_id: Option<String>,
    pub teams: Vec<EnrollTeam>,
    pub allow_local_git_remotes: bool,
}

fn merged_body(payload: &Value) -> AgentResult<Map<String, Value>> {
    let object = payload
        .as_object()
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "响应不是对象"))?;
    let mut body = object.clone();
    if let Some(Value::Object(data)) = object.get("data") {
        for (key, value) in data {
            body.insert(key.clone(), value.clone());
        }
    }
    Ok(body)
}

fn string_field<'a>(body: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

pub fn parse_enroll_response(payload: &Value) -> AgentResult<EnrollResponse> {
    let body = merged_body(payload)?;
    let agent_id = assert_safe_id(
        string_field(&body, "agentId").or_else(|| string_field(&body, "deviceId")),
        "设备 ID",
        code::INVALID_RESPONSE,
    )?;
    let credential = string_field(&body, "credential")
        .or_else(|| string_field(&body, "agentCredential"))
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "配对响应缺少有效 Agent 凭证"))?;
    if credential.len() < 32 || credential.chars().any(char::is_whitespace) {
        return err(code::INVALID_RESPONSE, "配对响应缺少有效 Agent 凭证");
    }
    let username = match string_field(&body, "username") {
        Some(value) => {
            let trimmed = value.trim();
            let valid = (3..=64).contains(&trimmed.len())
                && trimmed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
            if !valid {
                return err(code::INVALID_RESPONSE, "配对响应包含无效用户名");
            }
            Some(trimmed.to_string())
        }
        None => None,
    };
    let team_id = match string_field(&body, "teamId") {
        Some(value) => Some(assert_safe_id_default(Some(value), "团队 ID")?),
        None => None,
    };
    let mut teams = Vec::new();
    if let Some(Value::Array(items)) = body.get("teams") {
        for item in items {
            let team = item
                .as_object()
                .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "配对响应包含无效团队"))?;
            let id = assert_safe_id_default(string_field(team, "id"), "团队 ID")?;
            let name = string_field(team, "name").unwrap_or("").trim().to_string();
            if name.is_empty() || name.chars().count() > 160 {
                return err(code::INVALID_RESPONSE, "配对响应包含无效团队名称");
            }
            let role = string_field(team, "role").map(|value| value.chars().take(32).collect());
            teams.push(EnrollTeam { id, name, role });
        }
    }
    let protocol_version = body
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(AGENT_PROTOCOL_VERSION);
    Ok(EnrollResponse {
        agent_id,
        credential: credential.to_string(),
        protocol_version,
        username,
        team_id,
        teams,
        allow_local_git_remotes: body.get("allowLocalGitRemotes") == Some(&Value::Bool(true)),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerBinding {
    pub id: Option<String>,
    pub task_space_id: String,
    pub project_id: Option<String>,
    pub team_id: Option<String>,
    pub local_repo_key: Option<String>,
    pub status: String,
    pub branch_name: Option<String>,
    pub baseline_branch: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    pub protocol_version: u32,
    pub compatible: bool,
    pub minimum_agent_version: Option<String>,
    pub bindings: Vec<ServerBinding>,
}

fn present_field<'a>(
    body: &'a Map<String, Value>,
    key: &str,
    alias: Option<&str>,
) -> Option<&'a Value> {
    match body.get(key) {
        Some(value) if !value.is_null() => Some(value),
        _ => alias
            .and_then(|alt| body.get(alt))
            .filter(|value| !value.is_null()),
    }
}

fn parse_binding_safe_id(
    body: &Map<String, Value>,
    key: &str,
    alias: Option<&str>,
    field: &str,
    allow_missing: bool,
) -> AgentResult<Option<String>> {
    match present_field(body, key, alias) {
        Some(value) => assert_safe_id_default(value.as_str(), field).map(Some),
        None if allow_missing => Ok(None),
        None => err(code::INVALID_RESPONSE, format!("{field} 格式无效")),
    }
}

fn parse_server_binding(value: &Value) -> AgentResult<ServerBinding> {
    let object = value
        .as_object()
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "心跳响应包含无效绑定"))?;
    let status = match object.get("status") {
        None | Some(Value::Null) => "pending".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(_) => return err(code::INVALID_RESPONSE, "心跳响应包含未知绑定状态"),
    };
    if !matches!(
        status.as_str(),
        "pending" | "approved" | "rejected" | "revoked" | "disabled"
    ) {
        return err(code::INVALID_RESPONSE, "心跳响应包含未知绑定状态");
    }
    // 服务端在 BINDING_UNKNOWN / REMOTE_MISMATCH 的 rejected 项中会省略 id/projectId/localRepoKey。
    let allow_missing_binding_meta = status == "rejected";
    let id = parse_binding_safe_id(
        object,
        "id",
        Some("bindingId"),
        "绑定 ID",
        allow_missing_binding_meta,
    )?;
    let task_space_id = assert_safe_id(
        string_field(object, "taskSpaceId").or_else(|| string_field(object, "task_space_id")),
        "任务空间 ID",
        code::INVALID_RESPONSE,
    )?;
    let project_id = parse_binding_safe_id(
        object,
        "projectId",
        Some("project_id"),
        "项目 ID",
        allow_missing_binding_meta,
    )?;
    let local_repo_key = match present_field(object, "localRepoKey", None) {
        Some(value) => match value.as_str() {
            Some(text) if is_sha256_hex(text) => Some(text.to_string()),
            _ => return err(code::INVALID_RESPONSE, "心跳响应包含无效本地仓库标识"),
        },
        None if allow_missing_binding_meta => None,
        None => return err(code::INVALID_RESPONSE, "心跳响应包含无效本地仓库标识"),
    };
    let team_id = match string_field(object, "teamId") {
        Some(value) => Some(assert_safe_id_default(Some(value), "团队 ID")?),
        None => None,
    };
    Ok(ServerBinding {
        id,
        task_space_id,
        project_id,
        team_id,
        local_repo_key,
        status,
        branch_name: string_field(object, "branchName").map(str::to_string),
        baseline_branch: string_field(object, "baselineBranch").map(str::to_string),
        error_code: string_field(object, "errorCode").map(str::to_string),
        error: string_field(object, "error").map(|value| value.chars().take(500).collect()),
        read_only: object.get("readOnly") == Some(&Value::Bool(true)),
    })
}

pub fn parse_heartbeat_response(payload: &Value) -> AgentResult<HeartbeatResponse> {
    let body = merged_body(payload)?;
    let protocol_version = body
        .get("protocolVersion")
        .or_else(|| body.get("serverProtocolVersion"))
        .or_else(|| {
            body.get("device")
                .and_then(|device| device.get("protocolVersion"))
        })
        .and_then(Value::as_u64)
        .ok_or_else(|| AgentError::new(code::INVALID_RESPONSE, "心跳响应缺少协议版本"))?;
    if protocol_version < 1 {
        return err(code::INVALID_RESPONSE, "心跳响应缺少协议版本");
    }
    let compatible = body.get("compatible") != Some(&Value::Bool(false))
        && body.get("protocolVersionCompatible") != Some(&Value::Bool(false))
        && protocol_version == AGENT_PROTOCOL_VERSION as u64;
    let minimum_agent_version = string_field(&body, "minimumAgentVersion")
        .or_else(|| string_field(&body, "minimumVersion"))
        .map(str::to_string);
    let raw_bindings = match body.get("bindings") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) => items.as_slice(),
        Some(_) => return err(code::INVALID_RESPONSE, "心跳响应绑定列表无效"),
    };
    let mut bindings = Vec::with_capacity(raw_bindings.len());
    for item in raw_bindings {
        bindings.push(parse_server_binding(item)?);
    }
    Ok(HeartbeatResponse {
        protocol_version: protocol_version as u32,
        compatible,
        minimum_agent_version,
        bindings,
    })
}

pub const COMMAND_CREATE_TASK: &str = "create_task";
pub const COMMAND_ASSIGN_TASK: &str = "assign_task";
pub const COMMAND_SYNC_BRANCH: &str = "sync_branch";
pub const COMMAND_REFRESH_STATUS: &str = "refresh_status";

pub const COMMAND_TYPES: [&str; 4] = [
    COMMAND_CREATE_TASK,
    COMMAND_ASSIGN_TASK,
    COMMAND_SYNC_BRANCH,
    COMMAND_REFRESH_STATUS,
];

pub const COMMAND_RESULT_SUCCEEDED: &str = "succeeded";
pub const COMMAND_RESULT_FAILED: &str = "failed";

const ALLOWED_PAYLOAD_KEYS: [&str; 18] = [
    "taskSpaceId",
    "projectId",
    "branchName",
    "taskId",
    "title",
    "description",
    "priority",
    "slug",
    "assigneeUserId",
    "assigneeDevId",
    "executionTaskKey",
    "taskKey",
    "relativeDir",
    "baseTaskVersion",
    "baseTaskSha256",
    "taskVersion",
    "protocolVersion",
    "reason",
];

#[derive(Debug, Clone)]
pub struct AgentCommand {
    pub id: String,
    pub binding_id: String,
    pub kind: String,
    pub payload: Value,
}

impl AgentCommand {
    pub fn payload_str(&self, key: &str) -> Option<&str> {
        self.payload.get(key).and_then(Value::as_str)
    }

    pub fn requires(&self, key: &str) -> AgentResult<&str> {
        self.payload_str(key)
            .ok_or_else(|| AgentError::new(code::COMMAND_INVALID, format!("命令缺少字段 {key}")))
    }
}

pub fn validate_command(value: &Value) -> AgentResult<AgentCommand> {
    let object = value
        .as_object()
        .ok_or_else(|| AgentError::new(code::COMMAND_INVALID, "服务端返回了无效命令"))?;
    let id = assert_safe_id(string_field(object, "id"), "命令 ID", code::COMMAND_INVALID)?;
    let binding_id = assert_safe_id(
        string_field(object, "bindingId"),
        "绑定 ID",
        code::COMMAND_INVALID,
    )?;
    let kind = string_field(object, "type").unwrap_or("").to_string();
    if !COMMAND_TYPES.contains(&kind.as_str()) {
        return err(code::COMMAND_INVALID, "服务端返回了未授权命令类型");
    }
    let payload = match object.get("payload") {
        None | Some(Value::Null) => json!({}),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(_) => return err(code::COMMAND_INVALID, "命令载荷格式无效"),
    };
    let payload_map = payload.as_object().expect("payload is object");
    for key in payload_map.keys() {
        if !ALLOWED_PAYLOAD_KEYS.contains(&key.as_str()) {
            return err(code::COMMAND_INVALID, "命令载荷包含未允许字段");
        }
    }
    for (key, label) in [
        ("taskSpaceId", "任务空间 ID"),
        ("projectId", "项目 ID"),
        ("assigneeUserId", "负责人用户 ID"),
    ] {
        if let Some(Value::String(text)) = payload_map.get(key) {
            assert_safe_id(Some(text), label, code::COMMAND_INVALID)?;
        } else if payload_map.get(key).is_some_and(|value| !value.is_null()) {
            return err(code::COMMAND_INVALID, format!("{label} 格式无效"));
        }
    }
    if payload_map
        .get("branchName")
        .is_some_and(|value| !value.is_null() && !value.is_string())
    {
        return err(code::COMMAND_INVALID, "命令分支格式无效");
    }
    let has_text = |key: &str| {
        payload_map
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    };
    if (kind == COMMAND_CREATE_TASK || kind == COMMAND_ASSIGN_TASK)
        && (!has_text("taskSpaceId") || !has_text("assigneeUserId"))
    {
        return err(code::COMMAND_INVALID, "任务命令缺少任务空间或负责人");
    }
    if kind == COMMAND_CREATE_TASK {
        let title = payload_map
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("");
        if title.trim().is_empty() || title.chars().count() > 200 {
            return err(code::COMMAND_INVALID, "创建任务命令标题无效");
        }
    }
    if kind == COMMAND_ASSIGN_TASK && !has_text("executionTaskKey") {
        return err(code::COMMAND_INVALID, "改派命令缺少任务身份");
    }
    if let Some(version) = payload_map.get("protocolVersion") {
        if version.as_u64() != Some(AGENT_PROTOCOL_VERSION as u64) {
            return err(code::COMMAND_INVALID, "命令协议版本格式无效");
        }
    }
    if let Some(reason) = payload_map.get("reason") {
        match reason.as_str() {
            Some(text) if text.chars().count() <= 100 => {}
            _ => return err(code::COMMAND_INVALID, "命令原因格式无效"),
        }
    }
    Ok(AgentCommand {
        id,
        binding_id,
        kind,
        payload,
    })
}

pub fn build_command_result(
    status: &str,
    result: Option<Value>,
    error: Option<&AgentError>,
) -> AgentResult<Value> {
    if !matches!(status, COMMAND_RESULT_SUCCEEDED | COMMAND_RESULT_FAILED) {
        return err(code::COMMAND_INVALID, "命令结果状态无效");
    }
    Ok(json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "agentVersion": AGENT_VERSION,
        "status": status,
        "result": result,
        "error": error.map(|failure| format!("{}: {}", failure.code, safe_error_message(&failure.message))),
    }))
}

pub fn safe_error_message(message: &str) -> String {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<[(regex::Regex, &'static str); 4]> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            (
                regex::Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/-]+=*").expect("bearer regex"),
                "Bearer [REDACTED]",
            ),
            (
                regex::Regex::new(r"((?i:https?|ssh)://)[^\s/@]+(?::[^\s/@]*)?@").expect("url regex"),
                "$1[REDACTED]@",
            ),
            (
                regex::Regex::new(r#"(?i)\b(password|pairingCode|credential|token)\b(\s*[=:]\s*|"\s*:\s*")[^\s,;"'}]+"#)
                    .expect("secret regex"),
                "$1=[REDACTED]",
            ),
            (
                regex::Regex::new(r#"\b[A-Za-z]:[\\/][^\s"'<>|]+"#).expect("path regex"),
                "[本地路径]",
            ),
        ]
    });
    let mut text = message.to_string();
    for (pattern, replacement) in patterns {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    text.chars().take(500).collect()
}

pub fn is_authentication_error(error: &AgentError) -> bool {
    error.code == code::AUTH_REVOKED
        || error.code == code::DESKTOP_TOKEN_INVALID
        || matches!(error.status, Some(401) | Some(403))
}

pub fn is_path_inside(parent: &Path, child: &Path) -> bool {
    let parent: PathBuf = parent.components().collect();
    let child: PathBuf = child.components().collect();
    child == parent || child.starts_with(&parent)
}

/// 只把跨端相对 taskDir 映射到当前客户端的任务根，不比较不同来源的绝对路径。
pub fn resolve_task_dir_under(tasks_root: &Path, task_dir: &str) -> Option<PathBuf> {
    let relative = task_dir.strip_prefix(".trellis/tasks/")?;
    if relative.is_empty()
        || task_dir.contains('\\')
        || task_dir.contains('\0')
        || task_dir.starts_with('/')
    {
        return None;
    }
    let mut target = tasks_root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains(':')
            || segment.ends_with(' ')
            || segment.ends_with('.')
            || segment.chars().any(char::is_control)
        {
            return None;
        }
        target.push(segment);
        if !is_path_inside(tasks_root, &target) {
            return None;
        }
    }
    (target != tasks_root).then_some(target)
}

pub fn now_iso8601() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests;
