import { bigint, index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const recordingStatus = pgEnum("recording_status", ["UPLOADING", "PROCESSING", "READY", "FAILED", "DELETED"]);
export const uploadSessionStatus = pgEnum("upload_session_status", ["ACTIVE", "COMPLETING", "COMPLETED", "ABORTED", "EXPIRED"]);

export const recordings = pgTable("recordings", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), ownerId: uuid("owner_id").notNull(),
  title: text("title").notNull(), status: recordingStatus("status").notNull().default("UPLOADING"),
  sourceObjectKey: text("source_object_key").notNull().unique(), contentType: text("content_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("recordings_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").primaryKey(), workspaceId: uuid("workspace_id").notNull(), recordingId: uuid("recording_id").notNull().references(() => recordings.id, { onDelete: "cascade" }),
  s3UploadId: text("s3_upload_id").notNull().unique(), objectKey: text("object_key").notNull(), contentType: text("content_type").notNull(), partSizeBytes: integer("part_size_bytes").notNull(), expectedSizeBytes: bigint("expected_size_bytes", { mode: "number" }).notNull(),
  status: uploadSessionStatus("status").notNull().default("ACTIVE"), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("upload_sessions_workspace_status_idx").on(table.workspaceId, table.status), index("upload_sessions_recording_idx").on(table.recordingId)]);
