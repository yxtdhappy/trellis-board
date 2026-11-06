use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub schema_version: u32,
    pub server_url: String,
}

pub fn data_dir() -> PathBuf {
    if let Some(value) = std::env::var_os("TRELLIS_DESKTOP_HOME") {
        return PathBuf::from(value);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("TrellisBoard").join("data")
}

pub fn config_path() -> PathBuf {
    data_dir().join("client.json")
}

pub fn agent_root() -> PathBuf {
    data_dir().join("agent")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

pub fn ensure_directories() -> Result<(), String> {
    for directory in [data_dir(), agent_root(), logs_dir()] {
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("无法创建目录 {}: {error}", directory.display()))?;
    }
    Ok(())
}

pub fn load() -> Result<Option<ClientConfig>, String> {
    let path = config_path();
    let payload = match std::fs::read_to_string(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取桌面配置 {}: {error}", path.display())),
    };
    let config: ClientConfig =
        serde_json::from_str(&payload).map_err(|error| format!("桌面配置格式无效: {error}"))?;
    if config.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "桌面配置版本 {} 不受支持（需要 {SCHEMA_VERSION}）",
            config.schema_version
        ));
    }
    Ok(Some(config))
}

pub fn save(config: &ClientConfig) -> Result<(), String> {
    ensure_directories()?;
    let target = config_path();
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let payload = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("无法序列化桌面配置: {error}"))?;
    std::fs::write(&temp, payload)
        .map_err(|error| format!("无法写入桌面配置: {error}"))?;
    std::fs::rename(&temp, &target).map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("无法替换桌面配置 {}: {error}", target.display())
    })
}

pub fn server_url_from_args() -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        if argument == "--server" {
            return args.next();
        }
        if let Some(value) = argument.strip_prefix("--server=") {
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub fn minimized_from_args() -> bool {
    std::env::args().skip(1).any(|argument| argument == "--minimized")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_round_trips_without_secrets() {
        let directory = std::env::temp_dir().join(format!(
            "trellis-desktop-config-test-{}",
            std::process::id()
        ));
        std::env::set_var("TRELLIS_DESKTOP_HOME", &directory);
        let config = ClientConfig {
            schema_version: SCHEMA_VERSION,
            server_url: "https://board.example.com".to_string(),
        };
        save(&config).expect("save config");
        let loaded = load().expect("load config").expect("config exists");
        assert_eq!(loaded, config);
        let payload = std::fs::read_to_string(config_path()).unwrap();
        assert!(!payload.contains("credential"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
