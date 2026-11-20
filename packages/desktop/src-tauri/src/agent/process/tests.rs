use super::*;

#[tokio::test]
async fn captures_output_and_exit_code() {
    let command = std::path::Path::new("C:\\Windows\\System32\\cmd.exe");
    if !command.exists() {
        return;
    }
    let output = run_process(
        command,
        &["/C", "echo hello"],
        &ProcessOptions {
            timeout: Some(Duration::from_secs(10)),
            ..Default::default()
        },
    )
    .await
    .expect("cmd runs");
    assert_eq!(output.exit_code, 0);
    assert!(output.stdout.contains("hello"));
}

#[tokio::test]
async fn times_out_long_commands() {
    let command = std::path::Path::new("C:\\Windows\\System32\\cmd.exe");
    if !command.exists() {
        return;
    }
    let result = run_process(
        command,
        &["/C", "ping -n 10 127.0.0.1 > NUL"],
        &ProcessOptions {
            timeout: Some(Duration::from_millis(300)),
            ..Default::default()
        },
    )
    .await;
    let error = result.expect_err("should time out");
    assert!(is_timeout(&error));
}

#[cfg(windows)]
#[tokio::test]
async fn decodes_system_codepage_output() {
    let command = std::path::Path::new("C:\\Windows\\System32\\cmd.exe");
    if !command.exists() {
        return;
    }
    // cmd.exe 的内建错误按系统代码页输出（中文系统即 GBK），不能整段按 UTF-8 解码。
    let output = run_process(
        command,
        &["/C", "trellis_board_missing_command_xyz"],
        &ProcessOptions {
            timeout: Some(Duration::from_secs(10)),
            ..Default::default()
        },
    )
    .await
    .expect("cmd runs");
    assert_ne!(output.exit_code, 0);
    assert!(!output.stderr.trim().is_empty());
    assert!(!output.stderr.contains('\u{FFFD}'));
    // 中文系统下应还原成 GBK 的中文提示，而不是一堆替换符或误判字符。
    if unsafe { windows::Win32::Globalization::GetOEMCP() } == 936 {
        assert!(output.stderr.contains("不是内部或外部命令"));
    }
}

#[cfg(windows)]
#[tokio::test]
async fn logs_failed_commands() {
    let command = std::path::Path::new("C:\\Windows\\System32\\cmd.exe");
    if !command.exists() {
        return;
    }
    let dir = std::env::temp_dir().join(format!("trellis-process-log-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    crate::logging::init(&dir);
    let _ = run_process(
        command,
        &["/C", "trellis_board_missing_command_xyz"],
        &ProcessOptions {
            timeout: Some(Duration::from_secs(10)),
            ..Default::default()
        },
    )
    .await
    .expect("cmd runs");
    let log = std::fs::read_to_string(dir.join("desktop.log")).expect("log file");
    assert!(log.contains("命令失败(exit="));
    assert!(log.contains("trellis_board_missing_command_xyz"));
    let _ = std::fs::remove_dir_all(&dir);
}
