import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { workspaceError } from "../../../../../lib/workspace/http";
import { acceptInvitation } from "../../../../../lib/workspace/service";
import { acceptInvitationSchema } from "../../../../../lib/workspace/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "VIEWER");
    const { token } = acceptInvitationSchema.parse(await request.json());
    const result = await acceptInvitation(
      { userId: actor.userId, email: actor.email },
      token,
    );
    return Response.json(result);
  } catch (error) {
    return workspaceError(error);
  }
}
