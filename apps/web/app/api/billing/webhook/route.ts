import { billingError } from "../../../../lib/billing/http";
import { applyBillingEvent } from "../../../../lib/billing/service";
import {
  stripeEventSchema,
  verifyWebhookSignature,
  webhookSecret,
} from "../../../../lib/billing/stripe";
export const runtime = "nodejs";

/**
 * Receives subscription lifecycle events from the billing provider.
 *
 * Unauthenticated by design — the signature over the raw body is the
 * authentication. The body is read as text and never re-serialized, because
 * re-encoding the JSON changes the bytes the signature covers.
 */
export async function POST(request: Request) {
  let payload: string;
  try {
    payload = await request.text();
    if (
      !verifyWebhookSignature({
        payload,
        header: request.headers.get("stripe-signature"),
        secret: webhookSecret(),
      })
    )
      return Response.json(
        { error: { code: "INVALID_SIGNATURE" } },
        { status: 400 },
      );
  } catch (error) {
    return billingError(error);
  }
  try {
    const event = stripeEventSchema.parse(JSON.parse(payload));
    const applied = await applyBillingEvent(event);
    return Response.json({ received: true, applied });
  } catch (error) {
    // The signature already proved the sender; a failure here is Cap's, so
    // answer 500 and let the provider redeliver.
    console.error(
      "Billing webhook failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return Response.json(
      { error: { code: "BILLING_WEBHOOK_FAILED" } },
      { status: 500 },
    );
  }
}
