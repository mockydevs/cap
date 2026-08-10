ALTER TABLE "recordings" ADD COLUMN "linked_recording_id" uuid REFERENCES "recordings"("id") ON DELETE SET NULL;
CREATE INDEX "recordings_linked_recording_idx" ON "recordings" ("linked_recording_id");
