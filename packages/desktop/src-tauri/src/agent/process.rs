use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::agent::protocol::{code, AgentError, AgentResult};

/// 失败命令写入日志时保留的输出尾部长度。
const LOG_TAIL_CHARS: usize = 2_000;

const ENV_ALLOWLIST: [&str; 15] = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "SSH_AUTH_SOCK",
    "PSModulePath",
];

pub fn build_environment(extra: Option<&BTreeMap<String, String>>) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    for key in ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            environment.insert(key.to_string(), value);
        }
    }
    if let Some(extra) = extra {
        for (key, value) in extra {
            environment.insert(key.clone(), value.clone());
        }
    }
    environment
}

#[derive(Debug, Clone, Default)]
pub struct ProcessOptions {
    pub cwd: Option<std::path::PathBuf>,
    pub env: Option<BTreeMap<String, String>>,
    pub stdin: Option<Vec<u8>>,
    pub timeout: Option<Duration>,
    pub max_output_bytes: usize,
}

#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl ProcessOutput {
    pub fn success(&self) -> bool {
        self.exit_code == 0
    }

    pub fn stdout_tail(&self, limit: usize) -> String {
        tail_chars(&self.stdout, limit)
    }

    pub fn stderr_tail(&self, limit: usize) -> String {
        tail_chars(&self.stderr, limit)
    }
}

fn tail_chars(text: &str, limit: usize) -> String {
    let mut chars: Vec<char> = text.chars().rev().take(limit).collect();
    chars.reverse();
    chars.into_iter().collect()
}

pub async fn run_process(
    command: &std::path::Path,
    args: &[&str],
    options: &ProcessOptions,
) -> AgentResult<ProcessOutput> {
    let max_output = if options.max_output_bytes == 0 {
        1_048_576
    } else {
        options.max_output_bytes
    };
    let timeout = options.timeout.unwrap_or(Duration::from_secs(30));

    let mut builder = Command::new(command);
    builder
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // CREATE_NO_WINDOW：只在 Windows 上存在，其他平台不需要。
    #[cfg(windows)]
    builder.creation_flags(0x0800_0000);
    if let Some(cwd) = &options.cwd {
        builder.current_dir(cwd);
    }
    if let Some(env) = &options.env {
        builder.env_clear();
        builder.envs(env);
    }

    let mut child = builder.spawn().map_err(|error| {
        crate::logging::warn(&format!(
            "命令无法启动: {}: {error}",
            command_text(command, args)
        ));
        AgentError::new(code::HTTP_ERROR, format!("无法启动子进程: {error}"))
            .with_details(Some(json!({ "spawnFailed": true })))
    })?;
    let pid = child.id();

    let stdin_payload = options.stdin.clone();
    let mut stdin_handle = child.stdin.take();
    let stdout_handle = child.stdout.take();
    let stderr_handle = child.stderr.take();

    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin_handle.take() {
            if let Some(payload) = stdin_payload {
                let _ = stdin.write_all(&payload).await;
            }
            let _ = stdin.shutdown().await;
        }
    });

    let stdout_task = tokio::spawn(read_capped(stdout_handle, max_output));
    let stderr_task = tokio::spawn(read_capped(stderr_handle, max_output));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result.map_err(|error| {
            crate::logging::warn(&format!(
                "命令等待失败: {}: {error}",
                command_text(command, args)
            ));
            AgentError::new(code::HTTP_ERROR, format!("子进程执行失败: {error}"))
        })?,
        Err(_) => {
            kill_process_tree(pid).await;
            let _ = child.kill().await;
            let _ = writer.await;
            crate::logging::warn(&format!(
                "命令超时({}s): {}",
                timeout.as_secs(),
                command_text(command, args)
            ));
            return Err(AgentError::new(code::GIT_TIMEOUT, "子进程执行超时")
                .with_details(Some(json!({ "timedOut": true }))));
        }
    };

    let _ = writer.await;
    let stdout = match stdout_task.await {
        Ok(Ok(bytes)) => decode_output(&bytes),
        _ => {
            kill_process_tree(pid).await;
            return err_output_limit(command, args);
        }
    };
    let stderr = match stderr_task.await {
        Ok(Ok(bytes)) => decode_output(&bytes),
        _ => {
            kill_process_tree(pid).await;
            return err_output_limit(command, args);
        }
    };

    let output = ProcessOutput {
        exit_code: status.code().unwrap_or(-1),
        stdout,
        stderr,
    };
    if !output.success() {
        crate::logging::warn(&format!(
            "命令失败(exit={}): {}\nstdout: {}\nstderr: {}",
            output.exit_code,
            command_text(command, args),
            output.stdout_tail(LOG_TAIL_CHARS),
            output.stderr_tail(LOG_TAIL_CHARS),
        ));
    }
    Ok(output)
}

fn command_text(command: &std::path::Path, args: &[&str]) -> String {
    let mut text = command.display().to_string();
    for arg in args {
        text.push(' ');
        text.push_str(arg);
    }
    text
}

async fn read_capped<R>(mut stream: Option<R>, limit: usize) -> Result<Vec<u8>, ()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut collected = Vec::new();
    if let Some(reader) = stream.as_mut() {
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) => break,
                Ok(read) => {
                    if collected.len() + read > limit {
                        let remaining = limit.saturating_sub(collected.len());
                        collected.extend_from_slice(&chunk[..remaining]);
                        return Err(());
                    }
                    collected.extend_from_slice(&chunk[..read]);
                }
                Err(_) => break,
            }
        }
    }
    Ok(collected)
}

/// Windows 的 cmd.exe 等子进程按系统代码页（中文为 GBK）写输出，整段按 UTF-8
/// 解码会变成 U+FFFD。逐行先试 UTF-8，失败的行再按 OEM 代码页解码。
fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    bytes
        .split_inclusive(|byte| *byte == b'\n')
        .map(|line| match std::str::from_utf8(line) {
            Ok(text) => text.to_string(),
            Err(_) => decode_oem(line),
        })
        .collect()
}

#[cfg(windows)]
fn decode_oem(bytes: &[u8]) -> String {
    use windows::Win32::Globalization::{
        GetOEMCP, MultiByteToWideChar, MULTI_BYTE_TO_WIDE_CHAR_FLAGS,
    };
    let codepage = unsafe { GetOEMCP() };
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    let needed = unsafe { MultiByteToWideChar(codepage, flags, bytes, None) };
    if needed <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut wide = vec![0u16; needed as usize];
    let written = unsafe { MultiByteToWideChar(codepage, flags, bytes, Some(&mut wide)) };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&wide[..written as usize])
}

#[cfg(not(windows))]
fn decode_oem(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn err_output_limit(command: &std::path::Path, args: &[&str]) -> AgentResult<ProcessOutput> {
    crate::logging::warn(&format!(
        "命令输出超过大小限制: {}",
        command_text(command, args)
    ));
    Err(
        AgentError::new(code::INVALID_RESPONSE, "子进程输出超过大小限制")
            .with_details(Some(json!({ "outputLimit": true }))),
    )
}

pub fn is_timeout(error: &AgentError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("timedOut"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub(crate) async fn kill_process_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let taskkill = std::path::Path::new(&system_root)
        .join("System32")
        .join("taskkill.exe");
    let mut command = Command::new(taskkill);
    command
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let _ = command.status().await;
}

#[cfg(test)]
mod tests;
