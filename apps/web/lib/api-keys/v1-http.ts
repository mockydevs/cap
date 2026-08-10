import { ZodError } from "zod";
import { AuthenticationError } from "../auth/authorization";
import { RecordingServiceError } from "../recordings/service";
import { TranscriptServiceError } from "../transcripts/service";
import { ApiRateLimitError } from "./auth";

export function publicApiError(error: unknown): Response {
  if (error instanceof ZodError)
    return Response.json(
      { error: { code: "VALIDATION_ERROR" } },
      { status: 400 },
    );
  if (error instanceof AuthenticationError)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "www-authenticate": "Bearer" } },
    );
  if (error instanceof ApiRateLimitError)
    return Response.json(
      { error: { code: "RATE_LIMITED" } },
      { status: 429, headers: { "retry-after": "300" } },
    );
  if (
    error instanceof RecordingServiceError ||
    error instanceof TranscriptServiceError
  )
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  console.error("public api request failed", error);
  return Response.json(
    { error: { code: "API_REQUEST_FAILED" } },
    { status: 500 },
  );
}
