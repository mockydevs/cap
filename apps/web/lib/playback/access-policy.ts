import {
  authorizePlayback as authorizeSharePlayback,
  type RecordingVisibility,
  type WorkspaceRole,
} from "@cap/domain";

/**
 * Pure authorization rules for the recording library and playback edge.
 *
 * The caller is responsible for resolving a share token and any password grant
 * against the database before passing them here. Keeping that I/O outside this
 * policy makes the security boundary deterministic and easy to exercise from
 * both HTML pages and media URL endpoints.
 */
export type { RecordingVisibility } from "@cap/domain";
export type RecordingAvailability =
  "READY" | "PROCESSING" | "FAILED" | "DELETED";

export type PlaybackActor = {
  workspaceId: string;
  role: WorkspaceRole;
};

export type PlaybackAccess = {
  recordingWorkspaceId: string;
  availability: RecordingAvailability;
  visibility: RecordingVisibility;
  actor?: PlaybackActor | null;
  /** A non-expired, non-revoked token bound to this recording. */
  hasValidShareLink?: boolean;
  /** A server-issued, non-expired grant bound to this share link and recording. */
  hasValidPasswordGrant?: boolean;
};

export type PlaybackDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "RECORDING_UNAVAILABLE"
        | "WORKSPACE_MEMBERSHIP_REQUIRED"
        | "SHARE_LINK_REQUIRED"
        | "PASSWORD_REQUIRED";
    };

const allowed: PlaybackDecision = { allowed: true };

/**
 * Determines whether an actor may see an item in its owning workspace library.
 * A workspace identifier supplied by a client is never trusted for this check.
 */
export function canListRecordingInWorkspace(
  actor: PlaybackActor | null | undefined,
  recordingWorkspaceId: string,
  availability: RecordingAvailability,
): boolean {
  return (
    availability !== "DELETED" && actor?.workspaceId === recordingWorkspaceId
  );
}

/**
 * Decides whether a caller may receive playback access to private media.
 * This must run before issuing a presigned object-storage URL.
 */
export function authorizePlayback(input: PlaybackAccess): PlaybackDecision {
  if (input.availability !== "READY") {
    return { allowed: false, reason: "RECORDING_UNAVAILABLE" };
  }

  const decision = authorizeSharePlayback({
    visibility: input.visibility,
    isWorkspaceMember: input.actor?.workspaceId === input.recordingWorkspaceId,
    hasActiveShareLink: Boolean(input.hasValidShareLink),
    passwordVerified: Boolean(input.hasValidPasswordGrant),
  });
  if (decision.allowed) return allowed;

  switch (decision.reason) {
    case "WORKSPACE_REQUIRED":
      return { allowed: false, reason: "WORKSPACE_MEMBERSHIP_REQUIRED" };
    case "LINK_REQUIRED":
      return { allowed: false, reason: "SHARE_LINK_REQUIRED" };
    case "PASSWORD_REQUIRED":
      return { allowed: false, reason: "PASSWORD_REQUIRED" };
  }
}
