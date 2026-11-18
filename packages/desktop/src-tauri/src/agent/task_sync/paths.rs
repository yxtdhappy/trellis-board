use super::*;

pub(crate) fn is_archive_task_dir(task_dir: &str) -> bool {
    task_dir == ARCHIVE_TASKS_ROOT
        || task_dir
            .strip_prefix(ARCHIVE_TASKS_ROOT)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
pub(super) fn is_archive_snapshot_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized == ARCHIVE_TASKS_ROOT
        || normalized
            .strip_prefix(ARCHIVE_TASKS_ROOT)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
pub(super) fn active_task_directory_from_relative(path: &str) -> Option<String> {
    let task_dir = task_directory_from_relative(path)?;
    (!is_archive_task_dir(&task_dir)).then_some(task_dir)
}
pub(crate) fn active_task_directory_from_path(path: &str) -> Option<String> {
    let task_dir = task_directory_from_path(path).ok()?.task_dir;
    (!is_archive_task_dir(&task_dir)).then_some(task_dir)
}
pub fn normalize_snapshot_path(value: &str) -> AgentResult<String> {
    let raw = value.trim();
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') || raw.starts_with('/') {
        return protocol::err(code::INVALID_RESPONSE, "任务文件路径无效");
    }
    let normalized = raw
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if normalized != raw
        || normalized
            .split('/')
            .any(|part| part == "." || part == "..")
        || !normalized.starts_with(".trellis/tasks/")
    {
        return protocol::err(code::INVALID_RESPONSE, "任务文件必须位于 .trellis/tasks 内");
    }
    let lower = normalized.to_lowercase();
    if !SNAPSHOT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return protocol::err(code::INVALID_RESPONSE, "任务文件类型不受支持");
    }
    Ok(normalized)
}
pub struct TaskPathParts {
    pub task_dir: String,
    pub file_path: String,
    pub archived: bool,
    pub archive_month: Option<String>,
}
pub fn task_directory_from_path(value: &str) -> AgentResult<TaskPathParts> {
    let relative_path = normalize_snapshot_path(value)?;
    let parts: Vec<&str> = relative_path.split('/').collect();
    if parts.get(2) == Some(&"archive") {
        let month_ok = parts.get(3).is_some_and(|month| is_archive_month(month));
        if parts.len() < 6 || !month_ok {
            return protocol::err(code::INVALID_RESPONSE, "归档任务目录格式无效");
        }
        return Ok(TaskPathParts {
            task_dir: parts[..5].join("/"),
            file_path: parts[5..].join("/"),
            archived: true,
            archive_month: Some(parts[3].to_string()),
        });
    }
    if parts.len() < 4 {
        return protocol::err(code::INVALID_RESPONSE, "任务目录格式无效");
    }
    Ok(TaskPathParts {
        task_dir: parts[..3].join("/"),
        file_path: parts[3..].join("/"),
        archived: false,
        archive_month: None,
    })
}
pub fn task_directory_from_relative(relative_path: &str) -> Option<String> {
    let normalized = relative_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.first() != Some(&".trellis") || parts.get(1) != Some(&"tasks") {
        return None;
    }
    if parts.get(2) == Some(&"archive") {
        if parts.len() < 5 || !is_archive_month(parts[3]) {
            return None;
        }
        return Some(parts[..5].join("/"));
    }
    if parts.len() < 3 {
        return None;
    }
    Some(parts[..3].join("/"))
}
pub(super) fn is_archive_month(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7
        && bytes[4] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..].iter().all(u8::is_ascii_digit)
}
pub(super) fn valid_cached_task_dir(task_dir: &str) -> bool {
    task_directory_from_relative(&format!("{task_dir}/task.json")).as_deref() == Some(task_dir)
        && !is_archive_task_dir(task_dir)
        && protocol::resolve_task_dir_under(Path::new(".trellis/tasks"), task_dir).is_some()
}
pub(super) fn valid_cached_snapshot_path(path: &str) -> bool {
    task_directory_from_path(path).is_ok()
        && active_task_directory_from_path(path).is_some()
        && SNAPSHOT_EXTENSIONS
            .iter()
            .any(|extension| path.to_lowercase().ends_with(extension))
}
pub(super) fn normalize_cached_dirs(values: Vec<String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .filter(|task_dir| valid_cached_task_dir(task_dir))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    values.sort();
    values
}
pub(super) fn absolute_task_path(binding: &AgentBinding, relative_path: &str) -> String {
    Path::new(&binding.repo_path)
        .join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        .to_string_lossy()
        .to_string()
}
pub(super) fn task_directory_error(task_dir: &str, message: impl Into<String>) -> AgentError {
    let mut error = AgentError::new(code::INVALID_RESPONSE, message);
    if task_dir.starts_with(".trellis/tasks/") && task_dir.chars().count() <= 500 {
        error.details = Some(json!({ "taskDir": task_dir }));
    }
    error
}
