import { and, desc, eq, ne } from "drizzle-orm";
import {
  assertManagedMediaObjectKey,
  type PlaybackObjectStorage,
} from "@cap/storage";
import { db } from "../../db/client";
import { recordingAssets, recordings } from "../../db/schema";
import type { Actor } from "../auth/session";
import { uploadStorage } from "../uploads/storage";
import { RecordingServiceError } from "./service";

const PREVIEW_URL_TTL_SECONDS = 5 * 60;

/**
 * Returns visual media for a private library thumbnail without creating a
 * playback analytics session. The generated poster is preferred; the source
 * video lets a freshly uploaded recording become recognisable before media
 * processing finishes.
 */
export async function recordingPreview(
  actor: Actor,
  recordingId: string,
  storage: PlaybackObjectStorage = uploadStorage(),
) {
  const [recording] = await db()
    .select({
      id: recordings.id,
      sourceObjectKey: recordings.sourceObjectKey,
      sourceSizeBytes: recordings.sizeBytes,
    })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        ne(recordings.status, "DELETED"),
      ),
    )
    .limit(1);

  if (!recording) throw new RecordingServiceError("RECORDING_NOT_FOUND", 404);

  const [poster] = await db()
    .select({ objectKey: recordingAssets.objectKey })
    .from(recordingAssets)
    .where(
      and(
        eq(recordingAssets.recordingId, recording.id),
        eq(recordingAssets.kind, "POSTER"),
      ),
    )
    .orderBy(desc(recordingAssets.processingVersion))
    .limit(1);

  if (!poster && !recording.sourceSizeBytes) return null;

  const [posterPlayback, videoPlayback] = await Promise.all([
    poster
      ? storage.presignPlayback({
          objectKey: assertManagedMediaObjectKey(poster.objectKey),
          expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
        })
      : Promise.resolve(null),
    recording.sourceSizeBytes
      ? storage.presignPlayback({
          objectKey: assertManagedMediaObjectKey(recording.sourceObjectKey),
          expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
        })
      : Promise.resolve(null),
  ]);
  return {
    posterUrl: posterPlayback?.url ?? null,
    videoUrl: videoPlayback?.url ?? null,
    expiresAt: (posterPlayback ?? videoPlayback)!.expiresAt.toISOString(),
  };
}
