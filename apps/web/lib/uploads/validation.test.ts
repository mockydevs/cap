import { describe, expect, it } from "vitest";
import { s3EntityTag, sha256Base64 } from "@cap/domain";
import { reconcileCompletedParts } from "./reconcile";
import {
  completeUploadSchema,
  createUploadSchema,
  signPartSchema,
  UPLOAD_PART_SIZE_BYTES,
} from "./validation";

const checksum = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("multipart upload validation", () => {
  it("accepts supported browser media and a bounded source size", () => {
    expect(
      createUploadSchema.parse({
        title: "Demo",
        contentType: "video/webm",
        sizeBytes: UPLOAD_PART_SIZE_BYTES,
      }),
    ).toMatchObject({ title: "Demo" });
  });

  it("accepts an optional linkedRecordingId for a camera recording", () => {
    const linkedRecordingId = "11111111-1111-1111-1111-111111111111";
    expect(
      createUploadSchema.parse({
        title: "Camera",
        contentType: "video/webm",
        sizeBytes: UPLOAD_PART_SIZE_BYTES,
        linkedRecordingId,
      }),
    ).toMatchObject({ linkedRecordingId });
    expect(() =>
      createUploadSchema.parse({
        title: "Camera",
        contentType: "video/webm",
        sizeBytes: UPLOAD_PART_SIZE_BYTES,
        linkedRecordingId: "not-a-uuid",
      }),
    ).toThrow();
  });

  it("requires a valid checksum on every signing intent", () => {
    expect(() =>
      signPartSchema.parse({
        contentLength: 100,
        checksumSha256: "not-a-digest",
        isFinalPart: true,
      }),
    ).toThrow();
  });

  it("rejects duplicate completion parts", () => {
    expect(() =>
      completeUploadSchema.parse({
        parts: [
          { partNumber: 1, etag: '"one"', checksumSha256: checksum },
          { partNumber: 1, etag: '"two"', checksumSha256: checksum },
        ],
      }),
    ).toThrow();
  });
});

describe("multipart completion reconciliation", () => {
  it("accepts only matching persisted, browser, and S3 manifests", () => {
    const result = reconcileCompletedParts({
      partSizeBytes: UPLOAD_PART_SIZE_BYTES,
      expectedSizeBytes: UPLOAD_PART_SIZE_BYTES + 100,
      intents: [
        {
          partNumber: 1,
          contentLength: UPLOAD_PART_SIZE_BYTES,
          checksumSha256: checksum,
          isFinalPart: false,
        },
        {
          partNumber: 2,
          contentLength: 100,
          checksumSha256: checksum,
          isFinalPart: true,
        },
      ],
      browserParts: [
        { partNumber: 1, etag: '"one"', checksumSha256: checksum },
        { partNumber: 2, etag: '"two"', checksumSha256: checksum },
      ],
      storedParts: [
        {
          partNumber: 1,
          contentLength: UPLOAD_PART_SIZE_BYTES,
          etag: s3EntityTag('"one"'),
          checksumSha256: sha256Base64(checksum),
        },
        {
          partNumber: 2,
          contentLength: 100,
          etag: s3EntityTag('"two"'),
          checksumSha256: sha256Base64(checksum),
        },
      ],
    });
    expect(result.totalBytes).toBe(UPLOAD_PART_SIZE_BYTES + 100);
  });

  it("rejects a browser receipt that differs from S3", () => {
    expect(() =>
      reconcileCompletedParts({
        partSizeBytes: UPLOAD_PART_SIZE_BYTES,
        expectedSizeBytes: 100,
        intents: [
          {
            partNumber: 1,
            contentLength: 100,
            checksumSha256: checksum,
            isFinalPart: true,
          },
        ],
        browserParts: [
          { partNumber: 1, etag: '"browser"', checksumSha256: checksum },
        ],
        storedParts: [
          {
            partNumber: 1,
            contentLength: 100,
            etag: s3EntityTag('"s3"'),
            checksumSha256: sha256Base64(checksum),
          },
        ],
      }),
    ).toThrow("do not match");
  });

  it("accepts R2 part metadata when the provider omits SHA-256", () => {
    const result = reconcileCompletedParts({
      partSizeBytes: UPLOAD_PART_SIZE_BYTES,
      expectedSizeBytes: 100,
      intents: [
        {
          partNumber: 1,
          contentLength: 100,
          checksumSha256: checksum,
          isFinalPart: true,
        },
      ],
      browserParts: [{ partNumber: 1, etag: '"r2"', checksumSha256: checksum }],
      storedParts: [
        {
          partNumber: 1,
          contentLength: 100,
          etag: s3EntityTag('"r2"'),
        },
      ],
    });

    expect(result.parts[0]?.checksumSha256).toBe(checksum);
  });
});
