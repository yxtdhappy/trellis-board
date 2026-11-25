//! 从 EXE 内嵌资源释放 `trellis-kit` 工作流覆盖层（单文件绿色包）。
//!
//! `build.rs` 生成 `OUT_DIR/embedded_kit_assets.rs`，这里按「客户端版本 + 内容戳」
//! 释放到 `%LOCALAPPDATA%\TrellisBoard\runtime\kit\<version>\<stamp>`，升级后旧目录自然失效。

use std::path::{Path, PathBuf};

include!(concat!(env!("OUT_DIR"), "/embedded_kit_assets.rs"));

static KIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 返回已就绪的 kit 根目录。
pub fn ensure_kit(data_dir: &Path) -> Result<PathBuf, String> {
    let _guard = KIT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = data_dir
        .join("runtime")
        .join("kit")
        .join(env!("CARGO_PKG_VERSION"))
        .join(KIT_ASSET_STAMP);
    let marker = root.join(".complete");
    if marker.is_file() {
        return Ok(root);
    }
    let parent = root
        .parent()
        .ok_or_else(|| "无法定位 trellis-kit 运行时目录".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建 trellis-kit 运行时目录：{error}"))?;
    let staging = parent.join(format!(".tmp-{}-{}", std::process::id(), KIT_ASSET_STAMP));
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("无法创建 trellis-kit 临时目录：{error}"))?;
    for (relative, content) in KIT_ASSETS {
        let target = staging.join(relative);
        if let Some(directory) = target.parent() {
            std::fs::create_dir_all(directory)
                .map_err(|error| format!("无法创建 trellis-kit 子目录：{error}"))?;
        }
        std::fs::write(&target, content.as_bytes())
            .map_err(|error| format!("无法释放 trellis-kit 文件 {relative}：{error}"))?;
    }
    std::fs::write(staging.join(".complete"), KIT_ASSET_STAMP)
        .map_err(|error| format!("无法写入 trellis-kit 标记：{error}"))?;
    if root.exists() {
        let _ = std::fs::remove_dir_all(&root);
    }
    std::fs::rename(&staging, &root).map_err(|error| {
        let _ = std::fs::remove_dir_all(&staging);
        format!("无法启用 trellis-kit 运行时：{error}")
    })?;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_kit_has_apply_and_manifest() {
        assert!(KIT_ASSETS
            .iter()
            .any(|(relative, _)| *relative == "apply.py"));
        assert!(KIT_ASSETS
            .iter()
            .any(|(relative, _)| *relative == "manifest.json"));
        assert!(KIT_ASSETS
            .iter()
            .any(|(relative, _)| *relative == "platforms/registry.json"));
    }

    #[test]
    fn ensure_kit_creates_marker_and_required_files() {
        let root = std::env::temp_dir().join(format!(
            "trellis-kit-{}-{}",
            std::process::id(),
            KIT_ASSET_STAMP
        ));
        let _ = std::fs::remove_dir_all(&root);
        let kit = ensure_kit(&root).expect("kit should extract");
        assert!(kit.join(".complete").is_file());
        assert!(kit.join("apply.py").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }
}
