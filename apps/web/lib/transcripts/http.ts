import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { AiServiceError } from "../ai/errors";
import { TranscriptServiceError } from "./service";

export function transcriptError(error: unknown): Response {
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
  if (error instanceof TranscriptServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  // Requesting transcription resolves an AI entitlement; its refusal codes are
  // what the UI turns into "connect a key or start a plan".
  if (error instanceof AiServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  console.error("transcript request failed", error);
  return Response.json(
    { error: { code: "TRANSCRIPT_REQUEST_FAILED" } },
    { status: 500 },
  );
}
