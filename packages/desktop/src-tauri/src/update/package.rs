use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::manifest::{Release, MAX_PACKAGE_BYTES};

pub const EXE_NAME: &str = "trellis-board-client.exe";
const MAX_EXE_BYTES: u64 = 300 * 1024 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

pub async fn download(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
    release: &Release,
    mut progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    let response = client
        .get(url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("无法下载更新包：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载更新包失败：HTTP {}", response.status()));
    }
    if let Some(length) = response.content_length() {
        if length != release.size {
            return Err(format!(
                "更新包大小与清单不一致：服务器 {length} 字节，清单 {} 字节",
                release.size
            ));
        }
    }

    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("update.zip");
    let part = target.with_file_name(format!("{file_name}.part"));
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|error| format!("无法创建更新包临时文件：{error}"))?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_report = Instant::now();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Err(remove_part(&part, format!("下载更新包中断：{error}")).await),
        };
        downloaded += chunk.len() as u64;
        if downloaded > release.size || downloaded > MAX_PACKAGE_BYTES {
            return Err(remove_part(&part, "更新包大于清单声明的大小".to_string()).await);
        }
        hasher.update(&chunk);
        if let Err(error) = file.write_all(&chunk).await {
            return Err(remove_part(&part, format!("写入更新包失败：{error}")).await);
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            progress(downloaded, release.size);
            last_report = Instant::now();
        }
    }

    if let Err(error) = file.flush().await {
        return Err(remove_part(&part, format!("写入更新包失败：{error}")).await);
    }
    drop(file);
    if downloaded != release.size {
        return Err(remove_part(
            &part,
            format!(
                "更新包大小不符：下载 {downloaded} 字节，清单 {} 字节",
                release.size
            ),
        )
        .await);
    }
    let digest = sha256_hex(&hasher.finalize());
    if digest != release.sha256 {
        return Err(remove_part(&part, "更新包 SHA-256 校验失败".to_string()).await);
    }
    tokio::fs::rename(&part, target)
        .await
        .map_err(|error| format!("无法保存更新包：{error}"))?;
    progress(downloaded, release.size);
    Ok(())
}

async fn remove_part(part: &Path, message: String) -> String {
    let _ = tokio::fs::remove_file(part).await;
    message
}

pub fn sha256_hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn extract_executable(zip_path: &Path, destination: &Path) -> Result<PathBuf, String> {
    let file = fs::File::open(zip_path)
        .map_err(|error| format!("无法打开更新包 {}: {error}", zip_path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("更新包不是有效 ZIP：{error}"))?;
    fs::create_dir_all(destination).map_err(|error| format!("无法创建更新解压目录：{error}"))?;
    let staged = destination.join(EXE_NAME);
    let mut matched = false;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取更新包条目失败：{error}"))?;
        if !entry.is_file() {
            continue;
        }
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let depth = enclosed.components().count();
        let is_executable = (depth == 1 || depth == 2)
            && enclosed
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(EXE_NAME));
        if !is_executable {
            continue;
        }
        if matched {
            return Err("更新包包含多个客户端可执行文件".to_string());
        }
        matched = true;
        if entry.size() > MAX_EXE_BYTES {
            return Err("更新包中的客户端可执行文件过大".to_string());
        }
        let mut output = fs::File::create(&staged)
            .map_err(|error| format!("无法写入新客户端可执行文件：{error}"))?;
        let copied = io::copy(&mut entry.by_ref().take(MAX_EXE_BYTES + 1), &mut output)
            .map_err(|error| format!("解压客户端可执行文件失败：{error}"))?;
        if copied > MAX_EXE_BYTES {
            return Err("更新包中的客户端可执行文件过大".to_string());
        }
        output
            .flush()
            .map_err(|error| format!("写入新客户端可执行文件失败：{error}"))?;
    }

    if !matched {
        return Err(format!("更新包中缺少 {EXE_NAME}"));
    }
    Ok(staged)
}

pub fn replace_executable(staged: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位当前客户端：{error}"))?;
    replace_file(&exe, staged)?;
    Ok(exe)
}

fn replace_file(target: &Path, staged: &Path) -> Result<(), String> {
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法识别当前客户端文件名".to_string())?;
    let backup = target.with_file_name(format!("{file_name}.old"));
    let _ = fs::remove_file(&backup);
    fs::rename(target, &backup)
        .map_err(|error| format!("无法备份当前客户端（文件可能被占用）：{error}"))?;
    if let Err(error) = fs::copy(staged, target) {
        let _ = fs::rename(&backup, target);
        return Err(format!("替换客户端失败，已回滚：{error}"));
    }
    Ok(())
}

pub fn spawn_relaunch(exe: &Path) -> Result<(), String> {
    let directory = exe
        .parent()
        .ok_or_else(|| "无法定位客户端所在目录".to_string())?;
    launch_detached(exe, directory)
}

#[cfg(windows)]
fn launch_detached(exe: &Path, directory: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script = format!(
        "Wait-Process -Id {} -Timeout 30 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-Process -FilePath '{}' -WorkingDirectory '{}'",
        std::process::id(),
        powershell_quote(&exe.to_string_lossy()),
        powershell_quote(&directory.to_string_lossy())
    );
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法启动新版本客户端：{error}"))
}

#[cfg(not(windows))]
fn launch_detached(_exe: &Path, _directory: &Path) -> Result<(), String> {
    Err("当前平台不支持客户端自动更新".to_string())
}

#[cfg(windows)]
fn powershell_quote(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn cleanup_stale() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    if let (Some(directory), Some(file_name)) = (
        exe.parent(),
        exe.file_name().and_then(|value| value.to_str()),
    ) {
        let _ = fs::remove_file(directory.join(format!("{file_name}.old")));
    }
    let updates = crate::config::data_dir().join("updates");
    let current = env!("CARGO_PKG_VERSION");
    let Ok(entries) = fs::read_dir(&updates) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy() != current {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("trellis-update-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        use zip::write::SimpleFileOptions;
        let file = fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn formats_sha256_hex() {
        let digest = Sha256::digest(b"abc");
        assert_eq!(
            sha256_hex(&digest),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn extracts_unique_executable() {
        let directory = temp_dir("extract");
        let zip_path = directory.join("update.zip");
        write_zip(&zip_path, &[(EXE_NAME, b"new-client")]);
        let staged = extract_executable(&zip_path, &directory.join("staged")).unwrap();
        assert_eq!(fs::read(staged).unwrap(), b"new-client");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn extracts_executable_inside_portable_wrapper() {
        let directory = temp_dir("wrapper");
        let zip_path = directory.join("update.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "TrellisBoard_0.4.41_x64-portable/VERSION.txt",
                    b"boardVersion=0.4.41",
                ),
                (
                    "TrellisBoard_0.4.41_x64-portable/trellis-board-client.exe",
                    b"new-client",
                ),
            ],
        );
        let staged = extract_executable(&zip_path, &directory.join("staged")).unwrap();
        assert_eq!(fs::read(staged).unwrap(), b"new-client");
        let _ = fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn downloads_and_verifies_package() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = b"zip-bytes".to_vec();
        let server_body = body.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 1024];
            let _ = socket.read(&mut request).await.unwrap();
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(&server_body).await.unwrap();
        });

        let directory = temp_dir("download");
        let target = directory.join("update.zip");
        let release = Release {
            version: "0.4.41".to_string(),
            file: "update.zip".to_string(),
            sha256: sha256_hex(&Sha256::digest(&body)),
            size: body.len() as u64,
            notes: None,
            published_at: None,
        };
        let mut reported = None;
        download(
            &reqwest::Client::new(),
            &format!("http://{address}/update.zip"),
            &target,
            &release,
            |downloaded, total| reported = Some((downloaded, total)),
        )
        .await
        .unwrap();
        server.await.unwrap();
        assert_eq!(fs::read(&target).unwrap(), body);
        assert_eq!(reported, Some((body.len() as u64, body.len() as u64)));
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_zip_without_executable() {
        let directory = temp_dir("missing");
        let zip_path = directory.join("update.zip");
        write_zip(&zip_path, &[("notes.txt", b"hello")]);
        assert!(extract_executable(&zip_path, &directory.join("staged")).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn ignores_nested_or_traversing_entries() {
        let directory = temp_dir("nested");
        let zip_path = directory.join("update.zip");
        write_zip(
            &zip_path,
            &[
                ("nested/inner/trellis-board-client.exe", b"nested"),
                ("../trellis-board-client.exe", b"escape"),
            ],
        );
        assert!(extract_executable(&zip_path, &directory.join("staged")).is_err());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rolls_back_when_copy_fails() {
        let directory = temp_dir("rollback");
        let target = directory.join("trellis-board-client.exe");
        fs::write(&target, b"old").unwrap();
        let missing = directory.join("missing.exe");
        assert!(replace_file(&target, &missing).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn replaces_existing_executable() {
        let directory = temp_dir("replace");
        let target = directory.join("trellis-board-client.exe");
        let staged = directory.join("staged.exe");
        fs::write(&target, b"old").unwrap();
        fs::write(&staged, b"new").unwrap();
        replace_file(&target, &staged).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(directory.join("trellis-board-client.exe.old").exists());
        let _ = fs::remove_dir_all(directory);
    }
}
