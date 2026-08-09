CREATE TYPE "view_session_kind" AS ENUM ('WORKSPACE', 'SHARE', 'PUBLIC', 'EMBED');
CREATE TYPE "view_event_kind" AS ENUM ('HEARTBEAT', 'ENDED');
CREATE TABLE "recording_embed_policies" (
  "recording_id" uuid PRIMARY KEY NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
  "updated_by" uuid NOT NULL REFERENCES "users"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE "view_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "share_link_id" uuid REFERENCES "share_links"("id") ON DELETE SET NULL,
  "kind" "view_session_kind" NOT NULL,
  "viewer_hash" text NOT NULL,
  "dedup_key_hash" text NOT NULL,
  "first_viewed_at" timestamptz DEFAULT now() NOT NULL,
  "last_viewed_at" timestamptz DEFAULT now() NOT NULL,
  "watch_time_ms" bigint DEFAULT 0 NOT NULL,
  "max_position_ms" bigint DEFAULT 0 NOT NULL,
  "completed" boolean DEFAULT false NOT NULL,
  CONSTRAINT "view_sessions_viewer_hash_length_check" CHECK (length("viewer_hash") = 64),
  CONSTRAINT "view_sessions_dedup_hash_length_check" CHECK (length("dedup_key_hash") = 64)
);
CREATE UNIQUE INDEX "view_sessions_dedup_key_unique_idx" ON "view_sessions" ("dedup_key_hash");
CREATE INDEX "view_sessions_recording_first_idx" ON "view_sessions" ("recording_id", "first_viewed_at");
CREATE TABLE "view_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "view_session_id" uuid NOT NULL REFERENCES "view_sessions"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL,
  "kind" "view_event_kind" NOT NULL,
  "position_ms" bigint NOT NULL,
  "delta_ms" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "view_events_session_event_unique" UNIQUE("view_session_id", "event_id"),
  CONSTRAINT "view_events_position_nonnegative_check" CHECK ("position_ms" >= 0),
  CONSTRAINT "view_events_delta_bounded_check" CHECK ("delta_ms" >= 0 AND "delta_ms" <= 30000)
);
CREATE INDEX "view_events_session_created_idx" ON "view_events" ("view_session_id", "created_at");
