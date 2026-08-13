import { describe, expect, it } from "vitest";
import { parseServerEnvironment } from "./index";

describe("server storage environment", () => {
  it("normalizes empty provider-specific values for R2", () => {
    expect(
      parseServerEnvironment({
        AWS_REGION: " auto ",
        AWS_S3_BUCKET_NAME: " cap-production ",
        AWS_S3_ENDPOINT: " https://account.r2.cloudflarestorage.com ",
        AWS_KMS_KEY_ARN: "   ",
      }),
    ).toMatchObject({
      AWS_REGION: "auto",
      AWS_S3_BUCKET_NAME: "cap-production",
      AWS_S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      AWS_KMS_KEY_ARN: undefined,
    });
  });

  it("keeps an AWS KMS ARN when one is configured", () => {
    expect(
      parseServerEnvironment({
        AWS_S3_BUCKET_NAME: "cap-production",
        AWS_KMS_KEY_ARN:
          "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
      }).AWS_KMS_KEY_ARN,
    ).toContain("arn:aws:kms:");
  });
});
