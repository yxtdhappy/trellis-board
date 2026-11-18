use super::*;

#[test]
fn builds_fixed_arguments_in_order() {
    let base = std::env::temp_dir();
    let repo = base.join("trellis-git-args-repo");
    let hooks = base.join("trellis-git-args-hooks");
    let args = git_args(GitOperation::Status, &repo, &hooks, &GitParams::default())
        .expect("status args");
    assert_eq!(
        args,
        vec![
            "-C".to_string(),
            repo.to_string_lossy().into_owned(),
            "-c".to_string(),
            format!("core.hooksPath={}", hooks.to_string_lossy()),
            "-c".to_string(),
            "core.autocrlf=false".to_string(),
            "-c".to_string(),
            "http.sslVerify=true".to_string(),
            "-c".to_string(),
            format!("core.sshCommand={FIXED_SSH_COMMAND}"),
            "-c".to_string(),
            "core.fsmonitor=false".to_string(),
            "status".to_string(),
            "--porcelain=v1".to_string(),
            "--untracked-files=normal".to_string(),
        ]
    );

    let merged = git_args(GitOperation::Merge, &repo, &hooks, &GitParams::default())
        .expect("merge args");
    assert!(merged.ends_with(&[
        "--no-overwrite-ignore".to_string(),
        "FETCH_HEAD".to_string()
    ]));

    let paths = vec!["a.txt".to_string(), "b.txt".to_string()];
    let status_paths = git_args(
        GitOperation::StatusPaths,
        &repo,
        &hooks,
        &GitParams {
            paths: &paths,
            ..Default::default()
        },
    )
    .expect("status paths args");
    assert!(status_paths.ends_with(&[
        "--".to_string(),
        "a.txt".to_string(),
        "b.txt".to_string(),
    ]));
}

#[test]
fn rejects_forbidden_operations_and_invalid_markers() {
    let error = git_args(
        GitOperation::GitPath,
        Path::new("repo"),
        Path::new("hooks"),
        &GitParams {
            marker: Some("NOT_A_MARKER"),
            ..Default::default()
        },
    )
    .expect_err("invalid marker");
    assert_eq!(error.message, "Git 状态标记无效");
}

#[test]
fn parses_status_with_renames_and_untracked() {
    let output = concat!(
        " M src/lib.rs\r\n",
        "R  .trellis/tasks/old -> .trellis/tasks/new\n",
        "?? docs/新文件.md\n",
        "A  added.txt\n"
    );
    let entries = parse_status(output);
    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0].status, " M");
    assert_eq!(entries[0].path, "src/lib.rs");
    assert_eq!(entries[1].status, "R ");
    assert_eq!(entries[1].path, ".trellis/tasks/new");
    assert_eq!(
        entries[1].original_path.as_deref(),
        Some(".trellis/tasks/old")
    );
    assert_eq!(entries[2].status, "??");
    assert_eq!(entries[2].path, "docs/新文件.md");
    assert_eq!(entries[3].status, "A ");
    assert_eq!(entries[3].path, "added.txt");
    assert!(parse_status("").is_empty());
    assert!(parse_status("\n").is_empty());
}

#[test]
fn parses_nul_separated_diff_tree_paths() {
    let paths = parse_diff_tree_paths(
        "D\u{0}.trellis/tasks/old/prd.md\u{0}A\u{0}.trellis/tasks/new/prd.md\u{0}",
    )
    .expect("diff paths");
    assert_eq!(
        paths,
        vec![
            ".trellis/tasks/old/prd.md",
            ".trellis/tasks/new/prd.md"
        ]
    );
    assert!(parse_diff_tree_paths("Z\u{0}.trellis/tasks/a.md\u{0}").is_err());
}

#[test]
fn detects_git_state_markers() {
    let root = std::env::temp_dir().join(format!("trellis-git-state-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).expect("create temp dir");
    assert_eq!(detect_git_state(&root), None);

    let git_dir = root.join(".git");
    std::fs::create_dir_all(&git_dir).expect("create git dir");
    assert_eq!(detect_git_state(&root), None);

    std::fs::write(git_dir.join("MERGE_HEAD"), "").expect("write marker");
    assert_eq!(detect_git_state(&root), Some("MERGE_HEAD"));

    std::fs::remove_dir_all(&root).expect("cleanup");
}

#[test]
fn classifies_merge_failures() {
    assert_eq!(
        classify_merge_failure("fatal: Not possible to fast-forward, aborting.").code,
        code::NO_FAST_FORWARD
    );
    assert_eq!(
        classify_merge_failure("error: untracked working tree files would be overwritten").code,
        code::IGNORED_FILE_CONFLICT
    );
    assert_eq!(
        classify_merge_failure("fatal: 无法访问 'https://example.com'").code,
        code::MERGE_FAILED
    );
}

fn git_test_repo(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "trellis-git-guard-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).expect("create temp dir");
    let run = |args: &[&str]| {
        let output = std::process::Command::new(GIT_BINARY)
            .args(["-C", root.to_str().expect("utf8 path")])
            .args(args)
            .output()
            .expect("run git");
        assert!(output.status.success(), "git {args:?} failed");
    };
    run(&["init", "--initial-branch=main"]);
    run(&[
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "--allow-empty",
        "-m",
        "init",
    ]);
    root
}

#[tokio::test]
async fn asserts_repository_branch_matches_binding() {
    let repo = git_test_repo("match");
    let hooks = repo.join("hooks");
    std::fs::create_dir_all(&hooks).expect("create hooks");
    assert_eq!(
        assert_repository_branch(&repo, &hooks, "main")
            .await
            .expect("matching branch"),
        "main"
    );
    let output = std::process::Command::new(GIT_BINARY)
        .args([
            "-C",
            repo.to_str().expect("utf8 path"),
            "checkout",
            "-b",
            "feature",
        ])
        .output()
        .expect("checkout");
    assert!(output.status.success());
    let error = assert_repository_branch(&repo, &hooks, "main")
        .await
        .expect_err("mismatched branch");
    assert_eq!(error.code, code::BRANCH_MISMATCH);
    assert!(error.message.contains("feature"), "{}", error.message);
    std::fs::remove_dir_all(&repo).expect("cleanup");
}
