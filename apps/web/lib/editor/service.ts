import { createHash, randomUUID } from "node:crypto";
import {
  assertExecutableRenderManifest,
  compileRenderManifest,
  initializeEditorDocument,
  stableSerializeRenderManifest,
  validateEditDocument,
  type EditorDocumentV2,
} from "@cap/editor-domain";
import {
  createRedisConnection,
  createRenderQueue,
  renderJobOptions,
} from "@cap/queue";
import { and, desc, eq, ne, or } from "drizzle-orm";
import { db } from "../../db/client";
import {
  editorProjects,
  editorRevisions,
  recordingAssets,
  recordings,
  renderJobs,
} from "../../db/schema";
import type { Actor } from "../auth/session";
import { approvedCaptionCues } from "../transcripts/service";
import { uploadStorage } from "../uploads/storage";

const PLAYBACK_URL_TTL_SECONDS = 120;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export class EditorError extends Error {
  constructor(
    readonly code:
      | "EDITOR_NOT_FOUND"
      | "EDITOR_SOURCE_NOT_READY"
      | "EDITOR_CONFLICT"
      | "RENDER_NOT_FOUND"
      | "RENDER_NOT_READY"
      | "RENDER_QUEUE_NOT_CONFIGURED",
    readonly status: number,
  ) {
    super(code);
  }
}

export type EditorSnapshot = {
  projectId: string;
  revision: number;
  document: EditorDocumentV2;
};

/**
 * Recordings linked to this one (e.g. a camera recording captured alongside
 * a screen recording, in either direction) that are ready to attach to the
 * editor's sourceAssetIds via the ADD_SOURCE_ASSET command.
 */
export async function listLinkedRecordingAssets(
  recordingId: string,
  actor: Pick<Actor, "workspaceId">,
) {
  const [primary] = await db()
    .select({ linkedRecordingId: recordings.linkedRecordingId })
    .from(recordings)
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (!primary) throw new EditorError("EDITOR_NOT_FOUND", 404);

  const candidates = [
    eq(recordings.linkedRecordingId, recordingId),
    ...(primary.linkedRecordingId
      ? [eq(recordings.id, primary.linkedRecordingId)]
      : []),
  ];
  return db()
    .select({
      recordingId: recordings.id,
      title: recordings.title,
      sourceAssetId: recordingAssets.id,
      durationMs: recordings.durationMs,
      width: recordings.width,
      height: recordings.height,
    })
    .from(recordings)
    .innerJoin(recordingAssets, eq(recordingAssets.recordingId, recordings.id))
    .where(
      and(
        eq(recordings.workspaceId, actor.workspaceId),
        ne(recordings.id, recordingId),
        eq(recordings.status, "READY"),
        eq(recordingAssets.kind, "MP4"),
        or(...candidates),
      ),
    )
    // A linked recording that's been reprocessed more than once returns one
    // row per processing version, newest first — fine for the tiny result
    // set this produces (there are rarely more than one or two linked
    // recordings), but callers should take the first match per recordingId.
    .orderBy(desc(recordingAssets.processingVersion));
}

export async function loadEditor(
  recordingId: string,
  actor: Actor,
): Promise<EditorSnapshot> {
  const [project] = await db()
    .select()
    .from(editorProjects)
    .where(
      and(
        eq(editorProjects.recordingId, recordingId),
        eq(editorProjects.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (project) {
    const [revision] = await db()
      .select()
      .from(editorRevisions)
      .where(
        and(
          eq(editorRevisions.projectId, project.id),
          eq(editorRevisions.revision, project.currentRevision),
          eq(editorRevisions.workspaceId, actor.workspaceId),
        ),
      )
      .limit(1);
    if (!revision) throw new EditorError("EDITOR_NOT_FOUND", 404);
    return {
      projectId: project.id,
      revision: project.currentRevision,
      document: validateEditDocument(revision.document),
    };
  }

  const [source] = await db()
    .select({
      id: recordingAssets.id,
      durationMs: recordings.durationMs,
      width: recordings.width,
      height: recordings.height,
      status: recordings.status,
    })
    .from(recordings)
    .innerJoin(recordingAssets, eq(recordingAssets.recordingId, recordings.id))
    .where(
      and(
        eq(recordings.id, recordingId),
        eq(recordings.workspaceId, actor.workspaceId),
        eq(recordingAssets.kind, "MP4"),
      ),
    )
    .orderBy(desc(recordingAssets.processingVersion))
    .limit(1);
  if (
    !source ||
    source.status !== "READY" ||
    !source.durationMs ||
    !source.width ||
    !source.height
  ) {
    throw new EditorError("EDITOR_SOURCE_NOT_READY", 409);
  }
  const document = initializeEditorDocument({
    status: "READY",
    recordingId,
    sourceAssetId: source.id,
    durationMs: source.durationMs,
    width: source.width,
    height: source.height,
  });
  const projectId = randomUUID();
  const documentHash = digest(JSON.stringify(document));
  await db().transaction(async (transaction) => {
    await transaction.insert(editorProjects).values({
      id: projectId,
      workspaceId: actor.workspaceId,
      recordingId,
      name: "Untitled edit",
      schemaVersion: 2,
      currentRevision: 0,
      createdBy: actor.userId,
    });
    await transaction.insert(editorRevisions).values({
      projectId,
      workspaceId: actor.workspaceId,
      revision: 0,
      schemaVersion: 2,
      document,
      documentHash,
      createdBy: actor.userId,
    });
  });
  return { projectId, revision: 0, document };
}

export async function saveEditor(
  projectId: string,
  actor: Actor,
  expectedRevision: number,
  value: unknown,
): Promise<EditorSnapshot> {
  const document = validateEditDocument(value);
  const documentHash = digest(JSON.stringify(document));
  return db().transaction(async (transaction) => {
    const [project] = await transaction
      .update(editorProjects)
      .set({
        currentRevision: expectedRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(editorProjects.id, projectId),
          eq(editorProjects.workspaceId, actor.workspaceId),
          eq(editorProjects.currentRevision, expectedRevision),
        ),
      )
      .returning({
        id: editorProjects.id,
        currentRevision: editorProjects.currentRevision,
      });
    if (!project) throw new EditorError("EDITOR_CONFLICT", 409);
    await transaction.insert(editorRevisions).values({
      projectId: project.id,
      workspaceId: actor.workspaceId,
      revision: project.currentRevision,
      schemaVersion: 2,
      document,
      documentHash,
      createdBy: actor.userId,
    });
    return {
      projectId: project.id,
      revision: project.currentRevision,
      document,
    };
  });
}

export async function listEditorRevisions(projectId: string, actor: Actor) {
  const project = await projectForWorkspace(projectId, actor.workspaceId);
  const revisions = await db()
    .select({
      revision: editorRevisions.revision,
      documentHash: editorRevisions.documentHash,
      createdAt: editorRevisions.createdAt,
      createdBy: editorRevisions.createdBy,
    })
    .from(editorRevisions)
    .where(
      and(
        eq(editorRevisions.projectId, project.id),
        eq(editorRevisions.workspaceId, actor.workspaceId),
      ),
    )
    .orderBy(desc(editorRevisions.revision));
  return {
    projectId: project.id,
    currentRevision: project.currentRevision,
    revisions: revisions.map((revision) => ({
      ...revision,
      createdAt: revision.createdAt.toISOString(),
    })),
  };
}

async function projectForWorkspace(projectId: string, workspaceId: string) {
  const [project] = await db()
    .select()
    .from(editorProjects)
    .where(
      and(
        eq(editorProjects.id, projectId),
        eq(editorProjects.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!project) throw new EditorError("EDITOR_NOT_FOUND", 404);
  return project;
}

export async function requestRender(projectId: string, actor: Actor) {
  const project = await projectForWorkspace(projectId, actor.workspaceId);
  const [revision] = await db()
    .select()
    .from(editorRevisions)
    .where(
      and(
        eq(editorRevisions.projectId, project.id),
        eq(editorRevisions.revision, project.currentRevision),
      ),
    )
    .limit(1);
  if (!revision) throw new EditorError("EDITOR_NOT_FOUND", 404);
  const document = validateEditDocument(revision.document);
  const captionCues = document.captionStyle.burnIn
    ? await approvedCaptionCues(project.recordingId, actor.workspaceId)
    : [];
  const manifest = compileRenderManifest(document, captionCues);
  assertExecutableRenderManifest(manifest);
  const manifestHash = digest(stableSerializeRenderManifest(manifest));
  if (!process.env.REDIS_URL)
    throw new EditorError("RENDER_QUEUE_NOT_CONFIGURED", 503);
  const [job] = await db()
    .insert(renderJobs)
    .values({
      id: randomUUID(),
      workspaceId: actor.workspaceId,
      projectId: project.id,
      revision: revision.revision,
      status: "QUEUED",
      manifest,
      manifestHash,
      requestedBy: actor.userId,
    })
    .onConflictDoNothing({
      target: [renderJobs.projectId, renderJobs.revision],
    })
    .returning();
  const render =
    job ??
    (
      await db()
        .select()
        .from(renderJobs)
        .where(
          and(
            eq(renderJobs.projectId, project.id),
            eq(renderJobs.revision, revision.revision),
          ),
        )
        .limit(1)
    )[0];
  if (!render) throw new EditorError("EDITOR_NOT_FOUND", 404);

  if (render.status === "QUEUED")
    await enqueueRender(
      render.id,
      actor.workspaceId,
      project.id,
      revision.revision,
    );
  return serializeRender(render);
}

async function enqueueRender(
  renderJobId: string,
  workspaceId: string,
  projectId: string,
  revision: number,
) {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new EditorError("RENDER_QUEUE_NOT_CONFIGURED", 503);
  const connection = createRedisConnection(redisUrl);
  const queue = createRenderQueue(connection);
  try {
    await queue.add(
      "render",
      { renderJobId, workspaceId, projectId, revision },
      renderJobOptions(renderJobId),
    );
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

export async function loadRender(renderJobId: string, actor: Actor) {
  const [render] = await db()
    .select()
    .from(renderJobs)
    .where(
      and(
        eq(renderJobs.id, renderJobId),
        eq(renderJobs.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (!render) throw new EditorError("RENDER_NOT_FOUND", 404);
  return serializeRender(render);
}

export async function renderDownload(renderJobId: string, actor: Actor) {
  const [render] = await db()
    .select({
      status: renderJobs.status,
      outputObjectKey: recordingAssets.objectKey,
      contentType: recordingAssets.contentType,
      sizeBytes: recordingAssets.sizeBytes,
    })
    .from(renderJobs)
    .leftJoin(recordingAssets, eq(recordingAssets.id, renderJobs.outputAssetId))
    .where(
      and(
        eq(renderJobs.id, renderJobId),
        eq(renderJobs.workspaceId, actor.workspaceId),
      ),
    )
    .limit(1);
  if (!render) throw new EditorError("RENDER_NOT_FOUND", 404);
  if (render.status !== "COMPLETED" || !render.outputObjectKey)
    throw new EditorError("RENDER_NOT_READY", 409);
  const signed = await uploadStorage().presignPlayback({
    objectKey: render.outputObjectKey as never,
    expiresInSeconds: PLAYBACK_URL_TTL_SECONDS,
  });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    contentType: render.contentType,
    sizeBytes: render.sizeBytes,
  };
}

function serializeRender(render: typeof renderJobs.$inferSelect) {
  return {
    id: render.id,
    projectId: render.projectId,
    revision: render.revision,
    status: render.status,
    attempt: render.attempt,
    errorCategory: render.errorCategory,
    createdAt: render.createdAt.toISOString(),
    startedAt: render.startedAt?.toISOString() ?? null,
    completedAt: render.completedAt?.toISOString() ?? null,
    outputAssetId: render.outputAssetId,
  };
}
