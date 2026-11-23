use super::*;

#[test]
fn builds_fixed_arguments_in_order() {
    let base = std::env::temp_dir();
    let repo = base.join("trellis-git-args-repo");
    let hooks = base.join("trellis-git-args-hooks");
    let args =
        git_args(GitOperation::Status, &repo, &hooks, &GitParams::default()).expect("status args");
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

    let merged =
        git_args(GitOperation::Merge, &repo, &hooks, &GitParams::default()).expect("merge args");
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
    assert!(status_paths.ends_with(&["--".to_string(), "a.txt".to_string(), "b.txt".to_string(),]));
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
fn builds_write_operation_arguments() {
    let repo = std::env::temp_dir().join("trellis-git-write-repo");
    let hooks = std::env::temp_dir().join("trellis-git-write-hooks");
    let paths = vec![".trellis".to_string(), ".gitignore".to_string()];

    let add = git_args(
        GitOperation::AddPaths,
        &repo,
        &hooks,
        &GitParams {
            paths: &paths,
            ..Default::default()
        },
    )
    .expect("add args");
    assert!(add.ends_with(&[
        "add".to_string(),
        "-A".to_string(),
        "--".to_string(),
        ".trellis".to_string(),
        ".gitignore".to_string(),
    ]));

    let diff = git_args(
        GitOperation::DiffCachedQuiet,
        &repo,
        &hooks,
        &GitParams {
            paths: &paths,
            ..Default::default()
        },
    )
    .expect("diff cached args");
    assert!(diff.contains(&"core.fsmonitor=false".to_string()));
    assert!(diff.ends_with(&[
        "diff".to_string(),
        "--cached".to_string(),
        "--quiet".to_string(),
        "--".to_string(),
        ".trellis".to_string(),
        ".gitignore".to_string(),
    ]));

    let commit = git_args(
        GitOperation::CommitPaths,
        &repo,
        &hooks,
        &GitParams {
            message: Some("初始化trellis"),
            paths: &paths,
            ..Default::default()
        },
    )
    .expect("commit args");
    assert!(commit.ends_with(&[
        "commit".to_string(),
        "-m".to_string(),
        "初始化trellis".to_string(),
        "--".to_string(),
        ".trellis".to_string(),
        ".gitignore".to_string(),
    ]));

    let push = git_args(
        GitOperation::PushBranch,
        &repo,
        &hooks,
        &GitParams {
            branch: Some("feature/x"),
            ..Default::default()
        },
    )
    .expect("push args");
    assert!(push.ends_with(&[
        "push".to_string(),
        "origin".to_string(),
        "refs/heads/feature/x:refs/heads/feature/x".to_string(),
    ]));
}

#[test]
fn rejects_write_operations_without_paths_message_or_valid_branch() {
    for operation in [
        GitOperation::AddPaths,
        GitOperation::DiffCachedQuiet,
        GitOperation::CommitPaths,
    ] {
        let error = git_args(
            operation,
            Path::new("repo"),
            Path::new("hooks"),
            &GitParams {
                message: Some("初始化trellis"),
                ..Default::default()
            },
        )
        .expect_err("missing paths");
        assert_eq!(error.message, "Git 路径参数缺失");
    }

    let paths = vec![".trellis".to_string()];
    let error = git_args(
        GitOperation::CommitPaths,
        Path::new("repo"),
        Path::new("hooks"),
        &GitParams {
            paths: &paths,
            ..Default::default()
        },
    )
    .expect_err("missing message");
    assert_eq!(error.message, "提交信息缺失");

    let error = git_args(
        GitOperation::PushBranch,
        Path::new("repo"),
        Path::new("hooks"),
        &GitParams {
            branch: Some("bad branch"),
            ..Default::default()
        },
    )
    .expect_err("invalid branch");
    assert_eq!(error.code, code::BRANCH_INVALID);
}

#[test]
fn classifies_commit_and_push_failures() {
    assert!(classify_commit_failure("fatal: Please tell me who you are")
        .message
        .contains("user.name"));
    assert!(
        classify_commit_failure("fatal: unable to auto-detect email address")
            .message
            .contains("user.email")
    );
    let generic = classify_commit_failure("fatal: something else");
    assert!(generic.message.starts_with("Git 提交失败："));

    assert_eq!(
        classify_push_failure("error: failed to push some refs (non-fast-forward)").code,
        code::NO_FAST_FORWARD
    );
    assert_eq!(
        classify_push_failure("! [rejected] main -> main (fetch first)").code,
        code::NO_FAST_FORWARD
    );
    assert_eq!(
        classify_push_failure("fatal: unable to access 'https://example.com/repo.git'").code,
        code::REMOTE_UNREACHABLE
    );
    assert_eq!(
        classify_push_failure("fatal: something else").code,
        code::GIT_FAILED
    );
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
        vec![".trellis/tasks/old/prd.md", ".trellis/tasks/new/prd.md"]
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

fn run_git_in(cwd: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new(GIT_BINARY)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[tokio::test]
async fn maps_diff_cached_exit_codes_and_commits_only_fixed_paths() {
    let repo = git_test_repo("write-ops");
    let hooks = repo.join("hooks");
    std::fs::create_dir_all(&hooks).expect("create hooks");
    run_git_in(&repo, &["config", "user.name", "Trellis Test"]);
    run_git_in(&repo, &["config", "user.email", "test@example.com"]);
    std::fs::create_dir_all(repo.join(".trellis")).expect("create trellis");
    std::fs::write(repo.join(".trellis").join("init.md"), "trellis").expect("write trellis");
    std::fs::write(repo.join("other.txt"), "other").expect("write other");
    run_git_in(&repo, &["add", "other.txt"]);

    let paths = vec![".trellis".to_string()];
    add_paths(&repo, &hooks, &paths).await.expect("add paths");
    assert!(has_staged_changes(&repo, &hooks, &paths)
        .await
        .expect("staged"));
    commit_paths(&repo, &hooks, "初始化trellis", &paths)
        .await
        .expect("commit");
    assert!(!has_staged_changes(&repo, &hooks, &paths)
        .await
        .expect("clean"));

    let show = run_git_in(&repo, &["show", "--name-only", "--format="]);
    assert!(show.lines().any(|line| line.trim() == ".trellis/init.md"));
    assert!(!show.lines().any(|line| line.trim() == "other.txt"));
    let staged = run_git_in(&repo, &["diff", "--cached", "--name-only"]);
    assert!(staged.lines().any(|line| line.trim() == "other.txt"));

    let not_a_repo =
        std::env::temp_dir().join(format!("trellis-git-non-repo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&not_a_repo).expect("create non repo");
    let error = has_staged_changes(&not_a_repo, &hooks, &paths)
        .await
        .expect_err("not a repository");
    assert_eq!(error.code, code::GIT_FAILED);

    std::fs::remove_dir_all(&repo).expect("cleanup");
    std::fs::remove_dir_all(&not_a_repo).expect("cleanup");
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
