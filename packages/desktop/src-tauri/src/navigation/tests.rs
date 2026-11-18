use super::*;

fn parse(value: &str) -> Url {
    Url::parse(value).expect("valid test url")
}

#[test]
fn accepts_http_and_https() {
    assert!(validate_board_url("https://board.example.com").is_ok());
    assert!(validate_board_url("http://board.example.com").is_ok());
    assert!(validate_board_url("http://127.0.0.1:4317").is_ok());
    assert!(validate_board_url("http://localhost:4317/").is_ok());
}

#[test]
fn rejects_credentials_and_invalid_urls() {
    assert!(validate_board_url("https://user:secret@board.example.com").is_err());
    assert!(validate_board_url("https://board.example.com/app").is_err());
    assert!(validate_board_url("https://board.example.com/?team=a").is_err());
    assert!(validate_board_url("ftp://board.example.com").is_err());
    assert!(validate_board_url("file:///etc/passwd").is_err());
}

#[test]
fn origin_matching_includes_port() {
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
}
