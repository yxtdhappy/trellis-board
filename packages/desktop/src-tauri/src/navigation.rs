use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

const LOCAL_HOST: &str = "tauri.localhost";

pub fn validate_board_url(input: &str) -> Result<Url, String> {
    let url = Url::parse(input.trim()).map_err(|_| "Board 地址不是合法 URL".to_string())?;
    if url.username() != "" || url.password().is_some() {
        return Err("Board 地址不能包含账号或密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Board 地址不能包含查询参数或片段".to_string());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Board 地址必须使用根路径".to_string());
    }
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Board 地址只支持 HTTP 或 HTTPS".to_string()),
    }
}

pub fn same_origin(candidate: &Url, board: &Url) -> bool {
    candidate.scheme() == board.scheme()
        && candidate.host_str() == board.host_str()
        && candidate.port_or_known_default() == board.port_or_known_default()
}

pub fn is_local_page(candidate: &Url) -> bool {
    candidate.scheme() == "tauri"
        || candidate.scheme() == "about"
        || candidate.host_str() == Some(LOCAL_HOST)
}

/// dev 模式下窗口加载的是 vite dev server（tauri.conf.json 的 devUrl），必须放行，否则会被交给系统浏览器。
pub fn is_dev_page(app: &AppHandle, candidate: &Url) -> bool {
    #[cfg(debug_assertions)]
    {
        match app.config().build.dev_url.as_ref() {
            Some(dev) => same_origin(candidate, dev),
            None => false,
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, candidate);
        false
    }
}

/// 允许同源导航；外链交给系统浏览器，绝不把远程 URL 交给 webview。
pub fn handle_navigation(app: &AppHandle, candidate: &Url, board: Option<&Url>) -> bool {
    if is_local_page(candidate) || is_dev_page(app, candidate) {
        return true;
    }
    if let Some(board) = board {
        if same_origin(candidate, board) {
            return true;
        }
    }
    if matches!(candidate.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(candidate.as_str(), None::<&str>);
    }
    false
}

#[cfg(test)]
mod tests {
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
}
