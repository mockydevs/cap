import { requireActor } from "../../../../lib/auth/authorization";
import { hasTrustedOrigin } from "../../../../lib/auth/origin";
import { billingError } from "../../../../lib/billing/http";
import { startPlanCheckout } from "../../../../lib/billing/service";
import { startCheckoutSchema } from "../../../../lib/billing/validation";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (!hasTrustedOrigin(request))
      return Response.json(
        { error: { code: "INVALID_ORIGIN" } },
        { status: 403 },
      );
    const actor = await requireActor(request, "ADMIN");
    const { planCode } = startCheckoutSchema.parse(await request.json());
    return Response.json(await startPlanCheckout(actor, planCode));
  } catch (error) {
    return billingError(error);
  }
}
