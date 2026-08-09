import { actorFromToken, tokenFromRequest, type Actor } from "./session";

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}
type WorkspaceRole = Actor["role"];
const roleRank: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export async function requireActor(
  request: Request,
  minimumRole: WorkspaceRole = "VIEWER",
) {
  const actor = await actorFromToken(tokenFromRequest(request));
  if (!actor) throw new AuthenticationError("Authentication required");
  if (roleRank[actor.role] < roleRank[minimumRole])
    throw new AuthorizationError("Insufficient workspace role");
  return actor;
}
