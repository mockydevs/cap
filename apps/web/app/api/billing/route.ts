import { requireActor } from "../../../lib/auth/authorization";
import { billingError } from "../../../lib/billing/http";
import { getBillingOverview } from "../../../lib/billing/service";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return Response.json(
      await getBillingOverview(await requireActor(request)),
      {
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return billingError(error);
  }
}
