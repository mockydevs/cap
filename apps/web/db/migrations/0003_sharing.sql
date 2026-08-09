CREATE TYPE "recording_visibility" AS ENUM ('PRIVATE', 'LINK', 'PASSWORD', 'PUBLIC');
CREATE TYPE "share_link_mode" AS ENUM ('LINK', 'PASSWORD');
ALTER TABLE "recordings" ADD COLUMN "visibility" "recording_visibility" DEFAULT 'PRIVATE' NOT NULL;
CREATE TABLE "share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "mode" "share_link_mode" NOT NULL,
  "token_hash" text NOT NULL,
  "password_hash" text,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "share_links_password_mode_check" CHECK (("mode" = 'PASSWORD' AND "password_hash" IS NOT NULL) OR ("mode" = 'LINK' AND "password_hash" IS NULL)),
  CONSTRAINT "share_links_token_hash_length_check" CHECK (length("token_hash") = 64)
);
CREATE UNIQUE INDEX "share_links_token_hash_unique_idx" ON "share_links" ("token_hash");
CREATE UNIQUE INDEX "share_links_one_active_recording_idx" ON "share_links" ("recording_id") WHERE "revoked_at" IS NULL;
CREATE INDEX "share_links_workspace_recording_idx" ON "share_links" ("workspace_id", "recording_id");
