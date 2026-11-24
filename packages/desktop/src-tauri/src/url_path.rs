//! 两个可执行目标（`trellis-board-client` 与 `trellis-agent`）共用的 URL 路径判定。

/// URL 解析会消解 `.`/`..` 段，必须在解析前对原始输入检查。
pub fn raw_path_has_dot_segments(input: &str) -> bool {
    let rest = input
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(input);
    let path = rest.split_once('/').map(|(_, path)| path).unwrap_or("");
    path.split(['?', '#'])
        .next()
        .unwrap_or(path)
        .split('/')
        .any(|segment| segment == "." || segment == "..")
}
