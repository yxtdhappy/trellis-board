//! 切换服务器地址时的本地数据备份与清理。
//!
//! 只处理「登录数据 + 项目绑定数据」三类路径，不碰运行环境（`runtime/`、
//! `npm-global/`）、更新包、用户本地插件和外观设置；运行环境与工具链必须保留，
//! 否则换服务器后要重新下载 Node/Trellis。
//!
//! 顺序固定为「先备份、再删除」；任何删除失败都会用备份恢复已删项。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Local};

pub const BACKUP_PREFIX: &str = "data-backup-";
pub const KEEP_BACKUPS: usize = 3;
/// 清理项（相对 data 目录）。固定清单，不遍历目录，避免误删运行环境。
pub const RESET_ITEMS: [&str; 3] = ["client.json", "agent", "desktop-plugins"];

const REMOVE_ATTEMPTS: usize = 5;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct ResetOutcome {
    pub data_dir: PathBuf,
    pub backup_dir: PathBuf,
    /// 已成功删除的清理项（相对 data_dir），登录失败时据此恢复。
    pub removed: Vec<String>,
}

/// 服务器地址是否真的发生了切换；两侧都做与登录一致的归一化（尾部 `/`、
/// 主机大小写、默认端口、子路径），只有首次登录（没有旧地址）返回 `false`。
pub fn server_switched(previous: Option<&str>, next: &str) -> Result<bool, String> {
    let next = normalize_server_url(next)?;
    let Some(previous) = previous.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(false);
    };
    // 历史配置理论上已是归一化格式；解析失败就退回原样比较，绝不因此误清数据。
    let previous = normalize_server_url(previous).unwrap_or_else(|_| previous.to_string());
    Ok(previous != next)
}

pub fn normalize_server_url(input: &str) -> Result<String, String> {
    let board = crate::navigation::validate_board_url(input)?;
    Ok(crate::navigation::board_server_url(&board))
}

/// 备份根目录：data 目录的同级目录（Windows 即 `%LOCALAPPDATA%\TrellisBoard`）。
pub fn backup_root(data_dir: &Path) -> PathBuf {
    match data_dir.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

pub fn backup_dir_name(now: DateTime<Local>) -> String {
    format!("{BACKUP_PREFIX}{}", now.format("%Y%m%d-%H%M%S"))
}

/// 备份 + 清理。备份失败时源数据保持原样；删除失败时用备份恢复已删项。
pub fn backup_and_clear(data_dir: &Path, now: DateTime<Local>) -> Result<ResetOutcome, String> {
    let present: Vec<String> = RESET_ITEMS
        .iter()
        .map(|name| (*name).to_string())
        .filter(|name| data_dir.join(name).exists())
        .collect();
    let root = backup_root(data_dir);
    let backup_dir = unique_backup_dir(&root, &backup_dir_name(now));
    let mut outcome = ResetOutcome {
        data_dir: data_dir.to_path_buf(),
        backup_dir: backup_dir.clone(),
        removed: Vec::new(),
    };

    if let Err(error) = copy_items(data_dir, &present, &backup_dir) {
        let _ = fs::remove_dir_all(&backup_dir);
        return Err(format!("备份客户端数据失败，已取消切换：{error}"));
    }

    for name in &present {
        if let Err(error) = remove_path(&data_dir.join(name)) {
            // 失败项可能已被部分删除（例如目录删到一半被占用）：一并纳入恢复范围，
            // restore 会先移除现存目标再整份复制，不会留下半删状态。
            outcome.removed.push(name.clone());
            let restore_error = restore(&outcome).err();
            let mut message = format!("清理旧服务器数据失败：{error}；已尝试恢复原数据");
            if let Some(restore_error) = restore_error {
                message.push_str(&format!(
                    "（恢复失败：{restore_error}，备份目录 {}）",
                    backup_dir.display()
                ));
            }
            return Err(message);
        }
        outcome.removed.push(name.clone());
    }
    Ok(outcome)
}

/// 用备份恢复被清理的项：先移除现存同名项，再从备份复制回来。
pub fn restore(outcome: &ResetOutcome) -> Result<(), String> {
    for name in &outcome.removed {
        let target = outcome.data_dir.join(name);
        if target.exists() {
            remove_path(&target)?;
        }
        let source = outcome.backup_dir.join(name);
        if !source.exists() {
            continue;
        }
        copy_entry(&source, &target)?;
    }
    Ok(())
}

/// 只保留最近 `keep` 份备份，返回被删除的目录。
pub fn prune_backups(root: &Path, keep: usize) -> Vec<PathBuf> {
    let mut backups: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return backups;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let matches_prefix = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(BACKUP_PREFIX))
            .unwrap_or(false);
        if matches_prefix && path.is_dir() {
            backups.push(path);
        }
    }
    // 目录名以本地时间戳结尾，倒序即时间倒序。
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    let mut removed = Vec::new();
    for path in backups.into_iter().skip(keep) {
        if fs::remove_dir_all(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

fn unique_backup_dir(root: &Path, name: &str) -> PathBuf {
    let mut candidate = root.join(name);
    let mut index = 2;
    while candidate.exists() {
        candidate = root.join(format!("{name}-{index}"));
        index += 1;
    }
    candidate
}

fn copy_items(data_dir: &Path, names: &[String], backup_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(backup_dir)
        .map_err(|error| format!("无法创建备份目录 {}：{error}", backup_dir.display()))?;
    for name in names {
        copy_entry(&data_dir.join(name), &backup_dir.join(name))?;
    }
    Ok(())
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::metadata(source)
        .map_err(|error| format!("无法读取 {}：{error}", source.display()))?;
    if metadata.is_dir() {
        fs::create_dir_all(target)
            .map_err(|error| format!("无法创建目录 {}：{error}", target.display()))?;
        let entries = fs::read_dir(source)
            .map_err(|error| format!("无法读取目录 {}：{error}", source.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| format!("无法遍历目录 {}：{error}", source.display()))?;
            copy_entry(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}：{error}", parent.display()))?;
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("无法复制 {}：{error}", source.display()))
}

/// Windows 上被杀掉的子进程可能短暂持有文件句柄，删除按退避重试。
fn remove_path(path: &Path) -> Result<(), String> {
    let mut last_error: Option<std::io::Error> = None;
    for attempt in 0..REMOVE_ATTEMPTS {
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        if attempt + 1 < REMOVE_ATTEMPTS {
            std::thread::sleep(REMOVE_RETRY_DELAY);
        }
    }
    Err(last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "未知错误".to_string()))
}

#[cfg(test)]
#[path = "client_reset/tests.rs"]
mod tests;
