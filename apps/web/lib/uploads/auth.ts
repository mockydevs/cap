/**
 * Transitional actor boundary. Production requests must be backed by the account/session
 * implementation before upload routes are enabled. Header values are never trusted.
 */
export type UploadActor = { userId: string; workspaceId: string };

export function requireUploadActor(): UploadActor {
  const userId = process.env.DEV_UPLOAD_USER_ID;
  const workspaceId = process.env.DEV_UPLOAD_WORKSPACE_ID;
  if (process.env.NODE_ENV === "production" || !userId || !workspaceId) {
    throw new Error("UPLOAD_AUTH_NOT_CONFIGURED");
  }
  return { userId, workspaceId };
}
