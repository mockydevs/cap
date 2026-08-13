CREATE TYPE "ai_usage_lane" AS ENUM ('BYOK','MANAGED','DEPLOYMENT');
--> statement-breakpoint
CREATE TYPE "ai_usage_unit_kind" AS ENUM ('TOKENS','AUDIO_MS');
--> statement-breakpoint
CREATE TYPE "ai_usage_source" AS ENUM ('AI_JOB','TRANSCRIPTION_RUN','EMBEDDING_BATCH');
--> statement-breakpoint
CREATE TYPE "workspace_subscription_status" AS ENUM ('ACTIVE','TRIALING','PAST_DUE','CANCELED','INCOMPLETE','UNPAID');
--> statement-breakpoint
CREATE TABLE "ai_usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "purpose" "ai_provider_purpose" NOT NULL,
  "lane" "ai_usage_lane" NOT NULL,
  "source_kind" "ai_usage_source" NOT NULL,
  "source_id" uuid NOT NULL,
  "connection_id" uuid,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "units" bigint NOT NULL,
  "unit_kind" "ai_usage_unit_kind" NOT NULL,
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_microunits" bigint NOT NULL,
  "charged_microunits" bigint NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'USD',
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_usage_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "ai_usage_events_connection_id_ai_provider_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "ai_provider_connections"("id") ON DELETE SET NULL,
  CONSTRAINT "ai_usage_events_amounts_check" CHECK ("units" >= 0 AND "cost_microunits" >= 0 AND "charged_microunits" >= 0),
  CONSTRAINT "ai_usage_events_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ai_usage_events_charge_lane_check" CHECK ("lane" = 'MANAGED' OR "charged_microunits" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_events_source_unique_idx" ON "ai_usage_events" USING btree ("source_kind", "source_id");
--> statement-breakpoint
CREATE INDEX "ai_usage_events_workspace_occurred_idx" ON "ai_usage_events" USING btree ("workspace_id", "occurred_at");
--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
  "workspace_id" uuid PRIMARY KEY,
  "provider" text NOT NULL DEFAULT 'STRIPE',
  "customer_id" text NOT NULL,
  "subscription_id" text,
  "plan_code" text NOT NULL,
  "status" "workspace_subscription_status" NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "included_credit_microunits" bigint NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  CONSTRAINT "workspace_subscriptions_credit_check" CHECK ("included_credit_microunits" >= 0),
  CONSTRAINT "workspace_subscriptions_period_check" CHECK ("current_period_end" > "current_period_start")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_subscriptions_customer_unique_idx" ON "workspace_subscriptions" USING btree ("customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_subscriptions_subscription_unique_idx" ON "workspace_subscriptions" USING btree ("subscription_id") WHERE "subscription_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "billing_events" (
  "event_id" text PRIMARY KEY,
  "provider" text NOT NULL DEFAULT 'STRIPE',
  "event_type" text NOT NULL,
  "received_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "billing_events_received_idx" ON "billing_events" USING btree ("received_at");
