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
