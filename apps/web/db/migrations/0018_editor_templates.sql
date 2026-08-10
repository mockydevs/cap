CREATE TYPE "editor_template_kind" AS ENUM ('INTRO','OUTRO','GENERAL');

CREATE TABLE "editor_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" "editor_template_kind" NOT NULL,
  "fragment" jsonb NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "editor_templates_workspace_idx" ON "editor_templates" ("workspace_id", "kind");
