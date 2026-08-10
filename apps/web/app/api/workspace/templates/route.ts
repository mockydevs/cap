import { requireActor } from "../../../../lib/auth/authorization";
import { editorError } from "../../../../lib/editor/http";
import { listTemplates } from "../../../../lib/editor/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "MEMBER");
    const items = await listTemplates(actor.workspaceId);
    return Response.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    return editorError(error);
  }
}
