import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";

export function retentionError(error: unknown): Response {
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
  console.error("retention request failed", error);
  return Response.json(
    { error: { code: "RETENTION_REQUEST_FAILED" } },
    { status: 500 },
  );
}
