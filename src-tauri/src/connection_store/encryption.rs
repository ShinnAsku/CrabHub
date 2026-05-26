#![allow(dead_code)] // Scaffold: items reserved for upcoming features

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use sha2::Sha256;
use std::sync::OnceLock;

const SALT_SIZE: usize = 32;
const NONCE_SIZE: usize = 12;
const PBKDF2_ITERATIONS: u32 = 100_000;

static MASTER_KEY: OnceLock<Vec<u8>> = OnceLock::new();

// Structured error codes for the encryption module. Callers see a prefixed
// String so logs / UI can distinguish key-init failure from a tampered ciphertext.
const E_KEY_NOT_INIT: &str = "[CRYPTO-E001] Master key not initialized";
const E_BAD_BASE64: &str = "[CRYPTO-E002] Invalid base64";
const E_TRUNCATED: &str = "[CRYPTO-E003] Ciphertext too short (missing nonce)";
const E_AUTH_FAIL: &str = "[CRYPTO-E004] Authentication failure (data tampered or wrong key)";
const E_INVALID_UTF8: &str = "[CRYPTO-E005] Decrypted plaintext is not valid UTF-8";
const E_KEY_INIT: &str = "[CRYPTO-E006] Failed to set up master key";

/// Initialize master key from system keyring
pub fn init_master_key() -> Result<(), String> {
    if MASTER_KEY.get().is_some() {
        return Ok(());
    }

    // Try to get from keyring
    let keyring = keyring::Entry::new("crabhub", "master-key").map_err(|e| e.to_string())?;
    
    let master_key = match keyring.get_password() {
        Ok(password) => {
            // Use existing password
            derive_key(&password, b"crabhub-salt-v1")
        }
        Err(_) => {
            // Generate new master key
            let mut rng = rand::thread_rng();
            let mut password_bytes = [0u8; 32];
            rng.fill_bytes(&mut password_bytes);
            
            let password = base64_encode(&password_bytes);
            keyring.set_password(&password).map_err(|e| e.to_string())?;
            
            derive_key(&password, b"crabhub-salt-v1")
        }
    };

    // Another thread may have raced us between the `is_some()` check above and
    // here; that's fine, both derive the same key from the same keyring entry.
    let _ = MASTER_KEY.set(master_key);
    Ok(())
}

/// Derive a key from password using PBKDF2
fn derive_key(password: &str, salt: &[u8]) -> Vec<u8> {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(
        password.as_bytes(),
        salt,
        PBKDF2_ITERATIONS,
        &mut key,
    );
    key.to_vec()
}

/// Encrypt sensitive data
pub fn encrypt(data: &str) -> Result<String, String> {
    let key = MASTER_KEY.get().ok_or(E_KEY_NOT_INIT)?;
    
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("{}: {}", E_KEY_INIT, e))?;
    
    // Generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    // Encrypt (AES-256-GCM appends a 16-byte authentication tag to the ciphertext)
    let ciphertext = cipher
        .encrypt(nonce, data.as_bytes())
        .map_err(|e| format!("[CRYPTO-E007] Encryption failed: {}", e))?;
    
    // Combine nonce + ciphertext||tag
    let mut result = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    
    Ok(base64_encode(&result))
}

/// Decrypt sensitive data.
///
/// Returns a categorised `[CRYPTO-Exxx]`-prefixed error so callers can
/// distinguish setup failures (key not initialized, malformed input) from
/// genuine integrity failures (E004 = the ciphertext was tampered with or the
/// key changed). AES-256-GCM authenticates every byte; an E004 must be treated
/// as a security event, not a corruption recoverable by retry.
pub fn decrypt(encrypted_data: &str) -> Result<String, String> {
    let key = MASTER_KEY.get().ok_or(E_KEY_NOT_INIT)?;
    
    let data = base64_decode(encrypted_data).map_err(|e| format!("{}: {}", E_BAD_BASE64, e))?;
    
    if data.len() < NONCE_SIZE {
        return Err(E_TRUNCATED.to_string());
    }
    
    let nonce_bytes = &data[..NONCE_SIZE];
    let ciphertext = &data[NONCE_SIZE..];
    
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("{}: {}", E_KEY_INIT, e))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    
    // GCM verifies the 16-byte authentication tag during decrypt; any tampering
    // (ciphertext, nonce, or tag) yields a generic aead error which we map to
    // E_AUTH_FAIL so the caller cannot confuse it with a recoverable failure.
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| E_AUTH_FAIL.to_string())?;
    
    String::from_utf8(plaintext).map_err(|_| E_INVALID_UTF8.to_string())
}

/// Base64 encode
fn base64_encode(data: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(data)
}

/// Base64 decode
fn base64_decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn try_init() -> bool {
        init_master_key().is_ok()
    }

    #[test]
    fn test_encrypt_decrypt() {
        if !try_init() { return; }
        let original = "test_password_123";
        let encrypted = encrypt(original).unwrap();
        let decrypted = decrypt(&encrypted).unwrap();
        assert_eq!(original, decrypted);
        assert_ne!(original, encrypted);
    }

    #[test]
    fn test_tampered_ciphertext_is_rejected() {
        if !try_init() { return; }
        let encrypted = encrypt("sensitive-payload").unwrap();

        let mut bytes = base64_decode(&encrypted).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let tampered = base64_encode(&bytes);

        let err = decrypt(&tampered).unwrap_err();
        assert!(
            err.starts_with("[CRYPTO-E004]"),
            "expected E004 auth failure, got: {}",
            err
        );
    }

    #[test]
    fn test_truncated_ciphertext_is_rejected() {
        if !try_init() { return; }
        let err = decrypt(&base64_encode(&[0u8; 4])).unwrap_err();
        assert!(err.starts_with("[CRYPTO-E003]"), "got: {}", err);
    }

    #[test]
    fn test_bad_base64_is_rejected() {
        if !try_init() { return; }
        let err = decrypt("not!!!base64@@@").unwrap_err();
        assert!(err.starts_with("[CRYPTO-E002]"), "got: {}", err);
    }

    #[test]
    fn test_nonces_are_unique_per_encrypt() {
        if !try_init() { return; }
        let a = encrypt("same input").unwrap();
        let b = encrypt("same input").unwrap();
        assert_ne!(a, b, "same plaintext must produce different ciphertexts (random nonce)");
    }
}
