import { describe, expect, it } from "vitest";
import {
  mediaProcessingJobId,
  mediaProcessingJobOptions,
  mediaProcessingJobSchema,
} from "../src/index";

describe("media processing job contract", () => {
  it("has a stable idempotency key", () => {
    expect(
      mediaProcessingJobId("c24d9ba8-ca43-4906-a459-6dd7a9b2f013", 1),
    ).toBe("recording:c24d9ba8-ca43-4906-a459-6dd7a9b2f013:v1");
    expect(
      mediaProcessingJobOptions("c24d9ba8-ca43-4906-a459-6dd7a9b2f013", 2)
        .attempts,
    ).toBe(4);
  });

  it("rejects malformed jobs before worker execution", () => {
    expect(() =>
      mediaProcessingJobSchema.parse({
        recordingId: "bad",
        workspaceId: "bad",
        sourceObjectKey: "",
        processingVersion: 0,
      }),
    ).toThrow();
  });
});
