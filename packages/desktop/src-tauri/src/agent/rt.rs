//! 异步任务派发抽象。
//!
//! 桌面端沿用 Tauri 的全局运行时；headless 构建（`--no-default-features`）直接用
//! tokio，让同一份同步逻辑在两种形态下行为一致。

use std::future::Future;

#[cfg(feature = "desktop")]
pub fn spawn<F>(future: F) -> tauri::async_runtime::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tauri::async_runtime::spawn(future)
}

#[cfg(not(feature = "desktop"))]
pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(future)
}
