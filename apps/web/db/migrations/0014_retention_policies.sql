ALTER TABLE "recordings" ADD COLUMN "deleted_at" timestamptz;

CREATE TABLE "retention_policies" (
  "workspace_id" uuid PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "recording_retention_days" integer,
  "deleted_recording_purge_days" integer DEFAULT 30 NOT NULL,
  "updated_by" uuid NOT NULL REFERENCES "users"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
