use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
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

    MASTER_KEY.set(master_key).map_err(|_| "Failed to initialize master key")?;
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
    let key = MASTER_KEY.get().ok_or("Master key not initialized")?;
    
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    
    // Generate random nonce
    let mut nonce_bytes = [0u8; NONCE_SIZE];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    
    // Encrypt
    let ciphertext = cipher
        .encrypt(nonce, data.as_bytes())
        .map_err(|e| e.to_string())?;
    
    // Combine salt + nonce + ciphertext
    let mut result = Vec::new();
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    
    Ok(base64_encode(&result))
}

/// Decrypt sensitive data
pub fn decrypt(encrypted_data: &str) -> Result<String, String> {
    let key = MASTER_KEY.get().ok_or("Master key not initialized")?;
    
    let data = base64_decode(encrypted_data)?;
    
    if data.len() < NONCE_SIZE {
        return Err("Invalid encrypted data".to_string());
    }
    
    let nonce_bytes = &data[..NONCE_SIZE];
    let ciphertext = &data[NONCE_SIZE..];
    
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(nonce_bytes);
    
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;
    
    String::from_utf8(plaintext).map_err(|e| e.to_string())
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

    #[test]
    fn test_encrypt_decrypt() {
        init_master_key().unwrap();
        
        let original = "test_password_123";
        let encrypted = encrypt(original).unwrap();
        let decrypted = decrypt(&encrypted).unwrap();
        
        assert_eq!(original, decrypted);
        assert_ne!(original, encrypted);
    }
}
