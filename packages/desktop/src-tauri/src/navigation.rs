use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

use crate::url_path::raw_path_has_dot_segments;

const LOCAL_HOST: &str = "tauri.localhost";
const RESERVED_FIRST_SEGMENTS: [&str; 4] = ["api", "client-updates", "plugin-ui", "assets"];
const RESERVED_PAGE_ENDINGS: [&str; 5] = [
    "login",
    "login.html",
    "admin.html",
    "index.html",
    "share.html",
];

fn format_host_port(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = url
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Some(format!("{host}{port}"))
}

pub fn normalize_subpath(raw_path: &str) -> Result<String, String> {
    if raw_path.is_empty() || raw_path == "/" {
        return Ok(String::new());
    }
    if raw_path.contains("//")
        || raw_path.contains('\\')
        || raw_path
            .chars()
            .any(|ch| (ch as u32) <= 0x20 || ch == '\u{7f}')
    {
        return Err("Board 地址路径包含非法字符".to_string());
    }
    let trimmed = raw_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let body = trimmed.strip_prefix('/').unwrap_or(trimmed);
    let segments: Vec<&str> = body.split('/').collect();
    for segment in &segments {
        let valid = !segment.is_empty()
            && *segment != "."
            && *segment != ".."
            && segment.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'~')
            });
        if !valid {
            return Err("Board 地址路径段格式无效".to_string());
        }
    }
    if RESERVED_FIRST_SEGMENTS
        .iter()
        .any(|reserved| segments[0].eq_ignore_ascii_case(reserved))
    {
        return Err("Board 地址不能使用系统保留路径前缀".to_string());
    }
    if let Some(last) = segments.last() {
        if RESERVED_PAGE_ENDINGS
            .iter()
            .any(|ending| last.eq_ignore_ascii_case(ending))
        {
            return Err("Board 地址请填写服务根路径，不要包含页面文件名".to_string());
        }
    }
    Ok(format!("/{}", segments.join("/")))
}

pub fn validate_board_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if raw_path_has_dot_segments(trimmed) {
        return Err("Board 地址路径段格式无效".to_string());
    }
    let mut url = Url::parse(trimmed).map_err(|_| "Board 地址不是合法 URL".to_string())?;
    if url.username() != "" || url.password().is_some() {
        return Err("Board 地址不能包含账号或密码".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Board 地址不能包含查询参数或片段".to_string());
    }
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err("Board 地址只支持 HTTP 或 HTTPS".to_string()),
    }
    if url.host_str().is_none() {
        return Err("Board 地址缺少主机".to_string());
    }
    let subpath = normalize_subpath(url.path())?;
    let normalized_path = if subpath.is_empty() {
        "/".to_string()
    } else {
        format!("{subpath}/")
    };
    url.set_path(&normalized_path);
    Ok(url)
}

pub fn board_base_path(board: &Url) -> String {
    let trimmed = board.path().trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        trimmed.to_string()
    }
}

pub fn board_server_url(board: &Url) -> String {
    let host_port = format_host_port(board).unwrap_or_default();
    format!("{}://{host_port}{}", board.scheme(), board_base_path(board))
}

pub fn board_cookie_path(board: &Url) -> String {
    let base = board_base_path(board);
    if base.is_empty() {
        "/".to_string()
    } else {
        base
    }
}

pub fn same_origin(candidate: &Url, board: &Url) -> bool {
    candidate.scheme() == board.scheme()
        && candidate.host_str() == board.host_str()
        && candidate.port_or_known_default() == board.port_or_known_default()
}

pub fn same_board_scope(candidate: &Url, board: &Url) -> bool {
    if !same_origin(candidate, board) {
        return false;
    }
    let base = board_base_path(board);
    if base.is_empty() {
        return true;
    }
    candidate.path() == base || candidate.path().starts_with(&format!("{base}/"))
}

pub fn is_board_login_path(candidate: &Url, board: &Url) -> bool {
    if !same_origin(candidate, board) {
        return false;
    }
    let base = board_base_path(board);
    let relative = if base.is_empty() {
        candidate.path()
    } else {
        let Some(rest) = candidate.path().strip_prefix(&base) else {
            return false;
        };
        if rest.is_empty() {
            "/"
        } else if rest.starts_with('/') {
            rest
        } else {
            return false;
        }
    };
    matches!(relative, "/login" | "/login.html")
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

/// 允许同子路径作用域内导航；同域其他子路径及外链交给系统浏览器，绝不把越权 URL 交给 webview。
pub fn handle_navigation(app: &AppHandle, candidate: &Url, board: Option<&Url>) -> bool {
    if is_local_page(candidate) || is_dev_page(app, candidate) {
        return true;
    }
    if let Some(board) = board {
        if same_board_scope(candidate, board) {
            return true;
        }
    }
    if matches!(candidate.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(candidate.as_str(), None::<&str>);
    }
    false
}

#[cfg(test)]
mod tests;
