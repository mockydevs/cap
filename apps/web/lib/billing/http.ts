import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { BillingConfigurationError } from "./plans";
import { BillingServiceError } from "./service";
import { StripeRequestError } from "./stripe";

export function billingError(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      { error: { code: "VALIDATION_ERROR" } },
      { status: 400 },
    );
  if (error instanceof AuthenticationError)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  if (error instanceof AuthorizationError)
    return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  if (error instanceof BillingServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  // A misconfigured catalogue is the operator's problem, not the caller's, and
  // must not read as a client error.
  if (error instanceof BillingConfigurationError)
    return Response.json(
      { error: { code: "BILLING_NOT_CONFIGURED" } },
      { status: 503 },
    );
  if (error instanceof StripeRequestError) {
    console.error("Billing provider rejected a request", error.status);
    return Response.json(
      { error: { code: "BILLING_PROVIDER_FAILED" } },
      { status: 502 },
    );
  }
  console.error(
    "Billing route failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: { code: "BILLING_REQUEST_FAILED" } },
    { status: 500 },
  );
}
