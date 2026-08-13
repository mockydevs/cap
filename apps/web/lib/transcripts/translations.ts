import { createHash } from "node:crypto";
import { recordingId, workspaceId } from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  buildTranscriptCaptionObjectKey,
} from "@cap/storage";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { aiArtifacts, aiJobs, captionTracks } from "../../db/schema";
import { uploadStorage } from "../uploads/storage";
import { toSrt, toWebVtt, type CaptionSegment } from "./format";

type TranslationArtifactContent = {
  language: string;
  text: string;
  segments?: CaptionSegment[];
};

async function latestTranslationSegments(input: {
  workspaceId: string;
  recordingId: string;
  language: string;
  transcriptRevision: number;
}): Promise<CaptionSegment[] | undefined> {
  const [row] = await db()
    .select({ content: aiArtifacts.content })
    .from(aiArtifacts)
    .innerJoin(aiJobs, eq(aiJobs.id, aiArtifacts.jobId))
    .where(
      and(
        eq(aiArtifacts.workspaceId, input.workspaceId),
        eq(aiArtifacts.recordingId, input.recordingId),
        eq(aiArtifacts.capability, "TRANSLATION"),
        eq(aiJobs.targetLanguage, input.language),
        eq(aiJobs.transcriptRevision, input.transcriptRevision),
      ),
    )
    .orderBy(desc(aiArtifacts.createdAt))
    .limit(1);
  const content = row?.content as TranslationArtifactContent | undefined;
  return content?.segments?.length ? content.segments : undefined;
}

/**
 * Serves a translated caption track, generating and caching it in object
 * storage on first request. Returns undefined when no accepted TRANSLATION
 * AI artifact exists yet for this exact transcript revision and language —
 * callers should have the requester create one via
 * `POST /api/recordings/:id/ai` with capability "TRANSLATION" first.
 */
export async function translatedCaptions(input: {
  workspaceId: string;
  recordingId: string;
  transcriptId: string;
  correctionRevision: number;
  language: string;
  format: "vtt" | "srt";
}): Promise<string | undefined> {
  const trackFormat = input.format === "vtt" ? "WEBVTT" : "SRT";
  const [existing] = await db()
    .select({ objectKey: captionTracks.objectKey })
    .from(captionTracks)
    .where(
      and(
        eq(captionTracks.transcriptId, input.transcriptId),
        eq(captionTracks.format, trackFormat),
        eq(captionTracks.language, input.language),
        eq(captionTracks.sourceCorrectionRevision, input.correctionRevision),
      ),
    )
    .limit(1);
  if (existing) {
    const cached = await uploadStorage().getTextObject(
      assertManagedMediaObjectKey(existing.objectKey),
    );
    if (cached !== undefined) return cached;
  }

  const segments = await latestTranslationSegments({
    workspaceId: input.workspaceId,
    recordingId: input.recordingId,
    language: input.language,
    transcriptRevision: input.correctionRevision,
  });
  if (!segments) return undefined;

  const content = input.format === "vtt" ? toWebVtt(segments) : toSrt(segments);
  const objectKey = buildTranscriptCaptionObjectKey({
    workspaceId: workspaceId(input.workspaceId),
    recordingId: recordingId(input.recordingId),
    language: input.language,
    extension: input.format,
  });
  await uploadStorage().putTextObject({
    objectKey,
    content,
    contentType:
      input.format === "vtt"
        ? "text/vtt; charset=utf-8"
        : "application/x-subrip; charset=utf-8",
  });
  await db()
    .insert(captionTracks)
    .values({
      transcriptId: input.transcriptId,
      format: trackFormat,
      language: input.language,
      objectKey,
      contentHash: createHash("sha256").update(content).digest("hex"),
      sourceCorrectionRevision: input.correctionRevision,
    })
    .onConflictDoNothing();
  return content;
}
