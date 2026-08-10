import { describe, expect, it } from "vitest";
import {
  recordingId,
  sourceMediaType,
  uploadSessionId,
  workspaceId,
} from "@cap/domain";
import {
  assertManagedMediaObjectKey,
  assertPlaybackExpirySeconds,
  assertPresignExpirySeconds,
  buildRecordingObjectPrefix,
  buildSourceMediaObjectKey,
  buildTranscriptCaptionObjectKey,
  multipartUploadId,
} from "../src/index";

describe("storage security contract", () => {
  it("builds an internal immutable source key without a user filename", () => {
    expect(
      buildSourceMediaObjectKey({
        workspaceId: workspaceId("workspace_1"),
        recordingId: recordingId("recording_1"),
        uploadSessionId: uploadSessionId("attempt_1"),
        mediaType: sourceMediaType("video/webm;codecs=vp9,opus"),
      }),
    ).toBe(
      "workspaces/workspace_1/recordings/recording_1/source/attempt_1.webm",
    );
  });

  it("builds a recording's object prefix for retention purge", () => {
    expect(
      buildRecordingObjectPrefix({
        workspaceId: workspaceId("workspace_1"),
        recordingId: recordingId("recording_1"),
      }),
    ).toBe("workspaces/workspace_1/recordings/recording_1/");
  });

  it("builds a translated caption object key", () => {
    expect(
      buildTranscriptCaptionObjectKey({
        workspaceId: workspaceId("workspace_1"),
        recordingId: recordingId("recording_1"),
        language: "es",
        extension: "vtt",
      }),
    ).toBe("workspaces/workspace_1/recordings/recording_1/transcripts/es.vtt");
  });

  it("rejects traversal and keys outside the managed namespace", () => {
    expect(() =>
      assertManagedMediaObjectKey(
        "workspaces/a/recordings/b/source/../private",
      ),
    ).toThrow("managed media namespace");
    expect(() =>
      assertManagedMediaObjectKey("arbitrary/client/key.webm"),
    ).toThrow("managed media namespace");
  });

  it("keeps upload signatures short lived", () => {
    expect(() => assertPresignExpirySeconds(59)).toThrow("60-900");
    expect(() => assertPresignExpirySeconds(901)).toThrow("60-900");
    expect(() => assertPresignExpirySeconds(300)).not.toThrow();
  });

  it("keeps playback bearer URLs short lived", () => {
    expect(() => assertPlaybackExpirySeconds(29)).toThrow("30-900");
    expect(() => assertPlaybackExpirySeconds(901)).toThrow("30-900");
    expect(() => assertPlaybackExpirySeconds(120)).not.toThrow();
  });

  it("rejects control characters in provider upload IDs", () => {
    expect(() => multipartUploadId("bad\nupload")).toThrow(
      "Invalid multipart upload",
    );
  });
});
