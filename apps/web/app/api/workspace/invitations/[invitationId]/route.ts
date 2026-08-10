import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { workspaceError } from "../../../../../lib/workspace/http";
import { revokeInvitation } from "../../../../../lib/workspace/service";
import { invitationParamsSchema } from "../../../../../lib/workspace/validation";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { invitationId } = invitationParamsSchema.parse(await context.params);
    await revokeInvitation(actor, invitationId);
    return Response.json({ status: "REVOKED" });
  } catch (error) {
    return workspaceError(error);
  }
}
