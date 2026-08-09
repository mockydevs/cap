import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { CommentError } from "./service";
export function commentError(error: unknown) {
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
  if (error instanceof CommentError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  if (error instanceof Error && error.message === "COMMENT_RATE_LIMITED")
    return Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 });
  if (
    error instanceof Error &&
    error.message === "COMMENT_RATE_LIMIT_NOT_CONFIGURED"
  )
    return Response.json(
      { error: { code: "COMMENT_SECURITY_NOT_CONFIGURED" } },
      { status: 503 },
    );
  console.error("comment route failed", error);
  return Response.json(
    { error: { code: "COMMENT_REQUEST_FAILED" } },
    { status: 500 },
  );
}
