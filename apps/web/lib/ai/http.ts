import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { AiServiceError } from "./service";
import { ShareRateLimitError } from "../sharing/rate-limit";
export function aiError(error: unknown) {
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
  if (error instanceof AiServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  if (error instanceof ShareRateLimitError)
    return Response.json(
      { error: { code: "RATE_LIMITED" } },
      { status: 429, headers: { "retry-after": "60" } },
    );
  console.error(
    "AI route failed",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: { code: "AI_REQUEST_FAILED" } },
    { status: 500 },
  );
}
