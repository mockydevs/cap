import { createHash, randomUUID } from "node:crypto";
import { recordingId, workspaceId } from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  buildTranscriptCaptionObjectKey,
} from "@cap/storage";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db/client";
import { users, workspaceMembers, workspaces } from "../../db/schema";
import {
  completeSourceUpload,
  initiateSourceUpload,
  reportSourceUploadProgress,
  signSourceUploadPart,
} from "../../lib/uploads/service";
import { uploadStorage } from "../../lib/uploads/storage";
import { UPLOAD_PART_SIZE_BYTES } from "../../lib/uploads/validation";

describe("small object storage against LocalStack", () => {
  let workspace: ReturnType<typeof workspaceId>;
  let recording: ReturnType<typeof recordingId>;

  beforeAll(() => {
    workspace = workspaceId(`ws_${randomUUID().replaceAll("-", "")}`);
    recording = recordingId(`rec_${randomUUID().replaceAll("-", "")}`);
  });

  it("round-trips a small text object", async () => {
    const objectKey = buildTranscriptCaptionObjectKey({
      workspaceId: workspace,
      recordingId: recording,
      language: "es",
      extension: "vtt",
    });
    await uploadStorage().putTextObject({
      objectKey,
      content: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhola\n",
      contentType: "text/vtt; charset=utf-8",
    });
    const fetched = await uploadStorage().getTextObject(objectKey);
    expect(fetched).toContain("hola");
  });

  it("returns undefined for a missing object", async () => {
    const objectKey = assertManagedMediaObjectKey(
      `workspaces/${workspace}/recordings/${recording}/transcripts/missing.vtt`,
    );
    expect(await uploadStorage().getTextObject(objectKey)).toBeUndefined();
  });
});

describe("resumable multipart upload against LocalStack", () => {
  let actor: { userId: string; workspaceId: string };

  beforeAll(async () => {
    const workspaceRow = {
      id: randomUUID(),
      name: "Integration Test Workspace",
    };
    const userRow = {
      id: randomUUID(),
      email: `integration-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: "Integration Test User",
    };
    await db().insert(workspaces).values(workspaceRow);
    await db().insert(users).values(userRow);
    await db().insert(workspaceMembers).values({
      workspaceId: workspaceRow.id,
      userId: userRow.id,
      role: "OWNER",
    });
    actor = { userId: userRow.id, workspaceId: workspaceRow.id };
  });

  it("initiates, signs, uploads, and completes a single-part upload", async () => {
    const partBody = Buffer.from("integration-test-part-body-bytes");
    const initiated = await initiateSourceUpload(actor, {
      title: "Integration test recording",
      contentType: "video/webm",
      sizeBytes: partBody.byteLength,
    });
    expect(initiated.maxPartCount).toBe(1);

    const checksumSha256 = createHash("sha256")
      .update(partBody)
      .digest("base64");
    const signed = await signSourceUploadPart(actor, initiated.sessionId, 1, {
      contentLength: partBody.byteLength,
      checksumSha256,
      isFinalPart: true,
    });

    const response = await fetch(signed.url, {
      method: signed.method,
      body: partBody,
      headers: signed.requiredHeaders,
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("LocalStack did not return an ETag");

    const result = await completeSourceUpload(
      actor,
      initiated.sessionId,
      randomUUID(),
      [{ partNumber: 1, etag, checksumSha256 }],
    );
    expect(result).toMatchObject({ recordingId: initiated.recordingId });
  });

  it("seals a streaming upload to the final recorder byte size", async () => {
    const partBody = Buffer.from("live-recorder-tail");
    const initiated = await initiateSourceUpload(actor, {
      title: "Live integration recording",
      contentType: "video/mp4",
      streaming: true,
    });
    expect(initiated.maxUploadBytes).toBeGreaterThan(partBody.byteLength);

    const checksumSha256 = createHash("sha256")
      .update(partBody)
      .digest("base64");
    const signed = await signSourceUploadPart(actor, initiated.sessionId, 1, {
      contentLength: partBody.byteLength,
      checksumSha256,
      isFinalPart: true,
    });
    const response = await fetch(signed.url, {
      method: signed.method,
      body: partBody,
      headers: signed.requiredHeaders,
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("LocalStack did not return an ETag");

    const result = await completeSourceUpload(
      actor,
      initiated.sessionId,
      randomUUID(),
      [{ partNumber: 1, etag, checksumSha256 }],
    );
    expect(result).toMatchObject({
      recordingId: initiated.recordingId,
      sizeBytes: partBody.byteLength,
    });
  });

  it("seals an exact full streaming part that was uploaded before stop", async () => {
    const partBody = Buffer.alloc(UPLOAD_PART_SIZE_BYTES, 120);
    const initiated = await initiateSourceUpload(actor, {
      title: "Exact multipart boundary",
      contentType: "video/webm",
      streaming: true,
    });
    const checksumSha256 = createHash("sha256")
      .update(partBody)
      .digest("base64");
    const signed = await signSourceUploadPart(actor, initiated.sessionId, 1, {
      contentLength: partBody.byteLength,
      checksumSha256,
      isFinalPart: false,
    });
    const response = await fetch(signed.url, {
      method: signed.method,
      body: partBody,
      headers: signed.requiredHeaders,
    });
    expect(response.ok).toBe(true);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("LocalStack did not return an ETag");

    await reportSourceUploadProgress(actor, initiated.sessionId, {
      recordedBytes: partBody.byteLength,
      sealed: true,
    });
    const result = await completeSourceUpload(
      actor,
      initiated.sessionId,
      randomUUID(),
      [{ partNumber: 1, etag, checksumSha256 }],
    );
    expect(result.sizeBytes).toBe(partBody.byteLength);
  });
});
