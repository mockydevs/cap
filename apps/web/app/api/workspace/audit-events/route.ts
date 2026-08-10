import { z } from "zod";
import { listAuditEvents } from "../../../../lib/audit/service";
import { requireActor } from "../../../../lib/auth/authorization";
import { workspaceError } from "../../../../lib/workspace/http";

export const runtime = "nodejs";

const querySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "ADMIN");
    const url = new URL(request.url);
    const input = querySchema.parse({
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const { items, nextCursor } = await listAuditEvents(
      actor.workspaceId,
      input.cursor,
      input.limit,
    );
    return Response.json({
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      nextCursor,
    });
  } catch (error) {
    return workspaceError(error);
  }
}
