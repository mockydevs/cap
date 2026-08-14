import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { authorizePlayback, type RecordingVisibility } from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  type PlaybackObjectStorage,
} from "@cap/storage";
import { db } from "../../db/client";
import { recordingAssets, recordings, shareLinks } from "../../db/schema";
import { recordAuditEvent } from "../audit/service";
import { beginViewSession, type ViewKind } from "../analytics/service";
import { uploadStorage } from "../uploads/storage";

const PLAYBACK_URL_TTL_SECONDS = 120;
const DEFAULT_SHARE_TTL_HOURS = 7 * 24;

type SharingActor = {
  readonly userId: string;
  readonly workspaceId: string;
  readonly role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";
};

export class SharingServiceError extends Error {
  readonly code:
    | "RECORDING_NOT_FOUND"
    | "RECORDING_NOT_READY"
    | "SHARING_FORBIDDEN"
    | "SHARE_NOT_FOUND";
  readonly status: number;

  constructor(
    code: SharingServiceError["code"],
    status: number,
    message: string,
  ) {
    super(message);
    this.name = "SharingServiceError";
    this.code = code;
    this.status = status;
  }
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function updateRecordingSharing(
  actor: SharingActor,
  recordingId: string,
  input: {
    visibility: RecordingVisibility;
    expiresInHours?: number | undefined;
  },
) {
  const token = input.visibility === "LINK" ? generateShareToken() : undefined;
  const tokenHash = token ? hashShareToken(token) : undefined;
  const expiresAt = token
    ? new Date(
        Date.now() +
          (input.expiresInHours ?? DEFAULT_SHARE_TTL_HOURS) * 60 * 60 * 1000,
      )
    : undefined;

  await db().transaction(async (transaction) => {
    const [recording] = await transaction
      .select({ id: recordings.id, ownerId: recordings.ownerId })
      .from(recordings)
      .where(
        and(
          eq(recordings.id, recordingId),
          eq(recordings.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    if (!recording)
      throw new SharingServiceError(
        "RECORDING_NOT_FOUND",
        404,
        "Recording not found",
      );
    if (
      actor.role === "VIEWER" ||
      (actor.role === "MEMBER" && recording.ownerId !== actor.userId)
    ) {
      throw new SharingServiceError(
        "SHARING_FORBIDDEN",
        403,
        "Recording sharing cannot be changed",
      );
    }

    const now = new Date();
    await transaction
      .update(shareLinks)
      .set({ revokedAt: now })
      .where(
        and(
          eq(shareLinks.recordingId, recording.id),
          isNull(shareLinks.revokedAt),
        ),
      );
    await transaction
      .update(recordings)
      .set({ visibility: input.visibility, updatedAt: now })
      .where(eq(recordings.id, recording.id));
    if (input.visibility === "LINK" && token && tokenHash && expiresAt) {
      await transaction.insert(shareLinks).values({
        id: randomUUID(),
        workspaceId: actor.workspaceId,
        recordingId: recording.id,
        createdBy: actor.userId,
        mode: input.visibility,
        tokenHash,
        expiresAt,
      });
    }
    await recordAuditEvent(transaction, {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      action: "recording.sharing_updated",
      targetType: "recording",
      targetId: recording.id,
      metadata: { visibility: input.visibility },
    });
  });

  return {
    recordingId,
    visibility: input.visibility,
    ...(token
      ? {
          shareToken: token,
          playbackEndpoint: `/api/shares/${token}/playback`,
          expiresAt: expiresAt!.toISOString(),
        }
      : input.visibility === "PUBLIC"
        ? { playbackEndpoint: `/api/recordings/${recordingId}/playback` }
        : {}),
  };
}

async function playableRecording(recordingId: string) {
  const [recording] = await db()
    .select({
      recordingId: recordings.id,
      workspaceId: recordings.workspaceId,
      title: recordings.title,
      status: recordings.status,
      visibility: recordings.visibility,
      sourceObjectKey: recordings.sourceObjectKey,
      sourceContentType: recordings.contentType,
      sourceSizeBytes: recordings.sizeBytes,
    })
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .limit(1);
  if (!recording)
    throw new SharingServiceError(
      "RECORDING_NOT_FOUND",
      404,
      "Recording not found",
    );
  if (recording.status === "DELETED")
    throw new SharingServiceError(
      "RECORDING_NOT_FOUND",
      404,
      "Recording not found",
    );

  const [processed] = await db()
    .select({
      objectKey: recordingAssets.objectKey,
      contentType: recordingAssets.contentType,
      sizeBytes: recordingAssets.sizeBytes,
    })
    .from(recordingAssets)
    .where(
      and(
        eq(recordingAssets.recordingId, recordingId),
        eq(recordingAssets.kind, "MP4"),
      ),
    )
    .orderBy(desc(recordingAssets.processingVersion))
    .limit(1);

  // A completed source upload is already a valid media asset. Processing adds
  // the normalized MP4/HLS/poster renditions, but it must not hold the share
  // link hostage. Prefer the normalized MP4 once available and otherwise serve
  // the source while the worker continues in the background.
  const asset =
    recording.status === "READY" && processed
      ? processed
      : recording.sourceSizeBytes
        ? {
            objectKey: recording.sourceObjectKey,
            contentType: recording.sourceContentType,
            sizeBytes: recording.sourceSizeBytes,
          }
        : undefined;
  if (!asset) {
    throw new SharingServiceError(
      "RECORDING_NOT_READY",
      409,
      "Recording is not ready",
    );
  }
  return {
    recordingId: recording.recordingId,
    workspaceId: recording.workspaceId,
    title: recording.title,
    status: recording.status,
    visibility: recording.visibility,
    assetObjectKey: asset.objectKey,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
  };
}

async function signedPlayback(
  recording: Awaited<ReturnType<typeof playableRecording>>,
  storage: PlaybackObjectStorage,
  view: {
    request: Request;
    kind: ViewKind;
    actorUserId?: string | undefined;
    shareLinkId?: string | undefined;
  },
) {
  const [signed, analytics] = await Promise.all([
    storage.presignPlayback({
      objectKey: assertManagedMediaObjectKey(recording.assetObjectKey),
      expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
    }),
    beginViewSession({
      request: view.request,
      recordingId: recording.recordingId,
      workspaceId: recording.workspaceId,
      kind: view.kind,
      ...(view.actorUserId ? { actorUserId: view.actorUserId } : {}),
      ...(view.shareLinkId ? { shareLinkId: view.shareLinkId } : {}),
    }),
  ]);
  return {
    recordingId: recording.recordingId,
    title: recording.title,
    contentType: recording.contentType,
    sizeBytes: recording.sizeBytes,
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    viewSessionGrant: analytics.viewSessionGrant,
  };
}

export async function authorizeRecordingPlayback(
  request: Request,
  recordingId: string,
  actor: SharingActor | null,
  storage: PlaybackObjectStorage = uploadStorage(),
  viewKind?: ViewKind,
) {
  const recording = await playableRecording(recordingId);
  const decision = authorizePlayback({
    visibility: recording.visibility,
    isWorkspaceMember: actor?.workspaceId === recording.workspaceId,
    hasActiveShareLink: false,
  });
  if (!decision.allowed) {
    // Conceal private and link-only recording existence from unauthorized callers.
    throw new SharingServiceError(
      "RECORDING_NOT_FOUND",
      404,
      "Recording not found",
    );
  }
  return signedPlayback(recording, storage, {
    request,
    kind: viewKind ?? (decision.grant === "WORKSPACE" ? "WORKSPACE" : "PUBLIC"),
    ...(actor ? { actorUserId: actor.userId } : {}),
  });
}

/**
 * Holding an unexpired, unrevoked token is the whole of the check: the link is
 * the credential, so a recipient who has it can watch.
 */
export async function authorizeSharePlayback(
  request: Request,
  token: string,
  storage: PlaybackObjectStorage = uploadStorage(),
  options?: { viewKind?: ViewKind; expectedRecordingId?: string },
) {
  const tokenHash = hashShareToken(token);
  const now = new Date();
  const [link] = await db()
    .select({
      id: shareLinks.id,
      recordingId: shareLinks.recordingId,
      mode: shareLinks.mode,
    })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.tokenHash, tokenHash),
        isNull(shareLinks.revokedAt),
        or(isNull(shareLinks.expiresAt), gt(shareLinks.expiresAt, now)),
      ),
    )
    .limit(1);
  if (!link)
    throw new SharingServiceError("SHARE_NOT_FOUND", 404, "Share not found");
  if (
    options?.expectedRecordingId &&
    link.recordingId !== options.expectedRecordingId
  ) {
    throw new SharingServiceError("SHARE_NOT_FOUND", 404, "Share not found");
  }
  const recording = await playableRecording(link.recordingId);
  if (recording.visibility !== link.mode) {
    throw new SharingServiceError("SHARE_NOT_FOUND", 404, "Share not found");
  }

  const decision = authorizePlayback({
    visibility: recording.visibility,
    isWorkspaceMember: false,
    hasActiveShareLink: true,
  });
  if (!decision.allowed)
    throw new SharingServiceError("SHARE_NOT_FOUND", 404, "Share not found");
  return signedPlayback(recording, storage, {
    request,
    kind: options?.viewKind ?? "SHARE",
    shareLinkId: link.id,
  });
}
