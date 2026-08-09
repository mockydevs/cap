import { describe, expect, it } from "vitest";
import { recordingListSchema, recordingParamsSchema } from "./validation";

describe("recording API validation", () => {
  it("bounds pagination and coerces query strings", () => {
    expect(recordingListSchema.parse({ limit: "25" }).limit).toBe(25);
    expect(() => recordingListSchema.parse({ limit: "51" })).toThrow();
  });

  it("only accepts UUID recording identifiers", () => {
    expect(
      recordingParamsSchema.parse({
        recordingId: "c24d9ba8-ca43-4906-a459-6dd7a9b2f013",
      }).recordingId,
    ).toBe("c24d9ba8-ca43-4906-a459-6dd7a9b2f013");
    expect(() =>
      recordingParamsSchema.parse({ recordingId: "../other-workspace" }),
    ).toThrow();
  });
});
