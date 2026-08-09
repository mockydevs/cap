export type RecordingVisibility = "PRIVATE" | "LINK" | "PASSWORD" | "PUBLIC";

export type PlaybackAuthorization =
  | {
      readonly allowed: true;
      readonly grant: "WORKSPACE" | "LINK" | "PASSWORD" | "PUBLIC";
    }
  | {
      readonly allowed: false;
      readonly reason:
        "WORKSPACE_REQUIRED" | "LINK_REQUIRED" | "PASSWORD_REQUIRED";
    };

/** Pure deny-by-default policy used by every playback route. */
export function authorizePlayback(input: {
  readonly visibility: RecordingVisibility;
  readonly isWorkspaceMember: boolean;
  readonly hasActiveShareLink: boolean;
  readonly passwordVerified: boolean;
}): PlaybackAuthorization {
  if (input.isWorkspaceMember) return { allowed: true, grant: "WORKSPACE" };
  switch (input.visibility) {
    case "PUBLIC":
      return { allowed: true, grant: "PUBLIC" };
    case "LINK":
      return input.hasActiveShareLink
        ? { allowed: true, grant: "LINK" }
        : { allowed: false, reason: "LINK_REQUIRED" };
    case "PASSWORD":
      return input.hasActiveShareLink && input.passwordVerified
        ? { allowed: true, grant: "PASSWORD" }
        : { allowed: false, reason: "PASSWORD_REQUIRED" };
    case "PRIVATE":
      return { allowed: false, reason: "WORKSPACE_REQUIRED" };
  }
}

export class ShareConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareConfigurationError";
  }
}

export function validateShareConfiguration(input: {
  readonly visibility: RecordingVisibility;
  readonly password?: string;
}): void {
  if (input.visibility === "PASSWORD") {
    if (
      !input.password ||
      input.password.length < 10 ||
      input.password.length > 256
    ) {
      throw new ShareConfigurationError(
        "Password shares require a 10-256 character password",
      );
    }
    return;
  }
  if (input.password !== undefined) {
    throw new ShareConfigurationError(
      "Passwords are only valid for PASSWORD sharing",
    );
  }
}
