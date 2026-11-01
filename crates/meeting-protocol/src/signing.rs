//! HMAC request signing shared by both directions of the Calari integration.
//!
//! Signing string: `cap.v1.<purpose>\n<timestamp>\n<nonce>\n<raw body>`.
//! The purpose prefix keeps a pairing request from verifying as a delivery
//! and the other way round, even though both use the same integration key.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use thiserror::Error;

pub const HEADER_KEY_ID: &str = "x-cap-key-id";
pub const HEADER_TIMESTAMP: &str = "x-cap-timestamp";
pub const HEADER_NONCE: &str = "x-cap-nonce";
pub const HEADER_SIGNATURE: &str = "x-cap-signature-256";
pub const HEADER_DELIVERY_ID: &str = "x-cap-delivery-id";
/// SHA-256 hex of the entire raw body. Lets a receiver tell "same event,
/// same bytes" (duplicate) from "same event id, different content" (409).
pub const HEADER_CONTENT_SHA256: &str = "x-cap-content-sha256";
/// Integration secrets are exactly this many bytes, provisioned as
/// base64url without padding.
pub const SECRET_BYTES: usize = 32;

/// How far a signed request's clock may differ from ours.
pub const MAX_SKEW_SECONDS: i64 = 300;
/// How long a receiver must remember a nonce. Longer than twice the skew so a
/// request cannot be replayed at the far edge of the window.
pub const NONCE_RETENTION_SECONDS: i64 = 900;
/// Integration secrets shorter than this are refused at load time.
pub const MIN_SECRET_BYTES: usize = 32;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// Calari server → Cap meeting service: create a pairing code.
    Pairing,
    /// Cap meeting service → Calari: deliver a finished meeting.
    Delivery,
    /// Cap → Calari: exchange a one-time sign-in code for the staff member.
    Login,
}

impl Purpose {
    fn label(self) -> &'static str {
        match self {
            Purpose::Pairing => "pairing",
            Purpose::Delivery => "delivery",
            Purpose::Login => "login",
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SignatureError {
    #[error("missing or malformed signature header")]
    Malformed,
    #[error("timestamp outside the allowed window")]
    Stale,
    #[error("nonce must be 16-64 characters of [A-Za-z0-9_-]")]
    BadNonce,
    #[error("signature does not match")]
    Mismatch,
    #[error("integration secret is too short")]
    WeakSecret,
}

pub fn valid_nonce(nonce: &str) -> bool {
    (16..=64).contains(&nonce.len())
        && nonce
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn mac(
    secret: &[u8],
    purpose: Purpose,
    timestamp: i64,
    nonce: &str,
    body: &[u8],
) -> Result<HmacSha256, SignatureError> {
    if secret.len() < MIN_SECRET_BYTES {
        return Err(SignatureError::WeakSecret);
    }
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| SignatureError::WeakSecret)?;
    mac.update(b"cap.v1.");
    mac.update(purpose.label().as_bytes());
    mac.update(b"\n");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b"\n");
    mac.update(nonce.as_bytes());
    mac.update(b"\n");
    mac.update(body);
    Ok(mac)
}

/// Returns the `x-cap-signature-256` header value.
pub fn sign(
    secret: &[u8],
    purpose: Purpose,
    timestamp: i64,
    nonce: &str,
    body: &[u8],
) -> Result<String, SignatureError> {
    if !valid_nonce(nonce) {
        return Err(SignatureError::BadNonce);
    }
    let tag = mac(secret, purpose, timestamp, nonce, body)?
        .finalize()
        .into_bytes();
    Ok(format!("sha256={}", hex::encode(tag)))
}

/// Verifies signature, timestamp window and nonce shape. Nonce *uniqueness*
/// is the caller's job because it needs durable storage.
pub fn verify(
    secret: &[u8],
    purpose: Purpose,
    timestamp_header: &str,
    nonce: &str,
    signature_header: &str,
    body: &[u8],
    now_unix: i64,
) -> Result<i64, SignatureError> {
    let timestamp: i64 = timestamp_header
        .trim()
        .parse()
        .map_err(|_| SignatureError::Malformed)?;
    if (now_unix - timestamp).abs() > MAX_SKEW_SECONDS {
        return Err(SignatureError::Stale);
    }
    if !valid_nonce(nonce) {
        return Err(SignatureError::BadNonce);
    }
    let hex_tag = signature_header
        .trim()
        .strip_prefix("sha256=")
        .ok_or(SignatureError::Malformed)?;
    let tag = hex::decode(hex_tag).map_err(|_| SignatureError::Malformed)?;
    // `verify_slice` compares in constant time.
    mac(secret, purpose, timestamp, nonce, body)?
        .verify_slice(&tag)
        .map_err(|_| SignatureError::Mismatch)?;
    Ok(timestamp)
}

/// Decodes a provisioned integration secret: base64url, no padding, exactly
/// 32 bytes. The decoded bytes are the HMAC key, never the text.
pub fn decode_secret(text: &str) -> Result<Vec<u8>, SignatureError> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim())
        .map_err(|_| SignatureError::WeakSecret)?;
    if bytes.len() != SECRET_BYTES {
        return Err(SignatureError::WeakSecret);
    }
    Ok(bytes)
}

/// The pairing code for an authenticated pairing request. Deterministic per
/// `(secret, request_id)` so a retried request gets the same code back
/// without the code ever being stored in plain text.
pub fn derive_pairing_code(secret: &[u8], request_id: &uuid::Uuid) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(b"cap.v1.pairing-code\n");
    mac.update(request_id.hyphenated().to_string().as_bytes());
    let tag = mac.finalize().into_bytes();
    let bits = tag[..5]
        .iter()
        .fold(0u64, |acc, b| (acc << 8) | u64::from(*b));
    crate::ids::pairing_code_from_bits(bits)
}

/// A fresh random nonce for an outgoing request.
pub fn new_nonce() -> String {
    crate::ids::random_token(18)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const NONCE: &str = "nonce_0123456789ab";

    #[test]
    fn round_trips() {
        let sig = sign(SECRET, Purpose::Delivery, 1_000, NONCE, b"{}").unwrap();
        assert_eq!(
            verify(SECRET, Purpose::Delivery, "1000", NONCE, &sig, b"{}", 1_100),
            Ok(1_000)
        );
    }

    #[test]
    fn purpose_is_bound() {
        let sig = sign(SECRET, Purpose::Pairing, 1_000, NONCE, b"{}").unwrap();
        assert_eq!(
            verify(SECRET, Purpose::Delivery, "1000", NONCE, &sig, b"{}", 1_000),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn body_timestamp_and_nonce_are_bound() {
        let sig = sign(SECRET, Purpose::Pairing, 1_000, NONCE, b"{\"a\":1}").unwrap();
        let check = |ts: &str, nonce: &str, body: &[u8]| {
            verify(SECRET, Purpose::Pairing, ts, nonce, &sig, body, 1_000)
        };
        assert_eq!(
            check("1000", NONCE, b"{\"a\":2}"),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(
            check("1001", NONCE, b"{\"a\":1}"),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(
            check("1000", "nonce_0123456789ac", b"{\"a\":1}"),
            Err(SignatureError::Mismatch)
        );
    }

    #[test]
    fn rejects_stale_and_future_requests() {
        let sig = sign(SECRET, Purpose::Pairing, 1_000, NONCE, b"").unwrap();
        for now in [1_000 + MAX_SKEW_SECONDS + 1, 1_000 - MAX_SKEW_SECONDS - 1] {
            assert_eq!(
                verify(SECRET, Purpose::Pairing, "1000", NONCE, &sig, b"", now),
                Err(SignatureError::Stale)
            );
        }
    }

    #[test]
    fn rejects_wrong_secret_weak_secret_and_garbage() {
        let sig = sign(SECRET, Purpose::Pairing, 1_000, NONCE, b"").unwrap();
        let other = b"fedcba9876543210fedcba9876543210";
        assert_eq!(
            verify(other, Purpose::Pairing, "1000", NONCE, &sig, b"", 1_000),
            Err(SignatureError::Mismatch)
        );
        assert_eq!(
            sign(b"short", Purpose::Pairing, 1, NONCE, b""),
            Err(SignatureError::WeakSecret)
        );
        for bad in ["", "sha256=", "sha256=zz", "md5=00"] {
            assert!(verify(SECRET, Purpose::Pairing, "1000", NONCE, bad, b"", 1_000).is_err());
        }
        assert_eq!(
            verify(SECRET, Purpose::Pairing, "abc", NONCE, &sig, b"", 1_000),
            Err(SignatureError::Malformed)
        );
    }

    /// Public synthetic vector published by the Calari receiver
    /// (`docs/cap-signing-vector.json` in the Calari repo), computed there
    /// with Python's standard library.
    #[test]
    fn matches_calari_cross_language_vector() {
        let secret =
            hex::decode("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")
                .unwrap();
        let body = br#"{"tenant_id":"00000000-0000-4000-8000-000000000001","client_id":"00000000-0000-4000-8000-000000000002"}"#;
        let expected = "sha256=6cb335e11491fd3c071ba13b882837071380d488c9c137c55547dc0d0e8a740e";
        assert_eq!(
            sign(
                &secret,
                Purpose::Delivery,
                1_793_560_000,
                "abcdefghijklmnop",
                body
            )
            .unwrap(),
            expected
        );
        assert!(verify(
            &secret,
            Purpose::Delivery,
            "1793560000",
            "abcdefghijklmnop",
            expected,
            body,
            1_793_560_010
        )
        .is_ok());
    }

    #[test]
    fn secrets_and_derived_codes() {
        use base64::Engine;
        let text = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 32]);
        assert_eq!(decode_secret(&text).unwrap(), vec![9u8; 32]);
        assert!(decode_secret(&format!("{text}=")).is_err());
        let short = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([9u8; 31]);
        assert!(decode_secret(&short).is_err());
        let id = uuid::Uuid::new_v4();
        let a = derive_pairing_code(SECRET, &id);
        assert_eq!(a, derive_pairing_code(SECRET, &id));
        assert_ne!(a, derive_pairing_code(SECRET, &uuid::Uuid::new_v4()));
        assert_ne!(
            a,
            derive_pairing_code(b"fedcba9876543210fedcba9876543210", &id)
        );
        assert!(crate::ids::normalize_pairing_code(&a).is_some());
    }

    #[test]
    fn nonce_shape() {
        assert!(valid_nonce(&new_nonce()));
        assert!(!valid_nonce("short"));
        assert!(!valid_nonce("has space in it 123"));
        assert!(!valid_nonce(&"a".repeat(65)));
    }
}
