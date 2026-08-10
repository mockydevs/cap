import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { workspaceError } from "../../../../lib/workspace/http";
import { inviteMember, listMembers } from "../../../../lib/workspace/service";
import { inviteMemberSchema } from "../../../../lib/workspace/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "MEMBER");
    return Response.json({ items: await listMembers(actor.workspaceId) });
  } catch (error) {
    return workspaceError(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const input = inviteMemberSchema.parse(await request.json());
    return Response.json(await inviteMember(actor, input), { status: 201 });
  } catch (error) {
    return workspaceError(error);
  }
}
