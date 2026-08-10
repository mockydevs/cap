CREATE TYPE "ai_provider_kind" AS ENUM ('OPENAI','ANTHROPIC','OPENAI_COMPATIBLE');
CREATE TYPE "ai_provider_connection_status" AS ENUM ('ACTIVE','REVOKED');
CREATE TYPE "ai_provider_purpose" AS ENUM ('ANALYSIS','EMBEDDINGS','TRANSCRIPTION');

CREATE TABLE "ai_provider_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" "ai_provider_kind" NOT NULL,
  "display_name" text NOT NULL,
  "base_url" text,
  "encrypted_credential" text NOT NULL,
  "credential_key_arn" text NOT NULL,
  "credential_fingerprint" text NOT NULL,
  "allowed_capabilities" jsonb NOT NULL,
  "allowed_models" jsonb NOT NULL,
  "default_model" text NOT NULL,
  "data_region" text,
  "status" "ai_provider_connection_status" DEFAULT 'ACTIVE' NOT NULL,
  "last_validated_at" timestamptz,
  "last_used_at" timestamptz,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_provider_connections_fingerprint_check" CHECK (length("credential_fingerprint")=12),
  CONSTRAINT "ai_provider_connections_capabilities_check" CHECK (jsonb_typeof("allowed_capabilities")='array' AND jsonb_array_length("allowed_capabilities")>0),
  CONSTRAINT "ai_provider_connections_models_check" CHECK (jsonb_typeof("allowed_models")='array' AND jsonb_array_length("allowed_models")>0)
);
CREATE INDEX "ai_provider_connections_workspace_idx" ON "ai_provider_connections"("workspace_id","status");

CREATE TABLE "ai_provider_routes" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "purpose" "ai_provider_purpose" NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "ai_provider_connections"("id") ON DELETE CASCADE,
  "model" text NOT NULL,
  "updated_by" uuid NOT NULL REFERENCES "users"("id"),
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("workspace_id","purpose")
);

ALTER TABLE "ai_jobs" ADD COLUMN "provider_connection_id" uuid REFERENCES "ai_provider_connections"("id") ON DELETE SET NULL;
CREATE INDEX "ai_jobs_provider_connection_idx" ON "ai_jobs"("provider_connection_id","created_at");
