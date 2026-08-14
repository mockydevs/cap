import { describe, expect, it } from "vitest";
import {
  recordingListSchema,
  recordingParamsSchema,
  recordingUpdateSchema,
} from "./validation";

describe("recording API validation", () => {
  it("bounds pagination and coerces query strings", () => {
    expect(recordingListSchema.parse({ limit: "25" }).limit).toBe(25);
    expect(() => recordingListSchema.parse({ limit: "51" })).toThrow();
  });

  it("accepts only supported library views", () => {
    expect(recordingListSchema.parse({}).view).toBe("library");
    expect(recordingListSchema.parse({ view: "starred" }).view).toBe("starred");
    expect(() => recordingListSchema.parse({ view: "everything" })).toThrow();
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

  it("normalizes recording titles and keeps them compact", () => {
    expect(recordingUpdateSchema.parse({ title: "  Launch review  " })).toEqual(
      { title: "Launch review" },
    );
    expect(() => recordingUpdateSchema.parse({ title: "   " })).toThrow();
    expect(() =>
      recordingUpdateSchema.parse({ title: "x".repeat(161) }),
    ).toThrow();
  });
});
