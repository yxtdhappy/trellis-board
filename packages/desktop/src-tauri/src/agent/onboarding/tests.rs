use super::*;
use std::process::Command;

struct TempRepo {
    root: PathBuf,
    hooks: PathBuf,
}

impl TempRepo {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir()
            .join(format!("trellis-onboarding-{tag}-{}", uuid::Uuid::new_v4()));
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

    let custom_port =
        normalize_remote_identity("ssh://git@example.com:2222/team/repo.git", false)
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
    let file =
        normalize_remote_identity("file:///C:/repos/demo.git", true).expect("file remote");
    assert_eq!(file.host, "file");
    assert_eq!(file.path, "C:/repos/demo");
}

#[test]
fn parses_scp_style_remote() {
    let identity = normalize_remote_identity("git@example.com:team/repo.git", false)
        .expect("scp identity");
    assert_eq!(identity.host, "example.com");
    assert_eq!(identity.port, 0);
    assert_eq!(identity.path, "team/repo");

    let ipv6 =
        normalize_remote_identity("git@[::1]:team/repo.git", false).expect("ipv6 identity");
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
        normalize_agent_tools(&[" cursor ".to_string(), "pi".to_string()])
            .expect("known tools"),
        vec!["cursor".to_string(), "pi".to_string()]
    );
    assert_eq!(
        normalize_agent_tools(&[]).expect_err("empty").code,
        code::COMMAND_INVALID
    );
    assert_eq!(
        normalize_agent_tools(&["cursor".to_string(), "cursor".to_string()])
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
