import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
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
  "EXPORT",
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
export const transcriptStatus = pgEnum("transcript_status", [
  "REQUESTED",
  "PROCESSING",
  "READY",
  "FAILED",
  "DISABLED",
]);
export const transcriptionRunStatus = pgEnum("transcription_run_status", [
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
]);
export const transcriptionConsentBasis = pgEnum("transcription_consent_basis", [
  "EXPLICIT",
  "WORKSPACE_POLICY",
  "NOT_REQUIRED",
]);
export const captionTrackFormat = pgEnum("caption_track_format", [
  "WEBVTT",
  "SRT",
]);
export const renderJobStatus = pgEnum("render_job_status", [
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);
export const aiJobStatus = pgEnum("ai_job_status", [
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
]);
export const aiArtifactStatus = pgEnum("ai_artifact_status", [
  "SUGGESTED",
  "ACCEPTED",
  "REJECTED",
]);
export const aiProviderKind = pgEnum("ai_provider_kind", [
  "OPENAI",
  "ANTHROPIC",
  "OPENAI_COMPATIBLE",
]);
export const aiProviderConnectionStatus = pgEnum(
  "ai_provider_connection_status",
  ["ACTIVE", "REVOKED"],
);
export const aiProviderPurpose = pgEnum("ai_provider_purpose", [
  "ANALYSIS",
  "EMBEDDINGS",
  "TRANSCRIPTION",
]);
export const aiCapability = pgEnum("ai_capability", [
  "TITLE_DESCRIPTION",
  "SUMMARY",
  "CHAPTERS",
  "ACTION_ITEMS",
  "HIGHLIGHTS",
  "QUESTIONS_ANSWERS",
  "TRANSLATION",
  "FOLLOW_UP",
  "SENSITIVE_DATA",
]);

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

export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    emailAtLink: text("email_at_link").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("oauth_accounts_provider_subject_unique_idx").on(
      table.provider,
      table.providerSubject,
    ),
    uniqueIndex("oauth_accounts_provider_user_unique_idx").on(
      table.provider,
      table.userId,
    ),
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
    durationMs: bigint("duration_ms", { mode: "number" }),
    width: integer("width"),
    height: integer("height"),
    /** A separately-captured camera recording made alongside this one (or vice versa) — see docs on camera overlays. */
    linkedRecordingId: uuid("linked_recording_id").references(
      (): AnyPgColumn => recordings.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    previousStatus: recordingStatus("previous_status"),
  },
  (table) => [
    index("recordings_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("recordings_linked_recording_idx").on(table.linkedRecordingId),
    index("recordings_workspace_deleted_idx").on(
      table.workspaceId,
      table.deletedAt,
    ),
    check(
      "recordings_media_metadata_check",
      sql`(${table.durationMs} IS NULL AND ${table.width} IS NULL AND ${table.height} IS NULL) OR (${table.durationMs} > 0 AND ${table.width} > 0 AND ${table.height} > 0)`,
    ),
  ],
);

export const recordingStars = pgTable(
  "recording_stars",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.recordingId] }),
    index("recording_stars_user_workspace_idx").on(
      table.userId,
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

export const transcripts = pgTable(
  "transcripts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    sourceAssetId: uuid("source_asset_id")
      .notNull()
      .references(() => recordingAssets.id),
    status: transcriptStatus("status").notNull().default("REQUESTED"),
    requestedLanguage: text("requested_language"),
    approvedLanguage: text("approved_language"),
    correctionRevision: integer("correction_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("transcripts_recording_unique_idx").on(table.recordingId),
    index("transcripts_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    check(
      "transcripts_correction_revision_check",
      sql`${table.correctionRevision} >= 0`,
    ),
  ],
);

export const transcriptionRuns = pgTable(
  "transcription_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: transcriptionRunStatus("status").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    providerRequestIdHash: text("provider_request_id_hash"),
    requestedLanguage: text("requested_language"),
    detectedLanguage: text("detected_language"),
    identifySpeakers: boolean("identify_speakers").notNull().default(false),
    consentBasis: transcriptionConsentBasis("consent_basis").notNull(),
    consentCapturedAt: timestamp("consent_captured_at", {
      withTimezone: true,
    }).notNull(),
    consentActorUserId: uuid("consent_actor_user_id").references(
      () => users.id,
      { onDelete: "set null" },
    ),
    billedDurationMs: bigint("billed_duration_ms", { mode: "number" }),
    costMicrounits: bigint("cost_microunits", { mode: "number" }),
    currency: text("currency"),
    dataRegion: text("data_region"),
    errorCategory: text("error_category"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("transcription_runs_attempt_unique_idx").on(
      table.transcriptId,
      table.attempt,
    ),
    index("transcription_runs_transcript_status_idx").on(
      table.transcriptId,
      table.status,
    ),
    check("transcription_runs_attempt_check", sql`${table.attempt} > 0`),
    check(
      "transcription_runs_cost_pair_check",
      sql`(${table.costMicrounits} IS NULL AND ${table.currency} IS NULL) OR (${table.costMicrounits} >= 0 AND ${table.currency} ~ '^[A-Z]{3}$')`,
    ),
    check(
      "transcription_runs_request_hash_check",
      sql`${table.providerRequestIdHash} IS NULL OR length(${table.providerRequestIdHash}) = 64`,
    ),
    check(
      "transcription_runs_explicit_consent_check",
      sql`${table.consentBasis} <> 'EXPLICIT' OR ${table.consentActorUserId} IS NOT NULL`,
    ),
  ],
);

export const transcriptRunSegments = pgTable(
  "transcript_run_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => transcriptionRuns.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    speakerLabel: text("speaker_label"),
    confidence: numeric("confidence", {
      precision: 6,
      scale: 5,
      mode: "number",
    }),
  },
  (table) => [
    uniqueIndex("transcript_run_segments_key_unique_idx").on(
      table.runId,
      table.providerKey,
    ),
    uniqueIndex("transcript_run_segments_ordinal_unique_idx").on(
      table.runId,
      table.ordinal,
    ),
    check(
      "transcript_run_segments_timing_check",
      sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
    ),
  ],
);

export const transcriptRunWords = pgTable(
  "transcript_run_words",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runSegmentId: uuid("run_segment_id")
      .notNull()
      .references(() => transcriptRunSegments.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    confidence: numeric("confidence", {
      precision: 6,
      scale: 5,
      mode: "number",
    }),
  },
  (table) => [
    uniqueIndex("transcript_run_words_key_unique_idx").on(
      table.runSegmentId,
      table.providerKey,
    ),
    uniqueIndex("transcript_run_words_ordinal_unique_idx").on(
      table.runSegmentId,
      table.ordinal,
    ),
    check(
      "transcript_run_words_timing_check",
      sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
    ),
  ],
);

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    sourceRunSegmentId: uuid("source_run_segment_id").references(
      () => transcriptRunSegments.id,
      { onDelete: "set null" },
    ),
    ordinal: integer("ordinal").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    providerText: text("provider_text").notNull(),
    correctedText: text("corrected_text"),
    providerSpeakerLabel: text("provider_speaker_label"),
    correctedSpeakerLabel: text("corrected_speaker_label"),
    confidence: numeric("confidence", {
      precision: 6,
      scale: 5,
      mode: "number",
    }),
    isOrphaned: boolean("is_orphaned").notNull().default(false),
    correctionVersion: integer("correction_version").notNull().default(0),
    correctedBy: uuid("corrected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (table) => [
    index("transcript_segments_transcript_ordinal_idx").on(
      table.transcriptId,
      table.ordinal,
    ),
    index("transcript_segments_visible_text_trgm_idx").using(
      "gin",
      sql`coalesce(${table.correctedText}, ${table.providerText}) gin_trgm_ops`,
    ),
    check(
      "transcript_segments_timing_check",
      sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
    ),
    check(
      "transcript_segments_correction_version_check",
      sql`${table.correctionVersion} >= 0`,
    ),
    check(
      "transcript_segments_correction_audit_check",
      sql`(${table.correctedText} IS NULL AND ${table.correctedSpeakerLabel} IS NULL) OR ${table.correctedAt} IS NOT NULL`,
    ),
  ],
);

export const transcriptWords = pgTable(
  "transcript_words",
  {
    id: uuid("id").primaryKey(),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => transcriptSegments.id, { onDelete: "cascade" }),
    sourceRunWordId: uuid("source_run_word_id").references(
      () => transcriptRunWords.id,
      { onDelete: "set null" },
    ),
    ordinal: integer("ordinal").notNull(),
    startMs: bigint("start_ms", { mode: "number" }).notNull(),
    endMs: bigint("end_ms", { mode: "number" }).notNull(),
    providerText: text("provider_text").notNull(),
    correctedText: text("corrected_text"),
    confidence: numeric("confidence", {
      precision: 6,
      scale: 5,
      mode: "number",
    }),
    isOrphaned: boolean("is_orphaned").notNull().default(false),
    correctionVersion: integer("correction_version").notNull().default(0),
    correctedBy: uuid("corrected_by").references(() => users.id, {
      onDelete: "set null",
    }),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
  },
  (table) => [
    index("transcript_words_segment_ordinal_idx").on(
      table.segmentId,
      table.ordinal,
    ),
    check(
      "transcript_words_timing_check",
      sql`${table.startMs} >= 0 AND ${table.endMs} > ${table.startMs}`,
    ),
    check(
      "transcript_words_correction_audit_check",
      sql`${table.correctedText} IS NULL OR ${table.correctedAt} IS NOT NULL`,
    ),
  ],
);

export const captionTracks = pgTable(
  "caption_tracks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    format: captionTrackFormat("format").notNull(),
    language: text("language").notNull(),
    objectKey: text("object_key").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceCorrectionRevision: integer("source_correction_revision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("caption_tracks_revision_unique_idx").on(
      table.transcriptId,
      table.format,
      table.language,
      table.sourceCorrectionRevision,
    ),
    uniqueIndex("caption_tracks_object_key_unique_idx").on(table.objectKey),
    check(
      "caption_tracks_content_hash_check",
      sql`length(${table.contentHash}) = 64`,
    ),
  ],
);

export const editorProjects = pgTable(
  "editor_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    currentRevision: integer("current_revision").notNull().default(0),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("editor_projects_workspace_updated_idx").on(
      table.workspaceId,
      table.updatedAt,
    ),
    index("editor_projects_recording_idx").on(table.recordingId),
    check("editor_projects_revision_check", sql`${table.currentRevision} >= 0`),
    check(
      "editor_projects_schema_version_check",
      sql`${table.schemaVersion} > 0`,
    ),
  ],
);

export const editorRevisions = pgTable(
  "editor_revisions",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => editorProjects.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    document: jsonb("document").$type<unknown>().notNull(),
    documentHash: text("document_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.revision] }),
    index("editor_revisions_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    check("editor_revisions_revision_check", sql`${table.revision} >= 0`),
    check(
      "editor_revisions_document_hash_check",
      sql`length(${table.documentHash}) = 64`,
    ),
  ],
);

export const renderJobs = pgTable(
  "render_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => editorProjects.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    status: renderJobStatus("status").notNull().default("QUEUED"),
    manifest: jsonb("manifest").$type<unknown>().notNull(),
    manifestHash: text("manifest_hash").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    attempt: integer("attempt").notNull().default(0),
    outputAssetId: uuid("output_asset_id").references(
      () => recordingAssets.id,
      { onDelete: "set null" },
    ),
    errorCategory: text("error_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId, table.revision],
      foreignColumns: [editorRevisions.projectId, editorRevisions.revision],
      name: "render_jobs_project_revision_fk",
    }),
    uniqueIndex("render_jobs_project_revision_unique_idx").on(
      table.projectId,
      table.revision,
    ),
    index("render_jobs_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    check("render_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "render_jobs_manifest_hash_check",
      sql`length(${table.manifestHash}) = 64`,
    ),
  ],
);

export const aiProviderConnections = pgTable(
  "ai_provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: aiProviderKind("provider").notNull(),
    displayName: text("display_name").notNull(),
    baseUrl: text("base_url"),
    encryptedCredential: text("encrypted_credential").notNull(),
    credentialKeyArn: text("credential_key_arn").notNull(),
    credentialFingerprint: text("credential_fingerprint").notNull(),
    allowedCapabilities: jsonb("allowed_capabilities")
      .$type<Array<"ANALYSIS" | "EMBEDDINGS" | "TRANSCRIPTION">>()
      .notNull(),
    allowedModels: jsonb("allowed_models").$type<string[]>().notNull(),
    defaultModel: text("default_model").notNull(),
    dataRegion: text("data_region"),
    status: aiProviderConnectionStatus("status").notNull().default("ACTIVE"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_provider_connections_workspace_idx").on(
      table.workspaceId,
      table.status,
    ),
    check(
      "ai_provider_connections_fingerprint_check",
      sql`length(${table.credentialFingerprint}) = 12`,
    ),
  ],
);

export const aiProviderRoutes = pgTable(
  "ai_provider_routes",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    purpose: aiProviderPurpose("purpose").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => aiProviderConnections.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.purpose] })],
);

export const aiWorkspacePolicies = pgTable(
  "ai_workspace_policies",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    allowedProvider: text("allowed_provider")
      .notNull()
      .default("openai-compatible"),
    allowExternalProcessing: boolean("allow_external_processing")
      .notNull()
      .default(false),
    monthlyTokenLimit: integer("monthly_token_limit")
      .notNull()
      .default(1_000_000),
    monthlyCostLimitMicrounits: bigint("monthly_cost_limit_microunits", {
      mode: "number",
    })
      .notNull()
      .default(25_000_000),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    check(
      "ai_workspace_policies_token_limit_check",
      sql`${table.monthlyTokenLimit} >= 0`,
    ),
    check(
      "ai_workspace_policies_cost_limit_check",
      sql`${table.monthlyCostLimitMicrounits} >= 0`,
    ),
  ],
);

export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    transcriptRevision: integer("transcript_revision").notNull(),
    inputHash: text("input_hash").notNull(),
    capability: aiCapability("capability").notNull(),
    status: aiJobStatus("status").notNull().default("QUEUED"),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    providerConnectionId: uuid("provider_connection_id").references(
      () => aiProviderConnections.id,
      { onDelete: "set null" },
    ),
    provider: text("provider"),
    model: text("model"),
    question: text("question"),
    targetLanguage: text("target_language"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMicrounits: bigint("cost_microunits", { mode: "number" }),
    currency: text("currency"),
    providerRequestIdHash: text("provider_request_id_hash"),
    errorCategory: text("error_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("ai_jobs_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("ai_jobs_recording_status_idx").on(table.recordingId, table.status),
    check("ai_jobs_input_hash_check", sql`length(${table.inputHash}) = 64`),
    check("ai_jobs_revision_check", sql`${table.transcriptRevision} >= 0`),
  ],
);

export const aiArtifacts = pgTable(
  "ai_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .unique()
      .references(() => aiJobs.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    capability: aiCapability("capability").notNull(),
    content: jsonb("content").$type<unknown>().notNull(),
    status: aiArtifactStatus("status").notNull().default("SUGGESTED"),
    acceptedBy: uuid("accepted_by").references(() => users.id),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_artifacts_recording_idx").on(
      table.workspaceId,
      table.recordingId,
      table.createdAt,
    ),
  ],
);

export const aiSearchDocuments = pgTable(
  "ai_search_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordingId: uuid("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    transcriptId: uuid("transcript_id")
      .notNull()
      .references(() => transcripts.id, { onDelete: "cascade" }),
    segmentId: uuid("segment_id")
      .notNull()
      .unique()
      .references(() => transcriptSegments.id, { onDelete: "cascade" }),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: jsonb("embedding").$type<number[]>().notNull(),
    model: text("model").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ai_search_documents_workspace_recording_idx").on(
      table.workspaceId,
      table.recordingId,
    ),
    check(
      "ai_search_documents_content_hash_check",
      sql`length(${table.contentHash})=64`,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: workspaceRole("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("workspace_invitations_workspace_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("workspace_invitations_email_idx").on(table.email),
  ],
);

export const retentionPolicies = pgTable("retention_policies", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  recordingRetentionDays: integer("recording_retention_days"),
  deletedRecordingPurgeDays: integer("deleted_recording_purge_days")
    .notNull()
    .default(30),
  updatedBy: uuid("updated_by")
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const webhookEvent = pgEnum("webhook_event", [
  "recording.ready",
  "recording.deleted",
  "transcript.ready",
  "ai_artifact.created",
  "comment.created",
]);
export const webhookEndpointStatus = pgEnum("webhook_endpoint_status", [
  "ACTIVE",
  "DISABLED",
]);
export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "PENDING",
  "SUCCEEDED",
  "FAILED",
]);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    description: text("description"),
    encryptedSecret: text("encrypted_secret").notNull(),
    secretKeyArn: text("secret_key_arn").notNull(),
    secretFingerprint: text("secret_fingerprint").notNull(),
    enabledEvents: jsonb("enabled_events").$type<string[]>().notNull(),
    status: webhookEndpointStatus("status").notNull().default("ACTIVE"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    lastDeliveryStatus: webhookDeliveryStatus("last_delivery_status"),
  },
  (table) => [
    index("webhook_endpoints_workspace_idx").on(
      table.workspaceId,
      table.status,
    ),
  ],
);

export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    event: webhookEvent("event").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    aggregateId: text("aggregate_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_outbox_pending_idx").on(table.publishedAt, table.createdAt),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookEndpointId: uuid("webhook_endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    event: webhookEvent("event").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: webhookDeliveryStatus("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    responseExcerpt: text("response_excerpt"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => [
    index("webhook_deliveries_endpoint_idx").on(
      table.webhookEndpointId,
      table.createdAt,
    ),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    keyPrefix: text("key_prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("api_keys_workspace_idx").on(table.workspaceId)],
);

export const editorTemplateKind = pgEnum("editor_template_kind", [
  "INTRO",
  "OUTRO",
  "GENERAL",
]);

export const editorTemplates = pgTable(
  "editor_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: editorTemplateKind("kind").notNull(),
    /** An EditorTemplateFragment (see @cap/editor-domain): sourceAssetIds, clips, overlays, durationMs. */
    fragment: jsonb("fragment").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("editor_templates_workspace_idx").on(table.workspaceId, table.kind),
  ],
);

export const aiUsageLane = pgEnum("ai_usage_lane", [
  "BYOK",
  "MANAGED",
  "DEPLOYMENT",
]);
export const aiUsageUnitKind = pgEnum("ai_usage_unit_kind", [
  "TOKENS",
  "AUDIO_MS",
]);
export const aiUsageSource = pgEnum("ai_usage_source", [
  "AI_JOB",
  "TRANSCRIPTION_RUN",
  "EMBEDDING_BATCH",
]);

/**
 * The one authoritative record of metered AI consumption.
 *
 * `ai_jobs` and `transcription_runs` remain the operational record of what ran
 * and how it went; this table answers what it cost and who paid. Quota checks
 * and the usage screen read here and nowhere else, so analysis, transcription,
 * and embedding spend can be summed together — the split that previously let
 * transcription and embeddings run entirely unmetered. Each row is written in
 * the same transaction that completes its source, and `(source_kind,
 * source_id)` is unique so a retried job cannot double-count.
 */
export const aiUsageEvents = pgTable(
  "ai_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    purpose: aiProviderPurpose("purpose").notNull(),
    lane: aiUsageLane("lane").notNull(),
    sourceKind: aiUsageSource("source_kind").notNull(),
    sourceId: uuid("source_id").notNull(),
    connectionId: uuid("connection_id").references(
      () => aiProviderConnections.id,
      { onDelete: "set null" },
    ),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    units: bigint("units", { mode: "number" }).notNull(),
    unitKind: aiUsageUnitKind("unit_kind").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    /** Estimated provider cost, counted against the workspace's own ceiling. */
    costMicrounits: bigint("cost_microunits", { mode: "number" }).notNull(),
    /** Decremented from plan credit; zero unless the managed lane paid. */
    chargedMicrounits: bigint("charged_microunits", { mode: "number" })
      .notNull()
      .default(0),
    currency: text("currency").notNull().default("USD"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_usage_events_source_unique_idx").on(
      table.sourceKind,
      table.sourceId,
    ),
    index("ai_usage_events_workspace_occurred_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
    check(
      "ai_usage_events_amounts_check",
      sql`${table.units} >= 0 AND ${table.costMicrounits} >= 0 AND ${table.chargedMicrounits} >= 0`,
    ),
    check(
      "ai_usage_events_currency_check",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "ai_usage_events_charge_lane_check",
      sql`${table.lane} = 'MANAGED' OR ${table.chargedMicrounits} = 0`,
    ),
  ],
);

export const workspaceSubscriptionStatus = pgEnum(
  "workspace_subscription_status",
  ["ACTIVE", "TRIALING", "PAST_DUE", "CANCELED", "INCOMPLETE", "UNPAID"],
);

/**
 * A mirror of the billing provider's subscription, never the source of truth.
 * Cap reads it to decide whether the managed AI lane is available and how much
 * credit the current period carries; the provider's webhook is what writes it.
 */
export const workspaceSubscriptions = pgTable(
  "workspace_subscriptions",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("STRIPE"),
    customerId: text("customer_id").notNull(),
    subscriptionId: text("subscription_id"),
    planCode: text("plan_code").notNull(),
    status: workspaceSubscriptionStatus("status").notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
    }).notNull(),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
    }).notNull(),
    includedCreditMicrounits: bigint("included_credit_microunits", {
      mode: "number",
    }).notNull(),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_subscriptions_customer_unique_idx").on(
      table.customerId,
    ),
    check(
      "workspace_subscriptions_credit_check",
      sql`${table.includedCreditMicrounits} >= 0`,
    ),
    check(
      "workspace_subscriptions_period_check",
      sql`${table.currentPeriodEnd} > ${table.currentPeriodStart}`,
    ),
  ],
);

/**
 * Delivered billing webhook identifiers. Providers redeliver on any non-2xx,
 * so a subscription change must be applied at most once no matter how often
 * the same event arrives.
 */
export const billingEvents = pgTable(
  "billing_events",
  {
    eventId: text("event_id").primaryKey(),
    provider: text("provider").notNull().default("STRIPE"),
    eventType: text("event_type").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("billing_events_received_idx").on(table.receivedAt)],
);
