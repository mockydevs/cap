CREATE TYPE "render_job_status" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELED');
ALTER TYPE "recording_asset_kind" ADD VALUE 'EXPORT';
ALTER TABLE "recordings" ADD COLUMN "duration_ms" bigint;
ALTER TABLE "recordings" ADD COLUMN "width" integer;
ALTER TABLE "recordings" ADD COLUMN "height" integer;
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_media_metadata_check" CHECK (("duration_ms" IS NULL AND "width" IS NULL AND "height" IS NULL) OR ("duration_ms" > 0 AND "width" > 0 AND "height" > 0));
CREATE TABLE "editor_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "recording_id" uuid NOT NULL REFERENCES "recordings"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "schema_version" integer NOT NULL, "current_revision" integer DEFAULT 0 NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"), "created_at" timestamptz DEFAULT now() NOT NULL, "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "editor_projects_revision_check" CHECK ("current_revision" >= 0), CONSTRAINT "editor_projects_schema_version_check" CHECK ("schema_version" > 0)
);
CREATE INDEX "editor_projects_workspace_updated_idx" ON "editor_projects" ("workspace_id", "updated_at");
CREATE INDEX "editor_projects_recording_idx" ON "editor_projects" ("recording_id");
CREATE TABLE "editor_revisions" (
  "project_id" uuid NOT NULL REFERENCES "editor_projects"("id") ON DELETE CASCADE, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL, "schema_version" integer NOT NULL, "document" jsonb NOT NULL, "document_hash" text NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"), "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "editor_revisions_pk" PRIMARY KEY("project_id", "revision"), CONSTRAINT "editor_revisions_revision_check" CHECK ("revision" >= 0), CONSTRAINT "editor_revisions_document_hash_check" CHECK (length("document_hash") = 64)
);
CREATE INDEX "editor_revisions_workspace_created_idx" ON "editor_revisions" ("workspace_id", "created_at");
CREATE TABLE "render_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "editor_projects"("id") ON DELETE CASCADE, "revision" integer NOT NULL,
  "status" "render_job_status" DEFAULT 'QUEUED' NOT NULL, "manifest" jsonb NOT NULL, "manifest_hash" text NOT NULL,
  "requested_by" uuid NOT NULL REFERENCES "users"("id"), "attempt" integer DEFAULT 0 NOT NULL,
  "output_asset_id" uuid REFERENCES "recording_assets"("id") ON DELETE SET NULL, "error_category" text,
  "created_at" timestamptz DEFAULT now() NOT NULL, "started_at" timestamptz, "completed_at" timestamptz,
  CONSTRAINT "render_jobs_project_revision_fk" FOREIGN KEY ("project_id", "revision") REFERENCES "editor_revisions"("project_id", "revision"),
  CONSTRAINT "render_jobs_attempt_check" CHECK ("attempt" >= 0), CONSTRAINT "render_jobs_manifest_hash_check" CHECK (length("manifest_hash") = 64)
);
CREATE UNIQUE INDEX "render_jobs_project_revision_unique_idx" ON "render_jobs" ("project_id", "revision");
CREATE INDEX "render_jobs_workspace_status_idx" ON "render_jobs" ("workspace_id", "status", "created_at");
