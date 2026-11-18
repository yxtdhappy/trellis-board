use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("trellis-env-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).expect("temp dir");
    directory
}

#[test]
fn parses_and_compares_versions() {
    assert_eq!(parse_version("v24.22.3\r\n").as_deref(), Some("24.22.3"));
    assert_eq!(parse_version("0.6.17").as_deref(), Some("0.6.17"));
    assert_eq!(parse_version("not-a-version"), None);
    assert_eq!(parse_version("24.22"), None);
    assert!(is_version_at_least("24.22.3", NODE_MIN_VERSION));
    assert!(is_version_at_least("v18.17.0", NODE_MIN_VERSION));
    assert!(!is_version_at_least("16.20.2", NODE_MIN_VERSION));
    assert!(!is_version_at_least("0.6.16", TRELLIS_VERSION));
    assert!(is_version_at_least("0.6.17", TRELLIS_VERSION));
}

#[test]
fn parses_python_version_output() {
    assert_eq!(
        parse_python_version("Python 3.12.8\r\n").as_deref(),
        Some("3.12.8")
    );
    assert_eq!(parse_python_version("3.12").as_deref(), Some("3.12.0"));
    assert_eq!(
        parse_python_version("Python 2.7.18").as_deref(),
        Some("2.7.18")
    );
    assert_eq!(parse_python_version("command not found"), None);
    assert_eq!(parse_python_version(""), None);
    assert!(!is_version_at_least("3.8.10", PYTHON_MIN_VERSION));
    assert!(is_version_at_least("3.9.0", PYTHON_MIN_VERSION));
    assert!(is_version_at_least("3.12.8", PYTHON_MIN_VERSION));
}

#[test]
fn rejects_corrupt_downloads() {
    let actual = hex(&Sha256::digest(b"not the node archive"));
    let error = verify_hash(&actual, NODE_ZIP_SHA256, "node:verify").expect_err("hash mismatch");
    assert_eq!(error.code, CODE_DOWNLOAD_CORRUPT);
    assert!(verify_hash(NODE_ZIP_SHA256, NODE_ZIP_SHA256, "node:verify").is_ok());
    assert_eq!(
        hex(&Sha256::digest(b"")),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn finds_executables_on_provided_path() {
    let directory = temp_dir("path");
    let executable = directory.join("node.exe");
    std::fs::write(&executable, b"node").expect("write");
    let dirs = vec![directory.join("missing"), directory.clone()];
    assert_eq!(
        find_in_path(&dirs, "node.exe").as_deref(),
        Some(executable.as_path())
    );
    assert_eq!(find_in_path(&dirs, "npm.cmd"), None);
    assert_eq!(find_in_path(&[], "node.exe"), None);
    let empty = directory.join("empty.exe");
    std::fs::write(&empty, b"").expect("write empty");
    assert_eq!(find_in_path(&[directory.clone()], "empty.exe"), None);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn nvm_version_dirs_are_probed() {
    let app_data = temp_dir("nvm");
    let version = app_data.join("nvm/v24.22.3");
    std::fs::create_dir_all(&version).expect("version dir");
    let dirs = fallback_dirs_in(Some(&app_data), None, None);
    assert!(dirs.contains(&version));
    assert!(dirs.contains(&app_data.join("nvm")));
    let _ = std::fs::remove_dir_all(&app_data);
}

#[test]
fn where_node_output_yields_parent_dirs() {
    let dirs = where_node_dirs(
        "C:\\Program Files\\nodejs\\node.exe\r\n\r\n\"C:\\nvm\\v24.22.3\\node.exe\"\r\nC:\\Windows\\System32\\where.exe\r\nC:\\nvm\\v24.22.3\\node.exe\r\n  C:\\fnm\\node.exe  \r\n",
    );
    assert_eq!(
        dirs,
        vec![
            PathBuf::from("C:\\Program Files\\nodejs"),
            PathBuf::from("C:\\nvm\\v24.22.3"),
            PathBuf::from("C:\\fnm"),
        ]
    );
    assert!(where_node_dirs("").is_empty());
    assert!(where_node_dirs("C:\\Windows\\node_modules\\.bin\\node.cmd").is_empty());
}

#[test]
fn where_python_output_yields_parent_dirs() {
    let dirs = where_python_dirs(
        "C:\\Python312\\python.exe\r\nC:\\Windows\\py.exe\r\n\"C:\\Program Files\\Python311\\python.exe\"\r\nC:\\Python312\\python.exe\r\n",
    );
    assert_eq!(
        dirs,
        vec![
            PathBuf::from("C:\\Python312"),
            PathBuf::from("C:\\Program Files\\Python311"),
        ]
    );
    assert!(where_python_dirs("C:\\Windows\\python3.exe").is_empty());
}

#[tokio::test]
async fn resolve_runtime_reuses_valid_flags_without_probing() {
    let directory = temp_dir("runtime-flags");
    let node = directory.join("node.exe");
    std::fs::write(&node, b"node").expect("node");
    let cli = directory.join("npm-global/node_modules/@mindfoldhq/trellis/bin/trellis.js");
    std::fs::create_dir_all(cli.parent().expect("cli parent")).expect("cli dir");
    std::fs::write(&cli, b"cli").expect("cli");
    std::fs::write(
        directory.join("npm-global/node_modules/@mindfoldhq/trellis/package.json"),
        r#"{"version":"0.6.17"}"#,
    )
    .expect("package");

    let mut config = json!({
        "node_runtime": {
            "version": "24.22.3",
            "path": node.display().to_string(),
            "source": "manual",
            "installed_at": ""
        },
        "trellis_runtime": {
            "version": "0.6.17",
            "cli_path": cli.display().to_string(),
            "source": "client-prefix",
            "installed_at": ""
        }
    });
    let (node_status, trellis_status, dirs, probed) =
        resolve_runtime(&directory, &mut config).await;
    assert!(node_status.ok);
    assert_eq!(node_status.source.as_deref(), Some("manual"));
    assert!(trellis_status.ok);
    assert!(dirs.is_empty());
    assert!(!probed);
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn node_has_npm_uses_given_dirs() {
    let directory = temp_dir("npm-dirs");
    std::fs::write(directory.join("npm.cmd"), b"npm").expect("npm");
    assert!(node_has_npm(
        Path::new("C:\\private\\node.exe"),
        std::slice::from_ref(&directory)
    ));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn manual_node_path_accepts_file_dir_and_quotes() {
    let directory = temp_dir("manual");
    let executable = directory.join("node.exe");
    std::fs::write(&executable, b"").expect("write node");
    let expected = Some(executable.clone());
    assert_eq!(
        node_executable_from_input(&directory.display().to_string()),
        expected
    );
    assert_eq!(
        node_executable_from_input(&executable.display().to_string()),
        expected
    );
    assert_eq!(
        node_executable_from_input(&format!("\"{}\"", executable.display())),
        expected
    );
    assert_eq!(node_executable_from_input("  "), None);
    assert_eq!(node_executable_from_input("C:\\missing\\node.exe"), None);
    assert_eq!(
        node_executable_from_input(&directory.join("npm.cmd").display().to_string()),
        None
    );
    let _ = std::fs::remove_dir_all(&directory);
}

#[tokio::test]
async fn set_node_path_rejects_missing_file_without_touching_config() {
    let mut document = serde_json::json!({ "node_runtime": { "path": "C:\\keep\\node.exe" } });
    let before = document.clone();
    let error = set_node_path(&mut document, "C:\\missing\\node.exe")
        .await
        .expect_err("missing node rejected");
    assert_eq!(error.code, CODE_NODE_PATH_INVALID);
    assert_eq!(document, before);
}

#[test]
fn fallback_dirs_cover_version_manager_prefixes() {
    let app_data = temp_dir("fallback");
    let alias = app_data.join("fnm/aliases/default");
    std::fs::create_dir_all(&alias).expect("alias dir");
    let version = app_data.join("fnm/node-versions/v24.12.0/installation");
    std::fs::create_dir_all(&version).expect("version dir");
    let dirs = fallback_dirs_in(
        Some(&app_data),
        Some(Path::new("C:\\local")),
        Some(Path::new("C:\\pf")),
    );
    assert!(dirs.contains(&alias));
    assert!(dirs.contains(&version));
    assert!(dirs.contains(&PathBuf::from("C:\\local\\Programs\\nodejs")));
    assert!(dirs.contains(&PathBuf::from("C:\\pf\\nodejs")));
    assert!(dirs.contains(&app_data.join("npm")));
    assert!(dirs.contains(&PathBuf::from("C:\\local\\pnpm")));
    let _ = std::fs::remove_dir_all(&app_data);
}

#[test]
fn python_dirs_cover_common_install_roots() {
    let local = temp_dir("py-local");
    let local_python = local.join("Programs/Python/Python312");
    std::fs::create_dir_all(&local_python).expect("local python dir");
    let program_files = temp_dir("py-pf");
    let all_users = program_files.join("Python311");
    std::fs::create_dir_all(&all_users).expect("program files python dir");
    std::fs::create_dir_all(program_files.join("Other")).expect("other dir");
    let drive = temp_dir("py-drive");
    let custom = drive.join("Python314");
    std::fs::create_dir_all(&custom).expect("custom python dir");
    std::fs::create_dir_all(drive.join("Windows")).expect("windows dir");

    let dirs = python_dirs_in(Some(&local), Some(&program_files), Some(&drive));
    assert!(dirs.contains(&local_python));
    assert!(dirs.contains(&all_users));
    assert!(dirs.contains(&custom));
    assert!(!dirs.contains(&program_files.join("Other")));
    assert!(!dirs.contains(&drive.join("Windows")));
    let _ = std::fs::remove_dir_all(&local);
    let _ = std::fs::remove_dir_all(&program_files);
    let _ = std::fs::remove_dir_all(&drive);
}

fn node_state(ok: bool) -> NodeStatus {
    NodeStatus {
        ok,
        version: ok.then(|| "24.13.0".to_string()),
        path: ok.then(|| "C:\\Program Files\\nodejs\\node.exe".to_string()),
        source: ok.then(|| "path".to_string()),
        min_version: NODE_MIN_VERSION.to_string(),
        found_version: None,
    }
}

fn trellis_state(ok: bool) -> TrellisStatus {
    TrellisStatus {
        ok,
        version: ok.then(|| TRELLIS_VERSION.to_string()),
        cli_path: ok.then(|| "C:\\data\\trellis.js".to_string()),
        source: ok.then(|| "global".to_string()),
        required_version: TRELLIS_VERSION.to_string(),
        found_version: None,
    }
}

fn python_state(ok: bool) -> PythonStatus {
    PythonStatus {
        ok,
        version: ok.then(|| "3.14.3".to_string()),
        path: ok.then(|| "C:\\Python314\\python.exe".to_string()),
        source: ok.then(|| "path".to_string()),
        min_version: PYTHON_MIN_VERSION.to_string(),
        found_version: None,
    }
}

#[test]
fn install_plan_only_installs_missing_components() {
    let ready = install_plan(&node_state(true), &trellis_state(true), &python_state(true));
    assert!(!ready.download_node);
    assert!(!ready.install_trellis);
    assert!(!ready.install_python);

    // 只缺 Trellis：不能因为私有 Node 不存在就重新下载 Node。
    let trellis_only = install_plan(
        &node_state(true),
        &trellis_state(false),
        &python_state(true),
    );
    assert!(!trellis_only.download_node);
    assert!(trellis_only.install_trellis);
    assert!(!trellis_only.install_python);

    let node_missing = install_plan(
        &node_state(false),
        &trellis_state(true),
        &python_state(true),
    );
    assert!(node_missing.download_node);
    assert!(!node_missing.install_trellis);
    assert!(!node_missing.install_python);
}

#[tokio::test]
async fn resolve_trellis_writes_flag_for_client_prefix() {
    let data_dir = temp_dir("trellis-prefix-flag");
    let package = data_dir.join("npm-global/node_modules/@mindfoldhq/trellis");
    std::fs::create_dir_all(package.join("bin")).expect("bin dir");
    std::fs::write(package.join("package.json"), r#"{"version":"0.6.17"}"#).expect("pkg");
    std::fs::write(package.join("bin/trellis.js"), b"cli").expect("cli");

    let mut config = json!({ "schemaVersion": 3 });
    let status = resolve_trellis(&data_dir, &mut config, &[]).await;
    assert!(status.ok);
    assert_eq!(status.source.as_deref(), Some("client-prefix"));
    let flag = config.trellis_runtime().expect("flag written");
    assert_eq!(flag.version, "0.6.17");
    assert_eq!(flag.source, "client-prefix");
    assert!(Path::new(&flag.cli_path).ends_with("trellis.js"));
    let _ = std::fs::remove_dir_all(&data_dir);
}

#[test]
fn finds_global_trellis_cli_in_prefix_dir() {
    let prefix = temp_dir("prefix");
    let package = prefix.join("node_modules/@mindfoldhq/trellis");
    std::fs::create_dir_all(package.join("bin")).expect("bin dir");
    std::fs::write(package.join("package.json"), r#"{"version":"0.6.17"}"#).expect("pkg");
    std::fs::write(package.join("bin/trellis.js"), b"").expect("cli");
    let (cli, source) = trellis_cli_in(&prefix).expect("cli in prefix");
    assert_eq!(source, "global");
    assert_eq!(read_package_version(&cli).as_deref(), Some("0.6.17"));
    assert!(trellis_cli_in(&prefix.join("missing")).is_none());
    let _ = std::fs::remove_dir_all(&prefix);
}

#[test]
fn reads_package_version_of_trellis_cli() {
    let directory = temp_dir("pkg");
    let package_root = directory.join("node_modules/@mindfoldhq/trellis");
    std::fs::create_dir_all(package_root.join("bin")).expect("bin dir");
    std::fs::write(
        package_root.join("package.json"),
        r#"{"name":"@mindfoldhq/trellis","version":"0.6.17"}"#,
    )
    .expect("write package");
    let cli = package_root.join("bin/trellis.js");
    std::fs::write(&cli, b"").expect("write cli");
    assert_eq!(read_package_version(&cli).as_deref(), Some("0.6.17"));
    let _ = std::fs::remove_dir_all(&directory);
}

#[test]
fn status_paths_live_under_data_dir() {
    let data_dir = Path::new("C:\\data");
    assert_eq!(
        node_exe_path(data_dir),
        PathBuf::from("C:\\data\\runtime\\node\\node.exe")
    );
    assert_eq!(
        download_dir(data_dir),
        PathBuf::from("C:\\data\\runtime\\download")
    );
    assert_eq!(
        trellis_cli_path(data_dir),
        PathBuf::from("C:\\data\\npm-global\\node_modules\\@mindfoldhq\\trellis\\bin\\trellis.js")
    );
    assert_eq!(
        npm_global_dir(data_dir),
        PathBuf::from("C:\\data\\npm-global")
    );
}

#[test]
fn runtime_state_serializes_to_expected_strings() {
    assert_eq!(
        serde_json::to_value(RuntimeState::NeedsSetup).expect("serialize"),
        json!("needs_setup")
    );
    assert_eq!(
        serde_json::to_value(RuntimeState::Ready).expect("serialize"),
        json!("ready")
    );
    let status = RuntimeStatus {
        state: RuntimeState::NeedsSetup,
        node: NodeStatus {
            ok: false,
            version: None,
            path: None,
            source: None,
            min_version: NODE_MIN_VERSION.to_string(),
            found_version: Some("16.20.2".to_string()),
        },
        trellis: TrellisStatus {
            ok: false,
            version: None,
            cli_path: None,
            source: None,
            required_version: TRELLIS_VERSION.to_string(),
            found_version: None,
        },
        download: DownloadInfo {
            version: NODE_DOWNLOAD_VERSION.to_string(),
            bytes: None,
        },
        python: PythonStatus {
            ok: false,
            version: None,
            path: None,
            source: None,
            min_version: PYTHON_MIN_VERSION.to_string(),
            found_version: Some("3.8.10".to_string()),
        },
    };
    let payload = serde_json::to_value(&status).expect("serialize status");
    assert_eq!(payload["state"], json!("needs_setup"));
    assert_eq!(payload["node"]["minVersion"], json!(NODE_MIN_VERSION));
    assert_eq!(payload["node"]["foundVersion"], json!("16.20.2"));
    assert_eq!(
        payload["trellis"]["requiredVersion"],
        json!(TRELLIS_VERSION)
    );
    assert_eq!(payload["python"]["minVersion"], json!(PYTHON_MIN_VERSION));
    assert_eq!(payload["python"]["foundVersion"], json!("3.8.10"));
    assert_eq!(payload["download"]["version"], json!(NODE_DOWNLOAD_VERSION));
}

#[test]
fn value_config_reads_and_clears_flags() {
    let mut config = json!({
        "schema_version": 3,
        "node_runtime": {
            "version": "24.22.3",
            "path": "C:\\data\\runtime\\node\\node.exe",
            "source": "downloaded",
            "installed_at": "2026-11-12T08:00:00Z"
        }
    });
    let node = config.node_runtime().expect("node flag");
    assert_eq!(node.version, "24.22.3");
    assert!(config.trellis_runtime().is_none());
    assert!(config.python_runtime().is_none());
    config.set_python_runtime(Some(PythonRuntimeFlag {
        version: "3.12.8".to_string(),
        path: "C:\\Python312\\python.exe".to_string(),
        source: "installed".to_string(),
        installed_at: "2026-11-13T08:00:00Z".to_string(),
    }));
    assert_eq!(
        config.python_runtime().expect("python flag").path,
        "C:\\Python312\\python.exe"
    );
    config.set_node_runtime(None);
    assert!(config.node_runtime().is_none());
    assert!(config.get("node_runtime").is_none());
    config.set_python_runtime(None);
    assert!(config.get("python_runtime").is_none());
}
