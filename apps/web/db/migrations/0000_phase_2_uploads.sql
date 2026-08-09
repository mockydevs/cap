CREATE TYPE "recording_status" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');
CREATE TYPE "upload_session_status" AS ENUM ('ACTIVE', 'COMPLETING', 'COMPLETED', 'ABORTED', 'EXPIRED');
CREATE TABLE "recordings" ("id" uuid PRIMARY KEY NOT NULL, "workspace_id" uuid NOT NULL, "owner_id" uuid NOT NULL, "title" text NOT NULL, "status" "recording_status" DEFAULT 'UPLOADING' NOT NULL, "source_object_key" text NOT NULL UNIQUE, "content_type" text NOT NULL, "size_bytes" bigint, "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL);
CREATE TABLE "upload_sessions" ("id" uuid PRIMARY KEY NOT NULL, "workspace_id" uuid NOT NULL, "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE, "s3_upload_id" text NOT NULL UNIQUE, "object_key" text NOT NULL, "content_type" text NOT NULL, "part_size_bytes" integer NOT NULL, "expected_size_bytes" bigint NOT NULL, "status" "upload_session_status" DEFAULT 'ACTIVE' NOT NULL, "expires_at" timestamptz NOT NULL, "completed_at" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL);
CREATE INDEX "recordings_workspace_created_idx" ON "recordings" ("workspace_id", "created_at");
CREATE INDEX "upload_sessions_workspace_status_idx" ON "upload_sessions" ("workspace_id", "status");
CREATE INDEX "upload_sessions_recording_idx" ON "upload_sessions" ("recording_id");
