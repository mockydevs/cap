import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { billingError } from "../../../../lib/billing/http";
import { openBillingPortal } from "../../../../lib/billing/service";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    return Response.json(
      await openBillingPortal(await requireActor(request, "ADMIN")),
    );
  } catch (error) {
    return billingError(error);
  }
}
