CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE INDEX "transcript_segments_visible_text_trgm_idx" ON "transcript_segments" USING gin (coalesce("corrected_text", "provider_text") gin_trgm_ops);
