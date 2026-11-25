use super::*;
use std::collections::BTreeMap;
use std::path::PathBuf;

fn templates() -> BTreeMap<String, String> {
    [
        ("vue2", "wit-frontend-vue2"),
        ("mom3", "wit-frontend-mom3"),
        ("react", "wit-frontend-react"),
        ("java", "wit-backend-java"),
        ("node", "wit-backend-node"),
        ("vue2-java", "wit-fullstack-vue2-java"),
        ("mom3-java", "wit-fullstack-mom3-java"),
        ("react-java", "wit-fullstack-react-java"),
        ("react-node", "wit-fullstack-react-node"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .collect()
}

fn detection() -> Detection {
    Detection::default()
}

fn temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "trellis-company-spec-{label}-{}",
        uuid::Uuid::new_v4()
    ))
}

#[test]
fn parses_choice_with_default_and_explicit_values() {
    assert_eq!(
        parse_choice(None, true),
        (CompanySpecChoice::Auto, None)
    );
    assert_eq!(
        parse_choice(None, false),
        (CompanySpecChoice::Skip, None)
    );
    assert_eq!(
        parse_choice(Some("auto"), false),
        (CompanySpecChoice::Auto, None)
    );
    assert_eq!(
        parse_choice(Some("none"), true),
        (CompanySpecChoice::Skip, None)
    );
    assert_eq!(
        parse_choice(Some("wit-frontend-vue2"), false),
        (
            CompanySpecChoice::Template("wit-frontend-vue2".to_string()),
            None
        )
    );
    let (choice, warning) = parse_choice(Some("  "), true);
    assert_eq!(choice, CompanySpecChoice::Skip);
    assert!(warning.is_some());
}

#[test]
fn selects_fullstack_template_from_frontend_and_backend() {
    let mut detected = detection();
    detected.vue2 = true;
    detected.java = true;
    detected.evidence = vec!["package.json: Vue 2".to_string()];
    let result = select_template(&detected, &templates());
    match result {
        SelectionResult::Selected(selection) => {
            assert_eq!(selection.project_type.as_deref(), Some("vue2-java"));
            assert_eq!(selection.template, "wit-fullstack-vue2-java");
        }
        other => panic!("expected selected, got {other:?}"),
    }
}

#[test]
fn mom3_wins_over_vue2_and_conflicts_skip() {
    let mut detected = detection();
    detected.vue2 = true;
    detected.mom3 = true;
    detected.java = true;
    let result = select_template(&detected, &templates());
    match result {
        SelectionResult::Selected(selection) => {
            assert_eq!(selection.template, "wit-fullstack-mom3-java");
        }
        other => panic!("expected selected, got {other:?}"),
    }

    let mut conflict = detection();
    conflict.vue2 = true;
    conflict.react = true;
    assert!(matches!(
        select_template(&conflict, &templates()),
        SelectionResult::Skipped { project_type, .. } if project_type == "conflict"
    ));
}

#[test]
fn monorepo_and_unknown_skip() {
    let mut monorepo = detection();
    monorepo.monorepo = true;
    monorepo.vue2 = true;
    assert!(matches!(
        select_template(&monorepo, &templates()),
        SelectionResult::Skipped { project_type, .. } if project_type == "monorepo"
    ));

    assert!(matches!(
        select_template(&detection(), &templates()),
        SelectionResult::Skipped { project_type, .. } if project_type == "unknown"
    ));
}

#[test]
fn manual_selection_validates_template_and_monorepo() {
    let config = CompanySpecConfig {
        feature_id: "company-spec".to_string(),
        registry: "ssh://example.com/team/specs.git".to_string(),
        templates: templates(),
    };
    match resolve_manual("wit-backend-java", &config, &detection()) {
        SelectionResult::Selected(selection) => {
            assert_eq!(selection.project_type.as_deref(), Some("java"));
        }
        other => panic!("expected selected, got {other:?}"),
    }
    assert!(matches!(
        resolve_manual("unknown-template", &config, &detection()),
        SelectionResult::Skipped { .. }
    ));

    let mut monorepo = detection();
    monorepo.monorepo = true;
    assert!(matches!(
        resolve_manual("wit-backend-java", &config, &monorepo),
        SelectionResult::Skipped { project_type, .. } if project_type == "monorepo"
    ));
}

#[test]
fn detects_vue2_java_and_tauri_evidence() {
    let root = temp_dir("detect");
    std::fs::create_dir_all(root.join("src-tauri")).expect("create src-tauri");
    std::fs::write(
        root.join("package.json"),
        r#"{"dependencies":{"vue":"^2.6.11","ant-design-vue":"1.7.8"}}"#,
    )
    .expect("write package.json");
    std::fs::write(root.join("pom.xml"), "<project><spring-boot/></project>")
        .expect("write pom.xml");
    std::fs::write(root.join("src-tauri/tauri.conf.json"), "{}").expect("write tauri conf");

    let detected = detect(&root);
    assert!(detected.vue2);
    assert!(detected.java);
    assert!(detected.tauri);
    assert!(!detected.react);
    assert!(detected
        .evidence
        .iter()
        .any(|item| item.contains("package.json: Vue 2")));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn detects_monorepo_from_workspaces() {
    let root = temp_dir("monorepo");
    std::fs::create_dir_all(root.join("packages/web")).expect("create packages");
    std::fs::write(
        root.join("package.json"),
        r#"{"workspaces":["packages/*"]}"#,
    )
    .expect("write root package.json");
    std::fs::write(
        root.join("packages/web/package.json"),
        r#"{"dependencies":{"vue":"2.7.0"}}"#,
    )
    .expect("write web package.json");

    let detected = detect(&root);
    assert!(detected.monorepo);
    assert!(detected.vue2);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn verify_requires_matching_marker_and_entrypoint() {
    let root = temp_dir("verify");
    std::fs::create_dir_all(root.join(".trellis/spec/frontend")).expect("create spec");
    std::fs::write(
        root.join(".trellis/spec/.company-spec.json"),
        r#"{"template":"wit-frontend-vue2"}"#,
    )
    .expect("write marker");
    std::fs::write(root.join(".trellis/spec/frontend/index.md"), "# 规范").expect("write index");

    let selection = CompanySpecSelection {
        project_type: Some("vue2".to_string()),
        template: "wit-frontend-vue2".to_string(),
        evidence: Vec::new(),
    };
    assert!(verify(&root, &selection).is_ok());

    let wrong = CompanySpecSelection {
        template: "wit-frontend-react".to_string(),
        ..selection
    };
    assert!(verify(&root, &wrong).is_err());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn loads_feature_descriptor_and_applies_env_registry_override() {
    let root = temp_dir("feature");
    let feature_dir = root.join("features/company-spec");
    std::fs::create_dir_all(&feature_dir).expect("create feature dir");
    std::fs::write(
        feature_dir.join("feature.json"),
        r#"{
            "schemaVersion":1,
            "id":"company-spec",
            "name":"公司开发规范",
            "version":"1.0.0",
            "enabledByDefault":false,
            "registry":"ssh://example.com/team/specs.git",
            "templates":{"vue2":"wit-frontend-vue2"}
        }"#,
    )
    .expect("write feature");

    let feature = load_feature(Some(&root)).expect("feature should load");
    assert_eq!(feature.id, "company-spec");
    assert!(!feature.enabled_by_default);
    assert_eq!(
        feature.templates.get("vue2").map(String::as_str),
        Some("wit-frontend-vue2")
    );
    std::fs::remove_dir_all(&root).ok();
}
