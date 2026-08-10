import { describe, expect, it } from "vitest";
import { updateRetentionPolicySchema } from "./validation";

describe("retention policy validation", () => {
  it("allows a null recording retention window to mean keep forever", () => {
    expect(
      updateRetentionPolicySchema.parse({
        recordingRetentionDays: null,
        deletedRecordingPurgeDays: 30,
      }),
    ).toEqual({ recordingRetentionDays: null, deletedRecordingPurgeDays: 30 });
  });

  it("rejects out-of-range or non-integer windows", () => {
    expect(() =>
      updateRetentionPolicySchema.parse({
        recordingRetentionDays: 0,
        deletedRecordingPurgeDays: 30,
      }),
    ).toThrow();
    expect(() =>
      updateRetentionPolicySchema.parse({
        recordingRetentionDays: 90,
        deletedRecordingPurgeDays: 3651,
      }),
    ).toThrow();
  });
});
