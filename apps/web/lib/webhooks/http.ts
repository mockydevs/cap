import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { WebhookServiceError } from "./service";

export function webhookError(error: unknown): Response {
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
  if (error instanceof WebhookServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  console.error("webhook request failed", error);
  return Response.json(
    { error: { code: "WEBHOOK_REQUEST_FAILED" } },
    { status: 500 },
  );
}
