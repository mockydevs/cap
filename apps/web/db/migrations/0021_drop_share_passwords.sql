-- Password-protected sharing is gone: the link itself is the credential.
-- Existing password shares become plain link shares so that URLs already in
-- someone's inbox keep working, and the stored hashes are dropped.

UPDATE "recordings" SET "visibility" = 'LINK' WHERE "visibility" = 'PASSWORD';
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT IF EXISTS "share_links_password_mode_check";
--> statement-breakpoint
UPDATE "share_links" SET "mode" = 'LINK' WHERE "mode" = 'PASSWORD';
--> statement-breakpoint
ALTER TABLE "share_links" DROP COLUMN IF EXISTS "password_hash";
--> statement-breakpoint

-- Postgres cannot drop a value from an enum, so each type is rebuilt without it.
ALTER TYPE "recording_visibility" RENAME TO "recording_visibility_old";
--> statement-breakpoint
CREATE TYPE "recording_visibility" AS ENUM ('PRIVATE', 'LINK', 'PUBLIC');
--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "visibility" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "visibility" TYPE "recording_visibility" USING "visibility"::text::"recording_visibility";
--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "visibility" SET DEFAULT 'PRIVATE';
--> statement-breakpoint
DROP TYPE "recording_visibility_old";
--> statement-breakpoint

ALTER TYPE "share_link_mode" RENAME TO "share_link_mode_old";
--> statement-breakpoint
CREATE TYPE "share_link_mode" AS ENUM ('LINK');
--> statement-breakpoint
ALTER TABLE "share_links" ALTER COLUMN "mode" TYPE "share_link_mode" USING "mode"::text::"share_link_mode";
--> statement-breakpoint
DROP TYPE "share_link_mode_old";
