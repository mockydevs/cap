import { ShareConfigurationError } from "@cap/domain";
import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { ShareRateLimitError } from "./rate-limit";
import { SharingServiceError } from "./service";

export function sharingError(error: unknown): Response {
  if (error instanceof ZodError || error instanceof ShareConfigurationError) {
    return Response.json(
      { error: { code: "VALIDATION_ERROR" } },
      { status: 400 },
    );
  }
  if (error instanceof AuthenticationError) {
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  }
  if (error instanceof AuthorizationError) {
    return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  }
  if (error instanceof ShareRateLimitError) {
    return Response.json(
      { error: { code: "RATE_LIMITED" } },
      { status: 429, headers: { "retry-after": "900" } },
    );
  }
  if (error instanceof SharingServiceError) {
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  }
  if (
    error instanceof Error &&
    error.message === "SHARE_RATE_LIMIT_NOT_CONFIGURED"
  ) {
    return Response.json(
      { error: { code: "SHARE_SECURITY_NOT_CONFIGURED" } },
      { status: 503 },
    );
  }
  console.error("sharing request failed", error);
  return Response.json(
    { error: { code: "SHARING_REQUEST_FAILED" } },
    { status: 500 },
  );
}
