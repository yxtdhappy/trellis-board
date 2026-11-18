use base64::Engine;
use serde_json::json;

use crate::agent::protocol::{self, code, AgentError, AgentResult};
use crate::agent::store::ConfigStore;

pub const CREDENTIAL_SCHEMA_VERSION: u32 = 1;
#[cfg(windows)]
pub const CREDENTIAL_ALGORITHM: &str = "WindowsDPAPI-CurrentUser";
/// 非 Windows 平台没有 DPAPI，凭证以仅本用户可读（0600）的文件保存。
#[cfg(not(windows))]
pub const CREDENTIAL_ALGORITHM: &str = "FileOwnerOnly-0600";

pub struct CredentialStore<'a> {
    store: &'a ConfigStore,
}

impl<'a> CredentialStore<'a> {
    pub fn new(store: &'a ConfigStore) -> Self {
        Self { store }
    }

    pub fn protect(&self, plaintext: &[u8]) -> AgentResult<Vec<u8>> {
        dpapi_protect(plaintext)
    }

    pub fn unprotect(&self, ciphertext: &[u8]) -> AgentResult<Vec<u8>> {
        dpapi_unprotect(ciphertext)
    }

    pub async fn save_credential(&self, credential: &str) -> AgentResult<()> {
        if credential.len() < 32 || credential.chars().any(char::is_whitespace) {
            return protocol::err(code::CREDENTIAL_CORRUPT, "Agent 凭证格式无效");
        }
        let ciphertext = self.protect(credential.as_bytes())?;
        let now = protocol::now_iso8601();
        let record = json!({
            "schemaVersion": CREDENTIAL_SCHEMA_VERSION,
            "algorithm": CREDENTIAL_ALGORITHM,
            "ciphertext": base64::engine::general_purpose::STANDARD.encode(ciphertext),
            "createdAt": now,
            "updatedAt": now,
        });
        self.store.write_credential_record(&record).await?;
        restrict_credential_permissions(&self.store.paths.credential_file);
        Ok(())
    }

    pub async fn load_credential(&self) -> AgentResult<String> {
        let record = self.store.read_credential_record().await?;
        let valid = record
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            == Some(CREDENTIAL_SCHEMA_VERSION as u64)
            && record.get("algorithm").and_then(serde_json::Value::as_str)
                == Some(CREDENTIAL_ALGORITHM);
        if !valid {
            return protocol::err(
                code::CREDENTIAL_CORRUPT,
                "Agent 凭证文件格式无效，请重新配对",
            );
        }
        let ciphertext_text = record
            .get("ciphertext")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                AgentError::new(
                    code::CREDENTIAL_CORRUPT,
                    "Agent 凭证文件格式无效，请重新配对",
                )
            })?;
        let ciphertext = base64::engine::general_purpose::STANDARD
            .decode(ciphertext_text)
            .map_err(|_| {
                AgentError::new(code::CREDENTIAL_CORRUPT, "Agent 凭证文件已损坏，请重新配对")
            })?;
        if ciphertext.len() < 32 {
            return protocol::err(code::CREDENTIAL_CORRUPT, "Agent 凭证文件已损坏，请重新配对");
        }
        let plaintext = match self.unprotect(&ciphertext) {
            Ok(value) => value,
            Err(error) if error.code == code::DPAPI_UNAVAILABLE => return Err(error),
            Err(_) => {
                return protocol::err(
                    code::CREDENTIAL_CORRUPT,
                    "Agent 凭证无法由当前 Windows 用户解密，请重新配对",
                )
            }
        };
        let credential = String::from_utf8(plaintext).map_err(|_| {
            AgentError::new(code::CREDENTIAL_CORRUPT, "Agent 凭证内容无效，请重新配对")
        })?;
        if credential.len() < 32 || credential.chars().any(char::is_whitespace) {
            return protocol::err(code::CREDENTIAL_CORRUPT, "Agent 凭证内容无效，请重新配对");
        }
        Ok(credential)
    }

    #[cfg(test)]
    pub fn self_test(&self) -> AgentResult<()> {
        let sample = format!(
            "trellis-agent-dpapi-{}",
            chrono::Utc::now().timestamp_millis()
        );
        let ciphertext = self.protect(sample.as_bytes())?;
        let plaintext = self.unprotect(&ciphertext)?;
        if plaintext != sample.as_bytes() {
            return protocol::err(code::DPAPI_FAILED, "DPAPI 往返校验失败");
        }
        Ok(())
    }
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> AgentResult<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            windows::core::PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| AgentError::new(code::DPAPI_FAILED, "Windows DPAPI 加密失败"))?;
    }
    let bytes = copy_blob_and_free(&output);
    Ok(bytes)
}

#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> AgentResult<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: ciphertext.len() as u32,
        pbData: ciphertext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| AgentError::new(code::DPAPI_FAILED, "Windows DPAPI 解密失败"))?;
    }
    let bytes = copy_blob_and_free(&output);
    Ok(bytes)
}

#[cfg(windows)]
fn copy_blob_and_free(
    blob: &windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB,
) -> Vec<u8> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    unsafe {
        let slice = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize);
        let bytes = slice.to_vec();
        let _ = LocalFree(HLOCAL(blob.pbData as *mut core::ffi::c_void));
        bytes
    }
}

#[cfg(not(windows))]
fn dpapi_protect(plaintext: &[u8]) -> AgentResult<Vec<u8>> {
    // 非 Windows 无 DPAPI：写入时保持原样，由文件权限（0600）保证隔离。
    Ok(plaintext.to_vec())
}

#[cfg(not(windows))]
fn dpapi_unprotect(ciphertext: &[u8]) -> AgentResult<Vec<u8>> {
    Ok(ciphertext.to_vec())
}

#[cfg(not(windows))]
fn restrict_credential_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(windows)]
fn restrict_credential_permissions(_path: &std::path::Path) {}

#[cfg(all(test, windows))]
mod tests;
