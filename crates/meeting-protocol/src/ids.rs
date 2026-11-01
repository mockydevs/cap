//! Identifiers, pairing codes and opaque tokens.

use rand::{Rng, RngCore};
use sha2::{Digest, Sha256};

/// Crockford base32 without I, L, O, U so codes survive being read aloud.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const URL_SAFE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Random URL-safe token of `len` characters (6 bits each).
pub fn random_token(len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| URL_SAFE[rng.random_range(0..64)] as char)
        .collect()
}

/// Random UUID v4, the identifier format shared with Calari and Postgres.
pub fn new_id() -> uuid::Uuid {
    uuid::Uuid::new_v4()
}

/// Lower-case hyphenated UUID, or `None`.
pub fn parse_uuid(value: &str) -> Option<uuid::Uuid> {
    let id = uuid::Uuid::parse_str(value).ok()?;
    (id.hyphenated().to_string() == value.to_ascii_lowercase() && !id.is_nil()).then_some(id)
}

/// Formats 40 bits as a pairing code `XXXX-XXXX`.
pub fn pairing_code_from_bits(bits: u64) -> String {
    let chars: Vec<char> = (0..8)
        .map(|i| CROCKFORD[((bits >> (35 - 5 * i)) & 31) as usize] as char)
        .collect();
    format!(
        "{}-{}",
        chars[..4].iter().collect::<String>(),
        chars[4..].iter().collect::<String>()
    )
}

/// A device bearer token: 32 random bytes, hex. Only its hash is stored.
pub fn new_device_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("capdev_{}", hex::encode(bytes))
}

/// An 8-character pairing code formatted `XXXX-XXXX` (40 bits).
pub fn new_pairing_code() -> String {
    let mut rng = rand::rng();
    let chars: Vec<char> = (0..8)
        .map(|_| CROCKFORD[rng.random_range(0..32)] as char)
        .collect();
    format!(
        "{}-{}",
        chars[..4].iter().collect::<String>(),
        chars[4..].iter().collect::<String>()
    )
}

/// Canonical form of a typed pairing code, or `None` if it cannot be one.
/// Accepts lower case, spaces and dashes, and the usual Crockford look-alikes.
pub fn normalize_pairing_code(input: &str) -> Option<String> {
    let mut out = String::with_capacity(8);
    for c in input.chars() {
        let c = match c.to_ascii_uppercase() {
            ' ' | '-' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c if CROCKFORD.contains(&(c as u8)) && c.is_ascii() => c,
            _ => return None,
        };
        out.push(c);
        if out.len() > 8 {
            return None;
        }
    }
    (out.len() == 8).then_some(out)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_codes_normalize() {
        let code = new_pairing_code();
        assert_eq!(code.len(), 9);
        let canonical = normalize_pairing_code(&code).unwrap();
        assert_eq!(
            normalize_pairing_code(&code.to_lowercase()),
            Some(canonical.clone())
        );
        assert_eq!(
            normalize_pairing_code(" 7kq2 m9xd "),
            Some("7KQ2M9XD".into())
        );
        assert_eq!(normalize_pairing_code("OIL0-0000"), Some("01100000".into()));
        assert_eq!(normalize_pairing_code("7KQ2-M9X"), None);
        assert_eq!(normalize_pairing_code("7KQ2-M9XDD"), None);
        assert_eq!(normalize_pairing_code("7KQ2-M9X!"), None);
        assert_eq!(normalize_pairing_code("7KQ2-M9XU"), None);
    }

    #[test]
    fn ids_tokens_and_codes() {
        assert_ne!(new_id(), new_id());
        assert_eq!(new_device_token().len(), 7 + 64);
        let id = new_id().to_string();
        assert!(parse_uuid(&id).is_some());
        assert!(parse_uuid(&id.to_uppercase()).is_some());
        assert!(parse_uuid("00000000-0000-0000-0000-000000000000").is_none());
        assert!(parse_uuid("not-a-uuid").is_none());
        assert!(parse_uuid(&id.replace('-', "")).is_none());
        assert_eq!(pairing_code_from_bits(0), "0000-0000");
        assert_eq!(pairing_code_from_bits((1 << 40) - 1), "ZZZZ-ZZZZ");
        assert!(normalize_pairing_code(&pairing_code_from_bits(0x12_3456_789a)).is_some());
    }
}
