-- Durable upload telemetry lets a second tab distinguish active, stalled, and
-- completed multipart work without trusting it for final object integrity.
ALTER TABLE "upload_sessions"
ADD COLUMN "recorded_size_bytes" bigint DEFAULT 0 NOT NULL,
ADD COLUMN "last_client_error" text,
ADD COLUMN "client_updated_at" timestamp with time zone;

ALTER TABLE "upload_part_intents"
ADD COLUMN "etag" text,
ADD COLUMN "uploaded_at" timestamp with time zone;
