import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";

export function recordingError(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      { error: { code: "VALIDATION_ERROR", issues: error.flatten() } },
      { status: 400 },
    );
  if (error instanceof AuthenticationError)
    return Response.json(
      { error: { code: "UNAUTHENTICATED" } },
      { status: 401 },
    );
  if (error instanceof AuthorizationError)
    return Response.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  console.error("recording route failed", error);
  return Response.json(
    { error: { code: "RECORDING_REQUEST_FAILED" } },
    { status: 500 },
  );
}
