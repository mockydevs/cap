import {
  bigint,
  boolean,
  check,
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
