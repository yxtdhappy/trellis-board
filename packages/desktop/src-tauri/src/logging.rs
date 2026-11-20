use chrono::{SecondsFormat, Utc};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const ROTATED_LOGS: u32 = 2;

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();
static LOG_LOCK: Mutex<()> = Mutex::new(());

pub fn init(directory: &Path) {
    if let Err(error) = std::fs::create_dir_all(directory) {
        eprintln!("无法创建日志目录 {}: {error}", directory.display());
        return;
    }
    let _ = LOG_FILE.set(directory.join("desktop.log"));
}

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn format_line(level: &str, message: &str) -> String {
    format!(
        "{} {} {}\n",
        timestamp(),
        level.to_ascii_uppercase(),
        redact(message.trim_end())
    )
}

fn write(level: &str, message: &str) {
    let line = format_line(level, message);
    if let Some(path) = LOG_FILE.get() {
        let _guard = LOG_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        append(path, &line);
    }
    eprint!("{line}");
}

fn append(path: &Path, line: &str) {
    rotate_if_needed(path);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn rotated_path(path: &Path, index: u32) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("desktop");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("log");
    path.with_file_name(format!("{stem}.{index}.{extension}"))
}

/// 超过上限时把当前日志移入历史文件；任何一步失败都保持原文件可追加。
fn rotate_if_needed(path: &Path) {
    let oversized = std::fs::metadata(path)
        .map(|meta| meta.len() >= MAX_LOG_BYTES)
        .unwrap_or(false);
    if !oversized {
        return;
    }
    let _ = std::fs::remove_file(rotated_path(path, ROTATED_LOGS));
    for index in (1..ROTATED_LOGS).rev() {
        let source = rotated_path(path, index);
        if source.exists() {
            let _ = std::fs::rename(&source, rotated_path(path, index + 1));
        }
    }
    let _ = std::fs::rename(path, rotated_path(path, 1));
}

pub fn info(message: &str) {
    write("info", message);
}

pub fn warn(message: &str) {
    write("warn", message);
}

/// 删除日志中可能出现的 Bearer 凭证、设备凭证、令牌和配对码字段值。
pub fn redact(input: &str) -> String {
    let mut value = input.to_string();
    let mut search = 0;
    while search < value.len() {
        let rest = &value[search..];
        let found = ["Bearer ", "bearer "]
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min();
        let Some(offset) = found else { break };
        let token_start = search + offset + "Bearer ".len();
        let token_end = value[token_start..]
            .find(|character: char| {
                character.is_whitespace() || character == '"' || character == ','
            })
            .map(|offset| token_start + offset)
            .unwrap_or(value.len());
        if token_end > token_start {
            value.replace_range(token_start..token_end, "***");
        }
        search = token_start + 3;
    }
    for marker in [
        "\"credential\"",
        "\"pairingCode\"",
        "\"sessionToken\"",
        "\"token\"",
        "\"password\"",
    ] {
        if let Some(index) = value.find(marker) {
            let tail = &value[index + marker.len()..];
            let colon = tail.find(':');
            if let Some(colon) = colon {
                let value_start = index + marker.len() + colon + 1;
                let rest = &value[value_start..];
                let quote = rest.find('"');
                if let Some(quote) = quote {
                    let start = value_start + quote + 1;
                    let end = value[start..]
                        .find('"')
                        .map(|offset| start + offset)
                        .unwrap_or(value.len());
                    value.replace_range(start..end, "***");
                }
            }
        }
    }
    value
}

#[cfg(test)]
mod tests;
