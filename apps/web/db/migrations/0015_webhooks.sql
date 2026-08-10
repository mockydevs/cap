CREATE TYPE "webhook_event" AS ENUM ('recording.ready','recording.deleted','transcript.ready','ai_artifact.created','comment.created');
CREATE TYPE "webhook_endpoint_status" AS ENUM ('ACTIVE','DISABLED');
CREATE TYPE "webhook_delivery_status" AS ENUM ('PENDING','SUCCEEDED','FAILED');

CREATE TABLE "webhook_endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "description" text,
  "encrypted_secret" text NOT NULL,
  "secret_key_arn" text NOT NULL,
  "secret_fingerprint" text NOT NULL,
  "enabled_events" jsonb NOT NULL,
  "status" "webhook_endpoint_status" DEFAULT 'ACTIVE' NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_delivery_at" timestamptz,
  "last_delivery_status" "webhook_delivery_status"
);
CREATE INDEX "webhook_endpoints_workspace_idx" ON "webhook_endpoints" ("workspace_id", "status");

CREATE TABLE "webhook_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event" "webhook_event" NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "aggregate_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "published_at" timestamptz
);
CREATE INDEX "webhook_outbox_pending_idx" ON "webhook_outbox" ("published_at", "created_at");

CREATE TABLE "webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "webhook_endpoint_id" uuid NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "event" "webhook_event" NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "webhook_delivery_status" DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "response_status" integer,
  "response_excerpt" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "delivered_at" timestamptz
);
CREATE INDEX "webhook_deliveries_endpoint_idx" ON "webhook_deliveries" ("webhook_endpoint_id", "created_at");
