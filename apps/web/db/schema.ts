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
  serial,
  text,
  unique,
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
export const viewSessionKind = pgEnum("view_session_kind", [
  "WORKSPACE",
  "SHARE",
  "PUBLIC",
  "EMBED",
]);
export const viewEventKind = pgEnum("view_event_kind", ["HEARTBEAT", "ENDED"]);

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

export const recordingEmbedPolicies = pgTable("recording_embed_policies", {
  recordingId: uuid("recording_id")
    .primaryKey()
    .references(() => recordings.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  allowedOrigins: text("allowed_origins")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const viewSessions = pgTable(
  "view_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    shareLinkId: uuid("share_link_id").references(() => shareLinks.id, {
      onDelete: "set null",
    }),
    kind: viewSessionKind("kind").notNull(),
    viewerHash: text("viewer_hash").notNull(),
    dedupKeyHash: text("dedup_key_hash").notNull(),
    firstViewedAt: timestamp("first_viewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    watchTimeMs: bigint("watch_time_ms", { mode: "number" })
      .notNull()
      .default(0),
    maxPositionMs: bigint("max_position_ms", { mode: "number" })
      .notNull()
      .default(0),
    completed: boolean("completed").notNull().default(false),
  },
  (table) => [
    uniqueIndex("view_sessions_dedup_key_unique_idx").on(table.dedupKeyHash),
    index("view_sessions_recording_first_idx").on(
      table.recordingId,
      table.firstViewedAt,
    ),
    check(
      "view_sessions_viewer_hash_length_check",
      sql`length(${table.viewerHash}) = 64`,
    ),
    check(
      "view_sessions_dedup_hash_length_check",
      sql`length(${table.dedupKeyHash}) = 64`,
    ),
  ],
);

export const viewEvents = pgTable(
  "view_events",
  {
    id: serial("id").primaryKey(),
    viewSessionId: uuid("view_session_id")
      .notNull()
      .references(() => viewSessions.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").notNull(),
    kind: viewEventKind("kind").notNull(),
    positionMs: bigint("position_ms", { mode: "number" }).notNull(),
    deltaMs: integer("delta_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("view_events_session_event_unique").on(
      table.viewSessionId,
      table.eventId,
    ),
    index("view_events_session_created_idx").on(
      table.viewSessionId,
      table.createdAt,
    ),
    check(
      "view_events_position_nonnegative_check",
      sql`${table.positionMs} >= 0`,
    ),
    check(
      "view_events_delta_bounded_check",
      sql`${table.deltaMs} >= 0 AND ${table.deltaMs} <= 30000`,
    ),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    guestName: text("guest_name"),
    guestKeyHash: text("guest_key_hash"),
    body: text("body").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    index("comments_recording_created_idx").on(
      table.recordingId,
      table.createdAt,
    ),
    check(
      "comments_author_check",
      sql`(${table.authorUserId} IS NOT NULL) OR (${table.guestName} IS NOT NULL AND ${table.guestKeyHash} IS NOT NULL)`,
    ),
  ],
);

export const commentReactions = pgTable(
  "comment_reactions",
  {
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    actorKeyHash: text("actor_key_hash").notNull(),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.commentId, table.actorKeyHash, table.emoji] }),
    index("comment_reactions_comment_idx").on(table.commentId),
  ],
);
