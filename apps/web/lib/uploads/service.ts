import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import {
  createUploadPlan,
  recordingId,
  sha256Base64,
  sourceMediaType,
  uploadSessionId,
  validateUploadPartIntent,
  workspaceId,
} from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  buildSourceMediaObjectKey,
  multipartUploadId,
  type MultipartObjectStorage,
} from "@cap/storage";
import { PROCESSING_VERSION } from "@cap/queue";
import { db } from "../../db/client";
import {
  processingOutbox,
  recordings,
  uploadPartIntents,
  uploadSessions,
} from "../../db/schema";
import {
  reconcileCompletedParts,
  type BrowserCompletedPart,
} from "./reconcile";
import { uploadStorage } from "./storage";
import { UPLOAD_PART_SIZE_BYTES } from "./validation";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COMPLETION_RECOVERY_AFTER_MS = 60 * 1000;
const PRESIGN_TTL_SECONDS = 300;

type UploadActor = { readonly userId: string; readonly workspaceId: string };

export class UploadServiceError extends Error {
  readonly code:
    | "UPLOAD_SESSION_NOT_FOUND"
    | "UPLOAD_SESSION_EXPIRED"
    | "UPLOAD_STATE_CONFLICT"
    | "UPLOAD_PART_CONFLICT"
    | "UPLOAD_COMPLETION_IN_PROGRESS"
    | "IDEMPOTENCY_KEY_REUSED"
    | "UPLOAD_INTEGRITY_ERROR"
    | "LINKED_RECORDING_NOT_FOUND";
  readonly status: number;

  constructor(
    code: UploadServiceError["code"],
    status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadServiceError";
    this.code = code;
    this.status = status;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function completionRequestHash(parts: readonly BrowserCompletedPart[]): string {
  const canonical = [...parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map((part) => [part.partNumber, part.etag, part.checksumSha256]);
  return digest(JSON.stringify(canonical));
}

function uploadReference(session: { objectKey: string; s3UploadId: string }) {
  return {
    objectKey: assertManagedMediaObjectKey(session.objectKey),
    uploadId: multipartUploadId(session.s3UploadId),
  };
}

export async function initiateSourceUpload(
  actor: UploadActor,
  input: {
    title: string;
    contentType: string;
    sizeBytes: number;
    linkedRecordingId?: string | undefined;
  },
  storage: MultipartObjectStorage = uploadStorage(),
) {
  if (input.linkedRecordingId) {
    const [linked] = await db()
      .select({ id: recordings.id })
      .from(recordings)
      .where(
        and(
          eq(recordings.id, input.linkedRecordingId),
          eq(recordings.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!linked)
      throw new UploadServiceError(
        "LINKED_RECORDING_NOT_FOUND",
        404,
        "Linked recording not found in this workspace",
      );
  }
  const plan = createUploadPlan({
    partSizeBytes: UPLOAD_PART_SIZE_BYTES,
    maxUploadBytes: input.sizeBytes,
  });
  const workspace = workspaceId(actor.workspaceId);
  const recording = recordingId(randomUUID());
  const session = uploadSessionId(randomUUID());
  const mediaType = sourceMediaType(input.contentType);
  const objectKey = buildSourceMediaObjectKey({
    workspaceId: workspace,
    recordingId: recording,
    uploadSessionId: session,
    mediaType,
  });
  const created = await storage.createSourceMultipartUpload({
    objectKey,
    workspaceId: workspace,
    recordingId: recording,
    uploadSessionId: session,
    mediaType,
  });
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  try {
    await db().transaction(async (transaction) => {
      await transaction.insert(recordings).values({
        id: recording,
        workspaceId: actor.workspaceId,
        ownerId: actor.userId,
        title: input.title,
        sourceObjectKey: objectKey,
        contentType: mediaType,
        ...(input.linkedRecordingId
          ? { linkedRecordingId: input.linkedRecordingId }
          : {}),
      });
      await transaction.insert(uploadSessions).values({
        id: session,
        workspaceId: actor.workspaceId,
        recordingId: recording,
        s3UploadId: created.uploadId,
        objectKey,
        contentType: mediaType,
        partSizeBytes: plan.partSizeBytes,
        expectedSizeBytes: plan.maxUploadBytes,
        maxPartCount: plan.maxPartCount,
        expiresAt,
      });
    });
  } catch (error) {
    await storage
      .abortMultipartUpload({ objectKey, uploadId: created.uploadId })
      .catch(() => undefined);
    throw error;
  }

  return {
    recordingId: recording,
    sessionId: session,
    partSizeBytes: plan.partSizeBytes,
    maxUploadBytes: plan.maxUploadBytes,
    maxPartCount: plan.maxPartCount,
    expiresAt: expiresAt.toISOString(),
  };
}

async function expireIfNecessary(
  actor: UploadActor,
  sessionIdValue: string,
  storage: MultipartObjectStorage,
): Promise<void> {
  const now = new Date();
  const [expired] = await db()
    .update(uploadSessions)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(
      and(
        eq(uploadSessions.id, sessionIdValue),
        eq(uploadSessions.workspaceId, actor.workspaceId),
        inArray(uploadSessions.status, ["PENDING", "UPLOADING"]),
        lt(uploadSessions.expiresAt, now),
      ),
    )
    .returning();
  if (expired) {
    await storage.abortMultipartUpload(uploadReference(expired));
    throw new UploadServiceError(
      "UPLOAD_SESSION_EXPIRED",
      410,
      "Upload session expired",
    );
  }
}

export async function signSourceUploadPart(
  actor: UploadActor,
  sessionIdValue: string,
  partNumber: number,
  input: {
    contentLength: number;
    checksumSha256: string;
    isFinalPart: boolean;
  },
  storage: MultipartObjectStorage = uploadStorage(),
) {
  await expireIfNecessary(actor, sessionIdValue, storage);
  const signedContext = await db().transaction(async (transaction) => {
    const [session] = await transaction
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, sessionIdValue),
          eq(uploadSessions.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    if (!session) {
      throw new UploadServiceError(
        "UPLOAD_SESSION_NOT_FOUND",
        404,
        "Upload session not found",
      );
    }
    if (session.status !== "PENDING" && session.status !== "UPLOADING") {
      throw new UploadServiceError(
        "UPLOAD_STATE_CONFLICT",
        409,
        "Upload is not accepting parts",
      );
    }

    const plan = createUploadPlan({
      partSizeBytes: session.partSizeBytes,
      maxUploadBytes: session.expectedSizeBytes,
    });
    if (session.maxPartCount !== plan.maxPartCount) {
      throw new UploadServiceError(
        "UPLOAD_INTEGRITY_ERROR",
        500,
        "Persisted upload plan is invalid",
      );
    }
    const intent = validateUploadPartIntent(plan, {
      partNumber,
      contentLength: input.contentLength,
      checksumSha256: sha256Base64(input.checksumSha256),
      isFinalPart: input.isFinalPart,
    });
    const expectedFinal = partNumber === plan.maxPartCount;
    const expectedLength = expectedFinal
      ? session.expectedSizeBytes - (partNumber - 1) * session.partSizeBytes
      : session.partSizeBytes;
    if (
      intent.isFinalPart !== expectedFinal ||
      intent.contentLength !== expectedLength
    ) {
      throw new UploadServiceError(
        "UPLOAD_PART_CONFLICT",
        409,
        "Part does not match the server-issued upload plan",
      );
    }

    const intents = await transaction
      .select()
      .from(uploadPartIntents)
      .where(eq(uploadPartIntents.uploadSessionId, session.id))
      .orderBy(asc(uploadPartIntents.partNumber));
    const existing = intents.find(
      (candidate) => candidate.partNumber === partNumber,
    );
    if (existing) {
      if (
        existing.contentLength !== intent.contentLength ||
        existing.checksumSha256 !== intent.checksumSha256 ||
        existing.isFinalPart !== intent.isFinalPart
      ) {
        throw new UploadServiceError(
          "UPLOAD_PART_CONFLICT",
          409,
          "A different intent already exists for this part",
        );
      }
    } else {
      if (
        intents.some((candidate) => candidate.isFinalPart) ||
        partNumber !== intents.length + 1
      ) {
        throw new UploadServiceError(
          "UPLOAD_PART_CONFLICT",
          409,
          "New parts must be signed sequentially and never after the final part",
        );
      }
      await transaction.insert(uploadPartIntents).values({
        uploadSessionId: session.id,
        partNumber: intent.partNumber,
        contentLength: intent.contentLength,
        checksumSha256: intent.checksumSha256,
        isFinalPart: intent.isFinalPart,
      });
      if (session.status === "PENDING") {
        await transaction
          .update(uploadSessions)
          .set({ status: "UPLOADING", updatedAt: new Date() })
          .where(
            and(
              eq(uploadSessions.id, session.id),
              eq(uploadSessions.status, "PENDING"),
            ),
          );
      }
    }
    return { session, intent };
  });

  const signed = await storage.presignUploadPart({
    ...uploadReference(signedContext.session),
    partNumber: signedContext.intent.partNumber,
    contentLength: signedContext.intent.contentLength,
    checksumSha256: signedContext.intent.checksumSha256,
    expiresInSeconds: PRESIGN_TTL_SECONDS,
  });
  return {
    url: signed.url,
    method: signed.method,
    expiresAt: signed.expiresAt.toISOString(),
    requiredHeaders: signed.requiredHeaders,
  };
}

function assertStoredObject(
  object: Awaited<ReturnType<MultipartObjectStorage["headSourceObject"]>>,
  session: { expectedSizeBytes: number; contentType: string },
): void {
  // On AWS the object must carry the key we authorized the upload under; on a
  // store without KMS there is no per-object key to compare and both are unset.
  if (
    object.contentLength !== session.expectedSizeBytes ||
    object.contentType !== session.contentType ||
    (object.kmsKeyId ?? undefined) !==
      (process.env.AWS_KMS_KEY_ARN ?? undefined)
  ) {
    throw new UploadServiceError(
      "UPLOAD_INTEGRITY_ERROR",
      409,
      "Stored source object does not match the authorized upload",
    );
  }
}

export async function completeSourceUpload(
  actor: UploadActor,
  sessionIdValue: string,
  idempotencyKey: string,
  browserParts: readonly BrowserCompletedPart[],
  storage: MultipartObjectStorage = uploadStorage(),
) {
  await expireIfNecessary(actor, sessionIdValue, storage);
  const keyHash = digest(idempotencyKey);
  const requestHash = completionRequestHash(browserParts);
  const [initial] = await db()
    .select()
    .from(uploadSessions)
    .where(
      and(
        eq(uploadSessions.id, sessionIdValue),
        eq(uploadSessions.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (!initial) {
    throw new UploadServiceError(
      "UPLOAD_SESSION_NOT_FOUND",
      404,
      "Upload session not found",
    );
  }
  if (initial.status === "COMPLETED") {
    if (
      initial.completionIdempotencyKeyHash !== keyHash ||
      initial.completionRequestHash !== requestHash ||
      !initial.completionResult
    ) {
      throw new UploadServiceError(
        "IDEMPOTENCY_KEY_REUSED",
        409,
        "Idempotency key or request does not match the completed upload",
      );
    }
    return initial.completionResult;
  }
  if (initial.status !== "UPLOADING" && initial.status !== "COMPLETING") {
    throw new UploadServiceError(
      "UPLOAD_STATE_CONFLICT",
      409,
      "Upload cannot be completed",
    );
  }
  if (
    initial.status === "COMPLETING" &&
    (initial.completionIdempotencyKeyHash !== keyHash ||
      initial.completionRequestHash !== requestHash)
  ) {
    throw new UploadServiceError(
      "IDEMPOTENCY_KEY_REUSED",
      409,
      "Completion retry does not match the original request",
    );
  }

  const intents = await db()
    .select()
    .from(uploadPartIntents)
    .where(eq(uploadPartIntents.uploadSessionId, initial.id))
    .orderBy(asc(uploadPartIntents.partNumber));
  const reference = uploadReference(initial);
  let storedObject = await storage.findSourceObject(reference.objectKey);
  if (storedObject && initial.status === "UPLOADING") {
    throw new UploadServiceError(
      "UPLOAD_INTEGRITY_ERROR",
      409,
      "A source object exists before completion was claimed",
    );
  }
  let verified;
  if (!storedObject) {
    const storedParts = await storage.listUploadedParts(reference);
    verified = reconcileCompletedParts({
      partSizeBytes: initial.partSizeBytes,
      expectedSizeBytes: initial.expectedSizeBytes,
      intents,
      browserParts,
      storedParts,
    });
  }

  const now = new Date();
  if (initial.status === "UPLOADING") {
    const [claimed] = await db()
      .update(uploadSessions)
      .set({
        status: "COMPLETING",
        completionIdempotencyKeyHash: keyHash,
        completionRequestHash: requestHash,
        completionStartedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(uploadSessions.id, initial.id),
          eq(uploadSessions.status, "UPLOADING"),
        ),
      )
      .returning();
    if (!claimed) {
      throw new UploadServiceError(
        "UPLOAD_COMPLETION_IN_PROGRESS",
        409,
        "Another request is completing this upload",
      );
    }
  } else {
    const recoveryBefore = new Date(
      now.getTime() - COMPLETION_RECOVERY_AFTER_MS,
    );
    const [recovered] = await db()
      .update(uploadSessions)
      .set({ completionStartedAt: now, updatedAt: now })
      .where(
        and(
          eq(uploadSessions.id, initial.id),
          eq(uploadSessions.status, "COMPLETING"),
          lt(uploadSessions.completionStartedAt, recoveryBefore),
        ),
      )
      .returning();
    if (!recovered) {
      throw new UploadServiceError(
        "UPLOAD_COMPLETION_IN_PROGRESS",
        409,
        "Upload completion is already in progress",
      );
    }
  }

  if (!storedObject) {
    if (!verified) {
      throw new UploadServiceError(
        "UPLOAD_INTEGRITY_ERROR",
        500,
        "Verified upload is missing",
      );
    }
    await storage.completeSourceMultipartUpload({
      ...reference,
      verifiedUpload: verified,
    });
    storedObject = await storage.headSourceObject(reference.objectKey);
  }
  assertStoredObject(storedObject, initial);

  const result = {
    recordingId: initial.recordingId,
    status: "PROCESSING" as const,
    sizeBytes: initial.expectedSizeBytes,
  };
  await db().transaction(async (transaction) => {
    const [completed] = await transaction
      .update(uploadSessions)
      .set({
        status: "COMPLETED",
        completionResult: result,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(uploadSessions.id, initial.id),
          eq(uploadSessions.status, "COMPLETING"),
        ),
      )
      .returning({ id: uploadSessions.id });
    if (!completed) {
      throw new UploadServiceError(
        "UPLOAD_STATE_CONFLICT",
        409,
        "Upload completion was superseded",
      );
    }
    const [updatedRecording] = await transaction
      .update(recordings)
      .set({
        status: "PROCESSING",
        sizeBytes: initial.expectedSizeBytes,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recordings.id, initial.recordingId),
          eq(recordings.workspaceId, initial.workspaceId),
          eq(recordings.status, "UPLOADING"),
        ),
      )
      .returning({ id: recordings.id });
    if (!updatedRecording) {
      throw new UploadServiceError(
        "UPLOAD_STATE_CONFLICT",
        409,
        "Recording was not in the expected upload state",
      );
    }
    await transaction.insert(processingOutbox).values({
      topic: "MEDIA_PROCESSING",
      aggregateId: initial.recordingId,
      payload: {
        recordingId: initial.recordingId,
        workspaceId: initial.workspaceId,
        sourceObjectKey: initial.objectKey,
        processingVersion: PROCESSING_VERSION,
      },
    });
  });
  return result;
}

export async function abortSourceUpload(
  actor: UploadActor,
  sessionIdValue: string,
  storage: MultipartObjectStorage = uploadStorage(),
): Promise<void> {
  const [session] = await db().transaction(async (transaction) => {
    const [current] = await transaction
      .select()
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.id, sessionIdValue),
          eq(uploadSessions.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) return [];
    if (current.status === "COMPLETED" || current.status === "COMPLETING") {
      throw new UploadServiceError(
        "UPLOAD_STATE_CONFLICT",
        409,
        "Upload cannot be aborted",
      );
    }
    if (current.status !== "ABORTED" && current.status !== "EXPIRED") {
      await transaction
        .update(uploadSessions)
        .set({ status: "ABORTED", updatedAt: new Date() })
        .where(eq(uploadSessions.id, current.id));
    }
    return [current];
  });
  if (!session) {
    throw new UploadServiceError(
      "UPLOAD_SESSION_NOT_FOUND",
      404,
      "Upload session not found",
    );
  }
  await storage.abortMultipartUpload(uploadReference(session));
}
