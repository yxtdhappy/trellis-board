//! 桌面设备注册与登录。
//! 来源 JS：`desktop/sidecar/desktop-device.js`（全文 690 行）与 `agent/api.js` 的端点定义。
//! Board 的登录/登出/撤销接口需要 origin、Cookie 和 Set-Cookie，`ApiClient` 不暴露这些能力，
//! 因此这里单独持有一个受控的 reqwest 客户端，只用于会话类请求。

use std::path::Path;
use std::time::Duration;

use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::agent::credential::CredentialStore;
use crate::agent::http::{bypass_proxy_for_server, ApiClient};
use crate::agent::protocol::{
    self, code, err, parse_enroll_response, parse_heartbeat_response, AgentError, AgentResult,
    AGENT_PROTOCOL_VERSION, AGENT_VERSION, LISTENER_REPORT_VERSION,
};
use crate::agent::store::{
    create_config_revision, AgentBinding, AgentConfig, AgentTeam, ConfigStore,
    CONFIG_SCHEMA_VERSION,
};
use crate::agent::task_sync::{self, TaskSync};

/// Board 的会话 Cookie 名称（对照 JS SESSION_COOKIE）。
const SESSION_COOKIE: &str = "trellis_team_session";
/// 会话类响应的上限（对照 JS MAX_RESPONSE_BYTES）。
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/// 登录结果：字段对照 JS loginDesktop 的返回值，缺失项不序列化。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLoginSummary {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub must_change_password: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_ready: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// completeDesktopEnrollment 的返回值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentSummary {
    pub agent_id: String,
    pub device_name: String,
    pub server_url: String,
    pub protocol_version: u32,
    pub username: Option<String>,
    pub teams: Vec<AgentTeam>,
}

/// 待上传本地任务（目录 + 本地 task.json 标题）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeferredTaskInfo {
    pub task_dir: String,
    pub title: Option<String>,
}

/// 本地关联列表项；字段与 `sidecar.rs` 的 LocalAssociation 一致（camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAssociation {
    pub project_id: String,
    #[serde(default)]
    pub task_space_id: String,
    pub repo_path: String,
    pub display_name: String,
    pub branch_name: String,
    pub team_id: Option<String>,
    pub status: String,
    #[serde(default)]
    pub detach_pending: bool,
    #[serde(default)]
    pub initial_review_pending: bool,
    pub read_only: bool,
    #[serde(default = "default_live_sync_status")]
    pub live_sync_status: String,
    pub live_sync_error: Option<String>,
    #[serde(default)]
    pub deferred_count: usize,
    #[serde(default)]
    pub deferred_task_dirs: Vec<String>,
    #[serde(default)]
    pub deferred_tasks: Vec<DeferredTaskInfo>,
    #[serde(default)]
    pub ownership_paused_count: usize,
    #[serde(default)]
    pub ownership_paused_task_dirs: Vec<String>,
    #[serde(default)]
    pub ownership_pending_count: usize,
    #[serde(default)]
    pub ownership_pending_task_dirs: Vec<String>,
    pub last_error_code: Option<String>,
    pub last_error: Option<String>,
}

fn default_live_sync_status() -> String {
    "pending".to_string()
}

/// loginRequest 的结果。
struct DesktopSession {
    session_token: String,
    expires_at: Option<String>,
    username: String,
    must_change_password: bool,
}

/// readRuntime 的结果。
struct RuntimeInfo {
    username: String,
    teams: Vec<AgentTeam>,
    allow_local_git_remotes: bool,
}

struct RawResponse {
    status: u16,
    set_cookies: Vec<String>,
    text: String,
}

impl RawResponse {
    /// 对照 JS parseResponseBody / response.body：解析失败视为没有 JSON。
    fn body(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
}

/// 会话类请求客户端（带 origin / cookie 头，可读取 Set-Cookie）。
struct SessionClient {
    server_url: String,
    http: reqwest::Client,
}

impl SessionClient {
    fn new(server_url: &str) -> AgentResult<Self> {
        let server_url = protocol::normalize_server_url(server_url)?;
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none());
        if bypass_proxy_for_server(&server_url) {
            builder = builder.no_proxy();
        }
        let http = builder.build().map_err(|error| {
            AgentError::new(code::HTTP_ERROR, format!("HTTP 客户端初始化失败：{error}"))
        })?;
        Ok(Self { server_url, http })
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, String)],
        body: Option<Value>,
    ) -> AgentResult<RawResponse> {
        let url = format!("{}{}", self.server_url, path);
        let mut request = self
            .http
            .request(method, url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(
                reqwest::header::USER_AGENT,
                format!("trellis-board-agent/{AGENT_VERSION}"),
            )
            .timeout(REQUEST_TIMEOUT);
        for (name, value) in headers {
            request = request.header(*name, value.as_str());
        }
        if let Some(body) = body {
            let payload = serde_json::to_vec(&body).map_err(|error| {
                AgentError::new(code::INVALID_RESPONSE, format!("请求体序列化失败：{error}"))
            })?;
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload);
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                return AgentError::new(code::NETWORK_ERROR, "Board 请求超时").retryable(true);
            }
            AgentError::new(
                code::NETWORK_ERROR,
                format!("无法连接 Board 服务端：{error}"),
            )
            .retryable(true)
        })?;
        let status = response.status().as_u16();
        let set_cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect();
        let bytes = response.bytes().await.map_err(|error| {
            AgentError::new(code::NETWORK_ERROR, format!("无法读取 Board 响应：{error}"))
                .retryable(true)
        })?;
        // ponytail: 与 JS 的边读边截断不同，这里读完后统一判断体积；会话响应很小，够用。
        if bytes.len() > MAX_RESPONSE_BYTES {
            return err(code::INVALID_RESPONSE, "Board 服务端响应过大");
        }
        Ok(RawResponse {
            status,
            set_cookies,
            text: String::from_utf8_lossy(&bytes).into_owned(),
        })
    }
}

// ---------------------------------------------------------------------------
// 校验函数（错误文案与 JS 完全一致）
// ---------------------------------------------------------------------------

/// 对照 JS validateDeviceName。
pub fn validate_device_name(value: &str) -> AgentResult<String> {
    let name = value.trim();
    if name.is_empty()
        || name.chars().count() > 80
        || name.chars().any(|ch| (ch as u32) <= 0x1f || ch == '\u{7f}')
    {
        return err(code::CONFIG_INVALID, "设备名格式无效");
    }
    Ok(name.to_string())
}

/// 对照 JS validateUsername：去空白 + 小写。
pub fn validate_username(value: &str) -> AgentResult<String> {
    let username = value.trim().to_lowercase();
    let valid = (3..=64).contains(&username.chars().count())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    if !valid {
        return err(code::CONFIG_INVALID, "登录名格式无效");
    }
    Ok(username)
}

/// 对照 JS validatePassword。
pub fn validate_password(value: &str) -> AgentResult<String> {
    if value.chars().count() < 6 {
        return err(code::CONFIG_INVALID, "密码至少需要 6 个字符");
    }
    if value.len() > 1024 {
        return err(code::CONFIG_INVALID, "密码不能超过 1024 字节");
    }
    Ok(value.to_string())
}

/// 对照 JS validateSessionToken（管理员会话 Cookie）。
pub fn validate_session_token(value: &str) -> AgentResult<String> {
    let token = value.trim();
    if !(16..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return err(code::CONFIG_INVALID, "管理员会话 Cookie 格式无效");
    }
    Ok(token.to_string())
}

/// 对照 JS validateEnrollToken。
pub fn validate_enroll_token(value: &str) -> AgentResult<String> {
    let token = value.trim();
    if !(32..=512).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return err(code::CONFIG_INVALID, "设备令牌格式无效");
    }
    Ok(token.to_string())
}

/// 对照 JS parseSessionCookie：Set-Cookie 里必须恰好有一个会话 Cookie。
pub fn parse_session_cookie(set_cookies: &[String]) -> AgentResult<String> {
    let mut matches: Vec<&str> = Vec::new();
    for row in set_cookies {
        let pair = row.split(';').next().unwrap_or("");
        let Some(separator) = pair.find('=') else {
            continue;
        };
        if pair[..separator].trim() != SESSION_COOKIE {
            continue;
        }
        matches.push(pair[separator + 1..].trim());
    }
    if matches.len() != 1 {
        let message = if matches.is_empty() {
            "Board 登录响应缺少会话 Cookie"
        } else {
            "Board 登录响应包含重复会话 Cookie"
        };
        return err(code::INVALID_RESPONSE, message);
    }
    validate_session_token(matches[0])
}

// ---------------------------------------------------------------------------
// 服务端交互
// ---------------------------------------------------------------------------

fn parse_response_body(text: &str) -> AgentResult<Value> {
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(text)
        .map_err(|_| AgentError::new(code::INVALID_RESPONSE, "Board 服务端返回了无效 JSON"))
}

/// 对照 JS responseError：优先使用服务端 error 字段。
fn response_error(response: &RawResponse, fallback: &str) -> AgentError {
    let body = response.body();
    let message = match body.get("error").and_then(Value::as_str) {
        Some(error) => error.chars().take(500).collect::<String>(),
        None => format!("{fallback}：HTTP {}", response.status),
    };
    AgentError::new(code::HTTP_ERROR, message)
}

/// Cookie 请求头。token 已通过字符集校验，等价于 JS 的 encodeURIComponent。
fn cookie_header(session_token: &str) -> String {
    format!("{SESSION_COOKIE}={session_token}")
}

fn normalize_teams(value: Option<&Value>) -> Vec<AgentTeam> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|team| {
            let object = team.as_object()?;
            let id = object.get("id").and_then(Value::as_str)?.trim();
            let name = object.get("name").and_then(Value::as_str)?.trim();
            if id.is_empty() || name.is_empty() || name.chars().count() > 160 {
                return None;
            }
            let role = object
                .get("role")
                .and_then(Value::as_str)
                .map(|role| role.chars().take(32).collect());
            Some(AgentTeam {
                id: id.to_string(),
                name: name.to_string(),
                role,
            })
        })
        .collect()
}

async fn login_request(
    client: &SessionClient,
    username: &str,
    password: &str,
) -> AgentResult<DesktopSession> {
    let response = client
        .request(
            Method::POST,
            "/api/auth/login",
            &[("origin", client.server_url.clone())],
            Some(json!({ "username": username, "password": password })),
        )
        .await?;
    if response.status != 200 {
        return Err(response_error(&response, "登录失败"));
    }
    let payload = parse_response_body(&response.text)?;
    let session_token = parse_session_cookie(&response.set_cookies)?;
    let user = match payload.get("user") {
        Some(Value::Object(user)) => user,
        _ => return err(code::INVALID_RESPONSE, "登录响应缺少用户信息"),
    };
    let username = validate_username(user.get("username").and_then(Value::as_str).unwrap_or(""))?;
    let expires_at = payload
        .get("expiresAt")
        .and_then(Value::as_str)
        .map(str::to_string);
    let must_change_password = user.get("mustChangePassword") == Some(&Value::Bool(true));
    Ok(DesktopSession {
        session_token,
        expires_at,
        username,
        must_change_password,
    })
}

async fn read_runtime(client: &SessionClient, session_token: &str) -> AgentResult<RuntimeInfo> {
    let response = client
        .request(
            Method::GET,
            "/api/runtime",
            &[("cookie", cookie_header(session_token))],
            None,
        )
        .await?;
    if response.status != 200 {
        return Err(response_error(&response, "无法读取登录账号信息"));
    }
    let payload = parse_response_body(&response.text)?;
    if payload.get("authenticated") != Some(&Value::Bool(true))
        || !matches!(payload.get("user"), Some(Value::Object(_)))
    {
        return err(code::INVALID_RESPONSE, "登录会话未生效");
    }
    let username = validate_username(
        payload
            .get("user")
            .and_then(|user| user.get("username"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )?;
    Ok(RuntimeInfo {
        username,
        teams: normalize_teams(payload.get("teams")),
        allow_local_git_remotes: payload.get("allowLocalGitRemotes") == Some(&Value::Bool(true)),
    })
}

async fn logout_request(client: &SessionClient, session_token: &str) -> AgentResult<RawResponse> {
    client
        .request(
            Method::POST,
            "/api/auth/logout",
            &[
                ("origin", client.server_url.clone()),
                ("cookie", cookie_header(session_token)),
            ],
            Some(json!({})),
        )
        .await
}

/// 对照 JS mapEnrollError。
fn map_enroll_error(error: AgentError) -> AgentError {
    if error.code == code::DESKTOP_TOKEN_INVALID {
        return AgentError::new(code::DESKTOP_TOKEN_INVALID, error.message).terminal(true);
    }
    if error.code == code::NETWORK_ERROR {
        return AgentError::new(
            code::NETWORK_ERROR,
            "无法连接 Board 服务端，请检查网络后重试",
        )
        .retryable(true);
    }
    error
}

async fn enroll_with_token_request(
    api: &ApiClient,
    token: &str,
    device_name: &str,
) -> AgentResult<protocol::EnrollResponse> {
    let body = json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "agentVersion": AGENT_VERSION,
        "platform": "win32",
        "token": token,
        "deviceName": device_name,
    });
    let payload = api
        .request_json(
            Method::POST,
            "/api/agent/enroll-desktop",
            Some(&body),
            REQUEST_TIMEOUT,
        )
        .await
        .map_err(map_enroll_error)?;
    parse_enroll_response(&payload)
}

/// 对照 JS completeDesktopEnrollment。
async fn complete_desktop_enrollment(
    store: &ConfigStore,
    enrolled: &protocol::EnrollResponse,
    server_url: &str,
    device_name: &str,
    bindings: Vec<AgentBinding>,
) -> AgentResult<EnrollmentSummary> {
    if enrolled.protocol_version != AGENT_PROTOCOL_VERSION {
        return err(
            code::PROTOCOL_INCOMPATIBLE,
            "服务端 Agent 协议版本与当前客户端不兼容",
        );
    }
    let credential = enrolled.credential.clone();
    let teams: Vec<AgentTeam> = enrolled
        .teams
        .iter()
        .map(|team| AgentTeam {
            id: team.id.clone(),
            name: team.name.clone(),
            role: team.role.clone(),
        })
        .collect();
    let config = AgentConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        revision: create_config_revision(),
        server_url: server_url.to_string(),
        ca_file: None,
        allow_local_git_remotes: false,
        agent_id: enrolled.agent_id.clone(),
        device_name: device_name.to_string(),
        username: enrolled.username.clone(),
        team_id: enrolled.team_id.clone(),
        teams: teams.clone(),
        protocol_version: AGENT_PROTOCOL_VERSION,
        agent_version: Some(AGENT_VERSION.to_string()),
        paired_at: Some(protocol::now_iso8601()),
        bindings,
    };
    // ponytail: JS 把凭证保存放进同一个配置锁的回调里；Rust 的 update_config 只接受同步闭包，
    // 只能先落盘凭证再写配置。失败时凭证可能已写入，下次注册会覆盖，不会产生脏引用。
    CredentialStore::new(store)
        .save_credential(&credential)
        .await?;
    store.update_config(true, move |_| Ok(Some(config))).await?;
    Ok(EnrollmentSummary {
        agent_id: enrolled.agent_id.clone(),
        device_name: device_name.to_string(),
        server_url: server_url.to_string(),
        protocol_version: enrolled.protocol_version,
        username: enrolled.username.clone(),
        teams,
    })
}

// ---------------------------------------------------------------------------
// 本地状态
// ---------------------------------------------------------------------------

async fn remove_file_if_exists(path: &Path) -> AgentResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AgentError::new(
            code::CONFIG_INVALID,
            format!("无法清理 Agent 缓存：{error}"),
        )),
    }
}

async fn remove_dir_if_exists(path: &Path) -> AgentResult<()> {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AgentError::new(
            code::CONFIG_INVALID,
            format!("无法清理 Agent 目录：{error}"),
        )),
    }
}

/// 对照 JS clearAgentTransientState。
async fn clear_agent_transient_state(store: &ConfigStore) -> AgentResult<()> {
    let paths = &store.paths;
    for file in [
        &paths.event_cursors_file,
        &paths.task_cursors_file,
        &paths.state_file,
    ] {
        remove_file_if_exists(file).await?;
    }
    if let Err(error) = remove_file_if_exists(&paths.ownership_index_file).await {
        crate::logging::warn(&format!(
            "清理 ownership 索引失败：{}",
            protocol::safe_error_message(&error.message)
        ));
    }
    for dir in [&paths.events_dir, &paths.live_backups_dir] {
        remove_dir_if_exists(dir).await?;
    }
    for dir in [&paths.events_dir, &paths.live_backups_dir] {
        tokio::fs::create_dir_all(dir).await.map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("无法创建 Agent 目录：{error}"),
            )
        })?;
    }
    Ok(())
}

/// 对照 JS clearDeviceRegistration。
/// ponytail: ConfigStore 的配置锁是私有的，这里直接删文件；调用点（登录/重注册）本身是串行入口。
async fn clear_device_registration(store: &ConfigStore) -> AgentResult<()> {
    remove_file_if_exists(&store.paths.config_file).await?;
    remove_file_if_exists(&store.paths.credential_file).await?;
    clear_agent_transient_state(store).await
}

/// 对照 JS reusableDevice：能通过心跳就复用现有注册。
async fn reusable_device(
    store: &ConfigStore,
    existing: Option<&AgentConfig>,
    server_url: &str,
    username: &str,
    device_name: &str,
) -> AgentResult<bool> {
    let Some(existing) = existing else {
        return Ok(false);
    };
    if existing.server_url != server_url
        || existing.username.as_deref().unwrap_or("").to_lowercase() != username
    {
        return Ok(false);
    }
    let credential = match CredentialStore::new(store).load_credential().await {
        Ok(credential) => credential,
        Err(_) => return Ok(false),
    };
    let api = ApiClient::new(server_url, Some(credential), None)?;
    let bindings: Vec<Value> = existing
        .bindings
        .iter()
        .map(|binding| {
            json!({
                "taskSpaceId": binding.task_space_id,
                "projectId": binding.project_id,
                "localRepoKey": binding.local_repo_key,
                "branchName": binding.branch_name,
                "remoteIdentityKey": binding.remote_identity_key,
                "displayName": binding.display_name,
                "status": binding.sync_status,
            })
        })
        .collect();
    let body = json!({
        "protocolVersion": AGENT_PROTOCOL_VERSION,
        "agentVersion": AGENT_VERSION,
        "platform": "win32",
        "agentId": existing.agent_id,
        "deviceName": device_name,
        "listenerReportVersion": LISTENER_REPORT_VERSION,
        "listeningTaskSpaceIds": [],
        "bindings": bindings,
    });
    match api
        .request_json(
            Method::POST,
            "/api/agent/heartbeat",
            Some(&body),
            REQUEST_TIMEOUT,
        )
        .await
    {
        Ok(payload) => {
            parse_heartbeat_response(&payload)?;
            Ok(true)
        }
        Err(error) => {
            let rejected = error.code == code::AUTH_REVOKED
                || error.code == code::CREDENTIAL_MISSING
                || error.code == code::CREDENTIAL_CORRUPT
                || matches!(error.status, Some(401) | Some(403));
            if rejected {
                Ok(false)
            } else {
                Err(error)
            }
        }
    }
}

fn server_url_of(api: &ApiClient) -> AgentResult<String> {
    protocol::normalize_server_url(api.base_url())
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/// 对照 JS loginDesktop。
///
/// 与任务书签名的差异：登录成功会写本地配置与凭证，因此必须显式传入 `store`
/// （`ConfigStore::from_env()` 与 desktop 的 `config::agent_root()` 不是同一目录）。
pub async fn login_desktop(
    store: &ConfigStore,
    api: &ApiClient,
    username: &str,
    password: &str,
    device_name: &str,
    force_new: bool,
) -> AgentResult<DesktopLoginSummary> {
    let server_url = server_url_of(api)?;
    let username = validate_username(username)?;
    let password = validate_password(password)?;
    let device_name = validate_device_name(device_name)?;
    store.ensure_directories().await?;

    let client = SessionClient::new(&server_url)?;
    let session = login_request(&client, &username, &password).await?;
    let result = complete_login(
        store,
        api,
        &client,
        &server_url,
        &username,
        &device_name,
        force_new,
        &session,
    )
    .await;
    match result {
        Ok(summary) => Ok(summary),
        Err(error) => {
            // JS 在失败时尽力退出刚建立的会话，避免留下悬空 Cookie。
            let _ = logout_request(&client, &session.session_token).await;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn complete_login(
    store: &ConfigStore,
    api: &ApiClient,
    client: &SessionClient,
    server_url: &str,
    username: &str,
    device_name: &str,
    force_new: bool,
    session: &DesktopSession,
) -> AgentResult<DesktopLoginSummary> {
    let runtime = read_runtime(client, &session.session_token).await?;
    if runtime.username != session.username {
        return err(code::INVALID_RESPONSE, "登录响应的用户身份不一致");
    }
    let existing = store.read_config(true).await.ok().flatten();
    let mut summary = DesktopLoginSummary {
        ok: true,
        session_token: Some(session.session_token.clone()),
        expires_at: session.expires_at.clone(),
        username: Some(session.username.clone()),
        must_change_password: Some(session.must_change_password),
        device_ready: Some(false),
        error: None,
        code: None,
    };
    if session.must_change_password {
        if force_new {
            clear_device_registration(store).await?;
        }
        return Ok(summary);
    }

    let reusable = if force_new {
        false
    } else {
        reusable_device(store, existing.as_ref(), server_url, username, device_name).await?
    };
    if reusable {
        let teams = runtime.teams.clone();
        let allow_local_git_remotes = runtime.allow_local_git_remotes;
        let server_url = server_url.to_string();
        let device_name = device_name.to_string();
        let username = username.to_string();
        store
            .update_config(false, move |current| {
                let Some(mut config) = current.cloned() else {
                    return err(code::CONFIG_MISSING, "Agent 配置不存在");
                };
                config.server_url = server_url;
                config.device_name = device_name;
                config.username = Some(username);
                config.teams = teams;
                config.allow_local_git_remotes = allow_local_git_remotes;
                Ok(Some(config))
            })
            .await?;
        summary.device_ready = Some(true);
        return Ok(summary);
    }

    let issued = client
        .request(
            Method::POST,
            "/api/desktop/enroll-tokens",
            &[
                ("origin", server_url.to_string()),
                ("cookie", cookie_header(&session.session_token)),
            ],
            Some(json!({ "deviceName": device_name })),
        )
        .await?;
    if issued.status != 201 {
        return Err(response_error(&issued, "无法签发桌面设备令牌"));
    }
    let issued_body = parse_response_body(&issued.text)?;
    let token = validate_enroll_token(
        issued_body
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )?;

    let same_account = existing.as_ref().is_some_and(|config| {
        config.server_url == server_url
            && config.username.as_deref().unwrap_or("").to_lowercase() == username
    });
    let enrolled = enroll_with_token_request(api, &token, device_name).await?;
    complete_desktop_enrollment(store, &enrolled, server_url, device_name, Vec::new()).await?;

    let teams = runtime.teams.clone();
    let allow_local_git_remotes = runtime.allow_local_git_remotes;
    let username_owned = username.to_string();
    store
        .update_config(false, move |current| {
            let Some(mut config) = current.cloned() else {
                return err(code::CONFIG_MISSING, "Agent 配置不存在");
            };
            config.username = Some(username_owned);
            config.teams = teams;
            config.allow_local_git_remotes = allow_local_git_remotes;
            Ok(Some(config))
        })
        .await?;
    if !same_account || force_new {
        clear_agent_transient_state(store).await?;
    }
    summary.device_ready = Some(true);
    Ok(summary)
}

/// 对照 JS logoutDesktopSession。
pub async fn logout_desktop_session(api: &ApiClient, session_token: &str) -> AgentResult<Value> {
    let session_token = validate_session_token(session_token)?;
    let client = SessionClient::new(api.base_url())?;
    let response = logout_request(&client, &session_token).await?;
    if response.status != 200 {
        return Err(response_error(&response, "退出登录失败"));
    }
    Ok(json!({ "loggedOut": true }))
}

/// 读取本地绑定并复用任务同步缓存投影归属状态。
pub async fn read_local_associations(
    store: &ConfigStore,
    task_sync: Option<&TaskSync>,
) -> AgentResult<Vec<LocalAssociation>> {
    let config = store
        .read_config(false)
        .await?
        .ok_or_else(|| AgentError::new(code::CONFIG_MISSING, "Agent 配置不存在"))?;
    let deferred = store.read_task_cursors().await;
    let ownership_index = if task_sync.is_none() {
        task_sync::load_ownership_index(&store.paths.ownership_index_file).await
    } else {
        None
    };
    let mut associations = Vec::with_capacity(config.bindings.len());
    for binding in config.bindings {
        let deferred_task_dirs = deferred_task_dirs(&deferred, &binding.task_space_id);
        let deferred_tasks =
            deferred_task_infos(Path::new(&binding.repo_path), &deferred_task_dirs);
        let (ownership_paused_task_dirs, ownership_pending_task_dirs) = if binding.sync_status
            == "approved"
            && !binding.detach_pending
            && !binding.read_only
            && binding.live_sync_status != "error"
            && binding.last_error_code.as_deref() != Some(code::BRANCH_MISMATCH)
            && binding.last_error_code.as_deref() != Some("BINDING_BRANCH_MISMATCH")
        {
            local_ownership_dirs(&binding, &deferred, task_sync, ownership_index.as_ref()).await?
        } else {
            (Vec::new(), Vec::new())
        };
        associations.push(LocalAssociation {
            project_id: binding.project_id,
            task_space_id: binding.task_space_id,
            repo_path: binding.repo_path,
            display_name: binding.display_name,
            branch_name: binding.branch_name,
            team_id: binding.team_id,
            status: binding.sync_status,
            detach_pending: binding.detach_pending,
            initial_review_pending: binding.initial_review_pending,
            read_only: binding.read_only,
            live_sync_status: binding.live_sync_status,
            live_sync_error: binding.live_sync_error,
            deferred_count: deferred_task_dirs.len(),
            deferred_task_dirs,
            deferred_tasks,
            ownership_paused_count: ownership_paused_task_dirs.len(),
            ownership_paused_task_dirs,
            ownership_pending_count: ownership_pending_task_dirs.len(),
            ownership_pending_task_dirs,
            last_error_code: binding.last_error_code,
            last_error: binding.last_error,
        });
    }
    Ok(associations)
}

async fn local_ownership_dirs(
    binding: &AgentBinding,
    cursors: &Value,
    task_sync: Option<&TaskSync>,
    ownership_index: Option<&task_sync::OwnershipIndex>,
) -> AgentResult<(Vec<String>, Vec<String>)> {
    let (paused, local_dirs) = match task_sync {
        Some(task_sync) => match task_sync.ownership_projection(binding).await {
            Ok(projection) => projection,
            Err(_) => return Ok((Vec::new(), Vec::new())),
        },
        None => {
            let tasks_root_safe =
                task_sync::ownership_tasks_root_is_safe(Path::new(&binding.repo_path)).await;
            if let Some((paused, local_dirs, _, _)) = ownership_index
                .filter(|_| tasks_root_safe)
                .and_then(|index| task_sync::indexed_ownership_projection(index, binding))
            {
                (paused, local_dirs)
            } else {
                let Ok(files) =
                    task_sync::read_local_task_snapshot_files(Path::new(&binding.repo_path), None)
                        .await
                else {
                    return Ok((Vec::new(), Vec::new()));
                };
                let groups = match task_sync::group_task_snapshot_files(&files) {
                    Ok(groups) => groups,
                    Err(_) => return Ok((Vec::new(), Vec::new())),
                };
                let paused = groups
                    .iter()
                    .filter(|group| {
                        group
                            .task_branch
                            .as_deref()
                            .is_some_and(|branch| branch != binding.branch_name)
                    })
                    .map(|group| group.task_dir.clone())
                    .collect::<std::collections::HashSet<_>>();
                let local_dirs = groups
                    .iter()
                    .map(|group| group.task_dir.clone())
                    .collect::<std::collections::HashSet<_>>();
                (std::sync::Arc::new(paused), std::sync::Arc::new(local_dirs))
            }
        }
    };
    let mut paused: Vec<String> = paused.iter().cloned().collect();
    paused.sort();
    let paused_set: std::collections::HashSet<String> = paused.iter().cloned().collect();
    let mut pending: Vec<String> = cursors
        .get("taskSpaces")
        .and_then(|spaces| spaces.get(&binding.task_space_id))
        .and_then(|space| space.get("ownershipPending"))
        .and_then(Value::as_object)
        .map(|items| items.keys().cloned().collect())
        .unwrap_or_default();
    pending.retain(|task_dir| local_dirs.contains(task_dir) && !paused_set.contains(task_dir));
    pending.sort();
    Ok((paused, pending))
}

/// 尚未补同步的本地任务目录（只看 `.trellis/tasks/` 前缀，按字典序）。
fn deferred_task_dirs(cursors: &Value, task_space_id: &str) -> Vec<String> {
    let mut dirs: Vec<String> = cursors
        .get("taskSpaces")
        .and_then(Value::as_object)
        .and_then(|spaces| spaces.get(task_space_id))
        .and_then(|space| space.get("deferred"))
        .and_then(Value::as_object)
        .map(|deferred| deferred.keys().cloned().collect())
        .unwrap_or_default();
    dirs.retain(|dir| dir.starts_with(".trellis/tasks/"));
    dirs.sort();
    dirs
}

/// 逐目录读取本地 task.json 标题；读取失败或标题缺失降级为 None。
fn deferred_task_infos(repo_path: &Path, task_dirs: &[String]) -> Vec<DeferredTaskInfo> {
    task_dirs
        .iter()
        .map(|task_dir| DeferredTaskInfo {
            task_dir: task_dir.clone(),
            title: deferred_task_title(repo_path, task_dir),
        })
        .collect()
}

fn deferred_task_title(repo_path: &Path, task_dir: &str) -> Option<String> {
    let content = std::fs::read_to_string(repo_path.join(task_dir).join("task.json")).ok()?;
    let parsed: Value = serde_json::from_str(&content).ok()?;
    parsed
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn clears_ownership_index_with_agent_transient_state() {
        let root = std::env::temp_dir().join(format!(
            "trellis-device-transient-{}",
            uuid::Uuid::new_v4()
        ));
        let store = ConfigStore::new_unsecured_for_test(root.clone());
        store.ensure_directories().await.expect("directories");
        tokio::fs::write(&store.paths.ownership_index_file, b"{}\n")
            .await
            .expect("ownership index");

        clear_agent_transient_state(&store)
            .await
            .expect("clear transient state");

        assert!(!store.paths.ownership_index_file.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[test]
    fn device_name_validation_boundaries() {
        assert!(validate_device_name("").is_err());
        assert!(validate_device_name("   ").is_err());
        assert!(validate_device_name(&"a".repeat(81)).is_err());
        assert!(validate_device_name("bad\u{1}name").is_err());
        assert_eq!(
            validate_device_name("  我的电脑  ").expect("trimmed"),
            "我的电脑"
        );
        assert_eq!(
            validate_device_name(&"a".repeat(80)).expect("80 chars"),
            "a".repeat(80)
        );
        assert_eq!(
            validate_device_name("").expect_err("empty").code,
            code::CONFIG_INVALID
        );
    }

    #[test]
    fn username_and_password_validation() {
        assert_eq!(
            validate_username("  Fly.Fly6 ").expect("normalized"),
            "fly.fly6"
        );
        assert_eq!(
            validate_username("ab").unwrap_err().message,
            "登录名格式无效"
        );
        assert_eq!(
            validate_username("bad name").unwrap_err().message,
            "登录名格式无效"
        );
        assert_eq!(
            validate_password("12345").unwrap_err().message,
            "密码至少需要 6 个字符"
        );
        assert_eq!(
            validate_password(&"a".repeat(1025)).unwrap_err().message,
            "密码不能超过 1024 字节"
        );
        assert_eq!(validate_password("123456").expect("ok"), "123456");
        // 多字节字符按字符数而非字节数判断下限。
        assert!(validate_password("密码密码密码").is_ok());
    }

    #[test]
    fn session_token_and_ids_validation() {
        assert!(validate_session_token("short").is_err());
        assert_eq!(
            validate_session_token(&"a".repeat(16)).expect("ok").len(),
            16
        );
        assert_eq!(
            validate_session_token("bad token with spaces")
                .unwrap_err()
                .message,
            "管理员会话 Cookie 格式无效"
        );
        assert_eq!(
            validate_enroll_token(&"a".repeat(31)).unwrap_err().message,
            "设备令牌格式无效"
        );
        assert!(validate_enroll_token(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn parses_session_cookie_rows() {
        let value = "c".repeat(24);
        let rows = vec![
            "other=1; Path=/".to_string(),
            format!("trellis_team_session={value}; Path=/; HttpOnly"),
        ];
        assert_eq!(parse_session_cookie(&rows).expect("parsed"), value);

        assert_eq!(
            parse_session_cookie(&[]).unwrap_err().message,
            "Board 登录响应缺少会话 Cookie"
        );
        let duplicated = vec![
            format!("trellis_team_session={value}"),
            format!("trellis_team_session={value}"),
        ];
        assert_eq!(
            parse_session_cookie(&duplicated).unwrap_err().message,
            "Board 登录响应包含重复会话 Cookie"
        );
        // 非会话 Cookie 不参与计数。
        let unrelated = vec!["theme=dark".to_string()];
        assert!(parse_session_cookie(&unrelated).is_err());
    }

    #[test]
    fn local_association_round_trips_camel_case() {
        let association = LocalAssociation {
            project_id: "project-1".to_string(),
            task_space_id: "task-space-1".to_string(),
            repo_path: "C:/repo".to_string(),
            display_name: "Repo".to_string(),
            branch_name: "main".to_string(),
            team_id: Some("team-1".to_string()),
            status: "approved".to_string(),
            detach_pending: true,
            initial_review_pending: false,
            read_only: true,
            live_sync_status: "idle".to_string(),
            live_sync_error: None,
            deferred_count: 2,
            deferred_task_dirs: vec![
                ".trellis/tasks/11-12-a".to_string(),
                ".trellis/tasks/11-12-b".to_string(),
            ],
            deferred_tasks: vec![
                DeferredTaskInfo {
                    task_dir: ".trellis/tasks/11-12-a".to_string(),
                    title: Some("修复登录".to_string()),
                },
                DeferredTaskInfo {
                    task_dir: ".trellis/tasks/11-12-b".to_string(),
                    title: None,
                },
            ],
            ownership_paused_count: 1,
            ownership_paused_task_dirs: vec![".trellis/tasks/11-12-a".to_string()],
            ownership_pending_count: 1,
            ownership_pending_task_dirs: vec![".trellis/tasks/11-12-b".to_string()],
            last_error_code: Some("GIT_FAILED".to_string()),
            last_error: None,
        };
        let value = serde_json::to_value(&association).expect("serialize");
        assert_eq!(value["projectId"], "project-1");
        assert_eq!(value["taskSpaceId"], "task-space-1");
        assert_eq!(value["repoPath"], "C:/repo");
        assert_eq!(value["detachPending"], true);
        assert_eq!(value["readOnly"], true);
        assert_eq!(value["liveSyncStatus"], "idle");
        assert_eq!(value["deferredCount"], 2);
        assert_eq!(value["deferredTaskDirs"][0], ".trellis/tasks/11-12-a");
        assert_eq!(
            value["deferredTasks"][0]["taskDir"],
            ".trellis/tasks/11-12-a"
        );
        assert_eq!(value["deferredTasks"][0]["title"], "修复登录");
        assert!(value["deferredTasks"][1]["title"].is_null());
        assert_eq!(value["lastErrorCode"], "GIT_FAILED");

        let minimal: LocalAssociation = serde_json::from_value(json!({
            "projectId": "p",
            "repoPath": "C:/r",
            "displayName": "d",
            "branchName": "main",
            "status": "approved",
            "readOnly": false,
        }))
        .expect("deserialize");
        assert_eq!(minimal.task_space_id, "");
        assert!(!minimal.detach_pending);
        assert_eq!(minimal.live_sync_status, "pending");
        assert!(minimal.deferred_tasks.is_empty());
    }

    #[test]
    fn deferred_task_infos_extract_titles_or_none() {
        let root =
            std::env::temp_dir().join(format!("trellis-device-titles-{}", uuid::Uuid::new_v4()));
        let titled = root.join(".trellis/tasks/11-12-titled");
        let untitled = root.join(".trellis/tasks/11-12-untitled");
        let broken = root.join(".trellis/tasks/11-12-broken");
        for dir in [&titled, &untitled, &broken] {
            std::fs::create_dir_all(dir).expect("task dir");
        }
        std::fs::write(titled.join("task.json"), r#"{"title":"  修复登录  "}"#).expect("titled");
        std::fs::write(untitled.join("task.json"), r#"{"id":"demo"}"#).expect("untitled");
        std::fs::write(broken.join("task.json"), "{not json").expect("broken");

        let dirs = vec![
            ".trellis/tasks/11-12-titled".to_string(),
            ".trellis/tasks/11-12-untitled".to_string(),
            ".trellis/tasks/11-12-broken".to_string(),
            ".trellis/tasks/11-12-missing".to_string(),
        ];
        let infos = deferred_task_infos(&root, &dirs);
        assert_eq!(infos.len(), 4);
        assert_eq!(infos[0].task_dir, ".trellis/tasks/11-12-titled");
        assert_eq!(infos[0].title.as_deref(), Some("修复登录"));
        assert_eq!(infos[1].title, None);
        assert_eq!(infos[2].title, None);
        assert_eq!(infos[3].title, None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn login_summary_uses_camel_case_and_skips_missing_fields() {
        let pending = DesktopLoginSummary {
            ok: true,
            session_token: None,
            expires_at: None,
            username: None,
            must_change_password: None,
            device_ready: None,
            error: None,
            code: None,
        };
        assert_eq!(
            serde_json::to_value(&pending).expect("serialize"),
            json!({ "ok": true })
        );

        let ready = DesktopLoginSummary {
            ok: true,
            session_token: Some("token".to_string()),
            expires_at: Some("2026-01-01T00:00:00.000Z".to_string()),
            username: Some("fly".to_string()),
            must_change_password: Some(false),
            device_ready: Some(true),
            error: None,
            code: None,
        };
        let value = serde_json::to_value(&ready).expect("serialize");
        assert_eq!(value["sessionToken"], "token");
        assert_eq!(value["expiresAt"], "2026-01-01T00:00:00.000Z");
        assert_eq!(value["mustChangePassword"], false);
        assert_eq!(value["deviceReady"], true);
        assert!(value.get("error").is_none());
        assert!(value.get("code").is_none());
    }

    #[test]
    fn maps_enroll_errors() {
        let terminal = map_enroll_error(AgentError::new(code::DESKTOP_TOKEN_INVALID, "令牌无效"));
        assert_eq!(terminal.code, code::DESKTOP_TOKEN_INVALID);
        assert_eq!(terminal.message, "令牌无效");
        assert!(terminal.terminal);

        let network = map_enroll_error(AgentError::new(code::NETWORK_ERROR, "connection refused"));
        assert_eq!(network.code, code::NETWORK_ERROR);
        assert_eq!(network.message, "无法连接 Board 服务端，请检查网络后重试");
        assert!(network.retryable);

        let other = map_enroll_error(AgentError::new(code::CONFIG_INVALID, "配置无效"));
        assert_eq!(other.code, code::CONFIG_INVALID);
        assert_eq!(other.message, "配置无效");
        assert!(!other.retryable);
    }
}
