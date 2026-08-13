export type RecordingVisibility = "PRIVATE" | "LINK" | "PUBLIC";

export type PlaybackAuthorization =
  | {
      readonly allowed: true;
      readonly grant: "WORKSPACE" | "LINK" | "PUBLIC";
    }
  | {
      readonly allowed: false;
      readonly reason: "WORKSPACE_REQUIRED" | "LINK_REQUIRED";
    };

/**
 * Pure deny-by-default policy used by every playback route.
 *
 * Access is carried by the link itself: holding an unexpired, unrevoked token
 * is what grants playback. There is no second secret to present — a recipient
 * who has the link can watch.
 */
export function authorizePlayback(input: {
  readonly visibility: RecordingVisibility;
  readonly isWorkspaceMember: boolean;
  readonly hasActiveShareLink: boolean;
}): PlaybackAuthorization {
  if (input.isWorkspaceMember) return { allowed: true, grant: "WORKSPACE" };
  switch (input.visibility) {
    case "PUBLIC":
      return { allowed: true, grant: "PUBLIC" };
    case "LINK":
      return input.hasActiveShareLink
        ? { allowed: true, grant: "LINK" }
        : { allowed: false, reason: "LINK_REQUIRED" };
    case "PRIVATE":
      return { allowed: false, reason: "WORKSPACE_REQUIRED" };
  }
}
