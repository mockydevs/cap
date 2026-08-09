CREATE TYPE "transcript_status" AS ENUM ('REQUESTED', 'PROCESSING', 'READY', 'FAILED', 'DISABLED');
CREATE TYPE "transcription_run_status" AS ENUM ('PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "transcription_consent_basis" AS ENUM ('EXPLICIT', 'WORKSPACE_POLICY', 'NOT_REQUIRED');
CREATE TYPE "caption_track_format" AS ENUM ('WEBVTT', 'SRT');
CREATE TABLE "transcripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "source_asset_id" uuid NOT NULL REFERENCES "recording_assets"("id"),
  "status" "transcript_status" DEFAULT 'REQUESTED' NOT NULL,
  "requested_language" text,
  "approved_language" text,
  "correction_revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "transcripts_correction_revision_check" CHECK ("correction_revision" >= 0)
);
CREATE UNIQUE INDEX "transcripts_recording_unique_idx" ON "transcripts" ("recording_id");
CREATE INDEX "transcripts_workspace_status_idx" ON "transcripts" ("workspace_id", "status");
CREATE TABLE "transcription_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transcript_id" uuid NOT NULL REFERENCES "transcripts"("id") ON DELETE CASCADE,
  "attempt" integer NOT NULL,
  "status" "transcription_run_status" NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "provider_request_id_hash" text,
  "requested_language" text,
  "detected_language" text,
  "identify_speakers" boolean DEFAULT false NOT NULL,
  "consent_basis" "transcription_consent_basis" NOT NULL,
  "consent_captured_at" timestamptz NOT NULL,
  "consent_actor_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "billed_duration_ms" bigint,
  "cost_microunits" bigint,
  "currency" text,
  "data_region" text,
  "error_category" text,
  "started_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "transcription_runs_attempt_check" CHECK ("attempt" > 0),
  CONSTRAINT "transcription_runs_cost_pair_check" CHECK (("cost_microunits" IS NULL AND "currency" IS NULL) OR ("cost_microunits" >= 0 AND "currency" ~ '^[A-Z]{3}$')),
  CONSTRAINT "transcription_runs_request_hash_check" CHECK ("provider_request_id_hash" IS NULL OR length("provider_request_id_hash") = 64),
  CONSTRAINT "transcription_runs_explicit_consent_check" CHECK ("consent_basis" <> 'EXPLICIT' OR "consent_actor_user_id" IS NOT NULL)
);
CREATE UNIQUE INDEX "transcription_runs_attempt_unique_idx" ON "transcription_runs" ("transcript_id", "attempt");
CREATE INDEX "transcription_runs_transcript_status_idx" ON "transcription_runs" ("transcript_id", "status");
CREATE TABLE "transcript_run_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "transcription_runs"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  "ordinal" integer NOT NULL,
  "start_ms" bigint NOT NULL,
  "end_ms" bigint NOT NULL,
  "text" text NOT NULL,
  "speaker_label" text,
  "confidence" numeric(6,5),
  CONSTRAINT "transcript_run_segments_timing_check" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms")
);
CREATE UNIQUE INDEX "transcript_run_segments_key_unique_idx" ON "transcript_run_segments" ("run_id", "provider_key");
CREATE UNIQUE INDEX "transcript_run_segments_ordinal_unique_idx" ON "transcript_run_segments" ("run_id", "ordinal");
CREATE TABLE "transcript_run_words" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_segment_id" uuid NOT NULL REFERENCES "transcript_run_segments"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  "ordinal" integer NOT NULL,
  "start_ms" bigint NOT NULL,
  "end_ms" bigint NOT NULL,
  "text" text NOT NULL,
  "confidence" numeric(6,5),
  CONSTRAINT "transcript_run_words_timing_check" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms")
);
CREATE UNIQUE INDEX "transcript_run_words_key_unique_idx" ON "transcript_run_words" ("run_segment_id", "provider_key");
CREATE UNIQUE INDEX "transcript_run_words_ordinal_unique_idx" ON "transcript_run_words" ("run_segment_id", "ordinal");
CREATE TABLE "transcript_segments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "transcript_id" uuid NOT NULL REFERENCES "transcripts"("id") ON DELETE CASCADE,
  "source_run_segment_id" uuid REFERENCES "transcript_run_segments"("id") ON DELETE SET NULL,
  "ordinal" integer NOT NULL,
  "start_ms" bigint NOT NULL,
  "end_ms" bigint NOT NULL,
  "provider_text" text NOT NULL,
  "corrected_text" text,
  "provider_speaker_label" text,
  "corrected_speaker_label" text,
  "confidence" numeric(6,5),
  "is_orphaned" boolean DEFAULT false NOT NULL,
  "correction_version" integer DEFAULT 0 NOT NULL,
  "corrected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "corrected_at" timestamptz,
  CONSTRAINT "transcript_segments_timing_check" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms"),
  CONSTRAINT "transcript_segments_correction_version_check" CHECK ("correction_version" >= 0),
  CONSTRAINT "transcript_segments_correction_audit_check" CHECK (("corrected_text" IS NULL AND "corrected_speaker_label" IS NULL) OR "corrected_at" IS NOT NULL)
);
CREATE INDEX "transcript_segments_transcript_ordinal_idx" ON "transcript_segments" ("transcript_id", "ordinal");
CREATE TABLE "transcript_words" (
  "id" uuid PRIMARY KEY NOT NULL,
  "segment_id" uuid NOT NULL REFERENCES "transcript_segments"("id") ON DELETE CASCADE,
  "source_run_word_id" uuid REFERENCES "transcript_run_words"("id") ON DELETE SET NULL,
  "ordinal" integer NOT NULL,
  "start_ms" bigint NOT NULL,
  "end_ms" bigint NOT NULL,
  "provider_text" text NOT NULL,
  "corrected_text" text,
  "confidence" numeric(6,5),
  "is_orphaned" boolean DEFAULT false NOT NULL,
  "correction_version" integer DEFAULT 0 NOT NULL,
  "corrected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "corrected_at" timestamptz,
  CONSTRAINT "transcript_words_timing_check" CHECK ("start_ms" >= 0 AND "end_ms" > "start_ms"),
  CONSTRAINT "transcript_words_correction_audit_check" CHECK ("corrected_text" IS NULL OR "corrected_at" IS NOT NULL)
);
CREATE INDEX "transcript_words_segment_ordinal_idx" ON "transcript_words" ("segment_id", "ordinal");
CREATE TABLE "caption_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transcript_id" uuid NOT NULL REFERENCES "transcripts"("id") ON DELETE CASCADE,
  "format" "caption_track_format" NOT NULL,
  "language" text NOT NULL,
  "object_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "source_correction_revision" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "caption_tracks_content_hash_check" CHECK (length("content_hash") = 64)
);
CREATE UNIQUE INDEX "caption_tracks_revision_unique_idx" ON "caption_tracks" ("transcript_id", "format", "language", "source_correction_revision");
CREATE UNIQUE INDEX "caption_tracks_object_key_unique_idx" ON "caption_tracks" ("object_key");
