import { ZodError } from "zod";
import { AuthenticationError, AuthorizationError } from "../auth/authorization";
import { WorkspaceServiceError } from "./service";

export function workspaceError(error: unknown): Response {
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
  if (error instanceof WorkspaceServiceError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.status },
    );
  console.error("workspace request failed", error);
  return Response.json(
    { error: { code: "WORKSPACE_REQUEST_FAILED" } },
    { status: 500 },
  );
}
