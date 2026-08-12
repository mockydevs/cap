/**
 * The workspace role ladder, ordered from most to least privileged. Session
 * actors, request validation, and the admin UI all read it from here so a new
 * role never has to be added in more than one place. The Postgres enum in
 * `apps/web/db/schema.ts` declares the same values for the database and is
 * pinned to this list by `lib/workspace/workspace.test.ts`.
 */
export const WORKSPACE_ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
