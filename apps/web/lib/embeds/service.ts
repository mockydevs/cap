import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { recordingEmbedPolicies, recordings } from "../../db/schema";
import { actorFromToken, tokenFromRequest, type Actor } from "../auth/session";
import {
  authorizeRecordingPlayback,
  authorizeSharePlayback,
  SharingServiceError,
} from "../sharing/service";

export class EmbedServiceError extends Error {
  readonly code:
    "EMBED_NOT_ALLOWED" | "RECORDING_NOT_FOUND" | "EMBED_FORBIDDEN";
  readonly status: number;
  constructor(code: EmbedServiceError["code"], status: number) {
    super(code);
    this.name = "EmbedServiceError";
    this.code = code;
    this.status = status;
  }
}

export async function updateEmbedPolicy(
  actor: Pick<Actor, "userId" | "workspaceId" | "role">,
  recordingId: string,
  input: { enabled: boolean; allowedOrigins: string[] },
) {
  const [recording] = await db()
    .select({ id: recordings.id, ownerId: recordings.ownerId })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (!recording) throw new EmbedServiceError("RECORDING_NOT_FOUND", 404);
  if (
    actor.role === "VIEWER" ||
    (actor.role === "MEMBER" && recording.ownerId !== actor.userId)
  ) {
    throw new EmbedServiceError("EMBED_FORBIDDEN", 403);
  }
  await db()
    .insert(recordingEmbedPolicies)
    .values({
      recordingId,
      workspaceId: actor.workspaceId,
      enabled: input.enabled,
      allowedOrigins: input.allowedOrigins,
      updatedBy: actor.userId,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recordingEmbedPolicies.recordingId,
      set: {
        enabled: input.enabled,
        allowedOrigins: input.allowedOrigins,
        updatedBy: actor.userId,
        updatedAt: new Date(),
      },
    });
  return { recordingId, ...input };
}

export async function assertEmbedOrigin(
  recordingId: string,
  origin: string | null,
) {
  const [policy] = await db()
    .select()
    .from(recordingEmbedPolicies)
    .where(eq(recordingEmbedPolicies.recordingId, recordingId))
    .limit(1);
  if (!policy?.enabled || !origin || !policy.allowedOrigins.includes(origin)) {
    throw new EmbedServiceError("EMBED_NOT_ALLOWED", 403);
  }
  return origin;
}

export async function authorizeEmbedPlayback(
  request: Request,
  recordingId: string,
  input: { shareToken?: string | undefined },
) {
  const origin = await assertEmbedOrigin(
    recordingId,
    request.headers.get("origin"),
  );
  if (input.shareToken) {
    return {
      origin,
      playback: await authorizeSharePlayback(
        request,
        input.shareToken,
        undefined,
        {
          viewKind: "EMBED",
          expectedRecordingId: recordingId,
        },
      ),
    };
  }
  const actor = await actorFromToken(tokenFromRequest(request));
  return {
    origin,
    playback: await authorizeRecordingPlayback(
      request,
      recordingId,
      actor,
      undefined,
      "EMBED",
    ),
  };
}

export function embedError(error: unknown): Response {
  if (error instanceof EmbedServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  if (error instanceof SharingServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  throw error;
}
