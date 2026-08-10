import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { retentionError } from "../../../../lib/retention/http";
import {
  getRetentionPolicy,
  updateRetentionPolicy,
} from "../../../../lib/retention/service";
import { updateRetentionPolicySchema } from "../../../../lib/retention/validation";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request, "ADMIN");
    const policy = await getRetentionPolicy(actor.workspaceId);
    return Response.json({
      ...policy,
      updatedAt: policy.updatedAt?.toISOString() ?? null,
    });
  } catch (error) {
    return retentionError(error);
  }
}

export async function PUT(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const input = updateRetentionPolicySchema.parse(await request.json());
    await updateRetentionPolicy(actor, input);
    return Response.json({ status: "UPDATED" });
  } catch (error) {
    return retentionError(error);
  }
}
