import { describe, expect, it } from "vitest";
import {
  suggestedRecordingTitle,
  uploadFailureMessage,
} from "../../components/capture-studio";

/**
 * Upload failures used to all read "Sign in and retry", whatever went wrong.
 * These pin each cause to advice that can actually resolve it.
 */
describe("uploadFailureMessage", () => {
  it("treats a rejected fetch as a connectivity problem, not an auth one", () => {
    const message = uploadFailureMessage(new TypeError("Failed to fetch"));
    expect(message).toContain("could not reach the upload service");
    expect(message).not.toContain("Sign in");
  });

  it("asks for a fresh sign-in only when the session actually expired", () => {
    expect(uploadFailureMessage(new Error("UNAUTHENTICATED"))).toContain(
      "session expired",
    );
  });

  it("surfaces the underlying reason for anything else", () => {
    expect(uploadFailureMessage(new Error("UPLOAD_QUOTA_EXCEEDED"))).toContain(
      "UPLOAD_QUOTA_EXCEEDED",
    );
  });

  it("always says the recording is still held locally", () => {
    for (const error of [
      new TypeError("Failed to fetch"),
      new Error("UNAUTHENTICATED"),
      new Error("SOMETHING_ELSE"),
      "not an error at all",
    ])
      expect(uploadFailureMessage(error)).toContain("still here");
  });
});

describe("suggestedRecordingTitle", () => {
  it("uses a useful capture-source label without leaking trailing window detail", () => {
    expect(
      suggestedRecordingTitle(
        "Tab: Quarterly planning - Google Chrome",
        new Date("2026-08-14T12:00:00Z"),
      ),
    ).toBe("Quarterly planning");
  });

  it("falls back when the browser exposes only a numeric screen identifier", () => {
    expect(
      suggestedRecordingTitle("Screen 1", new Date("2026-08-14T12:00:00Z")),
    ).toMatch(/^Recording /);
  });
});
