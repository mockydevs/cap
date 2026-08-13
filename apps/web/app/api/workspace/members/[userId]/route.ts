import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { workspaceError } from "../../../../../lib/workspace/http";
import {
  removeMember,
  updateMemberRole,
} from "../../../../../lib/workspace/service";
import {
  memberParamsSchema,
  updateMemberRoleSchema,
} from "../../../../../lib/workspace/validation";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { userId } = memberParamsSchema.parse(await context.params);
    const { role } = updateMemberRoleSchema.parse(await request.json());
    await updateMemberRole(actor, userId, role);
    return Response.json({ status: "UPDATED" });
  } catch (error) {
    return workspaceError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { userId } = memberParamsSchema.parse(await context.params);
    await removeMember(actor, userId);
    return Response.json({ status: "REMOVED" });
  } catch (error) {
    return workspaceError(error);
  }
}
