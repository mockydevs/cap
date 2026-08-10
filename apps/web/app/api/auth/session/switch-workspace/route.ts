import { z } from "zod";
import { requireActor } from "../../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../../lib/auth/origin";
import { switchActiveWorkspace, tokenFromRequest } from "../../../../../lib/auth/session";

export const runtime = "nodejs";

const bodySchema = z.object({ workspaceId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  if (!hasTrustedOrigin(request))
    return Response.json(
      { error: { code: "INVALID_ORIGIN" } },
      { status: 403 },
    );
  try {
    const actor = await requireActor(request, "VIEWER");
    const { workspaceId } = bodySchema.parse(await request.json());
    const token = tokenFromRequest(request);
    if (!token)
      return Response.json(
        { error: { code: "UNAUTHENTICATED" } },
        { status: 401 },
      );
    const switched = await switchActiveWorkspace(
      token,
      actor.userId,
      workspaceId,
    );
    if (!switched)
      return Response.json(
        { error: { code: "NOT_A_MEMBER" } },
        { status: 403 },
      );
    return Response.json({ status: "SWITCHED" });
  } catch {
    return Response.json(
      { error: { code: "VALIDATION_ERROR" } },
      { status: 400 },
    );
  }
}
