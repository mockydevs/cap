import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const recordingStatus = pgEnum("recording_status", [
  "UPLOADING",
  "PROCESSING",
  "READY",
  "FAILED",
  "DELETED",
]);
export const uploadSessionStatus = pgEnum("upload_session_status", [
  "PENDING",
  "UPLOADING",
  "COMPLETING",
  "COMPLETED",
  "ABORTED",
  "EXPIRED",
]);
export const workspaceRole = pgEnum("workspace_role", [
  "OWNER",
  "ADMIN",
  "MEMBER",
  "VIEWER",
]);
export const processingAttemptStatus = pgEnum("processing_attempt_status", [
  "RUNNING",
  "COMPLETED",
  "FAILED",
]);
export const recordingAssetKind = pgEnum("recording_asset_kind", [
  "MP4",
  "HLS_MANIFEST",
  "HLS_SEGMENT",
  "POSTER",
]);
export const processingOutboxTopic = pgEnum("processing_outbox_topic", [
  "MEDIA_PROCESSING",
]);
export const recordingVisibility = pgEnum("recording_visibility", [
  "PRIVATE",
  "LINK",
  "PASSWORD",
  "PUBLIC",
]);
export const shareLinkMode = pgEnum("share_link_mode", ["LINK", "PASSWORD"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique_idx").on(table.email)],
);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    activeWorkspaceId: uuid("active_workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const recordings = pgTable(
  "recordings",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    status: recordingStatus("status").notNull().default("UPLOADING"),
    visibility: recordingVisibility("visibility").notNull().default("PRIVATE"),
    sourceObjectKey: text("source_object_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("recordings_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    s3UploadId: text("s3_upload_id").notNull().unique(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    partSizeBytes: integer("part_size_bytes").notNull(),
    expectedSizeBytes: bigint("expected_size_bytes", {
      mode: "number",
    }).notNull(),
    maxPartCount: integer("max_part_count").notNull(),
    status: uploadSessionStatus("status").notNull().default("PENDING"),
    completionIdempotencyKeyHash: text("completion_idempotency_key_hash"),
    completionRequestHash: text("completion_request_hash"),
    completionResult: jsonb("completion_result").$type<{
      recordingId: string;
      status: "PROCESSING";
      sizeBytes: number;
    }>(),
    completionStartedAt: timestamp("completion_started_at", {
      withTimezone: true,
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("upload_sessions_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("upload_sessions_recording_idx").on(table.recordingId),
  ],
);

export const uploadPartIntents = pgTable(
  "upload_part_intents",
  {
    uploadSessionId: uuid("upload_session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    contentLength: bigint("content_length", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    isFinalPart: boolean("is_final_part").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.uploadSessionId, table.partNumber] }),
    index("upload_part_intents_session_idx").on(
      table.uploadSessionId,
      table.partNumber,
    ),
  ],
);

export const recordingProcessingAttempts = pgTable(
  "recording_processing_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    processingVersion: integer("processing_version").notNull(),
    workerId: text("worker_id").notNull(),
    status: processingAttemptStatus("status").notNull(),
    sourceMetadata: jsonb("source_metadata").$type<{
      durationSeconds: number;
      width: number;
      height: number;
    }>(),
    assetManifest:
      jsonb("asset_manifest").$type<
        readonly { kind: string; objectKey: string; contentType: string }[]
      >(),
    failureCategory: text("failure_category"),
    failureDetail: text("failure_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("recording_processing_attempt_version_unique_idx").on(
      table.recordingId,
      table.processingVersion,
    ),
  ],
);

export const recordingAssets = pgTable(
  "recording_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    processingVersion: integer("processing_version").notNull(),
    kind: recordingAssetKind("kind").notNull(),
    objectKey: text("object_key").notNull().unique(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("recording_assets_recording_idx").on(
      table.recordingId,
      table.processingVersion,
    ),
  ],
);

export const processingOutbox = pgTable(
  "processing_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    topic: processingOutboxTopic("topic").notNull(),
    aggregateId: uuid("aggregate_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    payload: jsonb("payload")
      .$type<{
        recordingId: string;
        workspaceId: string;
        sourceObjectKey: string;
        processingVersion: number;
      }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("processing_outbox_topic_aggregate_unique_idx").on(
      table.topic,
      table.aggregateId,
    ),
    index("processing_outbox_pending_idx").on(
      table.topic,
      table.publishedAt,
      table.createdAt,
    ),
  ],
);

export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    mode: shareLinkMode("mode").notNull(),
    tokenHash: text("token_hash").notNull(),
    passwordHash: text("password_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("share_links_token_hash_unique_idx").on(table.tokenHash),
    uniqueIndex("share_links_one_active_recording_idx")
      .on(table.recordingId)
      .where(sql`${table.revokedAt} is null`),
    index("share_links_workspace_recording_idx").on(
      table.workspaceId,
      table.recordingId,
    ),
    check(
      "share_links_password_mode_check",
      sql`(${table.mode} = 'PASSWORD' AND ${table.passwordHash} IS NOT NULL) OR (${table.mode} = 'LINK' AND ${table.passwordHash} IS NULL)`,
    ),
    check(
      "share_links_token_hash_length_check",
      sql`length(${table.tokenHash}) = 64`,
    ),
  ],
);
