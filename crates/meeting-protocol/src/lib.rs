//! Shared meeting protocol for Cap's desktop app, Chrome extension, meeting
//! service and the Calari integration. See
//! `docs/integrations/calari/CONTRACT.md`.

pub mod audio;
pub mod ids;
pub mod lifecycle;
pub mod signing;
pub mod types;

pub use lifecycle::{MeetingState, Transition};
pub use types::*;

#[cfg(test)]
mod fixtures {
    //! The fixtures in `docs/integrations/calari/fixtures` are produced from
    //! these types. Run with `UPDATE_FIXTURES=1` to regenerate them; otherwise
    //! the test fails if a fixture no longer matches the code.

    use super::*;
    use chrono::{TimeZone, Utc};
    use std::path::PathBuf;

    /// Same public synthetic key bytes as the Calari vector (00..1f).
    const FIXTURE_SECRET: &[u8] = &[
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        25, 26, 27, 28, 29, 30, 31,
    ];

    fn dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/integrations/calari/fixtures")
    }

    fn check(name: &str, value: &serde_json::Value) {
        let path = dir().join(name);
        let rendered = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::create_dir_all(dir()).unwrap();
            std::fs::write(&path, &rendered).unwrap();
        }
        let on_disk = std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("missing fixture {name}; run with UPDATE_FIXTURES=1"));
        assert_eq!(
            on_disk, rendered,
            "fixture {name} is stale; run with UPDATE_FIXTURES=1"
        );
    }

    fn sample_delivery() -> DeliveryPayload {
        let segments = vec![
            TranscriptSegment {
                index: 0,
                start_ms: 0,
                end_ms: 4_200,
                text: "Thanks for joining, let's go over the launch plan.".into(),
            },
            TranscriptSegment {
                index: 1,
                start_ms: 4_200,
                end_ms: 9_800,
                text: "We need the product photos by Friday.".into(),
            },
        ];
        let text = segments
            .iter()
            .map(|s| s.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        DeliveryPayload {
            schema: DELIVERY_SCHEMA.into(),
            event_id: delivery_event_id("3c9e7f20-5b1a-4d8e-9f6c-2a7b8c9d0e1f", 1),
            event_type: EVENT_TRANSCRIPT_COMPLETED.into(),
            revision: 1,
            tenant_id: "00000000-0000-4000-8000-000000000001".into(),
            client_id: Some("00000000-0000-4000-8000-000000000002".into()),
            pairing_id: "8d4e2f10-6a3b-4c7d-9e8f-1a2b3c4d5e6f".into(),
            intake_receipt_id: Some("00000000-0000-4000-8000-000000000003".into()),
            context: DeliveryContext {
                pairing_kind: PairingKind::ClientIntake,
                capture_mode: CaptureMode::Audio,
            },
            meeting: DeliveredMeeting {
                id: "3c9e7f20-5b1a-4d8e-9f6c-2a7b8c9d0e1f".into(),
                title: "Acme kickoff".into(),
                source: DeviceKind::Extension,
                provider_hint: Some("google_meet".into()),
                started_at: Utc.with_ymd_and_hms(2026, 11, 1, 9, 0, 0).unwrap(),
                ended_at: Utc.with_ymd_and_hms(2026, 11, 1, 9, 42, 10).unwrap(),
                duration_ms: 2_530_000,
                stop_reason: StopReason::MeetingEnded,
                partial: false,
                cap_url: "https://cap.example/v1/meetings/3c9e7f20-5b1a-4d8e-9f6c-2a7b8c9d0e1f"
                    .into(),
                meeting_url: Some("https://meet.google.com/abc-defg-hij".into()),
            },
            transcript: DeliveredTranscript {
                provider: "cap-whisper".into(),
                model: "ggml-small.en".into(),
                language: Some("en".into()),
                sha256: transcript_digest(&segments),
                segments,
                text,
            },
            // Calari's own worker summarizes, so Cap sends none by default.
            summary: None,
            created_at: Utc.with_ymd_and_hms(2026, 11, 1, 9, 44, 0).unwrap(),
        }
    }

    #[test]
    fn delivery_fixture_matches_types() {
        let payload = sample_delivery();
        let value = serde_json::to_value(&payload).unwrap();
        check("delivery.meeting.transcript.completed.json", &value);
        let back: DeliveryPayload = serde_json::from_value(value).unwrap();
        assert_eq!(back, payload);
    }

    #[test]
    fn pairing_fixtures_match_types() {
        let req = CreatePairingRequest {
            request_id: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b".into(),
            tenant_id: "00000000-0000-4000-8000-000000000001".into(),
            pairing_kind: PairingKind::ClientIntake,
            client_id: Some("00000000-0000-4000-8000-000000000002".into()),
            intake_receipt_id: Some("00000000-0000-4000-8000-000000000003".into()),
            client_display_name: Some("Acme Ltd".into()),
            ttl_seconds: 600,
        };
        assert!(req.validate().is_ok());
        check("pairing.request.json", &serde_json::to_value(&req).unwrap());
        let res = CreatePairingResponse {
            pairing_id: "8d4e2f10-6a3b-4c7d-9e8f-1a2b3c4d5e6f".into(),
            code: "7KQ2-M9XD".into(),
            expires_at: Utc.with_ymd_and_hms(2026, 11, 1, 20, 10, 0).unwrap(),
            deep_link: "cap://pair?code=7KQ2-M9XD".into(),
        };
        check(
            "pairing.response.json",
            &serde_json::to_value(&res).unwrap(),
        );
    }

    /// Shows a receiver exactly what to sign, with a throwaway secret, so the
    /// Calari side can unit-test its verifier against Cap's output.
    #[test]
    fn signed_example_fixture() {
        let body = serde_json::to_vec(&sample_delivery()).unwrap();
        let ts = 1_793_523_840_i64;
        let nonce = "fixturenonce_0000000001";
        let sig =
            signing::sign(FIXTURE_SECRET, signing::Purpose::Delivery, ts, nonce, &body).unwrap();
        let value = serde_json::json!({
            "note": "Throwaway secret for verifier tests only. Body is the compact JSON of delivery.meeting.transcript.completed.json.",
            "secret_hex": hex::encode(FIXTURE_SECRET),
            "secret_base64url": base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, FIXTURE_SECRET),
            "purpose": "delivery",
            "headers": {
                "x-cap-key-id": "fixture-key",
                "x-cap-timestamp": ts.to_string(),
                "x-cap-nonce": nonce,
                "x-cap-signature-256": sig,
                "x-cap-delivery-id": sample_delivery().event_id,
                "x-cap-content-sha256": ids::sha256_hex(&body),
            },
            "body": std::str::from_utf8(&body).unwrap(),
        });
        check("delivery.signed-example.json", &value);
        assert!(signing::verify(
            FIXTURE_SECRET,
            signing::Purpose::Delivery,
            &ts.to_string(),
            nonce,
            value["headers"]["x-cap-signature-256"].as_str().unwrap(),
            &body,
            ts
        )
        .is_ok());
    }
}
