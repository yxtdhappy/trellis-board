//! 从 EXE 内嵌资源释放插件运行时（单文件绿色包，不依赖安装目录外的文件）。

use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

static RUNTIME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 返回已就绪的运行时根目录；按「版本 + 内容戳」隔离，升级后旧目录自然失效。
pub fn ensure_runtime(data_dir: &Path) -> Result<PathBuf, String> {
    // 首次启动时多个 IPC 命令可能并发释放，串行化避免 rename 竞争。
    let _guard = RUNTIME_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = data_dir
        .join("runtime")
        .join("plugins")
        .join(env!("CARGO_PKG_VERSION"))
        .join(ASSET_STAMP);
    let marker = root.join(".complete");
    if marker.is_file() {
        return Ok(root);
    }
    let parent = root
        .parent()
        .ok_or_else(|| "无法定位插件运行时目录".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建插件运行时目录：{error}"))?;
    let staging = parent.join(format!(".tmp-{}-{}", std::process::id(), ASSET_STAMP));
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("无法创建临时运行时目录：{error}"))?;
    for (relative, content) in RUNTIME_ASSETS {
        let target = staging.join(relative);
        if let Some(directory) = target.parent() {
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("无法创建运行时子目录：{error}"))?;
        }
        std::fs::write(&target, content.as_bytes())
            .map_err(|error| format!("无法释放运行时资源 {relative}：{error}"))?;
    }
    std::fs::write(staging.join(".complete"), ASSET_STAMP)
        .map_err(|error| format!("无法写入运行时标记：{error}"))?;
    if root.exists() {
        // 目标目录已经存在但没有标记：用释放结果替换（只涉及本机运行时缓存）。
        let _ = std::fs::remove_dir_all(&root);
    }
    std::fs::rename(&staging, &root).map_err(|error| {
        let _ = std::fs::remove_dir_all(&staging);
        format!("无法启用插件运行时：{error}")
    })?;
    Ok(root)
}

#[cfg(test)]
pub fn asset_names() -> Vec<&'static str> {
    RUNTIME_ASSETS.iter().map(|(name, _)| *name).collect()
}
