import { describe, expect, it } from "vitest";
import { completeUploadSchema, createUploadSchema, UPLOAD_PART_SIZE_BYTES } from "./validation";

describe("multipart upload validation", () => {
  it("accepts supported browser media and a bounded source size", () => {
    expect(createUploadSchema.parse({ title: "Demo", contentType: "video/webm", sizeBytes: UPLOAD_PART_SIZE_BYTES })).toMatchObject({ title: "Demo" });
  });

  it("rejects duplicate completion parts", () => {
    expect(() => completeUploadSchema.parse({ parts: [{ partNumber: 1, etag: "one" }, { partNumber: 1, etag: "two" }] })).toThrow();
  });
});
