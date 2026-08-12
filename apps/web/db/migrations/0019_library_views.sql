ALTER TABLE "recordings" ADD COLUMN "previous_status" "recording_status";
--> statement-breakpoint
CREATE INDEX "recordings_workspace_deleted_idx" ON "recordings" USING btree ("workspace_id", "deleted_at");
--> statement-breakpoint
CREATE TABLE "recording_stars" (
  "user_id" uuid NOT NULL,
  "recording_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "recording_stars_user_id_recording_id_pk" PRIMARY KEY("user_id", "recording_id"),
  CONSTRAINT "recording_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "recording_stars_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE,
  CONSTRAINT "recording_stars_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "recording_stars_user_workspace_idx" ON "recording_stars" USING btree ("user_id", "workspace_id", "created_at");
