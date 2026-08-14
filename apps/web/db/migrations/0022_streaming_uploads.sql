-- Live browser uploads start before their final size is known. The service
-- issues a bounded quota and seals expected_size_bytes when the last part is
-- signed, while legacy post-recording uploads retain the fixed-size contract.
ALTER TABLE "upload_sessions"
ADD COLUMN "is_streaming" boolean DEFAULT false NOT NULL;
