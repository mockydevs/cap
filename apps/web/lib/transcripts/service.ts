import { and, asc, desc, eq, gt, ilike, ne, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { recordings, transcriptSegments, transcripts } from "../../db/schema";
import type { Actor } from "../auth/session";
import { toSrt, toWebVtt } from "./format";

export class TranscriptServiceError extends Error {
  constructor(
    readonly code:
      | "TRANSCRIPT_NOT_FOUND"
      | "TRANSCRIPT_NOT_READY"
      | "SEGMENT_NOT_FOUND"
      | "TRANSCRIPT_EDIT_FORBIDDEN"
      | "TRANSCRIPT_CONFLICT",
    readonly status: number,
  ) {
    super(code);
  }
}

type TranscriptActor = Pick<Actor, "userId" | "workspaceId" | "role">;

async function scopedTranscript(recordingId: string, actor: TranscriptActor) {
  const [transcript] = await db()
    .select({
      id: transcripts.id,
      recordingId: transcripts.recordingId,
      status: transcripts.status,
      language: transcripts.approvedLanguage,
      correctionRevision: transcripts.correctionRevision,
    })
    .from(transcripts)
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(
      and(
        eq(transcripts.recordingId, recordingId),
        eq(transcripts.workspaceId, actor.workspaceId),
        ne(recordings.status, "DELETED"),
      ),
    )
    .limit(1);
  if (!transcript)
    throw new TranscriptServiceError("TRANSCRIPT_NOT_FOUND", 404);
  return transcript;
}

function visibleText() {
  return sql<string>`coalesce(${transcriptSegments.correctedText}, ${transcriptSegments.providerText})`;
}
function visibleSpeaker() {
  return sql<
    string | null
  >`coalesce(${transcriptSegments.correctedSpeakerLabel}, ${transcriptSegments.providerSpeakerLabel})`;
}

/** All approved segments for burning captions into a render; empty when no ready transcript exists. */
export async function approvedCaptionCues(
  recordingId: string,
  workspaceId: string,
): Promise<{ startMs: number; endMs: number; text: string }[]> {
  const [transcript] = await db()
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.recordingId, recordingId),
        eq(transcripts.workspaceId, workspaceId),
        eq(transcripts.status, "READY"),
      ),
    )
    .limit(1);
  if (!transcript) return [];
  return db()
    .select({
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: visibleText(),
    })
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.transcriptId, transcript.id),
        eq(transcriptSegments.isOrphaned, false),
      ),
    )
    .orderBy(asc(transcriptSegments.ordinal));
}

export async function listTranscript(
  recordingId: string,
  actor: TranscriptActor,
  cursor: number | undefined,
  limit: number,
) {
  const transcript = await scopedTranscript(recordingId, actor);
  const rows = await db()
    .select({
      id: transcriptSegments.id,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: visibleText(),
      speakerLabel: visibleSpeaker(),
      ordinal: transcriptSegments.ordinal,
      correctionVersion: transcriptSegments.correctionVersion,
    })
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.transcriptId, transcript.id),
        eq(transcriptSegments.isOrphaned, false),
        cursor === undefined
          ? undefined
          : gt(transcriptSegments.ordinal, cursor),
      ),
    )
    .orderBy(asc(transcriptSegments.ordinal))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return {
    transcript: {
      id: transcript.id,
      language: transcript.language,
      status: transcript.status,
      correctionRevision: transcript.correctionRevision,
    },
    items,
    nextCursor: rows.length > limit ? (items.at(-1)?.ordinal ?? null) : null,
  };
}

export async function updateTranscriptLanguage(
  recordingId: string,
  actor: TranscriptActor,
  language: string | null,
) {
  if (actor.role === "VIEWER")
    throw new TranscriptServiceError("TRANSCRIPT_EDIT_FORBIDDEN", 403);
  const transcript = await scopedTranscript(recordingId, actor);
  const [updated] = await db()
    .update(transcripts)
    .set({ approvedLanguage: language, updatedAt: new Date() })
    .where(eq(transcripts.id, transcript.id))
    .returning({ id: transcripts.id, language: transcripts.approvedLanguage });
  return updated!;
}

export async function updateTranscriptSegment(
  recordingId: string,
  segmentId: string,
  actor: TranscriptActor,
  input: {
    text: string;
    speakerLabel?: string | null | undefined;
    expectedCorrectionRevision: number;
  },
) {
  if (actor.role === "VIEWER")
    throw new TranscriptServiceError("TRANSCRIPT_EDIT_FORBIDDEN", 403);
  const transcript = await scopedTranscript(recordingId, actor);
  return db().transaction(async (transaction) => {
    const [revision] = await transaction
      .update(transcripts)
      .set({
        correctionRevision: sql`${transcripts.correctionRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(transcripts.id, transcript.id),
          eq(transcripts.correctionRevision, input.expectedCorrectionRevision),
        ),
      )
      .returning({ correctionRevision: transcripts.correctionRevision });
    if (!revision) throw new TranscriptServiceError("TRANSCRIPT_CONFLICT", 409);
    const [updated] = await transaction
      .update(transcriptSegments)
      .set({
        correctedText: input.text,
        ...(input.speakerLabel !== undefined
          ? { correctedSpeakerLabel: input.speakerLabel }
          : {}),
        correctionVersion: sql`${transcriptSegments.correctionVersion} + 1`,
        correctedBy: actor.userId,
        correctedAt: new Date(),
      })
      .where(
        and(
          eq(transcriptSegments.id, segmentId),
          eq(transcriptSegments.transcriptId, transcript.id),
        ),
      )
      .returning({ id: transcriptSegments.id });
    if (!updated) throw new TranscriptServiceError("SEGMENT_NOT_FOUND", 404);
    return { ...updated, correctionRevision: revision.correctionRevision };
  });
}

export async function renderCaptions(
  recordingId: string,
  actor: TranscriptActor,
  format: "vtt" | "srt",
) {
  const transcript = await scopedTranscript(recordingId, actor);
  if (transcript.status !== "READY")
    throw new TranscriptServiceError("TRANSCRIPT_NOT_READY", 409);
  const segments = await db()
    .select({
      id: transcriptSegments.id,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: visibleText(),
      speakerLabel: visibleSpeaker(),
    })
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.transcriptId, transcript.id),
        eq(transcriptSegments.isOrphaned, false),
      ),
    )
    .orderBy(asc(transcriptSegments.ordinal));
  return format === "vtt" ? toWebVtt(segments) : toSrt(segments);
}

export async function searchWorkspaceTranscripts(
  actor: TranscriptActor,
  query: string,
  cursor: string | undefined,
  limit: number,
) {
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db()
    .select({
      id: transcriptSegments.id,
      recordingId: recordings.id,
      recordingTitle: recordings.title,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs,
      text: visibleText(),
      speakerLabel: visibleSpeaker(),
    })
    .from(transcriptSegments)
    .innerJoin(transcripts, eq(transcripts.id, transcriptSegments.transcriptId))
    .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
    .where(
      and(
        eq(transcripts.workspaceId, actor.workspaceId),
        eq(transcripts.status, "READY"),
        eq(transcriptSegments.isOrphaned, false),
        ne(recordings.status, "DELETED"),
        cursor ? gt(transcriptSegments.id, cursor) : undefined,
        ilike(visibleText(), pattern),
      ),
    )
    .orderBy(desc(transcriptSegments.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
  };
}
