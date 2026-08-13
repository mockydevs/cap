import { describe, expect, it } from "vitest";
import {
  isMissingObjectError,
  multipartSha256ChecksumsEnabled,
  storageBucketUrl,
  storageClientConfig,
  storageKmsKeyArn,
  storageWriteEncryption,
} from "../src/index";

describe("S3-compatible provider configuration", () => {
  it("uses path-style addressing and required-only checksums for R2", () => {
    expect(
      storageClientConfig({
        AWS_REGION: " auto ",
        AWS_S3_ENDPOINT: " https://account.r2.cloudflarestorage.com/ ",
      }),
    ).toMatchObject({
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com/",
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  });

  it("keeps AWS S3 on the SDK's standard addressing", () => {
    expect(storageClientConfig({ AWS_REGION: "eu-west-1" })).toEqual({
      region: "eu-west-1",
    });
  });

  it("disables per-part SHA-256 only for Cloudflare R2 endpoints", () => {
    expect(
      multipartSha256ChecksumsEnabled({
        AWS_S3_ENDPOINT: "https://account.eu.r2.cloudflarestorage.com",
      }),
    ).toBe(false);
    expect(
      multipartSha256ChecksumsEnabled({
        AWS_S3_ENDPOINT: "https://minio.example.com",
      }),
    ).toBe(true);
    expect(multipartSha256ChecksumsEnabled({})).toBe(true);
  });

  it("builds provider-specific preflight URLs", () => {
    expect(
      storageBucketUrl("cap-production", {
        AWS_REGION: "auto",
        AWS_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com/",
      }),
    ).toBe("https://account.r2.cloudflarestorage.com/cap-production/");
    expect(
      storageBucketUrl("cap-production", { AWS_REGION: "eu-west-1" }),
    ).toBe("https://cap-production.s3.eu-west-1.amazonaws.com/");
  });

  it("treats a blank KMS value as disabled", () => {
    expect(storageKmsKeyArn({ AWS_KMS_KEY_ARN: "   " })).toBeUndefined();
    expect(storageKmsKeyArn({ AWS_KMS_KEY_ARN: " arn:aws:kms:key " })).toBe(
      "arn:aws:kms:key",
    );
    expect(storageWriteEncryption({ AWS_KMS_KEY_ARN: "" })).toEqual({});
    expect(
      storageWriteEncryption({ AWS_KMS_KEY_ARN: "arn:aws:kms:key" }),
    ).toEqual({
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: "arn:aws:kms:key",
      BucketKeyEnabled: true,
    });
  });
});

describe("object existence errors", () => {
  it("recognizes explicit not-found responses", () => {
    expect(isMissingObjectError({ name: "NotFound" })).toBe(true);
    expect(
      isMissingObjectError({ name: "S3ServiceException", Code: "NoSuchKey" }),
    ).toBe(true);
    expect(isMissingObjectError({ $metadata: { httpStatusCode: 404 } })).toBe(
      true,
    );
  });

  it("does not turn access or transport failures into missing objects", () => {
    expect(isMissingObjectError({ name: "AccessDenied" })).toBe(false);
    expect(isMissingObjectError(new Error("socket closed"))).toBe(false);
  });
});
