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
    std::fs::write(&executable, b"").expect("write");
    let dirs = vec![directory.join("missing"), directory.clone()];
    assert_eq!(
        find_in_path(&dirs, "node.exe").as_deref(),
        Some(executable.as_path())
    );
    assert_eq!(find_in_path(&dirs, "npm.cmd"), None);
    assert_eq!(find_in_path(&[], "node.exe"), None);
    let _ = std::fs::remove_dir_all(&directory);
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
    let _ = std::fs::remove_dir_all(&app_data);
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
        PathBuf::from(
            "C:\\data\\npm-global\\node_modules\\@mindfoldhq\\trellis\\bin\\trellis.js"
        )
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
