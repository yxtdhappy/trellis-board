use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::config;

pub const THEMES: [&str; 3] = ["light", "dark", "system"];
pub const FONT_SIZES: [&str; 4] = ["sm", "md", "lg", "xl"];
pub const NOTIFY_MODES: [&str; 3] = ["never", "unfocused", "always"];

const DEFAULT_THEME: &str = "system";
const DEFAULT_FONT_SIZE: &str = "md";
const DEFAULT_NOTIFY_MODE: &str = "always";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub theme: String,
    pub font_size: String,
    #[serde(default)]
    pub notify_mode: String,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            theme: DEFAULT_THEME.to_string(),
            font_size: DEFAULT_FONT_SIZE.to_string(),
            notify_mode: DEFAULT_NOTIFY_MODE.to_string(),
        }
    }
}

impl Appearance {
    fn normalised(&self) -> Self {
        Self {
            theme: if THEMES.contains(&self.theme.as_str()) {
                self.theme.clone()
            } else {
                DEFAULT_THEME.to_string()
            },
            font_size: if FONT_SIZES.contains(&self.font_size.as_str()) {
                self.font_size.clone()
            } else {
                DEFAULT_FONT_SIZE.to_string()
            },
            notify_mode: if NOTIFY_MODES.contains(&self.notify_mode.as_str()) {
                self.notify_mode.clone()
            } else {
                DEFAULT_NOTIFY_MODE.to_string()
            },
        }
    }
}

pub fn appearance_path() -> PathBuf {
    config::data_dir().join("appearance.json")
}

/// 外观偏好属于设备而非某个站点，缺失或损坏时静默回落默认值。
pub fn load() -> Appearance {
    let Ok(payload) = std::fs::read_to_string(appearance_path()) else {
        return Appearance::default();
    };
    let payload = payload.strip_prefix('\u{feff}').unwrap_or(&payload);
    serde_json::from_str::<Appearance>(payload)
        .map(|value| value.normalised())
        .unwrap_or_default()
}

pub fn save(value: &Appearance) -> Result<(), String> {
    config::ensure_directories()?;
    let target = appearance_path();
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(&value.normalised())
        .map_err(|error| format!("无法序列化外观偏好: {error}"))?;
    std::fs::write(&temp, payload).map_err(|error| format!("无法写入外观偏好: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换外观偏好 {}: {error}", target.display())
    })
}

#[cfg(test)]
mod tests;
