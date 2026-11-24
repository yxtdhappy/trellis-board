use super::*;

fn parse(value: &str) -> Url {
    Url::parse(value).expect("valid test url")
}

#[test]
fn accepts_http_https_and_valid_subpaths() {
    assert_eq!(
        validate_board_url("https://board.example.com")
            .unwrap()
            .as_str(),
        "https://board.example.com/"
    );
    assert!(validate_board_url("http://board.example.com").is_ok());
    assert!(validate_board_url("http://127.0.0.1:4317").is_ok());
    assert!(validate_board_url("http://localhost:4317/").is_ok());

    let subpath = validate_board_url("http://spec-board.weintdata.cn/weint-spec-board").unwrap();
    assert_eq!(
        subpath.as_str(),
        "http://spec-board.weintdata.cn/weint-spec-board/"
    );
    assert_eq!(board_base_path(&subpath), "/weint-spec-board");
    assert_eq!(
        board_server_url(&subpath),
        "http://spec-board.weintdata.cn/weint-spec-board"
    );
    assert_eq!(board_cookie_path(&subpath), "/weint-spec-board");

    let with_slash = validate_board_url("https://board.example.com:8443/team/spec-board/").unwrap();
    assert_eq!(
        with_slash.as_str(),
        "https://board.example.com:8443/team/spec-board/"
    );
    assert_eq!(
        board_server_url(&with_slash),
        "https://board.example.com:8443/team/spec-board"
    );
}

#[test]
fn rejects_credentials_reserved_and_invalid_urls() {
    assert!(validate_board_url("https://user:secret@board.example.com").is_err());
    assert!(validate_board_url("https://board.example.com/?team=a").is_err());
    assert!(validate_board_url("https://board.example.com/app#frag").is_err());
    assert!(validate_board_url("https://board.example.com/api").is_err());
    assert!(validate_board_url("https://board.example.com/client-updates").is_err());
    assert!(validate_board_url("https://board.example.com/weint-spec-board/login.html").is_err());
    assert!(validate_board_url("https://board.example.com/weint-spec-board/share.html").is_err());
    assert!(validate_board_url("https://board.example.com/a//b").is_err());
    assert!(validate_board_url("https://board.example.com/../evil").is_err());
    assert!(validate_board_url("ftp://board.example.com").is_err());
    assert!(validate_board_url("file:///etc/passwd").is_err());
}

#[test]
fn origin_and_subpath_scope_matching() {
    let board = parse("https://board.example.com");
    assert!(same_origin(
        &parse("https://board.example.com/login.html"),
        &board
    ));
    assert!(!same_origin(
        &parse("https://board.example.com:8443/"),
        &board
    ));
    assert!(!same_origin(&parse("https://evil.example.com"), &board));
    assert!(!same_origin(&parse("http://board.example.com"), &board));
    assert_eq!(board_cookie_path(&board), "/");

    let scoped = validate_board_url("http://spec-board.weintdata.cn/weint-spec-board").unwrap();
    assert!(same_board_scope(
        &parse("http://spec-board.weintdata.cn/weint-spec-board/admin.html"),
        &scoped
    ));
    assert!(same_board_scope(
        &parse("http://spec-board.weintdata.cn/weint-spec-board"),
        &scoped
    ));
    assert!(!same_board_scope(
        &parse("http://spec-board.weintdata.cn/weint-spec-board-other/"),
        &scoped
    ));
    assert!(!same_board_scope(
        &parse("http://spec-board.weintdata.cn/other-app"),
        &scoped
    ));

    assert!(is_board_login_path(
        &parse("http://spec-board.weintdata.cn/weint-spec-board/login"),
        &scoped
    ));
    assert!(is_board_login_path(
        &parse("http://spec-board.weintdata.cn/weint-spec-board/login.html?returnTo=%2F"),
        &scoped
    ));
    assert!(!is_board_login_path(
        &parse("http://spec-board.weintdata.cn/login.html"),
        &scoped
    ));
    assert!(!is_board_login_path(
        &parse("http://spec-board.weintdata.cn/weint-spec-board-other/login.html"),
        &scoped
    ));
}
