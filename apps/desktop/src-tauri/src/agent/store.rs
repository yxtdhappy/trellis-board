use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use crate::agent::process::{build_environment, run_process, ProcessOptions};
use crate::agent::protocol::{self as protocol, code, AgentError, AgentResult};

pub const CONFIG_SCHEMA_VERSION: u32 = 2;
pub const STATE_SCHEMA_VERSION: u32 = 2;
const RENAME_RETRY_DELAYS_MS: [u64; 5] = [10, 25, 50, 100, 200];

#[derive(Debug, Clone)]
pub struct AgentPaths {
    pub root: PathBuf,
    pub config_file: PathBuf,
    pub credential_file: PathBuf,
    pub state_file: PathBuf,
    pub event_cursors_file: PathBuf,
    pub task_cursors_file: PathBuf,
    pub live_backups_dir: PathBuf,
    pub events_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub config_lock_file: PathBuf,
    pub task_cursor_lock_file: PathBuf,
    pub hooks_base_dir: PathBuf,
}

pub fn create_agent_paths(root: &Path) -> AgentPaths {
    AgentPaths {
        root: root.to_path_buf(),
        config_file: root.join("config.json"),
        credential_file: root.join("credential.dpapi"),
        state_file: root.join("runtime.json"),
        event_cursors_file: root.join("event-cursors.json"),
        task_cursors_file: root.join("live-cursors.json"),
        live_backups_dir: root.join("live-backups"),
        events_dir: root.join("events"),
        logs_dir: root.join("logs"),
        config_lock_file: root.join(".config.lock"),
        task_cursor_lock_file: root.join(".live-cursors.lock"),
        hooks_base_dir: root.join("hooks"),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentTeam {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinding {
    pub local_id: String,
    #[serde(default)]
    pub server_binding_id: Option<String>,
    pub task_space_id: String,
    pub project_id: String,
    pub repo_path: String,
    pub branch_name: String,
    #[serde(default)]
    pub team_id: Option<String>,
    pub remote_identity_key: String,
    pub local_repo_key: String,
    pub display_name: String,
    pub created_at: String,
    #[serde(default)]
    pub allow_file_remote: bool,
    #[serde(default)]
    pub read_only: bool,
    pub sync_status: String,
    #[serde(default)]
    pub detach_pending: bool,
    pub initial_sync_mode: String,
    pub initial_sync_completed: bool,
    pub initial_review_pending: bool,
    pub live_sync_status: String,
    #[serde(default)]
    pub live_sync_error: Option<String>,
    #[serde(default)]
    pub last_synced_at: Option<String>,
    #[serde(default)]
    pub last_head: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub schema_version: u32,
    pub revision: String,
    pub server_url: String,
    #[serde(default)]
    pub ca_file: Option<String>,
    #[serde(default)]
    pub allow_local_git_remotes: bool,
    pub agent_id: String,
    pub device_name: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub teams: Vec<AgentTeam>,
    pub protocol_version: u32,
    #[serde(default)]
    pub agent_version: Option<String>,
    #[serde(default)]
    pub paired_at: Option<String>,
    #[serde(default)]
    pub bindings: Vec<AgentBinding>,
}

fn require_string(value: Option<&str>, field: &str, max_length: usize) -> AgentResult<String> {
    match value {
        Some(text) if !text.is_empty() && text.len() <= max_length => Ok(text.to_string()),
        _ => protocol::err(code::CONFIG_INVALID, format!("配置字段 {field} 无效")),
    }
}

fn optional_string(
    value: Option<&str>,
    field: &str,
    max_length: usize,
) -> AgentResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(text) => require_string(Some(text), field, max_length).map(Some),
    }
}

fn require_hash(value: Option<&str>, field: &str) -> AgentResult<String> {
    match value {
        Some(text)
            if text.len() == 64
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Ok(text.to_string())
        }
        _ => protocol::err(code::CONFIG_INVALID, format!("配置字段 {field} 无效")),
    }
}

pub fn create_config_revision() -> String {
    use rand_bytes::random_bytes;
    random_bytes(16)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

mod rand_bytes {
    pub fn random_bytes(length: usize) -> Vec<u8> {
        uuid::Uuid::new_v4()
            .as_bytes()
            .iter()
            .copied()
            .chain(uuid::Uuid::new_v4().as_bytes().iter().copied())
            .take(length)
            .collect()
    }
}

fn validate_binding(binding: &AgentBinding, index: usize) -> AgentResult<AgentBinding> {
    let default_mode = if binding.initial_review_pending {
        "review"
    } else {
        "safe"
    };
    let initial_sync_mode = if binding.initial_sync_mode.is_empty() {
        default_mode.to_string()
    } else {
        binding.initial_sync_mode.clone()
    };
    if !matches!(
        binding.sync_status.as_str(),
        "pending" | "approved" | "rejected" | "revoked"
    ) {
        return protocol::err(
            code::CONFIG_INVALID,
            format!("第 {} 个绑定状态无效", index + 1),
        );
    }
    if !matches!(
        binding.live_sync_status.as_str(),
        "pending" | "syncing" | "ready" | "error"
    ) {
        return protocol::err(
            code::CONFIG_INVALID,
            format!("第 {} 个绑定的实时同步状态无效", index + 1),
        );
    }
    if !matches!(initial_sync_mode.as_str(), "bootstrap" | "safe" | "review") {
        return protocol::err(
            code::CONFIG_INVALID,
            format!("第 {} 个绑定的首次同步方式无效", index + 1),
        );
    }
    let initial_sync_completed = binding.initial_sync_completed;
    let initial_review_pending = initial_sync_mode == "review" && !initial_sync_completed;
    Ok(AgentBinding {
        local_id: require_string(Some(&binding.local_id), "localId", 128)?,
        server_binding_id: optional_string(
            binding.server_binding_id.as_deref(),
            "serverBindingId",
            128,
        )?,
        task_space_id: require_string(Some(&binding.task_space_id), "taskSpaceId", 128)?,
        project_id: require_string(Some(&binding.project_id), "projectId", 128)?,
        repo_path: std::path::absolute(Path::new(&binding.repo_path))
            .unwrap_or_else(|_| PathBuf::from(&binding.repo_path))
            .to_string_lossy()
            .to_string(),
        branch_name: protocol::validate_branch_name_syntax(&require_string(
            Some(&binding.branch_name),
            "branchName",
            255,
        )?)?,
        team_id: optional_string(binding.team_id.as_deref(), "teamId", 128)?,
        remote_identity_key: require_hash(Some(&binding.remote_identity_key), "remoteIdentityKey")?,
        local_repo_key: require_hash(Some(&binding.local_repo_key), "localRepoKey")?,
        display_name: require_string(Some(&binding.display_name), "displayName", 255)?,
        created_at: require_string(Some(&binding.created_at), "createdAt", 64)?,
        allow_file_remote: binding.allow_file_remote,
        read_only: binding.read_only,
        sync_status: binding.sync_status.clone(),
        detach_pending: binding.detach_pending,
        initial_sync_mode,
        initial_sync_completed,
        initial_review_pending,
        live_sync_status: binding.live_sync_status.clone(),
        live_sync_error: optional_string(binding.live_sync_error.as_deref(), "liveSyncError", 500)?,
        last_synced_at: optional_string(binding.last_synced_at.as_deref(), "lastSyncedAt", 64)?,
        last_head: optional_string(binding.last_head.as_deref(), "lastHead", 64)?,
        last_error: optional_string(binding.last_error.as_deref(), "lastError", 500)?,
        last_error_code: optional_string(binding.last_error_code.as_deref(), "lastErrorCode", 128)?,
    })
}

pub fn validate_config(config: &AgentConfig) -> AgentResult<AgentConfig> {
    if config.schema_version != CONFIG_SCHEMA_VERSION {
        return protocol::err(code::CONFIG_INVALID, "Agent 配置版本不受支持");
    }
    let revision = require_string(Some(&config.revision), "revision", 64)?;
    if revision.len() != 32
        || !revision
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return protocol::err(code::CONFIG_INVALID, "Agent 配置修订号无效");
    }
    let server_url = protocol::normalize_server_url(&config.server_url)?;
    let agent_id = require_string(Some(&config.agent_id), "agentId", 128)?;
    let device_name = require_string(Some(&config.device_name), "deviceName", 160)?;
    if device_name.chars().count() > 80 || device_name.chars().any(|ch| (ch as u32) < 0x20) {
        return protocol::err(code::CONFIG_INVALID, "设备名格式无效");
    }
    if config.protocol_version < 1 {
        return protocol::err(code::CONFIG_INVALID, "Agent 协议版本无效");
    }
    if let Some(ca_file) = &config.ca_file {
        if !Path::new(ca_file).is_absolute() {
            return protocol::err(code::CONFIG_INVALID, "CA 文件必须使用绝对路径");
        }
    }
    let mut bindings = Vec::with_capacity(config.bindings.len());
    for (index, binding) in config.bindings.iter().enumerate() {
        bindings.push(validate_binding(binding, index)?);
    }
    let mut seen = std::collections::HashSet::new();
    for binding in &bindings {
        if !seen.insert(binding.task_space_id.clone()) {
            return protocol::err(code::CONFIG_INVALID, "同一任务空间只能绑定一次");
        }
    }
    let mut teams = Vec::with_capacity(config.teams.len());
    for (index, team) in config.teams.iter().enumerate() {
        teams.push(AgentTeam {
            id: require_string(Some(&team.id), "teams.id", 128).map_err(|_| {
                AgentError::new(
                    code::CONFIG_INVALID,
                    format!("第 {} 个团队信息无效", index + 1),
                )
            })?,
            name: require_string(Some(&team.name), "teams.name", 160).map_err(|_| {
                AgentError::new(
                    code::CONFIG_INVALID,
                    format!("第 {} 个团队信息无效", index + 1),
                )
            })?,
            role: optional_string(team.role.as_deref(), "teams.role", 32)?,
        });
    }
    Ok(AgentConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        revision,
        server_url,
        ca_file: config.ca_file.clone(),
        allow_local_git_remotes: config.allow_local_git_remotes,
        agent_id,
        device_name,
        username: optional_string(config.username.as_deref(), "username", 64)?,
        team_id: optional_string(config.team_id.as_deref(), "teamId", 128)?,
        teams,
        protocol_version: config.protocol_version,
        agent_version: config.agent_version.clone(),
        paired_at: config.paired_at.clone(),
        bindings,
    })
}

/// 同一本地仓库只允许一个 approved 绑定；升级前已存在的双绑定保持兼容。
fn assert_repository_bindings_converged(
    bindings: &[AgentBinding],
    previous: &[AgentBinding],
) -> AgentResult<()> {
    fn active_by_repository(bindings: &[AgentBinding]) -> BTreeMap<&str, Vec<&str>> {
        let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for binding in bindings
            .iter()
            .filter(|item| item.sync_status == "approved")
        {
            groups
                .entry(binding.local_repo_key.as_str())
                .or_default()
                .push(binding.task_space_id.as_str());
        }
        groups
    }

    let before = active_by_repository(previous);
    for (local_repo_key, mut after) in active_by_repository(bindings) {
        if after.len() < 2 {
            continue;
        }
        after.sort_unstable();
        let mut existing = before.get(local_repo_key).cloned().unwrap_or_default();
        existing.sort_unstable();
        if existing == after {
            continue;
        }
        return protocol::err(
            code::CONFIG_INVALID,
            "同一本地仓库只能绑定一个任务空间；需要并行同步多个分支时请使用独立 Git worktree",
        );
    }
    Ok(())
}

pub struct ConfigStore {
    pub paths: AgentPaths,
    secure_directory: bool,
}

impl ConfigStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            paths: create_agent_paths(&root),
            secure_directory: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn new_unsecured_for_test(root: PathBuf) -> Self {
        Self {
            paths: create_agent_paths(&root),
            secure_directory: false,
        }
    }

    pub async fn ensure_directories(&self) -> AgentResult<()> {
        for directory in [
            &self.paths.root,
            &self.paths.logs_dir,
            &self.paths.hooks_base_dir,
            &self.paths.events_dir,
            &self.paths.live_backups_dir,
        ] {
            tokio::fs::create_dir_all(directory)
                .await
                .map_err(|error| {
                    AgentError::new(code::CONFIG_INVALID, format!("无法创建目录: {error}"))
                })?;
        }
        if self.secure_directory {
            let marker = self.paths.root.join(".acl-applied");
            if !marker.exists() && self.restrict_windows_acl().await.is_ok() {
                let _ = tokio::fs::write(&marker, b"1").await;
            }
        }
        Ok(())
    }

    async fn restrict_windows_acl(&self) -> AgentResult<()> {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
        let whoami = Path::new(&system_root).join("System32").join("whoami.exe");
        let icacls = Path::new(&system_root).join("System32").join("icacls.exe");
        let environment = build_environment(None);
        let identity = run_process(
            &whoami,
            &[],
            &ProcessOptions {
                env: Some(environment.clone()),
                timeout: Some(Duration::from_secs(10)),
                max_output_bytes: 32_768,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| {
            AgentError::new(
                code::CONFIG_INVALID,
                "无法确认当前 Windows 用户，配置目录未加密保护",
            )
        })?;
        let principal = identity
            .stdout
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if identity.exit_code != 0 || principal.is_empty() {
            return protocol::err(
                code::CONFIG_INVALID,
                "无法确认当前 Windows 用户，配置目录未加密保护",
            );
        }
        let grant = format!("{principal}:(OI)(CI)F");
        let root = self.paths.root.to_string_lossy().to_string();
        let result = run_process(
            &icacls,
            &[&root, "/inheritance:r", "/grant:r", &grant, "/C", "/Q"],
            &ProcessOptions {
                env: Some(environment),
                timeout: Some(Duration::from_secs(20)),
                max_output_bytes: 262_144,
                ..Default::default()
            },
        )
        .await
        .map_err(|_| AgentError::new(code::CONFIG_INVALID, "无法限制 Agent 配置目录 ACL"))?;
        if result.exit_code != 0 {
            return protocol::err(code::CONFIG_INVALID, "无法限制 Agent 配置目录 ACL");
        }
        Ok(())
    }

    pub async fn write_atomic(&self, target: &Path, data: &[u8]) -> AgentResult<()> {
        self.ensure_directories().await?;
        if let Some(directory) = target.parent() {
            tokio::fs::create_dir_all(directory)
                .await
                .map_err(|error| {
                    AgentError::new(code::CONFIG_INVALID, format!("无法创建目录: {error}"))
                })?;
        }
        let file_name = target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "tmp".to_string());
        let temp = target.with_file_name(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let write_result = async {
            let mut handle = tokio::fs::File::create(&temp).await?;
            handle.write_all(data).await?;
            handle.sync_all().await?;
            drop(handle);
            rename_with_retry(&temp, target).await
        }
        .await;
        if write_result.is_err() {
            let _ = tokio::fs::remove_file(&temp).await;
        }
        write_result.map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("无法写入 {}: {error}", target.display()),
            )
        })
    }

    pub async fn write_json(&self, target: &Path, value: &impl Serialize) -> AgentResult<()> {
        let mut text = serde_json::to_string_pretty(value).map_err(|error| {
            AgentError::new(code::CONFIG_INVALID, format!("序列化失败: {error}"))
        })?;
        text.push('\n');
        self.write_atomic(target, text.as_bytes()).await
    }

    pub async fn read_config(&self, allow_missing: bool) -> AgentResult<Option<AgentConfig>> {
        let raw = match tokio::fs::read_to_string(&self.paths.config_file).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if allow_missing {
                    return Ok(None);
                }
                return protocol::err(code::CONFIG_MISSING, "Agent 尚未配对，请先执行 pair");
            }
            Err(error) => {
                return Err(AgentError::new(
                    code::CONFIG_INVALID,
                    format!("无法读取 Agent 配置: {error}"),
                ))
            }
        };
        let parsed: AgentConfig = serde_json::from_str(&raw).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("Agent 配置文件不是合法 JSON: {error}"),
            )
        })?;
        validate_config(&parsed).map(Some)
    }

    #[cfg(test)]
    pub async fn save_config(&self, config: AgentConfig) -> AgentResult<AgentConfig> {
        let _guard = self.lock_config(Duration::from_secs(5)).await?;
        let previous = self.read_config(true).await.ok().flatten();
        self.save_config_unlocked(config, previous.as_ref()).await
    }

    async fn save_config_unlocked(
        &self,
        config: AgentConfig,
        previous: Option<&AgentConfig>,
    ) -> AgentResult<AgentConfig> {
        let normalized = validate_config(&config)?;
        assert_repository_bindings_converged(
            &normalized.bindings,
            previous
                .map(|value| value.bindings.as_slice())
                .unwrap_or(&[]),
        )?;
        self.write_json(&self.paths.config_file, &normalized)
            .await?;
        Ok(normalized)
    }

    pub async fn update_config<F>(
        &self,
        allow_missing: bool,
        mutator: F,
    ) -> AgentResult<Option<AgentConfig>>
    where
        F: FnOnce(Option<&AgentConfig>) -> AgentResult<Option<AgentConfig>>,
    {
        let _guard = self.lock_config(Duration::from_secs(5)).await?;
        let current = self.read_config(allow_missing).await?;
        let next = mutator(current.as_ref())?;
        match next {
            None => Ok(current),
            Some(config) => {
                let config = AgentConfig {
                    revision: create_config_revision(),
                    ..config
                };
                self.save_config_unlocked(config, current.as_ref())
                    .await
                    .map(Some)
            }
        }
    }

    async fn lock_config(&self, timeout: Duration) -> AgentResult<ConfigLock<'_>> {
        self.lock_file(
            &self.paths.config_lock_file,
            timeout,
            "无法锁定 Agent 配置",
            "Agent 配置正被另一个进程更新",
        )
        .await
    }

    /// 同步游标文件的跨进程锁（对照 JS `withLiveCursorLock`）。
    pub async fn lock_task_cursors(&self, timeout: Duration) -> AgentResult<ConfigLock<'_>> {
        self.lock_file(
            &self.paths.task_cursor_lock_file,
            timeout,
            "无法锁定 Agent 同步游标",
            "Agent 同步游标正被另一个进程更新",
        )
        .await
    }

    async fn lock_file<'a>(
        &'a self,
        path: &'a Path,
        timeout: Duration,
        open_message: &str,
        timeout_message: &str,
    ) -> AgentResult<ConfigLock<'a>> {
        self.ensure_directories().await?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(path)
                .await
            {
                Ok(_) => return Ok(ConfigLock { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = tokio::fs::metadata(path)
                        .await
                        .ok()
                        .and_then(|metadata| metadata.modified().ok())
                        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                        .is_some_and(|age| age > Duration::from_secs(30));
                    if stale {
                        let _ = tokio::fs::remove_file(path).await;
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return protocol::err(code::LOCKED, timeout_message);
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
                Err(error) => {
                    return Err(AgentError::new(
                        code::CONFIG_INVALID,
                        format!("{open_message}: {error}"),
                    ))
                }
            }
        }
    }

    pub async fn write_state(&self, state: Value) -> AgentResult<()> {
        let mut payload = match state {
            Value::Object(map) => Value::Object(map),
            other => {
                let mut map = serde_json::Map::new();
                map.insert("value".into(), other);
                Value::Object(map)
            }
        };
        payload["schemaVersion"] = Value::from(STATE_SCHEMA_VERSION);
        self.write_json(&self.paths.state_file, &payload).await
    }

    pub async fn read_event_cursors(&self) -> std::collections::BTreeMap<String, i64> {
        let Ok(text) = tokio::fs::read_to_string(&self.paths.event_cursors_file).await else {
            return Default::default();
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            return Default::default();
        };
        if parsed.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return Default::default();
        }
        let mut cursors = std::collections::BTreeMap::new();
        if let Some(Value::Object(map)) = parsed.get("cursors") {
            for (team_id, value) in map {
                if let Some(last_event_id) = value.get("lastEventId").and_then(Value::as_i64) {
                    if last_event_id >= 0 {
                        cursors.insert(team_id.clone(), last_event_id);
                    }
                }
            }
        }
        cursors
    }

    /// 任务同步游标文件的原始内容（缺失或损坏时返回空对象）。
    pub async fn read_task_cursors(&self) -> Value {
        let Ok(text) = tokio::fs::read_to_string(&self.paths.task_cursors_file).await else {
            return json!({});
        };
        serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({}))
    }

    pub async fn write_event_cursor(&self, team_id: &str, last_event_id: i64) -> AgentResult<()> {
        if team_id.is_empty() || last_event_id < 0 {
            return Ok(());
        }
        let mut cursors = self.read_event_cursors().await;
        if cursors
            .get(team_id)
            .is_some_and(|current| *current > last_event_id)
        {
            return Ok(());
        }
        cursors.insert(team_id.to_string(), last_event_id);
        self.persist_event_cursors(&cursors).await
    }

    pub async fn clear_event_cursor(&self, team_id: &str) -> AgentResult<()> {
        let mut cursors = self.read_event_cursors().await;
        if cursors.remove(team_id).is_none() {
            return Ok(());
        }
        self.persist_event_cursors(&cursors).await
    }

    async fn persist_event_cursors(
        &self,
        cursors: &std::collections::BTreeMap<String, i64>,
    ) -> AgentResult<()> {
        let now = protocol::now_iso8601();
        let mut map = serde_json::Map::new();
        for (team_id, cursor) in cursors {
            map.insert(
                team_id.clone(),
                serde_json::json!({ "lastEventId": cursor, "updatedAt": now }),
            );
        }
        let payload = serde_json::json!({ "schemaVersion": 1, "cursors": map });
        self.write_json(&self.paths.event_cursors_file, &payload)
            .await
    }

    pub async fn write_credential_record(&self, record: &Value) -> AgentResult<()> {
        self.write_json(&self.paths.credential_file, record).await
    }

    pub async fn read_credential_record(&self) -> AgentResult<Value> {
        let raw = match tokio::fs::read_to_string(&self.paths.credential_file).await {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return protocol::err(code::CREDENTIAL_MISSING, "Agent 凭证不存在，请重新配对")
            }
            Err(error) => {
                return Err(AgentError::new(
                    code::CREDENTIAL_CORRUPT,
                    format!("无法读取 Agent 凭证: {error}"),
                ))
            }
        };
        serde_json::from_str(&raw).map_err(|_| {
            AgentError::new(code::CREDENTIAL_CORRUPT, "Agent 凭证文件已损坏，请重新配对")
        })
    }
}

pub(crate) struct ConfigLock<'a> {
    path: &'a Path,
}

impl Drop for ConfigLock<'_> {
    fn drop(&mut self) {
        let path = self.path.to_path_buf();
        tokio::spawn(async move {
            let _ = tokio::fs::remove_file(path).await;
        });
    }
}

async fn rename_with_retry(source: &Path, target: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match tokio::fs::rename(source, target).await {
            Ok(()) => return Ok(()),
            Err(error) if attempt < RENAME_RETRY_DELAYS_MS.len() => {
                let retryable = matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Other
                ) || error.raw_os_error() == Some(32);
                if !retryable {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(RENAME_RETRY_DELAYS_MS[attempt])).await;
                attempt += 1;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config() -> AgentConfig {
        AgentConfig {
            schema_version: CONFIG_SCHEMA_VERSION,
            revision: "0123456789abcdef0123456789abcdef".into(),
            server_url: "http://localhost:4310".into(),
            ca_file: None,
            allow_local_git_remotes: false,
            agent_id: "agent-1".into(),
            device_name: "PC".into(),
            username: Some("dev".into()),
            team_id: None,
            teams: vec![],
            protocol_version: 3,
            agent_version: None,
            paired_at: None,
            bindings: vec![],
        }
    }

    #[test]
    fn validates_config_revision() {
        assert!(validate_config(&sample_config()).is_ok());
        let mut broken = sample_config();
        broken.revision = "zz".into();
        assert!(validate_config(&broken).is_err());
    }

    #[test]
    fn creates_paths_under_root() {
        let paths = create_agent_paths(Path::new("C:/tmp/agent"));
        assert!(paths.config_file.ends_with("config.json"));
        assert!(paths.task_cursors_file.ends_with("live-cursors.json"));
    }

    #[test]
    fn detach_pending_defaults_false_and_round_trips() {
        let binding = binding("local-1", "ts-1", false);
        let mut value = serde_json::to_value(&binding).expect("serialize");
        value.as_object_mut().expect("binding object").remove("detachPending");
        let parsed: AgentBinding = serde_json::from_value(value).expect("deserialize");
        assert!(!parsed.detach_pending);

        let mut value = serde_json::to_value(&binding).expect("serialize");
        value["detachPending"] = serde_json::Value::Bool(true);
        let pending: AgentBinding = serde_json::from_value(value).expect("deserialize");
        assert!(pending.detach_pending);
    }

    fn binding(local_id: &str, task_space_id: &str, read_only: bool) -> AgentBinding {
        AgentBinding {
            local_id: local_id.into(),
            server_binding_id: None,
            task_space_id: task_space_id.into(),
            project_id: "project-1".into(),
            repo_path: "C:/repo".into(),
            branch_name: "main".into(),
            team_id: None,
            remote_identity_key: "remote".into(),
            local_repo_key: "a".repeat(64),
            display_name: "Repo".into(),
            created_at: "2026-11-12T00:00:00.000Z".into(),
            allow_file_remote: false,
            read_only,
            sync_status: "approved".into(),
            detach_pending: false,
            initial_sync_mode: "bootstrap".into(),
            initial_sync_completed: true,
            initial_review_pending: false,
            live_sync_status: "ready".into(),
            live_sync_error: None,
            last_synced_at: None,
            last_head: None,
            last_error: None,
            last_error_code: None,
        }
    }

    #[test]
    fn rejects_second_active_binding_for_same_repository() {
        let first = binding("local-1", "ts-1", false);
        let second = binding("local-2", "ts-2", false);
        let error = assert_repository_bindings_converged(&[first.clone(), second], &[])
            .expect_err("should reject");
        assert_eq!(error.code, code::CONFIG_INVALID);
        // 与上一版配置一致时放行，允许历史数据继续运行。
        let legacy = binding("local-2", "ts-2", false);
        assert!(assert_repository_bindings_converged(
            &[first.clone(), legacy.clone()],
            &[first, legacy]
        )
        .is_ok());
    }
}
