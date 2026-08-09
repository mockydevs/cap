CREATE TYPE "processing_attempt_status" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "recording_asset_kind" AS ENUM ('MP4', 'HLS_MANIFEST', 'HLS_SEGMENT', 'POSTER');
CREATE TYPE "processing_outbox_topic" AS ENUM ('MEDIA_PROCESSING');

CREATE TABLE "recording_processing_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "processing_version" integer NOT NULL,
  "worker_id" text NOT NULL,
  "status" "processing_attempt_status" NOT NULL,
  "source_metadata" jsonb,
  "asset_manifest" jsonb,
  "failure_category" text,
  "failure_detail" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz
);
CREATE UNIQUE INDEX "recording_processing_attempt_version_unique_idx" ON "recording_processing_attempts" ("recording_id", "processing_version");

CREATE TABLE "recording_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "processing_version" integer NOT NULL,
  "kind" "recording_asset_kind" NOT NULL,
  "object_key" text NOT NULL UNIQUE,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "recording_assets_recording_idx" ON "recording_assets" ("recording_id", "processing_version");

CREATE TABLE "processing_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "topic" "processing_outbox_topic" NOT NULL,
  "aggregate_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "published_at" timestamptz
);
CREATE UNIQUE INDEX "processing_outbox_topic_aggregate_unique_idx" ON "processing_outbox" ("topic", "aggregate_id");
CREATE INDEX "processing_outbox_pending_idx" ON "processing_outbox" ("topic", "published_at", "created_at");
