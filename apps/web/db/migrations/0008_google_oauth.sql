CREATE TABLE "oauth_accounts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_subject" text NOT NULL,
  "email_at_link" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "last_login_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "oauth_accounts_provider_check" CHECK ("provider" = 'google')
);
CREATE UNIQUE INDEX "oauth_accounts_provider_subject_unique_idx" ON "oauth_accounts" ("provider", "provider_subject");
CREATE UNIQUE INDEX "oauth_accounts_provider_user_unique_idx" ON "oauth_accounts" ("provider", "user_id");
