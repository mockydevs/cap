import { describe, expect, it } from "vitest";
import {
  S3_MIN_MULTIPART_PART_BYTES,
  assertMultipartUploadTransition,
  createUploadPlan,
  s3EntityTag,
  sha256Base64,
  validateUploadPartIntent,
  verifyCompletedUpload,
} from "../src/index";

const checksum = sha256Base64("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");

describe("AWS multipart upload domain contract", () => {
  it("creates a bounded server upload plan", () => {
    expect(
      createUploadPlan({
        partSizeBytes: S3_MIN_MULTIPART_PART_BYTES,
        maxUploadBytes: S3_MIN_MULTIPART_PART_BYTES * 3,
      }),
    ).toEqual({
      partSizeBytes: S3_MIN_MULTIPART_PART_BYTES,
      maxUploadBytes: S3_MIN_MULTIPART_PART_BYTES * 3,
      maxPartCount: 3,
    });
  });

  it("rejects a short non-final part", () => {
    const plan = createUploadPlan({
      partSizeBytes: S3_MIN_MULTIPART_PART_BYTES,
      maxUploadBytes: S3_MIN_MULTIPART_PART_BYTES * 2,
    });
    expect(() =>
      validateUploadPartIntent(plan, {
        partNumber: 1,
        contentLength: 100,
        checksumSha256: checksum,
        isFinalPart: false,
      }),
    ).toThrow("Every non-final part");
  });

  it("accepts a smaller final part and computes total bytes", () => {
    const plan = createUploadPlan({
      partSizeBytes: S3_MIN_MULTIPART_PART_BYTES,
      maxUploadBytes: S3_MIN_MULTIPART_PART_BYTES * 2,
    });
    const result = verifyCompletedUpload(plan, [
      {
        partNumber: 1,
        contentLength: S3_MIN_MULTIPART_PART_BYTES,
        checksumSha256: checksum,
        etag: s3EntityTag('"first"'),
      },
      {
        partNumber: 2,
        contentLength: 123,
        checksumSha256: checksum,
        etag: s3EntityTag('"second"'),
      },
    ]);
    expect(result.totalBytes).toBe(S3_MIN_MULTIPART_PART_BYTES + 123);
  });

  it("rejects reordered, duplicated, or missing parts", () => {
    const plan = createUploadPlan({
      partSizeBytes: S3_MIN_MULTIPART_PART_BYTES,
      maxUploadBytes: S3_MIN_MULTIPART_PART_BYTES * 2,
    });
    expect(() =>
      verifyCompletedUpload(plan, [
        {
          partNumber: 2,
          contentLength: 10,
          checksumSha256: checksum,
          etag: s3EntityTag('"etag"'),
        },
      ]),
    ).toThrow("contiguous");
  });

  it("keeps terminal states closed", () => {
    expect(() => assertMultipartUploadTransition("COMPLETED", "UPLOADING")).toThrow(
      "Cannot transition",
    );
    expect(() => assertMultipartUploadTransition("UPLOADING", "COMPLETING")).not.toThrow();
  });
});
