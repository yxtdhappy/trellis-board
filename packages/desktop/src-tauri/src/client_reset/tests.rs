use super::*;

fn temp_data_dir(label: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "trellis-reset-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    let data = root.join("data");
    fs::create_dir_all(&data).expect("create data dir");
    (root, data)
}

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, contents).expect("write file");
}

#[test]
fn server_switched_ignores_formatting_and_treats_first_login_as_no_switch() {
    assert!(!server_switched(None, "https://board.example.com").unwrap());
    assert!(!server_switched(Some("   "), "https://board.example.com").unwrap());
    assert!(
        !server_switched(Some("https://board.example.com"), "https://board.example.com/").unwrap()
    );
    assert!(
        !server_switched(Some("https://board.example.com:443"), "https://BOARD.example.com")
            .unwrap()
    );
    assert!(!server_switched(
        Some("https://board.example.com/app"),
        "https://board.example.com/app/"
    )
    .unwrap());
    assert!(server_switched(
        Some("https://board.example.com"),
        "https://board.example.com/app"
    )
    .unwrap());
    assert!(server_switched(Some("https://old.example.com"), "https://new.example.com").unwrap());
    assert!(server_switched(Some("https://board.example.com"), "http://board.example.com").unwrap());
}

#[test]
fn backup_and_clear_touches_only_login_and_binding_data() {
    let (root, data) = temp_data_dir("scope");
    write(&data.join("client.json"), r#"{"serverUrl":"https://old"}"#);
    write(&data.join("agent/config.json"), "{}");
    write(&data.join("agent/credential.dpapi"), "secret");
    write(&data.join("desktop-plugins/hash/user/secrets.json"), "{}");
    write(&data.join("runtime/node/node.exe"), "node");
    write(&data.join("npm-global/bin/x"), "x");
    write(&data.join("updates/1.0.0/setup.exe"), "zip");
    write(&data.join("plugins/user-plugin/index.js"), "code");
    write(&data.join("logs/desktop.log"), "log");
    write(&data.join("appearance.json"), "{}");

    let outcome = backup_and_clear(&data, Local::now()).expect("backup and clear");

    for name in RESET_ITEMS {
        assert!(!data.join(name).exists(), "{name} should be removed");
        assert!(
            outcome.backup_dir.join(name).exists(),
            "{name} should be backed up"
        );
    }
    for name in [
        "runtime",
        "npm-global",
        "updates",
        "plugins",
        "logs",
        "appearance.json",
    ] {
        assert!(data.join(name).exists(), "{name} must be kept");
    }
    assert_eq!(outcome.backup_dir.parent(), Some(root.as_path()));
    assert_eq!(outcome.removed.len(), RESET_ITEMS.len());
}

#[test]
fn backup_and_clear_skips_missing_items() {
    let (_root, data) = temp_data_dir("missing");
    write(&data.join("client.json"), "{}");

    let outcome = backup_and_clear(&data, Local::now()).expect("backup and clear");

    assert_eq!(outcome.removed, vec!["client.json".to_string()]);
    assert!(outcome.backup_dir.join("client.json").exists());
    assert!(!outcome.backup_dir.join("agent").exists());
}

#[test]
fn restore_puts_cleared_items_back() {
    let (_root, data) = temp_data_dir("restore");
    write(&data.join("client.json"), r#"{"username":"alice"}"#);
    write(&data.join("agent/config.json"), r#"{"agentId":"a1"}"#);
    let outcome = backup_and_clear(&data, Local::now()).expect("backup and clear");
    // 登录失败前可能已经写入半成品，恢复必须以备份为准。
    write(&data.join("agent/config.json"), r#"{"agentId":"new"}"#);

    restore(&outcome).expect("restore");

    assert_eq!(
        fs::read_to_string(data.join("client.json")).unwrap(),
        r#"{"username":"alice"}"#
    );
    assert_eq!(
        fs::read_to_string(data.join("agent/config.json")).unwrap(),
        r#"{"agentId":"a1"}"#
    );
}

#[test]
fn prune_keeps_three_newest_backups() {
    let (root, data) = temp_data_dir("prune");
    for name in [
        "data-backup-20260101-000001",
        "data-backup-20260102-000002",
        "data-backup-20260103-000003",
        "data-backup-20260104-000004",
    ] {
        fs::create_dir_all(root.join(name)).expect("create backup dir");
    }

    let removed = prune_backups(&root, KEEP_BACKUPS);

    assert_eq!(removed.len(), 1);
    assert!(!root.join("data-backup-20260101-000001").exists());
    assert!(root.join("data-backup-20260104-000004").exists());
    assert!(data.exists(), "data dir is not a backup dir");
}

#[test]
fn second_backup_in_same_second_gets_suffix() {
    let (_root, data) = temp_data_dir("suffix");
    let fixed = Local::now();
    write(&data.join("client.json"), "{}");
    let first = backup_and_clear(&data, fixed).expect("first backup");
    write(&data.join("client.json"), "{}");
    let second = backup_and_clear(&data, fixed).expect("second backup");

    assert_ne!(first.backup_dir, second.backup_dir);
    let name = second.backup_dir.file_name().unwrap().to_str().unwrap();
    assert!(name.ends_with("-2"), "unexpected backup dir: {name}");
}

#[cfg(windows)]
#[test]
fn backup_failure_leaves_data_untouched() {
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;

    let (root, data) = temp_data_dir("locked");
    write(&data.join("client.json"), "{}");
    write(&data.join("agent/config.json"), "{}");
    // 独占句柄让复制读取失败，模拟备份中断；源数据必须原样保留。
    let _lock = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(data.join("agent/config.json"))
        .expect("lock file");

    let error = backup_and_clear(&data, Local::now()).expect_err("backup must fail");

    assert!(error.contains("备份客户端数据失败"), "unexpected: {error}");
    assert!(data.join("client.json").exists());
    assert!(data.join("agent/config.json").exists());
    let partial: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(BACKUP_PREFIX))
        .collect();
    assert!(partial.is_empty(), "partial backup must be removed");
}
