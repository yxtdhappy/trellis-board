//! 公司规范生命周期：离线状态、plan/apply helper 调用与写操作串行化。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent::company_spec::{
    self, CompanySpecDetected, CompanySpecFeature, CompanySpecTemplateOption,
};
use crate::agent::process::{run_process, ProcessOptions};
use crate::agent::trellis_cli::TrellisRuntime;

const HELPER_RELATIVE: &str = "features/company-spec/apply.mjs";
const HELPER_TIMEOUT: Duration = Duration::from_secs(120);
const HELPER_MAX_OUTPUT: usize = 256 * 1024;
const MARKER_RELATIVE: &str = ".trellis/spec/.company-spec.json";
const CONFIG_RELATIVE: &str = ".trellis/config.yaml";
const STATE_RELATIVE: &str = ".trellis/.runtime/company-spec-state.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecOperationRecord {
    pub action: String,
    pub template: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub applied_at: Option<String>,
    #[serde(default)]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecStatus {
    pub available: bool,
    pub name: String,
    pub state: String,
    pub template: Option<String>,
    pub version: Option<String>,
    pub generated_at: Option<String>,
    pub registry_source: Option<String>,
    pub registry_template: Option<String>,
    pub entrypoints: Vec<String>,
    pub warning: Option<String>,
    pub templates: Vec<CompanySpecTemplateOption>,
    pub detected: CompanySpecDetected,
    pub last_operation: Option<CompanySpecOperationRecord>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecPlanFiles {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub update: Vec<String>,
    #[serde(default)]
    pub keep: Vec<String>,
    #[serde(default)]
    pub conflict: Vec<String>,
    #[serde(default)]
    pub delete: Vec<String>,
    #[serde(default)]
    pub keep_deleted: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecPlan {
    pub action: String,
    pub template: String,
    #[serde(default)]
    pub current_template: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub registry_source: Option<String>,
    #[serde(default)]
    pub marker_invalid: bool,
    #[serde(default)]
    pub requires_backup: bool,
    #[serde(default)]
    pub entrypoints: Vec<String>,
    #[serde(default)]
    pub files: CompanySpecPlanFiles,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecApplyResult {
    pub applied: bool,
    pub action: String,
    pub template: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub backup_path: Option<String>,
    #[serde(default)]
    pub written: Vec<String>,
    #[serde(default)]
    pub kept: Vec<String>,
    #[serde(default)]
    pub deleted: Vec<String>,
    #[serde(default)]
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecError {
    pub ok: bool,
    pub code: String,
    pub message: String,
}

fn error(code: &str, message: impl Into<String>) -> CompanySpecError {
    CompanySpecError {
        ok: false,
        code: code.to_string(),
        message: message.into(),
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn marker_template(marker: &Value) -> Option<String> {
    marker
        .get("template")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn marker_entrypoints(marker: &Value) -> Vec<String> {
    let declared = marker.get("entrypoints").and_then(Value::as_array);
    if let Some(declared) = declared {
        let values: Vec<String> = declared
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        if !values.is_empty() {
            return values;
        }
    }
    marker
        .get("template")
        .and_then(Value::as_str)
        .map(|template| {
            company_spec::template_entrypoints(template)
                .iter()
                .map(|entry| entry.to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn read_registry_spec(repo: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(repo.join(CONFIG_RELATIVE)).ok()?;
    let mut in_registry = false;
    let mut in_spec = false;
    let mut source = None;
    let mut template = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if trimmed.starts_with("registry:") {
            in_registry = true;
            in_spec = false;
            continue;
        }
        if in_registry && trimmed.starts_with("spec:") {
            in_spec = true;
            continue;
        }
        if !in_registry || !in_spec {
            continue;
        }
        if indent <= 2 && !trimmed.starts_with("source:") && !trimmed.starts_with("template:") {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("source:") {
            source = Some(value.trim().trim_matches('"').trim_matches('\'').to_string());
        }
        if let Some(value) = trimmed.strip_prefix("template:") {
            template = Some(value.trim().trim_matches('"').trim_matches('\'').to_string());
        }
    }
    let source = source.filter(|value| !value.is_empty());
    let template = template.filter(|value| !value.is_empty());
    source.zip(template)
}

fn read_last_operation(repo: &Path) -> Option<CompanySpecOperationRecord> {
    read_json(&repo.join(STATE_RELATIVE))
        .and_then(|value| serde_json::from_value(value).ok())
}

fn state_warning(state: &str, template: Option<&str>) -> Option<String> {
    match state {
        "not_applied" => Some("尚未套用公司开发规范".to_string()),
        "template_mismatch" => Some(format!(
            "标记模板 {} 与 registry.spec 不一致，可更换模板",
            template.unwrap_or("未知")
        )),
        "update_source_missing" => {
            Some("缺少 registry.spec，无法检查更新；可修复".to_string())
        }
        "incomplete" => Some("公司规范标记或入口不完整，可修复".to_string()),
        _ => None,
    }
}

/// 离线读取项目状态；feature 不可用或 env 关闭时返回 None。
pub fn status(kit_root: Option<&Path>, repo: &Path) -> Option<CompanySpecStatus> {
    let availability = company_spec::availability(kit_root, repo)?;
    let marker_path = repo.join(MARKER_RELATIVE);
    let marker_text = fs::read_to_string(&marker_path).ok();
    let marker = marker_text
        .as_deref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    let marker_invalid = marker_text.is_some() && marker.is_none();
    let template = marker.as_ref().and_then(marker_template);
    let entrypoints = marker
        .as_ref()
        .map(marker_entrypoints)
        .unwrap_or_default();
    let registry = read_registry_spec(repo);

    let missing_entry = template
        .as_deref()
        .map(|template| {
            company_spec::template_entrypoints(template)
                .iter()
                .any(|entry| !repo.join(".trellis/spec").join(entry).is_file())
        })
        .unwrap_or(false);

    let state = if marker_text.is_none() {
        "not_applied"
    } else if marker_invalid || template.is_none() || missing_entry {
        "incomplete"
    } else if registry.is_none() {
        "update_source_missing"
    } else if registry
        .as_ref()
        .is_some_and(|(_, registry_template)| {
            template.as_deref() != Some(registry_template.as_str())
        })
    {
        "template_mismatch"
    } else {
        "applied"
    };

    let version = marker
        .as_ref()
        .and_then(|value| value.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let generated_at = marker
        .as_ref()
        .and_then(|value| value.get("generatedAt"))
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(CompanySpecStatus {
        available: true,
        name: availability.name,
        state: state.to_string(),
        template: template.clone(),
        version,
        generated_at,
        registry_source: registry.as_ref().map(|(source, _)| source.clone()),
        registry_template: registry.as_ref().map(|(_, template)| template.clone()),
        entrypoints,
        warning: state_warning(state, template.as_deref()),
        templates: availability.templates,
        detected: availability.detected,
        last_operation: read_last_operation(repo),
    })
}

fn validate_template_id(template: &str) -> Result<(), CompanySpecError> {
    let valid = !template.is_empty()
        && template.len() <= 64
        && template
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && template.as_bytes()[0].is_ascii_lowercase();
    if valid {
        Ok(())
    } else {
        Err(error("invalid_args", "模板 ID 格式无效"))
    }
}

fn validate_strategy(strategy: &str) -> Result<(), CompanySpecError> {
    if matches!(strategy, "keep-local" | "overwrite" | "replace") {
        Ok(())
    } else {
        Err(error("invalid_args", "未知的更新策略"))
    }
}

fn validate_strategy_for_action(action: &str, strategy: &str) -> Result<(), CompanySpecError> {
    let valid = match action {
        "update" => matches!(strategy, "keep-local" | "overwrite"),
        "apply" | "replace" => strategy == "replace",
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(error(
            "invalid_args",
            format!("策略 {strategy} 不适用于操作 {action}"),
        ))
    }
}

fn helper_path(kit_root: &Path) -> Result<PathBuf, CompanySpecError> {
    let path = kit_root.join(HELPER_RELATIVE);
    if path.is_file() {
        Ok(path)
    } else {
        Err(error(
            "helper_incompatible",
            "trellis-kit 缺少公司规范 helper，请升级桌面端",
        ))
    }
}

async fn run_helper(
    runtime: &TrellisRuntime,
    kit_root: &Path,
    repo: &Path,
    registry: &str,
    template: &str,
    mode: &str,
    strategy: &str,
) -> Result<Value, CompanySpecError> {
    validate_template_id(template)?;
    validate_strategy(strategy)?;
    if registry.trim().is_empty() {
        return Err(error("invalid_args", "registry 不能为空"));
    }
    if !repo.is_dir() {
        return Err(error("target_invalid", "项目目录不存在"));
    }
    let helper = helper_path(kit_root)?;
    let args = vec![
        helper.to_string_lossy().to_string(),
        "--cli".to_string(),
        runtime.cli_path.to_string_lossy().to_string(),
        "--target".to_string(),
        repo.to_string_lossy().to_string(),
        "--registry".to_string(),
        registry.to_string(),
        "--template".to_string(),
        template.to_string(),
        "--mode".to_string(),
        mode.to_string(),
        "--strategy".to_string(),
        strategy.to_string(),
        "--json".to_string(),
    ];
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let output = run_process(
        &runtime.node_exe,
        &arg_refs,
        &ProcessOptions {
            cwd: Some(repo.to_path_buf()),
            timeout: Some(HELPER_TIMEOUT),
            max_output_bytes: HELPER_MAX_OUTPUT,
            ..ProcessOptions::default()
        },
    )
    .await
    .map_err(|failure| error("write_failed", failure.message))?;

    let line = output
        .stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let parsed = serde_json::from_str::<Value>(line).ok();
    if output.exit_code != 0 || parsed.is_none() {
        if let Some(parsed) = parsed {
            let code = parsed
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("write_failed");
            let message = parsed
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("公司规范 helper 执行失败");
            return Err(error(code, message));
        }
        let detail = if output.stderr.trim().is_empty() {
            output.stdout_tail(400)
        } else {
            output.stderr_tail(400)
        };
        return Err(error(
            "write_failed",
            format!("公司规范 helper 执行失败：{}", detail.trim()),
        ));
    }
    let parsed = parsed.unwrap_or(Value::Null);
    if parsed.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(parsed)
    } else {
        let code = parsed
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("write_failed");
        let message = parsed
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("公司规范 helper 执行失败");
        Err(error(code, message))
    }
}

fn resolve_template(
    repo: &Path,
    feature: &CompanySpecFeature,
    current: Option<&str>,
    selection: Option<&str>,
) -> Result<String, CompanySpecError> {
    if let Some(selection) = selection {
        let selection = selection.trim();
        if selection == "none" {
            return Err(error("invalid_args", "生命周期操作不支持 none"));
        }
        if selection != "auto" {
            if !feature.templates.values().any(|value| value == selection) {
                return Err(error("invalid_args", "所选模板不在公司规范 feature 中"));
            }
            return Ok(selection.to_string());
        }
    }
    if let Some(current) = current {
        return Ok(current.to_string());
    }
    let detected = company_spec::describe_detection(repo, &feature.templates);
    detected
        .template
        .ok_or_else(|| {
            error(
                "template_not_found",
                "未识别出可用的公司规范模板，请手动选择",
            )
        })
}

pub async fn plan(
    runtime: &TrellisRuntime,
    kit_root: &Path,
    repo: &Path,
    feature: &CompanySpecFeature,
    selection: Option<&str>,
    strategy: &str,
) -> Result<CompanySpecPlan, CompanySpecError> {
    let current = status(Some(kit_root), repo);
    let current_template = current.as_ref().and_then(|status| status.template.clone());
    let template = resolve_template(repo, feature, current_template.as_deref(), selection)?;
    let registry = company_spec::config(feature).registry;
    let payload = run_helper(
        runtime,
        kit_root,
        repo,
        &registry,
        &template,
        "plan",
        strategy,
    )
    .await?;
    let raw = payload
        .get("plan")
        .cloned()
        .ok_or_else(|| error("helper_incompatible", "helper 未返回 plan"))?;
    serde_json::from_value(raw)
        .map_err(|_| error("helper_incompatible", "helper 返回的 plan 无法解析"))
}

fn write_locks() -> &'static tokio::sync::Mutex<HashSet<String>> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashSet<String>>> = OnceLock::new();
    LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashSet::new()))
}

fn write_key(repo: &Path) -> String {
    fs::canonicalize(repo)
        .unwrap_or_else(|_| repo.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

pub async fn apply(
    runtime: &TrellisRuntime,
    kit_root: &Path,
    repo: &Path,
    feature: &CompanySpecFeature,
    selection: Option<&str>,
    strategy: &str,
) -> Result<CompanySpecApplyResult, CompanySpecError> {
    validate_strategy(strategy)?;
    let plan = plan(runtime, kit_root, repo, feature, selection, strategy).await?;
    validate_strategy_for_action(&plan.action, strategy)?;
    let key = write_key(repo);
    let mut active = write_locks().lock().await;
    if active.contains(&key) {
        return Err(error("operation_in_progress", "该项目的公司规范操作正在进行中"));
    }
    active.insert(key.clone());
    let registry = company_spec::config(feature).registry;
    let result = run_helper(
        runtime,
        kit_root,
        repo,
        &registry,
        &plan.template,
        "apply",
        strategy,
    )
    .await;
    active.remove(&key);
    let payload = result?;
    let raw = payload
        .get("result")
        .cloned()
        .or_else(|| payload.get("apply").cloned())
        .unwrap_or(payload);
    serde_json::from_value(raw)
        .map_err(|_| error("helper_incompatible", "helper 返回的 apply 结果无法解析"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_template_ids_and_strategies() {
        assert!(validate_template_id("wit-frontend-vue2").is_ok());
        assert!(validate_template_id("Wit-Frontend").is_err());
        assert!(validate_template_id("-leading").is_err());
        assert!(validate_strategy("keep-local").is_ok());
        assert!(validate_strategy("merge").is_err());
        assert!(validate_strategy_for_action("update", "overwrite").is_ok());
        assert!(validate_strategy_for_action("update", "replace").is_err());
        assert!(validate_strategy_for_action("apply", "replace").is_ok());
        assert!(validate_strategy_for_action("apply", "keep-local").is_err());
    }

    #[test]
    fn reads_registry_spec_from_config_yaml() {
        let root = std::env::temp_dir().join(format!(
            "trellis-company-spec-config-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".trellis")).expect("create .trellis");
        std::fs::write(
            root.join(CONFIG_RELATIVE),
            "registry:\n\n  spec:\n    source: ssh://git@example.com/team/specs.git\n    template: wit-backend-java\n",
        )
        .expect("write config");
        let parsed = read_registry_spec(&root).expect("registry spec should parse");
        assert_eq!(parsed.0, "ssh://git@example.com/team/specs.git");
        assert_eq!(parsed.1, "wit-backend-java");
        std::fs::remove_dir_all(&root).ok();
    }
}
