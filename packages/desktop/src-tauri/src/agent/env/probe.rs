use super::*;

// ---------------------------------------------------------------- PATH 探测

pub(super) fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub(super) fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from)
}

pub(super) fn subdirs(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// PATH 之外还要找目录：客户端由资源管理器启动时，`PATH` 是机器/用户环境变量，
/// 不含 fnm、nvm、Volta 这类按 shell 注入的目录，但它们的前缀目录就在用户目录里。
pub(super) fn fallback_dirs_in(
    app_data: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(app_data) = app_data {
        let fnm = app_data.join("fnm");
        // fnm：`aliases/<别名>` 是该版本的前缀目录（node.exe + node_modules 都在里面），
        // `node-versions/<版本>/installation` 是未设别名时的兜底。
        dirs.extend(subdirs(&fnm.join("aliases")));
        dirs.extend(
            subdirs(&fnm.join("node-versions"))
                .into_iter()
                .map(|dir| dir.join("installation")),
        );
        dirs.push(app_data.join("nvm"));
        // Windows 默认 npm 全局前缀；PATH 被裁剪时（例如从受限环境启动）仍能找到全局 Trellis。
        dirs.push(app_data.join("npm"));
    }
    if let Some(local_app_data) = local_app_data {
        dirs.push(local_app_data.join("Programs").join("nodejs"));
        dirs.push(local_app_data.join("Volta").join("bin"));
        dirs.push(local_app_data.join("pnpm"));
    }
    if let Some(program_files) = program_files {
        dirs.push(program_files.join("nodejs"));
    }
    dirs
}

pub(super) fn fallback_dirs() -> Vec<PathBuf> {
    fallback_dirs_in(
        env_dir("APPDATA").as_deref(),
        env_dir("LOCALAPPDATA").as_deref(),
        env_dir("ProgramFiles").as_deref(),
    )
}

pub(super) fn probe_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_dirs();
    dirs.extend(fallback_dirs());
    let mut unique: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !dir.as_os_str().is_empty() && !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    unique
}

fn python_named(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_ascii_lowercase().starts_with("python"))
        .unwrap_or(false)
}

/// Python 常见安装根目录：官方 per-user/all-users 安装，以及 `C:\Python314` 这类自定义
/// 根目录。仅用于 PATH 之后的兜底，不改变“PATH 优先”的顺序。
pub(super) fn python_dirs_in(
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    system_drive: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(local_app_data) = local_app_data {
        dirs.extend(subdirs(&local_app_data.join("Programs").join("Python")));
    }
    if let Some(program_files) = program_files {
        dirs.extend(
            subdirs(program_files)
                .into_iter()
                .filter(|path| python_named(path)),
        );
    }
    if let Some(system_drive) = system_drive {
        let text = system_drive.to_string_lossy();
        let root = text.trim_end_matches('\\').trim_end_matches('/');
        if !root.is_empty() {
            let drive_root = PathBuf::from(format!("{root}\\"));
            dirs.extend(
                subdirs(&drive_root)
                    .into_iter()
                    .filter(|path| python_named(path)),
            );
        }
    }
    dirs
}

pub(super) fn python_dirs() -> Vec<PathBuf> {
    python_dirs_in(
        env_dir("LOCALAPPDATA").as_deref(),
        env_dir("ProgramFiles").as_deref(),
        env_dir("SystemDrive").as_deref(),
    )
}

/// 0 字节文件是 Windows App Execution Alias（例如未安装 Store 版 Python 时的
/// `WindowsApps\python.exe`），执行不了；不能当作可用解释器/工具。
pub(super) fn is_usable_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

pub fn find_in_path(dirs: &[PathBuf], executable: &str) -> Option<PathBuf> {
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join(executable);
        if is_usable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(super) fn shell_exe() -> PathBuf {
    std::env::var("ComSpec")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("C:\\Windows\\System32\\cmd.exe"))
}

/// 读取 `<pkg>/bin/trellis.js` 所在包的 `package.json` 版本。
pub fn read_package_version(cli_path: &Path) -> Option<String> {
    let package_root = cli_path.parent()?.parent()?;
    let text = std::fs::read_to_string(package_root.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let version = value.get("version")?.as_str()?.trim();
    parse_version(version)
}

pub(super) async fn node_version_at(executable: &Path) -> Option<String> {
    if !is_usable_file(executable) {
        return None;
    }
    let output = run_process(
        executable,
        &["--version"],
        &ProcessOptions {
            timeout: Some(NODE_VALIDATE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    parse_version(&output.stdout)
}

/// 前缀目录里的全局 Trellis CLI：优先全局包，其次 `trellis.cmd` 里的真实路径。
pub(super) fn trellis_cli_in(dir: &Path) -> Option<(PathBuf, &'static str)> {
    let cli = dir
        .join("node_modules")
        .join("@mindfoldhq")
        .join("trellis")
        .join("bin")
        .join("trellis.js");
    if cli.is_file() {
        return Some((cli, "global"));
    }
    trellis_from_cmd(&dir.join("trellis.cmd")).map(|cli| (cli, "path"))
}

pub(super) fn trellis_from_cmd(cmd: &Path) -> Option<PathBuf> {
    if let Ok(text) = std::fs::read_to_string(cmd) {
        for token in text.split(|character: char| character == '"' || character.is_whitespace()) {
            let lower = token.to_ascii_lowercase();
            if !lower.ends_with("trellis.js") {
                continue;
            }
            let mut candidate = PathBuf::from(token.replace('\\', "/"));
            if candidate.is_relative() {
                if let Some(parent) = cmd.parent() {
                    candidate = parent.join(candidate);
                }
            }
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let sibling = cmd
        .parent()?
        .join("node_modules")
        .join("@mindfoldhq")
        .join("trellis")
        .join("bin")
        .join("trellis.js");
    sibling.is_file().then_some(sibling)
}

// ---------------------------------------------------------------- check

pub async fn check<C: ClientConfigLike>(
    data_dir: &Path,
    config: &mut C,
) -> AgentResult<RuntimeStatus> {
    let node = resolve_node(data_dir, config).await;
    let trellis = resolve_trellis(data_dir, config).await;
    let python = resolve_python(config).await;
    let state = if node.ok && trellis.ok && python.ok {
        RuntimeState::Ready
    } else {
        RuntimeState::NeedsSetup
    };
    let zip = download_dir(data_dir).join("node.zip");
    let part = download_dir(data_dir).join("node.zip.part");
    let bytes = [&zip, &part]
        .into_iter()
        .find_map(|path| std::fs::metadata(path).ok().map(|meta| meta.len()));
    Ok(RuntimeStatus {
        state,
        node,
        trellis,
        python,
        download: DownloadInfo {
            version: NODE_DOWNLOAD_VERSION.to_string(),
            bytes,
        },
    })
}

pub(super) async fn resolve_node<C: ClientConfigLike>(
    data_dir: &Path,
    config: &mut C,
) -> NodeStatus {
    let mut outdated: Option<NodeStatus> = None;
    if let Some(flag) = config.node_runtime() {
        let executable = PathBuf::from(&flag.path);
        if is_usable_file(&executable) {
            let version = parse_version(&flag.version);
            let ok = version
                .as_deref()
                .map(|value| is_version_at_least(value, NODE_MIN_VERSION))
                .unwrap_or(false);
            if ok {
                return NodeStatus {
                    ok: true,
                    version,
                    path: Some(flag.path),
                    source: Some("client".to_string()),
                    min_version: NODE_MIN_VERSION.to_string(),
                    found_version: None,
                };
            }
            // flag 版本过低：保留为兜底结果，继续找 PATH / 私有运行时里的更新版本。
            outdated = Some(NodeStatus {
                ok: false,
                version: None,
                path: Some(flag.path),
                source: Some("client".to_string()),
                min_version: NODE_MIN_VERSION.to_string(),
                found_version: version,
            });
        } else {
            // flag 失效（文件被删）→ 清空后重新探测，自愈。
            config.set_node_runtime(None);
        }
    }

    let missing = NodeStatus {
        ok: false,
        version: None,
        path: None,
        source: None,
        min_version: NODE_MIN_VERSION.to_string(),
        found_version: None,
    };

    // 候选顺序：PATH/版本管理器/常见前缀 → 客户端私有 runtime（上次安装或中断留下）。
    // 逐个候选试 `node --version`：旧版本只在全部不合格时作为「版本过低」返回。
    let mut candidates: Vec<(PathBuf, &'static str)> = probe_dirs()
        .into_iter()
        .map(|dir| (dir.join("node.exe"), "path"))
        .collect();
    candidates.push((node_exe_path(data_dir), "client"));

    for (executable, source) in candidates {
        if !is_usable_file(&executable) {
            continue;
        }
        let Some(version) = node_version_at(&executable).await else {
            continue;
        };
        if !is_version_at_least(&version, NODE_MIN_VERSION) {
            outdated.get_or_insert(NodeStatus {
                ok: false,
                version: None,
                path: Some(executable.display().to_string()),
                source: Some(source.to_string()),
                min_version: NODE_MIN_VERSION.to_string(),
                found_version: Some(version),
            });
            continue;
        }
        // 探测到的路径同时写回 flag：Agent 侧只认 flag，不重新探测。
        config.set_node_runtime(Some(NodeRuntimeFlag {
            version: version.clone(),
            path: executable.display().to_string(),
            source: source.to_string(),
            installed_at: protocol::now_iso8601(),
        }));
        return NodeStatus {
            ok: true,
            version: Some(version),
            path: Some(executable.display().to_string()),
            source: Some(source.to_string()),
            min_version: NODE_MIN_VERSION.to_string(),
            found_version: None,
        };
    }
    outdated.unwrap_or(missing)
}

pub(super) fn trellis_status(cli_path: &Path, source: &str) -> TrellisStatus {
    let version = read_package_version(cli_path);
    let ok = version
        .as_deref()
        .map(|value| is_version_at_least(value, TRELLIS_VERSION))
        .unwrap_or(false);
    TrellisStatus {
        ok,
        version: if ok { version.clone() } else { None },
        cli_path: Some(cli_path.display().to_string()),
        source: Some(source.to_string()),
        required_version: TRELLIS_VERSION.to_string(),
        found_version: if ok { None } else { version },
    }
}

pub(super) async fn resolve_trellis<C: ClientConfigLike>(
    data_dir: &Path,
    config: &mut C,
) -> TrellisStatus {
    let mut outdated: Option<TrellisStatus> = None;
    if let Some(flag) = config.trellis_runtime() {
        let cli = PathBuf::from(&flag.cli_path);
        if is_usable_file(&cli) {
            let source = if flag.source.is_empty() {
                "client-prefix"
            } else {
                flag.source.as_str()
            };
            let status = trellis_status(&cli, source);
            if status.ok {
                return status;
            }
            // flag 版本过低：继续找全局/私有前缀里的更新版本。
            outdated = Some(status);
        } else {
            config.set_trellis_runtime(None);
        }
    }

    let client_prefix = trellis_cli_path(data_dir);
    if is_usable_file(&client_prefix) {
        let status = trellis_status(&client_prefix, "client-prefix");
        if status.ok {
            // 私有前缀可能来自上次安装；flag 丢失时也要写回，供 Agent 侧读取。
            config.set_trellis_runtime(Some(TrellisRuntimeFlag {
                version: status.version.clone().unwrap_or_default(),
                cli_path: client_prefix.display().to_string(),
                source: "client-prefix".to_string(),
                installed_at: protocol::now_iso8601(),
            }));
            return status;
        }
        outdated.get_or_insert(status);
    }

    // 全局包就挂在 node.exe 同级（`npm root -g` 的前缀目录），逐个候选目录看一遍；
    // 不跑 `npm root -g`：npm.cmd 内部的 `node` 同样依赖 PATH，解析不出来时只会更糟。
    for dir in probe_dirs() {
        let Some((cli, source)) = trellis_cli_in(&dir) else {
            continue;
        };
        let status = trellis_status(&cli, source);
        if !status.ok {
            outdated.get_or_insert(status);
            continue;
        }
        config.set_trellis_runtime(Some(TrellisRuntimeFlag {
            version: status.version.clone().unwrap_or_default(),
            cli_path: cli.display().to_string(),
            source: source.to_string(),
            installed_at: protocol::now_iso8601(),
        }));
        return status;
    }

    outdated.unwrap_or(TrellisStatus {
        ok: false,
        version: None,
        cli_path: None,
        source: None,
        required_version: TRELLIS_VERSION.to_string(),
        found_version: None,
    })
}

// ---------------------------------------------------------------- Python

pub(super) async fn python_version_at(program: &Path, args: &[&str]) -> Option<String> {
    let mut argv: Vec<&str> = args.to_vec();
    argv.push("--version");
    let output = run_process(
        program,
        &argv,
        &ProcessOptions {
            timeout: Some(PYTHON_PROBE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    // 3.9 及更早写 stderr，3.10 起写 stdout。
    parse_python_version(&output.stdout).or_else(|| parse_python_version(&output.stderr))
}

pub(super) fn python_status(version: &str, path: &Path, source: &str) -> PythonStatus {
    let ok = is_version_at_least(version, PYTHON_MIN_VERSION);
    PythonStatus {
        ok,
        version: ok.then(|| version.to_string()),
        path: Some(path.display().to_string()),
        source: Some(source.to_string()),
        min_version: PYTHON_MIN_VERSION.to_string(),
        found_version: if ok { None } else { Some(version.to_string()) },
    }
}

/// `py -3` 只代表启动器的默认解释器；解析成真实的 `python.exe`，客户端才能直接调用。
pub(super) async fn py_launcher_target() -> Option<(PathBuf, String)> {
    // PATH 里可能先命中 WindowsApps 的 0 字节 py.exe；优先用系统目录里的真实启动器。
    let launcher = env_dir("SystemRoot")
        .map(|root| root.join("py.exe"))
        .filter(|path| is_usable_file(path))
        .unwrap_or_else(|| PathBuf::from("py"));
    let output = run_process(
        &launcher,
        &[
            "-3",
            "-c",
            "import sys; print(sys.executable); print(sys.version.split()[0])",
        ],
        &ProcessOptions {
            timeout: Some(PYTHON_PROBE_TIMEOUT),
            max_output_bytes: 65_536,
            ..Default::default()
        },
    )
    .await
    .ok()?;
    if !output.success() {
        return None;
    }
    let mut lines = output
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let executable = PathBuf::from(lines.next()?);
    let version = parse_python_version(lines.next()?)?;
    Some((executable, version))
}

pub(super) async fn resolve_python<C: ClientConfigLike>(config: &mut C) -> PythonStatus {
    let mut outdated: Option<PythonStatus> = None;
    if let Some(flag) = config.python_runtime() {
        let executable = PathBuf::from(&flag.path);
        if is_usable_file(&executable) {
            match python_version_at(&executable, &[]).await {
                Some(version) if is_version_at_least(&version, PYTHON_MIN_VERSION) => {
                    return python_status(&version, &executable, "client");
                }
                Some(version) => outdated = Some(python_status(&version, &executable, "client")),
                None => {}
            }
        } else {
            // flag 失效（文件被删/换机器）→ 清空后重新探测，自愈。
            config.set_python_runtime(None);
        }
    }

    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(value) = std::env::var_os("TRELLIS_PYTHON") {
        candidates.push((PathBuf::from(value), "env"));
    }
    if let Some(found) = find_in_path(&path_dirs(), "python.exe") {
        candidates.push((found, "path"));
    }
    for dir in python_dirs() {
        let executable = dir.join("python.exe");
        if is_usable_file(&executable) {
            candidates.push((executable, "common-prefix"));
        }
    }

    let mut found: Option<(PathBuf, String, &'static str)> = None;
    for (program, source) in candidates {
        let Some(version) = python_version_at(&program, &[]).await else {
            continue;
        };
        if is_version_at_least(&version, PYTHON_MIN_VERSION) {
            found = Some((program, version, source));
            break;
        }
        outdated.get_or_insert(python_status(&version, &program, source));
    }
    if found.is_none() {
        if let Some((executable, version)) = py_launcher_target().await {
            if is_version_at_least(&version, PYTHON_MIN_VERSION) {
                found = Some((executable, version, "py-launcher"));
            } else {
                outdated.get_or_insert(python_status(&version, &executable, "py-launcher"));
            }
        }
    }

    match found {
        Some((executable, version, source)) => {
            // 探测到的解释器写回 flag：客户端执行 task.py 时只认 flag。
            config.set_python_runtime(Some(PythonRuntimeFlag {
                version: version.clone(),
                path: executable.display().to_string(),
                source: source.to_string(),
                installed_at: protocol::now_iso8601(),
            }));
            python_status(&version, &executable, source)
        }
        None => outdated.unwrap_or(PythonStatus {
            ok: false,
            version: None,
            path: None,
            source: None,
            min_version: PYTHON_MIN_VERSION.to_string(),
            found_version: None,
        }),
    }
}

