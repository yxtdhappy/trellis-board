use super::*;
use std::process::Command;

struct TempRepo {
    root: PathBuf,
    hooks: PathBuf,
}

impl TempRepo {
    fn new(tag: &str) -> Self {
        let base =
            std::env::temp_dir().join(format!("trellis-onboarding-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).expect("create temp dir");
        Self {
            root: base.join("repo"),
            hooks: base.join("hooks"),
        }
    }
}

impl Drop for TempRepo {
    fn drop(&mut self) {
        if let Some(base) = self.root.parent() {
            let _ = std::fs::remove_dir_all(base);
        }
    }
}

fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
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

fn init_repo(tag: &str, origin: Option<&str>) -> TempRepo {
    let repo = TempRepo::new(tag);
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    git(&repo.root, &["init", "-b", "main"]);
    if let Some(origin) = origin {
        git(&repo.root, &["remote", "add", "origin", origin]);
    }
    repo
}

fn commit_all(repo: &Path) {
    git(repo, &["add", "."]);
    git(
        repo,
        &[
            "-c",
            "user.name=Trellis Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-m",
            "init",
        ],
    );
}

#[tokio::test]
async fn rejects_non_git_directory() {
    let repo = TempRepo::new("non-git");
    std::fs::create_dir_all(&repo.root).expect("create dir");
    let error = inspect_project(&repo.root, &repo.hooks, false)
        .await
        .expect_err("non git dir");
    assert_eq!(error.code, code::NOT_GIT_REPOSITORY);
}

#[tokio::test]
async fn reports_missing_trellis_as_requires_initialization() {
    if !git_available() {
        return;
    }
    let repo = init_repo("missing-trellis", Some("https://example.com/team/repo.git"));
    let inspected = inspect_project(&repo.root, &repo.hooks, false)
        .await
        .expect("inspect repo");
    assert!(!inspected.has_trellis);
    assert!(!inspected.has_tasks);
    assert!(!inspected.has_committed_trellis);
    assert!(inspected.requires_initialization);
    assert_eq!(inspected.branch_name, "main");
    assert_eq!(inspected.head, None);
    assert!(inspected.clean);
    assert_eq!(inspected.repository_name, "repo");
    assert_eq!(inspected.remote_url, "https://example.com/team/repo.git");
    assert_eq!(inspected.local_repo_key.len(), 64);
    assert_eq!(inspected.remote_identity_key.len(), 64);
}

#[tokio::test]
async fn reports_existing_agent_tools_from_worktree() {
    if !git_available() {
        return;
    }
    let repo = init_repo("agent-tools", Some("https://example.com/team/repo.git"));
    std::fs::create_dir_all(repo.root.join(".cursor")).expect("create cursor dir");
    std::fs::write(repo.root.join(".cursor/mcp.json"), "{}").expect("write cursor config");
    let inspected = inspect_project(&repo.root, &repo.hooks, false)
        .await
        .expect("inspect repo");
    assert_eq!(inspected.existing_agent_tools, vec!["cursor".to_string()]);
    // 工作区出现未跟踪目录 → 不再 clean：校验 status 结果被如实透传。
    assert!(!inspected.clean);
    assert!(inspected.dirty_summary.contains(".cursor"));
}

#[tokio::test]
async fn maps_git_failures_to_agent_codes() {
    if !git_available() {
        return;
    }
    let missing_origin = init_repo("no-origin", None);
    let error = inspect_project(&missing_origin.root, &missing_origin.hooks, false)
        .await
        .expect_err("missing origin");
    assert_eq!(error.code, code::REMOTE_MISSING);

    let local_origin = init_repo("local-origin", Some("C:/tmp/repo"));
    let error = inspect_project(&local_origin.root, &local_origin.hooks, false)
        .await
        .expect_err("local path origin");
    assert_eq!(error.code, code::REMOTE_INVALID);

    let subdir = init_repo("subdir", Some("https://example.com/team/repo.git"));
    let nested = subdir.root.join("nested");
    std::fs::create_dir_all(&nested).expect("create nested dir");
    let error = inspect_project(&nested, &subdir.hooks, false)
        .await
        .expect_err("sub directory");
    assert_eq!(error.code, code::REPO_PATH_INVALID);
}

#[test]
fn normalizes_https_remote_identity_with_stable_hash() {
    let identity = normalize_remote_identity("https://GitHub.com/Team/Repo.git", false)
        .expect("https identity");
    assert_eq!(identity.host, "github.com");
    assert_eq!(identity.port, 0);
    assert_eq!(identity.path, "Team/Repo");
    let expected = sha256_hex(br#"{"host":"github.com","port":0,"path":"Team/Repo"}"#);
    assert_eq!(identity.identity_hash, expected);

    let custom_port = normalize_remote_identity("ssh://git@example.com:2222/team/repo.git", false)
        .expect("ssh identity");
    assert_eq!(custom_port.port, 2222);
    assert_eq!(custom_port.host, "example.com");
    assert_eq!(custom_port.path, "team/repo");
}

#[test]
fn rejects_invalid_remote_shapes() {
    assert_eq!(
        normalize_remote_identity("https://user:token@example.com/repo.git", false)
            .expect_err("credentials")
            .code,
        code::REMOTE_INVALID
    );
    assert_eq!(
        normalize_remote_identity("", false)
            .expect_err("empty")
            .code,
        code::REMOTE_INVALID
    );
    assert_eq!(
        normalize_remote_identity("ftp://example.com/repo.git", false)
            .expect_err("protocol")
            .code,
        code::REMOTE_INVALID
    );
    assert_eq!(
        normalize_remote_identity("file:///C:/repos/demo.git", false)
            .expect_err("file remote without opt in")
            .code,
        code::REMOTE_INVALID
    );
    let file = normalize_remote_identity("file:///C:/repos/demo.git", true).expect("file remote");
    assert_eq!(file.host, "file");
    assert_eq!(file.path, "C:/repos/demo");
}

#[test]
fn parses_scp_style_remote() {
    let identity =
        normalize_remote_identity("git@example.com:team/repo.git", false).expect("scp identity");
    assert_eq!(identity.host, "example.com");
    assert_eq!(identity.port, 0);
    assert_eq!(identity.path, "team/repo");

    let ipv6 = normalize_remote_identity("git@[::1]:team/repo.git", false).expect("ipv6 identity");
    assert_eq!(ipv6.host, "::1");
    assert_eq!(ipv6.path, "team/repo");
}

#[tokio::test]
async fn reports_initial_push_state_for_missing_remote_branch() {
    if !git_available() {
        return;
    }
    let bare = TempRepo::new("bare-remote");
    std::fs::create_dir_all(&bare.root).expect("create bare dir");
    git(&bare.root, &["init", "--bare"]);
    let origin = bare.root.to_string_lossy().replace('\\', "/");
    let repo = init_repo("initial-push", Some(origin.as_str()));
    std::fs::create_dir_all(repo.root.join(".trellis").join("tasks")).expect("create tasks");
    std::fs::write(
        repo.root.join(".trellis").join("tasks").join("t1.md"),
        "task",
    )
    .expect("write task");
    commit_all(&repo.root);

    let pushed = check_initial_push_with(&repo.root, &repo.hooks, "main", true)
        .await
        .expect("check push");
    assert!(pushed.is_branch_missing());
    assert!(pushed.message.contains("main"));
    assert!(pushed.local_head.is_some());

    git(&repo.root, &["push", "origin", "main"]);
    let ready = check_initial_push_with(&repo.root, &repo.hooks, "main", true)
        .await
        .expect("check push after push");
    assert!(ready.is_ready());
    assert_eq!(ready.local_head, ready.remote_head);

    let preflight = preflight_project_with(&repo.root, &repo.hooks, "team-1", true, true)
        .await
        .expect("preflight after push");
    assert!(preflight.push.is_some_and(|push| push.is_ready()));
    assert!(!preflight.inspected.requires_initialization);
}

#[tokio::test]
async fn requires_pushed_commit_rejects_waiting_state() {
    if !git_available() {
        return;
    }
    let repo = init_repo("waiting-commit", Some("https://example.com/team/repo.git"));
    std::fs::create_dir_all(repo.root.join(".trellis").join("tasks")).expect("create tasks");
    let error = preflight_project_with(&repo.root, &repo.hooks, "team-1", false, true)
        .await
        .expect_err("uncommitted trellis");
    assert_eq!(error.code, code::LOCAL_AHEAD);
    assert!(error.message.contains(".trellis"));
}

#[test]
fn normalizes_agent_tool_selection() {
    assert_eq!(
        normalize_agent_tools(&[" claude-code ".to_string(), "pi".to_string()])
            .expect("supported tools"),
        vec!["claude-code".to_string(), "pi".to_string()]
    );
    assert_eq!(
        normalize_agent_tools(&[]).expect_err("empty").code,
        code::COMMAND_INVALID
    );
    assert_eq!(
        normalize_agent_tools(&["pi".to_string(), "pi".to_string()])
            .expect_err("duplicate")
            .code,
        code::COMMAND_INVALID
    );
    assert_eq!(
        normalize_agent_tools(&["nope".to_string()])
            .expect_err("unknown")
            .code,
        code::COMMAND_INVALID
    );
    assert_eq!(
        normalize_agent_tools(&["cursor".to_string()])
            .expect_err("unsupported")
            .code,
        code::COMMAND_INVALID
    );
}

#[test]
fn validates_initial_sync_mode() {
    assert_eq!(
        normalize_initial_sync_mode(None).expect("default"),
        "review"
    );
    assert_eq!(
        normalize_initial_sync_mode(Some("bootstrap")).expect("bootstrap"),
        "bootstrap"
    );
    assert_eq!(
        normalize_initial_sync_mode(Some("unsafe"))
            .expect_err("invalid mode")
            .code,
        code::COMMAND_INVALID
    );
}

#[test]
fn selects_initialization_mode() {
    assert_eq!(
        initialization_mode(false, false, false),
        InitializationMode::FullInit
    );
    assert_eq!(
        initialization_mode(true, false, true),
        InitializationMode::FullInit
    );
    assert_eq!(
        initialization_mode(true, true, true),
        InitializationMode::AgentsOnly
    );
    assert_eq!(
        initialization_mode(true, true, false),
        InitializationMode::None
    );
}

#[tokio::test]
async fn reads_developer_name_from_trellis_developer_file() {
    let repo = TempRepo::new("developer-name");
    std::fs::create_dir_all(repo.root.join(".trellis")).expect("create trellis");
    let developer = repo.root.join(".trellis").join(".developer");

    assert_eq!(read_developer_name(&repo.root).await, None);

    std::fs::write(
        &developer,
        "name=yhj\ninitialized_at=2026-11-07T20:57:57.226493\n",
    )
    .expect("write developer");
    assert_eq!(
        read_developer_name(&repo.root).await.as_deref(),
        Some("yhj")
    );

    std::fs::write(&developer, "name=\ninitialized_at=x\n").expect("write empty name");
    assert_eq!(read_developer_name(&repo.root).await, None);

    std::fs::write(&developer, "name=yhj\r\ninitialized_at=x\r\n").expect("write crlf");
    assert_eq!(
        read_developer_name(&repo.root).await.as_deref(),
        Some("yhj")
    );
}

#[tokio::test]
async fn inspection_exposes_developer_name_from_local_file() {
    if !git_available() {
        return;
    }
    let repo = init_repo(
        "developer-inspection",
        Some("https://example.com/team/repo.git"),
    );
    std::fs::create_dir_all(repo.root.join(".trellis")).expect("create trellis");
    std::fs::write(repo.root.join(".trellis").join(".developer"), "name=yhj\n")
        .expect("write developer");
    let inspected = inspect_project(&repo.root, &repo.hooks, false)
        .await
        .expect("inspect repo");
    assert_eq!(inspected.developer_name.as_deref(), Some("yhj"));
}

#[tokio::test]
async fn creates_gitignore_with_selected_agent_rules() {
    let repo = TempRepo::new("gitignore-create");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    ensure_agent_gitignore(
        &repo.root,
        &["codex".to_string(), "claude-code".to_string()],
    )
    .await
    .expect("ensure gitignore");
    assert_eq!(
        std::fs::read_to_string(repo.root.join(".gitignore")).expect("read gitignore"),
        "# Trellis local agent configs (local only)\n/.claude/\n/.codex/\n# Trellis local state (local only)\n/.trellis/.template-hashes.json\n"
    );
}

#[tokio::test]
async fn appends_gitignore_rules_and_preserves_content_and_newlines() {
    let repo = TempRepo::new("gitignore-append");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    let path = repo.root.join(".gitignore");

    std::fs::write(&path, "/node_modules").expect("write gitignore");
    ensure_agent_gitignore(&repo.root, &["codex".to_string()])
        .await
        .expect("ensure gitignore");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read gitignore"),
        "/node_modules\n# Trellis local agent configs (local only)\n/.codex/\n# Trellis local state (local only)\n/.trellis/.template-hashes.json\n"
    );

    std::fs::write(
        &path,
        "dist/\r\n# Trellis local agent configs (local only)\r\n",
    )
    .expect("write crlf gitignore");
    ensure_agent_gitignore(&repo.root, &["claude-code".to_string()])
        .await
        .expect("ensure gitignore crlf");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read gitignore"),
        "dist/\r\n# Trellis local agent configs (local only)\r\n/.claude/\r\n# Trellis local state (local only)\r\n/.trellis/.template-hashes.json\r\n"
    );
}

#[tokio::test]
async fn dedupes_equivalent_gitignore_rules_and_is_idempotent() {
    let repo = TempRepo::new("gitignore-dedupe");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    let path = repo.root.join(".gitignore");
    std::fs::write(&path, "codex\n/.codex/\n").expect("write gitignore");

    ensure_agent_gitignore(&repo.root, &["codex".to_string()])
        .await
        .expect("ensure gitignore");
    let first = std::fs::read_to_string(&path).expect("read gitignore");
    assert_eq!(
        first,
        "codex\n/.codex/\n# Trellis local state (local only)\n/.trellis/.template-hashes.json\n"
    );

    ensure_agent_gitignore(&repo.root, &["codex".to_string()])
        .await
        .expect("ensure gitignore again");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read gitignore"),
        first
    );
}

#[tokio::test]
async fn writes_manifest_rule_even_without_selected_agent_tools() {
    let repo = TempRepo::new("gitignore-no-tools");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    ensure_agent_gitignore(&repo.root, &[])
        .await
        .expect("ensure gitignore");
    assert_eq!(
        std::fs::read_to_string(repo.root.join(".gitignore")).expect("read gitignore"),
        "# Trellis local state (local only)\n/.trellis/.template-hashes.json\n"
    );
}

#[tokio::test]
async fn dedupes_manifest_rule_without_leading_slash() {
    let repo = TempRepo::new("gitignore-manifest-dedupe");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    let path = repo.root.join(".gitignore");
    std::fs::write(&path, ".trellis/.template-hashes.json\n").expect("write gitignore");

    ensure_agent_gitignore(&repo.root, &[])
        .await
        .expect("ensure gitignore");
    assert_eq!(
        std::fs::read_to_string(&path).expect("read gitignore"),
        ".trellis/.template-hashes.json\n"
    );
}

#[tokio::test]
async fn untracks_manifest_before_initial_commit() {
    if !git_available() {
        return;
    }
    let bare = TempRepo::new("untrack-bare");
    std::fs::create_dir_all(&bare.root).expect("create bare dir");
    git(&bare.root, &["init", "--bare"]);
    let origin = bare.root.to_string_lossy().replace('\\', "/");
    let repo = init_repo("untrack-manifest", Some(origin.as_str()));
    git(&repo.root, &["config", "user.name", "Trellis Test"]);
    git(&repo.root, &["config", "user.email", "test@example.com"]);
    std::fs::create_dir_all(repo.root.join(".trellis")).expect("create trellis");
    // 真实项目里 .trellis 还有 workflow.md 等文件；否则脱管后 HEAD 里干脆没有 .trellis。
    std::fs::write(repo.root.join(".trellis").join("workflow.md"), "# 流程\n")
        .expect("write workflow");
    std::fs::write(
        repo.root.join(".trellis").join(".template-hashes.json"),
        "{}\n",
    )
    .expect("write hashes");
    std::fs::write(repo.root.join("AGENTS.md"), "# Trellis\n").expect("write agents");
    git(&repo.root, &["add", "."]);
    git(&repo.root, &["commit", "-m", "seed"]);

    let state = commit_and_push_initial(&repo.root, &repo.hooks, true)
        .await
        .expect("commit and push");
    assert!(state.is_ready(), "{}", state.message);
    let tracked = git(&repo.root, &["ls-files"]);
    assert!(tracked
        .lines()
        .any(|line| line.trim() == ".trellis/workflow.md"));
    assert!(!tracked
        .lines()
        .any(|line| line.trim() == TEMPLATE_HASHES_PATH));
    let status = git(&repo.root, &["status", "--porcelain"]);
    assert!(!status
        .lines()
        .any(|line| line.contains(".template-hashes.json")));
    let gitignore =
        std::fs::read_to_string(repo.root.join(".gitignore")).expect("read gitignore");
    assert!(gitignore.contains(TEMPLATE_HASHES_RULE));
    assert!(
        repo.root.join(TEMPLATE_HASHES_PATH).exists(),
        "manifest 工作区文件应保留"
    );
}

#[test]
fn recognizes_initial_commit_paths() {
    for path in [
        ".gitignore",
        ".gitattributes",
        "AGENTS.md",
        ".trellis/workflow.md",
        ".agents/skills/trellis.md",
    ] {
        assert!(is_initial_commit_path(path), "{path}");
    }
    for path in [".trellisx/a", "src/main.rs", ".gitignore.bak", "docs/AGENTS.md"] {
        assert!(!is_initial_commit_path(path), "{path}");
    }
}

#[test]
fn contains_trellis_entry_matches_only_trellis_paths() {
    assert!(contains_trellis_entry(&[
        ".trellis/tasks/a/prd.md".to_string()
    ]));
    assert!(!contains_trellis_entry(&[".trellisx/a.md".to_string()]));
    assert!(!contains_trellis_entry(&[]));
}

#[test]
fn selects_existing_initial_commit_paths() {
    let repo = TempRepo::new("initial-paths");
    std::fs::create_dir_all(&repo.root).expect("create repo dir");
    assert_eq!(
        initial_commit_paths(&repo.root),
        vec![".trellis".to_string()]
    );

    std::fs::write(repo.root.join(".gitignore"), "").expect("write gitignore");
    std::fs::write(repo.root.join("AGENTS.md"), "").expect("write agents");
    std::fs::write(repo.root.join(".gitattributes"), "").expect("write gitattributes");
    std::fs::create_dir_all(repo.root.join(".agents")).expect("create agents dir");
    assert_eq!(
        initial_commit_paths(&repo.root),
        vec![
            ".trellis".to_string(),
            ".gitignore".to_string(),
            "AGENTS.md".to_string(),
            ".gitattributes".to_string(),
            ".agents".to_string(),
        ]
    );

    std::fs::write(repo.root.join("unrelated.txt"), "").expect("write unrelated");
    assert_eq!(initial_commit_paths(&repo.root).len(), 5);
}

#[tokio::test]
async fn commits_and_pushes_only_initialization_paths() {
    if !git_available() {
        return;
    }
    let bare = TempRepo::new("push-bare");
    std::fs::create_dir_all(&bare.root).expect("create bare dir");
    git(&bare.root, &["init", "--bare"]);
    let origin = bare.root.to_string_lossy().replace('\\', "/");
    let repo = init_repo("push-initial", Some(origin.as_str()));
    git(&repo.root, &["config", "user.name", "Trellis Test"]);
    git(&repo.root, &["config", "user.email", "test@example.com"]);
    std::fs::create_dir_all(repo.root.join(".trellis").join("tasks")).expect("create tasks");
    std::fs::write(
        repo.root.join(".trellis").join("tasks").join("t1.md"),
        "task",
    )
    .expect("write task");
    std::fs::write(repo.root.join(".gitignore"), "/.codex/\n").expect("write gitignore");
    std::fs::write(repo.root.join("AGENTS.md"), "# Trellis\n").expect("write agents");
    std::fs::write(repo.root.join(".gitattributes"), "* text=auto\n").expect("write gitattributes");
    std::fs::create_dir_all(repo.root.join(".agents").join("skills").join("trellis"))
        .expect("create agents skills");
    std::fs::write(
        repo.root
            .join(".agents")
            .join("skills")
            .join("trellis")
            .join("SKILL.md"),
        "# skill\n",
    )
    .expect("write skill");
    std::fs::write(repo.root.join("other.txt"), "other").expect("write other");
    // 用户已有的暂存改动不能被卷入初始化提交。
    git(&repo.root, &["add", "other.txt"]);

    let state = commit_and_push_initial(&repo.root, &repo.hooks, true)
        .await
        .expect("commit and push");
    assert!(state.is_ready(), "{}", state.message);
    assert_eq!(
        git(&repo.root, &["log", "-1", "--format=%s"]).trim(),
        "初始化trellis"
    );

    let committed = git(&repo.root, &["show", "--name-only", "--format="]);
    let committed: Vec<&str> = committed
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    assert!(committed.contains(&".gitignore"));
    assert!(committed.contains(&"AGENTS.md"));
    assert!(committed.contains(&".gitattributes"));
    assert!(committed.contains(&".agents/skills/trellis/SKILL.md"));
    assert!(committed.iter().any(|path| path.starts_with(".trellis/")));
    assert!(!committed.contains(&"other.txt"));
    let staged = git(&repo.root, &["diff", "--cached", "--name-only"]);
    assert!(staged.lines().any(|line| line.trim() == "other.txt"));

    // 未出生分支完成 root commit 后，第二次点击只推送，不产生空提交。
    let head_before = git(&repo.root, &["rev-parse", "HEAD"]);
    let again = commit_and_push_initial(&repo.root, &repo.hooks, true)
        .await
        .expect("second commit and push");
    assert!(again.is_ready(), "{}", again.message);
    assert_eq!(git(&repo.root, &["rev-parse", "HEAD"]), head_before);
    assert_eq!(
        git(&repo.root, &["rev-list", "--count", "HEAD"]).trim(),
        "1"
    );
    let remote_head = git(&bare.root, &["rev-parse", "refs/heads/main"]);
    assert_eq!(again.local_head.as_deref(), Some(remote_head.trim()));
}
