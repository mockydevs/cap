//! Encryption at rest for calendar refresh tokens and bot device tokens.
//! ChaCha20-Poly1305 with a random nonce; the associated data binds each
//! ciphertext to its purpose and owning row, so a value copied to another
//! row or column does not decrypt.

use ring::{
    aead::{Aad, LessSafeKey, Nonce, UnboundKey, CHACHA20_POLY1305, NONCE_LEN},
    rand::{SecureRandom, SystemRandom},
};

const VERSION: u8 = 1;

#[derive(Debug, thiserror::Error)]
#[error("stored credential could not be decrypted")]
pub struct DecryptError;

fn aad(purpose: &str, key_id: &str, owner: &str) -> Vec<u8> {
    format!("cap.calendar.v1\n{purpose}\n{key_id}\n{owner}").into_bytes()
}

fn key(raw: &[u8; 32]) -> LessSafeKey {
    // 32 bytes is always a valid ChaCha20-Poly1305 key.
    LessSafeKey::new(UnboundKey::new(&CHACHA20_POLY1305, raw).unwrap_or_else(|_| unreachable!()))
}

pub fn seal(
    raw_key: &[u8; 32],
    key_id: &str,
    purpose: &str,
    owner: &str,
    plaintext: &[u8],
) -> anyhow::Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| anyhow::anyhow!("system randomness unavailable"))?;
    let mut buf = plaintext.to_vec();
    key(raw_key)
        .seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::from(aad(purpose, key_id, owner)),
            &mut buf,
        )
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + buf.len());
    out.push(VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&buf);
    Ok(out)
}

pub fn open(
    raw_key: &[u8; 32],
    key_id: &str,
    purpose: &str,
    owner: &str,
    sealed: &[u8],
) -> Result<String, DecryptError> {
    if sealed.len() < 1 + NONCE_LEN + 16 || sealed[0] != VERSION {
        return Err(DecryptError);
    }
    let nonce =
        Nonce::try_assume_unique_for_key(&sealed[1..1 + NONCE_LEN]).map_err(|_| DecryptError)?;
    let mut buf = sealed[1 + NONCE_LEN..].to_vec();
    let plain = key(raw_key)
        .open_in_place(nonce, Aad::from(aad(purpose, key_id, owner)), &mut buf)
        .map_err(|_| DecryptError)?;
    String::from_utf8(plain.to_vec()).map_err(|_| DecryptError)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_binding() {
        let k = [3u8; 32];
        let sealed = seal(&k, "v1", "refresh", "row-1", b"1//refresh-token").unwrap();
        assert!(!sealed.windows(7).any(|w| w == b"refresh"));
        assert_eq!(
            open(&k, "v1", "refresh", "row-1", &sealed).unwrap(),
            "1//refresh-token"
        );
        assert!(
            open(&k, "v1", "refresh", "row-2", &sealed).is_err(),
            "other row"
        );
        assert!(
            open(&k, "v1", "device", "row-1", &sealed).is_err(),
            "other purpose"
        );
        assert!(
            open(&k, "v2", "refresh", "row-1", &sealed).is_err(),
            "other key id"
        );
        assert!(
            open(&[4u8; 32], "v1", "refresh", "row-1", &sealed).is_err(),
            "other key"
        );
        let mut tampered = sealed.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(open(&k, "v1", "refresh", "row-1", &tampered).is_err());
        assert_ne!(
            sealed,
            seal(&k, "v1", "refresh", "row-1", b"1//refresh-token").unwrap()
        );
    }
}
