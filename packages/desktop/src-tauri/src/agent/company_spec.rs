//! 公司开发规范（company-spec）kit feature：读取 feature 描述、识别项目类型、
//! 选择模板并在初始化后校验落盘结果。生命周期更新见 `company_spec/lifecycle.rs`。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FEATURE_ID: &str = "company-spec";
const FEATURE_PATH: &str = "features/company-spec/feature.json";
const MAX_SCAN_BYTES: u64 = 1024 * 1024;
const MAX_EVIDENCE: usize = 20;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecFeature {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled_by_default: bool,
    pub registry: String,
    pub templates: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecTemplateOption {
    pub id: String,
    pub label: String,
    pub group: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecDetected {
    pub project_type: String,
    pub template: Option<String>,
    pub evidence: Vec<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecAvailability {
    pub available: bool,
    pub enabled_by_default: bool,
    pub name: String,
    pub templates: Vec<CompanySpecTemplateOption>,
    pub detected: CompanySpecDetected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanySpecConfig {
    pub feature_id: String,
    pub registry: String,
    pub templates: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanySpecChoice {
    Auto,
    Skip,
    Template(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanySpecRequest {
    pub config: CompanySpecConfig,
    pub choice: CompanySpecChoice,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanySpecSelection {
    pub project_type: Option<String>,
    pub template: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionResult {
    Selected(CompanySpecSelection),
    Skipped {
        project_type: String,
        reason: String,
        evidence: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanySpecInit<'a> {
    pub registry_url: &'a str,
    pub template: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanySpecOutcome {
    pub attempted: bool,
    pub applied: bool,
    pub project_type: Option<String>,
    pub template: Option<String>,
    pub warning: Option<String>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Detection {
    pub vue2: bool,
    pub mom3: bool,
    pub react: bool,
    pub node_backend: bool,
    pub java: bool,
    pub tauri: bool,
    pub monorepo: bool,
    pub evidence: Vec<String>,
}

fn read_limited(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SCAN_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&read_limited(path)?).ok()
}

fn push_evidence(detection: &mut Detection, evidence: String) {
    if detection.evidence.len() >= MAX_EVIDENCE || detection.evidence.contains(&evidence) {
        return;
    }
    detection.evidence.push(evidence);
}

fn relative_path(package_relative: &str, file: &str) -> String {
    if package_relative == "." || package_relative.is_empty() {
        file.to_string()
    } else {
        format!("{package_relative}/{file}")
    }
}

fn dependency_version<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    for section in ["dependencies", "devDependencies"] {
        if let Some(version) = value.get(section).and_then(|deps| deps.get(name)) {
            return version.as_str();
        }
    }
    None
}

fn dependency_present(value: &Value, name: &str) -> bool {
    dependency_version(value, name).is_some()
}

fn major_version(version: &str) -> Option<u32> {
    let digits: String = version
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn scan_package(repo: &Path, package_relative: &str, detection: &mut Detection) {
    let package_dir = repo.join(package_relative);
    let package_json = package_dir.join("package.json");
    let package = read_json(&package_json);
    let display = relative_path(package_relative, "package.json");

    if let Some(package) = &package {
        if dependency_present(package, "ant-design-vue")
            || dependency_present(package, "vue-template-compiler")
            || dependency_version(package, "vue")
                .and_then(major_version)
                .is_some_and(|major| major == 2)
        {
            detection.vue2 = true;
            push_evidence(detection, format!("{display}: Vue 2"));
        }
        if dependency_present(package, "@micro-zoe/micro-app") {
            detection.mom3 = true;
            push_evidence(detection, format!("{display}: @micro-zoe/micro-app"));
        }
        if dependency_present(package, "react") {
            detection.react = true;
            push_evidence(detection, format!("{display}: react"));
        }
        for framework in ["express", "koa", "fastify", "@nestjs/core", "hono"] {
            if dependency_present(package, framework) {
                detection.node_backend = true;
                push_evidence(detection, format!("{display}: {framework}"));
                break;
            }
        }
        if dependency_present(package, "@tauri-apps/api") {
            detection.tauri = true;
            push_evidence(detection, format!("{display}: @tauri-apps/api"));
        }
        if let Some(name) = package.get("name").and_then(Value::as_str) {
            if name.to_ascii_lowercase().contains("mom3") {
                detection.mom3 = true;
                push_evidence(detection, format!("{display}: package name contains mom3"));
            }
        }
        if package_relative.eq_ignore_ascii_case("packages/server")
            || package_relative.eq_ignore_ascii_case("server")
            || package_relative.eq_ignore_ascii_case("backend")
        {
            detection.node_backend = true;
            push_evidence(detection, format!("{display}: server package"));
        }
    }

    if package_relative.to_ascii_lowercase().contains("mom3") {
        detection.mom3 = true;
        push_evidence(detection, format!("{package_relative}: path contains mom3"));
    }

    for (file, label) in [
        ("pom.xml", "pom.xml"),
        ("build.gradle", "build.gradle"),
        ("build.gradle.kts", "build.gradle.kts"),
    ] {
        let path = package_dir.join(file);
        if !path.is_file() {
            continue;
        }
        detection.java = true;
        let evidence = format!("{}: {label}", relative_path(package_relative, file));
        if read_limited(&path)
            .is_some_and(|text| text.contains("spring-boot") || text.contains("springframework"))
        {
            push_evidence(detection, format!("{evidence} (Spring)"));
        } else {
            push_evidence(detection, evidence);
        }
    }

    let tauri_config = package_dir.join("src-tauri").join("tauri.conf.json");
    if tauri_config.is_file() {
        detection.tauri = true;
        push_evidence(
            detection,
            format!(
                "{}: src-tauri/tauri.conf.json",
                if package_relative == "." {
                    String::new()
                } else {
                    package_relative.to_string()
                }
            ),
        );
    }
}

fn expand_workspace_pattern(repo: &Path, pattern: &str) -> Vec<PathBuf> {
    let trimmed = pattern.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() || trimmed == "." {
        return Vec::new();
    }
    if let Some(prefix) = trimmed.strip_suffix("/*") {
        let root = repo.join(prefix);
        let Ok(entries) = fs::read_dir(root) else {
            return Vec::new();
        };
        return entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.path())
            .collect();
    }
    if trimmed.contains('*') {
        return Vec::new();
    }
    let path = repo.join(trimmed);
    path.is_dir().then_some(path).into_iter().collect()
}

fn workspace_patterns(repo: &Path) -> Vec<String> {
    let mut patterns = Vec::new();
    if let Some(package) = read_json(&repo.join("package.json")) {
        if let Some(workspaces) = package.get("workspaces") {
            let values = workspaces
                .as_array()
                .cloned()
                .or_else(|| workspaces.get("packages").and_then(Value::as_array).cloned())
                .unwrap_or_default();
            for value in values {
                if let Some(pattern) = value.as_str() {
                    patterns.push(pattern.to_string());
                }
            }
        }
    }
    if let Some(pnpm) = read_limited(&repo.join("pnpm-workspace.yaml")) {
        let mut in_packages = false;
        for line in pnpm.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("packages:") {
                in_packages = true;
                continue;
            }
            if !in_packages {
                continue;
            }
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if let Some(value) = trimmed.strip_prefix('-') {
                patterns.push(value.trim().trim_matches('"').trim_matches('\'').to_string());
            } else {
                in_packages = false;
            }
        }
    }
    if let Some(lerna) = read_json(&repo.join("lerna.json")) {
        if let Some(values) = lerna.get("packages").and_then(Value::as_array) {
            for value in values {
                if let Some(pattern) = value.as_str() {
                    patterns.push(pattern.to_string());
                }
            }
        }
    }
    patterns
}

fn is_monorepo(repo: &Path) -> bool {
    if repo.join("pnpm-workspace.yaml").is_file() || repo.join("lerna.json").is_file() {
        return true;
    }
    read_json(&repo.join("package.json"))
        .and_then(|package| package.get("workspaces").cloned())
        .is_some_and(|workspaces| {
            workspaces
                .as_array()
                .is_some_and(|values| !values.is_empty())
                || workspaces
                    .get("packages")
                    .and_then(Value::as_array)
                    .is_some_and(|values| !values.is_empty())
        })
}

/// 只读扫描项目根及一层 workspace 包；任何读取失败都跳过，不影响初始化。
pub fn detect(repo: &Path) -> Detection {
    let mut detection = Detection::default();
    detection.monorepo = is_monorepo(repo);
    if detection.monorepo {
        push_evidence(&mut detection, "package.json: workspaces/pnpm/lerna".to_string());
    }

    scan_package(repo, ".", &mut detection);
    let mut packages: Vec<String> = Vec::new();
    for pattern in workspace_patterns(repo) {
        for path in expand_workspace_pattern(repo, &pattern) {
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            let parent = path
                .parent()
                .and_then(|value| value.strip_prefix(repo).ok())
                .map(|value| value.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            let relative = if parent.is_empty() {
                name.to_string()
            } else {
                format!("{parent}/{name}")
            };
            if !packages.contains(&relative) {
                packages.push(relative);
            }
        }
    }
    packages.sort();
    for package in packages {
        scan_package(repo, &package, &mut detection);
    }
    detection
}

fn selected_template(
    project_type: &str,
    templates: &BTreeMap<String, String>,
) -> SelectionResult {
    match templates.get(project_type) {
        Some(template) => SelectionResult::Selected(CompanySpecSelection {
            project_type: Some(project_type.to_string()),
            template: template.clone(),
            evidence: Vec::new(),
        }),
        None => SelectionResult::Skipped {
            project_type: project_type.to_string(),
            reason: format!("没有匹配 {project_type} 的公司规范模板"),
            evidence: Vec::new(),
        },
    }
}

/// 纯函数：只处理自动识别；冲突、monorepo、unknown 都返回 Skipped。
pub fn select_template(
    detection: &Detection,
    templates: &BTreeMap<String, String>,
) -> SelectionResult {
    if detection.monorepo {
        return SelectionResult::Skipped {
            project_type: "monorepo".to_string(),
            reason: "workspace monorepo 暂不自动套用公司规范，请按包单独初始化".to_string(),
            evidence: detection.evidence.clone(),
        };
    }
    if detection.vue2 && detection.react {
        return SelectionResult::Skipped {
            project_type: "conflict".to_string(),
            reason: "同时检测到 Vue 2 与 React，请手动选择模板或检查项目结构".to_string(),
            evidence: detection.evidence.clone(),
        };
    }

    let frontend = if detection.mom3 {
        Some("mom3")
    } else if detection.vue2 {
        Some("vue2")
    } else if detection.react {
        Some("react")
    } else {
        None
    };
    let backend = if detection.java {
        Some("java")
    } else if detection.node_backend {
        Some("node")
    } else {
        None
    };

    let project_type = match (frontend, backend) {
        (Some(frontend), Some(backend)) => format!("{frontend}-{backend}"),
        (Some(frontend), None) => frontend.to_string(),
        (None, Some(backend)) => backend.to_string(),
        (None, None) => "unknown".to_string(),
    };
    if project_type == "unknown" {
        return SelectionResult::Skipped {
            project_type,
            reason: "未识别出可映射的项目类型".to_string(),
            evidence: detection.evidence.clone(),
        };
    }
    match selected_template(&project_type, templates) {
        SelectionResult::Selected(mut selection) => {
            selection.evidence = detection.evidence.clone();
            SelectionResult::Selected(selection)
        }
        SelectionResult::Skipped {
            project_type,
            reason,
            ..
        } => SelectionResult::Skipped {
            project_type,
            reason,
            evidence: detection.evidence.clone(),
        },
    }
}

pub fn resolve_manual(
    template: &str,
    config: &CompanySpecConfig,
    detection: &Detection,
) -> SelectionResult {
    if detection.monorepo {
        return SelectionResult::Skipped {
            project_type: "monorepo".to_string(),
            reason: "workspace monorepo 暂不自动套用公司规范，请按包单独初始化".to_string(),
            evidence: detection.evidence.clone(),
        };
    }
    let project_type = config
        .templates
        .iter()
        .find_map(|(key, value)| (value == template).then(|| key.clone()));
    if project_type.is_none() {
        return SelectionResult::Skipped {
            project_type: "unknown".to_string(),
            reason: format!("未知的公司规范模板：{template}"),
            evidence: detection.evidence.clone(),
        };
    }
    SelectionResult::Selected(CompanySpecSelection {
        project_type,
        template: template.to_string(),
        evidence: detection.evidence.clone(),
    })
}

pub fn parse_choice(
    input: Option<&str>,
    enabled_by_default: bool,
) -> (CompanySpecChoice, Option<String>) {
    let Some(input) = input else {
        return if enabled_by_default {
            (CompanySpecChoice::Auto, None)
        } else {
            (CompanySpecChoice::Skip, None)
        };
    };
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return (
            CompanySpecChoice::Skip,
            Some("公司规范选择为空，已跳过".to_string()),
        );
    }
    match trimmed {
        "auto" => (CompanySpecChoice::Auto, None),
        "none" => (CompanySpecChoice::Skip, None),
        other => (CompanySpecChoice::Template(other.to_string()), None),
    }
}

pub fn template_options(feature: &CompanySpecFeature) -> Vec<CompanySpecTemplateOption> {
    let mut templates: Vec<CompanySpecTemplateOption> = feature
        .templates
        .values()
        .map(|id| template_option(id))
        .collect();
    templates.sort_by(|left, right| left.id.cmp(&right.id));
    templates
}

fn template_option(id: &str) -> CompanySpecTemplateOption {
    let (label, group) = match id {
        "wit-frontend-vue2" => ("前端 Vue 2", "frontend"),
        "wit-frontend-mom3" => ("前端 MOM3", "frontend"),
        "wit-frontend-react" => ("前端 React", "frontend"),
        "wit-backend-java" => ("后端 Java", "backend"),
        "wit-backend-node" => ("后端 Node.js", "backend"),
        "wit-fullstack-vue2-java" => ("全栈 Vue 2 + Java", "fullstack"),
        "wit-fullstack-mom3-java" => ("全栈 MOM3 + Java", "fullstack"),
        "wit-fullstack-react-java" => ("全栈 React + Java", "fullstack"),
        "wit-fullstack-react-node" => ("全栈 React + Node.js", "fullstack"),
        other => (other, "other"),
    };
    CompanySpecTemplateOption {
        id: id.to_string(),
        label: label.to_string(),
        group: group.to_string(),
    }
}

fn env_override(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// 读取 `<kit_root>/features/company-spec/feature.json`；任何契约不满足都返回 None。
pub fn load_feature(kit_root: Option<&Path>) -> Option<CompanySpecFeature> {
    let Some(kit_root) = kit_root else {
        return None;
    };
    let path = kit_root.join(FEATURE_PATH);
    let Some(text) = read_limited(&path) else {
        crate::logging::warn(&format!("公司规范 feature 缺失或不可读：{}", path.display()));
        return None;
    };
    let feature: CompanySpecFeature = match serde_json::from_str(&text) {
        Ok(feature) => feature,
        Err(error) => {
            crate::logging::warn(&format!("公司规范 feature.json 解析失败：{error}"));
            return None;
        }
    };
    if feature.id != FEATURE_ID
        || feature.registry.trim().is_empty()
        || feature.templates.is_empty()
    {
        crate::logging::warn("公司规范 feature.json 契约不完整，已禁用");
        return None;
    }
    Some(feature)
}

pub fn config(feature: &CompanySpecFeature) -> CompanySpecConfig {
    CompanySpecConfig {
        feature_id: feature.id.clone(),
        registry: env_override("TRELLIS_COMPANY_SPEC_REGISTRY")
            .unwrap_or_else(|| feature.registry.clone()),
        templates: feature.templates.clone(),
    }
}

fn detected_from_result(result: &SelectionResult) -> CompanySpecDetected {
    match result {
        SelectionResult::Selected(selection) => CompanySpecDetected {
            project_type: selection
                .project_type
                .clone()
                .unwrap_or_else(|| "unknown".to_string()),
            template: Some(selection.template.clone()),
            evidence: selection.evidence.clone(),
            warning: None,
        },
        SelectionResult::Skipped {
            project_type,
            reason,
            evidence,
        } => CompanySpecDetected {
            project_type: project_type.clone(),
            template: None,
            evidence: evidence.clone(),
            warning: Some(reason.clone()),
        },
    }
}

pub fn availability(kit_root: Option<&Path>, repo: &Path) -> Option<CompanySpecAvailability> {
    let feature = load_feature(kit_root)?;
    if env_override("TRELLIS_COMPANY_SPEC_ENABLED").as_deref() == Some("0") {
        return None;
    }
    let enabled_by_default = feature.enabled_by_default
        || env_override("TRELLIS_COMPANY_SPEC_ENABLED").as_deref() == Some("1");
    let detection = detect(repo);
    let selection = select_template(&detection, &feature.templates);
    Some(CompanySpecAvailability {
        available: true,
        enabled_by_default,
        name: feature.name.clone(),
        templates: template_options(&feature),
        detected: detected_from_result(&selection),
    })
}

pub fn describe_detection(
    repo: &Path,
    templates: &BTreeMap<String, String>,
) -> CompanySpecDetected {
    let detection = detect(repo);
    detected_from_result(&select_template(&detection, templates))
}

pub fn template_entrypoints(template: &str) -> &'static [&'static str] {
    entrypoints_for(template)
}

fn entrypoints_for(template: &str) -> &'static [&'static str] {
    if template.starts_with("wit-fullstack-") {
        &["frontend/index.md", "backend/index.md"]
    } else if template.starts_with("wit-frontend-") {
        &["frontend/index.md"]
    } else if template.starts_with("wit-backend-") {
        &["backend/index.md"]
    } else {
        &[]
    }
}

/// 校验模板确实落在目标项目：marker.template 一致且入口文件存在。
pub fn verify(repo: &Path, selection: &CompanySpecSelection) -> Result<(), String> {
    let marker_path = repo.join(".trellis/spec/.company-spec.json");
    let Some(text) = read_limited(&marker_path) else {
        return Err("公司规范标记文件未生成".to_string());
    };
    let marker: Value = serde_json::from_str(&text)
        .map_err(|_| "公司规范标记文件不是合法 JSON".to_string())?;
    if marker.get("template").and_then(Value::as_str) != Some(selection.template.as_str()) {
        return Err(format!(
            "公司规范标记模板不匹配：期望 {}",
            selection.template
        ));
    }
    for entrypoint in entrypoints_for(&selection.template) {
        if !repo.join(".trellis/spec").join(entrypoint).is_file() {
            return Err(format!("公司规范入口缺失：{entrypoint}"));
        }
    }
    Ok(())
}

pub mod lifecycle;

#[cfg(test)]
mod tests;
