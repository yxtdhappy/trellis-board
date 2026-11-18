use serde::Deserialize;

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_PACKAGE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NOTES_CHARS: usize = 4000;
const MAX_VERSION_BYTES: usize = 64;

#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    pub file: String,
    pub sha256: String,
    pub size: u64,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRelease {
    version: String,
    file: String,
    sha256: String,
    size: u64,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
}

impl Release {
    pub fn zip_url(&self, base: &str) -> String {
        format!("{}/{}", base.trim_end_matches('/'), self.file)
    }
}

pub fn parse(payload: &[u8]) -> Result<Release, String> {
    let payload = payload.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(payload);
    if payload.len() > MAX_MANIFEST_BYTES {
        return Err("更新清单超过 64 KiB".to_string());
    }
    let wire: WireRelease = serde_json::from_slice(payload)
        .map_err(|error| format!("更新清单不是合法 JSON：{error}"))?;
    let version = normalize_version(&wire.version)?;
    if !valid_file_name(&wire.file) {
        return Err("更新清单中的文件名无效".to_string());
    }
    let sha256 = normalize_sha256(&wire.sha256)?;
    if wire.size == 0 || wire.size > MAX_PACKAGE_BYTES {
        return Err("更新包大小超出允许范围".to_string());
    }
    if let Some(notes) = wire.notes.as_deref() {
        if notes.chars().count() > MAX_NOTES_CHARS {
            return Err(format!("更新说明不能超过 {MAX_NOTES_CHARS} 个字符"));
        }
    }
    if let Some(published_at) = wire.published_at.as_deref() {
        if published_at.len() > 64 || published_at.chars().any(char::is_control) {
            return Err("发布时间格式无效".to_string());
        }
    }
    Ok(Release {
        version,
        file: wire.file,
        sha256,
        size: wire.size,
        notes: wire.notes,
        published_at: wire.published_at,
    })
}

pub fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let value = value.trim();
    let value = value
        .strip_prefix('v')
        .or_else(|| value.strip_prefix('V'))
        .unwrap_or(value);
    let mut parts = value.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    }
}

fn normalize_version(value: &str) -> Result<String, String> {
    if value.len() > MAX_VERSION_BYTES {
        return Err("版本号过长".to_string());
    }
    let parsed = parse_version(value).ok_or_else(|| "版本号必须是 x.y.z".to_string())?;
    Ok(format!("{}.{}.{}", parsed.0, parsed.1, parsed.2))
}

fn normalize_sha256(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("SHA-256 必须是 64 位十六进制字符串".to_string());
    }
    Ok(value)
}

fn valid_file_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    !value.is_empty()
        && value.len() <= 255
        && value == value.trim()
        && lower.ends_with(".zip")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value != "."
        && value != ".."
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(overrides: &[(&str, serde_json::Value)]) -> Vec<u8> {
        let mut value = serde_json::json!({
            "version": "0.5.0",
            "file": "TrellisBoard_0.5.0_x64-portable.zip",
            "sha256": "a".repeat(64),
            "size": 1024,
            "notes": "修复若干问题",
            "publishedAt": "2026-11-18T00:00:00Z"
        });
        for (key, replacement) in overrides {
            value[*key] = replacement.clone();
        }
        serde_json::to_vec(&value).unwrap()
    }

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.4.10", "0.4.9"));
        assert!(!is_newer("0.4.9", "0.4.10"));
        assert!(!is_newer("0.4.40", "0.4.40"));
        assert!(is_newer("v0.5.0", "0.4.40"));
        assert!(!is_newer("latest", "0.4.40"));
    }

    #[test]
    fn rejects_invalid_versions() {
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.2.x"), None);
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
    }

    #[test]
    fn parses_valid_manifest() {
        let release = parse(&manifest(&[])).unwrap();
        assert_eq!(release.version, "0.5.0");
        assert_eq!(release.sha256, "a".repeat(64));
        assert_eq!(
            release.zip_url("https://files.example.com/updates/"),
            "https://files.example.com/updates/TrellisBoard_0.5.0_x64-portable.zip"
        );
    }

    #[test]
    fn rejects_path_in_file_name() {
        for file in ["../a.zip", "dir/a.zip", "dir\\a.zip", "a.txt", " a.zip"] {
            let payload = manifest(&[("file", serde_json::json!(file))]);
            assert!(parse(&payload).is_err(), "{file} should be rejected");
        }
    }

    #[test]
    fn rejects_bad_hash_and_size() {
        assert!(parse(&manifest(&[("sha256", serde_json::json!("abc"))])).is_err());
        assert!(parse(&manifest(&[("size", serde_json::json!(0))])).is_err());
        assert!(parse(&manifest(&[(
            "size",
            serde_json::json!(MAX_PACKAGE_BYTES + 1)
        )]))
        .is_err());
    }

    #[test]
    fn rejects_long_notes() {
        let notes = "长".repeat(MAX_NOTES_CHARS + 1);
        assert!(parse(&manifest(&[("notes", serde_json::json!(notes))])).is_err());
    }
}
