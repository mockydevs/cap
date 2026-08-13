import type { Actor } from "../auth/session";

export type PersistedRecordingStatus =
  "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "DELETED";

export function canManageRecording(
  actor: Pick<Actor, "role" | "userId">,
  ownerId: string,
) {
  return (
    actor.role === "OWNER" || actor.role === "ADMIN" || ownerId === actor.userId
  );
}

export function statusAfterRestore(
  previousStatus: PersistedRecordingStatus | null,
): Exclude<PersistedRecordingStatus, "DELETED"> {
  return previousStatus && previousStatus !== "DELETED"
    ? previousStatus
    : "FAILED";
}
