import { describe, expect, it } from "vitest";
import { canManageRecording, statusAfterRestore } from "./library-policy";

describe("recording library policy", () => {
  it("allows workspace administrators and the creator to manage trash", () => {
    expect(canManageRecording({ role: "ADMIN", userId: "admin" }, "creator")).toBe(true);
    expect(canManageRecording({ role: "MEMBER", userId: "creator" }, "creator")).toBe(true);
    expect(canManageRecording({ role: "MEMBER", userId: "other" }, "creator")).toBe(false);
  });

  it("restores the previous processing state and safely handles legacy rows", () => {
    expect(statusAfterRestore("READY")).toBe("READY");
    expect(statusAfterRestore("PROCESSING")).toBe("PROCESSING");
    expect(statusAfterRestore(null)).toBe("FAILED");
    expect(statusAfterRestore("DELETED")).toBe("FAILED");
  });
});
