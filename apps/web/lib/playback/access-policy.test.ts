import { describe, expect, it } from "vitest";
import {
  authorizePlayback,
  canListRecordingInWorkspace,
  type PlaybackAccess,
} from "./access-policy";

const workspaceId = "workspace-a";
const readyPrivate: PlaybackAccess = {
  recordingWorkspaceId: workspaceId,
  availability: "READY",
  visibility: "PRIVATE",
};

describe("recording library authorization", () => {
  it("only lists non-deleted recordings in the actor's active workspace", () => {
    expect(
      canListRecordingInWorkspace(
        { workspaceId, role: "VIEWER" },
        workspaceId,
        "READY",
      ),
    ).toBe(true);
    expect(
      canListRecordingInWorkspace(
        { workspaceId: "workspace-b", role: "OWNER" },
        workspaceId,
        "READY",
      ),
    ).toBe(false);
    expect(
      canListRecordingInWorkspace(
        { workspaceId, role: "OWNER" },
        workspaceId,
        "DELETED",
      ),
    ).toBe(false);
  });
});

describe("share and playback authorization", () => {
  it("requires a same-workspace authenticated member for private recordings", () => {
    expect(authorizePlayback(readyPrivate)).toEqual({
      allowed: false,
      reason: "WORKSPACE_MEMBERSHIP_REQUIRED",
    });
    expect(
      authorizePlayback({
        ...readyPrivate,
        actor: { workspaceId, role: "VIEWER" },
      }),
    ).toEqual({ allowed: true });
    expect(
      authorizePlayback({
        ...readyPrivate,
        actor: { workspaceId: "workspace-b", role: "OWNER" },
      }),
    ).toEqual({
      allowed: false,
      reason: "WORKSPACE_MEMBERSHIP_REQUIRED",
    });
  });

  it("does not treat an unlisted URL as public access", () => {
    expect(authorizePlayback({ ...readyPrivate, visibility: "LINK" })).toEqual({
      allowed: false,
      reason: "SHARE_LINK_REQUIRED",
    });
    expect(
      authorizePlayback({
        ...readyPrivate,
        visibility: "LINK",
        hasValidShareLink: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("lets an authorized workspace member play any non-deleted workspace recording", () => {
    expect(
      authorizePlayback({
        ...readyPrivate,
        visibility: "PASSWORD",
        actor: { workspaceId, role: "MEMBER" },
      }),
    ).toEqual({ allowed: true });
  });

  it("requires both a bound link and a password grant for protected shares", () => {
    expect(
      authorizePlayback({
        ...readyPrivate,
        visibility: "PASSWORD",
        hasValidPasswordGrant: true,
      }),
    ).toEqual({ allowed: false, reason: "PASSWORD_REQUIRED" });
    expect(
      authorizePlayback({
        ...readyPrivate,
        visibility: "PASSWORD",
        hasValidShareLink: true,
      }),
    ).toEqual({ allowed: false, reason: "PASSWORD_REQUIRED" });
    expect(
      authorizePlayback({
        ...readyPrivate,
        visibility: "PASSWORD",
        hasValidShareLink: true,
        hasValidPasswordGrant: true,
      }),
    ).toEqual({ allowed: true });
  });

  it("allows ready public recordings without a session but never leaks unready media", () => {
    expect(
      authorizePlayback({ ...readyPrivate, visibility: "PUBLIC" }),
    ).toEqual({ allowed: true });
    expect(
      authorizePlayback({
        ...readyPrivate,
        availability: "PROCESSING",
        visibility: "PUBLIC",
      }),
    ).toEqual({ allowed: false, reason: "RECORDING_UNAVAILABLE" });
  });
});
