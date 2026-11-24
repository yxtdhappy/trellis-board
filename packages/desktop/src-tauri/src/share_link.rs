use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewWindow};

use crate::{ensure_board_caller, focus_main_window, logging, navigation, DesktopAuthState};

const MAX_PARAM_LENGTH: usize = 512;

/// 分享链接只携带任务定位参数，不携带任何任务内容。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTarget {
    pub server: String,
    pub task_space_id: String,
    pub task_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PendingShare {
    #[serde(rename_all = "camelCase")]
    Target {
        server: String,
        task_space_id: String,
        task_id: String,
    },
    Invalid,
}

impl From<ShareTarget> for PendingShare {
    fn from(target: ShareTarget) -> Self {
        Self::Target {
            server: target.server,
            task_space_id: target.task_space_id,
            task_id: target.task_id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EnqueueResult {
    pub notify: bool,
    pub valid: bool,
}

fn clean_param(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_PARAM_LENGTH
        || trimmed.chars().any(char::is_control)
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// 解析 `spec-board://task?server=<board_server_url>&space=<taskSpaceId>&task=<taskId>`。
///
/// 链接可被任意程序触发，因此只接受合法的 http(s) 服务基址（含可选子路径）与受限长度的定位参数，
/// 不解析、不执行其中的任何其它字段。
pub fn parse(raw: &str) -> Option<ShareTarget> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.scheme() != "spec-board" || url.host_str() != Some("task") {
        return None;
    }
    let mut server = None;
    let mut space = None;
    let mut task = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "server" => server = Some(value.into_owned()),
            "space" => space = Some(value.into_owned()),
            "task" => task = Some(value.into_owned()),
            _ => {}
        }
    }
    let server = navigation::validate_board_url(&server?).ok()?;
    Some(ShareTarget {
        // 归一化服务基址（保留合法子路径、去掉默认端口与尾斜杠），便于与 Web 侧比较。
        server: navigation::board_server_url(&server),
        task_space_id: clean_param(&space?)?,
        task_id: clean_param(&task?)?,
    })
}

pub(crate) fn enqueue(slot: &mut Option<PendingShare>, raw: &str) -> EnqueueResult {
    if let Some(target) = parse(raw) {
        let next = PendingShare::from(target);
        // 同一链接可能同时来自 argv 与 deep-link 事件，重复触发不再打扰用户。
        if slot.as_ref() == Some(&next) {
            return EnqueueResult {
                notify: false,
                valid: true,
            };
        }
        *slot = Some(next);
        return EnqueueResult {
            notify: true,
            valid: true,
        };
    }
    // 已有待打开的合法目标或已记录非法提示时不再被重复/无效链接覆盖。
    if matches!(
        slot.as_ref(),
        Some(PendingShare::Target { .. } | PendingShare::Invalid)
    ) {
        return EnqueueResult {
            notify: false,
            valid: false,
        };
    }
    *slot = Some(PendingShare::Invalid);
    EnqueueResult {
        notify: true,
        valid: false,
    }
}

pub(crate) fn take(slot: &mut Option<PendingShare>) -> Option<PendingShare> {
    slot.take()
}

pub(crate) fn clear(slot: &mut Option<PendingShare>) {
    *slot = None;
}

/// 冷启动 argv 与运行期唤起的统一入口：暂存目标、前置窗口，再通知已加载的 Board。
pub fn handle(app: &AppHandle, raw: &str) {
    let state = app.state::<DesktopAuthState>();
    let Ok(mut pending) = state.pending_share.lock() else {
        logging::warn("任务分享链接暂存不可用");
        return;
    };
    let result = enqueue(&mut pending, raw);
    drop(pending);
    if !result.valid {
        logging::warn("忽略无法识别的任务分享链接");
    }
    if result.notify {
        focus_main_window(app);
        let _ = app.emit("share-link-open", ());
    }
}

#[tauri::command]
pub fn take_pending_share_link(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopAuthState>,
) -> Result<Option<PendingShare>, String> {
    ensure_board_caller(&app, &window)?;
    let mut pending = state
        .pending_share
        .lock()
        .map_err(|_| "任务分享链接暂存不可用".to_string())?;
    Ok(take(&mut pending))
}

#[cfg(test)]
#[path = "share_link/tests.rs"]
mod tests;
