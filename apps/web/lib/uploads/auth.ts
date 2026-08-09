import { AuthorizationError, requireActor } from "../auth/authorization";
import { hasTrustedOrigin } from "../auth/origin";

/** Uploads require an authenticated member of the active workspace. */
export const requireUploadActor = (request: Request) =>
  requireActor(request, "MEMBER");

export function requireTrustedUploadOrigin(request: Request): void {
  if (!hasTrustedOrigin(request))
    throw new AuthorizationError("Untrusted request origin");
}
