use super::{
    clean_param, clear, enqueue, parse, take, EnqueueResult, PendingShare, MAX_PARAM_LENGTH,
};

fn link(server: &str, space: &str, task: &str) -> String {
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("server", server)
        .append_pair("space", space)
        .append_pair("task", task)
        .finish();
    format!("spec-board://task?{encoded}")
}

#[test]
fn parses_http_and_https_boards() {
    let http = parse(&link("http://192.168.1.8:8080", "11-24-share", "task-a")).unwrap();
    assert_eq!(http.server, "http://192.168.1.8:8080");
    assert_eq!(http.task_space_id, "11-24-share");
    assert_eq!(http.task_id, "task-a");

    let https = parse(&link("https://board.example.com", "space", "task")).unwrap();
    assert_eq!(https.server, "https://board.example.com");
}

#[test]
fn normalizes_default_port_out_of_server_origin() {
    let target = parse(&link("http://board.example.com:80/", "space", "task")).unwrap();
    assert_eq!(target.server, "http://board.example.com");
}

#[test]
fn rejects_links_that_do_not_point_at_a_board_task() {
    assert!(parse("https://board.example.com/share.html?space=s&task=t").is_none());
    assert!(parse("spec-board://other?server=http://board.example.com&space=s&task=t").is_none());
    assert!(parse("spec-board://task?server=http://board.example.com&space=s").is_none());
    assert!(parse("spec-board://task?space=s&task=t").is_none());
    assert!(
        parse("spec-board://task?server=http://board.example.com/sub&space=s&task=t").is_none()
    );
    assert!(parse("spec-board://task?server=javascript:alert(1)&space=s&task=t").is_none());
    assert!(parse("").is_none());
}

#[test]
fn rejects_oversized_or_blank_locators() {
    assert!(parse(&link("http://board.example.com", "space", "   ")).is_none());
    assert!(parse(&link(
        "http://board.example.com",
        &"s".repeat(MAX_PARAM_LENGTH + 1),
        "task"
    ))
    .is_none());
    assert_eq!(clean_param(" task ").as_deref(), Some("task"));
}

#[test]
fn enqueue_deduplicates_and_overwrites_valid_targets() {
    let mut slot = None;
    let first = link("http://127.0.0.1:4317", "space-1", "task-1");
    let second = link("http://127.0.0.1:4317", "space-1", "task-2");

    assert_eq!(
        enqueue(&mut slot, &first),
        EnqueueResult {
            notify: true,
            valid: true
        }
    );
    assert_eq!(
        enqueue(&mut slot, &first),
        EnqueueResult {
            notify: false,
            valid: true
        }
    );
    assert_eq!(
        enqueue(&mut slot, &second),
        EnqueueResult {
            notify: true,
            valid: true
        }
    );
    assert_eq!(
        slot,
        Some(PendingShare::Target {
            server: "http://127.0.0.1:4317".to_string(),
            task_space_id: "space-1".to_string(),
            task_id: "task-2".to_string(),
        })
    );
}

#[test]
fn invalid_link_notifies_without_clobbering_valid_target() {
    let mut slot = None;
    assert_eq!(
        enqueue(&mut slot, "spec-board://task?space=only"),
        EnqueueResult {
            notify: true,
            valid: false
        }
    );
    assert_eq!(slot, Some(PendingShare::Invalid));
    assert_eq!(
        enqueue(&mut slot, "spec-board://task?space=only-again"),
        EnqueueResult {
            notify: false,
            valid: false
        }
    );

    let valid = link("http://127.0.0.1:4317", "space-1", "task-1");
    assert_eq!(
        enqueue(&mut slot, &valid),
        EnqueueResult {
            notify: true,
            valid: true
        }
    );
    assert!(matches!(slot, Some(PendingShare::Target { .. })));

    assert_eq!(
        enqueue(&mut slot, "spec-board://task?space=only"),
        EnqueueResult {
            notify: false,
            valid: false
        }
    );
    assert!(matches!(slot, Some(PendingShare::Target { .. })));
}

#[test]
fn take_drains_and_clear_resets_pending_share() {
    let mut slot = None;
    let valid = link("http://127.0.0.1:4317", "space-1", "task-1");
    enqueue(&mut slot, &valid);
    assert!(matches!(take(&mut slot), Some(PendingShare::Target { .. })));
    assert!(take(&mut slot).is_none());

    enqueue(&mut slot, &valid);
    clear(&mut slot);
    assert!(slot.is_none());

    enqueue(&mut slot, "spec-board://task?space=only");
    clear(&mut slot);
    assert!(slot.is_none());
}

#[test]
fn serializes_pending_share_with_camel_case_tag_and_fields() {
    let target = PendingShare::Target {
        server: "http://127.0.0.1:4317".to_string(),
        task_space_id: "space-1".to_string(),
        task_id: "task-1".to_string(),
    };
    assert_eq!(
        serde_json::to_value(&target).unwrap(),
        serde_json::json!({
            "kind": "target",
            "server": "http://127.0.0.1:4317",
            "taskSpaceId": "space-1",
            "taskId": "task-1",
        })
    );
    assert_eq!(
        serde_json::to_value(PendingShare::Invalid).unwrap(),
        serde_json::json!({ "kind": "invalid" })
    );
}
