use super::*;

fn association(task_space_id: &str, status: &str) -> agent_service::LocalAssociation {
    agent_service::LocalAssociation {
        project_id: "project-1".to_string(),
        task_space_id: task_space_id.to_string(),
        repo_path: format!("C:/work/{task_space_id}"),
        display_name: "repo".to_string(),
        branch_name: "main".to_string(),
        team_id: Some("team-1".to_string()),
        status: status.to_string(),
        detach_pending: false,
        initial_review_pending: false,
        read_only: false,
        live_sync_status: "idle".to_string(),
        live_sync_error: None,
        deferred_count: 0,
        deferred_task_dirs: Vec::new(),
        deferred_tasks: Vec::new(),
        last_error_code: None,
        last_error: None,
        ownership_paused_count: 0,
        ownership_paused_task_dirs: Vec::new(),
        ownership_pending_count: 0,
        ownership_pending_task_dirs: Vec::new(),
        pending_upload_count: 0,
        pending_upload_task_dirs: Vec::new(),
        pending_rejected_count: 0,
        pending_rejected_task_dirs: Vec::new(),
        conflict_pending_count: 0,
        conflict_pending_task_dirs: Vec::new(),
    }
}

#[test]
fn approved_association_requires_approved_status() {
    let associations = vec![
        association("space-1", "pending"),
        association("space-1", "approved"),
        association("space-2", "revoked"),
    ];
    let selected = approved_association_for_task_space(&associations, "space-1").unwrap();
    assert_eq!(selected.repo_path, "C:/work/space-1");
}

#[test]
fn approved_association_rejects_missing_or_unapproved() {
    let associations = vec![
        association("space-1", "pending"),
        association("space-2", "revoked"),
    ];
    for task_space_id in ["space-1", "space-2", "space-3"] {
        assert!(approved_association_for_task_space(&associations, task_space_id).is_err());
    }
}

#[test]
fn agent_tool_validation_caps_catalog_size() {
    let tools = (0..MAX_AGENT_TOOLS)
        .map(|index| format!("agent-{index}"))
        .collect::<Vec<_>>();
    assert_eq!(validate_agent_tools(&tools).unwrap().len(), MAX_AGENT_TOOLS);
    let too_many = (0..=MAX_AGENT_TOOLS)
        .map(|index| format!("agent-{index}"))
        .collect::<Vec<_>>();
    assert!(validate_agent_tools(&too_many).is_err());
    assert!(validate_agent_tools(&[]).is_err());
    assert!(validate_agent_tools(&["Claude Code".to_string()]).is_err());
}

#[test]
fn resolve_app_name_follows_runtime_build_product_default_priority() {
    assert_eq!(
        resolve_app_name(
            Some("Runtime Board"),
            Some("Build Board"),
            Some("Product Board")
        ),
        "Runtime Board"
    );
    assert_eq!(
        resolve_app_name(Some("  "), Some("  Build Board  "), Some("Product Board")),
        "Build Board"
    );
    assert_eq!(
        resolve_app_name(None, Some(""), Some("Acme Board")),
        "Acme Board"
    );
    assert_eq!(resolve_app_name(None, None, Some("  ")), "Board");
    assert_eq!(resolve_app_name(None, None, None), "Board");
}
