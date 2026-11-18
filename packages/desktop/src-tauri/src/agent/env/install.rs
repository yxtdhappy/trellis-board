use super::*;

// ---------------------------------------------------------------- install

pub async fn install(
    data_dir: &Path,
    mut on_progress: impl FnMut(&str, &str) + Send,
) -> AgentResult<RuntimeInstallResult> {
    let node_path = node_exe_path(data_dir);
    let node_version = match node_version_at(&node_path).await {
        Some(version) => {
            on_progress("node:validate", &format!("Node.js {version} 已就绪"));
            version
        }
        None => install_node(data_dir, &mut on_progress).await?,
    };
    if !is_version_at_least(&node_version, NODE_MIN_VERSION) {
        return Err(AgentError::new(
            CODE_NODE_INVALID,
            format!("Node.js 版本过低: {node_version}"),
        )
        .with_details(Some(json!({ "stage": "node:validate" }))));
    }

    let cli_path = trellis_cli_path(data_dir);
    let existing = read_package_version(&cli_path)
        .filter(|version| is_version_at_least(version, TRELLIS_VERSION));
    let trellis_version = match existing {
        Some(version) => {
            on_progress("trellis:validate", &format!("Trellis CLI {version} 已就绪"));
            version
        }
        None => {
            on_progress("trellis:install", "正在安装 Trellis CLI");
            install_trellis(data_dir, &node_path, &mut on_progress).await?;
            on_progress("trellis:validate", "正在校验 Trellis CLI");
            let version = read_package_version(&cli_path).ok_or_else(|| {
                AgentError::new(code::MISSING_TRELLIS, "Trellis CLI 安装后未找到")
                    .with_details(Some(json!({ "stage": "trellis:validate" })))
            })?;
            if !is_version_at_least(&version, TRELLIS_VERSION) {
                return Err(AgentError::new(
                    code::MISSING_TRELLIS,
                    format!("Trellis CLI 版本过低: {version}"),
                )
                .with_details(Some(json!({ "stage": "trellis:validate" }))));
            }
            version
        }
    };

    let (python_path, python_version) = match installed_python().await {
        Some((path, version)) => {
            on_progress("python:validate", &format!("Python {version} 已就绪"));
            (path, version)
        }
        None => install_python(data_dir, &mut on_progress).await?,
    };

    on_progress("write-flag", "正在保存运行时配置");
    let installed_at = protocol::now_iso8601();
    write_runtime_flags(
        data_dir,
        &NodeRuntimeFlag {
            version: node_version.clone(),
            path: node_path.display().to_string(),
            source: "downloaded".to_string(),
            installed_at: installed_at.clone(),
        },
        &TrellisRuntimeFlag {
            version: trellis_version.clone(),
            cli_path: cli_path.display().to_string(),
            source: "client-prefix".to_string(),
            installed_at: installed_at.clone(),
        },
        &PythonRuntimeFlag {
            version: python_version.clone(),
            path: python_path.display().to_string(),
            source: "installed".to_string(),
            installed_at,
        },
    )?;

    on_progress(
        "ready",
        &format!("Node.js {node_version} · Trellis CLI {trellis_version} · Python {python_version} 已就绪"),
    );
    Ok(RuntimeInstallResult {
        node_version,
        trellis_version,
        python_version,
    })
}

pub(super) async fn install_node(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<String> {
    let zip = download_node(data_dir, &mut *on_progress).await?;
    let staged = runtime_dir(data_dir).join("node.new");
    on_progress("node:extract", "正在解压 Node.js");
    let extraction = {
        let zip = zip.clone();
        let staged = staged.clone();
        tokio::task::spawn_blocking(move || extract_node(&zip, &staged))
            .await
            .map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("解压任务失败: {error}"))
            })?
    };
    if let Err(error) = extraction {
        cleanup_partial(data_dir).await;
        return Err(error);
    }

    on_progress("node:validate", "正在校验 Node.js");
    let version = match node_version_at(&staged.join("node.exe")).await {
        Some(version) if is_version_at_least(&version, NODE_MIN_VERSION) => version,
        Some(version) => {
            cleanup_partial(data_dir).await;
            return Err(
                AgentError::new(CODE_NODE_INVALID, format!("Node.js 版本过低: {version}"))
                    .with_details(Some(json!({ "stage": "node:validate" }))),
            );
        }
        None => {
            cleanup_partial(data_dir).await;
            return Err(AgentError::new(CODE_NODE_INVALID, "Node.js 校验失败")
                .with_details(Some(json!({ "stage": "node:validate" }))));
        }
    };

    let node_dir = runtime_dir(data_dir).join("node");
    if node_dir.exists() {
        std::fs::remove_dir_all(&node_dir).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法清理旧 Node.js: {error}"))
        })?;
    }
    std::fs::rename(&staged, &node_dir).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("Node.js 安装失败: {error}"))
    })?;
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_file(download_dir(data_dir).join("node.zip.part"));
    Ok(version)
}

pub(super) struct DownloadSpec {
    url: &'static str,
    sha256: &'static str,
    file_name: &'static str,
    label: &'static str,
    download_stage: &'static str,
    verify_stage: &'static str,
}

pub(super) async fn download_file(
    data_dir: &Path,
    spec: &DownloadSpec,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<PathBuf> {
    let directory = download_dir(data_dir);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("无法创建下载目录: {error}"))
        })?;
    let target = directory.join(spec.file_name);
    let part_path = directory.join(format!("{}.part", spec.file_name));
    let _ = tokio::fs::remove_file(&part_path).await;
    let label = spec.label;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| {
            AgentError::new(
                CODE_DOWNLOAD_FAILED,
                format!("下载客户端初始化失败: {error}"),
            )
        })?;
    let response = client.get(spec.url).send().await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("下载 {label} 失败: {error}"))
            .retryable(true)
            .with_details(Some(
                json!({ "stage": spec.download_stage, "url": spec.url }),
            ))
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AgentError::new(
            CODE_DOWNLOAD_FAILED,
            format!("下载 {label} 失败: HTTP {}", status.as_u16()),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": spec.download_stage,
            "url": spec.url,
            "status": status.as_u16(),
        }))));
    }

    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(&part_path).await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("无法写入下载文件: {error}"))
    })?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut last_percent: i64 = -1;
    on_progress(spec.download_stage, &format!("开始下载 {label}"));

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("下载 {label} 中断: {error}"))
                .retryable(true)
                .with_details(Some(
                    json!({ "stage": spec.download_stage, "url": spec.url }),
                ))
        })?;
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("写入下载文件失败: {error}"))
        })?;
        received += chunk.len() as u64;
        if received > MAX_ZIP_BYTES {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(AgentError::new(
                CODE_DOWNLOAD_FAILED,
                format!("{label} 下载超出大小限制"),
            ));
        }
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| ((received.saturating_mul(100) / total).min(100)) as i64);
        let percent_changed = percent != Some(last_percent);
        if (percent_changed || percent.is_none()) && last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_percent = percent.unwrap_or_default();
            last_emit = Instant::now();
            let megabytes = received as f64 / 1_048_576.0;
            let message = match (percent, total) {
                (Some(percent), Some(total)) => format!(
                    "正在下载 {label} {percent}% ({megabytes:.1} MB / {:.1} MB)",
                    total as f64 / 1_048_576.0
                ),
                _ => format!("正在下载 {label} {megabytes:.1} MB"),
            };
            on_progress(spec.download_stage, &message);
        }
    }

    file.flush().await.map_err(|error| {
        AgentError::new(CODE_DOWNLOAD_FAILED, format!("写入下载文件失败: {error}"))
    })?;
    drop(file);

    on_progress(spec.verify_stage, "正在校验下载文件");
    verify_hash(&hex(&hasher.finalize()), spec.sha256, spec.verify_stage).inspect_err(|_| {
        let _ = std::fs::remove_file(&part_path);
    })?;
    let _ = std::fs::remove_file(&target);
    tokio::fs::rename(&part_path, &target)
        .await
        .map_err(|error| {
            AgentError::new(CODE_DOWNLOAD_FAILED, format!("保存下载文件失败: {error}"))
        })?;
    Ok(target)
}

pub(super) async fn download_node(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<PathBuf> {
    download_file(
        data_dir,
        &DownloadSpec {
            url: NODE_ZIP_URL,
            sha256: NODE_ZIP_SHA256,
            file_name: "node.zip",
            label: "Node.js",
            download_stage: "node:download",
            verify_stage: "node:verify",
        },
        &mut *on_progress,
    )
    .await
}

/// 已装好的 >=3.9 解释器：per-user 安装目录 → PATH → `py -3`，取第一个可用者。
pub(super) async fn installed_python() -> Option<(PathBuf, String)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut parts = PYTHON_INSTALL_VERSION.split('.');
    let directory = format!(
        "Python{}{}",
        parts.next().unwrap_or("3"),
        parts.next().unwrap_or("12")
    );
    if let Some(local) = env_dir("LOCALAPPDATA") {
        candidates.push(
            local
                .join("Programs")
                .join("Python")
                .join(directory)
                .join("python.exe"),
        );
    }
    if let Some(found) = find_in_path(&path_dirs(), "python.exe") {
        candidates.push(found);
    }
    for program in candidates {
        let Some(version) = python_version_at(&program, &[]).await else {
            continue;
        };
        if is_version_at_least(&version, PYTHON_MIN_VERSION) {
            return Some((program, version));
        }
    }
    py_launcher_target()
        .await
        .filter(|(_, version)| is_version_at_least(version, PYTHON_MIN_VERSION))
}

pub(super) async fn run_with_heartbeat(
    program: PathBuf,
    args: Vec<String>,
    stage: &'static str,
    message: String,
    timeout: Duration,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<ProcessOutput> {
    let options = ProcessOptions {
        timeout: Some(timeout),
        max_output_bytes: 1_048_576,
        ..Default::default()
    };
    let mut task = tokio::spawn(async move {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        run_process(&program, &argv, &options).await
    });
    let started = Instant::now();
    loop {
        tokio::select! {
            joined = &mut task => {
                // 安装器静默执行时没有输出，只能靠心跳让前端知道还在装。
                return joined.map_err(|error| {
                    AgentError::new(CODE_PYTHON_INVALID, format!("Python 安装任务失败: {error}"))
                })?;
            }
            _ = tokio::time::sleep(PYTHON_INSTALL_HEARTBEAT) => {
                let seconds = started.elapsed().as_secs();
                on_progress(stage, &format!("{message}（已用 {seconds} 秒）"));
            }
        }
    }
}

pub(super) async fn install_python(
    data_dir: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<(PathBuf, String)> {
    let installer = download_file(
        data_dir,
        &DownloadSpec {
            url: PYTHON_INSTALLER_URL,
            sha256: PYTHON_INSTALLER_SHA256,
            file_name: PYTHON_INSTALLER_FILE,
            label: "Python",
            download_stage: "python:download",
            verify_stage: "python:verify",
        },
        &mut *on_progress,
    )
    .await?;

    on_progress(
        "python:install",
        &format!("正在静默安装 Python {PYTHON_INSTALL_VERSION}"),
    );
    let args: Vec<String> = PYTHON_INSTALLER_ARGS
        .iter()
        .map(|value| value.to_string())
        .collect();
    let outcome = run_with_heartbeat(
        installer.clone(),
        args,
        "python:install",
        format!("正在静默安装 Python {PYTHON_INSTALL_VERSION}"),
        PYTHON_INSTALL_TIMEOUT,
        &mut *on_progress,
    )
    .await;
    // 成功或失败都删掉安装包；失败文案里给官方下载页。
    let _ = std::fs::remove_file(&installer);
    let output = outcome?;
    let exit_code = output.exit_code;
    if exit_code != 0 && exit_code != PYTHON_EXIT_REBOOT_REQUIRED {
        return Err(AgentError::new(
            CODE_PYTHON_INVALID,
            format!("Python 安装失败: 退出码 {exit_code}，可从 {PYTHON_PAGE_URL} 手动安装"),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": "python:install",
            "exitCode": exit_code,
            "url": PYTHON_PAGE_URL,
        }))));
    }

    on_progress("python:validate", "正在校验 Python");
    installed_python().await.ok_or_else(|| {
        AgentError::new(
            CODE_PYTHON_INVALID,
            format!("Python 安装后未找到 {PYTHON_MIN_VERSION} 及以上的解释器"),
        )
        .with_details(Some(json!({
            "stage": "python:validate",
            "minVersion": PYTHON_MIN_VERSION,
        })))
    })
}

pub(super) fn node_entry_allowed(relative: &str) -> bool {
    relative == "node.exe"
        || relative == "npm.cmd"
        || relative == "npx.cmd"
        || relative == "npm"
        || relative == "npx"
        || relative.starts_with("node_modules/npm/")
        || Path::new(relative)
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.to_ascii_uppercase().starts_with("LICENSE"))
            .unwrap_or(false)
}

pub(super) fn extract_node(zip_path: &Path, target: &Path) -> AgentResult<()> {
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法清理临时目录: {error}"))
        })?;
    }
    std::fs::create_dir_all(target).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建解压目录: {error}"))
    })?;

    let file = std::fs::File::open(zip_path).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("无法打开压缩包: {error}"))
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        AgentError::new(CODE_EXTRACT_FAILED, format!("压缩包无法解析: {error}"))
    })?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("压缩包条目读取失败: {error}"))
        })?;
        let name = entry.name().to_string();
        let Some(relative) = name.strip_prefix(NODE_ZIP_ROOT) else {
            continue;
        };
        if relative.is_empty() || !node_entry_allowed(relative) {
            continue;
        }
        let mut destination = target.to_path_buf();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => destination.push(part),
                _ => {
                    return Err(AgentError::new(CODE_EXTRACT_FAILED, "压缩包包含非法路径"));
                }
            }
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&destination).map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建目录: {error}"))
            })?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AgentError::new(CODE_EXTRACT_FAILED, format!("无法创建目录: {error}"))
            })?;
        }
        let mut output = std::fs::File::create(&destination).map_err(|error| {
            AgentError::new(CODE_EXTRACT_FAILED, format!("无法写入文件: {error}"))
        })?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| AgentError::new(CODE_EXTRACT_FAILED, format!("解压失败: {error}")))?;
        output.flush().ok();
    }
    Ok(())
}

pub(super) async fn cleanup_partial(data_dir: &Path) {
    let staged = runtime_dir(data_dir).join("node.new");
    if staged.exists() {
        let _ = tokio::fs::remove_dir_all(&staged).await;
    }
    let _ = tokio::fs::remove_file(download_dir(data_dir).join("node.zip.part")).await;
}

pub(super) async fn install_trellis(
    data_dir: &Path,
    node_path: &Path,
    on_progress: &mut (impl FnMut(&str, &str) + Send),
) -> AgentResult<()> {
    let prefix = npm_global_dir(data_dir);
    tokio::fs::create_dir_all(&prefix).await.map_err(|error| {
        AgentError::new(
            CODE_TRELLIS_INSTALL_FAILED,
            format!("无法创建安装目录: {error}"),
        )
    })?;
    let prefix_text = prefix.display().to_string();
    let package = format!("{TRELLIS_PACKAGE}@{TRELLIS_VERSION}");
    let options = ProcessOptions {
        timeout: Some(NPM_INSTALL_TIMEOUT),
        max_output_bytes: 1_048_576,
        ..Default::default()
    };

    let npm_cli = node_path
        .parent()
        .map(|directory| {
            directory
                .join("node_modules")
                .join("npm")
                .join("bin")
                .join("npm-cli.js")
        })
        .filter(|path| path.is_file());

    let output = if let Some(npm_cli) = npm_cli {
        let npm_cli_text = npm_cli.display().to_string();
        on_progress("trellis:install", "正在安装 Trellis CLI");
        run_process(
            node_path,
            &[
                npm_cli_text.as_str(),
                "install",
                "-g",
                "--prefix",
                prefix_text.as_str(),
                package.as_str(),
            ],
            &options,
        )
        .await?
    } else if let Some(npm) = find_in_path(&path_dirs(), "npm.cmd") {
        on_progress("trellis:install", "正在安装 Trellis CLI");
        let line = format!(
            "\"{}\" install -g --prefix \"{prefix_text}\" {package}",
            npm.display()
        );
        run_process(&shell_exe(), &["/C", line.as_str()], &options).await?
    } else {
        return Err(
            AgentError::new(code::MISSING_TRELLIS, "未找到 npm，无法安装 Trellis CLI")
                .with_details(Some(json!({ "stage": "trellis:install" }))),
        );
    };

    if !output.success() {
        return Err(AgentError::new(
            CODE_TRELLIS_INSTALL_FAILED,
            format!(
                "安装 Trellis CLI 失败: {}",
                output.stderr_tail(ERROR_TAIL_CHARS)
            ),
        )
        .retryable(true)
        .with_details(Some(json!({
            "stage": "trellis:install",
            "exitCode": output.exit_code,
        }))));
    }
    Ok(())
}

/// 把三个运行时 flag 合并写入 `<data_dir>/client.json`（schema 3）。
pub fn write_runtime_flags(
    data_dir: &Path,
    node: &NodeRuntimeFlag,
    trellis: &TrellisRuntimeFlag,
    python: &PythonRuntimeFlag,
) -> AgentResult<()> {
    let path = data_dir.join("client.json");
    let mut document: Map<String, Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    document.insert("schema_version".to_string(), json!(3));
    document.insert(
        "node_runtime".to_string(),
        serde_json::to_value(node).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    document.insert(
        "trellis_runtime".to_string(),
        serde_json::to_value(trellis).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    document.insert(
        "python_runtime".to_string(),
        serde_json::to_value(python).map_err(|error| {
            AgentError::new(
                code::CONFIG_INVALID,
                format!("运行时配置序列化失败: {error}"),
            )
        })?,
    );
    let payload = serde_json::to_vec_pretty(&Value::Object(document)).map_err(|error| {
        AgentError::new(
            code::CONFIG_INVALID,
            format!("运行时配置序列化失败: {error}"),
        )
    })?;

    std::fs::create_dir_all(data_dir).map_err(|error| {
        AgentError::new(code::CONFIG_INVALID, format!("无法创建配置目录: {error}"))
    })?;
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    std::fs::write(&temp, payload).map_err(|error| {
        AgentError::new(code::CONFIG_INVALID, format!("无法写入运行时配置: {error}"))
    })?;
    if std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&temp, &path).map_err(|error| {
            AgentError::new(code::CONFIG_INVALID, format!("无法写入运行时配置: {error}"))
        })?;
    }
    Ok(())
}

