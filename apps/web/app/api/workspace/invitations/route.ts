import { requireActor } from "../../../../lib/auth/authorization";
import { workspaceError } from "../../../../lib/workspace/http";
import { listInvitations } from "../../../../lib/workspace/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "ADMIN");
    return Response.json({ items: await listInvitations(actor.workspaceId) });
  } catch (error) {
    return workspaceError(error);
  }
}
