use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LOG_FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn init(directory: &Path) {
    if let Err(error) = std::fs::create_dir_all(directory) {
        eprintln!("无法创建日志目录 {}: {error}", directory.display());
        return;
    }
    let _ = LOG_FILE.set(directory.join("desktop.log"));
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn write(level: &str, message: &str) {
    let line = format!("{} [{level}] {}\n", timestamp(), redact(message.trim_end()));
    if let Some(path) = LOG_FILE.get() {
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(line.as_bytes());
        }
    }
    eprint!("{line}");
}

pub fn line(message: &str) {
    write("agent", message);
}

pub fn warn(message: &str) {
    write("warn", message);
}

/// 删除日志中可能出现的 Bearer 凭证、设备凭证、令牌和配对码字段值。
pub fn redact(input: &str) -> String {
    let mut value = input.to_string();
    let mut search = 0;
    while search < value.len() {
        let rest = &value[search..];
        let found = ["Bearer ", "bearer "]
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min();
        let Some(offset) = found else { break };
        let token_start = search + offset + "Bearer ".len();
        let token_end = value[token_start..]
            .find(|character: char| {
                character.is_whitespace() || character == '"' || character == ','
            })
            .map(|offset| token_start + offset)
            .unwrap_or(value.len());
        if token_end > token_start {
            value.replace_range(token_start..token_end, "***");
        }
        search = token_start + 3;
    }
    for marker in ["\"credential\"", "\"pairingCode\"", "\"token\"", "\"password\""] {
        if let Some(index) = value.find(marker) {
            let tail = &value[index + marker.len()..];
            let colon = tail.find(':');
            if let Some(colon) = colon {
                let value_start = index + marker.len() + colon + 1;
                let rest = &value[value_start..];
                let quote = rest.find('"');
                if let Some(quote) = quote {
                    let start = value_start + quote + 1;
                    let end = value[start..]
                        .find('"')
                        .map(|offset| start + offset)
                        .unwrap_or(value.len());
                    value.replace_range(start..end, "***");
                }
            }
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_tokens_and_secret_fields() {
        assert_eq!(
            redact("authorization: Bearer abc.def.ghi"),
            "authorization: Bearer ***"
        );
        assert_eq!(redact(r#"{"credential":"secret-value"}"#), r#"{"credential":"***"}"#);
        assert_eq!(redact(r#"{"pairingCode":"abc123"}"#), r#"{"pairingCode":"***"}"#);
    }
}
